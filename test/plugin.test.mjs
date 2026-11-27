import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { BTW_PATH, Config, PROGRESS_PATH, RECAP_PATH, RECAPS_PATH, ROUTE_PATH, apply, inject, name } from '../index.js'

// apply() 把回顾历史写进 $DSH_HOME；测试用临时目录，避免污染真实 home。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wdx-relief-test-'))

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function createHostContext(output = '修一下失败的测试', options = {}) {
  const session = {
    id: 'session-1',
    seq: 3,
    deriveMessages: () => [userMessage('测试挂了'), assistantMessage('要我修吗？')],
  }
  const routes = new Map()
  let llmCalls = 0
  const listeners = []
  const handlers = new Map()
  const ctx = {
    sessions: { get: (id) => (id === 'session-1' ? session : undefined) },
    effect: (fn) => fn(),
    on(name, listener) {
      listeners.push(name)
      if (typeof listener === 'function') {
        if (!handlers.has(name)) handlers.set(name, [])
        handlers.get(name).push(listener)
      }
      return () => {}
    },
    inject: (services, callback) => callback({
      systemPrompt: { section: (section) => { ctx.sections.push(section); return () => {} } },
    }),
    sections: [],
    get: (name) => {
      if (name === 'llm') {
        return {
          stream() {
            llmCalls += 1
            const delayMs = Number(options.delayMs) || 0
            return (async function* () {
              if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
              yield { type: 'text-delta', text: output }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'provider', model: 'model' }) }
      }
      if (name === 'agents') {
        return {
          get: (id) => (id === 'session-1'
            ? { model: { current: () => ({ provider: 'agent-provider', model: 'agent-model' }) } }
            : undefined),
        }
      }
      return undefined
    },
    connection: {
      fetch: {
        register(options) {
          routes.set(options.path, options)
          return () => {}
        },
      },
    },
  }
  return {
    ctx,
    session,
    route: (path = ROUTE_PATH) => routes.get(path),
    llmCalls: () => llmCalls,
    listeners: () => listeners.slice(),
    call(name, ...args) {
      for (const listener of handlers.get(name) ?? []) listener(...args)
    },
  }
}

function recapConfig(options = {}) {
  const values = {
    recap: options.recap ?? true,
    recapMinTurns: options.minTurns ?? 1,
    recapCooldownTurns: options.cooldownTurns ?? 1,
    recapSimilarityThreshold: 1,
    recapMaxWords: 40,
    recapModelChain: options.chain ?? '',
  }
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { get: () => value }]))
}


/** 模型调用是异步的：轮询到条件成立或超时，避免用固定 sleep 猜时序。 */
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function request(body, path = ROUTE_PATH) {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('host plugin declares its route and config', () => {
  assert.equal(name, 'wdx-relief')
  assert.deepEqual(inject, ['connection', 'sessions', 'tools'])
  const config = Config({})
  assert.equal(config.enabled.get(), true)
  assert.equal(config.recap.get(), true)
  assert.equal(config.recapActivity.get(), false)
  assert.equal(config.recapProgress.get(), true)
  assert.equal(config.recapStallSeconds.get(), 600)
  assert.equal(config.pendingTurns.get(), 3)
  assert.equal(config.recapModelChain.get(), '')
  assert.equal(config.defaultTab.get(), 'recaps')
  assert.equal(config.verbosity.get(), 'low')
  assert.equal(config.writingStyle.get(), false)
  assert.equal(config.baseStyle.get(), 'default')
  assert.equal(config.customInstructions.get(), '')
  assert.equal(config.toolRepair.get(), true)
  assert.equal(config.toolRepairLang.get(), 'zh')
  assert.equal(config.toolRepairMaxCorrections.get(), 2)
  assert.equal(config.toolRepairDebugLog.get(), false)
})

test('apply mounts the tool-call repair listeners', () => {
  const host = createHostContext()
  apply(host.ctx, {})
  for (const name of ['tools/pre-execute', 'tools/post-execute', 'session/event', 'agent/turn-stopping', 'agent/pre-step']) {
    assert.ok(host.listeners().includes(name), name)
  }
})

test('host route returns a prediction and then serves it from cache', async () => {
  const host = createHostContext()
  apply(host.ctx, { enabled: { get: () => true } })
  const route = host.route()
  assert.equal(route.path, ROUTE_PATH)
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(host.ctx.sections.length, 1)
  assert.equal(host.ctx.sections[0].name, 'wdx-relief:reply-style')
  assert.equal(host.ctx.sections[0].interpolate, false)
  assert.ok(host.ctx.sections[0].text().includes('保持回复简短'))

  const first = await route.fetch(request({ sessionId: 'session-1' }))
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { ok: true, data: { suggestion: '修一下失败的测试' } })

  const second = await route.fetch(request({ sessionId: 'session-1' }))
  assert.deepEqual(await second.json(), { ok: true, data: { suggestion: '修一下失败的测试', cached: true } })
  assert.equal(host.llmCalls(), 1)
})

test('btw route answers from the panel without session writes', async () => {
  const host = createHostContext('旁问回答')
  apply(host.ctx, {})
  const route = host.route(BTW_PATH)
  assert.equal(route.path, BTW_PATH)
  assert.deepEqual(route.methods, ['POST'])

  const response = await route.fetch(request({ sessionId: 'session-1', question: '这个报错什么意思？' }, BTW_PATH))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, data: { answer: '旁问回答' } })
  assert.equal(host.llmCalls(), 1)

  const empty = await route.fetch(request({ sessionId: 'session-1', question: '   ' }, BTW_PATH))
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).error.code, 'invalid-params')

  const missing = await route.fetch(request({ sessionId: 'missing', question: '问题' }, BTW_PATH))
  const missingBody = await missing.json()
  assert.equal(missingBody.ok, false)
  assert.equal(missingBody.error.code, 'not-found')
})

test('recap route returns the last turn and caches it', async () => {
  const host = createHostContext()
  apply(host.ctx, recapConfig())
  const route = host.route(RECAP_PATH)
  assert.equal(route.path, RECAP_PATH)
  assert.deepEqual(route.methods, ['POST'])

  const first = await route.fetch(request({ sessionId: 'session-1' }, RECAP_PATH))
  assert.equal(first.status, 200)
  const body = await first.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.recap.kind, 'question')
  assert.equal(body.data.recap.question, '要我修吗？')
  assert.equal(body.data.recap.user, '测试挂了')
  assert.equal(body.data.recap.summary, '修一下失败的测试')

  const second = await route.fetch(request({ sessionId: 'session-1' }, RECAP_PATH))
  assert.equal((await second.json()).data.cached, true)
})

test('recaps route lists generated recap history for one session', async () => {
  const host = createHostContext()
  apply(host.ctx, recapConfig())

  const recap = await host.route(RECAP_PATH).fetch(request({ sessionId: 'session-1' }, RECAP_PATH))
  assert.equal((await recap.json()).ok, true)

  const route = host.route(RECAPS_PATH)
  assert.equal(route.path, RECAPS_PATH)
  const response = await route.fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.items.length, 1)
  assert.equal(body.data.items[0].summary, '修一下失败的测试')
  assert.equal(body.data.items[0].seq, 3)

  const other = await route.fetch(request({ sessionId: 'session-2' }, RECAPS_PATH))
  assert.deepEqual((await other.json()).data.items, [])

  const invalid = await route.fetch(request({ sessionId: '' }, RECAPS_PATH))
  assert.equal(invalid.status, 400)

  const stored = readFileSync(join(process.env.DSH_HOME, 'wdx-relief', 'recaps.json'), 'utf8')
  assert.match(stored, /修一下失败的测试/)

  const cleared = await route.fetch(request({ sessionId: 'session-1', clear: true }, RECAPS_PATH))
  assert.deepEqual((await cleared.json()).data.items, [])
  const afterClear = await route.fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  assert.deepEqual((await afterClear.json()).data.items, [])

  // 清空历史也要丢掉内存缓存；否则当前轮继续命中缓存，列表却永远是空的。
  const beforeRegenerate = host.llmCalls()
  const regenerated = await host.route(RECAP_PATH).fetch(request({ sessionId: 'session-1' }, RECAP_PATH))
  assert.equal((await regenerated.json()).data.cached, undefined)
  assert.equal(host.llmCalls(), beforeRegenerate + 1)
  const refilled = await route.fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  assert.equal((await refilled.json()).data.items.length, 1)
  await route.fetch(request({ sessionId: 'session-1', clear: true }, RECAPS_PATH))
})

test('recap route records a local fallback so the panel matches the composer line', async () => {
  const host = createHostContext('')
  apply(host.ctx, recapConfig())
  await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1', clear: true }, RECAPS_PATH))

  const response = await host.route(RECAP_PATH).fetch(request({ sessionId: 'session-1' }, RECAP_PATH))
  const body = await response.json()
  assert.equal(body.data.degraded, true)
  assert.match(body.data.recap.summary, /测试挂了/)

  const list = await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  const items = (await list.json()).data.items
  assert.equal(items.length, 1)
  assert.equal(items[0].summary, body.data.recap.summary)
  assert.equal(items[0].degraded, true)
  await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1', clear: true }, RECAPS_PATH))
})

