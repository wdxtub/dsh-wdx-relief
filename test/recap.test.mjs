import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRecap,
  buildSummarySystemPrompt,
  countUserTurns,
  createRecapService,
  fallbackSummary,
  generateSummary,
  limitWords,
  readRecapConfig,
  resolveModelCandidates,
  sanitizeSummary,
  similarity,
} from '../src/recap.js'

function fakeStream(text) {
  return (async function* () {
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

function failingStream() {
  return (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'missing credential' } } }
  })()
}

function message(role, text, sourceKind) {
  return {
    role,
    content: [{ type: 'text', text }],
    ...(role === 'user' ? { source: { kind: sourceKind ?? 'user' } } : {}),
  }
}

function config(values = {}) {
  const fields = {
    recap: values.recap,
    recapMinTurns: values.minTurns,
    recapCooldownTurns: values.cooldownTurns,
    recapSimilarityThreshold: values.similarityThreshold,
    recapMaxWords: values.maxWords,
    recapModelChain: values.chain,
  }
  const result = {}
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) result[name] = { get: () => value }
  }
  return result
}

test('recap summarizes the last answered turn as one line', () => {
  const recap = buildRecap([
    message('system', 'prompt'),
    message('user', '注入的上下文', 'context'),
    message('user', '帮我把失败的测试修一下'),
    message('assistant', '已修好 3 个失败用例。下一步：你确认后我再清理临时文件。'),
  ])
  assert.equal(recap.kind, 'answered')
  assert.equal(recap.user, '帮我把失败的测试修一下')
  assert.equal(recap.assistant, '下一步：你确认后我再清理临时文件。')
  assert.equal(recap.question, null)
})

test('recap surfaces a pending question instead of a generic answer', () => {
  const recap = buildRecap([
    message('user', '测试挂了'),
    message('assistant', '我看过了，是 fixture 过期。要我直接改吗？'),
  ])
  assert.equal(recap.kind, 'question')
  assert.equal(recap.question, '要我直接改吗？')
  assert.equal(recap.assistant, null)
})

test('recap reports a user turn that has not been answered', () => {
  const recap = buildRecap([
    message('assistant', '第一轮已经完成。'),
    message('user', '那再跑一次集成测试'),
  ])
  assert.equal(recap.kind, 'waiting')
  assert.equal(recap.user, '那再跑一次集成测试')
  assert.equal(recap.assistant, null)
})

test('recap handles assistant-only history and empty history', () => {
  assert.deepEqual(buildRecap([message('assistant', '只剩一条助手消息。')]), {
    kind: 'assistant',
    user: null,
    assistant: '只剩一条助手消息。',
    question: null,
  })
  assert.equal(buildRecap([]), null)
  assert.equal(buildRecap([message('user', '只有上下文', 'context')]), null)
})

test('recap clips long user and assistant text', () => {
  const recap = buildRecap([
    message('user', '请'.repeat(500)),
    message('assistant', '好'.repeat(500)),
  ])
  assert.ok(recap.user.length <= 121)
  assert.ok(recap.assistant.length <= 181)
  assert.ok(recap.user.endsWith('…'))
  assert.ok(recap.assistant.endsWith('…'))
})

test('user turn count ignores injected context', () => {
  assert.equal(countUserTurns([
    message('user', '注入的上下文', 'context'),
    message('user', '真的问题'),
    message('assistant', '回答'),
    message('user', '再来一个'),
  ]), 2)
})

test('maxWords counts CJK by character and Latin by word', () => {
  assert.equal(limitWords('一二三四五六', 4), '一二三四…')
  assert.equal(limitWords('one two three four', 3), 'one two three…')
  assert.equal(limitWords('修复测试', 40), '修复测试')
  assert.match(buildSummarySystemPrompt(12), /12 个词/)
})

test('similarity is a token-set Jaccard score', () => {
  assert.ok(similarity('修测试，已修好', '修测试，已经修好') > 0.7)
  assert.ok(similarity('修测试', '写文档') < 0.2)
  assert.equal(similarity('', '修测试'), 0)
})

