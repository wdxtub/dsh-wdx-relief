/**
 * 回顾历史：每次真正生成一条 recap、或运行中每 10 分钟记录一条进度时留一份，
 * 供侧边栏「会话回顾」回看和筛选。
 *
 * 约束：
 * - 只存本地 JSON（$DSH_HOME/wdx-relief/recaps.json），不写会话、不外发；
 * - 摘要按 (sessionId, turn / seq) 去重；同一轮的本地兜底可被之后模型恢复
 *   生成的真摘要替换。进度按 (sessionId, turn, anchor, bucket) 去重，
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

/**
 * 轮次编号应该随时间递增；上下文压缩会让 Host 的 countUserTurns 突然变小
 * （44 → 13），旧记录里就出现「更晚的记录反而轮次更小」。这里在读取时
 * 做一次只增不减的修正：晚于历史最大轮次的记录，若编号更小就顺延到最大 + 1。
 * 后台任务条目（jobId / jobGrouped）故意沿用任务起点的轮次，跳过。
 * @returns {boolean} 是否改动了内存里的记录
 */
function normalizeTurnLabels(list) {
  let maxTurn = 0
  let changed = false
  const ordered = [...list].sort((left, right) => (left.at || 0) - (right.at || 0) || (left.seq || 0) - (right.seq || 0))
  for (const item of ordered) {
    if (!Number.isInteger(item.turn) || item.turn < 1) continue
    if (typeof item.jobId === 'string' && item.jobId !== '') continue
    if (item.jobGrouped === true) continue
    // 进度条目的轮次来自客户端的 turn/start 事件，是可靠的；只修正摘要这类
    // Host 用 countUserTurns 算出来的编号，别把延迟到达的进度也一起改掉。
    if (item.kind === 'progress') {
      if (item.turn > maxTurn) maxTurn = item.turn
      continue
    }
    if (item.turn < maxTurn) {
      item.turn = maxTurn + 1
      changed = true
    }
    if (item.turn > maxTurn) maxTurn = item.turn
  }
  return changed
}

/** 旧版本没有 jobId，只能从 activity 文案认出这是后台任务进度。 */
function isLegacyJobEntry(item) {
  return item.kind === 'progress'
    && typeof item.activity === 'string'
    && /后台任务|background job/i.test(item.activity)
}

/**
 * 旧版本的同一个后台任务会按「当时所在轮次」记进度，被拆到 44/46 等多个组。
 * 同一任务起点（anchor）的条目统一收拢到最早的轮次，并打上 jobGrouped，
 * 免得下一次 normalizeTurnLabels 又把它拆回去。
 * @returns {boolean} 是否改动了内存里的记录
 */
