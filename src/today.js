/**
 * 今日：把「用户还没跟进的事」从过去会话里捞出来。
 *
 * 设计约束：
 * - 只取每个空闲会话的最后一条助手消息（尾部 ≤800 字），不扫全文；
 * - 确定性部分只做筛选（工作区、时间窗、空闲时长、最后一条是助手），
 *   是否算「还没跟进」交给一次模型调用判断；
 * - 结果按工作区 + 会话集合缓存，模型调用不写会话、不触发 agent loop。
 */

import { messageText } from './prediction.js'

export const MAX_SESSIONS = 8
export const MAX_TAIL_CHARS = 800
export const MAX_USER_CHARS = 200
export const MAX_ITEMS = 5
export const MIN_IDLE_MS = 2 * 3600 * 1000
export const LOOKBACK_MS = 14 * 24 * 3600 * 1000
export const CACHE_TTL_MS = 15 * 60 * 1000
export const MODEL_TIMEOUT_MS = 30000
export const MAX_OUTPUT_TOKENS = 900

export const SYSTEM_PROMPT = [
  '你在整理「用户还没跟进的事」。输入是过去几个会话里，助手最后一条消息的尾部片段。',
  '只挑出需要用户本人做、但用户此后没有回应的事：',
  '- 要用户决定、授权、确认的事，例如部署、推送、发版、重启、两个方案二选一；',
  '- 助手提问后用户没有再回答的问题；',
  '- 明确留给用户去做的动作。',
  '不要挑：验证结果、改动说明、状态汇报、纯信息提醒（「需要你知道」），以及助手说他自己会做的事。',
  '不要编造输入里没有的事。跨会话重复的同一件事合并成一条，保留最新的会话编号。',
  '每条不超过 40 个汉字，保留具体对象（哪个仓库、哪个服务、哪个文件），不要写「继续处理」这类空话。',
  '只输出 JSON 数组，不要代码块、不要解释：',
  '[{"i":会话编号,"text":"一句话"}]',
  '没有符合的事就输出 []。',
].join('\n')

function clip(value, maxChars) {
  const text = String(value ?? '').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, 20)}…${text.slice(text.length - (maxChars - 20))}`
}

/** 尾部截取：遗漏项通常在消息末尾，保留结尾比保留开头有用。 */
export function tailText(text, maxChars = MAX_TAIL_CHARS) {
  const value = String(text ?? '').trim()
  if (value.length <= maxChars) return value
  return `…${value.slice(value.length - maxChars)}`
}

function eventText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (!Array.isArray(content)) return ''
  return messageText({ role: 'x', content })
}

/**
 * 从一个会话的模型可见事件里取出尾部一条助手消息。
 * 返回 null：没有可读消息，或最后一条是用户消息（等回复的是助手，不是用户）。
 * @param {Array<object>} events - sessionQuery.readSurface() 的 events
 * @param {number} now
 * @param {{ minIdleMs?: number }} [options]
 * @returns {{ lastAssistant: string, lastUser: string|null, lastTime: number, idleHours: number, unanswered: boolean }|null}
 */
export function tailOfSurface(events, now, options = {}) {
  const minIdleMs = options.minIdleMs ?? MIN_IDLE_MS
  const list = Array.isArray(events) ? events : []
  let lastAssistant = ''
  let lastUser = ''
  let lastSpeaker = null
  for (const event of list) {
    if (event?.type === 'user/message') {
      const source = event.data?.source
      if (source && source.kind !== 'user') continue
      const text = eventText(event)
      if (text === '') continue
      lastUser = text
      lastSpeaker = 'user'
    } else if (event?.type === 'assistant/message') {
      const text = eventText(event)
      if (text === '') continue
      lastAssistant = text
      lastSpeaker = 'assistant'
    }
  }
  if (lastSpeaker !== 'assistant' || lastAssistant === '') return null
  const lastTime = Number(list.at(-1)?.time)
  if (!Number.isFinite(lastTime)) return null
  if (now - lastTime < minIdleMs) return null
  return {
    lastAssistant: tailText(lastAssistant),
    lastUser: lastUser === '' ? null : lastUser,
    lastTime,
    idleHours: Math.max(1, Math.round((now - lastTime) / 3600000)),
    unanswered: true,
  }
}

/**
 * 收集候选：同一工作区、时间窗内、除当前会话外、最新的若干空闲会话。
 * @param {Array<{header: object}>} records - sessionQuery.listSessions() 结果
 * @param {{ cwd: string, sessionId: string, now: number, lookbackMs?: number, maxSessions?: number }} options
 */
export function pickRecords(records, options) {
  const { cwd, sessionId, now } = options
  const lookbackMs = options.lookbackMs ?? LOOKBACK_MS
  const maxSessions = options.maxSessions ?? MAX_SESSIONS
  return (Array.isArray(records) ? records : [])
    .filter((record) => {
      const header = record?.header
      if (!header || typeof header.id !== 'string' || header.id === sessionId) return false
      if (typeof header.cwd !== 'string' || header.cwd !== cwd) return false
      return Number.isFinite(header.createdAt) && header.createdAt >= now - lookbackMs
    })
    .sort((a, b) => b.header.createdAt - a.header.createdAt)
    .slice(0, maxSessions)
}

const FALLBACK_RE = /(还没|没做|没动|未提交|未推送|未部署|尚未|待你确认|等你确认|等你定|等你拍板|需要你确认|需要你决定|需要你拍板)/u
const FALLBACK_ASK_RE = /([^。！？!?\n]{4,120}[？?])\s*$/u

/**
 * 模型不可用时的退路：只留问句和「还没/未推送/待你确认」这类硬信号。
 * 精确率不高，但比空面板强，界面上会标注「未经模型整理」。
 */
export function pickFallbackItems(candidates, maxItems = 3) {
  const items = []
  const seen = new Set()
  for (const candidate of candidates) {
    const text = candidate.lastAssistant
    const question = text.match(FALLBACK_ASK_RE)
    const lines = text.split(/\n/u).map((line) => line.replace(/^[-*#\s]+/u, '').trim()).filter(Boolean)
    const picked = new Set()
    if (question) picked.add(question[1].trim())
    for (const line of lines) {
      if (line.length < 6 || line.length > 120) continue
      if (!FALLBACK_RE.test(line)) continue
      picked.add(line)
      break
    }
    for (const item of picked) {
      const key = item.replace(/\s+/gu, '')
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ text: item.slice(0, 120), sessionId: candidate.sessionId, idleHours: candidate.idleHours })
      if (items.length >= maxItems) return items
    }
  }
  return items
}

/** 拼模型输入；编号从 1 开始，方便模型回填。 */
export function buildTodayPrompt(candidates) {
  const lines = []
  candidates.forEach((candidate, index) => {
    lines.push(`[${index + 1}] ${candidate.idleHours} 小时前，助手最后一条消息（用户此后没有回复）：`)
    lines.push(tailText(candidate.lastAssistant))
    if (candidate.lastUser) lines.push(`用户最后说的是：${clip(candidate.lastUser, MAX_USER_CHARS)}`)
    lines.push('')
  })
  return lines.join('\n').trim()
}

function firstJsonArray(raw) {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/```\s*$/u, '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return null
  return text.slice(start, end + 1)
}

