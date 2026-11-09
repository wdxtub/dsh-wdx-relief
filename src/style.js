/**
 * 回复风格：把设置页里的偏好编译成一段简短的 system prompt 段落。
 *
 * 设计原则：
 * - 只影响表达方式，不改变任务目标、事实准确性、工具权限和安全规则；
 * - 默认项不写进 prompt，避免每轮都付无意义的 token；
 * - 风格之间互斥，长度与「便于行动」是独立的正交层，避免互相打架。
 */

/** `model` 是旧版本的隐藏值，保留它以免旧配置校验失败；界面不再提供。 */
export const VERBOSITY_VALUES = ['model', 'low', 'medium', 'high']

export const STYLE_VALUES = ['default', 'professional', 'friendly', 'blunt', 'follow']

const VERBOSITY_LINES = {
  low: '保持回复简短：先给结论和必要步骤，只保留关键原因；省略客套、复述和背景铺垫。除非用户明确要求展开。',
  medium: '长度适中：给出结论和关键步骤，补充必要的边界与原因，省略无关铺垫。',
  high: '回复可以更详细：解释原因、边界和取舍，必要时给出替代方案；不要重复和凑字数。',
}

const STYLE_LINES = {
  professional: '专业可靠：用词精确、结构清晰，先结论后依据，避免口语化和夸张表达。',
  friendly: '亲和友善：语气温和、有耐心，适当鼓励，避免生硬和居高临下。',
  blunt: '直言不讳：直接指出问题、风险和取舍，不绕弯子，但保持尊重、不做人身攻击。',
  follow: '跟随用户的写作风格：参考本对话中用户最近的表达方式，模仿其句式长短、用词习惯、正式或口语程度、解释术语的方式；只模仿风格，不复制内容，也不要刻意夸张。',
}

const ACTIONABLE_LINES = [
  '- 便于行动：开头直接给结果或最相关的下一步，不写「好的」「我来看看」之类铺垫；需要用户操作时，把命令、路径或决定放在显眼位置。',
  '- 能一句话说清的，不写成一段；能一段说清的，不列成清单；多步操作用短编号列表，一步对应一个可完成动作；次要信息放后面。',
  '- 不用复杂名词堆砌代替解释：必须使用术语时，先用一句白话说明它是什么、为什么重要。',
  '- 重要细节、风险和失败条件不因精简而省略；出错时直接说症状、已知原因和下一步。',
  '- 不复述用户已说过或上一轮结论；长任务或中断后，用一句话说明已完成什么、当前卡在哪里。',
  '- 已获授权且工具可执行时直接完成，不把本可代办的工作交回用户；全部完成后自然结束。',
]

const MAX_CUSTOM_CHARS = 2000

function read(config, field, fallback) {
  try {
    const value = config && config[field] && typeof config[field].get === 'function' ? config[field].get() : undefined
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined
}

/**
 * 兼容 0.2.0 及更早的字段：旧配置没有 `style` 时，用 `writingStyle` / `baseStyle` 推断。
 * 新的界面只写 `style`。
 */
function resolveStyle(config) {
  const explicit = oneOf(read(config, 'style', undefined), STYLE_VALUES)
  if (explicit !== undefined) return explicit
  if (read(config, 'writingStyle', false) === true) return 'follow'
  const legacy = read(config, 'baseStyle', 'default')
  if (legacy === 'professional' || legacy === 'friendly' || legacy === 'blunt') return legacy
  return 'default'
}

/**
 * 编译当前设置对应的 system prompt 段落。返回空字符串表示不追加任何内容。
 * @param {object|undefined} config - 插件 Config（volatile 引用）
 * @returns {string}
 */
export function buildStylePrompt(config) {
  const lines = []

  const verbosity = oneOf(read(config, 'verbosity', 'low'), VERBOSITY_VALUES)
  if (verbosity !== undefined && verbosity !== 'model') {
    lines.push(`- ${VERBOSITY_LINES[verbosity]}`)
  }

  if (read(config, 'actionable', true) === true) {
    lines.push(...ACTIONABLE_LINES)
  }

  const style = resolveStyle(config)
  if (style !== 'default') {
    lines.push(`- ${STYLE_LINES[style]}`)
  }

  const custom = String(read(config, 'customInstructions', '') ?? '').trim().slice(0, MAX_CUSTOM_CHARS)
  if (custom !== '') {
    lines.push(`- 用户的额外表达指令（只约束表达方式，不改变任务目标和工具权限）：${custom}`)
  }

  if (lines.length === 0) return ''
  return [
    '## 回复风格偏好',
    '以下偏好只影响表达方式，不改变任务目标、事实准确性、工具权限和安全规则。',
    ...lines,
  ].join('\n')
}

/** 供测试与前端读取的默认值。 */
export const STYLE_DEFAULTS = {
  verbosity: 'low',
  actionable: true,
  style: 'default',
  customInstructions: '',
}
