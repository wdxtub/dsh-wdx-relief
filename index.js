/**
 * dsh-wdx-relief — Host 入口。
 *
 * 七件事：
 * 1. 注册认证路由 `POST /api/wdx-relief/predict`，按会话日志生成「下一句输入」；
 * 2. 注册认证路由 `POST /api/wdx-relief/recap`，按最近一轮生成「现在到哪」；
 * 3. 注册认证路由 `POST /api/wdx-relief/recaps` 读取某会话生成过的回顾历史；
 *    `POST /api/wdx-relief/progress` 生成并追加一条按时间窗的进度摘要（和摘要共用一份历史）；
 * 4. 注册认证路由 `POST /api/wdx-relief/btw`，回答右侧面板里的旁问；
 * 5. 把所有设置暴露成 volatile Config，供设置页读写并即时生效；
 * 6. 注册 `wdx-relief:reply-style` system prompt section，把回复风格编译成短指令；
 * 7. 挂载工具调用泄漏守卫：调用被写成正文、turn 静默结束时当场检测并在同一轮内纠正重发。
 *
 * 预测、回顾、进度摘要和旁问都走 ctx.llm，不写 session log、不触发 agent loop；
 * 回顾的模型调用直接从服务流式读取，不 append 消息、不注入上下文，
 * 因此输入框上方那一行永远不会进入模型上下文。
 */
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createBtwService } from './src/btw.js'
import { createPredictionService } from './src/prediction.js'
import { buildRecap, countUserTurns, createRecapService } from './src/recap.js'
import { createRecapHistory } from './src/recapHistory.js'
import { installToolCallRepair } from './src/toolCallRepair.js'
import { STYLE_VALUES, VERBOSITY_VALUES, buildStylePrompt } from './src/style.js'

export const name = 'wdx-relief'

/** connection 提供认证 fetch 路由；sessions 读取会话日志；agents 由旁问惰性读取当前会话模型；tools 提供执行前/后接缝。 */
export const inject = ['connection', 'sessions', 'tools']

export const ROUTE_PATH = '/api/wdx-relief/predict'
export const RECAP_PATH = '/api/wdx-relief/recap'
export const RECAPS_PATH = '/api/wdx-relief/recaps'
export const PROGRESS_PATH = '/api/wdx-relief/progress'
export const BTW_PATH = '/api/wdx-relief/btw'

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description('根据对话在输入框下方显示下一条消息预测，Tab 填入'),
  recap: Schema.boolean()
    .default(true)
    .volatile()
    .description('输入框上方那一行的语义摘要：每轮用一次便宜模型写「现在到哪」，不进入模型上下文'),
  recapActivity: Schema.boolean()
    .default(false)
    .volatile()
    .description('输入框上方那一行的活动流水：正在读文件、跑命令、改代码，本地生成，零模型调用'),
  recapProgress: Schema.boolean()
    .default(true)
    .volatile()
    .description('一轮跑久了还没给用户回复时，按设置的间隔用便宜模型写一条这段时间的思路与进展（默认 10 分钟），失败退回本地摘要；整合进右侧栏的「会话回顾」，不单开 Tab'),
  recapStallSeconds: Schema.number()
    .default(600)
    .volatile()
    .description('一轮运行中多久没给用户回复后开始记录一条进度，之后每隔这么久再记一条；默认 600 秒 = 10 分钟'),
  pendingTurns: Schema.number()
    .default(3)
    .volatile()
    .description('「会话回顾」里把最近几轮标成待跟进（1–20，默认 3）'),
  recapModelChain: Schema.string()
    .default('')
    .volatile()
    .description('摘要模型链，按顺序尝试 provider/model；留空自动挑便宜模型，最后退回默认模型'),
  defaultTab: Schema.union(['untouched', 'recaps', 'btw'])
    .default('recaps')
    .volatile()
    .description('右侧 WDX Relief 面板第一次打开时默认显示哪个 Tab：会话回顾 / 旁问'),
  /** 已移除的跨会话待跟进开关；保留字段只为旧 profile 的配置能继续通过校验。 */
  today: Schema.boolean()
    .default(true)
    .volatile()
    .description('（已移除）旧版「待跟进」总开关，保留仅为兼容旧配置'),
  verbosity: Schema.union(VERBOSITY_VALUES)
    .default('low')
    .volatile()
    .description('回复详细程度：model 表示不干预，low/medium/high 为固定偏好'),
  actionable: Schema.boolean()
    .default(true)
    .volatile()
    .description('便于行动：先给结果和下一步，少铺垫，保留风险与失败条件'),
  eli5: Schema.boolean()
    .default(true)
    .volatile()
    .description('默认用 ELI5 的方式说话：说人话、少术语，用户要求时再深入讲解'),
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
  toolRepair: Schema.boolean()
    .default(true)
    .volatile()
    .description('工具调用被写成正文、turn 静默结束时自动检测并在同一轮内纠正重发'),
  toolRepairLang: Schema.union(['zh', 'en'])
    .default('zh')
    .volatile()
    .description('工具调用修复提示语言'),
  toolRepairMaxCorrections: Schema.number()
    .default(2)
    .volatile()
    .description('每轮最多自动纠正几次（0 表示不自动纠正）'),
  toolRepairDebugLog: Schema.boolean()
    .default(false)
    .volatile()
    .description('输出工具调用修复的诊断日志'),
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
 * 读取 volatile Config 引用；缺失、非对象或 getter 抛错都回退 undefined，
 * 由调用方给默认值。插件配置在旧 profile 里可能没有新字段。
 */
