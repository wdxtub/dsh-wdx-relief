/**
 * dsh-wdx-relief — Host 入口。
 *
 * 三件事：
 * 1. 注册认证路由 `POST /api/wdx-relief/predict`，按会话日志生成「下一句输入」；
 * 2. 把所有设置暴露成 volatile Config，供设置页读写并即时生效；
 * 3. 注册 `wdx-relief:reply-style` system prompt section，把回复风格编译成短指令。
 *
 * 预测走 ctx.llm + agentDefaultModel，不写 session log、不触发 agent loop。
 */
import Schema from '@deepseek-ai/schemastery'
import { createPredictionService } from './src/prediction.js'
import { AXIS_VALUES, BASE_STYLE_VALUES, VERBOSITY_VALUES, buildStylePrompt } from './src/style.js'

export const name = 'wdx-relief'

/** connection 提供认证 fetch 路由；sessions 读取会话日志。 */
export const inject = ['connection', 'sessions']

export const ROUTE_PATH = '/api/wdx-relief/predict'

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description('根据对话在输入框里显示下一条消息预测，Tab 填入'),
  verbosity: Schema.union(VERBOSITY_VALUES)
    .default('low')
    .volatile()
    .description('回复详细程度：model 表示不干预，low/medium/high 为固定偏好'),
  actionable: Schema.boolean()
    .default(true)
    .volatile()
    .description('便于行动：先给结果和下一步，少铺垫，保留风险与失败条件'),
  writingStyle: Schema.boolean()
    .default(false)
    .volatile()
    .description('参考用户在当前对话里的写作风格'),
  baseStyle: Schema.union(BASE_STYLE_VALUES)
    .default('default')
    .volatile()
    .description('整体风格与语气预设'),
  friendliness: Schema.union(AXIS_VALUES).default('default').volatile().description('亲切程度'),
  enthusiasm: Schema.union(AXIS_VALUES).default('default').volatile().description('热情程度'),
  emoji: Schema.union(AXIS_VALUES).default('default').volatile().description('表情符号使用程度'),
  visualAnswers: Schema.union(AXIS_VALUES).default('default').volatile().description('可视化回答程度'),
  headingsLists: Schema.union(AXIS_VALUES).default('default').volatile().description('标题和列表使用程度'),
  customInstructions: Schema.string()
    .default('')
    .volatile()
    .description('只影响回复表达的额外指令'),
})

/** 回复风格段落在 system prompt 中的顺序：放在部署 persona 之后。 */
export const STYLE_SECTION_ORDER = 10300

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function errorPayload(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'internal'
  const raw = error && error.message ? String(error.message) : String(error)
  const message = raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw
  return { ok: false, error: { code, message } }
}

async function handleRequest(request, service) {
  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: { code: 'invalid-params', message: '只支持 POST' } })
  }
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse(400, { ok: false, error: { code: 'invalid-params', message: '请求体不是合法 JSON' } })
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse(400, { ok: false, error: { code: 'invalid-params', message: '请求体必须是 JSON 对象' } })
  }
  try {
    const data = await service.predict(body.sessionId, request.signal)
    return jsonResponse(200, { ok: true, data })
  } catch (error) {
    // 业务失败（模型不可用、会话不存在等）统一 200 + ok:false，前端静默隐藏。
    const status = error && error.code === 'invalid-params' ? 400 : 200
    return jsonResponse(status, errorPayload(error))
  }
}

/**
 * Host 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, { get: () => unknown }>} config - Config 的 volatile 引用集合
 */
export function apply(ctx, config) {
  const service = createPredictionService({
    config,
    sessions: ctx.sessions,
    llm: () => ctx.get('llm'),
    defaultSelection: () => {
      try {
        const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
        return selection ?? null
      } catch {
        return null
      }
    },
    log: (message, error) => {
      const detail = error && error.message ? error.message : error === undefined ? '' : String(error)
      console.warn(`[wdx-relief] ${message}${detail === '' ? '' : `：${detail}`}`)
    },
  })

  ctx.inject(['systemPrompt'], (scope) => {
    console.log('[wdx-relief] 回复风格 prompt section 已注册')
    scope.systemPrompt.section({
      name: 'wdx-relief:reply-style',
      order: STYLE_SECTION_ORDER,
      interpolate: false,
      text: () => buildStylePrompt(config),
    })
  })

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request, service),
    })
    return () => {
      void dispose()
    }
  }, 'wdx-relief: /api/wdx-relief/predict route')
  console.log(`[wdx-relief] 预测路由已注册：${ROUTE_PATH}`)
}