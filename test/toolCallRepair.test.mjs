import test from 'node:test'
import assert from 'node:assert/strict'

import { installToolCallRepair } from '../src/toolCallRepair.js'

const invoke = '<invoke name="write">'
const invokeEnd = '</invoke>'
const param = '<parameter name="content">'
const paramEnd = '</parameter>'

function strataLeak() {
  return `已完成，用时1分18秒\n<tool_call> <function=read> <parameter=path> src/sync.js </parameter> </function> </tool_call>`
}

function assistantEvent(text, seq, turn = 1, step = 1) {
  return {
    type: 'assistant/message',
    seq,
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  }
}

/**
 * Minimal host context: records listeners and provides the tools registry stub.
 * `configValues` is read live on every event.
 */
function createHarness(configValues = {}) {
  const listeners = new Map()
  const ctx = {
    tools: { get() {} },
    effect(fn) {
      return fn()
    },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {}
    },
  }
  const readConfig = () => ({
    enabled: configValues.enabled !== false,
    lang: 'zh',
    maxCorrectionsPerTurn: 2,
    ...configValues,
  })
  installToolCallRepair(ctx, readConfig, () => {})
  return {
    call(name, thisArg, ...args) {
      const list = listeners.get(name) || []
      return list.length === 1 ? list[0].apply(thisArg, args) : list.map((l) => l.apply(thisArg, args))
    },
    count(name) {
      return (listeners.get(name) || []).length
    },
  }
}

test('registers one listener per repair mechanism', () => {
  const harness = createHarness()
  for (const name of ['tools/pre-execute', 'tools/post-execute', 'session/event', 'agent/turn-stopping', 'agent/pre-step']) {
    assert.equal(harness.count(name), 1, name)
  }
})

test('M4 injects a correction in the same turn, escalates once, then stops', async () => {
  const harness = createHarness({ maxCorrectionsPerTurn: 2 })
  const session = { id: 's1' }
  const injected = []
  const agent = {
    id: 's1',
    inject(message) {
      injected.push(message)
    },
  }

  harness.call('session/event', session, session, assistantEvent(strataLeak(), 1))
  await harness.call('agent/turn-stopping', null, { agent, turn: 1 })
  assert.equal(injected.length, 1)
  assert.equal(injected[0].role, 'user')
  assert.equal(injected[0].source.kind, 'runtime-context')
  assert.match(injected[0].content[0].text, /立即执行/)

  // A second damaged step in the SAME turn gets the harder second-tier text.
  harness.call('session/event', session, session, assistantEvent(strataLeak(), 2))
  await harness.call('agent/turn-stopping', null, { agent, turn: 1 })
  assert.equal(injected.length, 2)
  assert.match(injected[1].content[0].text, /第二次尝试仍失败/)

  // Bounded: a third correction in the same turn never fires.
  harness.call('session/event', session, session, assistantEvent(strataLeak(), 3))
  await harness.call('agent/turn-stopping', null, { agent, turn: 1 })
  assert.equal(injected.length, 2)

  // A later turn starts with a fresh budget.
  harness.call('session/event', session, session, assistantEvent(strataLeak(), 4, 2))
  await harness.call('agent/turn-stopping', null, { agent, turn: 2 })
  assert.equal(injected.length, 3)
})

test('healthy steps and real tool calls are left alone', async () => {
  const harness = createHarness()
  const session = { id: 's2' }
  const injected = []
  const agent = { id: 's2', inject: (m) => injected.push(m) }

  harness.call('session/event', session, session, assistantEvent('已经写完，回读确认过。', 1))
  await harness.call('agent/turn-stopping', null, { agent, turn: 1 })
  assert.equal(injected.length, 0)

  // A step that did produce a tool-call block is not a silent failure even when
  // its prose also carries leaked markup.
  harness.call('session/event', session, session, {
    type: 'assistant/message',
    seq: 2,
    data: {
      turn: 2,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: strataLeak() },
          { type: 'tool-call', id: 'c1', name: 'read', arguments: { path: 'src/sync.js' } },
        ],
      },
    },
  })
  await harness.call('agent/turn-stopping', null, { agent, turn: 2 })
  assert.equal(injected.length, 0)
})

test('a damaged step cancels any pending correction for the same turn', async () => {
  const harness = createHarness()
  const session = { id: 's3' }
  const injected = []
  const agent = { id: 's3', inject: (m) => injected.push(m) }

  harness.call('session/event', session, session, assistantEvent(strataLeak(), 1))
  harness.call('session/event', session, session, assistantEvent('继续处理下一个文件。', 2))
  await harness.call('agent/turn-stopping', null, { agent, turn: 1 })
  assert.equal(injected.length, 0)
})

test('disabling the feature registers listeners but never acts', async () => {
  const harness = createHarness({ enabled: false })
  const session = { id: 's4' }
  const injected = []
  const agent = { id: 's4', inject: (m) => injected.push(m) }

  harness.call('session/event', session, session, assistantEvent(strataLeak(), 1))
  await harness.call('agent/turn-stopping', null, { agent, turn: 1 })
  assert.equal(injected.length, 0)
})

