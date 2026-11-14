/**
 * 下一句输入预测：把「用户与 coding agent 的最近对话」压成一段上下文，
 * 让当前默认模型猜一条用户接下来最可能发送的消息。
 *
 * 设计约束：
 * - 只读会话日志（deriveMessages），不往会话里写任何东西；
 * - 预测是辅助请求，不进 session log，也不触发 agent loop；
 * - 一次对话轮次只生成一次，按 session.seq 缓存，客户端重复调用不重复烧 token。
 */

const MAX_MESSAGES = 8
const MAX_MESSAGE_CHARS = 1600
const MAX_PROMPT_CHARS = 6000
const MAX_SUGGESTION_CHARS = 60
const MAX_OUTPUT_TOKENS = 800
const MODEL_TIMEOUT_MS = 15000

export const SYSTEM_PROMPT = [
  '你是一个「下一句输入」预测器。你会看到用户和编码 agent 的最近对话，任务是预测用户接下来最可能发送的一条消息。',
  '要求：',
  '- 只输出一条消息本身，尽可能短：中文不超过 30 个字，英文不超过 15 个词，像用户会直接打进输入框的话。',
  '- 使用与用户最近消息相同的语言。',
  '- 优先给出具体动作、回答 agent 的提问、或确认下一步；不要泛泛地说「继续」。',
  '- 不要重复助手说过的话，也不要复述用户上一条消息。',
  '- 「助手（提问）」/「用户（回答）」是助手用提问框向用户确认、用户点选的答案，按已经发生的对话处理。',
  '- 不要解释、不要引号、不要编号、不要加「预测：」之类的前缀。',
  '- 没有足够信息时只输出 <none>。',
].join('\n')

const NONE_RE = /^(<none>|none|null|nil|n\/a|无|没有|无法预测|不确定)[。.!！]?$/i
const REFUSAL_RE = /^(我无法|无法预测|抱歉|对不起|sorry|i can(?:'|no)t)/i

/** 保留开头和结尾，中间省略；长 prompt 的诉求常在末尾。 */
function clipText(text, maxChars) {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** 取出消息里的纯文本块，忽略 reasoning、图片、工具块。 */
export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text.trim())
    }
  }
  return parts.join('\n').trim()
}

/** 提问框工具：助手用它让用户点选答案，答案不会以用户消息的形式出现。 */
const QUESTION_TOOL = 'ask_user_question'
const MAX_QUESTION_CHARS = 400
const MAX_ANSWER_CHARS = 200

function parseObject(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 「要写入吗？（选项：可以、先别）」——把提问框的问题压成一行。 */
function questionLine(questions) {
  const parts = []
  for (const question of Array.isArray(questions) ? questions : []) {
    if (question === null || typeof question !== 'object') continue
    const text = typeof question.question === 'string' ? question.question.trim() : ''
    if (text === '') continue
    const labels = (Array.isArray(question.options) ? question.options : [])
      .map((option) => (option !== null && typeof option === 'object' && typeof option.label === 'string' ? option.label.trim() : ''))
      .filter((label) => label !== '')
      .slice(0, 4)
    parts.push(labels.length === 0 ? text : `${text}（选项：${labels.join('、')}）`)
  }
  return parts.join('；')
}

/** 用户的点选结果；多问题时带上题目，单独一题时靠上一行提问就够。 */
function answerLine(answers, questions) {
  const questionById = new Map()
  let questionCount = 0
  for (const question of Array.isArray(questions) ? questions : []) {
    if (question === null || typeof question !== 'object') continue
    questionCount += 1
    const text = typeof question.question === 'string' ? question.question.trim() : ''
    if (typeof question.id === 'string' && text !== '') questionById.set(question.id, text)
  }

  const parts = []
  for (const answer of Array.isArray(answers) ? answers : []) {
    if (answer === null || typeof answer !== 'object') continue
    const selected = (Array.isArray(answer.selected) ? answer.selected : [])
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim())
    const custom = typeof answer.custom === 'string' ? answer.custom.trim() : ''
    let picked
    if (selected.length === 0) picked = custom === '' ? '跳过' : `自定义：${custom}`
    else picked = custom === '' ? selected.join('、') : `${selected.join('、')}（补充：${custom}）`
    const prompt = questionCount > 1 && typeof answer.id === 'string' ? questionById.get(answer.id) : undefined
    parts.push(prompt === undefined ? picked : `${prompt} → ${picked}`)
  }
  return parts.join('；')
}

/**
 * 从 deriveMessages() 里截出最近几轮可读对话。
 * 只保留真人用户消息（source.kind === 'user'，排除注入的上下文）和助手消息；
 * 提问框的问答要单独还原：前台回答写在工具结果的 JSON 里，排队回答是
 * `source.kind === 'user-question-reply'` 的用户消息，两者都不是普通用户文本。
 * 少了这两行，最近几轮看起来就像助手没问过就直接把事做完了。
 * 最后一条必须是助手，否则说明当前轮次还没结束，不该预测。
 */
