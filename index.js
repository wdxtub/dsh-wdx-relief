/**
 * dsh-wdx-relief — Host 入口。
 *
 * 六件事：
 * 1. 注册认证路由 `POST /api/wdx-relief/predict`，按会话日志生成「下一句输入」；
 * 2. 注册认证路由 `POST /api/wdx-relief/recap`，按最近一轮生成「现在到哪」；
 * 3. 注册认证路由 `POST /api/wdx-relief/today`，整理「用户还没跟进的事」；
 *    `POST /api/wdx-relief/today/dismiss`、`.../restore` 记录面板里清掉 / 撤销的条目；
 *    `POST /api/wdx-relief/recaps` 读取某会话生成过的回顾历史；
 * 4. 注册认证路由 `POST /api/wdx-relief/btw`，回答右侧面板里的旁问；
 * 5. 把所有设置暴露成 volatile Config，供设置页读写并即时生效；
 * 6. 注册 `wdx-relief:reply-style` system prompt section，把回复风格编译成短指令。
 *
 * 预测、回顾和旁问都走 ctx.llm，不写 session log、不触发 agent loop；
 * 回顾的模型调用直接从服务流式读取，不 append 消息、不注入上下文，
 * 因此输入框上方那一行永远不会进入模型上下文。
 */
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createBtwService } from './src/btw.js'
import { createFollowupStore } from './src/followups.js'
import { createPredictionService } from './src/prediction.js'
import { createRecapService } from './src/recap.js'
import { createRecapHistory } from './src/recapHistory.js'
import { createTodayService } from './src/today.js'
import { STYLE_VALUES, VERBOSITY_VALUES, buildStylePrompt } from './src/style.js'

export const name = 'wdx-relief'

/** connection 提供认证 fetch 路由；sessions 读取会话日志；agents 由旁问惰性读取当前会话模型。 */
export const inject = ['connection', 'sessions']

export const ROUTE_PATH = '/api/wdx-relief/predict'
export const RECAP_PATH = '/api/wdx-relief/recap'
export const TODAY_PATH = '/api/wdx-relief/today'
export const RECAPS_PATH = '/api/wdx-relief/recaps'
export const BTW_PATH = '/api/wdx-relief/btw'
export const DISMISS_PATH = '/api/wdx-relief/today/dismiss'
export const RESTORE_PATH = '/api/wdx-relief/today/restore'

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description('根据对话在输入框下方显示下一条消息预测，Tab 填入'),
  recap: Schema.boolean()
    .default(true)
    .volatile()
    .description('输入框上方那一行的语义摘要：每几轮用一次便宜模型写「现在到哪」，不进入模型上下文'),
  recapActivity: Schema.boolean()
    .default(false)
    .volatile()
    .description('输入框上方那一行的活动流水：正在读文件、跑命令、改代码，本地生成，零模型调用'),
  recapTiming: Schema.boolean()
    .default(false)
    .volatile()
    .description('输入框上方那一行的耗时：这一轮跑了多久，本地生成'),
  recapReasoning: Schema.boolean()
    .default(false)
    .volatile()
    .description('输入框上方那一行的思考预览：折叠推理的第一行，本地生成'),
  recapPlacement: Schema.union(['above', 'below'])
    .default('above')
    .volatile()
    .description('这一行放在输入框上方还是下方'),
  recapMinTurns: Schema.number()
    .default(3)
    .volatile()
    .description('至少经过几轮用户消息后才开始生成语义摘要'),
  recapCooldownTurns: Schema.number()
    .default(3)
    .volatile()
    .description('每隔几轮才更新语义摘要；1 表示每轮'),
  recapSimilarityThreshold: Schema.number()
    .default(0.7)
    .volatile()
    .description('新旧摘要相似度达到这个值时沿用旧的一行（0–1）'),
  recapMaxWords: Schema.number()
    .default(40)
    .volatile()
    .description('语义摘要的词预算；中文按字算'),
  recapModelChain: Schema.string()
    .default('')
    .volatile()
    .description('摘要模型链，按顺序尝试 provider/model；留空自动挑便宜模型，最后退回默认模型'),
  today: Schema.boolean()
    .default(true)
    .volatile()
    .description('把过去会话里「提醒过你但你没跟进」的事整理成一小份清单'),
  verbosity: Schema.union(VERBOSITY_VALUES)
    .default('low')
    .volatile()
    .description('回复详细程度：model 表示不干预，low/medium/high 为固定偏好'),
  actionable: Schema.boolean()
    .default(true)
    .volatile()
    .description('便于行动：先给结果和下一步，少铺垫，保留风险与失败条件'),
  style: Schema.union(STYLE_VALUES)
    .volatile()
    .description('回复风格：default / professional / friendly / blunt / follow'),
  /** 0.2.0 及更早版本的字段，仅用于旧配置迁移，界面不再展示。 */
  writingStyle: Schema.boolean().default(false).volatile(),
  baseStyle: Schema.union(['default', 'professional', 'friendly', 'blunt', 'imaginative', 'efficient', 'snarky'])
    .default('default')
    .volatile(),
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

