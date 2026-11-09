/**
 * 回复风格：把设置页里的偏好编译成一段简短的 system prompt 段落。
 *
 * 设计原则：
 * - 只影响表达方式，不改变任务目标、事实准确性、工具权限和安全规则；
 * - 默认项不写进 prompt，避免每轮都付无意义的 token；
 * - 文本要短、可执行，不堆形容词。
 */

export const VERBOSITY_VALUES = ['model', 'low', 'medium', 'high']
export const AXIS_VALUES = ['default', 'enhanced', 'reduced']
export const BASE_STYLE_VALUES = [
  'default',
  'professional',
  'friendly',
  'blunt',
  'imaginative',
  'efficient',
  'snarky',
]

export const AXIS_FIELDS = ['friendliness', 'enthusiasm', 'emoji', 'visualAnswers', 'headingsLists']

const VERBOSITY_LINES = {
  low: '保持回复简洁：先给结论和必要步骤，只保留关键原因；省略客套、复述、背景铺垫和冗长解释。除非用户明确要求展开。',
  medium: '兼顾细节与简洁：给出结论和关键步骤，补充必要的边界与原因，省略无关铺垫。',
  high: '在回复中包含更多细节：解释原因、边界和取舍，必要时给出替代方案；不要重复和凑字数。',
}

const BASE_STYLE_LINES = {
  professional: '专业可靠：用词精确、结构清晰，先结论后依据，避免口语化和夸张表达。',
  friendly: '亲和友善：语气温和、有耐心，适当鼓励，避免生硬和居高临下。',
  blunt: '直言不讳：直接指出问题、风险和取舍，不绕弯子，但保持尊重、不做人身攻击。',
  imaginative: '天马行空：在合适时给出大胆、有想象力的方案，同时明确前提和风险。',
  efficient: '高效务实：用最短路径解决问题，少铺垫，多给可执行的动作和结果。',
  snarky: '吐槽达人：可以犀利、幽默地吐槽，但不做人身攻击，不牺牲准确性和可执行性。',
}

const AXIS_LINES = {
  friendliness: {
    enhanced: '更友好、更亲近，像熟悉的同事。',
    reduced: '更专业、更事实性，减少寒暄和情绪表达。',
  },
  enthusiasm: {
    enhanced: '更有活力、更热情，但不要浮夸。',
    reduced: '更冷静、更中立，避免感叹和情绪渲染。',
  },
  emoji: {
    enhanced: '可以适当使用表情符号来分隔语气，但不要过量。',
    reduced: '尽量少用或不用表情符号。',
  },
  visualAnswers: {
    enhanced: '适合时使用表格、图示或结构化对比来辅助理解。',
    reduced: '优先使用段落文字，少用表格和图示。',
  },
  headingsLists: {
    enhanced: '使用清晰的标题和列表结构组织信息。',
    reduced: '更多使用段落文本，少用标题和列表。',
  },
}

const AXIS_LABELS = {
  friendliness: '亲切程度',
  enthusiasm: '热情程度',
  emoji: '表情符号',
  visualAnswers: '可视化回答',
  headingsLists: '标题和列表',
}

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

  const base = oneOf(read(config, 'baseStyle', 'default'), BASE_STYLE_VALUES)
  if (base !== undefined && base !== 'default') {
    lines.push(`- 基础风格：${BASE_STYLE_LINES[base]}`)
  }

  for (const field of AXIS_FIELDS) {
    const value = oneOf(read(config, field, 'default'), AXIS_VALUES)
    if (value === undefined || value === 'default') continue
    lines.push(`- ${AXIS_LABELS[field]}：${AXIS_LINES[field][value]}`)
  }

  const writingStyle = read(config, 'writingStyle', false) === true
  if (writingStyle) {
    lines.push('- 参考用户在本对话中最近的表达方式：模仿其句式长短、用词习惯、正式或口语程度、以及解释术语的方式；只模仿风格，不复制内容，也不要刻意夸张。')
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

/** 供测试与前端读取的选项常量。 */
export const STYLE_DEFAULTS = {
  verbosity: 'low',
  writingStyle: false,
  baseStyle: 'default',
  friendliness: 'default',
  enthusiasm: 'default',
  emoji: 'default',
  visualAnswers: 'default',
  headingsLists: 'default',
  customInstructions: '',
}