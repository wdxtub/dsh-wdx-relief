import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPrompt,
  createPredictionService,
  extractConversation,
  sanitizeSuggestion,
  sameMessage,
  SYSTEM_PROMPT,
} from '../src/prediction.js'

function message(role, text, sourceKind) {
  return {
    role,
    content: [{ type: 'text', text }],
    ...(role === 'user' ? { source: { kind: sourceKind ?? 'user' } } : {}),
  }
}

test('extractConversation keeps real user and assistant text only', () => {
  const conversation = extractConversation([
    message('system', 'prompt'),
    message('user', '注入的上下文', 'context'),
    message('user', '帮我把测试跑通'),
    message('assistant', '我会先看失败用例。'),
  ])
  assert.deepEqual(conversation, [
    { role: 'user', text: '帮我把测试跑通' },
    { role: 'assistant', text: '我会先看失败用例。' },
  ])
})

test('extractConversation refuses while the assistant has not settled', () => {
  assert.equal(
    extractConversation([message('user', '开始'), message('assistant', '好'), message('user', '继续')]),
    null,
  )
})

test('extractConversation drops empty assistant messages', () => {
  assert.equal(
    extractConversation([message('user', '开始'), message('assistant', '   ')]),
    null,
  )
})

test('extractConversation keeps the latest turns within the prompt budget', () => {
  const messages = []
  for (let i = 0; i < 20; i += 1) {
    messages.push(message('user', `用户第 ${i} 条 `.repeat(10)))
    messages.push(message('assistant', `助手第 ${i} 条 `.repeat(10)))
  }
  const conversation = extractConversation(messages, { maxMessages: 4, maxPromptChars: 5000 })
  assert.ok(conversation.length <= 4)
  assert.equal(conversation[conversation.length - 1].role, 'assistant')
  assert.ok(buildPrompt(conversation).length <= 5000 + 400)
})

test('buildPrompt names both sides and asks for one line', () => {
  const prompt = buildPrompt([
    { role: 'user', text: '测试失败了' },
    { role: 'assistant', text: '要我修复吗？' },
  ])
  assert.match(prompt, /用户：测试失败了/)
  assert.match(prompt, /助手：要我修复吗？/)
  assert.match(prompt, /只输出/)
  assert.ok(SYSTEM_PROMPT.includes('<none>'))
})

function toolMessage(text, callId, isError = false) {
  return {
    role: 'tool',
    toolCallId: callId,
    source: { kind: 'tool', callId },
    content: [{ type: 'text', text }],
    isError,
  }
}

function questionCall(callId, questions, text = '') {
  return {
    role: 'assistant',
    content: [
      ...(text === '' ? [] : [{ type: 'text', text }]),
      { type: 'tool-call', id: callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) },
    ],
  }
}

const WRITE_QUESTION = [{ id: 'write', question: '要写入这 11 条吗？', options: [{ label: '可以改' }, { label: '先别' }] }]

test('extractConversation restores the question box answer from the tool result', () => {
  const conversation = extractConversation([
    message('user', '先确认再增加'),
    questionCall('c1', WRITE_QUESTION, '我先确认一下。'),
    toolMessage(JSON.stringify({ answers: [{ id: 'write', selected: ['可以改'] }] }), 'c1'),
    message('assistant', '已写入 11 条，备份表在下面。'),
  ])
  assert.deepEqual(conversation, [
    { role: 'user', text: '先确认再增加' },
    { role: 'assistant', text: '我先确认一下。' },
    { role: 'assistant', kind: 'question', text: '要写入这 11 条吗？（选项：可以改、先别）' },
    { role: 'user', kind: 'answer', text: '可以改' },
    { role: 'assistant', text: '已写入 11 条，备份表在下面。' },
  ])
})

