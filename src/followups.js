/**
 * 待跟进的清掉记录：用户点过「清掉」的条目不再出现在面板里。
 *
 * 设计约束：
 * - 只存本地 JSON（$DSH_HOME/wdx-relief/followups.json），不写会话、不外发；
 * - 指纹是「会话 + 归一化文本」；模型下一次换个说法时，用同一会话内的相似度兜底；
 * - 最多保留 200 条，超出丢最旧的；
 * - 清掉只影响面板，不删会话里的任何内容，撤销就是删掉这条记录。
 */

import fs from 'node:fs'
import path from 'node:path'
import { similarity } from './recap.js'

export const MAX_ENTRIES = 200
export const MAX_TEXT_CHARS = 200
export const SIMILARITY_THRESHOLD = 0.6

/** 归一化后只留文字和数字：标点、空白、大小写都不参与比对。 */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, MAX_TEXT_CHARS)
}

export function createFollowupStore({
  file,
  maxEntries = MAX_ENTRIES,
  threshold = SIMILARITY_THRESHOLD,
  log = () => {},
  now = () => Date.now(),
}) {
  let entries = null

  function load() {
    if (entries !== null) return entries
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      entries = Array.isArray(raw?.entries) ? raw.entries : []
    } catch {
      entries = []
    }
    return entries
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }, null, 1))
      fs.renameSync(temp, file)
    } catch (error) {
      log('followup store write failed', error)
    }
  }

  function keyOf(sessionId, text) {
    return `${sessionId}\u0000${normalizeText(text)}`
  }

  function valid(sessionId, text) {
    return typeof sessionId === 'string' && sessionId !== '' && normalizeText(text) !== ''
  }

  /** 英文词和数字要一致才算同一件事：PR #12 和 PR #13、v0.4.0 和 v0.5.0 不会被合并。 */
  function sameTokens(left, right) {
    const tokens = (value) => new Set(String(value ?? '').toLowerCase().match(/[a-z0-9]+/gu) ?? [])
    const a = tokens(left)
    const b = tokens(right)
    if (a.size === 0 || b.size === 0) return true
    if (a.size !== b.size) return false
    for (const token of a) if (!b.has(token)) return false
    return true
  }

  function sameEntry(entry, sessionId, text) {
    if (entry.sessionId !== sessionId) return false
    if (entry.key === keyOf(sessionId, text)) return true
    if (!sameTokens(entry.text, text)) return false
    return similarity(entry.text, text) >= threshold
  }

  return {
    /** @returns {boolean} 这次是否真新增了一条记录（重复清掉同一条返回 false）。 */
    dismiss(sessionId, text) {
      if (!valid(sessionId, text)) return false
      const list = load()
      if (list.some((entry) => sameEntry(entry, sessionId, text))) return false
      list.push({
        sessionId,
        key: keyOf(sessionId, text),
        text: String(text).slice(0, MAX_TEXT_CHARS),
        at: now(),
      })
      while (list.length > maxEntries) list.shift()
      save()
      return true
    },

    /** @returns {boolean} 是否删掉了记录；用于面板的「撤销」。 */
    restore(sessionId, text) {
      if (!valid(sessionId, text)) return false
      const list = load()
      const kept = list.filter((entry) => !sameEntry(entry, sessionId, text))
      if (kept.length === list.length) return false
      entries = kept
      save()
      return true
    },

    /** 最新清掉的在前。 */
    list() {
      return load().map((entry) => ({ sessionId: entry.sessionId, text: entry.text, at: entry.at })).reverse()
    },

    hides(item) {
      if (!item || typeof item.text !== 'string' || typeof item.sessionId !== 'string') return false
      return load().some((entry) => sameEntry(entry, item.sessionId, item.text))
    },

    /**
     * 过滤掉已清掉的条目。
     * @returns {{ items: Array<object>, hidden: number }}
     */
    filter(items) {
      const kept = []
      let hidden = 0
      for (const item of Array.isArray(items) ? items : []) {
        if (this.hides(item)) hidden += 1
        else kept.push(item)
      }
      return { items: kept, hidden }
    },
  }
}