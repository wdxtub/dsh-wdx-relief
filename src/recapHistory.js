/**
 * 回顾历史：每次真正生成一条 recap 时留一份，供侧边栏回看和调试。
 *
 * 约束：
 * - 只存本地 JSON（$DSH_HOME/wdx-relief/recaps.json），不写会话、不外发；
 * - 同一 (sessionId, seq) 只留一条，重复触发不会刷屏；
 * - 最多保留 maxEntries 条，超出丢最旧的。
 */

import fs from 'node:fs'
import path from 'node:path'

export const MAX_ENTRIES = 300

export function createRecapHistory({ file, maxEntries = MAX_ENTRIES, log = () => {} }) {
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
      log('recap history write failed', error)
    }
  }

  return {
    /** @returns {boolean} 是否真的写入了（同 seq 已存在则跳过） */
    append(entry) {
      if (!entry || typeof entry.sessionId !== 'string' || entry.sessionId === '') return false
      const list = load()
      if (list.some((item) => item.sessionId === entry.sessionId && item.seq === entry.seq)) return false
      // 重启后服务端缓存是空的，同一轮可能重新生成一次；摘要没变就不再记一条。
      const last = list[list.length - 1]
      if (last && last.sessionId === entry.sessionId && last.summary === entry.summary) return false
      list.push({
        sessionId: entry.sessionId,
        seq: entry.seq,
        at: typeof entry.at === 'number' ? entry.at : Date.now(),
        kind: entry.kind ?? null,
        summary: typeof entry.summary === 'string' ? entry.summary : '',
        user: typeof entry.user === 'string' ? entry.user : '',
        assistant: typeof entry.assistant === 'string' ? entry.assistant : '',
        question: typeof entry.question === 'string' ? entry.question : '',
      })
      while (list.length > maxEntries) list.shift()
      save()
      return true
    },

    /** 最新的在前。 */
    list(sessionId, limit = 50) {
      if (typeof sessionId !== 'string' || sessionId === '') return []
      return load().filter((item) => item.sessionId === sessionId).slice(-limit).reverse()
    },

    clear(sessionId) {
      const list = load()
      const next = sessionId === undefined ? [] : list.filter((item) => item.sessionId !== sessionId)
      entries = next
      save()
    },
  }
}