test('extractConversation restores a queued user-question reply', () => {
  const reply = {
    role: 'user',
    source: { kind: 'user-question-reply', callId: 'c2', outcome: 'answered' },
    content: [{
      type: 'text',
      text: JSON.stringify({
        kind: 'answer_to_pending_question',
        tool: 'ask_user_question',
        callId: 'c2',
        questions: [{ id: 'apply', question: '要现在应用吗？', options: [{ label: '应用' }, { label: '暂不' }] }],
        answers: [{ id: 'apply', selected: ['暂不'] }],
      }),
    }],
  }
  const conversation = extractConversation([
    message('user', '改完了吗'),
    questionCall('c2', [{ id: 'apply', question: '要现在应用吗？', options: [{ label: '应用' }, { label: '暂不' }] }]),
    reply,
    message('assistant', '那先留在仓库。'),
  ])
  assert.deepEqual(conversation, [
    { role: 'user', text: '改完了吗' },
    { role: 'assistant', kind: 'question', text: '要现在应用吗？（选项：应用、暂不）' },
    { role: 'user', kind: 'answer', text: '暂不' },
    { role: 'assistant', text: '那先留在仓库。' },
  ])
})

test('extractConversation labels the question box exchange in the prompt', () => {
  const prompt = buildPrompt([
    { role: 'user', text: '先确认再增加' },
    { role: 'assistant', kind: 'question', text: '要写入这 11 条吗？（选项：可以改、先别）' },
    { role: 'user', kind: 'answer', text: '可以改' },
    { role: 'assistant', text: '已写入 11 条。' },
  ])
  assert.match(prompt, /助手（提问）：要写入这 11 条吗？/)
  assert.match(prompt, /用户（回答）：可以改/)
  assert.match(prompt, /助手：已写入 11 条。/)
  assert.ok(SYSTEM_PROMPT.includes('用户（回答）'))
})

test('extractConversation folds multi-question answers with their prompts', () => {
  const questions = [
    { id: 'mode', question: '用哪种方式？', options: [{ label: '增量' }, { label: '镜像' }] },
    { id: 'scope', question: '范围呢？', options: [{ label: '只改 repo' }, { label: '含本机' }] },
  ]
  const conversation = extractConversation([
    message('user', '同步一下'),
    questionCall('c3', questions),
    toolMessage(JSON.stringify({ answers: [{ id: 'mode', selected: ['镜像'] }, { id: 'scope', selected: [] }] }), 'c3'),
    message('assistant', '好，镜像同步。'),
  ])
  assert.deepEqual(conversation.slice(1, 3), [
    { role: 'assistant', kind: 'question', text: '用哪种方式？（选项：增量、镜像）；范围呢？（选项：只改 repo、含本机）' },
    { role: 'user', kind: 'answer', text: '用哪种方式？ → 镜像；范围呢？ → 跳过' },
  ])
})

test('extractConversation ignores malformed, failed and duplicate question records', () => {
  const conversation = extractConversation([
    message('user', '开始'),
    questionCall('c4', WRITE_QUESTION),
    toolMessage('not json', 'c4'),
    toolMessage(JSON.stringify({ answers: [{ id: 'write', selected: ['先别'] }] }), 'c4', true),
    message('assistant', '没有拿到答案。'),
    questionCall('c5', WRITE_QUESTION),
    toolMessage(JSON.stringify({ answers: [{ id: 'write', selected: ['可以改'], custom: '但只改 repo' }] }), 'c5'),
    {
      role: 'user',
      source: { kind: 'user-question-reply', callId: 'c5' },
      content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'write', selected: ['先别'] }] }) }],
    },
    message('assistant', '已写入。'),
  ])
  assert.equal(conversation.filter((item) => item.kind === 'answer').length, 1)
  assert.equal(conversation.find((item) => item.kind === 'answer').text, '可以改（补充：但只改 repo）')
  assert.equal(conversation[conversation.length - 1].text, '已写入。')
})

test('sanitizeSuggestion strips labels, quotes and refusals', () => {
  assert.equal(sanitizeSuggestion('预测：修复失败的单元测试。'), '修复失败的单元测试。')
  assert.equal(sanitizeSuggestion('  “修复失败的单元测试”  '), '修复失败的单元测试')
  assert.equal(sanitizeSuggestion('Next: fix the failing test'), 'fix the failing test')
  assert.equal(sanitizeSuggestion('- 好的，继续'), '好的，继续')
  assert.equal(sanitizeSuggestion('第一行\n第二行'), '第一行')
  assert.equal(sanitizeSuggestion('<none>'), null)
  assert.equal(sanitizeSuggestion('无'), null)
  assert.equal(sanitizeSuggestion('抱歉，我无法预测'), null)
  assert.equal(sanitizeSuggestion(''), null)
})

