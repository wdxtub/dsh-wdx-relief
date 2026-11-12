import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_ITEMS,
  MAX_TAIL_CHARS,
  pickFallbackItems,
  buildTodayPrompt,
  createTodayService,
  parseItems,
  pickRecords,
  tailOfSurface,
} from '../src/today.js'

const NOW = 1_800_000_000_000

function user(text, time) {
  return { type: 'user/message', seq: 1, time, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
function assistant(text, time) {
  return { type: 'assistant/message', seq: 2, time, data: { message: { content: [{ type: 'text', text }] } } }
}
function tool(time) {
  return { type: 'tool/result', seq: 3, time, data: {} }
}

test('tailOfSurface returns the last assistant message of an idle session', () => {
  const tail = tailOfSurface(
    [user('把发布脚本跑一下', NOW - 5 * 3600 * 1000), assistant('已发布。要我把 tag 也推上去吗？', NOW - 4 * 3600 * 1000)],
    NOW,
  )
  assert.equal(tail.unanswered, true)
  assert.equal(tail.idleHours, 4)
  assert.equal(tail.lastUser, '把发布脚本跑一下')
  assert.match(tail.lastAssistant, /tag 也推上去/)
})

test('tailOfSurface ignores a session whose last message is from the user', () => {
  const tail = tailOfSurface(
    [assistant('我改完了。', NOW - 6 * 3600 * 1000), user('再跑一次测试', NOW - 5 * 3600 * 1000)],
    NOW,
  )
  assert.equal(tail, null)
})

test('tailOfSurface ignores sessions that are still active', () => {
  const tail = tailOfSurface([assistant('要我现在推送吗？', NOW - 10 * 60 * 1000)], NOW)
  assert.equal(tail, null)
})

test('tailText keeps the end of a long message', () => {
  const long = `${'前文'.repeat(1000)}最后一句：等你确认后再部署。`
  const tail = tailOfSurface([assistant(long, NOW - 3 * 3600 * 1000)], NOW)
  assert.ok(tail.lastAssistant.length <= MAX_TAIL_CHARS + 1)
  assert.match(tail.lastAssistant, /等你确认后再部署/)
  assert.doesNotMatch(tail.lastAssistant, /^前文前文/)
})

test('pickRecords keeps the current workspace, drops the current session and old ones', () => {
  const records = [
    { header: { id: 'a', cwd: '/w', createdAt: NOW - 3 * 3600 * 1000 } },
    { header: { id: 'b', cwd: '/w', createdAt: NOW - 9 * 3600 * 1000 } },
    { header: { id: 'current', cwd: '/w', createdAt: NOW - 1 * 3600 * 1000 } },
    { header: { id: 'other', cwd: '/x', createdAt: NOW - 2 * 3600 * 1000 } },
    { header: { id: 'old', cwd: '/w', createdAt: NOW - 30 * 24 * 3600 * 1000 } },
  ]
  const picked = pickRecords(records, { cwd: '/w', sessionId: 'current', now: NOW })
  assert.deepEqual(picked.map((record) => record.header.id), ['a', 'b'])
})

test('pickRecords caps the number of sessions it inspects', () => {
  const records = Array.from({ length: 12 }, (_, index) => ({
    header: { id: `s${index}`, cwd: '/w', createdAt: NOW - index * 3600 * 1000 },
  }))
  assert.equal(pickRecords(records, { cwd: '/w', sessionId: 'x', now: NOW, maxSessions: 4 }).length, 4)
})

test('fallback items keep only questions and hard unfinished signals', () => {
  const items = pickFallbackItems([
    {
      sessionId: 's1',
      idleHours: 3,
      lastAssistant: '已修复并要求你重启服务。\n- 生产仍未部署，等你确认。\n- 验证通过。',
    },
    {
      sessionId: 's2',
      idleHours: 8,
      lastAssistant: '改好了。要我推送到 origin/main 吗？',
    },
  ])
  assert.ok(items.length >= 2)
  assert.equal(items[0].sessionId, 's1')
  assert.match(items[0].text, /尚未|未部署|等你确认/u)
  assert.ok(items.some((item) => item.sessionId === 's2' && /推送/.test(item.text)))
})

test('buildTodayPrompt numbers candidates and keeps the last user line', () => {
  const prompt = buildTodayPrompt([
    { idleHours: 3, lastAssistant: '要我现在推送吗？', lastUser: '发布完了吗' },
    { idleHours: 20, lastAssistant: '两个方案你选一个。', lastUser: null },
  ])
  assert.match(prompt, /^\[1\] 3 小时前/)
  assert.match(prompt, /\[2\] 20 小时前/)
  assert.match(prompt, /用户最后说的是：发布完了吗/)
  assert.doesNotMatch(prompt, /\[2\][\s\S]*用户最后说的是/)
})

test('parseItems accepts fenced JSON and maps indices to sessions', () => {
  const items = parseItems('```json\n[{"i":2,"text":"等你确认后部署 wt-agent"},{"i":1,"text":"要不要加按钮"}]\n```', [
    { sessionId: 's1', idleHours: 3 },
    { sessionId: 's2', idleHours: 8 },
  ])
  assert.deepEqual(items, [
    { text: '等你确认后部署 wt-agent', sessionId: 's2', idleHours: 8 },
    { text: '要不要加按钮', sessionId: 's1', idleHours: 3 },
  ])
})

test('parseItems drops out-of-range indices, duplicates and over-long text', () => {
  const long = '长'.repeat(300)
  const items = parseItems(
    JSON.stringify([
      { i: 9, text: '越界' },
      { i: 1, text: '要我现在推送吗？' },
      { i: 1, text: '要我现在推送吗' },
      { i: 2, text: long },
      { i: 0, text: '编号从 1 开始' },
    ]),
    [
      { sessionId: 's1', idleHours: 3 },
      { sessionId: 's2', idleHours: 8 },
    ],
  )
  assert.deepEqual(items, [{ text: '要我现在推送吗？', sessionId: 's1', idleHours: 3 }])
})

test('parseItems returns an empty list for prose or broken JSON', () => {
  assert.deepEqual(parseItems('没有需要处理的事', []), [])
  assert.deepEqual(parseItems('[{"i":1,', [{ sessionId: 's1', idleHours: 1 }]), [])
  assert.deepEqual(parseItems('', []), [])
})

test('parseItems caps the number of items', () => {
  const raw = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({ i: 1, text: `第 ${index} 件事` })))
  assert.equal(parseItems(raw, [{ sessionId: 's1', idleHours: 1 }]).length, MAX_ITEMS)
})