test('turn/end fills in a recap when no client is watching', async () => {
  const host = createHostContext()
  apply(host.ctx, recapConfig())
  await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1', clear: true }, RECAPS_PATH))

  // 没有前端请求，只有会话自己发出的 turn/end。
  host.call('session/event', host.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitFor(() => host.llmCalls() === 1)
  assert.equal(host.llmCalls(), 1)

  const list = await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  const items = (await list.json()).data.items
  assert.equal(items.length, 1)
  assert.equal(items[0].summary, '修一下失败的测试')
  assert.equal(items[0].turn, 1)

  // 前端随后为同一轮请求时命中缓存，不会重复调模型。
  const again = await host.route(RECAP_PATH).fetch(request({ sessionId: 'session-1' }, RECAP_PATH))
  const body = await again.json()
  assert.equal(body.data.cached, true)
  assert.equal(host.llmCalls(), 1)
  await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1', clear: true }, RECAPS_PATH))
})

test('turn/end fallback skips subagent sessions and the disabled switch', async () => {
  const host = createHostContext()
  apply(host.ctx, recapConfig())
  await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1', clear: true }, RECAPS_PATH))

  host.session.header = { origin: 'subagent' }
  host.call('session/event', host.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(host.llmCalls(), 0)

  host.session.header = {}
  const off = createHostContext()
  apply(off.ctx, recapConfig({ recap: false }))
  off.call('session/event', off.session, { type: 'turn/end', data: { turn: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(off.llmCalls(), 0)
  await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1', clear: true }, RECAPS_PATH))
})

test('progress route appends one snapshot per turn and bucket', async () => {
  const host = createHostContext()
  apply(host.ctx, recapConfig())
  const route = host.route(PROGRESS_PATH)
  assert.equal(route.path, PROGRESS_PATH)
  assert.deepEqual(route.methods, ['POST'])

  const entry = {
    turn: 2,
    bucket: 1,
    status: 'stalled',
    summary: '第 2 轮 · 运行 job_output · 等待 10 分',
    activity: '运行 job_output…',
    elapsedMs: 700000,
    silenceMs: 600000,
    steps: 2,
  }
  const first = await route.fetch(request({ sessionId: 'session-1', entry }, PROGRESS_PATH))
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { ok: true, data: { appended: true } })

  const again = await route.fetch(request({ sessionId: 'session-1', entry }, PROGRESS_PATH))
  assert.deepEqual(await again.json(), { ok: true, data: { appended: false } })

  const next = await route.fetch(request({
    sessionId: 'session-1',
    entry: { ...entry, bucket: 2, severity: 1, summary: '第 2 轮 · 运行 job_output · 等待 20 分' },
  }, PROGRESS_PATH))
  assert.deepEqual(await next.json(), { ok: true, data: { appended: true } })

  const list = await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  const items = (await list.json()).data.items
  assert.equal(items.length, 2)
  assert.equal(items[0].kind, 'progress')
  assert.equal(items[0].bucket, 2)
  assert.equal(items[0].turn, 2)
  assert.equal(items[0].status, 'stalled')

  const invalid = await route.fetch(request({
    sessionId: 'session-1',
    entry: { turn: 0, bucket: 1, summary: 'x' },
  }, PROGRESS_PATH))
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'invalid-params')

  const missing = await route.fetch(request({
    sessionId: 'missing',
    entry: entry,
  }, PROGRESS_PATH))
  assert.equal((await missing.json()).error.code, 'not-found')
})


test('job progress stays under the turn that started the job', async () => {
  const host = createHostContext()
  apply(host.ctx, recapConfig({ recap: false }))
  const route = host.route(PROGRESS_PATH)
  const anchor = 1795479188145
  const base = {
    anchor: anchor,
    jobId: 'bash-1',
    jobName: 'bash 任务',
    status: 'running',
    activity: '后台任务 1 个运行中',
    summary: '关于「把两个人群补齐」：后台任务运行中',
    digest: {
      reasoning: '',
      actions: [],
      goal: '把两个人群补齐',
      jobs: [{ name: 'bash 任务', status: 'running', elapsedMinutes: 5 }],
    },
  }
  const first = await route.fetch(request({ sessionId: 'session-1', entry: { ...base, turn: 46, bucket: 1 } }, PROGRESS_PATH))
  assert.deepEqual(await first.json(), { ok: true, data: { appended: true } })
  // 任务跑了很久，客户端现在已经在第 50 轮；进度仍然回到第 46 轮。
  const later = await route.fetch(request({
    sessionId: 'session-1',
    entry: { ...base, turn: 50, bucket: 2, digest: { ...base.digest, goal: '最新一轮的要求' } },
  }, PROGRESS_PATH))
  assert.deepEqual(await later.json(), { ok: true, data: { appended: true } })

  const list = await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  const items = (await list.json()).data.items.filter((item) => item.jobId === 'bash-1')
  assert.deepEqual([...items.map((item) => item.turn)], [46, 46])
  assert.equal(items.every((item) => item.jobName === 'bash 任务'), true)
  // 后续条目沿用任务最初的目标，不会被新回合的要求覆盖。
  assert.deepEqual([...new Set(items.map((item) => item.jobGoal))], ['把两个人群补齐'])
})

test('recap labels use the client turn after history compression', async () => {
  const host = createHostContext('补一句摘要')
  apply(host.ctx, recapConfig())
  const route = host.route(RECAP_PATH)
  const response = await route.fetch(request({ sessionId: 'session-1', turn: 46 }, RECAP_PATH))
  const data = (await response.json()).data
  assert.equal(data.recap.turn, 46)
  const list = await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  const items = (await list.json()).data.items
  assert.equal(items[0].turn, 46)
})

test('progress route replaces the local preview with a model-written interval summary', async () => {
  const host = createHostContext('先确认刷新会覆盖哪些手工改动，再按时间窗整批迁移。')
  apply(host.ctx, recapConfig())
  const entry = {
    turn: 3,
    bucket: 2,
    anchor: 0,
    status: 'stalled',
    summary: '在修改 migrate.js、运行命令',
    activity: '修改 migrate.js；运行命令 ×2',
    windowMs: 600000,
    elapsedMs: 1320000,
    silenceMs: 1200000,
    steps: 4,
    digest: { reasoning: '先确认 JOB 刷新会不会覆盖手工改动，再决定迁移粒度', actions: ['修改 migrate.js', '运行命令 ×2'], replies: '' },
  }
  const response = await host.route(PROGRESS_PATH).fetch(request({ sessionId: 'session-1', entry }, PROGRESS_PATH))
  assert.deepEqual(await response.json(), { ok: true, data: { appended: true } })
  assert.equal(host.llmCalls(), 1)

  // 页面刷新重发同一档：不重复写历史，也不重复调模型。
  const again = await host.route(PROGRESS_PATH).fetch(request({ sessionId: 'session-1', entry }, PROGRESS_PATH))
  assert.deepEqual(await again.json(), { ok: true, data: { appended: false } })
  assert.equal(host.llmCalls(), 1)

  const list = await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  const item = (await list.json()).data.items[0]
  assert.equal(item.summary, '先确认刷新会覆盖哪些手工改动，再按时间窗整批迁移。')
  assert.equal(item.windowMs, 600000)
  assert.equal(item.generated, true)
  assert.equal(item.activity, '修改 migrate.js；运行命令 ×2')
})

test('progress route keeps the local summary when the recap model is off', async () => {
  const host = createHostContext()
  apply(host.ctx, recapConfig({ recap: false }))
  const entry = {
    turn: 1,
    bucket: 1,
    anchor: 0,
    status: 'stalled',
    summary: '先读配置，确认旧标签写在哪。',
    activity: '读取 recap.js',
    windowMs: 600000,
    elapsedMs: 620000,
    silenceMs: 600000,
    steps: 2,
    digest: { reasoning: '先读配置，确认旧标签写在哪。', actions: ['读取 recap.js'], replies: '' },
  }
  const response = await host.route(PROGRESS_PATH).fetch(request({ sessionId: 'session-1', entry }, PROGRESS_PATH))
  assert.deepEqual(await response.json(), { ok: true, data: { appended: true } })
  assert.equal(host.llmCalls(), 0)

  const list = await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  const item = (await list.json()).data.items[0]
  assert.equal(item.summary, '先读配置，确认旧标签写在哪。')
  assert.equal(item.generated, false)
})

test('progress entries are stamped when the request arrives, not when the model finishes', async () => {
  // 模型慢 300ms：旧实现用生成完成时间，面板上的记录时间会晚一截，
  // 慢的那条还可能排到下一条后面；记录时间应该贴近请求到达的那一刻。
  const host = createHostContext('迁移完成，等回归测试。', { delayMs: 300 })
  apply(host.ctx, recapConfig())
  const entry = {
    turn: 3,
    bucket: 5,
    anchor: 1000,
    status: 'stalled',
    summary: '在改迁移脚本',
    activity: '修改 migrate.js',
    windowMs: 600000,
    windowFromMs: 2400000,
    windowToMs: 3000000,
    turnStartedAt: 1000,
    elapsedMs: 3000000,
    silenceMs: 3000000,
    steps: 3,
    digest: { reasoning: '先改脚本再跑回归', actions: ['修改 migrate.js'], replies: '' },
  }
  const before = Date.now()
  const response = await host.route(PROGRESS_PATH).fetch(request({ sessionId: 'session-1', entry }, PROGRESS_PATH))
  assert.deepEqual(await response.json(), { ok: true, data: { appended: true } })
  assert.equal(host.llmCalls(), 1)

  const list = await host.route(RECAPS_PATH).fetch(request({ sessionId: 'session-1' }, RECAPS_PATH))
  const item = (await list.json()).data.items[0]
  assert.equal(item.generated, true)
  assert.equal(item.summary, '迁移完成，等回归测试。')
  const lag = item.at - before
  assert.ok(lag >= 0 && lag < 250, `recorded ${lag}ms after the request`)
})

test('recap route respects the toggle and unknown sessions', async () => {
  const host = createHostContext()
  apply(host.ctx, recapConfig({ recap: false }))
  const route = host.route(RECAP_PATH)
  const disabled = await route.fetch(request({ sessionId: 'session-1' }, RECAP_PATH))
  assert.deepEqual(await disabled.json(), { ok: true, data: { recap: null, disabled: true } })

  const enabledHost = createHostContext()
  apply(enabledHost.ctx, recapConfig())
  const missing = await enabledHost.route(RECAP_PATH).fetch(request({ sessionId: 'missing' }, RECAP_PATH))
  const missingBody = await missing.json()
  assert.equal(missingBody.ok, false)
  assert.equal(missingBody.error.code, 'not-found')
})

test('host route rejects unknown sessions without failing the caller', async () => {
  const host = createHostContext()
  apply(host.ctx, { enabled: { get: () => true } })
  const response = await host.route().fetch(request({ sessionId: 'missing' }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'not-found')
})

test('host route refuses malformed requests', async () => {
  const host = createHostContext()
  apply(host.ctx, { enabled: { get: () => true } })
  const route = host.route()

  const badJson = await route.fetch(request('{'))
  assert.equal(badJson.status, 400)

  const badShape = new Request(`http://127.0.0.1${ROUTE_PATH}`, { method: 'POST', body: 'null' })
  assert.equal((await route.fetch(badShape)).status, 400)

  const wrongMethod = new Request(`http://127.0.0.1${ROUTE_PATH}`, { method: 'GET' })
  assert.equal((await route.fetch(wrongMethod)).status, 405)
})

// ---------------------------------------------------------------- client

test('client bundle registers the composer ghost prediction and settings page', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) { loaded = spec },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
  }
  runInNewContext(code, sandbox)
  assert.ok(loaded)
  assert.equal(loaded.id, 'dsh-wdx-relief')

  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState() {},
    useEffect() {},
    useRef() {},
    useLayoutEffect() {},
  }
  const modelFields = []
  class SettingsFormModel {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = specs
      modelFields.push(specs.map((spec) => spec.field))
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field(name) {
      const spec = this.specs.find((entry) => entry.field === name)
      return { text: spec ? spec.format(undefined) : '', overridden: false, invalid: false }
    }
    bind(select) {
      const value = select()
      return { getSnapshot: () => value, subscribe: () => () => {} }
    }
    actions() {
      return { edit() {}, resetField() {}, save() {}, discard() {} }
    }
    dispose() {}
  }
  const primitives = {
    Switch: function Switch() {},
    SettingsForm: function SettingsForm() {},
    SettingsFormModel,
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${id}`)
  })

  assert.equal(client.name, 'wdx-relief')
  assert.deepEqual([...client.inject], ['slots', 'configForms', 'locale', 'sidebarRight', 'sidebarRightTabs', 'modelDirectories', 'sessions'])

  const registrations = []
  const locales = []
  const tabTypes = []
  const openedTabs = []
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { enabled: true, recap: true, defaultTab: 'recaps' }, writable: true }),
    subscribe: () => () => {},
    mutate: () => Promise.resolve(true),
  }
  const ctx = {
    configForms: { get: (ns) => { assert.equal(ns, 'wdx-relief'); return form } },
    locale: {
      register: (ns, dictionaries) => {
        locales.push([ns, dictionaries])
        return () => {}
      },
      bind: (ns) => (key) => {
        const entry = locales.find(([name]) => name === ns)
        return entry && entry[1].zh[key] !== undefined ? entry[1].zh[key] : key
      },
    },
    effect: (fn) => fn(),
    sidebarRight: {
      openTab: (kind, options) => { openedTabs.push({ kind, options }) },
    },
    sidebarRightTabs: {
      register: (options) => { tabTypes.push(options); return () => {} },
    },
    slots: {
      inject: (slot, register) => register(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)

  assert.deepEqual([...locales.map(([ns]) => ns)], ['wdx-relief'])
  assert.deepEqual(Object.keys(locales[0][1]).sort(), ['en', 'zh'])
  assert.deepEqual(registrations.map((entry) => entry.options.name), [
    'conversation.session.header.utilities',
    'sidebar.right.pane.tab',
    'conversation.input.overlay',
    'conversation.input.dock',
    'plugins.bundle.config',
  ])
  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].id, 'wdx-relief')
  assert.equal(tabTypes[0].kind, 'wdx-relief')
  assert.equal(tabTypes[0].priority, 'extension')
  assert.equal(typeof tabTypes[0].title, 'function')
  assert.equal(tabTypes[0].guide[0].order, 35)
  const header = registrations[0].options
  assert.equal(header.id, 'wdx-relief')
  assert.equal(header.order, 12)
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(header.label(), '打开 WDX Relief：会话回顾 / 旁问')
  const headerButton = registrations[0].component().children.find((child) => child && child.props && child.props.type === 'button')
  assert.equal(headerButton.props.className.includes('headerBtn'), true)
  assert.equal(headerButton.props.title, '打开 WDX Relief：会话回顾 / 旁问')
  assert.equal(headerButton.props['aria-label'], '打开 WDX Relief：会话回顾 / 旁问')
  headerButton.props.onClick()
  assert.equal(openedTabs[0].kind, 'wdx-relief')
  assert.equal(openedTabs[0].options, undefined)
  const sidebar = registrations[1].options
  assert.equal(sidebar.key, 'wdx-relief')
  assert.equal(typeof registrations[1].component, 'function')
  assert.equal(sidebar.inject('session-1').defaultTab, 'recaps')

  const overlay = registrations[2].options
  assert.equal(overlay.id, 'wdx-prediction')
  assert.equal(overlay.locale, 'wdx-relief')
  assert.equal(overlay.inject('session-1').hooks.settings.getSnapshot().value.enabled, true)

  const recap = registrations[3].options
  assert.equal(recap.id, 'wdx-turn-line-above')
  assert.equal(recap.order, 30)
  const recapInjected = recap.inject('session-1')
  assert.equal(recapInjected.hooks.settings.getSnapshot().value.recap, true)
  assert.equal(typeof recapInjected.openProgress, 'function')
  recapInjected.openProgress()
  const progressTab = openedTabs.at(-1)
  assert.equal(progressTab.kind, 'wdx-relief')
  assert.equal(progressTab.options.params.wdxReliefTab, 'recaps')
  assert.equal(progressTab.options.params.wdxRecapFilter, 'progress')
  // 带轮次跳转：不再只筛进度（那会把行上的摘要藏起来），改由面板展开这一轮。
  recapInjected.openProgress(3)
  const turnTab = openedTabs.at(-1)
  assert.equal(turnTab.kind, 'wdx-relief')
  assert.equal(turnTab.options.params.wdxReliefTab, 'recaps')
  assert.equal(turnTab.options.params.wdxRecapTurn, 3)
  assert.equal(turnTab.options.params.wdxRecapFilter, undefined)

  assert.equal(typeof client.BtwSection, 'function')

  const config = registrations[4].options
  assert.equal(config.key, 'dsh-wdx-relief')
  assert.equal(config.locale, 'wdx-relief')
  assert.equal(typeof registrations[4].component, 'function')
  const injected = config.inject()
  const settings = injected.hooks.settings.getSnapshot()
  assert.equal(settings.enabled.text, 'true')
  assert.equal(settings.recap.text, 'true')
  assert.equal(settings.recapProgress.text, 'true')
  assert.equal(settings.recapStallSeconds.text, '600')
  assert.equal(settings.pendingTurns.text, '3')
  assert.equal(typeof settings.recapActivity.text, 'string')
  assert.equal(settings.recapModelChain.text, '')
  assert.equal(settings.defaultTab.text, 'recaps')
  assert.equal(settings.verbosity.text, 'low')
  assert.equal(settings.actionable.text, 'true')
  assert.equal(settings.eli5.text, 'true')
  assert.equal(settings.style.text, 'default')
  assert.equal(settings.customInstructions.text, '')
  assert.equal(settings.toolRepair.text, 'true')
  assert.equal(settings.toolRepairLang.text, 'zh')
  assert.equal(settings.toolRepairMaxCorrections.text, '2')
  assert.equal(typeof settings.toolRepairDebugLog.text, 'string')
  assert.equal(typeof injected.edit, 'function')
  assert.equal(typeof injected.save, 'function')
  assert.equal(typeof injected.discard, 'function')

  assert.deepEqual({ ...client.describeToolCall('read', '{"path":"src/recap.js"}') }, { verb: 'read', target: 'recap.js' })
  assert.equal(client.formatRecap({ kind: 'question', question: '要继续吗？' }), '要继续吗？')
  assert.equal(
    client.formatRecap({ kind: 'question', user: '测试挂了', question: '要直接改吗？' }),
    '测试挂了 · 要直接改吗？',
  )
  assert.equal(
    client.formatRecap({ kind: 'answered', user: '修测试', assistant: '已修好' }),
    '修测试 · 已修好',
  )
  assert.equal(client.formatRecap({ kind: 'waiting', user: '再跑一次' }), '再跑一次 · 还没回复')
  assert.equal(client.trf(undefined, 'panel.ageShort', { hours: 3 }, '{hours} 小时'), '3 小时')
})

test('bundle settings page exposes the tool-call guard controls', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    // 展开「高级」折叠区，让断言能覆盖折叠后的字段。
    useState(initial) { return [typeof initial === 'boolean' ? true : initial, () => {}] },
    useEffect() {},
    useRef() { return { current: null } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const field = (text) => ({ text, overridden: false, invalid: false })
  const snapshot = {
    writable: true,
    saving: false,
    enabled: field('true'),
    recap: field('true'),
    recapProgress: field('true'),
    recapStallSeconds: field('600'),
    pendingTurns: field('3'),
    recapActivity: field('false'),
    recapModelChain: field(''),
    defaultTab: field('recaps'),
    verbosity: field('low'),
    actionable: field('true'),
    eli5: field('true'),
    style: field('default'),
    customInstructions: field(''),
    toolRepair: field('true'),
    toolRepairLang: field('zh'),
    toolRepairMaxCorrections: field('2'),
    toolRepairDebugLog: field('false'),
  }

  const tree = client.BundleSettingsPage({
    view: 'fields',
    t: (key) => key,
    useSettings: (select) => select(snapshot),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
  })

  const keys = []
  ;(function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.props && node.props.key) keys.push(node.props.key)
    for (const child of node.children || []) walk(child)
  })(tree)

  for (const key of ['features', 'turnLine', 'reply', 'toolRepair', 'recap', 'recapProgress', 'stallSeconds', 'recapActivity', 'modelChain', 'eli5', 'toolRepairLang', 'toolRepairMaxCorrections', 'toolRepairDebugLog', 'defaultTab']) {
    assert.ok(keys.includes(key), key)
  }
  for (const key of ['recapTiming', 'recapReasoning', 'recapPlacement', 'minTurns', 'cooldownTurns', 'similarity', 'maxWords', 'length', 'writing']) {
    assert.ok(!keys.includes(key), key)
  }
})

test('turn line derives activity and summary from the event window', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 2 } } },
    { type: 'event', event: { type: 'tool/call', seq: 2, time: 2000, data: { callId: 'c1', name: 'read', arguments: '{"path":"README.md"}', turn: 2, step: 1 } } },
    { type: 'event', event: { type: 'tool/result', seq: 3, time: 3000, data: { turn: 2, step: 1, message: { source: { callId: 'c1' } } } } },
    { type: 'transient', event: { type: 'assistant/live-chunk', seq: 4, time: 4000, data: { turn: 2, step: 1, chunk: { type: 'reasoning-delta', text: '先检查依赖。\n再跑测试' } } } },
    { type: 'event', event: { type: 'turn/end', seq: 5, time: 9000, data: { turn: 2, reason: { kind: 'stop' } } } },
  ]
  const view = client.deriveTurnView(entries, 10000)
  assert.equal(view.turn, 2)
  assert.equal(view.running, false)
  assert.equal(view.elapsedMs, 8000)
  assert.equal(view.tool.done, true)
  assert.equal(view.actions.length, 1)
  assert.match(view.reasoning, /先检查依赖/)

  const segments = client.buildTurnSegments(view, { activity: true, summary: true }, (key) => (key === 'turn.verb.read' ? '读取' : key), { text: '修测试，已修好' })
  assert.deepEqual([...segments.map((segment) => segment.key)], ['activity', 'summary'])
  assert.match(segments[0].text, /读取 README\.md/)
  assert.equal(segments[1].text, '※ 修测试，已修好')

  const localOnly = client.buildTurnSegments(view, { activity: true, summary: false }, (key) => key, null)
  assert.deepEqual([...localOnly.map((segment) => segment.key)], ['activity'])
})

test('progress snapshots use the 10 minute bucket and stay compact', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 3 } } },
    { type: 'event', event: { type: 'step/start', seq: 2, time: 1000, data: { turn: 3, step: 1 } } },
    { type: 'event', event: { type: 'tool/call', seq: 3, time: 2000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"job_output"}', turn: 3, step: 1 } } },
  ]
  const settings = { stallMs: 600000 }
  const t = (key) => key
  const first = client.progressEntryOf(client.deriveTurnView(entries, 603000), settings, t, entries)
  assert.equal(first.turn, 3)
  assert.equal(first.bucket, 1)
  assert.equal(first.status, 'stalled')
  assert.equal(first.silenceMs, 600000)
  assert.equal(first.elapsedMs, 602000)
  assert.equal(first.steps, 1)
  assert.equal(first.anchor, 1000)
  assert.equal(client.deriveTurnView(entries, 603000).quietMs, 602000)
  assert.equal(first.windowMs, 600000)
  assert.equal(first.digest.actions.length, 1)
  // 命令参数不进入进度摘要，只保留动作本身。
  assert.doesNotMatch(first.digest.actions[0], /job_output/)
  assert.equal(first.activity, first.digest.actions[0])

  const second = client.progressEntryOf(client.deriveTurnView(entries, 1210000), settings, t, entries)
  assert.equal(second.bucket, 2)
  assert.equal(second.silenceMs, 1200000)
  assert.equal(second.windowMs, 600000)
})

test('progress records only right after a bucket boundary, never twice in a row', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const stallMs = 600000
  const cfg = { progress: true, stallMs }

  // 切回会话 / 刷新 / 休眠唤醒时，当前这一档往往已经过了一大半：不记，等下一档。
  const joinedLate = client.progressWindowOf(159 * 60000 + 30000, stallMs)
  assert.equal(joinedLate.bucket, 15)
  assert.equal(joinedLate.fresh, false)
  // 档位刚跨过去的 1 分钟内记（后台节流到 1 分钟一次也赶得上）；再晚就跳过。
  assert.equal(client.progressWindowOf(160 * 60000, stallMs).fresh, true)
  assert.equal(client.progressWindowOf(160 * 60000 + 59000, stallMs).fresh, true)
  assert.equal(client.progressWindowOf(160 * 60000 + 61000, stallMs).fresh, false)
  assert.equal(client.progressWindowOf(0, stallMs).fresh, false)
  // 同一次等待、同一个档位只记一条。
  const reported = {}
  const view = { running: true, turn: 3, lastReplyAt: 1000, quietMs: 160 * 60000 }
  const plan = client.progressDueOf(view, cfg, reported)
  assert.equal(plan.bucket, 16)
  reported[plan.key] = true
  assert.equal(client.progressDueOf(view, cfg, reported), null)
  assert.equal(client.progressDueOf({ ...view, turn: 0 }, cfg, {}), null)
  assert.equal(client.progressDueOf(view, { progress: false, stallMs }, {}), null)

  // 按每秒一次 tick 走一遍：旧规则在 159.5 分补一条、30 秒后又跟一条；
  // 新规则只在 160 分这一条边界上开始记，之后每 10 分钟一条。
  function replay(rule, startQuietMs, seconds) {
    const seen = {}
    const recorded = []
    for (let offset = 0; offset <= seconds; offset += 1) {
      const quietMs = startQuietMs + offset * 1000
      const item = rule(quietMs, seen)
      if (item === null) continue
      seen[item.key] = true
      recorded.push(quietMs)
    }
    return recorded
  }
  const oldRule = (quietMs, seen) => {
    const bucket = Math.floor(quietMs / stallMs)
    if (bucket < 1) return null
    const key = '3:' + (1000) + ':' + bucket
    if (seen[key] === true) return null
    return { bucket, key }
  }
  const newRule = (quietMs, seen) => client.progressDueOf({ running: true, turn: 3, lastReplyAt: 1000, quietMs }, cfg, seen)

  const late = 159 * 60000 + 30000
  const oldRun = replay(oldRule, late, 5 * 60)
  assert.deepEqual(oldRun, [late, 160 * 60000])
  const newRun = replay(newRule, late, 11 * 60)
  assert.deepEqual(newRun, [160 * 60000, 170 * 60000])
  for (let index = 1; index < newRun.length; index += 1) {
    assert.equal(newRun[index] - newRun[index - 1], stallMs)
  }
})

test('progress cadence stays at least one interval apart with throttled ticks', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const stallMs = 600000
  const cfg = { progress: true, stallMs }
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  // tick 节奏：前台 1 秒、后台节流 1 分钟、休眠唤醒后的 3 分钟大跳；
  // 挂载点分别落在档位开头、中间和末尾。
  for (const tickMs of [1000, 60000, 180000]) {
    for (const mountOffset of [0, 30000, 300000, 540000 + 30000]) {
      const seen = {}
      const recorded = []
      for (let quietMs = mountOffset; quietMs <= 40 * 60000; quietMs += tickMs + Math.floor(random() * tickMs)) {
        const plan = client.progressDueOf({ running: true, turn: 2, lastReplyAt: 0, quietMs }, cfg, seen)
        if (plan === null) continue
        seen[plan.key] = true
        recorded.push(quietMs)
      }
      for (let index = 1; index < recorded.length; index += 1) {
        // 记录只在档位边界后 1 分钟内发生，所以相邻两条最近是「间隔 - 1 分钟」。
        assert.ok(recorded[index] - recorded[index - 1] >= stallMs - 60000, `${tickMs}/${mountOffset}: ${recorded.join(',')}`)
      }
      for (const quietMs of recorded) {
        assert.ok(quietMs % stallMs <= 60000, `${tickMs}/${mountOffset}: recorded mid-window at ${quietMs}`)
      }
      // 粗节流本来就可能整天错过边界，只有前台每秒 tick 必须稳定出记录，
      // 否则「一条都不记」的实现也会让上面两个循环空转通过。
      if (tickMs <= 1000) {
        assert.ok(recorded.length >= 3, `${tickMs}/${mountOffset}: 只记录了 ${recorded.length} 条`)
      }
    }
  }
})


test('progress fires while tools keep running without a reply', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const t = (key) => key
  const settings = { stallMs: 600000 }
  // 19 分钟一直在跑工具和思考，中间没有任何给用户的正文回复。
  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } },
    { type: 'event', event: { type: 'step/start', seq: 2, time: 0, data: { turn: 1, step: 1 } } },
    { type: 'event', event: { type: 'tool/call', seq: 3, time: 60000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"job_output"}', turn: 1, step: 1 } } },
    { type: 'event', event: { type: 'tool/result', seq: 4, time: 120000, data: { turn: 1, step: 1, message: { source: { callId: 'c1' } } } } },
    { type: 'transient', event: { type: 'assistant/live-chunk', seq: 5, time: 300000, data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', text: '继续排查' } } } },
    { type: 'event', event: { type: 'tool/call', seq: 6, time: 900000, data: { callId: 'c2', name: 'grep', arguments: '{"pattern":"foo"}', turn: 1, step: 2 } } },
  ]
  const view = client.deriveTurnView(entries, 1140000)
  assert.equal(view.running, true)
  assert.equal(view.silenceMs, 240000)
  assert.equal(view.lastReplyAt, 0)
  assert.equal(view.quietMs, 1140000)

  const entry = client.progressEntryOf(view, settings, t, entries)
  assert.equal(entry.bucket, 1)
  assert.equal(entry.anchor, 0)
  assert.match(entry.summary, /继续排查/)
  assert.equal(entry.digest.reasoning, '继续排查')
  assert.equal(entry.windowMs, 600000)

  // 这一行不再本地拼时间窗摘要（思考碎片里的代码会直接上屏），改由「会话回顾」
  // 里 Host 写好的那一条负责；没有存下来的摘要时不硬凑一段。
  const segments = client.buildTurnSegments(view, { progress: true, stallMs: 600000, activity: false, summary: true }, t, null)
  assert.deepEqual([...segments.map((segment) => segment.key)], [])
  assert.equal(client.turnStatusInfo(view, t, false).label, '')

  // 一旦有正文回复，等待重新计时；工具事件不会把它重置。
  const replied = [...entries, { type: 'event', event: { type: 'assistant/message', seq: 7, time: 1000000, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '先说下结论' }] } } } }]
  const repliedView = client.deriveTurnView(replied, 1150000)
  assert.equal(repliedView.lastReplyAt, 1000000)
  assert.equal(repliedView.quietMs, 150000)
  assert.equal(repliedView.silenceMs, 150000)
})

test('running line shows the latest stored progress summary from Session review', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })
  const t = (key) => key

  // 面板里的回顾历史：本轮两条进度、一条上一轮摘要、一条后台任务进度。
  const at = 1700000000000
  const items = [
    { kind: 'summary', turn: 4, at: at - 4 * 3600000, summary: '旧的摘要' },
    { kind: 'progress', turn: 4, at: at - 600000, bucket: 1, summary: '批量数量输入正抽成共用组件，专业评分卡接入全量模式。' },
    { kind: 'progress', turn: 4, at: at, bucket: 2, summary: '前端检查待跟进；图床和分析卡在同步替换。' },
    { kind: 'progress', turn: 3, at: at + 60000, bucket: 1, summary: '上一轮的进度，不该串到这一轮。' },
    { kind: 'progress', turn: 4, at: at + 600000, bucket: 1, jobId: 'bash-1', summary: '后台任务还在跑，不属于这一轮的进展。' },
  ]
  const note = client.latestProgressNote(items, 4)
  assert.equal(note.turn, 4)
  assert.equal(note.text, '前端检查待跟进；图床和分析卡在同步替换。')
  // 本轮没写过进度、或只有后台任务进度时不拿别的轮凑数。
  assert.equal(client.latestProgressNote(items, 5), null)
  assert.equal(client.latestProgressNote([{ kind: 'summary', turn: 4, at: at, summary: '只有摘要' }], 4), null)
  assert.equal(client.latestProgressNote([], 4), null)

  // 一段话原样放进这一行：不截、不拼「第几轮」、不拼时间窗，清掉重复的时长。
  const view = { turn: 4, running: true, quietMs: 25 * 60000, elapsedMs: 25 * 60000, status: 'running', startedAt: at - 25 * 60000, lastReplyAt: at - 25 * 60000, silenceMs: 60000, actions: [], steps: 1 }
  const cfg = { progress: true, stallMs: 600000, activity: false, summary: false, jobs: false }
  const segments = client.buildTurnSegments(view, cfg, t, null, [], note.text)
  assert.deepEqual([...segments.map((segment) => segment.key)], ['note'])
  assert.equal(segments[0].className, 'wdxt-note')
  assert.equal(segments[0].text, note.text)
  assert.doesNotMatch(segments[0].text, /未回复|第 4 轮|1–20 分/)
  // 没有摘要时这一行不留空壳。
  const empty = client.buildTurnSegments(view, cfg, t, null, [], '')
  assert.deepEqual([...empty.map((segment) => segment.key)], [])
})

test('progress stays quiet while the turn waits for the user', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })
  const t = (key) => key
  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 4 } } },
    { type: 'event', event: { type: 'step/start', seq: 2, time: 1000, data: { turn: 4, step: 1 } } },
    { type: 'event', event: { type: 'tool/call', seq: 3, time: 2000, data: { callId: 'c9', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1', question: '要现在跑吗？' }] }), turn: 4, step: 1 } } },
  ]
  const waiting = client.deriveTurnView(entries, 1300000)
  assert.equal(waiting.awaiting, 'question')
  assert.equal(waiting.askQuestion, '要现在跑吗？')
  assert.equal(client.progressDueOf(waiting, { progress: true, stallMs: 600000 }, {}), null)
  assert.equal(client.turnStatusInfo(waiting, t, true).label, '等你回答')
  // 这一档里只有「提问」发生在上一个窗口，本窗口没有任何模型活动。
  const quietEntry = client.progressEntryOf(waiting, { stallMs: 600000 }, t, entries)
  assert.equal(quietEntry.events, 0)

  // 用户答了（回执先到），等待结束；工具结果再回来也不影响。
  const replied = [...entries, {
    type: 'event',
    event: { type: 'user/message', seq: 4, time: 1300000, data: { message: { role: 'user', source: { kind: 'user-question-reply', callId: 'c9' }, content: [{ type: 'text', text: '跑吧' }] } } },
  }]
  const answered = client.deriveTurnView(replied, 1301000)
  assert.equal(answered.awaiting, '')
  assert.equal(answered.askQuestion, '')
  const resumed = [...replied, { type: 'event', event: { type: 'tool/result', seq: 5, time: 1302000, data: { turn: 4, step: 1, message: { source: { callId: 'c9' } } } } }]
  assert.equal(client.deriveTurnView(resumed, 1310000).awaiting, '')

  // 审批事件：决定前算等待，决定后恢复正常。
  const approvals = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 5 } } },
    { type: 'event', event: { type: 'approval/asked', seq: 2, time: 1500, data: { id: 'a1', tool: 'bash' } } },
  ]
  const asked = client.deriveTurnView(approvals, 800000)
  assert.equal(asked.awaiting, 'approval')
  assert.equal(client.progressDueOf(asked, { progress: true, stallMs: 600000 }, {}), null)
  const decided = [...approvals, { type: 'event', event: { type: 'approval/decided', seq: 3, time: 800000, data: { id: 'a1', outcome: 'allowed-once' } } }]
  assert.equal(client.deriveTurnView(decided, 800100).awaiting, '')
})

test('background jobs surface their latest output and record progress', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })
  const t = (key) => key
  const jobStart = 1000000
  const now = jobStart + 7 * 3600 * 1000 + 46 * 60 * 1000
  const rows = [
    { id: 'bash-1', kind: 'bash', label: 'while pgrep -f monitor; do', status: 'running', startedAt: jobStart, progress: '3/10', output: { total: 2048, earliest: 0 } },
    { id: 'bash-2', kind: 'bash', label: 'done job', status: 'completed', startedAt: 900000, output: { total: 0, earliest: 0 } },
    { id: 'bash-3', kind: 'bash', label: 'stopping job', status: 'stopping', startedAt: jobStart + 60000, output: { total: 10, earliest: 0 } },
  ]
  const jobs = client.liveJobsOf(rows, now)
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].id, 'bash-1')
  assert.equal(jobs[1].id, 'bash-3')
  assert.equal(client.liveJobsOf(null, now).length, 0)

  assert.equal(client.jobOutputLine('\u001b[32mstarting\u001b[0m\r\n[12:00] scanned 100 rows\n'), '[12:00] scanned 100 rows')
  assert.equal(client.jobOutputLine(''), '')
  assert.equal(
    client.jobOutputTail('\u001b[32mstart\u001b[0m\nline 1\nline 2\nline 3\n', 600, 3),
    'line 1\nline 2\nline 3',
  )
  const lineText = client.jobOutputLine('正在扫描第 3/10 批…')
  jobs[0].line = lineText
  jobs[0].tail = '已扫完第 2 批，共命中 120 条\n第 3 批扫描中'
  jobs[0].outputTotal = 2048

  // 展示名：命令式 label 换成「bash 任务」，短标签保留。
  assert.equal(client.jobDisplayName({ label: '/Users/someone/run.sh --full', kind: 'bash' }, t), 'bash 任务')
  assert.equal(client.jobDisplayName({ label: '跑 10 轮压测', kind: 'bash' }, t), '跑 10 轮压测')
  assert.equal(client.jobDisplayName({ label: '', kind: '' }, t), '后台任务')

  // 会话上下文：这一轮用户要什么。
  // 真实日志形状：turn/start → step/start → user/message（内容直接挂在 data 上），
  // 之后才是 runtime-context / skill-catalog 这类注入消息。
  const goalEntries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 990000, data: { turn: 45 } } },
    { type: 'event', event: { type: 'step/start', seq: 2, time: 990010, data: { turn: 45, step: 1 } } },
    { type: 'event', event: { type: 'user/message', seq: 3, time: 990020, data: { role: 'user', id: 'u1', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '把科创债 ETF 世界的两个人群补齐，跑完把结果带回来' }] } } },
    { type: 'event', event: { type: 'user/message', seq: 4, time: 990030, data: { role: 'user', id: 'u2', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current working directory: …' }] } } },
    { type: 'event', event: { type: 'user/message', seq: 5, time: 1100000, data: { role: 'user', id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: '进度呢' }] } } },
  ]
  // 中途追问不能顶掉出发点的请求。
  assert.equal(client.jobGoalOf(goalEntries, 45), '把科创债 ETF 世界的两个人群补齐，跑完把结果带回来')
  const goal = client.jobGoalOf(goalEntries, 45)
  assert.equal(goal, '把科创债 ETF 世界的两个人群补齐，跑完把结果带回来')
  assert.equal(client.jobGoalOf(goalEntries, 46), '')
  assert.equal(client.jobGoalOf([]), '')
  // 同名导出：这一行也拿它显示「这一轮的要求」。
  assert.equal(client.turnGoalOf(goalEntries, 45), goal)
  assert.equal(client.turnGoalOf(goalEntries, 46), '')

  const view = { turn: 45, startedAt: 990000, running: false }
  const entry = client.jobProgressEntryOf(jobs, view, { stallMs: 600000 }, t, 'zh', now, goal)
  assert.equal(entry.turn, 45)
  assert.equal(entry.status, 'running')
  assert.equal(entry.anchor, jobStart)
  assert.equal(entry.bucket, Math.floor((now - jobStart) / 600000))
  assert.equal(entry.digest.jobs.length, 2)
  assert.equal(entry.digest.jobs[0].elapsedMinutes, 466)
  assert.equal(entry.digest.jobs[0].line, '正在扫描第 3/10 批…')
  assert.match(entry.summary, /关于「把科创债 ETF 世界的两个人群补齐/)
  // 命令式的任务名不进摘要：人和模型看到的都是「bash 任务」。
  assert.match(entry.summary, /「bash 任务」还在运行/)
  assert.doesNotMatch(entry.summary, /pgrep/)
  assert.match(entry.summary, /已运行 7 小时 46 分/)
  assert.match(entry.summary, /正在扫描第 3\/10 批…/)
  assert.equal(entry.silenceMs, 0)
  assert.equal(entry.digest.goal, goal)
  assert.equal(entry.jobId, 'bash-1')
  assert.equal(entry.jobName, 'bash 任务')
  assert.equal(entry.jobGoal, goal)
  assert.equal(entry.digest.jobs[0].name, 'bash 任务')
  assert.equal(entry.digest.jobs[0].tail, '已扫完第 2 批，共命中 120 条\n第 3 批扫描中')
  assert.equal(client.jobProgressEntryOf([], view, { stallMs: 600000 }, t, 'zh', now), null)
  assert.equal(client.jobProgressEntryOf(jobs, { turn: 0 }, { stallMs: 600000 }, t, 'zh', now), null)

  const segment = client.jobSegmentText(jobs, t, false)
  assert.match(segment, /后台任务 2 个仍在运行/)
  // 名字、时长、输出出自同一个任务，不再拿最长时长配别人的输出。
  assert.match(segment, /「bash 任务」已运行 7 小时 46 分/)
  assert.match(segment, /最近输出：正在扫描第 3\/10 批…/)
  const mixedJobs = [
    { id: 'j1', kind: 'bash', label: '跑 10 轮压测', status: 'running', startedAt: now - 3 * 3600000, elapsedMs: 3 * 3600000, line: '', progress: '', outputTotal: 0 },
    { id: 'j2', kind: 'bash', label: '盯行情', status: 'running', startedAt: now - 300000, elapsedMs: 300000, line: '第 12 批命中 3 条', progress: '', outputTotal: 3 },
  ]
  const mixedText = client.jobSegmentText(mixedJobs, t, false)
  assert.match(mixedText, /「盯行情」已运行 5 分/)
  assert.doesNotMatch(mixedText, /3 小时/)
  assert.match(mixedText, /最近输出：第 12 批命中 3 条/)
  // 还没有任何输出时说清楚，而不是只剩一句「已运行」。
  assert.match(
    client.jobSegmentText([{ id: 'j3', kind: 'bash', label: '跑 10 轮压测', status: 'running', startedAt: now - 600000, elapsedMs: 600000, line: '', progress: '', outputTotal: 0 }], t, true),
    /「跑 10 轮压测」已运行 10 分 · 还没有输出/,
  )
  assert.equal(client.jobSegmentText([], t, true), '')

  const segments = client.buildTurnSegments({ ...view, running: true }, { progress: true, stallMs: 600000, activity: false, summary: true, jobs: true }, t, null, jobs)
  assert.deepEqual([...segments.map((item) => item.key)], ['jobs'])
  const off = client.buildTurnSegments({ ...view, running: true }, { progress: true, stallMs: 600000, activity: false, summary: true, jobs: false }, t, null, jobs)
  assert.deepEqual([...off.map((item) => item.key)], [])

  // 只在「本轮结束」或「停在等你回答」时单独记后台任务进度。
  const cfg = { progress: true, jobs: true, stallMs: 600000 }
  assert.equal(client.jobProgressDueOf(view, cfg, now + 600000, now), true)
  assert.equal(client.jobProgressDueOf(view, cfg, now + 300000, now), false)
  assert.equal(client.jobProgressDueOf({ ...view, running: true, awaiting: '' }, cfg, now + 600000, now), false)
  assert.equal(client.jobProgressDueOf({ ...view, running: true, awaiting: 'question' }, cfg, now + 600000, now), true)
  assert.equal(client.jobProgressDueOf({ ...view, running: true, awaiting: 'approval' }, cfg, now + 600000, now), true)
  assert.equal(client.jobProgressDueOf(view, { ...cfg, progress: false }, now + 600000, now), false)
  assert.equal(client.jobProgressDueOf(view, { ...cfg, jobs: false }, now + 600000, now), false)
  assert.equal(client.jobProgressDueOf({ ...view, turn: 0 }, cfg, now + 600000, now), false)
})

test('recap entries group by turn and support both orders', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const items = [
    { sessionId: 's', seq: 1, kind: 'answered', turn: 1, at: 3000, summary: 'r1' },
    { sessionId: 's', seq: 2, kind: 'progress', turn: 1, at: 1000, bucket: 1, anchor: 900, summary: 'p1' },
    { sessionId: 's', seq: 2, kind: 'progress', turn: 1, at: 2000, bucket: 2, anchor: 900, summary: 'p2' },
    { sessionId: 's', seq: 4, kind: 'progress', turn: 2, at: 4000, bucket: 1, anchor: 3500, elapsedMs: 3000, summary: 'p3' },
    { sessionId: 's', seq: 5, kind: 'answered', turn: 2, at: 5000, summary: 'r2' },
    // 第 1 轮的任务进度跑到很晚：组仍按轮次排，不按最后时间浮到第 2 轮上面。
    { sessionId: 's', seq: 6, kind: 'progress', turn: 1, at: 9000, bucket: 3, anchor: 900, summary: 'p-late' },
    { sessionId: 's', seq: 9, kind: 'answered', turn: null, at: 500, summary: 'old' },
  ]

  const desc = client.groupRecapEntries(items, 'desc')
  assert.deepEqual([...desc.map((group) => group.key)], ['t:2', 't:1', 'u'])
  assert.deepEqual([...desc[0].entries.map((item) => item.summary)], ['r2', 'p3'])
  assert.deepEqual([...desc[1].entries.map((item) => item.summary)], ['p-late', 'r1', 'p2', 'p1'])
  assert.equal(desc[1].firstAt, 1000)
  assert.equal(desc[1].lastAt, 9000)
  assert.equal(desc[0].firstAt, 1000)

  const asc = client.groupRecapEntries(items, 'asc')
  assert.deepEqual([...asc.map((group) => group.key)], ['t:1', 't:2', 'u'])
  assert.deepEqual([...asc[0].entries.map((item) => item.summary)], ['p1', 'p2', 'r1', 'p-late'])
  assert.deepEqual([...asc[1].entries.map((item) => item.summary)], ['p3', 'r2'])

  // 同一个任务的进度单独成组，组头的时长说成「任务已运行」，不冒充某一轮的用时。
  const jobItems = [
    { sessionId: 's', seq: 1, kind: 'progress', turn: 44, at: 2000, bucket: 1, anchor: 900, jobId: 'bash-1', jobName: 'bash 任务', elapsedMs: 8 * 3600 * 1000, summary: 'j1' },
    { sessionId: 's', seq: 2, kind: 'progress', turn: 44, at: 3000, bucket: 2, anchor: 900, jobId: 'bash-1', jobName: 'bash 任务', elapsedMs: 8.1 * 3600 * 1000, summary: 'j2' },
    { sessionId: 's', seq: 3, kind: 'answered', turn: 44, at: 2500, summary: 'r44' },
  ]
  const jobGroups = client.groupRecapEntries(jobItems, 'desc')
  assert.equal(jobGroups[0].key, 'j:bash-1')
  assert.equal(jobGroups[0].isJob, true)
  assert.equal(jobGroups[0].jobName, 'bash 任务')
  assert.deepEqual([...jobGroups[0].entries.map((item) => item.summary)], ['j2', 'j1'])
  assert.equal(jobGroups[1].key, 't:44')
  assert.match(client.recapGroupTime(jobGroups[0], (key) => key), /任务已运行 8 小时/)
})

test('recap history filters summaries and progress entries', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  const progress = {
    sessionId: 's1', seq: 2, kind: 'progress', turn: 2, bucket: 1, anchor: 2000, at: 1700000000000,
    status: 'stalled', summary: '第 2 轮 · 运行 job_output · 等待 10 分',
    activity: '运行 job_output…', elapsedMs: 700000, silenceMs: 600000, steps: 2,
  }
  const summary = {
    sessionId: 's1', seq: 1, kind: 'answered', at: 1699999000000,
    summary: '旧摘要', user: '改测试', assistant: '改好了',
  }
  let calls = 0
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      calls += 1
      if (calls === 1) return [{ status: 'ready', items: [progress, summary] }, () => {}]
      if (calls === 2) return ['progress', () => {}]
      if (calls === 3) return ['desc', () => {}]
      if (calls === 4) return ['p:2:2:2000:1', () => {}]
      if (calls === 5) return [true, () => {}]
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const section = client.RecapHistorySection({
    sessionId: 's1',
    t: (key) => key,
    initialFilter: 'progress',
    initialFilterRevision: 1,
  })
  const json = JSON.stringify(section)
  assert.match(json, /wdxp-filter/)
  assert.match(json, /wdxp-filterActive/)
  assert.match(json, /wdxp-group/)
  assert.match(json, /wdxp-groupHead/)
  assert.match(json, /wdxp-groupTime/)
  assert.match(json, /wdxp-rowMetaCol/)
  assert.match(json, /第 2 轮/)
  assert.match(json, /进度 1/)
  assert.match(json, /最新在前/)
  assert.match(json, /最早在前/)
  assert.match(json, /job_output/)
  assert.match(json, /总耗时/)
  assert.match(json, /未回复/)
  assert.match(json, /等待/)
  assert.match(json, /wdxp-confirm/)
  assert.match(json, /确认清空/)
  assert.doesNotMatch(json, /旧摘要/)
})

test('expanded line reuses the recap reply from history instead of the request', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const at = 1700000000000
  const items = [
    { kind: 'answered', turn: 4, at: at, summary: '旧摘要', user: '上一轮的要求', assistant: '上一轮的回复' },
    { kind: 'progress', turn: 4, at: at + 1000, bucket: 1, summary: '进度摘要' },
    { kind: 'answered', turn: 4, at: at + 2000, summary: '新摘要', user: '这一轮的要求', assistant: '这一轮的回复原文' },
    { kind: 'answered', turn: 5, at: at + 3000, summary: '别的轮次', user: '别的要求', assistant: '不属于这一轮' },
  ]
  // 运行中那行的文本 = 时间点 + 最新进度摘要；旧记录没有 at 时只给正文。
  assert.equal(client.progressNoteText(null), '')
  assert.equal(client.progressNoteText({ text: '没有时间点的旧记录' }), '没有时间点的旧记录')
  assert.match(client.progressNoteText({ at: Date.now(), text: '刚写的进度' }), /^\d{1,2}:\d{2} 刚写的进度$/)

  const hit = client.latestTurnReply(items, 4)
  assert.equal(hit.reply, '这一轮的回复原文')
  assert.equal(hit.question, '')
  // 只停在提问的那一轮展开后给「待回答」，没有回复可给。
  const asked = client.latestTurnReply([{ kind: 'question', turn: 4, at: at, question: '要用哪个模型？', assistant: '' }], 4)
  assert.equal(asked.reply, '')
  assert.equal(asked.question, '要用哪个模型？')
  // 只有进度记录、或轮次不符时不给。
  assert.equal(client.latestTurnReply([{ kind: 'progress', turn: 4, at: at, summary: '进度' }], 4), null)
  assert.equal(client.latestTurnReply(items, 6), null)
  assert.equal(client.latestTurnReply([], 4), null)
})

test('turn view reports silence, status and progress segments', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const t = (key) => key
  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 2 } } },
    { type: 'event', event: { type: 'step/start', seq: 2, time: 1000, data: { turn: 2, step: 1 } } },
    { type: 'event', event: { type: 'tool/call', seq: 3, time: 2000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"job_output"}', turn: 2, step: 1 } } },
  ]
  const view = client.deriveTurnView(entries, 100000)
  assert.equal(view.running, true)
  assert.equal(view.status, 'running')
  assert.equal(view.lastEventAt, 2000)
  assert.equal(view.silenceMs, 98000)
  assert.equal(view.steps, 1)
  assert.equal(view.actions[0].done, false)

  const stalled = client.turnStatusInfo(view, t, true)
  assert.equal(stalled.kind, 'stalled')
  // 卡住时要说明静默了多久，否则「无新输出」分不清是刚停还是停了一小时。
  assert.equal(stalled.label, '无新输出 1 分')
  // 还在跑工具时徽标不报当前动作：正文区的过程行已经写了「正在运行命令」。
  assert.equal(client.turnStatusInfo(view, t, false).label, '')

  // 运行中这一行给「会话回顾」里的最新进度，不再报「第 2 轮 · 未回复 1 分 39 秒」。
  const runningSegments = client.buildTurnSegments(view, { progress: true, stallMs: 45000, activity: false, summary: true }, t, null, [], '修登录框的校验，等测试结果。')
  assert.deepEqual([...runningSegments.map((segment) => segment.key)], ['note'])
  assert.equal(runningSegments[0].text, '修登录框的校验，等测试结果。')

  const completedView = client.deriveTurnView([
    ...entries,
    { type: 'event', event: { type: 'tool/result', seq: 4, time: 3000, data: { turn: 2, message: { source: { callId: 'c1' } } } } },
    { type: 'event', event: { type: 'turn/end', seq: 5, time: 9000, data: { turn: 2, reason: { kind: 'completed' } } } },
  ], 10000)
  const completedStatus = client.turnStatusInfo(completedView, t, false)
  assert.equal(completedStatus.kind, 'done')
  const completedSegments = client.buildTurnSegments(completedView, { progress: true, stallMs: 45000, activity: false, summary: true }, t, { text: '改完测试' })
  assert.deepEqual([...completedSegments.map((segment) => segment.key)], ['meta', 'summary'])
  // 用时压成 mm:ss，完整说法只留在 title。
  assert.equal(completedSegments[0].text, '0:08')
  assert.match(completedSegments[0].title, /第 2 轮 · 用时 8 秒/)
  assert.equal(client.compactDuration(8 * 60000 + 40000), '8:40')
  assert.equal(client.compactDuration(3600000 + 5 * 60000 + 30000), '1:05:30')
})

test('line chrome uses one icon scale and shared action-button geometry', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // 行尾三个操作键：同一个 20×18 命中区、同一个圆角，关闭键也带键盘聚焦轮廓。
  assert.match(code, /\.wdxt-open,\.wdxt-expand,\.wdxt-close\{width:20px;height:18px/)
  assert.match(code, /\.wdxt-open:focus-visible,\.wdxt-expand:focus-visible,\.wdxt-close:focus-visible\{opacity:1;outline:/)
  // 状态只用颜色区分：绿=完成、红=出错/拦截、橙=等你反馈或卡住、蓝=运行中；灰=取消/中断。
  assert.match(code, /\.wdxt-status\[data-kind="done"\]\{color:var\(--dsw-alias-state-success-primary\)\}/)
  assert.match(code, /\.wdxt-status\[data-kind="error"\],\.wdxt-status\[data-kind="blocked"\]\{color:var\(--dsw-alias-state-error-primary\)/)
  assert.match(code, /\.wdxt-status\[data-kind="running"\]\{color:var\(--dsw-alias-state-business-primary\)/)
  assert.match(code, /\.wdxt-status\[data-kind="stalled"\]\{color:var\(--dsw-alias-state-warn-label\)/)
  // 只留色点的状态不需要胶囊底色。
  assert.match(code, /\.wdxt-status\.wdxt-statusBare\{border:0;background:transparent;padding:0;max-width:none\}/)
  // 进度表盘 12px。
  assert.match(code, /\.wdxt-metaIcon\{width:12px;height:12px/)
  // 详情块的淡入也遵守 reduced motion，和行本身一致。
  assert.match(code, /\.wdxt-row,\.wdxt-detail\{animation:none\}/)
})

test('line settings default to a 10 minute progress interval', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const defaults = client.lineSettings(undefined)
  assert.equal(defaults.progress, true)
  assert.equal(defaults.jobs, true)
  assert.equal(defaults.stallMs, 600000)

  const configured = client.lineSettings({ value: { recapProgress: false, recapStallSeconds: '90', recapActivity: true, recap: false, recapJobs: false } })
  assert.equal(configured.progress, false)
  assert.equal(configured.jobs, false)
  assert.equal(configured.stallMs, 90000)
  assert.equal(configured.activity, true)
  assert.equal(configured.summary, false)

  const clamped = client.lineSettings({ value: { recapStallSeconds: 1 } })
  assert.equal(clamped.stallMs, 600000)
  assert.equal(client.formatDuration(8000, (key) => key), '8 秒')
  assert.equal(client.formatDuration(125000, (key) => key), '2 分 5 秒')
  assert.equal(client.formatDuration(3720000, (key) => key), '1 小时 2 分')
})

test('turn line renders a silent running turn with a progress shortcut', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  const now = Date.now()
  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: now - 20 * 60000, data: { turn: 2 } } },
    { type: 'event', event: { type: 'tool/call', seq: 2, time: now - 19 * 60000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"job_output"}', turn: 2, step: 1 } } },
  ]
  let calls = 0
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      calls += 1
      return [calls === 1 ? entries : initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  let opened = 0
  const line = client.TurnRecapDock({
    sessionId: 'session-1',
    t: (key) => key,
    readFeed: () => null,
    openProgress: () => { opened += 1 },
    useSession: () => true,
    useInput: () => ({ draft: '', attachmentIds: [] }),
    useSettings: () => ({ value: { recapProgress: true, recapStallSeconds: 60, recap: false } }),
  })
  const json = JSON.stringify(line)
  assert.match(json, /wdxt-row/)
  assert.match(json, /data-state":"stalled/)
  assert.match(json, /无新输出/)
  // 没有存下来的进度摘要时不本地拼一段；这行靠状态词和入口保住可达性，
  // 也不重复正文区正在算的「未回复 19 分」。
  assert.doesNotMatch(json, /wdxt-note/)
  assert.doesNotMatch(json, /未回复|第 2 轮/)
  assert.match(json, /wdxt-open/)
  ;(function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.props && node.props.key === 'open' && typeof node.props.onClick === 'function') node.props.onClick()
    for (const child of node.children || []) walk(child)
  })(line)
  assert.equal(opened, 1)
})

test('turn line shows a long busy turn that has no reply, and hides once replied', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  function renderLine(entries, note, expandedTurn) {
    let calls = 0
    // 组件里的 useState 顺序：entries / tick / summary / dismissedTurn / waitedTurn /
    // jobsSnapshot / progressNote / noteRevision / expandedTurn。
    const values = [entries, 0, null, 0, 0, null, note || null, 0, expandedTurn || 0]
    const react = {
      createElement(type, props, ...children) { return { type, props: props || {}, children } },
      useState(initial) {
        calls += 1
        return [calls <= values.length ? values[calls - 1] : initial, () => {}]
      },
      useEffect() {},
      useRef(value) { return { current: value } },
      useLayoutEffect() {},
    }
    const client = loaded.factory((id) => {
      if (id === 'react') return react
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`unexpected require: ${id}`)
    })
    return client.TurnRecapDock({
      sessionId: 'session-1',
      t: (key) => key,
      readFeed: () => null,
      openProgress: () => {},
      useSession: () => true,
      useInput: () => ({ draft: '', attachmentIds: [] }),
      useSettings: () => ({ value: { recapProgress: true, recapStallSeconds: 600, recap: false } }),
    })
  }

  const now = Date.now()
  const busy = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: now - 19 * 60000, data: { turn: 2 } } },
    { type: 'event', event: { type: 'tool/call', seq: 2, time: now - 17 * 60000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"job_output"}', turn: 2, step: 1 } } },
    { type: 'event', event: { type: 'tool/result', seq: 3, time: now - 16 * 60000, data: { turn: 2, step: 1, message: { source: { callId: 'c1' } } } } },
    { type: 'event', event: { type: 'tool/call', seq: 4, time: now - 3 * 60000, data: { callId: 'c2', name: 'bash', arguments: '{"command":"job_output"}', turn: 2, step: 2 } } },
  ]
  const note = { turn: 2, at: Date.now(), text: '批量数量输入正抽成共用组件，图床和分析卡在同步替换，前端检查待跟进。' }
  const line = renderLine(busy, note)
  assert.ok(line !== null)
  const json = JSON.stringify(line)
  assert.match(json, /data-state":"running/)
  // 运行标记只剩一个脉冲点（label 为空），当前动作仍由正文区的过程行负责。
  assert.match(json, /"label":"","live":false/)
  // 这一段就是「会话回顾」里最新一条进度，原样上屏；不再写和过程行重复的「第 2 轮 · 未回复 19 分」。
  assert.match(json, /wdxt-note/)
  // 进度摘要前面带它被记下的时间点（当天只给时分）。
  assert.match(json, /\d{1,2}:\d{2} 批量数量输入正抽成共用组件/)
  assert.match(json, /批量数量输入正抽成共用组件/)
  assert.doesNotMatch(json, /未回复|第 2 轮/)
  assert.doesNotMatch(json, /进行中|等待/)
  // 长进度会截断，所以它和摘要一样可展开：单行留状态点，完整进度进详情块。
  assert.match(json, /wdxt-expand/)
  const expandedJson = JSON.stringify(renderLine(busy, note, 2))
  assert.match(expandedJson, /wdxt-detailText/)
  assert.match(expandedJson, /进度/)
  assert.match(expandedJson, /批量数量输入正抽成共用组件/)
  assert.doesNotMatch(expandedJson, /wdxt-note/)

  // 同样的长时间运行，只要最近给过正文回复，就不再提示。
  const replied = [...busy, { type: 'event', event: { type: 'assistant/message', seq: 3, time: now - 2 * 60000, data: { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: '先说明一下当前进展' }] } } } }]
  assert.equal(renderLine(replied), null)
})

test('status reads as one colored dot and the turn meta as #N + mm:ss', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) { return [initial, () => {}] },
    useEffect() {},
    useRef(value) { return { current: value } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  // 完成 = 一个静态绿点（颜色在 CSS 的 data-kind 上），状态词进 title / 无障碍标签。
  const doneChip = client.StatusChip({ kind: 'done', label: '已完成', live: true })
  assert.equal(doneChip.props.className, 'wdxt-status wdxt-statusBare')
  assert.deepEqual([...doneChip.children[0].map((child) => child.props.key)], ['dot'])
  assert.equal(doneChip.children[0][0].props.className, 'wdxt-dotStatic')
  assert.equal(doneChip.props['aria-label'], '已完成')
  assert.equal(doneChip.props.title, '已完成')
  // 异常态点后仍然写字：「出错 / 待批准 bash / 无新输出 12 分」不是颜色能替代的。
  const errorChip = client.StatusChip({ kind: 'error', label: '出错', live: true })
  assert.equal(errorChip.props.className, 'wdxt-status')
  assert.deepEqual([...errorChip.children[0].map((child) => child.props.key)], ['dot', 'label'])
  assert.equal(errorChip.children[0][0].props.className, 'wdxt-dotStatic')
  // 运行中是一个脉冲点，不带文字。
  const runningChip = client.StatusChip({ kind: 'running', label: '' })
  assert.equal(runningChip.props.className, 'wdxt-status wdxt-statusBare')
  assert.equal(runningChip.children[0].length, 1)
  assert.equal(runningChip.children[0][0].props.className, 'wdxt-dot')
})

test('completed turn line expands into the recap reply instead of the request', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  const now = Date.now()
  const longGoal = '现在这个状态栏和上面的一样其实没有什么意义，除了信息透明，如果已有展示的信息，不需要重复展示'
  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: now - 1300000, data: { turn: 1 } } },
    { type: 'event', event: { type: 'user/message', seq: 2, time: now - 1290000, data: { role: 'user', content: [{ type: 'text', text: longGoal }] } } },
    { type: 'event', event: { type: 'turn/end', seq: 3, time: now - 100000, data: { turn: 1, reason: { kind: 'stop' } } } },
  ]
  const summaryState = {
    text: '去重状态栏与上方重复信息；运行中不再报本轮耗时，动作和思考交给正文区。',
    turn: 1,
    reply: '改完后的回复原文：状态词换成图标，轮次和用时压成 #1 · 1:30，摘要因此多出半行宽度；测试都过了。',
    question: '',
  }

  function render(expandedTurn, draft) {
    let calls = 0
    const pressed = []
    const react = {
      createElement(type, props, ...children) { return { type, props: props || {}, children } },
      useState(initial) {
        calls += 1
        const values = [entries, 0, summaryState, 0, 0, null, null, 0, expandedTurn]
        return [calls <= values.length ? values[calls - 1] : initial, (value) => { pressed.push(value) }]
      },
      useEffect() {},
      useRef(value) { return { current: value } },
      useLayoutEffect() {},
    }
    const client = loaded.factory((id) => {
      if (id === 'react') return react
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`unexpected require: ${id}`)
    })
    const line = client.TurnRecapDock({
      sessionId: 'session-1',
      t: (key) => key,
      readFeed: () => null,
      openProgress: () => {},
      useSession: () => false,
      useInput: () => ({ draft: draft || '', attachmentIds: [] }),
      useSettings: () => ({ value: { recap: true, recapProgress: true, recapStallSeconds: 600 } }),
    })
    return { line, pressed }
  }

  const collapsed = render(0)
  const collapsedJson = JSON.stringify(collapsed.line)
  assert.match(collapsedJson, /wdxt-expand/)
  assert.match(collapsedJson, /"aria-expanded":false/)
  assert.doesNotMatch(collapsedJson, /wdxt-detailText/)
  // 完成态：一个对勾 + `#1 · ◷ mm:ss`，不再把「已完成 / 第 1 轮 · 用时 x 分 y 秒」写成大字。
  assert.match(collapsedJson, /wdxt-meta/)
  assert.match(collapsedJson, /#1/)
  // 单行只放进度和摘要，不展示「这一轮的要求」——空间留给前面两段。
  assert.match(collapsedJson, /去重状态栏与上方重复信息/)
  assert.doesNotMatch(collapsedJson, new RegExp(longGoal))

  const expanded = render(1)
  const expandedJson = JSON.stringify(expanded.line)
  assert.match(expandedJson, /wdxt-detailText/)
  // 展开后是「回复」+「摘要」：用户刚发的那句话不再抄一遍。
  assert.match(expandedJson, /回复/)
  assert.match(expandedJson, /改完后的回复原文/)
  assert.match(expandedJson, /摘要/)
  assert.match(expandedJson, /去重状态栏与上方重复信息/)
  assert.match(expandedJson, /"aria-expanded":true/)
  assert.doesNotMatch(expandedJson, /本轮要求/)
  assert.doesNotMatch(expandedJson, new RegExp(longGoal))

  // 行尾的「展开」只剩一个 ▾ 图标，文字不再占位；点一下仍然切到展开态。
  const expandNodes = []
  const openNodes = []
  ;(function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props && node.props.className === 'wdxt-expand') expandNodes.push(node)
    if (node.props && node.props.className === 'wdxt-open') openNodes.push(node)
    for (const child of node.children || []) walk(child)
  })(collapsed.line)
  assert.equal(expandNodes.length, 1)
  const expandIcon = expandNodes[0].children[0]
  assert.equal(expandIcon.type, 'svg')
  assert.equal(expandIcon.props['aria-hidden'], 'true')
  assert.equal(expandNodes[0].props['aria-expanded'], false)
  assert.equal(expandNodes[0].children.length, 1)
  // 和「›」同一套箭头：同一个 16 的 viewBox、同样的 14px 尺寸，视觉大小才一致。
  assert.equal(openNodes.length, 1)
  const openIcon = openNodes[0].children[0]
  assert.equal(openIcon.props.width, 14)
  assert.equal(openIcon.props.height, 14)
  assert.equal(expandIcon.props.width, 14)
  assert.equal(expandIcon.props.height, 14)
  assert.equal(expandIcon.props.viewBox, openIcon.props.viewBox)
  expandNodes[0].props.onClick()
  assert.deepEqual(collapsed.pressed, [1])

  // 正在输入时这一行仍然在；只有发出去（新一轮开始）才让位。
  const typing = render(0, '准备发一条新消息')
  assert.ok(typing.line !== null)
  assert.match(JSON.stringify(typing.line), /wdxt-meta/)
})

