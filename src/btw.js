/**
 * 旁问：把用户的问题和最近几轮主对话作为背景，直接问当前会话模型。
 *
 * 关键约束：
 * - 只服务右侧 WDX Relief 面板的「旁问」区，不 append 任何 user/assistant 消息；
 * - 模型看不到这次问答，所以不会污染主上下文，也不会影响下一轮；
 * - 只发送最近几轮文本，且限制长度，旁问不是第二次完整会话。
 */

import { messageText } from './prediction.js'

const MAX_CONTEXT_MESSAGES = 6
const MAX_CONTEXT_MESSAGE_CHARS = 1200
const MAX_CONTEXT_TOTAL_CHARS = 5000
const MAX_QUESTION_CHARS = 4000
const MAX_ANSWER_CHARS = 8000
const MAX_OUTPUT_TOKENS = 1600
const TIMEOUT_MS = 30000

export const SYSTEM_PROMPT = [
  '你是用户主任务之外的旁问助手。只回答用户此刻的旁问，不执行主任务、不改文件、不调用工具。',
  '主对话片段只作背景，可能不完整；与旁问无关时忽略它，直接回答。',
  '回答使用用户提问的语言，简洁、直接；必要时给步骤或代码。',
  '不要提及「旁问」「上下文」或这次回答不会进入主对话。',
].join('\n')

function failure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function clip(value, maxChars) {
  const text = String(value ?? '').trim()
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/**
 * 取最近几轮真人用户/助手文本作为旁问背景。
 * 不接受注入上下文、工具消息和空文本。
 * @param {Array<object>} messages
 * @returns {Array<{ role: 'user'|'assistant', text: string }>}
 */
export function extractBtwContext(messages) {
  const items = []
  for (const message of messages ?? []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
    if (message.role === 'user' && message.source && message.source.kind !== 'user') continue
    const raw = messageText(message)
    if (raw === '') continue
    items.push({ role: message.role, text: clip(raw, MAX_CONTEXT_MESSAGE_CHARS) })
  }

  const tail = []
  let total = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (tail.length >= MAX_CONTEXT_MESSAGES) break
    if (tail.length > 0 && total + item.text.length > MAX_CONTEXT_TOTAL_CHARS) break
    tail.unshift(item)
    total += item.text.length
  }
  return tail
}

/** 拼出旁问的 user prompt；没有背景时只发问题。 */
export function buildBtwPrompt(question, context) {
  const input = String(question ?? '').trim().slice(0, MAX_QUESTION_CHARS)
  const lines = []
  if (context.length > 0) {
    lines.push('主对话的最近片段（仅作背景，可能不完整）：', '')
    for (const item of context) {
      lines.push(`${item.role === 'user' ? '用户' : '助手'}：${item.text}`, '')
    }
  }
  lines.push('用户的旁问：', input)
  return lines.join('\n')
}

/** 清理模型输出；返回 null 表示没有可用回答。 */
export function sanitizeAnswer(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  text = text.replace(/^(回答|answer)\s*[:：]\s*/iu, '')
  if (text.length > MAX_ANSWER_CHARS) text = `${text.slice(0, MAX_ANSWER_CHARS).trim()}…`
  return text === '' ? null : text
}

function readOverride(override) {
  if (override && typeof override.provider === 'string' && typeof override.model === 'string') {
    return { provider: override.provider, model: override.model }
  }
  return null
}

function readSelection(agent, fallback) {
  try {
    const current = agent?.model?.current?.()
    if (current && typeof current.provider === 'string' && typeof current.model === 'string') return current
  } catch {
    // 句柄未就绪时继续尝试默认模型。
  }
  try {
    const selection = fallback?.()
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') return selection
  } catch {
    // 没有默认模型时交给调用方报错。
  }
  return null
}

async function generate({ service, selection, question, context, signal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  let text = ''
  try {
    const stream = service.stream({
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildBtwPrompt(question, context) }],
      }],
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish') {
        const kind = chunk.reason && chunk.reason.kind
        if (kind === 'error' || kind === 'aborted') {
          const detail = chunk.reason && chunk.reason.failure
          throw new Error(detail && detail.message ? detail.message : `model stream ${kind}`)
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
 * 旁问服务：供面板的 `/api/wdx-relief/btw` 路由调用。
 * 只读会话与模型，不向会话写任何事件。
 *
 * @param {object} options
 * @param {object} options.sessions - ctx.sessions
 * @param {() => object|undefined} [options.agents] - 惰性读取 ctx.agents，用于拿到当前会话模型
 * @param {() => object|undefined} options.llm - 惰性读取 ctx.llm
 * @param {() => object|null} [options.defaultSelection] - 没有实时 agent 时的默认模型
 * @param {(message: string, error?: unknown) => void} [options.log]
 */
export function createBtwService({ sessions, agents, llm, defaultSelection, log = () => {} }) {
  function currentAgent(sessionId) {
    try {
      const registry = typeof agents === 'function' ? agents() : agents
      return registry?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  return {
    /**
     * 回答一次旁问，返回 { answer }。
     * 预期失败抛出带 code 的 Error，由 HTTP 路由转成 ok:false。
     *
     * @param {string} sessionId
     * @param {string} question
     * @param {AbortSignal} [signal]
     * @param {{ provider?: string, model?: string }} [override] - 面板里选的旁问模型；不传则用会话模型
     */
    async ask(sessionId, question, signal, override) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw failure('invalid-params', 'sessionId is required')
      }
      const input = String(question ?? '').trim()
      if (input === '') throw failure('invalid-params', '问题不能为空。')
      if (input.length > MAX_QUESTION_CHARS) {
        throw failure('invalid-params', `问题太长：请控制在 ${MAX_QUESTION_CHARS} 字以内。`)
      }

      const session = sessions.get(sessionId)
      if (session === undefined) throw failure('not-found', `session "${sessionId}" is unavailable`)

      let messages = []
      try {
        messages = session.deriveMessages()
      } catch (error) {
        log('side question deriveMessages failed', error)
      }

      const selection = readOverride(override) ?? readSelection(currentAgent(sessionId), defaultSelection)
      if (selection === null) throw failure('no-model', '没有可用的默认模型，无法回答旁问。')

      let service
      try {
        service = typeof llm === 'function' ? llm() : llm
      } catch (error) {
        log('side question llm lookup failed', error)
        throw failure('llm-unavailable', '模型服务不可用，无法回答旁问。')
      }
      if (!service || typeof service.stream !== 'function') {
        throw failure('llm-unavailable', '模型服务不可用，无法回答旁问。')
      }

      let raw
      try {
        raw = await generate({
          service,
          selection,
          question: input,
          context: extractBtwContext(messages),
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw failure('cancelled', '旁问已取消。')
        if (error && error.name === 'AbortError') throw failure('timeout', '旁问超时（30 秒）。')
        log('side question failed', error)
        const detail = error && error.message ? String(error.message) : String(error)
        throw failure('model-error', `旁问失败：${clip(detail, 300)}`)
      }

      const answer = sanitizeAnswer(raw)
      if (answer === null) throw failure('empty-answer', '模型没有返回可用的回答。')
      return { answer }
    },
  }
}