/**
 * 所有路由共用的 POST/JSON 外壳：解析 body，业务交给 run。
 * @param {Request} request
 * @param {(sessionId: unknown, signal: AbortSignal, body: object) => Promise<object>} run
 */
async function handleRequest(request, run) {
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
    const data = await run(body.sessionId, request.signal, body)
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
  const log = (message, error) => {
    const detail = error && error.message ? error.message : error === undefined ? '' : String(error)
    console.warn(`[wdx-relief] ${message}${detail === '' ? '' : `：${detail}`}`)
  }

  const defaultSelection = () => {
    try {
      return ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
    } catch {
      return null
    }
  }

  const prediction = createPredictionService({
    config,
    sessions: ctx.sessions,
    llm: () => ctx.get('llm'),
    defaultSelection,
    log,
  })

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const recapHistory = createRecapHistory({
    file: join(dshHome, 'wdx-relief', 'recaps.json'),
    log,
  })

  const followupStore = createFollowupStore({
    file: join(dshHome, 'wdx-relief', 'followups.json'),
    log,
  })

  const recapService = createRecapService({
    config,
    sessions: ctx.sessions,
    llm: () => ctx.get('llm'),
    defaultSelection,
    history: recapHistory,
    log,
  })

  const todayService = createTodayService({
    config,
    sessions: ctx.sessions,
    sessionQuery: () => ctx.get('sessionQuery'),
    llm: () => ctx.get('llm'),
    defaultSelection,
    dismissals: followupStore,
    log,
  })

  const btwService = createBtwService({
    sessions: ctx.sessions,
    agents: () => ctx.get('agents'),
    llm: () => ctx.get('llm'),
    defaultSelection,
    log,
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
    const disposePredict = ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request, (sessionId, signal) => prediction.predict(sessionId, signal)),
    })
    const disposeRecap = ctx.connection.fetch.register({
      path: RECAP_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request, (sessionId, signal) => recapService.recap(sessionId, signal)),
    })
    const disposeRecaps = ctx.connection.fetch.register({
      path: RECAPS_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request, (sessionId, signal, body) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          const error = new Error('sessionId is required')
          error.code = 'invalid-params'
          throw error
        }
        if (body.clear === true) {
          recapHistory.clear(sessionId)
          return { items: [] }
        }
        return { items: recapHistory.list(sessionId) }
      }),
    })
    const disposeToday = ctx.connection.fetch.register({
      path: TODAY_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request, (sessionId, signal) => todayService.list(sessionId, signal, { force: request.headers.get('x-wdx-force') === '1' })),
    })
    const disposeDismiss = ctx.connection.fetch.register({
      path: DISMISS_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request, (sessionId, signal, body) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          const error = new Error('sessionId is required')
          error.code = 'invalid-params'
          throw error
        }
        return { changed: followupStore.dismiss(sessionId, body.text) }
      }),
    })
    const disposeRestore = ctx.connection.fetch.register({
      path: RESTORE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request, (sessionId, signal, body) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          const error = new Error('sessionId is required')
          error.code = 'invalid-params'
          throw error
        }
        return { changed: followupStore.restore(sessionId, body.text) }
      }),
    })
    const disposeBtw = ctx.connection.fetch.register({
      path: BTW_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request, (sessionId, signal, body) => btwService.ask(sessionId, body.question, signal, { provider: body.provider, model: body.model })),
    })
    return () => {
      void disposePredict()
      void disposeRecap()
      void disposeRecaps()
      void disposeToday()
      void disposeDismiss()
      void disposeRestore()
      void disposeBtw()
    }
  }, 'wdx-relief: prediction, recap, today, followup and btw routes')
  console.log(`[wdx-relief] 路由已注册：${ROUTE_PATH}、${RECAP_PATH}、${RECAPS_PATH}、${TODAY_PATH}、${DISMISS_PATH}、${RESTORE_PATH}、${BTW_PATH}`)
}
