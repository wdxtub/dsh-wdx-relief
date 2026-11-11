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
  assert.equal(saved.version, 1)
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