function readVolatile(config, key) {
  const ref = config && config[key]
  try {
    if (ref && typeof ref === 'object' && typeof ref.get === 'function') return ref.get()
  } catch {
    /* 配置读取失败按缺失处理 */
  }
  return undefined
}

/**
 * 工具调用修复的实时配置切片；每次事件重新读取，volatile 改动立即生效。
 */
function readToolRepairConfig(config) {
  const lang = readVolatile(config, 'toolRepairLang')
  const maxCorrections = readVolatile(config, 'toolRepairMaxCorrections')
  return {
    enabled: readVolatile(config, 'toolRepair') !== false,
    lang: lang === 'en' ? 'en' : 'zh',
    maxCorrectionsPerTurn: Number.isInteger(maxCorrections) && maxCorrections >= 0 ? maxCorrections : 2,
    debugLog: readVolatile(config, 'toolRepairDebugLog') === true,
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

  installToolCallRepair(ctx, () => readToolRepairConfig(config), log)

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

  const recapService = createRecapService({
    config,
    sessions: ctx.sessions,
    llm: () => ctx.get('llm'),
    defaultSelection,
    history: recapHistory,
    log,
  })

  // 客户端只在「这个会话在前台、且刚好看到本轮结束」时请求摘要；切走、关掉面板
  // 或整页刷新都会漏掉这一轮。turn/end 时在 Host 侧补一条，快照在回调里同步拍下，
  // 避免下一轮已经开始后把两轮混在一起。若客户端也在同一刻请求，服务层缓存 /
  // inFlight 会合并成一次模型调用。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'turn/end') return
      if (readVolatile(config, 'recap') === false) return
      const sessionId = session && typeof session.id === 'string' ? session.id : ''
      if (sessionId === '') return
      const header = session.header
      // 子会话的每一轮都补摘要只会刷屏，也不在用户看的会话列表里。
      if (header && header.origin === 'subagent') return
      const messages = session.deriveMessages()
      const turn = countUserTurns(messages)
      const recap = buildRecap(messages)
      if (turn < 1 || recap === null) return
      recapService.recapCaptured(sessionId, { turn, recap }).catch((error) => {
        log('host recap fallback failed', error)
      })
    } catch (error) {
      log('host recap fallback failed', error)
    }
  }), 'wdx-relief: host recap fallback')

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
          // 清空历史时也丢掉内存里的当轮摘要；否则当前轮会继续命中缓存，
          // 输入框上仍显示旧摘要，却不会重新写入刚被清空的列表。
          recapService.clear(sessionId)
          recapHistory.clear(sessionId)
          return { items: [] }
        }
        return { items: recapHistory.list(sessionId) }
      }),
    })
    const disposeProgress = ctx.connection.fetch.register({
      path: PROGRESS_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request, async (sessionId, signal, body) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          const error = new Error('sessionId is required')
          error.code = 'invalid-params'
          throw error
        }
        const session = ctx.sessions.get(sessionId)
        if (session === undefined) {
          const error = new Error(`session "${sessionId}" is unavailable`)
          error.code = 'not-found'
          throw error
        }
        const entry = body && typeof body.entry === 'object' && body.entry !== null ? body.entry : body
        const turn = Number(entry.turn)
        const bucket = Number(entry.bucket)
        const summary = typeof entry.summary === 'string' ? entry.summary.slice(0, 500) : ''
        if (!Number.isInteger(turn) || turn < 1 || !Number.isInteger(bucket) || bucket < 1 || summary.trim() === '') {
          const error = new Error('turn, bucket and summary are required')
          error.code = 'invalid-params'
          throw error
        }
        // 页面刷新后客户端可能重发同一档；历史里已有就不再调一次模型。
        const anchor = Number(entry.anchor) || 0
        const duplicate = recapHistory.list(sessionId).some((item) => item.kind === 'progress'
          && item.turn === turn
          && (item.anchor || 0) === anchor
          && item.bucket === bucket)
        if (duplicate) return { appended: false }
        // 记录时间按「收到这一档的时刻」算。模型生成可能慢几十秒，用生成完成时间
        // 会让面板上的两条进度看起来更挤，也会让组头「用时」偏长。
        const capturedAt = Date.now()
        // 新客户端会带一段「这 10 分钟的思考/动作」；有 digest 时让 Host 用便宜模型
        // 写成叙述性进展。模型不可用或摘要功能关闭时保留客户端兜底文案。
        const generated = entry.digest && typeof entry.digest === 'object'
          ? await recapService.summarizeProgress(sessionId, entry, request.signal).catch(() => null)
          : null
        return {
          appended: recapHistory.append({
            sessionId,
            seq: session.seq,
            kind: 'progress',
            turn,
            bucket,
            anchor,
            status: entry.status === 'running' ? 'running' : 'stalled',
            summary: generated !== null ? generated.summary : summary,
            activity: typeof entry.activity === 'string' ? entry.activity.slice(0, 300) : '',
            elapsedMs: Number(entry.elapsedMs) || 0,
            silenceMs: Number(entry.silenceMs) || 0,
            steps: Number(entry.steps) || 0,
            windowMs: Number(entry.windowMs) || 0,
            windowFromMs: Number(entry.windowFromMs) || 0,
            windowToMs: Number(entry.windowToMs) || 0,
            turnStartedAt: Number(entry.turnStartedAt) || 0,
            generated: generated !== null,
            at: capturedAt,
          }),
        }
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
      void disposeProgress()
      void disposeBtw()
    }
  }, 'wdx-relief: prediction, recap, progress and btw routes')
  console.log(`[wdx-relief] 路由已注册：${ROUTE_PATH}、${RECAP_PATH}、${RECAPS_PATH}、${PROGRESS_PATH}、${BTW_PATH}`)
}