test('running line leaves the action to the transcript and only reports no-reply time', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })
  const t = (key) => key
  const start = { type: 'event', event: { type: 'turn/start', seq: 1, time: 0, data: { turn: 7 } } }
  const step = { type: 'event', event: { type: 'step/start', seq: 2, time: 0, data: { turn: 7, step: 1 } } }
  function bash(callId, at) {
    return { type: 'event', event: { type: 'tool/call', seq: 3, time: at, data: { callId: callId, name: 'bash', arguments: '{"command":"' + callId + '"}', turn: 7, step: 1 } } }
  }
  function result(callId, at) {
    return { type: 'event', event: { type: 'tool/result', seq: 4, time: at, data: { turn: 7, step: 1, message: { source: { callId: callId } } } } }
  }

  // 纯思考：正文区的过程行已经在显示这句思考，徽标和活动段都不复述。
  const thinkingEntries = [
    start,
    step,
    { type: 'transient', event: { type: 'assistant/live-chunk', seq: 5, time: 1000, data: { turn: 7, step: 1, chunk: { type: 'reasoning-delta', text: '先看依赖，再跑测试' } } } },
  ]
  const thinking = client.deriveTurnView(thinkingEntries, 600000)
  assert.equal(client.turnStatusInfo(thinking, t, false).label, '')
  const thinkingSegments = client.buildTurnSegments(thinking, { progress: false, stallMs: 600000, activity: true, summary: false }, t, null)
  assert.deepEqual([...thinkingSegments.map((segment) => segment.key)], [])

  // 连着四个 bash：徽标不报动作，摊开的活动流水折叠成一条「运行命令 ×4」。
  const many = [start, step, bash('c1', 1000), result('c1', 2000), bash('c2', 3000), result('c2', 4000), bash('c3', 5000), result('c3', 6000), bash('c4', 7000)]
  const busy = client.deriveTurnView(many, 60000)
  assert.equal(client.turnStatusInfo(busy, t, false).label, '')
  const busySegments = client.buildTurnSegments(busy, { progress: false, stallMs: 600000, activity: true, summary: false }, t, null)
  assert.deepEqual([...busySegments.map((segment) => segment.key)], ['activity'])
  assert.equal(busySegments[0].text, '运行命令 ×4')
  // 默认关闭活动流水时，正文区之外的这行没有任何动作片段；还没跑满一个间隔，
  // 也没有可回看的时间窗。
  const busyDefault = client.buildTurnSegments(busy, { progress: true, stallMs: 600000, activity: false, summary: false }, t, null)
  assert.deepEqual([...busyDefault.map((segment) => segment.key)], [])

  // 结果回来、下一步还没开始：同样不报「处理结果」。
  const handled = client.deriveTurnView([...many, result('c4', 8000)], 70000)
  assert.equal(client.turnStatusInfo(handled, t, false).label, '')

  // 中途回复过，本轮耗时和「未回复」就不再是同一段时间。
  const replied = client.deriveTurnView([
    start,
    bash('c1', 60000),
    { type: 'event', event: { type: 'assistant/message', seq: 6, time: 600000, data: { turn: 7, message: { role: 'assistant', content: [{ type: 'text', text: '先说结论' }] } } } },
  ], 1500000)
  assert.equal(client.turnStatusInfo(replied, t, false).label, '')
  // 之后一刻钟又没动静：没有可回看的时间窗，连「未回复 15 分」也不再写——
  // 正文区的过程行已经在算同一个秒数，真卡住时交给状态词「无新输出」。
  const repliedCfg = { progress: true, stallMs: 600000, activity: false, summary: false }
  assert.equal(client.latestProgressNote([], replied.turn), null)
  const repliedSegments = client.buildTurnSegments(replied, repliedCfg, t, null, [], '')
  assert.deepEqual([...repliedSegments.map((segment) => segment.key)], [])

  // 截图里的那种情况：思考 + 目标 + 欠回复。正文区已有此刻的动作和思考，
  // 这一行改报前面每个完整时间窗在做什么，不再重复「未回复 10 分」。
  const liveCfg = { progress: true, stallMs: 600000, activity: false, summary: false, jobs: false }
  const liveSegments = client.buildTurnSegments(thinking, liveCfg, t, null, [], '读完依赖清单，正在跑测试用例。')
  assert.deepEqual([...liveSegments.map((segment) => segment.key)], ['note'])
  assert.equal(liveSegments[0].text, '读完依赖清单，正在跑测试用例。')

  // 刚回复过、还没到下一条时间窗时，这行不再只写一个轮次。
  const fresh = client.deriveTurnView([start], 0)
  assert.equal(client.latestProgressNote([], fresh.turn), null)
  const freshSegments = client.buildTurnSegments(fresh, liveCfg, t, null, [], '')
  assert.deepEqual([...freshSegments.map((segment) => segment.key)], [])

  // 等回答 / 待批准仍然优先于运行态；这一行的活动段给那句问题本身。
  const waiting = client.deriveTurnView([
    start,
    { type: 'event', event: { type: 'tool/call', seq: 7, time: 1000, data: { callId: 'c9', name: 'ask_user_question', arguments: JSON.stringify({ question: '现在跑吗？' }), turn: 7, step: 1 } } },
  ], 2000)
  assert.equal(client.turnStatusInfo(waiting, t, false).label, '等你回答')
  const waitingSegments = client.buildTurnSegments(waiting, { progress: false, stallMs: 600000, activity: true, summary: false }, t, null)
  assert.equal(waitingSegments[0].text, '现在跑吗？')
})

