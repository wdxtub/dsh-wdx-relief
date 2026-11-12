/**
 * 会话回顾：在输入框上方用一行告诉用户「现在到哪」。
 *
 * 设计约束：
 * - 纯 UI：只读 `deriveMessages()`，模型调用走 `ctx.llm.stream`，不写会话日志、
 *   不 append 消息、不注入 system prompt，因此摘要永远不会进入模型上下文；
 * - 逐轮触发，但不是每轮都烧模型：`minTurns` 之前不生成，`cooldownTurns`
 *   控制更新频率，`similarityThreshold` 让变化不大时沿用上一行；
 * - 模型链：先按用户配置的 `provider/model` 顺序尝试，再退到自动挑出的便宜模型，
 *   最后退回当前默认模型；
 * - 模型失败时退回「要求 · 结果」的本地短拼接，保证这一行不会空着。
 */

import { messageText } from './prediction.js'

const MAX_SUMMARY_INPUT_USER = 700
const MAX_SUMMARY_INPUT_ASSISTANT = 1200
const MAX_SUMMARY_CHARS = 120
const MAX_OUTPUT_TOKENS = 512
const SUMMARY_TIMEOUT_MS = 8000

export const DEFAULT_MIN_TURNS = 3
export const DEFAULT_COOLDOWN_TURNS = 3
export const DEFAULT_SIMILARITY_THRESHOLD = 0.7
export const DEFAULT_MAX_WORDS = 40

/** 便宜模型的名字通常带这些词；只用于自动挑选，不改变用户显式配置的顺序。 */
const CHEAP_HINTS = [
  'flash',
  'mini',
  'lite',
  'light',
  'small',
  'haiku',
  'turbo',
  'nano',
  'air',
  'spark',
  'fast',
  'cheap',
  'efficient',
]

const MAX_MESSAGES = 6
const MAX_MESSAGE_CHARS = 800
const MAX_USER_CHARS = 120
const MAX_ASSISTANT_CHARS = 180

/** 助手把下一步单独成行时，优先展示这一行，而不是泛泛的第一句。 */
const NEXT_LINE_RE = /^(下一步|接下来|还需要|需要你|等你|请|next step|you need|please|waiting for)/i

const FENCED_CODE_RE = /```[\s\S]*?```/g

function clip(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trim()}…`
}

/** 去掉标题、列表、引用和强调标记，让一行回顾更像人话。 */
function stripMarkdown(line) {
  return String(line)
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^>\s?/u, '')
    .replace(/^[-*+]\s+/u, '')
    .replace(/^\d+[.)]\s+/u, '')
    .replace(/[*_`~]/g, '')
    .trim()
}

function firstLine(text, maxChars) {
  const withoutCode = String(text ?? '').replace(FENCED_CODE_RE, ' ')
  for (const rawLine of withoutCode.split(/\r?\n/u)) {
    const line = stripMarkdown(rawLine)
    if (line !== '') return clip(line, maxChars)
  }
  return ''
}

/** 取助手最后一句问句；没有就返回空字符串。 */
function lastQuestion(text) {
  const withoutCode = String(text ?? '').replace(FENCED_CODE_RE, ' ')
  const tail = withoutCode.slice(-600)
  const match = tail.match(/(?:^|[\n。！？!?]\s*)([^。！？!?\n]{2,160}[？?])\s*$/u)
  return match === null ? '' : clip(stripMarkdown(match[1]), 160)
}

/** 优先「下一步/需要你」行，其次第一条正文。 */
function assistantSummary(text) {
  const withoutCode = String(text ?? '').replace(FENCED_CODE_RE, ' ')
  for (const rawLine of withoutCode.split(/\r?\n/u)) {
    const line = stripMarkdown(rawLine)
    if (line !== '' && NEXT_LINE_RE.test(line)) return clip(line, MAX_ASSISTANT_CHARS)
  }
  // 下一步常和结论写在同一段里，再按句号切一次。
  for (const rawSentence of withoutCode.split(/(?<=[。！？!?])\s*/u)) {
    const sentence = stripMarkdown(rawSentence)
    if (sentence !== '' && NEXT_LINE_RE.test(sentence)) return clip(sentence, MAX_ASSISTANT_CHARS)
  }
  return firstLine(text, MAX_ASSISTANT_CHARS)
}

