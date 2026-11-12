import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { BTW_PATH, Config, DISMISS_PATH, RECAP_PATH, RECAPS_PATH, RESTORE_PATH, ROUTE_PATH, TODAY_PATH, apply, inject, name } from '../index.js'

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
    seq: 3,
    deriveMessages: () => [userMessage('测试挂了'), assistantMessage('要我修吗？')],
  }
  const routes = new Map()
  let llmCalls = 0
  const ctx = {
    sessions: { get: (id) => (id === 'session-1' ? session : undefined) },
    effect: (fn) => fn(),
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
    route: (path = ROUTE_PATH) => routes.get(path),
    llmCalls: () => llmCalls,
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

function request(body, path = ROUTE_PATH) {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('host plugin declares its route and config', () => {
  assert.equal(name, 'wdx-relief')
  assert.deepEqual(inject, ['connection', 'sessions'])
  const config = Config({})
  assert.equal(config.enabled.get(), true)
  assert.equal(config.recap.get(), true)
  assert.equal(config.recapActivity.get(), false)
  assert.equal(config.recapTiming.get(), false)
  assert.equal(config.recapReasoning.get(), false)
  assert.equal(config.recapPlacement.get(), 'above')
  assert.equal(config.recapMinTurns.get(), 3)
  assert.equal(config.recapCooldownTurns.get(), 3)
  assert.equal(config.recapSimilarityThreshold.get(), 0.7)
  assert.equal(config.recapMaxWords.get(), 40)
  assert.equal(config.recapModelChain.get(), '')
  assert.equal(config.today.get(), true)
  assert.equal(config.verbosity.get(), 'low')
  assert.equal(config.writingStyle.get(), false)
  assert.equal(config.baseStyle.get(), 'default')
  assert.equal(config.customInstructions.get(), '')
})

test('today route degrades to unavailable without a session query service', async () => {
  const host = createHostContext()
  apply(host.ctx, { today: { get: () => true } })
  const route = host.route(TODAY_PATH)
  assert.equal(route.path, TODAY_PATH)
  const response = await route.fetch(request({ sessionId: 'session-1' }, TODAY_PATH))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, data: { items: [], unavailable: true } })
})

test('dismiss and restore routes record cleared follow-ups', async () => {
  const host = createHostContext()
  apply(host.ctx, { today: { get: () => true } })

  const dismiss = host.route(DISMISS_PATH)
  assert.equal(dismiss.path, DISMISS_PATH)
  assert.deepEqual(dismiss.methods, ['POST'])

  const cleared = await dismiss.fetch(request({ sessionId: 'session-1', text: '把 tag 推到远端' }, DISMISS_PATH))
  assert.equal(cleared.status, 200)
  assert.deepEqual(await cleared.json(), { ok: true, data: { changed: true } })

  const again = await dismiss.fetch(request({ sessionId: 'session-1', text: '把 tag 推到远端' }, DISMISS_PATH))
  assert.deepEqual(await again.json(), { ok: true, data: { changed: false } })

  const stored = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'wdx-relief', 'followups.json'), 'utf8'))
  assert.equal(stored.entries.length, 1)
  assert.equal(stored.entries[0].text, '把 tag 推到远端')

  const restore = host.route(RESTORE_PATH)
  const restored = await restore.fetch(request({ sessionId: 'session-1', text: '把 tag 推到远端' }, RESTORE_PATH))
  assert.deepEqual(await restored.json(), { ok: true, data: { changed: true } })

  const empty = await restore.fetch(request({ sessionId: 'session-1', text: '把 tag 推到远端' }, RESTORE_PATH))
  assert.deepEqual(await empty.json(), { ok: true, data: { changed: false } })

  const invalid = await dismiss.fetch(request({ text: '把 tag 推到远端' }, DISMISS_PATH))
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).ok, false)
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
    createElement() {},
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
    getSnapshot: () => ({ status: 'ready', value: { enabled: true, recap: true, today: true }, writable: true }),
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
      openTab: (kind) => { openedTabs.push(kind) },
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
    'sidebar.right.pane.tab',
    'conversation.input.overlay',
    'conversation.input.dock',
    'conversation.composer.dock',
    'plugins.bundle.config',
  ])
  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].id, 'wdx-relief')
  assert.equal(tabTypes[0].kind, 'wdx-relief')
  assert.equal(tabTypes[0].priority, 'extension')
  assert.equal(typeof tabTypes[0].title, 'function')
  assert.equal(tabTypes[0].guide[0].order, 35)
  assert.equal(registrations[0].options.key, 'wdx-relief')
  assert.equal(typeof registrations[0].component, 'function')

  const overlay = registrations[1].options
  assert.equal(overlay.id, 'wdx-prediction')
  assert.equal(overlay.locale, 'wdx-relief')
  assert.equal(overlay.inject('session-1').hooks.settings.getSnapshot().value.enabled, true)

  const recap = registrations[2].options
  assert.equal(recap.id, 'wdx-turn-line-above')
  assert.equal(recap.order, 30)
  assert.equal(recap.inject('session-1').placement, 'above')
  assert.equal(recap.inject('session-1').hooks.settings.getSnapshot().value.recap, true)

  const recapBelow = registrations[3].options
  assert.equal(recapBelow.id, 'wdx-turn-line-below')
  assert.equal(recapBelow.order, 30)
  assert.equal(recapBelow.inject('session-1').placement, 'below')

  assert.equal(typeof client.BtwSection, 'function')

  const config = registrations[4].options
  assert.equal(config.key, 'dsh-wdx-relief')
  assert.equal(config.locale, 'wdx-relief')
  assert.equal(typeof registrations[4].component, 'function')
  const injected = config.inject()
  const settings = injected.hooks.settings.getSnapshot()
  assert.equal(settings.enabled.text, 'true')
  assert.equal(settings.recap.text, 'true')
  assert.equal(typeof settings.recapActivity.text, 'string')
  assert.equal(typeof settings.recapTiming.text, 'string')
  assert.equal(typeof settings.recapReasoning.text, 'string')
  assert.equal(settings.recapPlacement.text, 'above')
  assert.equal(settings.recapMinTurns.text, '3')
  assert.equal(settings.recapCooldownTurns.text, '3')
  assert.equal(settings.recapSimilarityThreshold.text, '0.7')
  assert.equal(settings.recapMaxWords.text, '40')
  assert.equal(settings.recapModelChain.text, '')
  assert.equal(settings.today.text, 'true')
  assert.equal(settings.verbosity.text, 'low')
  assert.equal(settings.actionable.text, 'true')
  assert.equal(settings.style.text, 'default')
  assert.equal(settings.customInstructions.text, '')
  assert.equal(typeof injected.edit, 'function')
  assert.equal(typeof injected.save, 'function')
  assert.equal(typeof injected.discard, 'function')

  assert.deepEqual([...client.RECAP_PLACEMENTS], ['above', 'below'])
  assert.equal(client.formatDuration(12000), '12s')
  assert.equal(client.formatDuration(65000), '1m 05s')
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
test('turn line derives activity, timing and reasoning from the event window', () => {
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

  const segments = client.buildTurnSegments(view, { activity: true, timing: true, reasoning: true, summary: true }, (key) => (key === 'turn.verb.read' ? '读取' : key), { text: '修测试，已修好' })
  assert.deepEqual([...segments.map((segment) => segment.key)], ['activity', 'time', 'reasoning', 'summary'])
  assert.match(segments[0].text, /读取 README\.md/)
  assert.equal(segments[1].text, '8s')

  const localOnly = client.buildTurnSegments(view, { activity: true, timing: false, reasoning: false, summary: false }, (key) => key, null)
  assert.deepEqual([...localOnly.map((segment) => segment.key)], ['activity'])
})