test('finished and waiting states name the reason, the approval target and the request', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })
  const t = (key) => key
  const now = 1000000
  const start = [
    { type: 'event', event: { type: 'turn/start', time: now - 600000, data: { turn: 3 } } },
    { type: 'event', event: { type: 'user/message', time: now - 599000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把输入框上那一行讲清楚' }] } } },
  ]
  const settings = { progress: true, stallMs: 600000, activity: false, summary: false, jobs: true }

  // 出错：只写「出错」等于让用户去翻日志，把原因挂在同一行上。
  const failed = client.deriveTurnView([
    ...start,
    { type: 'event', event: { type: 'turn/end', time: now - 540000, data: { turn: 3, reason: { kind: 'error', error: { message: 'HTTP 429 rate limit exceeded', code: 'PROVIDER_RATE_LIMIT' } } } } },
  ], now)
  assert.equal(client.turnStatusInfo(failed, t, false).kind, 'error')
  const failedSegments = client.buildTurnSegments(failed, settings, t, null, [])
  assert.deepEqual([...failedSegments.map((segment) => segment.key)], ['meta', 'reason'])
  assert.equal(failedSegments[0].text, '1:00')
  assert.equal(failedSegments[0].title, '第 3 轮 · 用时 1 分')
  assert.equal(failedSegments[1].text, '原因：HTTP 429 rate limit exceeded')

  // 没有 message 时退回错误码，而不是直接丢掉。
  const coded = client.deriveTurnView([
    ...start,
    { type: 'event', event: { type: 'turn/end', time: now - 540000, data: { turn: 3, reason: { kind: 'error', error: { code: 'PROVIDER_RATE_LIMIT' } } } } },
  ], now)
  const codedSegments = client.buildTurnSegments(coded, settings, t, null, [])
  assert.equal(codedSegments[1].text, '原因：PROVIDER_RATE_LIMIT')

  // 待批准：说清楚批准哪个工具。
  const approval = client.deriveTurnView([
    ...start,
    { type: 'event', event: { type: 'approval/asked', time: now - 300000, data: { id: 'a1', toolName: 'bash' } } },
  ], now)
  assert.equal(approval.awaiting, 'approval')
  assert.equal(approval.approvalTool, 'bash')
  assert.equal(client.turnStatusInfo(approval, t, false).label, '待批准 bash')
  // 决定之后不再挂着这个工具名。
  assert.equal(client.turnStatusInfo(client.deriveTurnView([
    ...start,
    { type: 'event', event: { type: 'approval/asked', time: now - 300000, data: { id: 'a1', toolName: 'bash' } } },
    { type: 'event', event: { type: 'approval/decided', time: now - 200000, data: { id: 'a1', outcome: 'allow' } } },
  ], now), t, false).label, '')

  // 卡住好几小时：粗粒度时长，不出现「3 小时 0 分」。
  const idle = client.deriveTurnView([...start, { type: 'event', event: { type: 'tool/call', time: now - 3 * 3600000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"sleep"}', turn: 3, step: 1 } } }], now - 2 * 3600000)
  assert.equal(client.turnStatusInfo(idle, t, true).label, '无新输出 1 小时')
  assert.equal(client.formatDuration(3 * 3600000, t), '3 小时')

  // 这一轮的要求不再上屏（展开也没有）：一行已经放不下一段话，
  // 展开时换成同一份回顾里的「回复」。
  const longGoal = '把输入框上方那一行的状态词从「进行中」改成它现在在做什么，顺带把重复的两个时长合并成一句，顺便再补一句这一轮到底在为什么干活'
  const longSegments = client.buildTurnSegments(failed, settings, t, null, [])
  assert.doesNotMatch(longSegments.map((segment) => segment.text).join(' '), new RegExp(longGoal.slice(0, 6)))
})

test('relief panel shows recap and aside tabs, defaulting to recap', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  const react = {
    createElement(type, props, ...children) { return { type, props, children } },
    useState(initial) { return [initial, () => {}] },
    useEffect() {},
    useRef() { return { current: null } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const t = (key) => key
  const panel = client.ReliefPanel({ sessionId: 'session-1', t })
  assert.equal(panel.type, 'div')
  assert.equal(panel.props.className, 'wdxp-page')
  assert.equal(typeof panel.children[0][0].type, 'function')
  var tabs = panel.children[0][1]
  assert.equal(tabs.type, 'div')
  assert.equal(tabs.props.role, 'tablist')
  var tabButtons = tabs.children[0]
  assert.equal(tabButtons.length, 2)
  assert.equal(tabButtons[0].props.id, 'wdxp-tab-recaps')
  assert.equal(tabButtons[0].props['aria-selected'], true)
  assert.equal(panel.children[0][2].props.id, 'wdxp-pane-recaps')
  assert.equal(panel.children[0][2].children[0].type, client.RecapHistorySection)

  // 从输入框那一行跳进来时，轮次和 revision 要原样交给列表，列表据此展开并重读。
  const jumped = client.ReliefPanel({ sessionId: 'session-1', t, requestedTurn: 3, requestedRevision: 9 })
  assert.equal(jumped.children[0][2].children[0].props.jumpTurn, 3)
  assert.equal(jumped.children[0][2].children[0].props.jumpRevision, 9)
  assert.equal(panel.children[0][3].children[0], null)

  const btwPanel = client.ReliefPanel({ sessionId: 'session-1', t, defaultTab: 'btw' })
  var btwTabs = btwPanel.children[0][1].children[0]
  assert.equal(btwTabs[1].props['aria-selected'], true)
  assert.equal(btwPanel.children[0][2].children[0], null)
  assert.equal(btwPanel.children[0][3].children[0].type, client.BtwSection)

  const recaps = client.RecapHistorySection({ sessionId: 'session-1', t })
  assert.equal(recaps.type, 'div')
  assert.equal(recaps.props.className, 'wdxp-body')

  const btw = client.BtwSection({ sessionId: 'session-1', t })
  assert.equal(btw.type, 'div')
  assert.equal(btw.children[0][0].type, 'div')
})

test('a cancelled aside answer is muted, not styled as an error', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  const items = [{ id: '1', question: '还能继续吗？', status: 'cancelled', answer: '', error: '已取消' }]
  let calls = 0
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      calls += 1
      if (calls === 2) return [items, () => {}]
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const tree = JSON.stringify(client.BtwSection({ sessionId: 's1', t: (key) => key }))
  assert.match(tree, /wdxa-note/)
  assert.match(tree, /已取消/)
  assert.doesNotMatch(tree, /wdxa-error/)
})

test('recap history marks the latest turn as waiting for a reply', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  const items = [
    {
      sessionId: 's1', seq: 2, kind: 'progress', turn: 1, bucket: 1, anchor: 1000, at: 1700000001000,
      status: 'stalled', summary: '第 1 轮 · 运行 job_output · 等待 10 分', elapsedMs: 600000, silenceMs: 600000, steps: 1,
    },
    {
      sessionId: 's1', seq: 3, kind: 'question', turn: 1, at: 1700000002000,
      summary: '第 1 轮 · 等你确认', user: '跑完了吗', question: '要继续吗？',
    },
  ]
  let calls = 0
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      calls += 1
      if (calls === 1) return [{ status: 'ready', items: items }, () => {}]
      if (calls === 2) return ['all', () => {}]
      if (calls === 3) return ['desc', () => {}]
      if (calls === 4) return ['s:3', () => {}]
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const waiting = client.RecapHistorySection({ sessionId: 's1', t: (key) => key, running: false, currentTurn: 1 })
  const waitingJson = JSON.stringify(waiting)
  assert.match(waitingJson, /wdxp-groupPending/)
  assert.match(waitingJson, /待跟进/)
  assert.match(waitingJson, /要继续吗？/)

  calls = 0
  const running = client.RecapHistorySection({ sessionId: 's1', t: (key) => key, running: true, currentTurn: 1 })
  assert.doesNotMatch(JSON.stringify(running), /wdxp-groupPending/)

  // 运行中只压掉「正在跑的当前轮」；已经结束的上一轮待跟进仍然保留。
  calls = 0
  const runningPrevious = client.RecapHistorySection({ sessionId: 's1', t: (key) => key, running: true, currentTurn: 2 })
  assert.match(JSON.stringify(runningPrevious), /wdxp-groupPending/)
  assert.match(JSON.stringify(runningPrevious), /要继续吗？/)

  calls = 0
  const newer = client.RecapHistorySection({ sessionId: 's1', t: (key) => key, running: false, currentTurn: 4 })
  assert.doesNotMatch(JSON.stringify(newer), /wdxp-groupPending/)

  calls = 0
  const inWindow = client.RecapHistorySection({ sessionId: 's1', t: (key) => key, running: false, currentTurn: 2, pendingTurns: 3 })
  assert.match(JSON.stringify(inWindow), /wdxp-groupPending/)
})

test('recap history marks a next-step turn as pending', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  const items = [{
    sessionId: 's1', seq: 4, kind: 'answered', turn: 1, at: 1700000003000,
    summary: '第 1 轮 · 下一步：基于 v0.7.0 创建 GitHub Release',
    assistant: '下一步：基于 v0.7.0 创建 GitHub Release',
  }]
  let calls = 0
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      calls += 1
      if (calls === 1) return [{ status: 'ready', items: items }, () => {}]
      if (calls === 2) return ['all', () => {}]
      if (calls === 3) return ['desc', () => {}]
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const section = client.RecapHistorySection({ sessionId: 's1', t: (key) => key, running: false, currentTurn: 1 })
  const json = JSON.stringify(section)
  assert.match(json, /wdxp-groupPending/)
  assert.match(json, /待跟进/)
  assert.match(json, /创建 GitHub Release/)
})

test('recap history empty/error/pending copy follows the actual switches and running state', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  let presetStates = []
  let calls = 0
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      calls += 1
      if (calls <= presetStates.length) return [presetStates[calls - 1], () => {}]
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  function render(states, props) {
    presetStates = states
    calls = 0
    return JSON.stringify(client.RecapHistorySection({ sessionId: 's1', t: (key) => key, ...props }))
  }

  const empty = [{ status: 'empty', items: [] }]
  assert.match(render(empty, { summaryEnabled: false, progressEnabled: false }), /语义摘要和实时进度都已关闭/)
  assert.match(render(empty, { summaryEnabled: true, progressEnabled: false }), /还没有摘要/)
  assert.match(render(empty, { summaryEnabled: false, progressEnabled: true }), /还没有进度记录/)
  assert.match(render(empty, { summaryEnabled: true, progressEnabled: true }), /还没有生成过摘要或进度记录/)

  assert.match(render([{ status: 'error', items: [], code: '' }], {}), /重试/)
  const routeMissing = render([{ status: 'error', items: [], code: 'route-missing' }], {})
  assert.match(routeMissing, /回顾历史路由没加载/)
  assert.doesNotMatch(routeMissing, /重试/)

  const pendingItem = {
    sessionId: 's1', seq: 1, kind: 'question', turn: 1, at: 1700000000000,
    summary: '等你确认', user: '跑完了吗', question: '要继续吗？',
  }
  const progressOnly = {
    sessionId: 's1', seq: 3, kind: 'progress', turn: 1, bucket: 1, anchor: 1000, at: 1700000002000,
    status: 'stalled', summary: '第 1 轮 · 等待', elapsedMs: 600000, silenceMs: 600000, steps: 1,
  }
  const noSummaryPending = render([{ status: 'ready', items: [progressOnly] }, 'pending'], { running: false, currentTurn: 1, summaryEnabled: false, progressEnabled: true })
  assert.match(noSummaryPending, /语义摘要已关闭/)

  const runningPending = render([{ status: 'ready', items: [pendingItem] }, 'pending'], { running: true, currentTurn: 1 })
  assert.match(runningPending, /正在跑的这轮不标待跟进/)
  const count = render([{ status: 'ready', items: [pendingItem] }, 'all'], { running: false, currentTurn: 1 })
  assert.match(count, /1 轮/)

  const progressItem = {
    sessionId: 's1', seq: 2, kind: 'progress', turn: 1, bucket: 1, anchor: 1000, at: 1700000001000,
    status: 'stalled', summary: '第 1 轮 · 等待', elapsedMs: 600000, silenceMs: 600000, steps: 1,
  }
  const span = render([{ status: 'ready', items: [progressItem] }, 'all'], { running: false, currentTurn: 1 })
  assert.match(span, /用时 10 分/)
})

