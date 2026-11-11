import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBtwPrompt,
  createBtwService,
  extractBtwContext,
  sanitizeAnswer,
  SYSTEM_PROMPT,
} from '../src/btw.js'

function message(role, text, sourceKind) {
  return {
    role,
    content: [{ type: 'text', text }],
    ...(role === 'user' ? { source: { kind: sourceKind ?? 'user' } } : {}),
  }
}

function fakeLlm(output) {
  return {
    calls: 0,
    last: null,
    stream(options) {
      this.calls += 1
      this.last = options
      return (async function* () {
        yield { type: 'text-delta', text: output }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function serviceFor({ messages = [message('user', '主任务'), message('assistant', '进行中')], selection = { provider: 'p', model: 'm' }, llm = fakeLlm('这是旁问的回答。'), sessions } = {}) {
  const session = {
    seq: 1,
    deriveMessages: () => messages,
  }
  const registry = sessions ?? { get: (id) => (id === 'session-1' ? session : undefined) }
  return {
    service: createBtwService({
      sessions: registry,
      agents: () => ({
        get: (id) => (id === 'session-1' && selection ? { model: { current: () => selection } } : undefined),
      }),
      llm: () => llm,
      defaultSelection: () => ({ provider: 'fallback', model: 'fallback' }),
    }),
    session,
    llm,
  }
}

test('btw context only keeps real user and assistant text in a bounded tail', () => {
  const context = extractBtwContext([
    message('user', '注入的上下文', 'context'),
    message('user', '问题一'),
    message('assistant', '回答一'),
    message('user', '问题二'),
    message('assistant', '回答二'),
  ])
  assert.deepEqual(context, [
    { role: 'user', text: '问题一' },
    { role: 'assistant', text: '回答一' },
    { role: 'user', text: '问题二' },
    { role: 'assistant', text: '回答二' },
  ])
})

test('btw prompt includes background and the side question', () => {
  const prompt = buildBtwPrompt('这个报错什么意思？', [
    { role: 'user', text: '跑测试' },
    { role: 'assistant', text: 'EADDRINUSE' },
  ])
  assert.match(prompt, /主对话的最近片段/)
  assert.match(prompt, /助手：EADDRINUSE/)
  assert.match(prompt, /用户的旁问：\n这个报错什么意思？/)
  assert.match(SYSTEM_PROMPT, /不执行主任务/)
})

test('btw prompt omits background when there is no history', () => {
  const prompt = buildBtwPrompt('1+1 等于几？', [])
  assert.doesNotMatch(prompt, /主对话的最近片段/)
  assert.match(prompt, /1\+1 等于几？/)
})

test('sanitizeAnswer strips labels and caps length', () => {
  assert.equal(sanitizeAnswer('回答：先看端口占用。'), '先看端口占用。')
  assert.equal(sanitizeAnswer('   '), null)
  assert.ok(sanitizeAnswer('x'.repeat(9000)).length <= 8001)
})

test('btw service asks the session model without appending a message', async () => {
  const host = serviceFor()
  const result = await host.service.ask('session-1', '  这个报错什么意思？  ', new AbortController().signal)
  assert.deepEqual(result, { answer: '这是旁问的回答。' })
  assert.equal(host.llm.calls, 1)
  assert.equal(host.llm.last.provider, 'p')
  assert.equal(host.llm.last.model, 'm')
  assert.match(host.llm.last.messages[0].content[0].text, /这个报错什么意思？/)
  assert.match(host.llm.last.system, /旁问助手/)
})

test('btw service honors a model chosen for this aside', async () => {
  const host = serviceFor()
  await host.service.ask('session-1', '问题', undefined, { provider: 'picked', model: 'picked-model' })
  assert.equal(host.llm.last.provider, 'picked')
  assert.equal(host.llm.last.model, 'picked-model')
})

test('btw service falls back to the default model when no live agent exists', async () => {
  const llm = fakeLlm('回退回答')
  const service = createBtwService({
    sessions: { get: () => ({ deriveMessages: () => [message('assistant', '你好')] }) },
    agents: () => ({ get: () => undefined }),
    llm: () => llm,
    defaultSelection: () => ({ provider: 'fallback', model: 'fallback' }),
  })
  await service.ask('s1', '问题')
  assert.equal(llm.last.provider, 'fallback')
  assert.equal(llm.last.model, 'fallback')
})

test('btw service rejects empty input, missing sessions and missing models', async () => {
  const host = serviceFor()
  await assert.rejects(host.service.ask('session-1', '   '), { code: 'invalid-params' })
  await assert.rejects(host.service.ask('missing', '问题'), { code: 'not-found' })

  const noModel = createBtwService({
    sessions: { get: () => ({ deriveMessages: () => [] }) },
    agents: () => ({ get: () => undefined }),
    llm: () => fakeLlm('x'),
    defaultSelection: () => null,
  })
  await assert.rejects(noModel.ask('s1', '问题'), { code: 'no-model' })
})

test('btw service turns model failures into a coded error', async () => {
  const host = serviceFor({
    llm: {
      stream() {
        throw new Error('provider down')
      },
    },
  })
  await assert.rejects(host.service.ask('session-1', '问题'), (error) => {
    assert.equal(error.code, 'model-error')
    assert.match(error.message, /旁问失败：provider down/)
    return true
  })
})
