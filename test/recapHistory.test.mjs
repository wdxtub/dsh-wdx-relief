import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRecapHistory } from '../src/recapHistory.js'

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'wdx-recap-'))
  return { dir, history: createRecapHistory({ file: join(dir, 'recaps.json') }) }
}

test('history keeps one entry per session and seq, newest first', () => {
  const { dir, history } = store()
  assert.equal(history.append({ sessionId: 's1', seq: 1, summary: '第一条', user: 'a', kind: 'answered' }), true)
  assert.equal(history.append({ sessionId: 's1', seq: 1, summary: '重复', user: 'a' }), false)
  assert.equal(history.append({ sessionId: 's1', seq: 2, summary: '第二条' }), true)
  assert.equal(history.append({ sessionId: 's2', seq: 1, summary: '别的会话' }), true)

  const items = history.list('s1')
  assert.deepEqual(items.map((item) => item.summary), ['第二条', '第一条'])
  assert.equal(history.list('s2').length, 1)
  assert.deepEqual(history.list('missing'), [])

  const saved = JSON.parse(readFileSync(join(dir, 'recaps.json'), 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.entries.length, 3)
})

test('history skips a repeated summary for the same session', () => {
  const { history } = store()
  assert.equal(history.append({ sessionId: 's1', seq: 1, summary: '同一行' }), true)
  assert.equal(history.append({ sessionId: 's1', seq: 2, summary: '同一行' }), false)
  assert.equal(history.append({ sessionId: 's1', seq: 3, summary: '换了一行' }), true)
  assert.equal(history.list('s1').length, 2)
})

test('history survives a reload and caps its size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdx-recap-'))
  const file = join(dir, 'recaps.json')
  const first = createRecapHistory({ file, maxEntries: 3 })
  for (let seq = 1; seq <= 5; seq += 1) first.append({ sessionId: 's1', seq, summary: `第 ${seq} 条` })

  const reopened = createRecapHistory({ file, maxEntries: 3 })
  assert.deepEqual(reopened.list('s1').map((item) => item.summary), ['第 5 条', '第 4 条', '第 3 条'])
})

test('history rejects malformed entries and clears per session', () => {
  const { history } = store()
  assert.equal(history.append(null), false)
  assert.equal(history.append({ summary: '没有会话' }), false)
  history.append({ sessionId: 's1', seq: 1, summary: '要保留' })
  history.append({ sessionId: 's2', seq: 1, summary: '也保留' })
  history.clear('s1')
  assert.deepEqual(history.list('s1'), [])
  assert.equal(history.list('s2').length, 1)
  history.clear()
  assert.deepEqual(history.list('s2'), [])
})

test('progress entries dedupe by turn and bucket and coexist with summaries', () => {
  const { dir, history } = store()
  assert.equal(history.append({ sessionId: 's1', seq: 1, summary: '第一条', kind: 'answered' }), true)
  assert.equal(history.append({
    sessionId: 's1', seq: 1, kind: 'progress', turn: 2, bucket: 1, status: 'stalled',
    summary: '第 2 轮 · 运行 job_output · 等待 10 分', activity: '运行 job_output…',
    elapsedMs: 700000, silenceMs: 600000, steps: 2,
  }), true)
  assert.equal(history.append({
    sessionId: 's1', seq: 1, kind: 'progress', turn: 2, bucket: 1,
    summary: '重复的 10 分钟', elapsedMs: 1, silenceMs: 1, steps: 0,
  }), false)
  assert.equal(history.append({
    sessionId: 's1', seq: 1, kind: 'progress', turn: 2, bucket: 2,
    summary: '第 2 轮 · 运行 job_output · 等待 20 分', elapsedMs: 1300000, silenceMs: 1200000, steps: 2,
  }), true)
  // 进度记录和摘要共用 seq 编号，但不会互相挡住。
  assert.equal(history.append({ sessionId: 's1', seq: 2, summary: '同一轮的摘要', kind: 'answered' }), true)

  const items = history.list('s1')
  assert.deepEqual(items.map((item) => item.summary), ['同一轮的摘要', '第 2 轮 · 运行 job_output · 等待 20 分', '第 2 轮 · 运行 job_output · 等待 10 分', '第一条'])
  const progress = items.filter((item) => item.kind === 'progress')
  assert.equal(progress.length, 2)
  assert.equal(progress[0].bucket, 2)
  assert.equal(progress[0].status, 'stalled')
  assert.equal(progress[0].silenceMs, 1200000)
  assert.equal(progress[0].steps, 2)

  const reopened = createRecapHistory({ file: join(dir, 'recaps.json') })
  assert.equal(reopened.list('s1').filter((item) => item.kind === 'progress').length, 2)
})