test('recap groups carry turn markers and the jumped turn opens first', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  let presetStates = []
  let calls = 0
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      calls += 1
      if (calls <= presetStates.length) return [presetStates[calls - 1], () => {}]
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    useLayoutEffect() {},
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const items = [
    { sessionId: 's1', seq: 1, kind: 'progress', turn: 1, bucket: 1, anchor: 0, at: 1700000000000, status: 'stalled', summary: '第一轮还在跑', elapsedMs: 600000, silenceMs: 600000, steps: 1 },
    { sessionId: 's1', seq: 2, kind: 'answered', turn: 1, at: 1700000001000, summary: '第一轮摘要', user: 'u1', assistant: 'a1' },
    { sessionId: 's1', seq: 3, kind: 'answered', turn: 2, at: 1700000002000, summary: '第二轮摘要', user: 'u2', assistant: 'a2' },
  ]

  // useState 的顺序：state / filter / order / openKey / confirmClear / clearError / openTurn。
  presetStates = [{ status: 'ready', items: items }, 'all', 'desc', null, false, false, 't:1']
  calls = 0
  const json = JSON.stringify(client.RecapHistorySection({ sessionId: 's1', t: (key) => key, jumpTurn: 1, jumpRevision: 2 }))
  assert.match(json, /"data-wdx-turn":"1"/)
  assert.match(json, /"data-wdx-turn":"2"/)
  // 跳转的那一轮展开，其余轮次保持收起，整页不会被撑长。
  assert.match(json, /第一轮摘要/)
  assert.doesNotMatch(json, /第二轮摘要/)
})

