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

test('history keeps at most one summary per turn, even when the text repeats', () => {
  const { history } = store()
  assert.equal(history.append({ sessionId: 's1', seq: 1, turn: 1, summary: '同一行' }), true)
  assert.equal(history.append({ sessionId: 's1', seq: 1, turn: 1, summary: '同一行重写' }), false)
  assert.equal(history.append({ sessionId: 's1', seq: 2, turn: 2, summary: '同一行' }), true)
  assert.equal(history.append({ sessionId: 's1', seq: 3, turn: 3, summary: '换一行' }), true)
  assert.deepEqual([...history.list('s1').map((item) => item.turn)], [3, 2, 1])
})
