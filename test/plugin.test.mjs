import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { Config, ROUTE_PATH, apply, inject, name } from '../index.js'

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
  let route = null
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
      return undefined
    },
    connection: {
      fetch: {
        register(options) {
          route = options
          return () => {}
        },
      },
    },
  }
  return { ctx, route: () => route, llmCalls: () => llmCalls }
}

function request(body) {
  return new Request(`http://127.0.0.1${ROUTE_PATH}`, {
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
  assert.equal(config.verbosity.get(), 'low')
  assert.equal(config.writingStyle.get(), false)
  assert.equal(config.baseStyle.get(), 'default')
  assert.equal(config.customInstructions.get(), '')
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
  assert.deepEqual([...client.inject], ['slots', 'configForms', 'locale'])

  const registrations = []
  const locales = []
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { enabled: true }, writable: true }),
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
    'conversation.input.overlay',
    'plugins.bundle.config',
  ])

  const overlay = registrations[0].options
  assert.equal(overlay.id, 'wdx-prediction')
  assert.equal(overlay.locale, 'wdx-relief')
  assert.equal(overlay.inject('session-1').hooks.settings.getSnapshot().value.enabled, true)

  const config = registrations[1].options
  assert.equal(config.key, 'dsh-wdx-relief')
  assert.equal(config.locale, 'wdx-relief')
  assert.equal(typeof registrations[1].component, 'function')
  const injected = config.inject()
  const settings = injected.hooks.settings.getSnapshot()
  assert.equal(settings.enabled.text, 'true')
  assert.equal(settings.verbosity.text, 'low')
  assert.equal(settings.actionable.text, 'true')
  assert.equal(settings.style.text, 'default')
  assert.equal(settings.customInstructions.text, '')
  assert.equal(typeof injected.edit, 'function')
  assert.equal(typeof injected.save, 'function')
  assert.equal(typeof injected.discard, 'function')
})