test('the recap request for a finished turn is not aborted when the next turn starts', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const start = code.indexOf('requested.current = key')
  const end = code.indexOf("}, [cfg.summary, sessionId, running, view.turn])", start)
  assert.ok(start >= 0 && end > start)
  const block = code.slice(start, end)
  // 新的一轮开始时 effect 会重跑；这里不能取消上一轮还在生成的摘要请求。
  assert.doesNotMatch(block, /controller\.abort|abort\(\)/)
  assert.match(block, /activeSession\.current !== sessionId/)
})

test('accepting a prediction does not permanently dismiss it', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const start = code.indexOf('function accept()')
  const end = code.indexOf('// Tab 填入', start)
  assert.ok(start >= 0 && end > start)
  const body = code.slice(start, end)
  assert.match(body, /setPrediction\(null\)/)
  assert.doesNotMatch(body, /setDismissed\(/)
})

test('progress digest keeps only the current interval idea and strips command parameters', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)
  const client = loaded.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {}, useRef() {}, useLayoutEffect() {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } },
    { type: 'transient', event: { type: 'assistant/live-chunk', seq: 2, time: 60000, data: { turn: 1, chunk: { type: 'reasoning-delta', text: '先读配置，确认旧标签写在哪。' } } } },
    { type: 'event', event: { type: 'tool/call', seq: 3, time: 120000, data: { callId: 'c1', name: 'read', arguments: '{"file_path":"/repo/src/recap.js"}', turn: 1 } } },
    { type: 'transient', event: { type: 'assistant/live-chunk', seq: 4, time: 660000, data: { turn: 1, chunk: { type: 'reasoning-delta', text: '改成按时间窗总结，命令参数不要带。' } } } },
    { type: 'event', event: { type: 'tool/call', seq: 5, time: 720000, data: { callId: 'c2', name: 'bash', arguments: '{"command":"npm test --watch"}', turn: 1 } } },
    { type: 'event', event: { type: 'assistant/message', seq: 6, time: 780000, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '第二段思考也要保留。' }] } } } },
  ]
  const view = client.deriveTurnView(entries, 1260000)
  const first = client.collectProgressDigest(entries, view, 1, 600000)
  assert.match(first.reasoning, /先读配置/)
  assert.doesNotMatch(first.reasoning, /按时间窗/)
  assert.equal(first.actions[0].verb, 'read')
  assert.equal(first.actions[0].target, 'recap.js')

  const second = client.collectProgressDigest(entries, view, 2, 600000)
  assert.match(second.reasoning, /按时间窗/)
  assert.match(second.reasoning, /第二段思考也要保留/)
  assert.doesNotMatch(second.reasoning, /先读配置/)
  assert.equal(second.actions[0].verb, 'command')
  // 命令的具体参数不进入进度摘要。
  assert.equal(second.actions[0].target, '')

  const labels = {
    'progress.interval': '{from}–{to} 分', 'progress.intervalOne': '{minute} 分',
    'progress.intervalShort': '短 {from}–{to} 分', 'progress.intervalOneShort': '短 {minute} 分',
  }
  const t = (key, params) => {
    let value = labels[key] ?? key
    for (const [name, text] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(text))
    return value
  }
  assert.equal(client.progressIntervalText({ bucket: 1, windowMs: 600000 }, t), '1–10 分')
  // 列表右侧的小字用 short 口径：不带「第」，省地方。
  assert.equal(client.progressIntervalText({ bucket: 1, windowMs: 600000 }, t, 'short'), '短 1–10 分')
  assert.equal(client.progressIntervalText({ bucket: 2, windowMs: 600000 }, t, 'short'), '短 1–20 分')
  assert.equal(client.progressIntervalText({ bucket: 2, windowMs: 600000 }, t), '1–20 分')
  assert.equal(client.progressIntervalText({ bucket: 1 }, t), '')
  // 跳档或中途回复：按真实时间窗落在本轮的哪几分钟。
  assert.equal(client.progressIntervalText({ turnStartedAt: 1000000, windowFromMs: 2200000, windowToMs: 2800000 }, t), '21–30 分')
  assert.equal(client.progressIntervalText({ turnStartedAt: 1000000, windowFromMs: 1200000, windowToMs: 1800000 }, t), '4–14 分')
  // 从本轮开始一直没回复时，第 2 条按累计口径显示 1–20。
  assert.equal(client.progressIntervalText({
    turnStartedAt: 1000000, anchor: 1000000, windowFromMs: 1600000, windowToMs: 2200000,
  }, t), '1–20 分')
})
