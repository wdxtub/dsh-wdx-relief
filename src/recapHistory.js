/**
 * 回顾历史：每次真正生成一条 recap、或运行中每 10 分钟记录一条进度时留一份，
 * 供侧边栏「会话回顾」回看和筛选。
 *
 * 约束：
 * - 只存本地 JSON（$DSH_HOME/wdx-relief/recaps.json），不写会话、不外发；
 * - 摘要按 (sessionId, seq) 去重；进度按 (sessionId, turn, bucket) 去重，
 *   页面刷新或重复请求都不会刷屏；
 * - 最多保留 maxEntries 条，超出丢最旧的。
 */

import fs from 'node:fs'
import path from 'node:path'

export const MAX_ENTRIES = 300

function text(value, maxChars) {
  return typeof value === 'string' ? value.slice(0, maxChars) : ''
}

function nonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 ? number : 0
}

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
      fs.writeFileSync(temp, JSON.stringify({ version: 2, entries }, null, 1))
      fs.renameSync(temp, file)
    } catch (error) {
      log('recap history write failed', error)
    }
  }

  return {
    /** @returns {boolean} 是否真的写入了（重复条目返回 false） */
    append(entry) {
      if (!entry || typeof entry.sessionId !== 'string' || entry.sessionId === '') return false
      const list = load()

      if (entry.kind === 'progress') {
        const turn = positiveInteger(entry.turn)
        const bucket = positiveInteger(entry.bucket)
        const anchor = nonNegative(entry.anchor)
        const summary = text(entry.summary, 500).trim()
        if (turn === 0 || bucket === 0 || summary === '') return false
        if (list.some((item) => item.kind === 'progress' && item.sessionId === entry.sessionId && item.turn === turn && (item.anchor || 0) === anchor && item.bucket === bucket)) return false
        list.push({
          sessionId: entry.sessionId,
          seq: entry.seq,
          kind: 'progress',
          turn,
          bucket,
          anchor,
          status: entry.status === 'running' ? 'running' : 'stalled',
          at: typeof entry.at === 'number' ? entry.at : Date.now(),
          summary,
          activity: text(entry.activity, 300),
          elapsedMs: nonNegative(entry.elapsedMs),
          silenceMs: nonNegative(entry.silenceMs),
          steps: nonNegative(entry.steps),
        })
        while (list.length > maxEntries) list.shift()
        save()
        return true
      }

      const turn = positiveInteger(entry.turn)
      if (turn > 0) {
        // 每组轮次只留一条摘要；文字沿用上一轮时也保留当轮这一条。
        if (list.some((item) => item.kind !== 'progress' && item.sessionId === entry.sessionId && item.turn === turn)) return false
      } else {
        if (list.some((item) => item.sessionId === entry.sessionId && item.kind !== 'progress' && item.seq === entry.seq)) return false
        // 旧记录没有 turn：重启后同一轮可能重新生成一次，摘要没变就不再记一条。
        let lastRecap = null
        for (let index = list.length - 1; index >= 0; index -= 1) {
          if (list[index].sessionId === entry.sessionId && list[index].kind !== 'progress') {
            lastRecap = list[index]
            break
          }
        }
        if (lastRecap && lastRecap.summary === entry.summary) return false
      }
      list.push({
        sessionId: entry.sessionId,
        seq: entry.seq,
        kind: entry.kind ?? null,
        turn: turn || null,
        at: typeof entry.at === 'number' ? entry.at : Date.now(),
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
    list(sessionId, limit = 80) {
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