test('progress entries require a turn, bucket and summary', () => {
  const { history } = store()
  assert.equal(history.append({ sessionId: 's1', kind: 'progress', bucket: 1, summary: 'x' }), false)
  assert.equal(history.append({ sessionId: 's1', kind: 'progress', turn: 2, summary: 'x' }), false)
  assert.equal(history.append({ sessionId: 's1', kind: 'progress', turn: 2, bucket: 1, summary: '   ' }), false)
})

test('progress entries in a later silence episode are kept', () => {
  const { history } = store()
  const base = { sessionId: 's1', kind: 'progress', turn: 2, bucket: 1, summary: '第 2 轮 · 等待 10 分' }
  assert.equal(history.append({ ...base, anchor: 1000 }), true)
  assert.equal(history.append({ ...base, anchor: 1000 }), false)
  assert.equal(history.append({ ...base, anchor: 5000 }), true)
  assert.equal(history.list('s1').length, 2)
  assert.deepEqual(history.list('s1').map((item) => item.anchor).sort(), [1000, 5000])
})

test('list returns every stored entry for a session, not a hidden 80-entry slice', () => {
  const { history } = store()
  for (let turn = 1; turn <= 90; turn += 1) {
    assert.equal(history.append({ sessionId: 's1', seq: turn, turn, summary: `第 ${turn} 条` }), true)
  }
  assert.equal(history.list('s1').length, 90)
  assert.equal(history.list('s1')[0].turn, 90)
})

test('a local fallback summary is stored and replaced by a later real summary', () => {
  const { history } = store()
  assert.equal(history.append({ sessionId: 's1', seq: 1, turn: 1, kind: 'waiting', summary: '本地兜底', degraded: true }), true)
  assert.equal(history.list('s1').length, 1)
  assert.equal(history.list('s1')[0].degraded, true)

  // 模型恢复后，同轮的真摘要替换本地兜底，而不是被「每轮一条」规则挡住。
  assert.equal(history.append({ sessionId: 's1', seq: 2, turn: 1, kind: 'answered', summary: '模型摘要', degraded: false }), true)
  assert.equal(history.list('s1').length, 1)
  assert.equal(history.list('s1')[0].summary, '模型摘要')
  assert.equal(history.list('s1')[0].degraded, false)

  // 真摘要已经有了一条，后面的兜底不能反过来覆盖它。
  assert.equal(history.append({ sessionId: 's1', seq: 3, turn: 1, summary: '再一次兜底', degraded: true }), false)
})

test('compression-miscounted turns are repaired to stay increasing over time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdx-recap-'))
  const file = join(dir, 'recaps.json')
  const first = createRecapHistory({ file })
  first.append({ sessionId: 's1', seq: 1, turn: 44, kind: 'answered', summary: '第 44 轮', at: 1000 })
  // 上下文压缩后 countUserTurns 从 44 掉到 13，摘要被记成第 13 轮。
  first.append({ sessionId: 's1', seq: 2, turn: 13, kind: 'answered', summary: '压缩后的摘要', at: 2000 })
  first.append({ sessionId: 's1', seq: 3, kind: 'progress', turn: 46, bucket: 1, anchor: 900, summary: '第 46 轮进度', at: 3000 })
  // 延迟到达的进度条目不改标签：它的 turn 来自事件，是可信的。
  first.append({ sessionId: 's1', seq: 4, kind: 'progress', turn: 44, bucket: 2, anchor: 900, summary: '延迟的进度', at: 4000 })

  const reopened = createRecapHistory({ file })
  const items = reopened.list('s1')
  const summary = items.find((item) => item.summary === '压缩后的摘要')
  assert.equal(summary.turn, 45)
  // 时间上更早的 44 和更晚的 46 保持不变。
  assert.equal(items.find((item) => item.summary === '第 44 轮').turn, 44)
  assert.equal(items.find((item) => item.summary === '第 46 轮进度').turn, 46)
  assert.equal(items.find((item) => item.summary === '延迟的进度').turn, 44)
})