/**
 * 从模型可见消息里提取一行回顾所需的结构化字段。
 * 返回 null 表示没有足够的历史（空会话或只有工具消息）。
 *
 * @param {Array<object>} messages - Session.deriveMessages() 的结果
 * @param {{ maxMessages?: number, maxMessageChars?: number }} [options]
 * @returns {{ kind: 'answered'|'question'|'waiting'|'assistant', user: string|null, assistant: string|null, question: string|null }|null}
 */
export function buildRecap(messages, options = {}) {
  const maxMessages = options.maxMessages ?? MAX_MESSAGES
  const maxMessageChars = options.maxMessageChars ?? MAX_MESSAGE_CHARS

  const items = []
  for (const message of messages ?? []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
    if (message.role === 'user' && message.source && message.source.kind !== 'user') continue
    const raw = messageText(message)
    if (raw === '') continue
    items.push({ role: message.role, text: clip(raw, maxMessageChars) })
  }
  if (items.length === 0) return null

  const tail = items.slice(-maxMessages)
  let lastUser = -1
  let lastAssistant = -1
  for (let index = 0; index < tail.length; index += 1) {
    if (tail[index].role === 'user') lastUser = index
    else lastAssistant = index
  }

  const user = lastUser === -1 ? null : firstLine(tail[lastUser].text, MAX_USER_CHARS) || null

  if (lastAssistant === -1) {
    return { kind: 'waiting', user, assistant: null, question: null }
  }
  if (lastUser === -1) {
    return { kind: 'assistant', user: null, assistant: assistantSummary(tail[lastAssistant].text), question: null }
  }
  if (lastAssistant < lastUser) {
    return { kind: 'waiting', user, assistant: null, question: null }
  }

  const assistantText = tail[lastAssistant].text
  const question = lastQuestion(assistantText)
  if (question !== '') {
    return { kind: 'question', user, assistant: null, question }
  }
  return {
    kind: 'answered',
    user,
    assistant: assistantSummary(assistantText),
    question: null,
  }
}

/** 会话里真正由人发出的用户消息数量，用来对应 minTurns。 */
export function countUserTurns(messages) {
  let count = 0
  for (const message of messages ?? []) {
    if (!message || message.role !== 'user') continue
    if (message.source && message.source.kind !== 'user') continue
    if (messageText(message) !== '') count += 1
  }
  return count
}

/**
 * 按词预算截断；中文、日文、韩文按「字」算，英文按空格分隔的词算。
 * pi-recap 的 `maxWords` 在中文里没有意义，这里保留同一个配置名但换成混排计数。
 */
export function limitWords(value, maxWords = DEFAULT_MAX_WORDS) {
  const text = String(value ?? '').trim()
  const budget = Number.isFinite(maxWords) ? Math.max(1, Math.floor(maxWords)) : DEFAULT_MAX_WORDS
  if (text === '') return ''

  let units = 0
  let inLatinWord = false
  let output = ''
  for (const char of text) {
    const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
    const latin = /[A-Za-z0-9]/u.test(char)
    if (wide) {
      units += 1
      inLatinWord = false
    } else if (latin) {
      if (!inLatinWord) units += 1
      inLatinWord = true
    } else {
      inLatinWord = false
    }
    if (units > budget) return `${output.trim()}…`
    output += char
  }
  return output.trim()
}

