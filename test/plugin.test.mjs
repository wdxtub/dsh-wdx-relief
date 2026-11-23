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

function createHostContext(output = '修一下失败的测试') {
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
            return (async function* () {
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

  const segments = client.buildTurnSegments(view, { progress: true, stallMs: 600000, activity: false, summary: true }, t, null)
  assert.deepEqual([...segments.map((segment) => segment.key)], ['progress', 'activity'])
  assert.match(segments[0].text, /等待 10 分/)

  // 一旦有正文回复，等待重新计时；工具事件不会把它重置。
  const replied = [...entries, { type: 'event', event: { type: 'assistant/message', seq: 7, time: 1000000, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '先说下结论' }] } } } }]
  const repliedView = client.deriveTurnView(replied, 1150000)
  assert.equal(repliedView.lastReplyAt, 1000000)
  assert.equal(repliedView.quietMs, 150000)
  assert.equal(repliedView.silenceMs, 150000)
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
    { sessionId: 's', seq: 9, kind: 'answered', turn: null, at: 500, summary: 'old' },
  ]

  const desc = client.groupRecapEntries(items, 'desc')
  assert.deepEqual([...desc.map((group) => group.key)], ['t:2', 't:1', 'u'])
  assert.deepEqual([...desc[0].entries.map((item) => item.summary)], ['r2', 'p3'])
  assert.deepEqual([...desc[1].entries.map((item) => item.summary)], ['r1', 'p2', 'p1'])
  assert.equal(desc[1].firstAt, 1000)
  assert.equal(desc[1].lastAt, 3000)
  assert.equal(desc[0].firstAt, 1000)

  const asc = client.groupRecapEntries(items, 'asc')
  assert.deepEqual([...asc.map((group) => group.key)], ['t:1', 't:2', 'u'])
  assert.deepEqual([...asc[0].entries.map((item) => item.summary)], ['p1', 'p2', 'r1'])
  assert.deepEqual([...asc[1].entries.map((item) => item.summary)], ['p3', 'r2'])
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

  const runningSegments = client.buildTurnSegments(view, { progress: true, stallMs: 45000, activity: false, summary: true }, t, null)
  assert.deepEqual([...runningSegments.map((segment) => segment.key)], ['progress', 'activity'])
  assert.match(runningSegments[0].text, /等待/)
  assert.match(runningSegments[1].text, /运行命令/)

  const completedView = client.deriveTurnView([
    ...entries,
    { type: 'event', event: { type: 'tool/result', seq: 4, time: 3000, data: { turn: 2, message: { source: { callId: 'c1' } } } } },
    { type: 'event', event: { type: 'turn/end', seq: 5, time: 9000, data: { turn: 2, reason: { kind: 'completed' } } } },
  ], 10000)
  const completedStatus = client.turnStatusInfo(completedView, t, false)
  assert.equal(completedStatus.kind, 'done')
  const completedSegments = client.buildTurnSegments(completedView, { progress: true, stallMs: 45000, activity: false, summary: true }, t, { text: '改完测试' })
  assert.deepEqual([...completedSegments.map((segment) => segment.key)], ['progress', 'summary'])
  assert.match(completedSegments[0].text, /用时/)
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
  assert.equal(defaults.stallMs, 600000)

  const configured = client.lineSettings({ value: { recapProgress: false, recapStallSeconds: '90', recapActivity: true, recap: false } })
  assert.equal(configured.progress, false)
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

  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 2 } } },
    { type: 'event', event: { type: 'tool/call', seq: 2, time: 2000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"job_output"}', turn: 2, step: 1 } } },
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
  assert.match(json, /运行命令/)
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

  function renderLine(entries) {
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
    { type: 'event', event: { type: 'tool/call', seq: 2, time: now - 3 * 60000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"job_output"}', turn: 2, step: 1 } } },
  ]
  const line = renderLine(busy)
  assert.ok(line !== null)
  const json = JSON.stringify(line)
  assert.match(json, /data-state":"running/)
  assert.match(json, /进行中/)
  assert.match(json, /等待 10 分/)

  // 同样的长时间运行，只要最近给过正文回复，就不再提示。
  const replied = [...busy, { type: 'event', event: { type: 'assistant/message', seq: 3, time: now - 2 * 60000, data: { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: '先说明一下当前进展' }] } } } }]
  assert.equal(renderLine(replied), null)
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