test('sanitizeSuggestion caps the suggestion length', () => {
  const result = sanitizeSuggestion('请'.repeat(100))
  assert.ok(result.length <= 60)
})

test('sameMessage ignores punctuation and whitespace', () => {
  assert.equal(sameMessage('修复测试。', '修复测试'), true)
  assert.equal(sameMessage('修复测试', '重构代码'), false)
  assert.equal(sameMessage('', ''), false)
})

function fakeSession(messages, seq = 1) {
  return {
    seq,
    deriveMessages: () => messages,
  }
}

function fakeLlm(output) {
  return {
    calls: 0,
    stream(options) {
      this.calls += 1
      return (async function* () {
        yield { type: 'text-delta', text: output }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

test('prediction service calls the model once per session.seq', async () => {
  const sessions = new Map()
  sessions.set('s1', fakeSession([message('user', '测试挂了'), message('assistant', '要我修吗？')], 7))
  const llm = fakeLlm('修一下失败的测试')
  const service = createPredictionService({
    config: { enabled: { get: () => true } },
    sessions,
    llm,
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })

  const first = await service.predict('s1')
  assert.deepEqual(first, { suggestion: '修一下失败的测试' })
  const second = await service.predict('s1')
  assert.equal(second.cached, true)
  assert.equal(llm.calls, 1)

  sessions.set('s1', fakeSession([message('user', '测试挂了'), message('assistant', '要我修吗？')], 8))
  await service.predict('s1')
  assert.equal(llm.calls, 2)
})

test('prediction service caches no-suggestion turns without calling the model', async () => {
  const sessions = new Map()
  sessions.set('s1', fakeSession([message('user', '你好')], 1))
  const llm = fakeLlm('不应该被调用')
  const service = createPredictionService({
    config: { enabled: { get: () => true } },
    sessions,
    llm,
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  assert.deepEqual(await service.predict('s1'), { suggestion: null })
  assert.deepEqual(await service.predict('s1'), { suggestion: null, cached: true })
  assert.equal(llm.calls, 0)
})

test('prediction service respects the enabled switch', async () => {
  const llm = fakeLlm('不会调用')
  const service = createPredictionService({
    config: { enabled: { get: () => false } },
    sessions: new Map([['s1', fakeSession([message('user', 'a'), message('assistant', 'b')])]]),
    llm,
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  assert.deepEqual(await service.predict('s1'), { suggestion: null, disabled: true })
  assert.equal(llm.calls, 0)
})

test('prediction service refuses to echo the last user message', async () => {
  const service = createPredictionService({
    config: { enabled: { get: () => true } },
    sessions: new Map([['s1', fakeSession([message('user', '修复测试。'), message('assistant', '好')])]]),
    llm: fakeLlm('修复测试'),
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  assert.deepEqual(await service.predict('s1'), { suggestion: null })
})

test('prediction service merges concurrent calls for the same turn', async () => {
  let resolve
  const gate = new Promise((done) => { resolve = done })
  const service = createPredictionService({
    config: { enabled: { get: () => true } },
    sessions: new Map([['s1', fakeSession([message('user', 'a'), message('assistant', 'b')])]]),
    llm: {
      calls: 0,
      async *stream() {
        this.calls += 1
        await gate
        yield { type: 'text-delta', text: '继续' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const a = service.predict('s1')
  const b = service.predict('s1')
  resolve()
  assert.deepEqual(await a, { suggestion: '继续' })
  assert.deepEqual(await b, { suggestion: '继续' })
})

test('prediction service uses the lowest reasoning effort and caches the route lookup', async () => {
  let resolved = 0
  const seen = []
  const sessions = new Map([
    ['s1', fakeSession([message('user', 'a'), message('assistant', 'b')])],
    ['s2', fakeSession([message('user', 'c'), message('assistant', 'd')])],
  ])
  const service = createPredictionService({
    config: { enabled: { get: () => true } },
    sessions,
    llm: {
      async resolveModelInfo() {
        resolved += 1
        return { reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] } }
      },
      stream(options) {
        seen.push(options)
        return (async function* () {
          yield { type: 'text-delta', text: '继续' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    defaultSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }),
  })
  await service.predict('s1')
  await service.predict('s2')
  assert.equal(resolved, 1)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].reasoningEffort, 'minimal')
  assert.equal(seen[1].reasoningEffort, 'minimal')
})