test('M2 denies an emptied required-argument call', () => {
  const harness = createHarness()
  const tools = {}
  const exec = {
    name: 'write_file',
    arguments: {},
    schema: { parameters: { required: ['path'] } },
  }
  const decision = harness.call('tools/pre-execute', tools, exec, () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /未执行/)

  const okExec = { name: 'write_file', arguments: { path: 'a.txt' }, schema: exec.schema }
  const allowed = harness.call('tools/pre-execute', tools, okExec, () => ({ kind: 'allow' }))
  assert.deepEqual(allowed, { kind: 'allow' })
})

test('M2 denies a large structurally multiplied payload but passes small ones through', () => {
  const harness = createHarness()
  const tools = {}
  const big = `${invoke}${param}${'x'.repeat(2500)}${paramEnd}${invokeEnd}${invokeEnd}`
  const denied = harness.call(
    'tools/pre-execute',
    tools,
    { name: 'write', arguments: { content: big } },
    () => ({ kind: 'allow' }),
  )
  assert.equal(denied.kind, 'deny')

  const small = `${invoke}${param}x${paramEnd}${invokeEnd}${invokeEnd}`
  const passed = harness.call(
    'tools/pre-execute',
    tools,
    { name: 'write', arguments: { content: small } },
    () => ({ kind: 'allow' }),
  )
  assert.deepEqual(passed, { kind: 'allow' })
})

test('M3 adds a no-op note only for write-like tools', async () => {
  const harness = createHarness()
  const exec = { name: 'write_file', arguments: { path: 'a.txt', content: 'x'.repeat(40) } }
  const result = { isError: false, value: { written: 0 } }

  const withNote = await harness.call(
    'tools/post-execute',
    null,
    exec,
    result,
    async () => ({ kind: 'accept', additionalContexts: [] }),
  )
  assert.equal(withNote.additionalContexts.length, 1)
  assert.equal(withNote.additionalContexts[0].role, 'user')

  const readerExec = { name: 'read', arguments: { path: 'a.txt' } }
  const untouched = await harness.call(
    'tools/post-execute',
    null,
    readerExec,
    result,
    async () => ({ kind: 'accept', additionalContexts: [] }),
  )
  assert.equal(untouched.additionalContexts.length, 0)
})

test('M7 briefs a forked session once before its first step', async () => {
  const harness = createHarness()
  const agent = { id: 'fork-1', session: { header: { parentSession: 'parent-1' } } }
  const enter = () => ({ kind: 'enter', messages: [] })

  const first = await harness.call('agent/pre-step', null, { agent, turn: 0, step: 0 }, enter)
  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 1)
  assert.match(first.messages[0].content[0].text, /会话简报/)

  const second = await harness.call('agent/pre-step', null, { agent, turn: 0, step: 1 }, enter)
  assert.equal(second.messages.length, 0)

  const plainAgent = { id: 'plain-1', session: { header: { isSeeded: false } } }
  const plain = await harness.call('agent/pre-step', null, { agent: plainAgent, turn: 0, step: 0 }, enter)
  assert.equal(plain.messages.length, 0)
})

test('M9 shadows a damaged step on the model-visible surface and self-tests first', async () => {
  const harness = createHarness()
  const events = [
    { type: 'user/message', seq: 0, data: { message: { role: 'user', content: [] } } },
    assistantEvent(strataLeak(), 1),
  ]
  const nodes = [0, 1]
  let nextSeq = events.length
  const log = events.slice()
  const session = {
    id: 's9',
    append(type, data, options = {}) {
      const seq = nextSeq
      nextSeq += 1
      log.push({ type, data, seq })
      const op = options.surfaceOp
      if (op === 'append') nodes.push(seq)
      else if (op && op.op === 'replace') {
        for (let s = op.startSeq; s <= op.endSeq; s += 1) {
          const at = nodes.indexOf(s)
          if (at >= 0) nodes.splice(at, 1)
        }
        nodes.push(seq)
      }
      return { seq }
    },
    eventAt(seq) {
      return log[seq]
    },
    isOwnSeq(seq) {
      return seq >= 0 && seq < nextSeq
    },
    get seq() {
      return nextSeq
    },
  }
  Object.defineProperty(session, 'surface', { get: () => ({ nodes }) })

  const injected = []
  const agent = { id: 's9', session, inject: (m) => injected.push(m) }
  await harness.call('agent/turn-stopping', null, { agent, turn: 1 })

  assert.equal(nodes.includes(1), false, 'damaged node must leave the surface')
  assert.ok(nodes.some((seq) => seq > 1), 'the replacement note must be on the surface')
  // The probe node is replaced by its own swap, so no stray probe remains either.
  assert.equal(nodes.filter((seq) => seq === 2).length, 0)
})