test('legacy job progress spanning turns is regrouped under the first turn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdx-recap-'))
  const file = join(dir, 'recaps.json')
  const first = createRecapHistory({ file })
  const anchor = 1795479188145
  // 0.9.3 的任务进度没有 jobId，只留下 activity 文案和任务起点。
  first.append({ sessionId: 's1', seq: 1, kind: 'progress', turn: 44, bucket: 1, anchor, summary: '第一条', activity: '后台任务 1 个运行中', at: 1000 })
  first.append({ sessionId: 's1', seq: 2, kind: 'progress', turn: 46, bucket: 2, anchor, summary: '第二条', activity: '后台任务 1 个运行中', at: 2000 })
  first.append({ sessionId: 's1', seq: 3, kind: 'progress', turn: 47, bucket: 3, anchor, summary: '第三条', activity: '后台任务 1 个运行中', at: 3000 })

  const reopened = createRecapHistory({ file })
  const items = reopened.list('s1')
  assert.deepEqual([...items.map((item) => item.turn)], [44, 44, 44])
  assert.equal(items.every((item) => item.jobGrouped === true), true)
  // 合成稳定的 jobId，客户端据此把旧条目和新条目放进同一个「后台任务」组。
  assert.equal(items.every((item) => item.jobId === 'legacy-1795479188145'), true)
})

test('jobTurnFor reuses the first turn and keeps the original goal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdx-recap-'))
  const history = createRecapHistory({ file: join(dir, 'recaps.json') })
  const anchor = 1795479188145
  assert.equal(history.append({
    sessionId: 's1', seq: 1, kind: 'progress', turn: 44, bucket: 1, anchor, jobId: 'bash-1',
    jobName: 'bash 任务', jobGoal: '把两个人群补齐', summary: '起点', activity: '后台任务 1 个运行中', at: 1000,
  }), true)
  assert.equal(history.append({
    sessionId: 's1', seq: 2, kind: 'progress', turn: 50, bucket: 2, anchor, jobId: 'bash-1',
    jobName: 'bash 任务', jobGoal: '后来的一轮要求', summary: '后来', activity: '后台任务 1 个运行中', at: 2000,
  }), true)

  assert.equal(history.jobTurnFor('s1', anchor), 44)
  assert.equal(history.jobGoalFor('s1', anchor), '把两个人群补齐')
  // 真实 jobId 到来后，旧条目统一改名，同一个任务只留一组。
  assert.equal(history.jobTurnFor('s1', anchor, 'bash-real-1'), 44)
  assert.deepEqual([...new Set(history.list('s1').map((item) => item.jobId))], ['bash-real-1'])
  // 两个条目都收拢到 44，后续刷新不会再按 50 分到另一组。
  assert.deepEqual([...history.list('s1').map((item) => item.turn)], [44, 44])
})

test('history keeps at most one summary per turn, even when the text repeats', () => {
  const { history } = store()
  assert.equal(history.append({ sessionId: 's1', seq: 1, turn: 1, summary: '同一行' }), true)
  assert.equal(history.append({ sessionId: 's1', seq: 1, turn: 1, summary: '同一行重写' }), false)
  assert.equal(history.append({ sessionId: 's1', seq: 2, turn: 2, summary: '同一行' }), true)
  assert.equal(history.append({ sessionId: 's1', seq: 3, turn: 3, summary: '换一行' }), true)
  assert.deepEqual([...history.list('s1').map((item) => item.turn)], [3, 2, 1])
})