/** 词集合 Jaccard；中文按字、英文按词，和 pi-recap 的相似度门限语义一致。 */
export function similarity(left, right) {
  const tokenize = (value) => {
    const normalized = String(value ?? '').toLowerCase()
    const tokens = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[a-z0-9]+(?:['’-][a-z0-9]+)*/gu)
    return new Set(tokens ?? [])
  }
  const a = tokenize(left)
  const b = tokenize(right)
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const token of a) if (b.has(token)) overlap += 1
  const union = new Set([...a, ...b])
  return overlap / union.size
}

/** 模型不可用时的退路：两段各截一小段，避免把长消息原样贴出来。 */
export function fallbackSummary(recap) {
  if (!recap) return ''
  const user = clip(recap.user, 40)
  const tail = clip(recap.assistant || recap.question || '', 60)
  if (recap.kind === 'waiting' || tail === '') return user === '' ? '' : `${user} · 尚未回复`
  return user === '' ? tail : `${user} · ${tail}`
}

/** 清掉模型可能带上的前缀、引号和换行。 */
export function sanitizeSummary(raw, maxWords = DEFAULT_MAX_WORDS) {
  if (typeof raw !== 'string') return ''
  let text = raw.trim().replace(/\s+/g, ' ')
  text = text.replace(/^\*\*(.+)\*\*$/u, '$1')
  text = text.replace(/^[-*+>]\s*/u, '')
  text = text.replace(/^※\s*/u, '')
  text = text.replace(/^(摘要|上次进度|进度|summary|recap)\s*[:：]\s*/iu, '')
  text = text.replace(/^["'“”「『]+|["'“”」』]+$/gu, '').trim()
  if (text === '') return ''
  return limitWords(text, Math.min(maxWords, MAX_SUMMARY_CHARS))
}

const ENDING_PUNCT = /[。！？!?…．.」』”’）)】\]]$/u
const TRAILING_CONNECTOR = /[，,、；;：:（(【「『—\-～~]$/u
const CLAUSE_SPLIT = /[，,；;：:、。！？!?…]/u

/**
 * 模型有时会吐半句就停（例如「…表前缀已替换，待」）。这种结尾不能直接上线：
 * 判断标准是「没有句末标点，且最后一个分句只剩 1-2 个字」，或者停在连接符上。
 */
export function unfinishedEnding(value) {
  const text = String(value ?? '').trim()
  if (text === '') return false
  if (ENDING_PUNCT.test(text)) return false
  if (TRAILING_CONNECTOR.test(text)) return true
  const clauses = text.split(CLAUSE_SPLIT)
  if (clauses.length < 2) return false
  const tail = clauses[clauses.length - 1].trim()
  return tail !== '' && tail.length <= 2
}

/** 重试也没拿到完整结尾时，退到最后一个分句边界，别让面板停在半个词上。 */
export function trimUnfinished(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  const boundaries = ['，', ',', '；', ';', '：', ':', '、']
  const cut = Math.max(...boundaries.map((mark) => text.lastIndexOf(mark)))
  if (cut <= 0) return text
  return `${text.slice(0, cut)}…`
}

/** 摘要只需要最近一轮，不把整个会话塞进 prompt。 */
export function buildSummaryPrompt(recap) {
  const lines = [`用户：${clip(recap.user, MAX_SUMMARY_INPUT_USER)}`]
  if (recap.assistant) lines.push(`助手：${clip(recap.assistant, MAX_SUMMARY_INPUT_ASSISTANT)}`)
  else if (recap.question) lines.push(`助手最后问：${clip(recap.question, 200)}`)
  else lines.push('助手：（尚未回复）')
  return lines.join('\n')
}

export function buildSummarySystemPrompt(maxWords = DEFAULT_MAX_WORDS) {
  return [
    '你在写会话的「最近进度」：帮刚回到会话的人三秒内接上。',
    '输入是最近一轮对话：用户的要求，和助手最后的回复。',
    '输出一行字，包含两部分：',
    '1) 用户要做的事——长段落只留目标，概括，不要照抄原话；',
    '2) 现在到哪——已完成什么、卡在哪、或待确认什么。',
    `限制：不超过 ${maxWords} 个词（中文按字计）；用陈述句；`,
    '不出现「你」「我」「用户说」；不要引号、编号、前缀或解释；只输出这一行。',
  ].join('\n')
}

function read(config, field, fallback) {
  try {
    const value = config && config[field] && typeof config[field].get === 'function' ? config[field].get() : undefined
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

function unitRatio(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback
}

/** 把 Config 读取集中在一处，服务和测试都按同一套默认值走。 */
export function readRecapConfig(config) {
  return {
    enabled: read(config, 'recap', true) !== false,
    minTurns: positiveInt(read(config, 'recapMinTurns', DEFAULT_MIN_TURNS), DEFAULT_MIN_TURNS),
    cooldownTurns: positiveInt(read(config, 'recapCooldownTurns', DEFAULT_COOLDOWN_TURNS), DEFAULT_COOLDOWN_TURNS),
    similarityThreshold: unitRatio(read(config, 'recapSimilarityThreshold', DEFAULT_SIMILARITY_THRESHOLD), DEFAULT_SIMILARITY_THRESHOLD),
    maxWords: positiveInt(read(config, 'recapMaxWords', DEFAULT_MAX_WORDS), DEFAULT_MAX_WORDS),
    chain: String(read(config, 'recapModelChain', '') ?? '').trim(),
  }
}

/** `provider/model` 或裸模型 id。 */
export function splitModelRef(value) {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  const separator = text.indexOf('/')
  if (separator <= 0 || separator === text.length - 1) return { model: text }
  return { provider: text.slice(0, separator).trim(), model: text.slice(separator + 1).trim() }
}

/** 逗号、换行或空格分隔的模型链。 */
export function parseModelChain(value) {
  return String(value ?? '')
    .split(/[\n,，]+/u)
    .map((item) => splitModelRef(item))
    .filter((item) => item !== undefined && item.model !== '')
}

function cheapScore(model) {
  const haystack = `${model.id ?? ''} ${model.name ?? ''}`.toLowerCase()
  let score = 0
  for (const hint of CHEAP_HINTS) {
    if (haystack.includes(hint)) score += 10 - CHEAP_HINTS.indexOf(hint) / 10
  }
  return score
}

async function listCatalog(llm) {
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return []
  let providers
  try {
    providers = llm.listProviders()
  } catch {
    return []
  }
  const catalog = []
  for (const provider of providers ?? []) {
    const id = typeof provider === 'string' ? provider : provider && provider.id
    if (typeof id !== 'string' || id === '') continue
    try {
      const models = await llm.listModels(id)
      for (const model of models ?? []) {
        if (!model || typeof model.id !== 'string' || model.id === '') continue
        catalog.push({ provider: id, model: model.id, name: typeof model.name === 'string' ? model.name : '' })
      }
    } catch {
      // 某个 provider 的目录读不到时不影响其它 provider。
    }
  }
  return catalog
}

/**
 * 模型选择链：显式配置 → 自动挑出的便宜模型 → 当前默认模型。
 * 只在调用前排序，真正可用性由 `generateSummary` 逐个尝试决定（凭据缺失等
 * 只能在请求时暴露）。
 *
 * @returns {Promise<Array<{provider: string, model: string}>>}
 */
export async function resolveModelCandidates({ llm, defaultSelection, chain = '', limit = 4 }) {
  const candidates = []
  const seen = new Set()
  const push = (provider, model) => {
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return
    const key = `${provider}\u0000${model}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ provider, model })
  }

  let defaultSelectionValue
  try {
    defaultSelectionValue = defaultSelection?.()
  } catch {
    defaultSelectionValue = undefined
  }

  const configured = parseModelChain(chain)
  const catalog = configured.some((item) => item.provider === undefined) ? await listCatalog(llm) : []

  for (const item of configured) {
    if (item.provider !== undefined) {
      push(item.provider, item.model)
      continue
    }
    if (defaultSelectionValue && typeof defaultSelectionValue.provider === 'string') {
      push(defaultSelectionValue.provider, item.model)
    }
    for (const entry of catalog) {
      if (entry.model === item.model) push(entry.provider, entry.model)
    }
  }

  if (configured.length === 0) {
    const autoCatalog = catalog.length === 0 ? await listCatalog(llm) : catalog
    const cheap = autoCatalog
      .filter((entry) => cheapScore(entry) > 0)
      .sort((left, right) => cheapScore(right) - cheapScore(left))
    for (const entry of cheap.slice(0, 2)) push(entry.provider, entry.model)
  }

  if (defaultSelectionValue && typeof defaultSelectionValue.provider === 'string' && typeof defaultSelectionValue.model === 'string') {
    push(defaultSelectionValue.provider, defaultSelectionValue.model)
  }

  return candidates.slice(0, Math.max(1, limit))
}

async function streamOnce({ service, candidate, recap, maxWords, signal, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let text = ''
  let finished = false
  try {
    const stream = service.stream({
      provider: candidate.provider,
      model: candidate.model,
      system: buildSummarySystemPrompt(maxWords),
      messages: [{ role: 'user', content: [{ type: 'text', text: buildSummaryPrompt(recap) }] }],
      maxTokens: Math.min(MAX_OUTPUT_TOKENS, Math.max(96, maxWords * 6)),
      temperature: 0.3,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish') {
        finished = true
        const kind = chunk.reason && chunk.reason.kind
        if (kind === 'error' || kind === 'aborted') {
          const failure = chunk.reason && chunk.reason.failure
          throw new Error(failure && failure.message ? failure.message : `model stream ${kind}`)
        }
        if (kind === 'length') throw new Error('model output truncated')
      }
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
  if (!finished) throw new Error('model stream ended without finish')
  const cleaned = sanitizeSummary(text, maxWords)
  if (cleaned === '') throw new Error('empty model output')
  return cleaned
}

/**
 * 按链尝试生成摘要；全部失败返回 null，由调用方退回本地拼接。
 * @returns {Promise<{ text: string, provider: string, model: string }|null>}
 */
export async function generateSummary({ llm, defaultSelection, recap, chain, maxWords, signal, timeoutMs = SUMMARY_TIMEOUT_MS, log = () => {} }) {
  const service = typeof llm === 'function' ? llm() : llm
  if (!service || typeof service.stream !== 'function') return null
  const candidates = await resolveModelCandidates({ llm: service, defaultSelection, chain })
  // 整条链共享 15 秒预算：便宜模型失败时快速换下一个，不让这一行拖住。
  const deadline = Date.now() + 15000
  let salvage = null
  for (const candidate of candidates) {
    if (signal && signal.aborted) return null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      try {
        const text = await streamOnce({ service, candidate, recap, maxWords, signal, timeoutMs: Math.min(timeoutMs, remaining) })
        if (unfinishedEnding(text)) {
          // 模型写了半句就停（「…表前缀已替换，待」）：先在同一模型上重试一次。
          log(`[wdx-relief] recap model ${candidate.provider}/${candidate.model} returned a half sentence`)
          salvage = { text, provider: candidate.provider, model: candidate.model }
          continue
        }
        return { text, provider: candidate.provider, model: candidate.model }
      } catch (error) {
        log(`[wdx-relief] recap model ${candidate.provider}/${candidate.model} failed`, error)
        break
      }
    }
  }
  if (salvage !== null) {
    const text = trimUnfinished(salvage.text)
    if (text !== '') return { ...salvage, text }
  }
  return null
}

function recapKey(turn, recap) {
  return [String(turn), recap.user ?? '', recap.assistant ?? '', recap.question ?? ''].join('\u0000')
}

export function createRecapService({ config, sessions, llm, defaultSelection, history, log = () => {} }) {
  /** sessionId -> { key, turn, recap, generatedTurn, model } */
  const cache = new Map()
  const inFlight = new Map()

  function remember(sessionId, value) {
    if (cache.size >= 200) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(sessionId, value)
  }

  return {
    /**
     * 返回 { recap, turn, cached?, skipped?, kept?, degraded?, model? }。
     * 业务失败抛错，由 HTTP 层转成 ok:false。
     */
    async recap(sessionId, signal) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        const error = new Error('sessionId is required')
        error.code = 'invalid-params'
        throw error
      }
      const settings = readRecapConfig(config)
      if (!settings.enabled) return { recap: null, disabled: true }

      const session = sessions.get(sessionId)
      if (session === undefined) {
        const error = new Error(`session "${sessionId}" is unavailable`)
        error.code = 'not-found'
        throw error
      }

      let messages
      try {
        messages = session.deriveMessages()
      } catch (error) {
        log('[wdx-relief] recap deriveMessages failed', error)
        return { recap: null, turn: 0 }
      }

      const turn = countUserTurns(messages)
      const recap = buildRecap(messages)
      if (recap === null) return { recap: null, turn }

      const key = recapKey(turn, recap)
      const previous = cache.get(sessionId)
      if (previous !== undefined && previous.key === key) {
        return { recap: previous.recap, turn, cached: true, model: previous.model }
      }

      if (turn < settings.minTurns) {
        return { recap: previous?.recap ?? null, turn, skipped: 'min-turns' }
      }

      if (previous !== undefined && turn - previous.generatedTurn < settings.cooldownTurns) {
        return { recap: previous.recap, turn, skipped: 'cooldown', model: previous.model }
      }

      const flightKey = `${sessionId}\u0000${key}`
      const pending = inFlight.get(flightKey)
      if (pending !== undefined) return pending

      const task = (async () => {
        const generated = await generateSummary({
          llm,
          defaultSelection,
          recap,
          chain: settings.chain,
          maxWords: settings.maxWords,
          signal,
          log,
        })
        const text = generated === null ? limitWords(fallbackSummary(recap), settings.maxWords) : generated.text
        const degraded = generated === null

        // 生成失败（模型不可用、被取消）时不缓存、不写历史：这行只是当前轮的兜底，
        // 下一轮继续尝试；否则一条本地拼接会沿用整个 cooldown 窗口。
        if (degraded) {
          return { recap: { ...recap, summary: text, turn }, turn, model: null, degraded: true }
        }

        if (previous !== undefined && previous.recap.summary && text !== '' && settings.similarityThreshold > 0 && similarity(previous.recap.summary, text) >= settings.similarityThreshold) {
          const kept = {
            ...previous,
            key,
            turn,
            generatedTurn: turn,
          }
          remember(sessionId, kept)
          return { recap: kept.recap, turn, kept: true, model: kept.model, degraded: generated === null }
        }

        const final = { ...recap, summary: text, turn }
        const state = {
          key,
          turn,
          recap: final,
          generatedTurn: turn,
          model: generated === null ? null : `${generated.provider}/${generated.model}`,
        }
        remember(sessionId, state)
        if (history) {
          try {
            history.append({ sessionId, seq: session.seq, ...final })
          } catch (error) {
            log('[wdx-relief] recap history append failed', error)
          }
        }
        return { recap: final, turn, model: state.model, degraded }
      })()

      inFlight.set(flightKey, task)
      try {
        return await task
      } finally {
        inFlight.delete(flightKey)
      }
    },

    /** 测试 / 会话销毁时清理缓存。 */
    clear(sessionId) {
      if (sessionId === undefined) cache.clear()
      else cache.delete(sessionId)
    },
  }
}