export function extractConversation(messages, options = {}) {
  const maxMessages = options.maxMessages ?? MAX_MESSAGES
  const maxMessageChars = options.maxMessageChars ?? MAX_MESSAGE_CHARS
  const maxPromptChars = options.maxPromptChars ?? MAX_PROMPT_CHARS

  const items = []
  /** callId -> 这一问的问题列表，用来给回答补上题目。 */
  const asked = new Map()
  const answered = new Set()

  const pushAnswer = (callId, answers, questions) => {
    if (typeof callId === 'string') {
      if (answered.has(callId)) return
      answered.add(callId)
    }
    const text = answerLine(answers, questions)
    if (text === '') return
    items.push({ role: 'user', kind: 'answer', text: clipText(text, MAX_ANSWER_CHARS) })
  }

  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue

    // 前台回答：ask_user_question 的结果落在一条 role: 'tool' 的消息里。
    if (message.role === 'tool') {
      const source = message.source
      const callId = typeof message.toolCallId === 'string'
        ? message.toolCallId
        : source && typeof source === 'object' && typeof source.callId === 'string' ? source.callId : undefined
      if (callId === undefined || !asked.has(callId) || message.isError === true) continue
      const result = parseObject(messageText(message))
      if (result !== null && Array.isArray(result.answers)) pushAnswer(callId, result.answers, asked.get(callId))
      continue
    }

    if (message.role === 'user') {
      const source = message.source
      // 排队回答：用户回答在等待窗口关闭后才到达时，DSH 会追加一条用户消息。
      if (source && typeof source === 'object' && source.kind === 'user-question-reply') {
        const reply = parseObject(messageText(message))
        if (reply === null || !Array.isArray(reply.answers)) continue
        const callId = typeof source.callId === 'string'
          ? source.callId
          : typeof reply.callId === 'string' ? reply.callId : undefined
        pushAnswer(callId, reply.answers, Array.isArray(reply.questions) ? reply.questions : (callId === undefined ? undefined : asked.get(callId)))
        continue
      }
      if (source && typeof source === 'object' && source.kind !== 'user') continue
    } else if (message.role !== 'assistant') {
      continue
    }

    const raw = messageText(message)
    if (raw !== '') items.push({ role: message.role, text: clipText(raw, maxMessageChars) })

    const blocks = message.role === 'assistant' && Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || block.type !== 'tool-call' || block.name !== QUESTION_TOOL) continue
      const args = parseObject(block.arguments)
      const questions = args === null ? [] : Array.isArray(args.questions) ? args.questions : []
      const text = questionLine(questions)
      if (text === '') continue
      if (typeof block.id === 'string') asked.set(block.id, questions)
      items.push({ role: 'assistant', kind: 'question', text: clipText(text, MAX_QUESTION_CHARS) })
    }
  }

  if (items.length < 2) return null
  if (items[items.length - 1].role !== 'assistant') return null

  const tail = []
  let total = 0
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (tail.length >= maxMessages) break
    if (tail.length > 0 && total + item.text.length > maxPromptChars) break
    tail.unshift(item)
    total += item.text.length
  }
  return tail
}

/** 提问框的问答要标出来，模型才知道这是用户在弹窗里点的，不是随口说的。 */
function speakerOf(item) {
  if (item.kind === 'question') return '助手（提问）'
  if (item.kind === 'answer') return '用户（回答）'
  return item.role === 'user' ? '用户' : '助手'
}

/** 把对话尾段拼成给模型的 user prompt。 */
export function buildPrompt(conversation) {
  const transcript = conversation
    .map((item) => `${speakerOf(item)}：${item.text}`)
    .join('\n\n')
  return [
    '以下是用户与编码 agent 的最近对话：',
    '',
    transcript,
    '',
    '请只输出用户接下来最可能发送的一条消息。不要解释，不要加引号，不要写「预测：」。',
  ].join('\n')
}

/**
 * 清理模型输出：一行、无前缀、无引号、去掉拒答与 <none>。
 * 返回 null 表示这一轮不该给建议（前端直接不显示）。
 */