test('recap service caches by turn content and respects the toggle', async () => {
  let messages = [message('user', '测试挂了'), message('assistant', '已修好。')]
  let reads = 0
  const sessions = {
    get: (id) => (id === 's1' ? {
      seq: 1,
      deriveMessages: () => {
        reads += 1
        return messages
      },
    } : undefined),
  }
  const service = createRecapService({
    config: config({ minTurns: 1, cooldownTurns: 1 }),
    sessions,
    llm: { stream: () => fakeStream('修测试，已修好') },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const first = await service.recap('s1')
  assert.equal(first.recap.kind, 'answered')
  assert.equal(first.recap.summary, '修测试，已修好')
  assert.equal(first.turn, 1)
  assert.equal(first.cached, undefined)
  const second = await service.recap('s1')
  assert.equal(second.cached, true)
  assert.equal(reads, 2)

  messages = [message('user', '换个问题'), message('assistant', '新回答。')]
  await service.recap('s1')
  assert.equal(reads, 3)

  const disabled = createRecapService({
    config: config({ recap: false }),
    sessions,
  })
  assert.deepEqual(await disabled.recap('s1'), { recap: null, disabled: true })
})

test('minTurns defers the first summary and cooldownTurns spaces updates', async () => {
  let messages = [message('user', '第一轮'), message('assistant', '一')]
  let calls = 0
  const sessions = {
    get: () => ({ seq: 1, deriveMessages: () => messages }),
  }
  const service = createRecapService({
    config: config({ minTurns: 3, cooldownTurns: 3 }),
    sessions,
    llm: {
      stream: () => {
        calls += 1
        return fakeStream('进度')
      },
    },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })

  const early = await service.recap('s1')
  assert.equal(early.recap, null)
  assert.equal(early.skipped, 'min-turns')
  assert.equal(calls, 0)

  messages = [
    message('user', '第一轮'), message('assistant', '一'),
    message('user', '第二轮'), message('assistant', '二'),
    message('user', '第三轮'), message('assistant', '三'),
  ]
  const first = await service.recap('s1')
  assert.equal(first.recap.summary, '进度')
  assert.equal(calls, 1)

  messages = [...messages, message('user', '第四轮'), message('assistant', '四')]
  const cooled = await service.recap('s1')
  assert.equal(cooled.skipped, 'cooldown')
  assert.equal(cooled.recap.summary, '进度')
  assert.equal(calls, 1)

  messages = [...messages, message('user', '第五轮'), message('assistant', '五')]
  const stillCooled = await service.recap('s1')
  assert.equal(stillCooled.skipped, 'cooldown')
  assert.equal(calls, 1)

  messages = [...messages, message('user', '第六轮'), message('assistant', '六')]
  const refreshed = await service.recap('s1')
  assert.equal(refreshed.skipped, undefined)
  assert.equal(calls, 2)
})

test('similarity gate keeps the displayed line across similar turns', async () => {
  let messages = [message('user', '修测试'), message('assistant', '已修好。')]
  const service = createRecapService({
    config: config({ minTurns: 1, cooldownTurns: 1, similarityThreshold: 0.7 }),
    sessions: { get: () => ({ seq: 1, deriveMessages: () => messages }) },
    llm: { stream: () => fakeStream(messages.length === 2 ? '修测试，已修好' : '修测试，已经修好') },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const first = await service.recap('s1')
  assert.equal(first.recap.summary, '修测试，已修好')

  messages = [message('user', '修测试'), message('assistant', '已修好。'), message('user', '再确认'), message('assistant', '还是好的。')]
  const second = await service.recap('s1')
  assert.equal(second.kept, true)
  assert.equal(second.recap.summary, '修测试，已修好')
})

test('model chain tries configured refs before the default', async () => {
  const tried = []
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'flash', name: 'Flash' }, { id: 'pro', name: 'Pro' }],
    stream(options) {
      tried.push(`${options.provider}/${options.model}`)
      if (options.model === 'missing') return failingStream()
      return fakeStream('便宜模型给的进度')
    },
  }
  const result = await generateSummary({
    llm,
    defaultSelection: () => ({ provider: 'p', model: 'pro' }),
    recap: { user: '修测试', assistant: '已修好', question: null },
    chain: 'p/missing, p/flash',
    maxWords: 40,
  })
  assert.equal(result.text, '便宜模型给的进度')
  assert.equal(result.model, 'flash')
  assert.deepEqual(tried, ['p/missing', 'p/flash'])
})

test('empty chain prefers cheap-looking catalog models before the default', async () => {
  const llm = {
    listProviders: () => [{ id: 'openai' }, { id: 'deepseek' }],
    listModels: async (provider) => provider === 'openai'
      ? [{ id: 'gpt-pro', name: 'GPT Pro' }]
      : [{ id: 'deepseek-v4-flash', name: 'Flash' }],
  }
  const candidates = await resolveModelCandidates({
    llm,
    defaultSelection: () => ({ provider: 'openai', model: 'gpt-pro' }),
    chain: '',
  })
  assert.deepEqual(candidates[0], { provider: 'deepseek', model: 'deepseek-v4-flash' })
  assert.deepEqual(candidates[1], { provider: 'openai', model: 'gpt-pro' })
})

test('readRecapConfig clamps and defaults the advanced fields', () => {
  assert.deepEqual(readRecapConfig(config({ minTurns: 0, cooldownTurns: -1, similarityThreshold: 3, maxWords: 0 })), {
    enabled: true,
    minTurns: 3,
    cooldownTurns: 3,
    similarityThreshold: 0.7,
    maxWords: 40,
    chain: '',
  })
  assert.equal(readRecapConfig(config({ recap: false })).enabled, false)
})

test('summary text drops labels, quotes and over-long output', () => {
  assert.equal(sanitizeSummary('摘要：「修测试 · 已修好」'), '修测试 · 已修好')
  assert.equal(sanitizeSummary('※ recap: 修测试 · 已修好'), '修测试 · 已修好')
  assert.equal(sanitizeSummary('**进度：修测试**'), '修测试')
  assert.equal(sanitizeSummary(''), '')
  assert.ok(sanitizeSummary('长'.repeat(200)).length <= 41)
})

test('fallback summary keeps each side short', () => {
  const text = fallbackSummary({ kind: 'answered', user: '把'.repeat(200), assistant: '好'.repeat(200) })
  assert.ok(text.length <= 105)
  assert.match(text, /…/u)
  assert.equal(fallbackSummary({ kind: 'waiting', user: '再跑一次' }), '再跑一次 · 尚未回复')
})

test('recap falls back to a short join when the model fails', async () => {
  const service = createRecapService({
    config: config({ minTurns: 1, cooldownTurns: 1 }),
    sessions: {
      get: () => ({
        seq: 1,
        deriveMessages: () => [message('user', '把'.repeat(300)), message('assistant', '好'.repeat(300))],
      }),
    },
    llm: { stream: () => (async function* () { throw new Error('boom') })() },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const result = await service.recap('s1')
  assert.match(result.recap.summary, /…/u)
  assert.ok(result.recap.summary.length <= 45)
  assert.equal(result.degraded, true)
})


test('degraded summaries are not cached and retried on the next turn', async () => {
  let messages = [message('user', '修测试'), message('assistant', '已修好。')]
  let attempts = 0
  const service = createRecapService({
    config: config({ minTurns: 1, cooldownTurns: 3 }),
    sessions: { get: () => ({ seq: 1, deriveMessages: () => messages }) },
    llm: {
      stream: () => {
        attempts += 1
        return failingStream()
      },
    },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
    history: { append: () => { throw new Error('degraded recaps must not enter history') } },
  })

  const first = await service.recap('s1')
  assert.equal(first.degraded, true)
  assert.match(first.recap.summary, /修测试/u)
  const afterFirst = attempts
  assert.ok(afterFirst >= 1)

  messages = [...messages, message('user', '再修一次'), message('assistant', '改好了。')]
  const second = await service.recap('s1')
  assert.equal(second.degraded, true)
  assert.ok(attempts > afterFirst)
})