function makeService({ records, surfaces, reply, config, dismissals } = {}) {
  const calls = []
  const service = createTodayService({
    config: config ?? { today: { get: () => true } },
    sessions: { get: (id) => (id === 'current' ? { cwd: '/w' } : undefined) },
    sessionQuery: {
      listSessions: async () => records ?? [],
      readSurface: async (id) => surfaces?.[id] ?? { events: [] },
    },
    llm: {
      stream: async function* (request) {
        calls.push(request)
        yield { type: 'text-delta', text: reply ?? '[]' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
    dismissals: dismissals ?? null,
    now: () => NOW,
  })
  return { service, calls }
}

const surface = {
  s1: { events: [user('发版', NOW - 5 * 3600 * 1000), assistant('版本号和 CHANGELOG 我没动，确认发 0.2.0 我再补。', NOW - 4 * 3600 * 1000)] },
  s2: { events: [user('好了没', NOW - 30 * 3600 * 1000), assistant('要我推送到 origin/main 吗？', NOW - 29 * 3600 * 1000)] },
}
const records = [
  { header: { id: 's1', cwd: '/w', createdAt: NOW - 5 * 3600 * 1000 } },
  { header: { id: 's2', cwd: '/w', createdAt: NOW - 30 * 3600 * 1000 } },
  { header: { id: 'current', cwd: '/w', createdAt: NOW - 1 * 3600 * 1000 } },
]

test('today service turns session tails into items', async () => {
  const { service, calls } = makeService({
    records,
    surfaces: surface,
    reply: '[{"i":1,"text":"确认发 0.2.0 并补 CHANGELOG"},{"i":2,"text":"推送 wt-agent 到 origin/main"}]',
  })
  const result = await service.list('current')
  assert.equal(result.scanned, 2)
  assert.deepEqual(result.items.map((item) => item.sessionId), ['s1', 's2'])
  assert.equal(calls.length, 1)
  assert.match(calls[0].messages[0].content[0].text, /确认发 0\.2\.0/)
})

test('today service caches the answer until the session set changes', async () => {
  const { service, calls } = makeService({ records, surfaces: surface, reply: '[{"i":1,"text":"确认发版"}]' })
  await service.list('current')
  await service.list('current')
  assert.equal(calls.length, 1)
})

test('today service falls back to keyword items when the model fails', async () => {
  const service = createTodayService({
    config: { today: { get: () => true } },
    sessions: { get: () => ({ cwd: '/w' }) },
    sessionQuery: {
      listSessions: async () => [{ header: { id: 's1', cwd: '/w', createdAt: NOW - 3 * 3600 * 1000 } }],
      readSurface: async () => ({ events: [assistant('生产仍未部署，等你确认。', NOW - 3 * 3600 * 1000)] }),
    },
    llm: {
      stream: async function* () {
        throw new Error('model unavailable')
      },
    },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
    now: () => NOW,
  })
  const result = await service.list('current')
  assert.equal(result.degraded, true)
  assert.match(result.detail, /model unavailable/)
  assert.equal(result.items.length, 1)
  assert.match(result.items[0].text, /部署/u)
})

test('today service reads cwd from the session list when the session is not live', async () => {
  const service = createTodayService({
    config: { today: { get: () => true } },
    sessions: { get: () => undefined },
    sessionQuery: {
      listSessions: async () => [
        { header: { id: 'current', cwd: '/w', createdAt: NOW - 1000 } },
        { header: { id: 's1', cwd: '/w', createdAt: NOW - 3 * 3600 * 1000 } },
      ],
      readSurface: async () => ({ events: [assistant('要我推送吗？', NOW - 3 * 3600 * 1000)] }),
    },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', text: '[{"i":1,"text":"推送"}]' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
    now: () => NOW,
  })
  const result = await service.list('current')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].sessionId, 's1')
})

test('today service reports unavailable when no session query is mounted', async () => {
  const service = createTodayService({
    config: { today: { get: () => true } },
    sessions: { get: () => ({ cwd: '/w' }) },
    sessionQuery: undefined,
    llm: () => undefined,
    defaultSelection: () => null,
    now: () => NOW,
  })
  assert.deepEqual(await service.list('current'), { items: [], unavailable: true })
})

test('today service stays quiet when disabled', async () => {
  const { service, calls } = makeService({ records, surfaces: surface, config: { today: { get: () => false } } })
  assert.deepEqual(await service.list('current'), { items: [], disabled: true })
  assert.equal(calls.length, 0)
})

test('today service hides cleared items, including from the cached result', async () => {
  const cleared = []
  const dismissals = {
    filter(items) {
      const kept = items.filter((item) => !cleared.some((entry) => entry.sessionId === item.sessionId && entry.text === item.text))
      return { items: kept, hidden: items.length - kept.length }
    },
  }
  const { service, calls } = makeService({
    records,
    surfaces: surface,
    reply: '[{"i":1,"text":"确认发版"},{"i":2,"text":"推送 origin/main"}]',
    dismissals,
  })

  const first = await service.list('current')
  assert.equal(first.items.length, 2)
  assert.equal(first.hidden, 0)
  assert.equal(calls.length, 1)

  cleared.push({ sessionId: first.items[0].sessionId, text: first.items[0].text })
  const second = await service.list('current')
  assert.equal(second.cached, true)
  assert.equal(second.items.length, 1)
  assert.equal(second.items[0].text, first.items[1].text)
  assert.equal(second.hidden, 1)
  assert.equal(calls.length, 1)
})
