import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProgressPrompt,
  buildProgressSystemPrompt,
  buildRecap,
  buildSummarySystemPrompt,
  countUserTurns,
  createRecapService,
  fallbackSummary,
  generateSummary,
  limitWords,
  looksLikeCommand,
  readRecapConfig,
  resolveModelCandidates,
  sanitizeSummary,
  similarity,
  trimUnfinished,
  unfinishedEnding,
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

test('recapCaptured summarizes the captured turn even after the session moved on', async () => {
  let calls = 0
  const service = createRecapService({
    config: config({ minTurns: 1, cooldownTurns: 1 }),
    // 会话已经进入下一轮：deriveMessages 只看得到第二轮。
    sessions: { get: () => ({ seq: 9, deriveMessages: () => [message('user', '第二轮'), message('assistant', '二')] }) },
    llm: {
      stream: () => {
        calls += 1
        return fakeStream('第一轮的摘要')
      },
    },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })

  const captured = { turn: 1, recap: { kind: 'answered', user: '第一轮', assistant: '一', question: null } }
  const result = await service.recapCaptured('s1', captured)
  assert.equal(result.turn, 1)
  assert.equal(result.recap.summary, '第一轮的摘要')
  assert.equal(calls, 1)

  // 客户端随后请求同一轮时命中缓存，不再调模型。
  const again = await service.recapCaptured('s1', captured)
  assert.equal(again.cached, true)
  assert.equal(calls, 1)

  await assert.rejects(() => service.recapCaptured('s1', { turn: 0, recap: null }), (error) => error.code === 'invalid-params')
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
  const appended = []
  const service = createRecapService({
    config: config({ minTurns: 1, cooldownTurns: 1, similarityThreshold: 0.7 }),
    sessions: { get: () => ({ seq: 1, deriveMessages: () => messages }) },
    llm: { stream: () => fakeStream(messages.length === 2 ? '修测试，已修好' : '修测试，已经修好') },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
    history: { append: (entry) => { appended.push(entry); return true } },
  })
  const first = await service.recap('s1')
  assert.equal(first.recap.summary, '修测试，已修好')
  assert.equal(appended.length, 1)
  assert.equal(appended[0].turn, 1)

  messages = [message('user', '修测试'), message('assistant', '已修好。'), message('user', '再确认'), message('assistant', '还是好的。')]
  const second = await service.recap('s1')
  assert.equal(second.kept, true)
  assert.equal(second.recap.summary, '修测试，已修好')
  // 文字沿用了上一轮，但第二轮仍然有自己的历史记录。
  assert.equal(appended.length, 2)
  assert.equal(appended[1].turn, 2)
  assert.equal(appended[1].summary, '修测试，已修好')
  assert.equal(appended[1].user, '再确认')
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
    minTurns: 1,
    cooldownTurns: 1,
    similarityThreshold: 0.9,
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

test('unfinishedEnding flags half sentences but keeps complete one-liners', () => {
  assert.equal(unfinishedEnding('解释 QIG；已说明其为临时自造缩写，表前缀已替换，待'), true)
  assert.equal(unfinishedEnding('正在读文件，'), true)
  assert.equal(unfinishedEnding('修测试，已修好'), false)
  assert.equal(unfinishedEnding('发布 0.4.0，待确认'), false)
  assert.equal(unfinishedEnding('改完了。'), false)
  assert.equal(unfinishedEnding('好了'), false)
  assert.equal(unfinishedEnding(''), false)
})

test('trimUnfinished cuts at the last clause boundary', () => {
  assert.equal(trimUnfinished('解释 QIG；表前缀已替换，待'), '解释 QIG；表前缀已替换…')
  assert.equal(trimUnfinished('没有边界'), '没有边界')
  assert.equal(trimUnfinished(''), '')
})

test('generateSummary retries once when the model stops mid-sentence', async () => {
  const calls = []
  const llm = {
    stream() {
      calls.push(1)
      return fakeStream(calls.length === 1 ? '确认改名并替换表前缀，待' : '确认改名并替换表前缀，待你拍板')
    },
  }
  const result = await generateSummary({
    llm,
    defaultSelection: () => ({ provider: 'p', model: 'fast' }),
    recap: { user: '改名', assistant: '待确认', question: null },
    maxWords: 40,
  })
  assert.equal(calls.length, 2)
  assert.equal(result.text, '确认改名并替换表前缀，待你拍板')
})

test('generateSummary fragments the sentence when retries also stop mid-way', async () => {
  const calls = []
  const llm = {
    stream() {
      calls.push(1)
      return fakeStream('确认改名并替换表前缀，待')
    },
  }
  const result = await generateSummary({
    llm,
    defaultSelection: () => ({ provider: 'p', model: 'fast' }),
    recap: { user: '改名', assistant: '待确认', question: null },
    maxWords: 40,
  })
  assert.equal(calls.length, 2)
  assert.equal(result.text, '确认改名并替换表前缀…')
})

test('generateSummary rejects a stream that never finishes', async () => {
  let calls = 0
  const llm = {
    stream() {
      calls += 1
      return (async function* () {
        yield { type: 'text-delta', text: '只有半句' }
      })()
    },
  }
  const result = await generateSummary({
    llm,
    defaultSelection: () => ({ provider: 'p', model: 'fast' }),
    recap: { user: '改名', assistant: '待确认', question: null },
    maxWords: 40,
  })
  assert.equal(calls, 1)
  assert.equal(result, null)
})

test('defaults refresh the summary on every new turn', async () => {
  let messages = [
    message('user', '第一轮'), message('assistant', '一'),
    message('user', '第二轮'), message('assistant', '二'),
    message('user', '第三轮'), message('assistant', '三'),
  ]
  let calls = 0
  const service = createRecapService({
    config: config({}),
    sessions: { get: () => ({ seq: 1, deriveMessages: () => messages }) },
    llm: {
      stream: () => {
        calls += 1
        return fakeStream(calls === 1 ? '进度一' : '进度二')
      },
    },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })

  const first = await service.recap('s1')
  assert.equal(first.recap.summary, '进度一')
  assert.equal(calls, 1)

  messages = [...messages, message('user', '第四轮'), message('assistant', '四')]
  const next = await service.recap('s1')
  assert.equal(next.skipped, undefined)
  assert.equal(next.recap.summary, '进度二')
  assert.equal(calls, 2)
})


test('progress prompt asks for the interval idea, not commands', () => {
  const prompt = buildProgressPrompt({
    goal: '把迁移脚本改成按时间窗刷新',
    previous: '先定位了旧标签的写入点',
    fromMinute: 11,
    toMinute: 20,
    reasoning: '先确认 JOB 刷新会不会覆盖手工改动，再决定迁移粒度',
    actions: ['修改 migrate.js', '运行命令 ×2'],
    replies: '正在验证',
  })
  assert.match(prompt, /时间窗：第 11–20 分钟（本轮累计到第 20 分钟）/)

  const cumulative = buildProgressPrompt({ fromMinute: 1, newFromMinute: 11, toMinute: 20 })
  assert.match(cumulative, /时间窗：第 1–20 分钟（本条新增第 11–20 分钟）/)
  assert.match(prompt, /本轮目标：把迁移脚本改成按时间窗刷新/)
  assert.match(prompt, /此前进展：先定位了旧标签的写入点/)
  assert.match(prompt, /先确认 JOB 刷新会不会覆盖手工改动/)
  assert.match(prompt, /修改 migrate\.js/)
  assert.match(buildProgressSystemPrompt(80), /不要罗列命令、参数、文件路径或工具名/)
})

test('summarizeProgress builds the interval prompt and uses the model text', async () => {
  const calls = []
  const service = createRecapService({
    config: config(),
    sessions: { get: () => ({ seq: 3, deriveMessages: () => [message('user', '把迁移脚本改成按时间窗刷新')] }) },
    llm: () => ({
      stream: (options) => {
        calls.push(options)
        return fakeStream('先确认刷新会覆盖哪些手工改动，再按时间窗整批迁移。')
      },
    }),
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
    history: { list: () => [], append: () => true },
  })
  const result = await service.summarizeProgress('s1', {
    turn: 2,
    bucket: 2,
    anchor: 0,
    windowMs: 600000,
    digest: { reasoning: '先确认 JOB 刷新会不会覆盖手工改动', actions: ['修改 migrate.js'], replies: '' },
  })
  assert.equal(result.summary, '先确认刷新会覆盖哪些手工改动，再按时间窗整批迁移。')
  assert.equal(calls.length, 1)
  assert.match(calls[0].messages[0].content[0].text, /时间窗：第 11–20 分钟（本轮累计到第 20 分钟）/)
  assert.match(calls[0].messages[0].content[0].text, /本轮目标：把迁移脚本改成按时间窗刷新/)
})

test('summarizeProgress respects the recap toggle and missing sessions', async () => {
  let calls = 0
  const disabled = createRecapService({
    config: config({ recap: false }),
    sessions: { get: () => ({ seq: 1, deriveMessages: () => [] }) },
    llm: () => ({ stream: () => { calls += 1; return fakeStream('x') } }),
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await disabled.summarizeProgress('s1', { turn: 1, bucket: 1, windowMs: 600000, digest: { reasoning: 'x' } }), null)
  assert.equal(calls, 0)

  const missing = createRecapService({
    config: config(),
    sessions: { get: () => undefined },
    llm: () => ({ stream: () => { calls += 1; return fakeStream('x') } }),
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await missing.summarizeProgress('s1', { turn: 1, bucket: 1, windowMs: 600000, digest: { reasoning: 'x' } }), null)
  assert.equal(calls, 0)

  const empty = createRecapService({
    config: config(),
    sessions: { get: () => ({ seq: 1, deriveMessages: () => [] }) },
    llm: () => ({ stream: () => { calls += 1; return fakeStream('x') } }),
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await empty.summarizeProgress('s1', { turn: 1, bucket: 1, windowMs: 600000, digest: { reasoning: '', actions: [], replies: '' } }), null)
  assert.equal(calls, 0)
})


test('progress prompt follows the UI language and rejects command-shaped output', () => {
  const englishSystem = buildProgressSystemPrompt(80, 'en')
  assert.match(englishSystem, /Do not list commands/)
  assert.match(englishSystem, /at most 80 words/)
  const englishPrompt = buildProgressPrompt({
    goal: 'migrate the script by time window',
    fromMinute: 11,
    toMinute: 20,
    reasoning: 'check the JOB refresh first',
    actions: ['Edit migrate.js', 'Run command x2'],
  }, 'en')
  assert.match(englishPrompt, /Window: minute 11-20/)
  assert.match(englishPrompt, /Actions: Edit migrate\.js; Run command x2/)

  assert.equal(looksLikeCommand('运行 npm test --watch 验证'), true)
  assert.equal(looksLikeCommand('改的是 /Users/someone/project 里的文件'), true)
  assert.equal(looksLikeCommand('先确认刷新会覆盖哪些手工改动，再按时间窗迁移。'), false)
})

test('summarizeProgress drops a command-shaped model answer and keeps the local fallback', async () => {
  const service = createRecapService({
    config: config(),
    sessions: { get: () => ({ seq: 1, deriveMessages: () => [message('user', '跑测试')] }) },
    llm: () => ({ stream: () => fakeStream('运行 npm test --watch 直到通过') }),
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  assert.equal(await service.summarizeProgress('s1', {
    turn: 1,
    bucket: 1,
    windowMs: 600000,
    digest: { reasoning: '先定位失败用例，再决定是否改断言。', actions: ['运行命令 ×2'] },
  }), null)
})

test('summarizeProgress uses the real window offsets for the prompt window', async () => {
  const calls = []
  const service = createRecapService({
    config: config(),
    sessions: { get: () => ({ seq: 1, deriveMessages: () => [message('user', '继续迁移')] }) },
    llm: () => ({ stream: (options) => { calls.push(options); return fakeStream('继续推进迁移并验证。') } }),
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  await service.summarizeProgress('s1', {
    turn: 3,
    bucket: 3,
    windowMs: 600000,
    turnStartedAt: 1000000,
    windowFromMs: 2200000,
    windowToMs: 2800000,
    digest: { reasoning: '继续迁移', actions: ['修改 a.js'] },
  })
  assert.match(calls[0].messages[0].content[0].text, /时间窗：第 21–30 分钟（本轮累计到第 30 分钟）/)
})

test('summarizeProgress keeps the cumulative window while pointing at the new interval', async () => {
  const calls = []
  const service = createRecapService({
    config: config(),
    sessions: { get: () => ({ seq: 1, deriveMessages: () => [message('user', '继续迁移')] }) },
    llm: () => ({ stream: (options) => { calls.push(options); return fakeStream('按时间窗推进迁移，已改完标签。') } }),
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
  })
  await service.summarizeProgress('s1', {
    turn: 2,
    bucket: 2,
    anchor: 1000000,
    windowMs: 600000,
    turnStartedAt: 1000000,
    windowFromMs: 1600000,
    windowToMs: 2200000,
    digest: { reasoning: '继续迁移', actions: ['修改 a.js'] },
  })
  assert.match(calls[0].messages[0].content[0].text, /时间窗：第 1–20 分钟（本条新增第 11–20 分钟）/)
})