function regroupJobEntries(list) {
  const byAnchor = new Map()
  for (const item of list) {
    if (item.kind !== 'progress') continue
    if (typeof item.jobId === 'string' && item.jobId !== '') {
      item.jobGrouped = true
      continue
    }
    if (!isLegacyJobEntry(item)) continue
    const anchor = item.anchor || 0
    if (anchor <= 0) continue
    const bucket = byAnchor.get(anchor)
    if (bucket === undefined) byAnchor.set(anchor, [item])
    else bucket.push(item)
  }
  let changed = false
  for (const [anchor, items] of byAnchor.entries()) {
    let min = 0
    for (const item of items) {
      if (!Number.isInteger(item.turn) || item.turn < 1) continue
      if (min === 0 || item.turn < min) min = item.turn
    }
    if (min === 0) continue
    // 合成一个稳定的 jobId，旧条目在「会话回顾」里才能和后续条目合成一组。
    const legacyId = `legacy-${anchor}`
    for (const item of items) {
      if (item.jobGrouped !== true) { item.jobGrouped = true; changed = true }
      if (typeof item.jobId !== 'string' || item.jobId === '') {
        item.jobId = legacyId
        changed = true
      }
      if (item.turn !== min) { item.turn = min; changed = true }
    }
  }
  return changed
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
    // 旧数据的轮次修正（压缩后的低编号、任务被拆到多个轮次组）在读取时完成；
    // 下一次 append 的 save 会把结果写回文件。只改内存也不会影响本次显示。
    normalizeTurnLabels(entries)
    regroupJobEntries(entries)
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
          jobId: text(entry.jobId, 80),
          jobName: text(entry.jobName, 120),
          jobGoal: text(entry.jobGoal, 200),
          status: entry.status === 'running' ? 'running' : 'stalled',
          at: typeof entry.at === 'number' ? entry.at : Date.now(),
          summary,
          activity: text(entry.activity, 300),
          elapsedMs: nonNegative(entry.elapsedMs),
          silenceMs: nonNegative(entry.silenceMs),
          steps: nonNegative(entry.steps),
          windowMs: nonNegative(entry.windowMs),
          windowFromMs: nonNegative(entry.windowFromMs),
          windowToMs: nonNegative(entry.windowToMs),
          turnStartedAt: nonNegative(entry.turnStartedAt),
          generated: entry.generated === true,
        })
        while (list.length > maxEntries) list.shift()
        save()
        return true
      }

      const turn = positiveInteger(entry.turn)
      if (turn > 0) {
        // 每组轮次只留一条摘要；文字沿用上一轮时也保留当轮这一条。
        const existing = list.find((item) => item.kind !== 'progress' && item.sessionId === entry.sessionId && item.turn === turn)
        if (existing !== undefined) {
          // 模型失败时的本地兜底已经显示在输入框上方；之后模型恢复并给出同轮摘要时，
          // 用真摘要替换它，而不是让低质量的本地拼接占住这一轮。
          if (existing.degraded === true && entry.degraded !== true) {
            existing.kind = entry.kind ?? existing.kind
            existing.at = typeof entry.at === 'number' ? entry.at : Date.now()
            existing.summary = typeof entry.summary === 'string' ? entry.summary : existing.summary
            existing.user = typeof entry.user === 'string' ? entry.user : existing.user
            existing.assistant = typeof entry.assistant === 'string' ? entry.assistant : existing.assistant
            existing.question = typeof entry.question === 'string' ? entry.question : existing.question
            existing.degraded = false
            save()
            return true
          }
          return false
        }
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
        degraded: entry.degraded === true,
      })
      while (list.length > maxEntries) list.shift()
      save()
      return true
    },

    /** 最新的在前；默认返回这个会话保存的全部条目，避免面板「共 N 条」与实际只显示最近 80 条不一致。 */
    list(sessionId, limit = maxEntries) {
      if (typeof sessionId !== 'string' || sessionId === '') return []
      return load().filter((item) => item.sessionId === sessionId).slice(-limit).reverse()
    },

    /**
     * 同一个任务起点（anchor）已经记过的轮次：取最早的一条，后续条目都用它。
     * 顺便把旧条目收拢到这个轮次，返回 0 表示还没有记录。
     */
    jobTurnFor(sessionId, anchor, jobId = '') {
      if (typeof sessionId !== 'string' || sessionId === '') return 0
      if (!Number.isFinite(anchor) || anchor <= 0) return 0
      const items = load().filter((item) => item.kind === 'progress'
        && item.sessionId === sessionId
        && (item.anchor || 0) === anchor
        && Number.isInteger(item.turn)
        && item.turn >= 1)
      if (items.length === 0) return 0
      let min = 0
      for (const item of items) {
        if (min === 0 || item.turn < min) min = item.turn
      }
      let changed = false
      for (const item of items) {
        if (item.jobGrouped !== true) { item.jobGrouped = true; changed = true }
        // 旧条目（legacy-<anchor>）遇到真实 jobId 后统一改名，同一个任务只留一组。
        if (jobId !== '' && item.jobId !== jobId) { item.jobId = jobId; changed = true }
        if (item.turn !== min) { item.turn = min; changed = true }
      }
      if (changed) save()
      return min
    },

    /** 同一个任务最早记下的「本轮目标」，给后续摘要保持上下文一致。 */
    jobGoalFor(sessionId, anchor) {
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      if (!Number.isFinite(anchor) || anchor <= 0) return ''
      let best = null
      for (const item of load()) {
        if (item.kind !== 'progress' || item.sessionId !== sessionId) continue
        if ((item.anchor || 0) !== anchor) continue
        if (typeof item.jobGoal !== 'string' || item.jobGoal === '') continue
        if (best === null || (item.at || 0) < (best.at || 0)) best = item
      }
      return best === null ? '' : best.jobGoal
    },

    clear(sessionId) {
      const list = load()
      const next = sessionId === undefined ? [] : list.filter((item) => item.sessionId !== sessionId)
      entries = next
      save()
    },
  }
}
