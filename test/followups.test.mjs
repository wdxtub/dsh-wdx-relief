import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFollowupStore, normalizeText } from '../src/followups.js'

function makeStore(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wdx-relief-followups-'))
  const file = join(dir, 'followups.json')
  const store = createFollowupStore({ file, ...options })
  return { store, file, reopen: () => createFollowupStore({ file, ...options }) }
}

test('normalizeText drops punctuation, whitespace and case', () => {
  assert.equal(normalizeText('  把 Tag 推到远端！'), '把tag推到远端')
  assert.equal(normalizeText(''), '')
  assert.equal(normalizeText(null), '')
})

test('dismiss hides the same item and survives a reload', () => {
  const { store, reopen } = makeStore()
  assert.equal(store.dismiss('s1', '把 tag 推到远端'), true)
  assert.equal(store.dismiss('s1', '把 tag 推到远端'), false)
  assert.equal(store.hides({ sessionId: 's1', text: '把 tag 推到远端。' }), true)
  assert.equal(reopen().hides({ sessionId: 's1', text: '把 tag 推到远端' }), true)
})

test('a reworded item in the same session stays hidden', () => {
  const { store } = makeStore()
  store.dismiss('s1', '把 tag 推到远端')
  assert.equal(store.hides({ sessionId: 's1', text: '推送 tag 到远端' }), true)
})

test('different sessions and different numbers are not affected', () => {
  const { store } = makeStore()
  store.dismiss('s1', '合并 PR #12')
  assert.equal(store.hides({ sessionId: 's2', text: '合并 PR #12' }), false)
  assert.equal(store.hides({ sessionId: 's1', text: '合并 PR #13' }), false)
  assert.equal(store.hides({ sessionId: 's1', text: '确认是否部署 staging' }), false)
})

test('filter reports how many items were hidden', () => {
  const { store } = makeStore()
  store.dismiss('s1', '把 tag 推到远端')
  const result = store.filter([
    { sessionId: 's1', text: '把 tag 推到远端' },
    { sessionId: 's1', text: '确认是否部署 staging' },
    { sessionId: 's2', text: '把 tag 推到远端' },
  ])
  assert.equal(result.items.length, 2)
  assert.equal(result.hidden, 1)
  assert.deepEqual(store.filter(undefined), { items: [], hidden: 0 })
})

test('restore brings the item back and is idempotent', () => {
  const { store, reopen } = makeStore()
  store.dismiss('s1', '把 tag 推到远端')
  assert.equal(store.restore('s1', '推送 tag 到远端'), true)
  assert.equal(store.restore('s1', '推送 tag 到远端'), false)
  assert.equal(store.hides({ sessionId: 's1', text: '把 tag 推到远端' }), false)
  assert.equal(reopen().list().length, 0)
})

test('clearing many items keeps only the newest maxEntries', () => {
  const { store } = makeStore({ maxEntries: 3 })
  for (let index = 0; index < 5; index += 1) store.dismiss('s1', `第 ${index} 件事`)
  assert.equal(store.list().length, 3)
  assert.equal(store.hides({ sessionId: 's1', text: '第 0 件事' }), false)
  assert.equal(store.hides({ sessionId: 's1', text: '第 4 件事' }), true)
})

test('invalid input is ignored and a broken file reads as empty', () => {
  const { store, file } = makeStore()
  assert.equal(store.dismiss('', '有的'), false)
  assert.equal(store.dismiss('s1', '   '), false)
  assert.equal(store.dismiss(undefined, undefined), false)
  writeFileSync(file, 'not json')
  assert.deepEqual(createFollowupStore({ file }).list(), [])
})

test('store writes a versioned JSON file', () => {
  const { store, file } = makeStore()
  store.dismiss('s1', '把 tag 推到远端')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.entries.length, 1)
  assert.equal(raw.entries[0].sessionId, 's1')
  assert.equal(raw.entries[0].text, '把 tag 推到远端')
})