export function sanitizeSuggestion(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.replace(/```[a-zA-Z0-9_-]*/g, '').trim()
  if (text === '') return null

  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
  if (firstLine === undefined) return null
  text = firstLine

  text = text.replace(/^(预测|next(?:\s+message)?|用户|user)\s*[:：]\s*/i, '')
  text = text.replace(/^[-*•]\s+/, '')
  text = text.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
  text = text.replace(/\s+/g, ' ').trim()

  if (NONE_RE.test(text) || REFUSAL_RE.test(text)) return null
  if (text.length < 2) return null
  if (text.length > MAX_SUGGESTION_CHARS) text = text.slice(0, MAX_SUGGESTION_CHARS).trim()
  return text === '' ? null : text
}

/** 归一化后比较，防止预测复述用户上一条消息。 */
export function sameMessage(a, b) {
  const normalize = (value) => String(value ?? '').replace(/\s+/g, '').replace(/[。.!！?？,，、;；:：]/g, '')
  const left = normalize(a)
  const right = normalize(b)
  return left !== '' && left === right
}

/**
 * 预测服务：缓存、并发合并、模型调用。
 * @param {object} options
 * @param {object|undefined} options.config - 插件 Config（enabled 为 live reference）
 * @param {object} options.sessions - ctx.sessions
 * @param {object|undefined} options.llm - ctx.llm
 * @param {() => object|null} options.defaultSelection - 读取默认模型
 * @param {(message: string, error?: unknown) => void} [options.log]
 */
export function createPredictionService({ config, sessions, llm, defaultSelection, log = () => {} }) {
  /** sessionId -> { seq, suggestion } */
  const cache = new Map()
  /** `${sessionId}:${seq}` -> Promise */
  const inflight = new Map()
  /** provider/model -> 最低推理档位（辅助请求不沿用会话的 high effort） */
  const lowEffortCache = new Map()

  async function resolveLowEffort(llmService, selection, signal) {
    const key = `${selection.provider}\u0000${selection.model}`
    if (lowEffortCache.has(key)) return lowEffortCache.get(key)
    let effort
    try {
      const info = await llmService.resolveModelInfo(selection.provider, selection.model, signal)
      const first = info && info.reasoning && Array.isArray(info.reasoning.efforts)
        ? info.reasoning.efforts[0]
        : undefined
      effort = first && typeof first.id === 'string' ? first.id : undefined
    } catch {
      effort = undefined
    }
    lowEffortCache.set(key, effort)
    return effort
  }

  const enabled = () => {
    try {
      return config?.enabled?.get?.() !== false
    } catch {
      return true
    }
  }

  function readSelection() {
    const selection = defaultSelection?.()
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null
    return selection
  }

  async function generate({ conversation, selection, signal }) {
    const llmService = typeof llm === 'function' ? llm() : llm
    if (!llmService || typeof llmService.stream !== 'function') throw new Error('llm service is unavailable')
    const prompt = buildPrompt(conversation)
    let text = ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const reasoningEffort = await resolveLowEffort(llmService, selection, controller.signal)
      const stream = llmService.stream({
        provider: selection.provider,
        model: selection.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.4,
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

  function remember(sessionId, seq, suggestion) {
    if (cache.size >= 200) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(sessionId, { seq, suggestion })
  }

  return {
    /**
     * 返回 { suggestion: string|null, disabled?: boolean, cached?: boolean }。
     * 失败会抛出，由 HTTP 层转成 ok:false。
     */
    async predict(sessionId, signal) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        const error = new Error('sessionId is required')
        error.code = 'invalid-params'
        throw error
      }
      if (!enabled()) return { suggestion: null, disabled: true }

      const session = sessions.get(sessionId)
      if (session === undefined) {
        const error = new Error(`session "${sessionId}" is unavailable`)
        error.code = 'not-found'
        throw error
      }

      const seq = session.seq
      const cached = cache.get(sessionId)
      if (cached !== undefined && cached.seq === seq) {
        return { suggestion: cached.suggestion, cached: true }
      }

      const key = `${sessionId}:${seq}`
      const running = inflight.get(key)
      if (running !== undefined) return running

      const task = (async () => {
        let conversation
        try {
          conversation = extractConversation(session.deriveMessages())
        } catch (error) {
          log('deriveMessages failed', error)
          remember(sessionId, seq, null)
          return { suggestion: null }
        }
        if (conversation === null) {
          remember(sessionId, seq, null)
          return { suggestion: null }
        }

        const selection = readSelection()
        if (selection === null) {
          const error = new Error('no default model is configured')
          error.code = 'no-model'
          throw error
        }

        const lastUser = [...conversation].reverse().find((item) => item.role === 'user')
        let raw
        try {
          raw = await generate({ conversation, selection, signal })
        } catch (error) {
          log('prediction model call failed', error)
          throw error
        }
        let suggestion = sanitizeSuggestion(raw)
        if (suggestion !== null && lastUser !== undefined && sameMessage(suggestion, lastUser.text)) {
          suggestion = null
        }
        remember(sessionId, seq, suggestion)
        return { suggestion }
      })()

      inflight.set(key, task)
      try {
        return await task
      } finally {
        inflight.delete(key)
      }
    },

    /** 测试 / 会话销毁时清理缓存。 */
    clear(sessionId) {
      if (sessionId === undefined) cache.clear()
      else cache.delete(sessionId)
    },
  }
}