test('relief panel renders today and btw sections without a live sidebar', () => {
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
  const panel = client.ReliefPanel({ sessionId: 'session-1', t, openSession() {} })
  assert.equal(panel.type, 'div')
  assert.equal(panel.props.className, 'wdxp-page')
  assert.equal(typeof panel.children[0][0].type, 'function')
  var tabs = panel.children[0][1]
  assert.equal(tabs.type, 'div')
  assert.equal(tabs.props.role, 'tablist')
  var tabButtons = tabs.children[0]
  assert.equal(tabButtons.length, 4)
  assert.equal(tabButtons[1].props.id, 'wdxp-tab-recaps')
  assert.equal(panel.children[0][2].props.id, 'wdxp-pane-untouched')
  assert.equal(panel.children[0][3].props.id, 'wdxp-pane-recaps')
  assert.equal(panel.children[0][3].children[0], null)
  assert.equal(panel.children[0][4].children[0].type, client.BtwSection)

  const recaps = client.RecapHistorySection({ sessionId: 'session-1', t })
  assert.equal(recaps.type, 'div')
  assert.equal(recaps.props.className, 'wdxp-body')

  const btw = client.BtwSection({ sessionId: 'session-1', t })
  assert.equal(btw.type, 'div')
  assert.equal(btw.children[0][0].type, 'div')
})

test('relief panel renders ready items without a missing helper', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  let stateCalls = 0
  const react = {
    createElement(type, props, ...children) { return { type, props, children } },
    useState(initial) {
      stateCalls += 1
      if (stateCalls === 2) {
        return [{
          status: 'ready',
          items: [{ text: '需要你确认', sessionId: 'session-1', idleHours: 3 }],
          degraded: false,
          detail: '',
        }, () => {}]
      }
      return [initial, () => {}]
    },
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
  const panel = client.ReliefPanel({ sessionId: 'session-1', t, openSession() {} })
  const json = JSON.stringify(panel)
  assert.match(json, /需要你确认/)
  assert.match(json, /3 小时/)
  assert.match(json, /wdxp-follow/)
  assert.match(json, /wdxp-clear/)
  assert.match(json, /清掉，不再出现在列表里/)
  assert.doesNotMatch(json, /wdxp-undo/)
})

test('relief panel offers undo after an item is cleared', () => {
  const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = { window: { __ModuleLoader__: { load(spec) { loaded = spec } } }, console, setTimeout, clearTimeout, AbortController }
  runInNewContext(code, sandbox)

  let stateCalls = 0
  const react = {
    createElement(type, props, ...children) { return { type, props, children } },
    useState(initial) {
      stateCalls += 1
      if (stateCalls === 2) {
        return [{
          status: 'empty',
          items: [],
          degraded: false,
          detail: '',
          lastCleared: { text: '需要你确认', sessionId: 'session-1' },
          clearError: '',
        }, () => {}]
      }
      return [initial, () => {}]
    },
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
  const panel = client.ReliefPanel({ sessionId: 'session-1', t, openSession() {} })
  const json = JSON.stringify(panel)
  assert.match(json, /wdxp-undo/)
  assert.match(json, /已清掉这条/)
  assert.match(json, /撤销/)
  assert.match(json, /最近两周没有待你决定的事/)
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