/**
 * 解析模型输出；编号越界、空文本、重复条目都丢弃。
 * @param {string} raw
 * @param {Array<{sessionId: string, idleHours: number}>} candidates
 * @returns {Array<{text: string, sessionId: string, idleHours: number}>}
 */
export function parseItems(raw, candidates) {
  const json = firstJsonArray(raw)
  if (json === null) return []
  let value
  try {
    value = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const items = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const index = Number(entry.i ?? entry.index)
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) continue
    const text = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
    if (text === '' || text.length > 200) continue
    const key = text.replace(/[。！？!?，,。.\s]/gu, '')
    if (seen.has(key)) continue
    seen.add(key)
    const candidate = candidates[index - 1]
    items.push({ text, sessionId: candidate.sessionId, idleHours: candidate.idleHours })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

const lowEffortCache = new Map()

/** 整理只需要判断，用该模型最低的推理档位；查询失败就不传，退回默认。 */
async function resolveLowEffort(service, selection, signal) {
  const key = `${selection.provider}\u0000${selection.model}`
  if (lowEffortCache.has(key)) return lowEffortCache.get(key)
  let effort
  try {
    const info = await service.resolveModelInfo(selection.provider, selection.model, signal)
    const first = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts[0] : undefined
    effort = first && typeof first.id === 'string' ? first.id : undefined
  } catch {
    effort = undefined
  }
  lowEffortCache.set(key, effort)
  return effort
}

async function generate({ llm, defaultSelection, prompt, signal }) {
  const service = typeof llm === 'function' ? llm() : llm
  if (!service || typeof service.stream !== 'function') throw new Error('llm service is unavailable')
  const selection = defaultSelection?.()
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw new Error('no default model')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let text = ''
  try {
    const reasoningEffort = await resolveLowEffort(service, selection, controller.signal)
    const stream = service.stream({
      provider: selection.provider,
      model: selection.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish') {
        const kind = chunk.reason && chunk.reason.kind
        if (kind === 'error' || kind === 'aborted') {
          const failure = chunk.reason && chunk.reason.failure
          throw new Error(failure && failure.message ? failure.message : `model stream ${kind}`)
        }
      }
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
  return text
}

/**
 * @param {object} options
 * @param {object|undefined} options.config - 插件 Config（today 为 live reference）
 * @param {object} options.sessions - ctx.sessions，用来取当前会话的 cwd
 * @param {object|undefined} options.sessionQuery - ctx.sessionQuery（可选；缺失时只报 unavailable）
 * @param {() => object|undefined} options.llm
 * @param {() => object|null} options.defaultSelection
 * @param {(message: string, error?: unknown) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createTodayService({
  config,
  sessions,
  sessionQuery,
  llm,
  defaultSelection,
  dismissals = null,
  log = () => {},
  now = () => Date.now(),
}) {
  const cache = new Map()

  const enabled = () => {
    try {
      return config?.today?.get?.() !== false
    } catch {
      return true
    }
  }

  /** 当前会话可能不是 live（刚恢复的历史会话），cwd 优先从 live 会话取，其次从列表记录取。 */
  function resolveCwd(sessionId, records) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      const error = new Error('sessionId is required')
      error.code = 'invalid-params'
      throw error
    }
    const session = sessions?.get?.(sessionId)
    const liveCwd = session?.cwd ?? session?.header?.cwd
    if (typeof liveCwd === 'string' && liveCwd !== '') return liveCwd
    const record = records.find((entry) => entry?.header?.id === sessionId)
    const recordCwd = record?.header?.cwd
    return typeof recordCwd === 'string' && recordCwd !== '' ? recordCwd : null
  }

  /** 已清掉的条目在这里过滤，缓存里始终保留模型原样输出。 */
  function present(items, extra = {}) {
    if (!dismissals || typeof dismissals.filter !== 'function') return { items, ...extra }
    const shown = dismissals.filter(items)
    return { items: shown.items, hidden: shown.hidden, ...extra }
  }

  return {
    /**
     * 返回 { items, hidden?, scanned, cached?, disabled?, unavailable? }。
     * 业务失败抛错，由 HTTP 层转成 ok:false。
     */
    /**
     * @param {string} sessionId
     * @param {AbortSignal} [signal]
     * @param {{ force?: boolean }} [options] - force 跳过缓存（面板的刷新按钮）
     */
    async list(sessionId, signal, options = {}) {
      if (!enabled()) return { items: [], disabled: true }
      const query = typeof sessionQuery === 'function' ? sessionQuery() : sessionQuery
      if (!query || typeof query.listSessions !== 'function' || typeof query.readSurface !== 'function') {
        return { items: [], unavailable: true }
      }
      const at = now()
      const all = await query.listSessions(signal)
      const cwd = resolveCwd(sessionId, all)
      if (cwd === null) return { items: [], unavailable: true }
      const records = pickRecords(all, { cwd, sessionId, now: at })

      const candidates = []
      for (const record of records) {
        signal?.throwIfAborted()
        let surface
        try {
          surface = await query.readSurface(record.header.id)
        } catch (error) {
          log(`today surface read failed: ${record.header.id}`, error)
          continue
        }
        const tail = tailOfSurface(surface?.events, at)
        if (tail === null) continue
        candidates.push({ sessionId: record.header.id, ...tail })
      }

      if (candidates.length === 0) return { items: [], scanned: 0 }
      // 会话列表按创建时间取候选，但「最近待跟进的事」应按最后活动时间排；
      // 老会话被重新打开时，创建时间会把它排到后面。
      candidates.sort((left, right) => right.lastTime - left.lastTime)
      candidates.splice(MAX_SESSIONS)

      const key = `${cwd}\u0000${candidates.map((c) => `${c.sessionId}:${c.lastTime}`).join(',')}`
      const hit = cache.get(cwd)
      if (!options.force && hit && hit.key === key && at - hit.at < CACHE_TTL_MS) {
        return present(hit.items, { scanned: candidates.length, cached: true, ...(hit.degraded ? { degraded: true, detail: hit.detail } : {}) })
      }

      let items = []
      let degraded = false
      let detail = ''
      try {
        const raw = await generate({
          llm,
          defaultSelection,
          prompt: buildTodayPrompt(candidates),
          signal,
        })
        items = parseItems(raw, candidates)
      } catch (error) {
        log('today model call failed', error)
        degraded = true
        detail = String(error && error.message ? error.message : error).slice(0, 200)
        items = pickFallbackItems(candidates)
      }
      cache.set(cwd, { at, key, items, degraded, detail })
      return present(items, { scanned: candidates.length, ...(degraded ? { degraded, detail } : {}) })
    },

    clear() {
      cache.clear()
    },
  }
}
