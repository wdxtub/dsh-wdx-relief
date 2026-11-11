/**
 * dsh-wdx-relief 网页客户端。
 *
 * 四块 UI：
 * 1. 右侧栏 WDX Relief 页面：默认「没接住的事」，另一个 Tab 是「旁问」。
 * 2. `conversation.input.overlay`：在输入框里显示「下一句消息」灰字预测，
 *    Tab 填入（Codex 式），点击也可以填入。
 * 3. `conversation.input.dock` / `conversation.composer.dock`：输入框上方或下方的一行，
 *    逐轮显示活动流水、耗时、思考预览与语义摘要。
 * 4. `plugins.bundle.config`：侧边栏「插件」里 dsh-wdx-relief 的配置页。
 *
 * 预测/回顾/今日/旁问都由 Host 侧对应路由生成；这里只负责触发、渲染和开关读写。
 * 回顾那一行是纯 UI：不写会话、不注入 prompt，也不进入模型上下文。
 *
 * 约束：
 * - 工厂函数不产生模块级副作用；样式随组件挂载，卸载时由 React 移除。
 * - 配置页使用官方 SettingsFormModel / SettingsForm 的暂存-保存模型。
 * - 输入框灰字是用户选择的 Codex 式体验，定位会测量 composer 布局；
 *   这是本插件已知的宿主 DOM 耦合点。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wdx-relief',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useLayoutEffect = React.useLayoutEffect

    var NS = 'wdx-relief'
    var RPC_PATH = '/api/wdx-relief/predict'
    var RECAP_PATH = '/api/wdx-relief/recap'
    var TODAY_PATH = '/api/wdx-relief/today'
    var RECAPS_PATH = '/api/wdx-relief/recaps'
    var BTW_PATH = '/api/wdx-relief/btw'
    var RECAP_PLACEMENTS = ['above', 'below']
    var MAX_CUSTOM_CHARS = 2000
    var SWITCH = primitives && primitives.Switch
    var MENU = primitives && primitives.Menu
    var CHEVRON = primitives && primitives.IconChevronDownOutlineRegular
    var SETTINGS_FORM = primitives && primitives.SettingsForm
    var SETTINGS_FORM_MODEL = primitives && primitives.SettingsFormModel
    var MARKDOWN = primitives && primitives.MarkdownText
    var DATA_ICON = primitives && primitives.IconDataOutlineRegular

    var VERBOSITY_OPTIONS = ['low', 'medium', 'high']
    var STYLE_OPTIONS = ['default', 'professional', 'friendly', 'blunt', 'follow']

    // ------------------------------------------------------------------ CSS

    var CSS = [
      '.wdxs-page{width:100%;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary)}',
      '.wdxs-intro{color:var(--dsw-alias-label-tertiary);margin:-4px 0 4px;font-size:12px;line-height:18px}',
      '.wdxs-groupHead{color:var(--dsw-alias-label-secondary);margin:24px 0 0;font-size:13px;font-weight:600;line-height:20px}',
      '.wdxs-item{flex-direction:column;gap:2px;max-width:280px;display:flex}',
      '.wdxs-itemName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.wdxs-itemDesc{color:var(--dsw-alias-label-caption);white-space:normal;font-size:12px;line-height:16px}',
      '.wdxs-row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:16px 0;display:flex}',
      '.wdxs-rowText{flex:1;min-width:0}',
      '.wdxs-title{font-size:14px;line-height:20px}',
      '.wdxs-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}',
      '.wdxs-reset{color:var(--dsw-alias-label-tertiary);background:none;border:0;padding:0;margin-top:6px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-decoration:underline}',
      '@media (hover:hover){.wdxs-reset:hover{color:var(--dsw-alias-label-primary)}}',
      '.wdxs-select{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);height:36px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;align-items:center;gap:12px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;display:inline-flex}',
      '@media (hover:hover){.wdxs-select:hover{background:var(--dsw-alias-interactive-bg-hover)}}',
      '.wdxs-chevron{flex:none}',
      '.wdxs-custom{padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.wdxs-textarea{box-sizing:border-box;width:100%;min-height:104px;resize:vertical;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);outline:none;margin-top:10px;padding:10px 12px;font:inherit;font-size:13px;line-height:20px}',
      '.wdxs-textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary)}',
      '.wdxs-textarea::placeholder{color:var(--dsw-alias-label-caption)}',
      '.wdxs-advanced{width:100%;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:14px 0;font:inherit;font-size:12px;line-height:18px;text-align:left;text-decoration:underline}',
      '@media (hover:hover){.wdxs-advanced:hover{color:var(--dsw-alias-label-primary)}}',
      '.wdxs-number{box-sizing:border-box;width:96px;height:34px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);outline:none;padding:0 10px;font:inherit;font-size:13px;line-height:20px}',
      '.wdxs-textInput{box-sizing:border-box;width:280px;max-width:100%;height:34px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);outline:none;padding:0 10px;font:inherit;font-size:13px;line-height:20px}',
      '.wdxs-number:focus-visible,.wdxs-textInput:focus-visible{border-color:var(--dsw-alias-state-business-primary)}',
      '.wdxs-advNote{color:var(--dsw-alias-label-caption);margin:10px 0 0;font-size:12px;line-height:18px}',
      '.wdxs-fallback{border:0;padding:0;margin:0}',
      '.wdxt-root{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;padding:0 var(--dsh-composer-dock-inset)}',
      '.wdxt-root[data-placement="below"]{width:auto;max-width:none;flex:1 1 auto;min-width:0;padding:0}',
      '.wdxt-row{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);min-height:28px;align-items:center;gap:6px;padding:4px 6px 4px 10px;font-size:12px;line-height:18px;display:flex}',
      '.wdxt-seg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.wdxt-activity{color:var(--dsw-alias-label-tertiary);flex:0 1 auto;max-width:46%}',
      '.wdxt-time{color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;flex:none}',
      '.wdxt-reason{color:var(--dsw-alias-label-caption);flex:0 1 auto;max-width:34%}',
      '.wdxt-summary{color:var(--dsw-alias-label-secondary);flex:1 1 auto;min-width:0}',
      '.wdxt-sep{color:var(--dsw-alias-border-l3);flex:none}',
      '.wdxt-close{width:16px;height:16px;color:var(--dsw-alias-label-caption);cursor:pointer;opacity:0;background:0 0;border:0;border-radius:999px;flex:none;place-items:center;padding:0;font:inherit;font-size:12px;line-height:1;display:grid}',
      '.wdxt-row:hover .wdxt-close,.wdxt-close:focus-visible{opacity:1}',
      '@media (hover:hover){.wdxt-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}',
      '.wdxa-pane{flex-direction:column;gap:8px;display:flex}',
      '.wdxa-meta{min-height:20px;align-items:center;gap:8px;display:flex}',
      '.wdxa-composer{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);flex-direction:column;gap:4px;padding:8px 8px 6px;display:flex}',
      '.wdxa-composer:focus-within{border-color:var(--dsw-alias-state-business-primary)}',
      '.wdxa-textarea{box-sizing:border-box;width:100%;min-height:58px;resize:none;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);padding:2px 4px 0;font:inherit;font-size:13px;line-height:20px}',
      '.wdxa-textarea::placeholder{color:var(--dsw-alias-label-caption)}',
      '.wdxa-toolbar{align-items:center;gap:6px;min-width:0;display:flex}',
      '.wdxa-modelWrap{position:relative;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:var(--dsw-radius-sm);min-width:0;max-width:260px;height:28px;align-items:center;gap:4px;padding:0 4px 0 6px;font-size:12px;line-height:20px;display:flex}',
      '@media (hover:hover){.wdxa-modelWrap:hover{background:var(--dsw-alias-interactive-bg-hover)}}',
      '.wdxa-modelWrap:focus-within{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.wdxa-modelIcon{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.wdxa-modelName{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.wdxa-modelMeasure{position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none;left:0;top:0;width:max-content;max-width:none;font:inherit;font-size:12px;line-height:20px}',
      '.wdxa-modelChevron{color:var(--dsw-alias-label-caption);flex:none}',
      '.wdxa-modelSelect{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:0;margin:0;padding:0;font:inherit;appearance:none;-webkit-appearance:none}',
      '.wdxa-modelSelect:disabled{cursor:default}',
      '.wdxa-spacer{flex:1}',
      '.wdxa-send{width:32px;height:32px;border-radius:50%;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;border:0;flex:none;place-items:center;padding:0;display:grid}',
      '@media (hover:hover){.wdxa-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,var(--dsw-alias-state-business-primary))}}',
      '.wdxa-send:disabled{opacity:.45;cursor:default}',
      '.wdxa-clear{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;margin-left:auto;padding:0;font:inherit;font-size:11px;line-height:16px;text-decoration:underline}',
      '@media (hover:hover){.wdxa-clear:hover{color:var(--dsw-alias-label-primary)}}',
      '.wdxa-list{flex-direction:column;gap:8px;display:flex}',
      '.wdxa-item{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);flex-direction:column;gap:6px;padding:8px 10px;display:flex}',
      '.wdxa-q{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-weight:500;overflow-wrap:anywhere}',
      '.wdxa-answer{color:var(--dsw-alias-label-primary);max-height:260px;overflow:auto;font-size:12px;line-height:19px}',
      '.wdxa-pre{white-space:pre-wrap;margin:0;font:inherit}',
      '.wdxa-loading{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.wdxa-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.wdxa-note{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:12px;line-height:18px}',
      '.wdxp-page{box-sizing:border-box;height:100%;min-height:0;flex-direction:column;gap:14px;padding:14px 14px 24px;display:flex;color:var(--dsw-alias-label-primary);overflow:auto}',
      '.wdxp-tabs{box-sizing:border-box;align-items:center;gap:18px;border-bottom:.5px solid var(--dsw-alias-border-l3);display:flex}',
      '.wdxp-tab{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;margin:0;padding:2px 0 9px;font:inherit;font-size:13px;font-weight:500;line-height:18px;position:relative;align-items:center;gap:6px;display:inline-flex}',
      '@media (hover:hover){.wdxp-tab:hover{color:var(--dsw-alias-label-primary)}}',
      '.wdxp-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:var(--dsw-radius-sm)}',
      '.wdxp-tabActive{color:var(--dsw-alias-label-primary)}',
      '.wdxp-tabActive:after{content:"";position:absolute;right:0;bottom:-1px;left:0;background:var(--dsw-alias-state-business-primary);border-radius:2px;height:2px}',
      '.wdxp-tabCount{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:999px;padding:0 5px;font-size:10px;line-height:15px}',
      '.wdxp-pane{min-width:0;flex-direction:column;gap:8px;display:flex}',
      '.wdxp-pane[hidden]{display:none}',
      '.wdxp-section{flex-direction:column;gap:8px;display:flex}',
      '.wdxp-sectionHead{min-height:24px;align-items:center;gap:6px;display:flex}',
      '.wdxp-sectionTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px}',
      '.wdxp-count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:999px;padding:1px 6px;font-size:11px;line-height:16px}',
      '.wdxp-iconBtn{width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:var(--dsw-radius-sm);flex:none;place-items:center;margin-left:auto;padding:0;display:grid}',
      '@media (hover:hover){.wdxp-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}',
      '.wdxp-iconBtn:disabled{opacity:.5;cursor:default}',
      '.wdxp-body{min-width:0}',
      '.wdxp-rows{flex-direction:column;gap:8px;display:flex}',
      '.wdxp-list{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}',
      '.wdxp-item{min-width:0;flex-direction:column;gap:2px;margin:0;padding:0;display:flex}',
      '.wdxp-row{box-sizing:border-box;width:100%;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:inherit;font:inherit;text-align:left;cursor:pointer;align-items:flex-start;gap:10px;padding:8px 10px;display:flex}',
      '@media (hover:hover){.wdxp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}}',
      '.wdxp-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-1px}',
      '.wdxp-rowText{overflow-wrap:anywhere;white-space:normal;flex:1;min-width:0;font-size:13px;line-height:19px}',
      '.wdxp-rowMeta{color:var(--dsw-alias-label-caption);white-space:nowrap;font-variant-numeric:tabular-nums;flex:none;font-size:11px;line-height:19px}',
      '.wdxp-note{color:var(--dsw-alias-label-tertiary);align-items:center;gap:6px;margin:2px 0 0;font-size:12px;line-height:18px;display:flex}',
      '.wdxp-link{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;padding:0;font:inherit;font-size:12px;line-height:18px;text-decoration:underline}',
      '@media (hover:hover){.wdxp-link:hover{color:var(--dsw-alias-label-primary)}}',
      '.wdxp-degraded{color:var(--dsw-alias-label-caption);overflow-wrap:anywhere;margin:6px 0 0;font-size:11px;line-height:16px}',
      '.wdxh-row{align-items:flex-start;flex:none}',
      '.wdxh-toolbar{align-items:center;gap:8px;min-height:18px;display:flex}',
      '.wdxh-count{color:var(--dsw-alias-label-caption);margin-right:auto;font-size:11px;line-height:16px}',
      '.wdxh-detail{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);max-height:260px;flex-direction:column;gap:6px;margin-top:2px;padding:8px 10px;display:flex;overflow:auto}',
      '.wdxh-line{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap;margin:0;font-size:12px;line-height:18px}',
      '.wdxh-label{color:var(--dsw-alias-label-caption);margin-right:4px;font-size:11px}',
      '.wdxp-skeleton{flex-direction:column;gap:2px;display:flex}',
      '.wdxp-skeletonRow{height:38px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-skeleton)}',
    ].join('')

    function PluginStyles(props) {
      var scope = props && props.scope ? ':' + props.scope : ''
      return h('style', { 'data-plugin-css': NS + scope }, CSS)
    }

    // -------------------------------------------------------------- locale

    var zh = {
      'reply.intro': '这些偏好只影响回复的表达方式，不改变任务目标、事实准确性或工具权限。',
      'reply.group.input': '输入',
      'reply.group.length': '回复长度',
      'reply.group.writing': '写作',
      'reply.verbosity.title': '输出详细程度',
      'reply.verbosity.description': '选择回复包含细节的详细程度',
      'reply.verbosity.low': '短',
      'reply.verbosity.medium': '标准',
      'reply.verbosity.high': '详细',
      'reply.actionable.title': '便于行动',
      'reply.actionable.description': '先给结果和下一步，少铺垫；能一句话说清就不展开，术语先用白话说明',
      'reply.style.title': '回复风格',
      'reply.style.description': '选择整体语气和表达方式',
      'reply.style.default': '默认',
      'reply.style.professional': '专业',
      'reply.style.friendly': '亲和',
      'reply.style.blunt': '直接',
      'reply.style.follow': '跟随我的风格',
      'reply.style.option.default.desc': '中立、简洁',
      'reply.style.option.professional.desc': '精确、结构化，少口语',
      'reply.style.option.friendly.desc': '温和、有耐心，术语先解释',
      'reply.style.option.blunt.desc': '直说问题和取舍',
      'reply.style.option.follow.desc': '模仿你在这段对话里的句式与用词',
      'reply.custom.title': '自定义指令',
      'reply.custom.description': '补充只影响回复表达的指令，优先级高于上面的长度和风格',
      'reply.custom.placeholder': '例如：先给结论；用中文解释术语；不要使用「首先/其次」。',
      'settings.title': '显示预测消息',
      'settings.description': '根据对话预测你接下来要发送的消息',
      'settings.turnLine': '输入框上的一行',
      'settings.turnLine.note': '这一行只是界面提示，不进入模型上下文；前三项本地生成，只有语义摘要会调用模型。',
      'settings.recap.title': '语义摘要',
      'settings.recap.description': '每几轮用一次便宜模型，写一行「现在到哪」',
      'settings.recapActivity.title': '活动流水',
      'settings.recapActivity.description': '正在读文件、跑命令、改代码；本地生成，零模型调用（默认关闭）',
      'settings.recapTiming.title': '状态耗时',
      'settings.recapTiming.description': '这一轮跑了多久；本地生成（默认关闭）',
      'settings.recapReasoning.title': '思考预览',
      'settings.recapReasoning.description': '折叠推理的第一行；本地生成，零模型调用（默认关闭）',
      'settings.recapPlacement.title': '显示位置',
      'settings.recapPlacement.description': '这一行放在输入框上方还是下方',
      'settings.recapPlacement.above': '输入框上方',
      'settings.recapPlacement.below': '输入框下方',
      'settings.recapAdvanced': '高级（一般不用改）',
      'settings.recapAdvancedHide': '收起高级设置',
      'settings.recapMinTurns.title': '从第几轮开始',
      'settings.recapMinTurns.description': '至少经过几轮用户消息才生成语义摘要',
      'settings.recapCooldownTurns.title': '摘要更新间隔',
      'settings.recapCooldownTurns.description': '每隔几轮更新一次；1 表示每轮',
      'settings.recapSimilarityThreshold.title': '沿用旧摘要的阈值',
      'settings.recapSimilarityThreshold.description': '新旧摘要相似度达到这个值就不再改字（0–1）',
      'settings.recapMaxWords.title': '摘要长度',
      'settings.recapMaxWords.description': '词预算；中文按字算',
      'settings.recapModelChain.title': '摘要模型链',
      'settings.recapModelChain.description': '按顺序尝试 provider/model；留空自动挑便宜模型，全部失败退回当前默认模型',
      'settings.recapModelChain.placeholder': 'deepseek-v4-flash, deepseek-chat',
      'settings.btwHint': '提示：右侧 WDX Relief 面板的「旁问」Tab 可以直接问当前模型，底部可以选旁问模型；问答不会进入主上下文。',
      'settings.summary': '预测下一句，输入框上给一行进度；右侧面板整理没接住的事、回看历史摘要，并可旁问且不污染上下文。',
      'turn.reasoning': '思考',
      'turn.pending': '还没回复',
      'turn.dismiss': '收起这一行',
      'turn.thinking': '思考中…',
      'turn.answering': '正在回复…',
      'turn.tool': '调用工具…',
      'turn.verb.read': '读取',
      'turn.verb.write': '修改',
      'turn.verb.command': '运行',
      'turn.verb.search': '查找',
      'turn.verb.web': '查网页',
      'turn.verb.todo': '更新待办',
      'turn.verb.delegate': '子任务',
      'turn.verb.present': '整理交付',
      'turn.verb.ask': '等你回答',
      'turn.verb.skill': '加载技能',
      'turn.verb.other': '调用',
      'settings.today.title': '整理没接住的事',
      'settings.today.description': '把过去会话里提醒过你、但你还没处理的事整理成一小份清单',
      'panel.title': 'WDX Relief',
      'panel.guide': '整理没接住的事，也可以随手旁问',
      'panel.refresh': '刷新',
      'panel.retry': '重试',
      'panel.empty': '最近两周没有待你决定的事',
      'panel.unavailable': '当前 profile 没有启用会话查询，无法整理',
      'panel.error': '整理失败，稍后再试。',
      'panel.degraded': '模型没整理成功，这份是按关键词挑的',
      'panel.ageShort': '{hours} 小时',
      'section.untouched': '没接住的事',
      'section.recaps': '会话回顾',
      'panel.recapEmpty': '还没有生成过摘要；聊到第三轮就会出现第一条',
      'panel.recapError': '回顾历史读取失败',
      'panel.recapRouteMissing': '回顾历史路由没加载；重启 DSH 后再试',
      'panel.recapCount': '共 {count} 条',
      'panel.recapClear': '清空',
      'panel.recapRequest': '要求',
      'panel.recapReply': '回复',
      'panel.recapQuestion': '待回答',
      'section.btw': '旁问',
      'btw.placeholder': '问点什么…',
      'btw.ask': '问',
      'btw.asking': '回答中…',
      'btw.stop': '停止',
      'btw.clear': '清空',
      'btw.empty': '还没有旁问',
      'btw.error': '旁问失败',
      'btw.noSession': '先打开一个会话，才能带着上下文旁问。',
      'btw.cancelled': '已取消',
      'btw.model': '模型',
      'btw.modelLoading': '加载模型…',
      'btw.modelHint': '旁问使用的模型，不改变主会话',
      'btw.routeMissing': '旁问路由未加载；请重启 DSH 后再试。',
      'prediction.accept': '按 Tab 填入预测',
      'form.unavailable': '配置暂不可用。',
      'form.readOnly': '当前部署只读。',
      'form.saveFailed': '本部署没有接受这些值；已保留供你修改。',
      'form.save': '保存',
      'form.saving': '保存中…',
      'form.reset': '恢复默认',
    }

    var en = {
      'reply.intro': 'These preferences shape expression only. They do not change goals, facts, or tool permissions.',
      'reply.group.input': 'Input',
      'reply.group.length': 'Reply length',
      'reply.group.writing': 'Writing',
      'reply.verbosity.title': 'Output detail',
      'reply.verbosity.description': 'How much detail replies should include',
      'reply.verbosity.low': 'Short',
      'reply.verbosity.medium': 'Standard',
      'reply.verbosity.high': 'Detailed',
      'reply.actionable.title': 'Actionable replies',
      'reply.actionable.description': 'Lead with the result and next step; explain jargon in plain language; keep risks and failure conditions',
      'reply.style.title': 'Reply style',
      'reply.style.description': 'Choose the overall tone and expression',
      'reply.style.default': 'Default',
      'reply.style.professional': 'Professional',
      'reply.style.friendly': 'Friendly',
      'reply.style.blunt': 'Blunt',
      'reply.style.follow': 'Follow my style',
      'reply.style.option.default.desc': 'Neutral and concise',
      'reply.style.option.professional.desc': 'Precise, structured, less colloquial',
      'reply.style.option.friendly.desc': 'Warm, patient, explains terms first',
      'reply.style.option.blunt.desc': 'Straight about problems and tradeoffs',
      'reply.style.option.follow.desc': 'Mirror your sentence structure and wording',
      'reply.custom.title': 'Custom instructions',
      'reply.custom.description': 'Extra instructions about expression; override the length and style settings above',
      'reply.custom.placeholder': 'e.g. Lead with the conclusion; explain terms in one Chinese sentence; avoid "firstly/secondly".',
      'settings.title': 'Show predicted messages',
      'settings.description': 'Predict what you might send next based on the conversation',
      'settings.turnLine': 'Line above the composer',
      'settings.turnLine.note': 'This line is UI only and never enters the model context. The first three modes are local; only the semantic summary calls a model.',
      'settings.recap.title': 'Semantic summary',
      'settings.recap.description': 'Every few turns, one cheap-model line describing where things stand',
      'settings.recapActivity.title': 'Activity stream',
      'settings.recapActivity.description': 'Reading files, running commands, editing code; local, no model call (off by default)',
      'settings.recapTiming.title': 'Elapsed time',
      'settings.recapTiming.description': 'How long this turn has run; local (off by default)',
      'settings.recapReasoning.title': 'Thinking preview',
      'settings.recapReasoning.description': 'First line of the folded reasoning; local, no model call (off by default)',
      'settings.recapPlacement.title': 'Placement',
      'settings.recapPlacement.description': 'Show the line above or below the composer',
      'settings.recapPlacement.above': 'Above the composer',
      'settings.recapPlacement.below': 'Below the composer',
      'settings.recapAdvanced': 'Advanced (rarely needed)',
      'settings.recapAdvancedHide': 'Hide advanced settings',
      'settings.recapMinTurns.title': 'Start after',
      'settings.recapMinTurns.description': 'User messages required before a semantic summary starts',
      'settings.recapCooldownTurns.title': 'Update every',
      'settings.recapCooldownTurns.description': 'Turns between summary updates; 1 means every turn',
      'settings.recapSimilarityThreshold.title': 'Keep-when-similar threshold',
      'settings.recapSimilarityThreshold.description': 'Keep the previous line when the new summary is at least this similar (0–1)',
      'settings.recapMaxWords.title': 'Summary length',
      'settings.recapMaxWords.description': 'Word budget; Chinese counts by character',
      'settings.recapModelChain.title': 'Summary model chain',
      'settings.recapModelChain.description': 'Try provider/model in order. Empty picks cheap models automatically, then falls back to the current default',
      'settings.recapModelChain.placeholder': 'deepseek-v4-flash, deepseek-chat',
      'settings.btwHint': 'Tip: the Aside tab in the WDX Relief panel asks the current model; pick a model at the bottom. The exchange never enters the model context.',
      'settings.summary': 'Predict the next message, keep a live line above the composer, and use the right panel for unanswered items, recap history, and side questions that stay out of context.',
      'turn.reasoning': 'Thinking',
      'turn.pending': 'no reply yet',
      'turn.dismiss': 'Hide this line',
      'turn.thinking': 'Thinking…',
      'turn.answering': 'Replying…',
      'turn.tool': 'Running a tool…',
      'turn.verb.read': 'Read',
      'turn.verb.write': 'Edit',
      'turn.verb.command': 'Run',
      'turn.verb.search': 'Find',
      'turn.verb.web': 'Fetch',
      'turn.verb.todo': 'Update todos',
      'turn.verb.delegate': 'Delegate',
      'turn.verb.present': 'Prepare deliverable',
      'turn.verb.ask': 'Waiting on you',
      'turn.verb.skill': 'Load skill',
      'turn.verb.other': 'Call',
      'settings.today.title': 'Collect what you never answered',
      'settings.today.description': 'Turn reminders from past sessions that you never handled into a short list',
      'panel.title': 'WDX Relief',
      'panel.guide': 'Collect the reminders you never got back to, and ask aside',
      'panel.refresh': 'Refresh',
      'panel.retry': 'Retry',
      'panel.empty': 'Nothing waiting on you in the last two weeks',
      'panel.unavailable': 'This profile has no session query service, so there is nothing to collect',
      'panel.error': 'Could not collect; try again later.',
      'panel.degraded': 'The model did not finish; this list is keyword-picked',
      'panel.ageShort': '{hours}h',
      'section.untouched': 'Never answered',
      'section.recaps': 'Recaps',
      'panel.recapEmpty': 'No summary yet; one will appear after the third turn',
      'panel.recapError': 'Could not read recap history',
      'panel.recapRouteMissing': 'The recap history route is not loaded; restart DSH and try again',
      'panel.recapCount': '{count} entries',
      'panel.recapClear': 'Clear',
      'panel.recapRequest': 'Asked',
      'panel.recapReply': 'Replied',
      'panel.recapQuestion': 'Waiting on',
      'section.btw': 'Aside',
      'btw.placeholder': 'Ask anything…',
      'btw.ask': 'Ask',
      'btw.asking': 'Answering…',
      'btw.stop': 'Stop',
      'btw.clear': 'Clear',
      'btw.empty': 'No side questions yet',
      'btw.error': 'Side question failed',
      'btw.noSession': 'Open a session first so the aside can use its context.',
      'btw.cancelled': 'Cancelled',
      'btw.model': 'Model',
      'btw.modelLoading': 'Loading models…',
      'btw.modelHint': 'Model for this aside; it does not change the main session',
      'btw.routeMissing': 'The aside route is not loaded yet; restart DSH and try again.',
      'prediction.accept': 'Press Tab to insert the prediction',
      'form.unavailable': 'Configuration is unavailable.',
      'form.readOnly': 'This deployment stores settings read-only.',
      'form.saveFailed': 'The deployment did not accept these values; they were left for you to correct.',
      'form.save': 'Save',
      'form.saving': 'Saving…',
      'form.reset': 'Reset to default',
    }

    function tr(t, key, fallback) {
      if (t) {
        var value = t(key)
        if (value !== key) return value
      }
      return fallback
    }

    /** 带参数的本地化；t 不支持参数时按 fallback 模板替换。 */
    function trf(t, key, params, fallback) {
      if (t) {
        try {
          var value = t(key, params)
          if (value !== key) return value
        } catch (error) {
          // 缺少参数时退回本地文案。
        }
      }
      var text = fallback
      Object.keys(params).forEach(function (name) {
        text = text.split('{' + name + '}').join(String(params[name]))
      })
      return text
    }

    // --------------------------------------------------------------- host

    /** 一次预测 RPC；失败抛错，调用方静默处理。 */
    async function requestPrediction(sessionId, signal) {
      var response = await fetch(RPC_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
        signal: signal,
      })
      var body
      try {
        body = await response.json()
      } catch (error) {
        throw new Error('invalid prediction response')
      }
      if (!body || body.ok !== true) {
        var failure = body && body.error ? body.error : {}
        throw new Error(failure.message || 'prediction failed')
      }
      var value = body.data && body.data.suggestion
      return typeof value === 'string' && value !== '' ? value : null
    }

    /** 一次回顾 RPC；空会话或失败都返回 null，调用方不显示任何东西。 */
    async function requestRecap(sessionId, signal) {
      var response = await fetch(RECAP_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
        signal: signal,
      })
      var body
      try {
        body = await response.json()
      } catch (error) {
        return null
      }
      if (!body || body.ok !== true) return null
      var value = body.data && body.data.recap
      if (!value || typeof value !== 'object') return null
      return value
    }

    /**
     * 一次「没接住的事」RPC。
     * 返回 { items } / { unavailable } / { disabled }；网络或服务失败返回 { error }。
     */
    async function requestToday(sessionId, signal, force) {
      var headers = { 'content-type': 'application/json' }
      if (force) headers['x-wdx-force'] = '1'
      var response
      try {
        response = await fetch(TODAY_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: headers,
          body: JSON.stringify({ sessionId: sessionId }),
          signal: signal,
        })
      } catch (error) {
        var reason = error && error.name === 'AbortError' ? '请求被取消' : String((error && error.message) || error)
        return { error: true, message: '请求失败：' + reason }
      }
      var text = ''
      try {
        text = await response.text()
      } catch (error) {
        return { error: true, message: 'HTTP ' + response.status + ' · 读取响应失败' }
      }
      var body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch (error) {
        var snippet = text.replace(/\s+/g, ' ').slice(0, 140)
        return { error: true, message: 'HTTP ' + response.status + ' · ' + (snippet || '空响应') }
      }
      if (!body || body.ok !== true) {
        var failure = body && body.error ? body.error : {}
        var detail = typeof failure.message === 'string' && failure.message !== '' ? failure.message : 'HTTP ' + response.status
        return { error: true, message: detail }
      }
      var data = body.data || {}
      if (data.unavailable) return { unavailable: true }
      if (data.disabled) return { disabled: true }
      var items = Array.isArray(data.items) ? data.items : []
      return {
        items: items.filter(function (item) {
          return item && typeof item.text === 'string' && item.text !== '' && typeof item.sessionId === 'string'
        }),
        degraded: data.degraded === true,
        detail: typeof data.detail === 'string' ? data.detail : '',
      }
    }

    /**
     * 一次旁问 RPC。
     * 返回 { answer } 或 { error, message }；取消由调用方根据 AbortError 处理。
     */
    async function requestBtw(sessionId, question, selection, signal) {
      var payload = { sessionId: sessionId, question: question }
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        payload.provider = selection.provider
        payload.model = selection.model
      }
      var response
      try {
        response = await fetch(BTW_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: signal,
        })
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        var reason = String((error && error.message) || error)
        return { error: true, message: '请求失败：' + reason }
      }
      if (response.status === 404) {
        return { error: true, code: 'route-missing', message: '旁问路由未加载；请重启 DSH 后再试。' }
      }
      var text = ''
      try {
        text = await response.text()
      } catch (error) {
        return { error: true, message: 'HTTP ' + response.status + ' · 读取响应失败' }
      }
      var body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch (error) {
        var snippet = text.replace(/\s+/g, ' ').slice(0, 140)
        return { error: true, message: 'HTTP ' + response.status + ' · ' + (snippet || '空响应') }
      }
      if (!body || body.ok !== true) {
        var failure = body && body.error ? body.error : {}
        var detail = typeof failure.message === 'string' && failure.message !== '' ? failure.message : 'HTTP ' + response.status
        return { error: true, message: detail }
      }
      var answer = body.data && body.data.answer
      if (typeof answer !== 'string' || answer === '') return { error: true, message: '模型没有返回可用的回答。' }
      return { answer: answer }
    }

    /** 某个会话生成过的 recap 历史；失败返回 error，调用方决定怎么显示。 */
    async function requestRecapHistory(sessionId, signal, clear) {
      var response
      try {
        response = await fetch(RECAPS_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clear === true ? { sessionId: sessionId, clear: true } : { sessionId: sessionId }),
          signal: signal,
        })
      } catch (error) {
        return { error: true }
      }
      var text = ''
      if (response.status === 404) return { error: true, code: 'route-missing' }
      try {
        text = await response.text()
      } catch (error) {
        return { error: true }
      }
      var body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch (error) {
        return { error: true }
      }
      if (!body || body.ok !== true) return { error: true }
      var items = body.data && Array.isArray(body.data.items) ? body.data.items : []
      return {
        items: items.filter(function (item) {
          return item && typeof item.summary === 'string' && item.summary !== ''
        }),
      }
    }

    function formatRecapTime(at) {
      var date = new Date(at)
      if (isNaN(date.getTime())) return ''
      var pad = function (value) { return (value < 10 ? '0' : '') + value }
      var clock = pad(date.getHours()) + ':' + pad(date.getMinutes())
      var now = new Date()
      if (date.toDateString() === now.toDateString()) return clock
      return (date.getMonth() + 1) + '/' + date.getDate() + ' ' + clock
    }

    // ---------------------------------------------------------- prediction

    /**
     * 输入框里的灰字预测（Codex 式）。
     * 这是用户明确选择保留的体验：建议叠在空输入框的光标起点上，而不是变成输入框外的一行。
     * 定位仍读取 composer 的布局矩形；这是该视觉方案的代价，组件只在
     * `conversation.input.overlay` 自己的浮层里读写，不改动宿主 DOM 的结构。
     */
    function PredictionOverlay(props) {
      var useSession = props.useSession
      var useInput = props.useInput
      var useSettings = props.useSettings
      var inputActions = props.inputActions
      var t = props.t
      var sessionId = props.sessionId

      // 这些 Hook 由 slot 标准 props 提供；给一个稳定 fallback，避免配置缺失时整块 UI 消失。
      var running = (useSession ? useSession(function (s) { return s && s.running }) : false) || false
      var input = (useInput ? useInput(function (s) { return s }) : undefined) || {}
      var settings = useSettings ? useSettings(function (s) { return s }) : undefined
      var enabled = !settings || !settings.value || settings.value.enabled !== false

      var draft = typeof input.draft === 'string' ? input.draft : ''
      var attachments = Array.isArray(input.attachmentIds) ? input.attachmentIds.length : 0
      var phase = input.phase || 'inert'

      var anchorRef = useRef(null)
      var requestSeq = useRef(0)
      var [prediction, setPrediction] = useState(null)
      var [dismissed, setDismissed] = useState('')
      var [box, setBox] = useState(null)

      var idle = enabled && !running && phase === 'plain' && draft.trim() === '' && attachments === 0
      var suggestion = idle && prediction !== null && prediction.text !== dismissed ? prediction.text : ''

      // 切会话时清掉上一条会话的预测与定位。
      useEffect(function () {
        setPrediction(null)
        setDismissed('')
        setBox(null)
      }, [sessionId])

      // 空闲、空输入、开关开启时，去 Host 拿一次预测。服务端按 session.seq 缓存。
      useEffect(function () {
        if (!enabled || running || phase !== 'plain' || draft.trim() !== '' || attachments > 0) return undefined
        var controller = new AbortController()
        var seq = ++requestSeq.current
        var timer = setTimeout(function () {
          requestPrediction(sessionId, controller.signal)
            .then(function (text) {
              if (seq !== requestSeq.current) return
              setPrediction(text === null ? null : { text: text })
            })
            .catch(function (error) {
              if (seq !== requestSeq.current) return
              if (error && error.name === 'AbortError') return
              setPrediction(null)
            })
        }, 350)
        return function () {
          clearTimeout(timer)
          controller.abort()
          requestSeq.current += 1
        }
      }, [enabled, running, phase, draft, attachments, sessionId])

      // 测量编辑器位置；输入框尺寸变化时重测。
      useLayoutEffect(function () {
        if (suggestion === '') return undefined
        var measure = function () {
          var anchor = anchorRef.current
          var card = anchor && anchor.closest('[data-composer-card]')
          var editor = card && card.querySelector('[data-composer-input]')
          if (!card || !editor) return
          var cardRect = card.getBoundingClientRect()
          var rect = editor.getBoundingClientRect()
          var style = window.getComputedStyle(editor)
          var padTop = parseFloat(style.paddingTop) || 4
          var padLeft = parseFloat(style.paddingLeft) || 14
          var padRight = parseFloat(style.paddingRight) || 8
          setBox({
            top: rect.top - cardRect.top + padTop,
            left: rect.left - cardRect.left + padLeft,
            width: Math.max(0, rect.width - padLeft - padRight),
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            fontFamily: style.fontFamily,
          })
        }
        measure()
        var anchor = anchorRef.current
        var card = anchor && anchor.closest('[data-composer-card]')
        var editor = card && card.querySelector('[data-composer-input]')
        var observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (observer && card) observer.observe(card)
        if (observer && editor) observer.observe(editor)
        window.addEventListener('resize', measure)
        return function () {
          if (observer) observer.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [suggestion, sessionId, draft])

      var visible = suggestion !== '' && box !== null

      // 灰字出现时藏掉原生 placeholder，避免两层文字叠在一起。
      useEffect(function () {
        if (!visible) return undefined
        var card = anchorRef.current && anchorRef.current.closest('[data-composer-card]')
        var placeholder = card && card.querySelector('[data-composer-placeholder]')
        if (!placeholder) return undefined
        var previous = placeholder.style.visibility
        placeholder.style.visibility = 'hidden'
        return function () {
          placeholder.style.visibility = previous
        }
      }, [visible, suggestion])

      function accept() {
        if (suggestion === '') return
        try {
          if (inputActions && typeof inputActions.setDraft === 'function') {
            inputActions.setDraft(suggestion)
            if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
          }
        } catch (error) {
          // 编辑器锁定时 setDraft 会失败；保持预测可见即可。
        }
        // 只收起当前建议，不把这条建议标记为“忽略”；用户把填入内容删空后，
        // 同一轮缓存会重新给出它，体验和 Codex 一致。
        setPrediction(null)
        var card = anchorRef.current && anchorRef.current.closest('[data-composer-card]')
        var editor = card && card.querySelector('[data-composer-input]')
        if (editor) setTimeout(function () { editor.focus({ preventScroll: true }) }, 0)
      }

      // Tab 填入、Escape 暂时忽略。只在编辑器持有焦点时拦截，避免抢别的快捷键。
      useEffect(function () {
        if (!visible) return undefined
        var onKeyDown = function (event) {
          if (event.isComposing || event.repeat) return
          var anchor = anchorRef.current
          var card = anchor && anchor.closest('[data-composer-card]')
          var editor = card && card.querySelector('[data-composer-input]')
          var active = document.activeElement
          var focused = editor !== null && editor !== undefined && (active === editor || editor.contains(active))

          if (event.key === 'Escape' && focused && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault()
            event.stopPropagation()
            setDismissed(suggestion)
            return
          }
          if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
          if (!focused) return
          event.preventDefault()
          event.stopPropagation()
          accept()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return function () {
          window.removeEventListener('keydown', onKeyDown, true)
        }
      }, [visible, suggestion])

      return h('div', { ref: anchorRef, style: { position: 'relative', width: '100%', height: 0 } },
        visible
          ? h('div', {
              'data-wdx-prediction': true,
              title: tr(t, 'prediction.accept', 'Press Tab to insert the prediction'),
              style: {
                position: 'absolute',
                top: box.top + 'px',
                left: box.left + 'px',
                width: box.width + 'px',
                display: 'inline-flex',
                alignItems: 'flex-start',
                gap: '6px',
                pointerEvents: 'none',
                userSelect: 'none',
                zIndex: 1,
              },
            }, [
              h('span', {
                key: 'text',
                'aria-hidden': true,
                style: {
                  color: 'var(--dsw-alias-label-caption)',
                  fontSize: box.fontSize,
                  lineHeight: box.lineHeight,
                  fontFamily: box.fontFamily,
                  minWidth: 0,
                  flex: '0 1 auto',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  opacity: 0.9,
                },
              }, suggestion),
              h('button', {
                key: 'key',
                type: 'button',
                title: tr(t, 'prediction.accept', 'Press Tab to insert the prediction'),
                'aria-label': tr(t, 'prediction.accept', 'Press Tab to insert the prediction') + ': ' + suggestion,
                onPointerDown: function (event) {
                  if (event.button !== 0) return
                  event.preventDefault()
                  event.stopPropagation()
                  accept()
                },
                onClick: function (event) {
                  if (event.detail === 0) accept()
                },
                style: {
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                  flex: 'none',
                  marginTop: '2px',
                  height: '18px',
                  lineHeight: '18px',
                  padding: '0 4px',
                  borderRadius: '4px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-caption)',
                  fontSize: '10px',
                  fontFamily: 'ui-monospace, Menlo, monospace',
                  opacity: 0.75,
                },
              }, 'Tab'),
            ])
          : null)
    }

    // ------------------------------------------------------- turn line

    /**
     * 输入框上方（或下方）的一行：把「这一轮在做什么」压成一句。
     *
     * 四种语义各自独立开关：
     * - activity：活动流水，读文件 / 跑命令 / 改代码，本地零成本；
     * - timing：这一轮耗时，本地零成本；
     * - reasoning：折叠推理的第一行，本地零成本；
     * - summary：语义摘要，走 Host 的便宜模型链，不进入模型上下文。
     *
     * 前三种只读会话事件；第四种由 `POST /api/wdx-relief/recap` 生成。
     * 这一行永远不写回会话，也不进入下一次模型请求。
     */

    var TOOL_VERBS = {
      read: 'read',
      read_file: 'read',
      fs_read: 'read',
      write: 'write',
      write_file: 'write',
      edit: 'write',
      replace: 'write',
      apply_patch: 'write',
      str_replace: 'write',
      bash: 'command',
      shell: 'command',
      exec: 'command',
      command: 'command',
      terminal: 'command',
      glob: 'search',
      find: 'search',
      ls: 'search',
      list: 'search',
      grep: 'search',
      rg: 'search',
      search: 'search',
      web_search: 'web',
      web_fetch: 'web',
      todo_write: 'todo',
      subagent: 'delegate',
      subagent_fork: 'delegate',
      workflow: 'delegate',
      present: 'present',
      ask_user_question: 'ask',
      skill: 'skill',
    }

    function eventOf(entry) {
      return entry && entry.event ? entry.event : entry
    }

    function objectOf(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function clipText(text, maxChars) {
      var value = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
      if (value.length <= maxChars) return value
      return value.slice(0, maxChars).trim() + '…'
    }

    function baseName(path) {
      var value = String(path || '').replace(/[\\/]+$/u, '')
      var parts = value.split(/[\\/]/u)
      return parts[parts.length - 1] || value
    }

    function parseArguments(raw) {
      if (raw && typeof raw === 'object') return raw
      if (typeof raw !== 'string' || raw.trim() === '') return {}
      try {
        return JSON.parse(raw)
      } catch (error) {
        return {}
      }
    }

    /** 把工具名和参数压成「动词 + 对象」，供活动流水展示。 */
    function describeToolCall(name, rawArguments) {
      var tool = String(name || '')
      var args = parseArguments(rawArguments)
      var verb = TOOL_VERBS[tool]
      if (verb === undefined) {
        if (/read|cat|open/u.test(tool)) verb = 'read'
        else if (/write|edit|patch|replace/u.test(tool)) verb = 'write'
        else if (/bash|shell|exec|command|terminal/u.test(tool)) verb = 'command'
        else if (/search|grep|glob|find/u.test(tool)) verb = 'search'
        else if (/web|fetch/u.test(tool)) verb = 'web'
        else verb = 'other'
      }

      var target = ''
      if (verb === 'read' || verb === 'write') {
        target = baseName(args.file_path || args.path || args.file || args.filename || '')
      } else if (verb === 'command') {
        target = clipText(args.command || args.cmd || args.script || '', 28)
      } else if (verb === 'search') {
        target = clipText(args.pattern || args.query || args.glob || args.path || '', 28)
      } else if (verb === 'web') {
        target = clipText(args.query || args.url || '', 28)
      } else if (verb === 'delegate') {
        target = clipText(args.description || args.prompt || args.name || '', 24)
      } else if (verb === 'present') {
        target = clipText(args.title || args.path || '', 24)
      } else if (verb === 'ask') {
        target = clipText(args.question || args.header || '', 24)
      } else if (verb === 'skill') {
        target = clipText(args.name || args.skill || '', 24)
      } else if (verb === 'todo') {
        target = clipText(args.title || '', 24)
      }

      return { verb: verb, target: target }
    }

    function toolLabel(tool, t) {
      if (!tool) return ''
      var verb = tr(t, 'turn.verb.' + tool.verb, tool.verb === 'other' ? '调用' : tool.verb)
      return tool.target ? verb + ' ' + tool.target : verb
    }

    function reasoningFromContent(content) {
      if (!Array.isArray(content)) return ''
      var text = ''
      for (var index = 0; index < content.length; index += 1) {
        var block = content[index]
        if (!block || typeof block !== 'object') continue
        if (block.type === 'reasoning' || block.kind === 'reasoning') {
          text += String(block.text || '')
        }
      }
      return text
    }

    function cleanReasoning(text) {
      var value = String(text || '')
      if (value.charAt(0) === '<') {
        var end = value.indexOf('</signature>')
        if (end !== -1) value = value.slice(end + 12)
        else if (value.indexOf('<signature>') === 0) return ''
      }
      return value
    }

    /** 折叠预览取「最后一个完整段落的第一行」，避免每来一个字就跳。 */
    function latestReasoningLine(text) {
      var value = cleanReasoning(text)
      if (value.trim() === '') return ''
      var paragraphs = value.split(/\r?\n(?:[\t ]*\r?\n)+/u)
      var latest = paragraphs[paragraphs.length - 1]
      var line = latest.split(/\r?\n/u)[0] || ''
      if (line.trim() === '') line = paragraphs[0].split(/\r?\n/u)[0] || ''
      return clipText(line.replace(/^[-*+>#\s]+/u, '').replace(/[*_`~]/g, ''), 56)
    }

    function eventTurn(event) {
      var data = objectOf(event && event.data)
      return typeof data.turn === 'number' ? data.turn : 0
    }

    /**
     * 从事件窗口里推导当前这一轮。
     * @param {Array<object>} entries - `binding.eventSource.getSnapshot().entries`
     * @param {number} now - 当前时间，用来在运行中累计耗时
     * @param {{ running?: boolean }} [options]
     * @returns {{ turn: number, running: boolean, startedAt: number, elapsedMs: number, actions: Array<object>, tool: object|null, reasoning: string, phase: string }}
     */
    function deriveTurnView(entries, now, options) {
      var list = Array.isArray(entries) ? entries : []
      var anchor = -1
      var turn = 0
      for (var index = list.length - 1; index >= 0; index -= 1) {
        var candidate = eventOf(list[index])
        if (candidate && candidate.type === 'turn/start') {
          turn = eventTurn(candidate)
          anchor = index
          break
        }
      }
      if (anchor === -1) {
        for (var fallbackIndex = list.length - 1; fallbackIndex >= 0; fallbackIndex -= 1) {
          var fallbackEvent = eventOf(list[fallbackIndex])
          var fallbackTurn = eventTurn(fallbackEvent)
          if (fallbackTurn > 0) {
            turn = fallbackTurn
            anchor = fallbackIndex
            break
          }
        }
        if (anchor === -1) {
          return { turn: 0, running: false, startedAt: 0, elapsedMs: 0, actions: [], tool: null, reasoning: '', phase: 'idle' }
        }
        while (anchor > 0 && eventTurn(eventOf(list[anchor - 1])) === turn) anchor -= 1
      }

      var first = eventOf(list[anchor]) || {}
      var startedAt = typeof first.time === 'number' ? first.time : (typeof now === 'number' ? now : Date.now())
      var lastTime = startedAt
      var endedAt = 0
      var actions = []
      var tool = null
      var reasoning = ''
      var phase = 'thinking'

      for (var cursor = anchor; cursor < list.length; cursor += 1) {
        var event = eventOf(list[cursor])
        if (!event) continue
        var candidateTurn = eventTurn(event)
        if (candidateTurn !== 0 && candidateTurn !== turn) {
          if (candidateTurn > turn) break
          continue
        }
        var data = objectOf(event.data)
        if (typeof event.time === 'number') lastTime = event.time

        if (event.type === 'step/start') {
          phase = 'thinking'
          reasoning = ''
        } else if (event.type === 'tool/call') {
          var described = describeToolCall(data.name, data.arguments)
          tool = { callId: data.callId, verb: described.verb, target: described.target, done: false, time: event.time }
          actions.push(tool)
          reasoning = ''
          phase = 'tool'
        } else if (event.type === 'tool/result') {
          var source = objectOf(objectOf(data.message).source)
          var resultId = source.callId
          if (tool !== null && (resultId === undefined || resultId === tool.callId)) {
            tool.done = true
            phase = 'tool-done'
          }
        } else if (event.type === 'assistant/live-chunk') {
          var chunk = objectOf(data.chunk)
          if (chunk.type === 'reasoning-delta') {
            reasoning += String(chunk.text || '')
            phase = 'reasoning'
          } else if (chunk.type === 'text-delta') {
            phase = 'answering'
          } else if (chunk.type === 'tool-call-delta') {
            phase = 'tool'
          } else if (chunk.type === 'block-start') {
            if (chunk.blockType === 'reasoning') {
              reasoning = ''
              phase = 'reasoning'
            } else if (chunk.blockType === 'text') {
              phase = 'answering'
            }
          }
        } else if (event.type === 'assistant/message') {
          var contentReasoning = reasoningFromContent(objectOf(data.message).content)
          if (contentReasoning !== '') reasoning = contentReasoning
          phase = 'answering'
        } else if (event.type === 'turn/end') {
          endedAt = lastTime
          phase = 'done'
        }
      }

      var running = endedAt === 0 && !(options && options.running === false)
      if (endedAt === 0 && options && options.running === false) endedAt = lastTime
      var elapsedMs = Math.max(0, (endedAt > 0 ? endedAt : (typeof now === 'number' ? now : Date.now())) - startedAt)

      return {
        turn: turn,
        running: running,
        startedAt: startedAt,
        elapsedMs: elapsedMs,
        actions: actions,
        tool: tool,
        reasoning: latestReasoningLine(reasoning),
        phase: phase,
      }
    }

    function formatDuration(ms) {
      var seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      if (seconds < 60) return seconds + 's'
      var minutes = Math.floor(seconds / 60)
      var rest = seconds % 60
      if (minutes < 60) return minutes + 'm ' + (rest < 10 ? '0' : '') + rest + 's'
      var hours = Math.floor(minutes / 60)
      return hours + 'h ' + (minutes % 60) + 'm'
    }

    /** 最近两个动作连成流水；没有工具时用阶段兜底。 */
    function activityText(view, t) {
      if (!view || view.turn === 0) return ''
      var all = Array.isArray(view.actions) ? view.actions : []
      if (all.length > 0) {
        var shown = all.slice(-2)
        var prefix = all.length > 2 ? '… → ' : ''
        return prefix + shown.map(function (item, index) {
          var label = toolLabel(item, t)
          if (index === shown.length - 1 && item.done === false) label += '…'
          return label
        }).join(' → ')
      }
      if (view.phase === 'reasoning') return tr(t, 'turn.thinking', '思考中…')
      if (view.phase === 'answering') return tr(t, 'turn.answering', '正在回复…')
      if (view.phase === 'tool') return tr(t, 'turn.tool', '调用工具…')
      return ''
    }

    /**
     * 组装这一行的各个片段。每个片段只由自己的开关控制，互不牵连。
     * @returns {Array<{ key: string, text: string, className: string }>}
     */
    function buildTurnSegments(view, settings, t, summary) {
      var segments = []
      if (!view || view.turn === 0) return segments
      if (settings.activity) {
        var activity = activityText(view, t)
        if (activity !== '') segments.push({ key: 'activity', text: activity, className: 'wdxt-activity' })
      }
      if (settings.timing && (view.running || view.elapsedMs >= 1000)) {
        segments.push({ key: 'time', text: formatDuration(view.elapsedMs), className: 'wdxt-time' })
      }
      if (settings.reasoning && view.reasoning !== '') {
        var label = tr(t, 'turn.reasoning', '思考')
        segments.push({ key: 'reasoning', text: label + '：' + view.reasoning, className: 'wdxt-reason' })
      }
      if (settings.summary && summary && summary.text) {
        segments.push({ key: 'summary', text: '※ ' + summary.text, className: 'wdxt-summary' })
      }
      return segments
    }

    function lineSettings(settings, placement) {
      var value = (settings && settings.value) || {}
      var configuredPlacement = value.recapPlacement === 'below' ? 'below' : 'above'
      return {
        activity: value.recapActivity === true,
        timing: value.recapTiming === true,
        reasoning: value.recapReasoning === true,
        summary: value.recap !== false,
        placement: placement === configuredPlacement,
      }
    }

    var RECAP_SEP = ' · '

    function formatRecap(recap, t) {
      if (!recap) return ''
      if (typeof recap.summary === 'string' && recap.summary.trim() !== '') return recap.summary.trim()
      if (recap.kind === 'question' || recap.question) {
        var question = recap.question || '…'
        return recap.user ? recap.user + RECAP_SEP + question : question
      }
      if (recap.kind === 'answered') {
        var user = recap.user || ''
        var assistant = recap.assistant || ''
        if (user !== '' && assistant !== '') return user + RECAP_SEP + assistant
        return user || assistant
      }
      if (recap.user) {
        return recap.user + RECAP_SEP + tr(t, 'turn.pending', '还没回复')
      }
      return recap.assistant || ''
    }

    /**
     * 输入框上方 / 下方的一行。
     *
     * 组件本身不写任何状态到会话；activity / timing / reasoning 来自事件窗口，
     * summary 来自 Host 的 `recap` 路由。开关全部在插件配置里，不进入 prompt。
     */
    function TurnRecapDock(props) {
      var sessionId = props.sessionId
      var placement = props.placement
      var useSession = props.useSession
      var useInput = props.useInput
      var useSettings = props.useSettings
      var readFeed = props.readFeed
      var t = props.t

      var running = (useSession ? useSession(function (s) { return s && s.running }) : false) || false
      var input = (useInput ? useInput(function (s) { return s }) : undefined) || {}
      var settings = useSettings ? useSettings(function (s) { return s }) : undefined
      var draft = typeof input.draft === 'string' ? input.draft : ''
      var attachments = Array.isArray(input.attachmentIds) ? input.attachmentIds.length : 0
      var cfg = lineSettings(settings, placement)

      var [entries, setEntries] = useState([])
      var [tick, setTick] = useState(0)
      var [summary, setSummary] = useState(null)
      var [dismissedTurn, setDismissedTurn] = useState(0)
      var requested = useRef('')
      var activeSession = useRef('')

      // 切换会话时清掉上一会话的摘要和请求去重键。
      useEffect(function () {
        setEntries([])
        setSummary(null)
        setDismissedTurn(0)
        requested.current = ''
        activeSession.current = ''
      }, [sessionId])

      // 只订阅事件窗口，不写会话。窗口由 Session Controller 维护。
      useEffect(function () {
        if (!sessionId || typeof readFeed !== 'function') {
          activeSession.current = ''
          setEntries([])
          return undefined
        }
        var feed = null
        try {
          feed = readFeed(sessionId)
        } catch (error) {
          feed = null
        }
        if (!feed) {
          activeSession.current = ''
          setEntries([])
          return undefined
        }
        activeSession.current = sessionId
        function update() {
          try {
            var snapshot = feed.getSnapshot()
            setEntries(snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [])
          } catch (error) {
            // 会话关闭时静默；下一次会话切换会重新订阅。
          }
        }
        update()
        return feed.subscribe(update)
      }, [sessionId, readFeed, running])

      void tick
      var view = deriveTurnView(entries, Date.now(), { running: running })

      // 运行中每秒刷新耗时；事件窗口本身不保证每秒都有新事件。
      useEffect(function () {
        if (!view.running) return undefined
        var timer = setInterval(function () {
          setTick(function (value) { return value + 1 })
        }, 1000)
        return function () { clearInterval(timer) }
      }, [view.running, view.turn])

      // 轮次结束后去 Host 要一次语义摘要。Host 侧按 minTurns / cooldown /
      // similarity 决定是否真的调用模型；这里只按轮次去重。
      useEffect(function () {
        if (!cfg.summary) {
          setSummary(null)
          requested.current = ''
          return undefined
        }
        if (!cfg.placement) return undefined
        if (!sessionId || running || view.turn === 0) return undefined
        if (activeSession.current !== sessionId) return undefined
        var key = sessionId + ':' + view.turn
        if (requested.current === key) return undefined
        requested.current = key
        var controller = new AbortController()
        requestRecap(sessionId, controller.signal).then(function (recap) {
          var text = formatRecap(recap, t)
          if (text !== '') setSummary({ text: text, turn: view.turn })
        }).catch(function () {
          // 摘要失败时静默：本地三种信息仍然可用，不打扰主任务。
        })
        return function () { controller.abort() }
      }, [cfg.summary, cfg.placement, sessionId, running, view.turn])

      if (!cfg.placement || !sessionId) return null
      if (draft.trim() !== '' || attachments > 0) return null

      // 运行中先展示本地活动；语义摘要只在上一条轮次结束后出现，避免把旧摘要说成这一轮。
      var visibleSummary = summary !== null && summary.turn === view.turn && !running ? summary : null
      var segments = buildTurnSegments(view, cfg, t, visibleSummary)
      if (segments.length === 0 || dismissedTurn === view.turn) return null

      var fullTitle = segments.map(function (segment) { return segment.text }).join(RECAP_SEP)
      var children = [h(PluginStyles, { key: 'style', scope: 'turn-line' })]
      for (var index = 0; index < segments.length; index += 1) {
        if (index > 0) children.push(h('span', { key: 'sep' + index, className: 'wdxt-sep' }, '·'))
        children.push(h('span', {
          key: segments[index].key,
          className: 'wdxt-seg ' + segments[index].className,
        }, segments[index].text))
      }
      children.push(h('button', {
        key: 'close',
        type: 'button',
        className: 'wdxt-close',
        title: tr(t, 'turn.dismiss', '收起这一行'),
        'aria-label': tr(t, 'turn.dismiss', '收起这一行'),
        onClick: function () { setDismissedTurn(view.turn) },
      }, '×'))

      return h('div', { className: 'wdxt-root', 'data-wdx-turn-line': true, 'data-placement': placement || 'above' }, [
        h('div', { className: 'wdxt-row', title: fullTitle }, children),
      ])
    }

    // --------------------------------------------------------------- relief

    /**
     * WDX Relief 的右侧栏页面。
     *
     * 页面是插件所有小功能的容器：每个功能一个 section，目前只有「没接住的事」。
     * 数据由 Host 侧 `/api/wdx-relief/today` 产生：只读会话尾部，一次模型调用做归并判断；
     * 模型失败时 Host 会退回关键词清单，并在响应里带 `degraded`，这里如实标注。
     */

    var RELIEF_TAB = 'wdx-relief'

    function ReliefIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('rect', { key: 'frame', x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { key: 'lines', d: 'M5.2 6.1h5.6M5.2 8.3h5.6M5.2 10.5h3.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      ])
    }

    function ReloadIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('path', {
          key: 'arrow',
          d: 'M12.8 6.4A5 5 0 1 0 13 9.4M12.8 2.6v3.8H9',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ])
    }

    /**
     * 读取当前会话的模型目录。模型选择服务缺失或子会话不公开目录时返回 null。
     */
    function useModelDirectory(modelDirectories, sessionId) {
      var [directory, setDirectory] = useState(null)
      var [state, setState] = useState(null)

      useEffect(function () {
        if (!modelDirectories || !sessionId) {
          setDirectory(null)
          setState(null)
          return undefined
        }
        var next
        try {
          next = modelDirectories.directoryFor(sessionId)
        } catch (error) {
          next = null
        }
        if (!next) {
          setDirectory(null)
          setState(null)
          return undefined
        }
        setDirectory(next)
        setState(next.store.getSnapshot())
        var unsubscribe = next.store.subscribe(function () {
          setState(next.store.getSnapshot())
        })
        next.load().catch(function () {
          // 目录加载失败时保留「模型」占位，旁问仍可用当前会话模型。
        })
        return function () {
          unsubscribe()
        }
      }, [modelDirectories, sessionId])

      return { directory: directory, state: state }
    }

    function modelMenuItems(state) {
      var items = []
      if (!state || !Array.isArray(state.groups)) return items
      for (var groupIndex = 0; groupIndex < state.groups.length; groupIndex += 1) {
        var group = state.groups[groupIndex]
        if (!group || !Array.isArray(group.models)) continue
        for (var modelIndex = 0; modelIndex < group.models.length; modelIndex += 1) {
          var model = group.models[modelIndex]
          if (!model || typeof model.id !== 'string') continue
          items.push({
            id: group.id + '/' + model.id,
            text: model.name || model.id,
            label: model.name || model.id,
            provider: group.id,
            model: model.id,
            group: { name: group.id, label: group.name || group.id },
          })
        }
      }
      return items
    }

    function modelNameOf(state, selection) {
      if (!state || !selection || !Array.isArray(state.groups)) return ''
      for (var groupIndex = 0; groupIndex < state.groups.length; groupIndex += 1) {
        var group = state.groups[groupIndex]
        if (!group || group.id !== selection.provider || !Array.isArray(group.models)) continue
        for (var modelIndex = 0; modelIndex < group.models.length; modelIndex += 1) {
          var model = group.models[modelIndex]
          if (model && model.id === selection.model) return model.name || model.id
        }
      }
      return ''
    }

    /**
     * 会话回顾历史：每次真正生成过一条 recap 就留一条，关掉 composer 上那行之后
     * 仍然可以在这里回看。只读本地记录，不重新生成。
     */
    function RecapHistorySection(props) {
      var sessionId = props.sessionId
      var t = props.t
      var [state, setState] = useState({ status: 'loading', items: [] })
      var [openSeq, setOpenSeq] = useState(null)
      var controllerRef = useRef(null)

      function load() {
        if (!sessionId) {
          setState({ status: 'empty', items: [] })
          return
        }
        if (controllerRef.current) controllerRef.current.abort()
        var controller = new AbortController()
        controllerRef.current = controller
        setState({ status: 'loading', items: [] })
        requestRecapHistory(sessionId, controller.signal).then(function (result) {
          if (controller.signal.aborted) return
          if (result.error) {
            setState({ status: 'error', items: [], code: result.code || '' })
            return
          }
          var items = result.items || []
          setState({ status: items.length === 0 ? 'empty' : 'ready', items: items })
        }).catch(function () {
          if (!controller.signal.aborted) setState({ status: 'error', items: [] })
        })
      }

      function clearAll() {
        if (!sessionId) return
        if (controllerRef.current) controllerRef.current.abort()
        var controller = new AbortController()
        controllerRef.current = controller
        requestRecapHistory(sessionId, controller.signal, true).then(function (result) {
          if (controller.signal.aborted || result.error) return
          setOpenSeq(null)
          setState({ status: 'empty', items: [] })
        }).catch(function () {
          // 清空失败保持原列表。
        })
      }

      useEffect(function () {
        load()
        return function () {
          if (controllerRef.current) controllerRef.current.abort()
        }
      }, [sessionId])

      var body
      if (state.status === 'loading') {
        body = h('div', { key: 'skeleton', className: 'wdxp-skeleton' }, [
          h('div', { key: 'a', className: 'wdxp-skeletonRow' }),
          h('div', { key: 'b', className: 'wdxp-skeletonRow' }),
        ])
      } else if (state.status === 'error') {
        body = h('p', { key: 'error', className: 'wdxp-note' },
          state.code === 'route-missing'
            ? tr(t, 'panel.recapRouteMissing', '回顾历史路由没加载；重启 DSH 后再试')
            : tr(t, 'panel.recapError', '回顾历史读取失败'))
      } else if (state.status === 'empty') {
        body = h('p', { key: 'empty', className: 'wdxp-note' }, tr(t, 'panel.recapEmpty', '还没有生成过摘要；聊到第三轮就会出现第一条'))
      } else {
        body = h('div', { key: 'rows', className: 'wdxp-rows' }, [
          h('div', { key: 'toolbar', className: 'wdxh-toolbar' }, [
            h('span', { key: 'count', className: 'wdxh-count' },
              trf(t, 'panel.recapCount', { count: state.items.length }, '共 ' + state.items.length + ' 条')),
            h('button', {
              key: 'clear',
              type: 'button',
              className: 'wdxp-link',
              onClick: clearAll,
            }, tr(t, 'panel.recapClear', '清空')),
          ]),
          h('ul', { key: 'list', className: 'wdxp-list' }, state.items.map(function (item) {
          var open = openSeq === item.seq
          return h('li', { key: String(item.seq), className: 'wdxp-item' }, [
            h('button', {
              key: 'row',
              type: 'button',
              className: 'wdxp-row wdxh-row',
              title: item.summary,
              'aria-expanded': open,
              onClick: function () { setOpenSeq(open ? null : item.seq) },
            }, [
              h('span', { key: 'text', className: 'wdxp-rowText' }, item.summary),
              h('span', { key: 'time', className: 'wdxp-rowMeta' }, formatRecapTime(item.at)),
            ]),
            open
              ? h('div', { key: 'detail', className: 'wdxh-detail' }, [
                  item.user !== '' ? h('p', { key: 'q', className: 'wdxh-line' }, [
                    h('span', { key: 'label', className: 'wdxh-label' }, tr(t, 'panel.recapRequest', '要求')),
                    item.user,
                  ]) : null,
                  item.assistant !== '' ? h('p', { key: 'a', className: 'wdxh-line' }, [
                    h('span', { key: 'label', className: 'wdxh-label' }, tr(t, 'panel.recapReply', '回复')),
                    item.assistant,
                  ]) : null,
                  item.question !== '' ? h('p', { key: 'ask', className: 'wdxh-line' }, [
                    h('span', { key: 'label', className: 'wdxh-label' }, tr(t, 'panel.recapQuestion', '待回答')),
                    item.question,
                  ]) : null,
                ])
              : null,
          ])
          })),
        ])
      }

      return h('div', { className: 'wdxp-body' }, body)
    }

    /**
     * 右侧面板里的「旁问」区。
     *
     * 问题直接走 Host 的 `/api/wdx-relief/btw`，不经过命令、不写会话；
     * 回答只保存在这个组件的内存里，面板关闭或切换会话就消失。
     */
    function BtwSection(props) {
      var sessionId = props.sessionId
      var modelDirectories = props.modelDirectories
      var t = props.t
      var [draft, setDraft] = useState('')
      var [items, setItems] = useState([])
      var [asking, setAsking] = useState(false)
      var [override, setOverride] = useState(null)
      var [compactModel, setCompactModel] = useState(false)
      var askingRef = useRef(false)
      var controllerRef = useRef(null)
      var toolbarRef = useRef(null)
      var measureRef = useRef(null)
      var modelDir = useModelDirectory(modelDirectories, sessionId)
      var modelState = modelDir.state
      var modelItems = modelMenuItems(modelState)
      var selection = override || (modelState && modelState.current) || null
      var selectionName = modelNameOf(modelState, selection)
      var modelDisplay = selectionName
        || (modelState && modelState.status === 'loading' ? tr(t, 'btw.modelLoading', '加载模型…') : tr(t, 'btw.model', '模型'))

      useEffect(function () {
        setDraft('')
        setItems([])
        setAsking(false)
        setOverride(null)
        askingRef.current = false
        if (controllerRef.current) controllerRef.current.abort()
        return function () {
          if (controllerRef.current) controllerRef.current.abort()
          askingRef.current = false
        }
      }, [sessionId])

      useLayoutEffect(function () {
        function measure() {
          var toolbar = toolbarRef.current
          var measuring = measureRef.current
          if (!toolbar || !measuring) return
          // 发送键 + 两侧间距 + 数据图标 + 箭头 + 内边距，给模型名留出剩余宽度。
          var reserved = 32 + 6 * 2 + 16 + 4 + 16 + 4 + 10 + 8
          var available = Math.min(Math.max(0, toolbar.clientWidth - reserved), 260)
          var nameWidth = measuring.scrollWidth
          setCompactModel(nameWidth > Math.max(0, available - 4))
        }
        measure()
        var toolbar = toolbarRef.current
        var observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (observer && toolbar) observer.observe(toolbar)
        window.addEventListener('resize', measure)
        return function () {
          if (observer) observer.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [modelDisplay, sessionId])

      function updateItem(id, patch) {
        setItems(function (prev) {
          return prev.map(function (item) {
            if (item.id !== id) return item
            var next = { ...item }
            Object.keys(patch).forEach(function (name) { next[name] = patch[name] })
            return next
          })
        })
      }

      function ask() {
        var question = draft.trim()
        if (!sessionId || question === '' || asking || askingRef.current) return
        var id = String(Date.now()) + '-' + Math.random().toString(36).slice(2)
        setItems(function (prev) {
          return [{ id: id, question: question, status: 'loading', answer: '', error: '' }].concat(prev).slice(0, 10)
        })
        setDraft('')
        askingRef.current = true
        setAsking(true)
        if (controllerRef.current) controllerRef.current.abort()
        var controller = new AbortController()
        controllerRef.current = controller
        requestBtw(sessionId, question, override, controller.signal).then(function (result) {
          if (controller.signal.aborted) return
          askingRef.current = false
          setAsking(false)
          if (result.error) {
            var message = result.code === 'route-missing'
              ? tr(t, 'btw.routeMissing', '旁问路由未加载；请重启 DSH 后再试。')
              : result.message || tr(t, 'btw.error', '旁问失败')
            updateItem(id, { status: 'error', error: message })
          } else {
            updateItem(id, { status: 'done', answer: result.answer })
          }
        }).catch(function (error) {
          if (controller.signal.aborted) return
          askingRef.current = false
          setAsking(false)
          updateItem(id, { status: 'error', error: String((error && error.message) || error) })
        })
      }

      function stop() {
        if (controllerRef.current) controllerRef.current.abort()
        askingRef.current = false
        setAsking(false)
        setItems(function (prev) {
          return prev.map(function (item) {
            return item.status === 'loading'
              ? { ...item, status: 'error', error: tr(t, 'btw.cancelled', '已取消') }
              : item
          })
        })
      }

      function clear() {
        if (asking) return
        setItems([])
      }

      function onKeyDown(event) {
        if (event.isComposing || event.keyCode === 229) return
        if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || event.shiftKey) return
        event.preventDefault()
        ask()
      }

      function chooseModel(id) {
        if (id === '') {
          setOverride(null)
          return
        }
        for (var index = 0; index < modelItems.length; index += 1) {
          if (modelItems[index].id === id) {
            setOverride({ provider: modelItems[index].provider, model: modelItems[index].model })
            break
          }
        }
      }

      var modelControl = h('div', {
        key: 'model',
        className: 'wdxa-modelWrap',
        style: modelItems.length === 0 ? { opacity: 0.55 } : undefined,
      }, [
        DATA_ICON ? h(DATA_ICON, { key: 'icon', size: 16, className: 'wdxa-modelIcon' }) : null,
        compactModel
          ? null
          : h('span', { key: 'name', className: 'wdxa-modelName', 'aria-hidden': true }, modelDisplay),
        h('span', {
          key: 'measure',
          ref: measureRef,
          className: 'wdxa-modelMeasure',
          'aria-hidden': true,
        }, modelDisplay),
        CHEVRON ? h(CHEVRON, { key: 'chevron', className: 'wdxa-modelChevron' }) : null,
        h('select', {
          key: 'select',
          className: 'wdxa-modelSelect',
          title: tr(t, 'btw.modelHint', '旁问使用的模型，不改变主会话'),
          'aria-label': tr(t, 'btw.modelHint', '旁问使用的模型，不改变主会话') + ': ' + modelDisplay,
          value: selection ? selection.provider + '/' + selection.model : '',
          disabled: modelItems.length === 0,
          onChange: function (event) { chooseModel(event.target.value) },
        }, [
          h('option', { key: 'none', value: '' }, tr(t, 'btw.model', '模型')),
          ...(modelState && Array.isArray(modelState.groups) ? modelState.groups : []).map(function (group) {
            return h('optgroup', { key: group.id, label: group.name || group.id },
              (group.models || []).map(function (model) {
                return h('option', { key: model.id, value: group.id + '/' + model.id }, model.name || model.id)
              }))
          }),
        ]),
      ])

      var sendIcon = asking
        ? h('svg', { key: 'icon', viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, focusable: 'false' },
            h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.5, fill: 'currentColor' }))
        : h('svg', { key: 'icon', viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, focusable: 'false' },
            h('path', {
              d: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',
              fill: 'currentColor',
            }))

      var sendButton = h('button', {
        key: 'send',
        type: 'button',
        className: 'wdxa-send',
        'aria-label': asking ? tr(t, 'btw.stop', '停止') : tr(t, 'btw.ask', '问'),
        title: asking ? tr(t, 'btw.stop', '停止') : '⌘/Ctrl + Enter',
        disabled: !asking && (!sessionId || draft.trim() === ''),
        onClick: asking ? stop : ask,
      }, sendIcon)

      var composer = sessionId
        ? h('div', { key: 'composer', className: 'wdxa-composer' }, [
            h('textarea', {
              key: 'input',
              className: 'wdxa-textarea',
              'aria-label': tr(t, 'section.btw', '旁问'),
              value: draft,
              maxLength: 4000,
              rows: 2,
              placeholder: tr(t, 'btw.placeholder', '问点什么…'),
              spellCheck: false,
              onChange: function (event) { setDraft(event.target.value) },
              onKeyDown: onKeyDown,
            }),
            h('div', { key: 'toolbar', ref: toolbarRef, className: 'wdxa-toolbar' }, [
              h('span', { key: 'spacer', className: 'wdxa-spacer' }),
              modelControl,
              sendButton,
            ]),
          ])
        : h('p', { key: 'nosession', className: 'wdxa-note' }, tr(t, 'btw.noSession', '先打开一个会话，才能带着上下文旁问。'))

      var list = items.length > 0
        ? h('div', { key: 'list', className: 'wdxa-list' }, items.map(function (item) {
            var body
            if (item.status === 'loading') {
              body = h('div', { key: 'body', className: 'wdxa-loading' }, tr(t, 'btw.asking', '回答中…'))
            } else if (item.status === 'error') {
              body = h('div', { key: 'body', className: 'wdxa-error' }, item.error || tr(t, 'btw.error', '旁问失败'))
            } else {
              body = h('div', { key: 'body', className: 'wdxa-answer' },
                MARKDOWN
                  ? h(MARKDOWN, { text: item.answer })
                  : h('pre', { className: 'wdxa-pre' }, item.answer))
            }
            return h('article', { key: item.id, className: 'wdxa-item' }, [
              h('div', { key: 'q', className: 'wdxa-q' }, item.question),
              body,
            ])
          }))
        : h('p', { key: 'empty', className: 'wdxa-note' }, tr(t, 'btw.empty', '还没有旁问'))

      return h('div', { className: 'wdxa-pane' }, [
        composer,
        list,
        items.length > 0 && !asking
          ? h('div', { key: 'meta', className: 'wdxa-meta' }, [
              h('button', { key: 'clear', type: 'button', className: 'wdxa-clear', onClick: clear }, tr(t, 'btw.clear', '清空')),
            ])
          : null,
      ])
    }

    function ReliefPanel(props) {
      var sessionId = props.sessionId
      var openSession = props.openSession
      var modelDirectories = props.modelDirectories
      var t = props.t
      var [tab, setTab] = useState('untouched')

      var [state, setState] = useState({ status: 'loading', items: [], degraded: false, detail: '' })
      var controllerRef = useRef(null)

      function load(force) {
        if (!sessionId) {
          setState({ status: 'empty', items: [], degraded: false, detail: '' })
          return
        }
        if (controllerRef.current) controllerRef.current.abort()
        var controller = new AbortController()
        controllerRef.current = controller
        setState({ status: 'loading', items: [], degraded: false, detail: '' })
        requestToday(sessionId, controller.signal, force === true).then(function (result) {
          if (controller.signal.aborted) return
          if (result.error) {
            setState({ status: 'error', items: [], degraded: false, detail: result.message || '' })
            return
          }
          if (result.unavailable || result.disabled) {
            setState({ status: 'unavailable', items: [], degraded: false, detail: '' })
            return
          }
          var items = result.items || []
          setState({
            status: items.length === 0 ? 'empty' : 'ready',
            items: items,
            degraded: result.degraded === true,
            detail: result.detail || '',
          })
        }).catch(function () {
          if (!controller.signal.aborted) setState({ status: 'error', items: [], degraded: false, detail: '' })
        })
      }

      useEffect(function () {
        load(false)
        return function () {
          if (controllerRef.current) controllerRef.current.abort()
        }
      }, [sessionId])

      var count = state.items.length
      var body
      if (state.status === 'loading') {
        body = h('div', { key: 'skeleton', className: 'wdxp-skeleton' }, [
          h('div', { key: 'a', className: 'wdxp-skeletonRow' }),
          h('div', { key: 'b', className: 'wdxp-skeletonRow' }),
          h('div', { key: 'c', className: 'wdxp-skeletonRow' }),
        ])
      } else if (state.status === 'unavailable') {
        body = h('p', { key: 'unavailable', className: 'wdxp-note' }, tr(t, 'panel.unavailable', '当前 profile 没有启用会话查询，无法整理'))
      } else if (state.status === 'error') {
        body = h('div', { key: 'error', className: 'wdxp-rows' }, [
          h('p', { key: 'note', className: 'wdxp-note' }, [
            h('span', { key: 'text' }, tr(t, 'panel.error', '整理失败，稍后再试。')),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'wdxp-link',
              onClick: function () { load(true) },
            }, tr(t, 'panel.retry', '重试')),
          ]),
          state.detail ? h('p', { key: 'detail', className: 'wdxp-degraded' }, state.detail) : null,
        ])
      } else if (state.status === 'empty') {
        body = h('p', { key: 'empty', className: 'wdxp-note' }, tr(t, 'panel.empty', '最近两周没有待你决定的事'))
      } else {
        body = h('div', { key: 'rows', className: 'wdxp-rows' }, [
          h('ul', { key: 'list', className: 'wdxp-list' }, state.items.map(function (item, index) {
            return h('li', { key: String(index), className: 'wdxp-item' }, [
              h('button', {
                key: 'open',
                type: 'button',
                className: 'wdxp-row',
                title: item.text,
                onClick: function () { if (typeof openSession === 'function') openSession(item.sessionId) },
              }, [
                h('span', { key: 'text', className: 'wdxp-rowText' }, item.text),
                typeof item.idleHours === 'number'
                  ? h('span', { key: 'meta', className: 'wdxp-rowMeta' }, trf(t, 'panel.ageShort', { hours: item.idleHours }, item.idleHours + ' 小时'))
                  : null,
              ]),
            ])
          })),
          state.degraded
            ? h('p', { key: 'degraded', className: 'wdxp-degraded', title: state.detail },
                tr(t, 'panel.degraded', '模型没整理成功，这份是按关键词挑的'))
            : null,
        ])
      }

      function tabClass(id) {
        return 'wdxp-tab' + (tab === id ? ' wdxp-tabActive' : '')
      }

      return h('div', { className: 'wdxp-page' }, [
        h(PluginStyles, { key: 'style', scope: 'relief' }),
        h('div', { key: 'tabs', className: 'wdxp-tabs', role: 'tablist' }, [
          h('button', {
            key: 'untouched',
            id: 'wdxp-tab-untouched',
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'untouched',
            'aria-controls': 'wdxp-pane-untouched',
            className: tabClass('untouched'),
            onClick: function () { setTab('untouched') },
          }, [
            h('span', { key: 'label' }, tr(t, 'section.untouched', '没接住的事')),
            count > 0 ? h('span', { key: 'count', className: 'wdxp-tabCount' }, String(count)) : null,
          ]),
          h('button', {
            key: 'recaps',
            id: 'wdxp-tab-recaps',
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'recaps',
            'aria-controls': 'wdxp-pane-recaps',
            className: tabClass('recaps'),
            onClick: function () { setTab('recaps') },
          }, tr(t, 'section.recaps', '会话回顾')),
          h('button', {
            key: 'btw',
            id: 'wdxp-tab-btw',
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'btw',
            'aria-controls': 'wdxp-pane-btw',
            className: tabClass('btw'),
            onClick: function () { setTab('btw') },
          }, tr(t, 'section.btw', '旁问')),
          tab === 'untouched'
            ? h('button', {
                key: 'refresh',
                type: 'button',
                className: 'wdxp-iconBtn',
                title: tr(t, 'panel.refresh', '刷新'),
                'aria-label': tr(t, 'panel.refresh', '刷新'),
                disabled: state.status === 'loading',
                onClick: function () { load(true) },
              }, h(ReloadIcon, { key: 'icon' }))
            : null,
        ]),
        h('div', {
          key: 'untouched',
          id: 'wdxp-pane-untouched',
          role: 'tabpanel',
          'aria-labelledby': 'wdxp-tab-untouched',
          className: 'wdxp-pane',
          hidden: tab !== 'untouched',
        }, body),
        h('div', {
          key: 'recaps',
          id: 'wdxp-pane-recaps',
          role: 'tabpanel',
          'aria-labelledby': 'wdxp-tab-recaps',
          className: 'wdxp-pane',
          hidden: tab !== 'recaps',
        }, tab === 'recaps' ? h(RecapHistorySection, { key: 'recaps-body', sessionId: sessionId, t: t }) : null),
        h('div', {
          key: 'btw',
          id: 'wdxp-pane-btw',
          role: 'tabpanel',
          'aria-labelledby': 'wdxp-tab-btw',
          className: 'wdxp-pane',
          hidden: tab !== 'btw',
        }, h(BtwSection, { key: 'btw-body', sessionId: sessionId, t: t, modelDirectories: modelDirectories })),
      ])
    }

    // --------------------------------------------------------- settings UI

    function oneOf(value, allowed) {
      return typeof value === 'string' && allowed.indexOf(value) !== -1 ? value : undefined
    }

    function readConfig(scope) {
      try {
        var snapshot = scope.getSnapshot()
        if (snapshot && snapshot.value && typeof snapshot.value === 'object') return snapshot.value
      } catch (error) {
        // 配置尚未就绪时按默认值显示。
      }
      return {}
    }

    function legacyStyle(scope) {
      var value = readConfig(scope)
      if (value.writingStyle === true) return 'follow'
      if (value.baseStyle === 'professional' || value.baseStyle === 'friendly' || value.baseStyle === 'blunt') return value.baseStyle
      return 'default'
    }

    function booleanText(value) {
      return value === false ? 'false' : 'true'
    }

    function parseBoolean(text) {
      if (text === 'true') return { kind: 'set', value: true }
      if (text === 'false') return { kind: 'set', value: false }
      return undefined
    }

    function choiceField(name, allowed, fallback) {
      return {
        field: name,
        format: function (value) {
          return oneOf(value, allowed) || fallback
        },
        parse: function (text) {
          var value = oneOf(text, allowed)
          return value === undefined ? undefined : { kind: 'set', value: value }
        },
      }
    }

    function numberField(name, fallback, min, max, step) {
      return {
        field: name,
        format: function (value) {
          var number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
          return String(number)
        },
        parse: function (text) {
          var trimmed = String(text === undefined || text === null ? '' : text).trim()
          if (trimmed === '') return { kind: 'clear' }
          var number = Number(trimmed)
          if (!Number.isFinite(number)) return undefined
          var clamped = Math.min(max, Math.max(min, number))
          return { kind: 'set', value: step === undefined ? clamped : Math.round(clamped / step) * step }
        },
      }
    }

    function textField(name) {
      return {
        field: name,
        format: function (value) {
          return typeof value === 'string' ? value : ''
        },
        parse: function (text) {
          var value = String(text === undefined || text === null ? '' : text).trim()
          return value === '' ? { kind: 'clear' } : { kind: 'set', value: value }
        },
      }
    }

    function createSettingsModel(scope) {
      var model = new SETTINGS_FORM_MODEL(scope, [
        { field: 'enabled', format: booleanText, parse: parseBoolean },
        { field: 'recap', format: booleanText, parse: parseBoolean },
        { field: 'recapActivity', format: booleanText, parse: parseBoolean },
        { field: 'recapTiming', format: booleanText, parse: parseBoolean },
        { field: 'recapReasoning', format: booleanText, parse: parseBoolean },
        choiceField('recapPlacement', RECAP_PLACEMENTS, 'above'),
        numberField('recapMinTurns', 3, 1, 50, 1),
        numberField('recapCooldownTurns', 3, 1, 50, 1),
        numberField('recapSimilarityThreshold', 0.7, 0, 1, 0.05),
        numberField('recapMaxWords', 40, 5, 200, 1),
        textField('recapModelChain'),
        { field: 'today', format: booleanText, parse: parseBoolean },
        choiceField('verbosity', VERBOSITY_OPTIONS, 'low'),
        { field: 'actionable', format: booleanText, parse: parseBoolean },
        {
          field: 'style',
          format: function (value) {
            return oneOf(value, STYLE_OPTIONS) || legacyStyle(scope)
          },
          parse: function (text) {
            var value = oneOf(text, STYLE_OPTIONS)
            return value === undefined ? undefined : { kind: 'set', value: value }
          },
        },
        {
          field: 'customInstructions',
          format: function (value) {
            return typeof value === 'string' ? value.slice(0, MAX_CUSTOM_CHARS) : ''
          },
          parse: function (text) {
            var value = text.slice(0, MAX_CUSTOM_CHARS)
            return value === '' ? { kind: 'clear' } : { kind: 'set', value: value }
          },
        },
      ])

      var store = model.bind(function () {
        return {
          ...model.shell(),
          enabled: model.field('enabled'),
          recap: model.field('recap'),
          recapActivity: model.field('recapActivity'),
          recapTiming: model.field('recapTiming'),
          recapReasoning: model.field('recapReasoning'),
          recapPlacement: model.field('recapPlacement'),
          recapMinTurns: model.field('recapMinTurns'),
          recapCooldownTurns: model.field('recapCooldownTurns'),
          recapSimilarityThreshold: model.field('recapSimilarityThreshold'),
          recapMaxWords: model.field('recapMaxWords'),
          recapModelChain: model.field('recapModelChain'),
          today: model.field('today'),
          verbosity: model.field('verbosity'),
          actionable: model.field('actionable'),
          style: model.field('style'),
          customInstructions: model.field('customInstructions'),
        }
      })

      return { model: model, store: store }
    }

    function FieldText(props) {
      var t = props.t
      return h('div', { className: 'wdxs-rowText' }, [
        h('div', { key: 'title', className: 'wdxs-title' }, props.title),
        props.description ? h('div', { key: 'desc', className: 'wdxs-desc' }, props.description) : null,
        props.overridden
          ? h('button', {
              key: 'reset',
              type: 'button',
              className: 'wdxs-reset',
              onClick: props.onReset,
            }, tr(t, 'form.reset', '恢复默认'))
          : null,
      ])
    }

    function ToggleField(props) {
      var field = props.field
      var checked = field.text !== 'false'
      var disabled = props.disabled === true
      return h('div', { className: 'wdxs-row' }, [
        h(FieldText, {
          key: 'text',
          t: props.t,
          title: props.title,
          description: props.description,
          overridden: field.overridden === true,
          onReset: props.onReset,
        }),
        SWITCH
          ? h(SWITCH, {
              key: 'switch',
              checked: checked,
              label: props.title,
              disabled: disabled,
              onChange: function (next) { props.onChange(next) },
            })
          : h('button', {
              key: 'fallback',
              type: 'button',
              'aria-pressed': checked,
              disabled: disabled,
              onClick: function () { props.onChange(!checked) },
              className: 'wdxs-select',
            }, checked ? 'On' : 'Off'),
      ])
    }

    function SelectField(props) {
      var [open, setOpen] = useState(false)
      var options = props.options
      var selected = options.filter(function (option) { return option.id === props.value })[0] || options[0]
      var disabled = props.disabled === true
      var anchor = h('button', {
        type: 'button',
        className: 'wdxs-select',
        'aria-label': props.title || undefined,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        disabled: disabled,
        onClick: function () { setOpen(function (value) { return !value }) },
      }, [
        h('span', { key: 'label' }, selected ? (selected.text || selected.label) : ''),
        CHEVRON ? h(CHEVRON, { key: 'chevron', className: 'wdxs-chevron' }) : null,
      ])

      var control = MENU
        ? h(MENU, {
            key: 'menu',
            open: open,
            onClose: function () { setOpen(false) },
            items: options,
            selectedId: props.value,
            onSelect: function (id) {
              setOpen(false)
              props.onChange(id)
            },
            align: 'end',
            portal: true,
            anchor: anchor,
          })
        : h('select', {
            key: 'select',
            className: 'wdxs-select',
            value: props.value,
            disabled: disabled,
            onChange: function (event) { props.onChange(event.target.value) },
          }, options.map(function (option) {
            return h('option', { key: option.id, value: option.id }, option.label)
          }))

      return h('div', { className: 'wdxs-row' }, [
        h(FieldText, {
          key: 'text',
          t: props.t,
          title: props.title,
          description: props.description,
          overridden: props.overridden === true,
          onReset: props.onReset,
        }),
        control,
      ])
    }

    function NumberField(props) {
      var field = props.field
      return h('div', { className: 'wdxs-row' }, [
        h(FieldText, {
          key: 'text',
          t: props.t,
          title: props.title,
          description: props.description,
          overridden: field.overridden === true,
          onReset: props.onReset,
        }),
        h('input', {
          key: 'input',
          type: 'number',
          className: 'wdxs-number',
          value: field.text,
          min: props.min,
          max: props.max,
          step: props.step,
          disabled: props.disabled === true,
          onChange: function (event) { props.onChange(event.target.value) },
        }),
      ])
    }

    function TextField(props) {
      var field = props.field
      return h('div', { className: 'wdxs-row' }, [
        h(FieldText, {
          key: 'text',
          t: props.t,
          title: props.title,
          description: props.description,
          overridden: field.overridden === true,
          onReset: props.onReset,
        }),
        h('input', {
          key: 'input',
          type: 'text',
          className: 'wdxs-textInput',
          value: field.text,
          placeholder: props.placeholder,
          spellCheck: false,
          disabled: props.disabled === true,
          onChange: function (event) { props.onChange(event.target.value) },
        }),
      ])
    }

    function CustomTextField(props) {
      var field = props.field
      var disabled = props.disabled === true
      return h('div', { className: 'wdxs-custom' }, [
        h(FieldText, {
          key: 'text',
          t: props.t,
          title: props.title,
          description: props.description,
          overridden: field.overridden === true,
          onReset: props.onReset,
        }),
        h('textarea', {
          key: 'input',
          className: 'wdxs-textarea',
          value: field.text,
          maxLength: MAX_CUSTOM_CHARS,
          placeholder: props.placeholder,
          spellCheck: false,
          disabled: disabled,
          onChange: function (event) { props.onChange(event.target.value) },
        }),
      ])
    }

    function BundleSettingsPage(props) {
      var t = props.t
      if (props.view === 'summary') return tr(t, 'settings.summary', '预测下一句，输入框上给一行进度；右侧面板整理没接住的事、回看历史摘要，并可旁问且不污染上下文。')

      var useSettings = props.useSettings
      var advancedState = useState(false)
      var state = useSettings ? useSettings(function (s) { return s }) : undefined
      if (!state) return null

      var advanced = advancedState[0]
      var setAdvanced = advancedState[1]
      var disabled = state.writable === false || state.saving === true
      var emptyField = { text: '', overridden: false, invalid: false }
      var enabled = state.enabled || emptyField
      var recap = state.recap || emptyField
      var recapActivity = state.recapActivity || emptyField
      var recapTiming = state.recapTiming || emptyField
      var recapReasoning = state.recapReasoning || emptyField
      var recapPlacement = state.recapPlacement || emptyField
      var recapMinTurns = state.recapMinTurns || emptyField
      var recapCooldownTurns = state.recapCooldownTurns || emptyField
      var recapSimilarityThreshold = state.recapSimilarityThreshold || emptyField
      var recapMaxWords = state.recapMaxWords || emptyField
      var recapModelChain = state.recapModelChain || emptyField
      var todayField = state.today || emptyField
      var verbosity = state.verbosity || emptyField
      var actionable = state.actionable || emptyField
      var style = state.style || emptyField
      var customInstructions = state.customInstructions || emptyField

      function edit(name, value) {
        if (typeof props.edit === 'function') props.edit(name, value)
      }

      function reset(name) {
        if (typeof props.resetField === 'function') props.resetField(name)
      }

      var verbosityOptions = VERBOSITY_OPTIONS.map(function (id) {
        return { id: id, label: tr(t, 'reply.verbosity.' + id, id) }
      })
      var placementOptions = RECAP_PLACEMENTS.map(function (id) {
        return { id: id, label: tr(t, 'settings.recapPlacement.' + id, id === 'below' ? '输入框下方' : '输入框上方') }
      })
      var styleOptions = STYLE_OPTIONS.map(function (id) {
        var name = tr(t, 'reply.style.' + id, id)
        return {
          id: id,
          text: name,
          label: h('span', { className: 'wdxs-item' }, [
            h('span', { key: 'name', className: 'wdxs-itemName' }, name),
            h('span', { key: 'desc', className: 'wdxs-itemDesc' }, tr(t, 'reply.style.option.' + id + '.desc', '')),
          ]),
        }
      })

      var formLabels = {
        unavailable: tr(t, 'form.unavailable', '配置暂不可用。'),
        readOnly: tr(t, 'form.readOnly', '当前部署只读。'),
        saveFailed: tr(t, 'form.saveFailed', '保存失败，请重试。'),
        save: tr(t, 'form.save', '保存'),
        saving: tr(t, 'form.saving', '保存中…'),
      }

      var Form = SETTINGS_FORM || function (formProps) {
        return h('div', { className: 'wdxs-fallback' }, formProps.children)
      }

      return h('div', { className: 'wdxs-page' }, [
        h(PluginStyles, { key: 'style', scope: 'settings' }),
        h('div', { key: 'intro', className: 'wdxs-intro' }, tr(t, 'reply.intro', '')),
        h(Form, {
          key: 'form',
          labels: formLabels,
          state: state,
          onSave: function () { if (typeof props.save === 'function') props.save() },
          onDiscard: function () { if (typeof props.discard === 'function') props.discard() },
        }, [
          h('div', { key: 'input', className: 'wdxs-group' }, [
            h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'reply.group.input', '输入')),
            h(ToggleField, {
              key: 'prediction',
              t: t,
              title: tr(t, 'settings.title', '显示预测消息'),
              description: tr(t, 'settings.description', '根据对话预测你接下来要发送的消息'),
              field: enabled,
              disabled: disabled,
              onChange: function (next) { edit('enabled', String(next)) },
              onReset: function () { reset('enabled') },
            }),
            h(ToggleField, {
              key: 'today',
              t: t,
              title: tr(t, 'settings.today.title', '整理没接住的事'),
              description: tr(t, 'settings.today.description', '把过去会话里提醒过你、但你还没处理的事整理成一小份清单'),
              field: todayField,
              disabled: disabled,
              onChange: function (next) { edit('today', String(next)) },
              onReset: function () { reset('today') },
            }),
            h('div', {
              key: 'btwHint',
              className: 'wdxs-desc',
              style: { paddingBottom: '16px' },
            }, tr(t, 'settings.btwHint', '提示：右侧 WDX Relief 面板的「旁问」Tab 可以直接问当前模型，底部可以选旁问模型；问答不会进入主上下文。')),
          ]),
          h('div', { key: 'turnLine', className: 'wdxs-group' }, [
            h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'settings.turnLine', '输入框上的一行')),
            h('div', { key: 'note', className: 'wdxs-desc', style: { marginBottom: '8px' } }, tr(t, 'settings.turnLine.note', '')),
            h(ToggleField, {
              key: 'recapActivity',
              t: t,
              title: tr(t, 'settings.recapActivity.title', '活动流水'),
              description: tr(t, 'settings.recapActivity.description', ''),
              field: recapActivity,
              disabled: disabled,
              onChange: function (next) { edit('recapActivity', String(next)) },
              onReset: function () { reset('recapActivity') },
            }),
            h(ToggleField, {
              key: 'recapTiming',
              t: t,
              title: tr(t, 'settings.recapTiming.title', '状态耗时'),
              description: tr(t, 'settings.recapTiming.description', ''),
              field: recapTiming,
              disabled: disabled,
              onChange: function (next) { edit('recapTiming', String(next)) },
              onReset: function () { reset('recapTiming') },
            }),
            h(ToggleField, {
              key: 'recapReasoning',
              t: t,
              title: tr(t, 'settings.recapReasoning.title', '思考预览'),
              description: tr(t, 'settings.recapReasoning.description', ''),
              field: recapReasoning,
              disabled: disabled,
              onChange: function (next) { edit('recapReasoning', String(next)) },
              onReset: function () { reset('recapReasoning') },
            }),
            h(ToggleField, {
              key: 'recap',
              t: t,
              title: tr(t, 'settings.recap.title', '语义摘要'),
              description: tr(t, 'settings.recap.description', ''),
              field: recap,
              disabled: disabled,
              onChange: function (next) { edit('recap', String(next)) },
              onReset: function () { reset('recap') },
            }),
            h(SelectField, {
              key: 'recapPlacement',
              t: t,
              title: tr(t, 'settings.recapPlacement.title', '显示位置'),
              description: tr(t, 'settings.recapPlacement.description', ''),
              options: placementOptions,
              value: recapPlacement.text || 'above',
              overridden: recapPlacement.overridden === true,
              disabled: disabled,
              onChange: function (next) { edit('recapPlacement', next) },
              onReset: function () { reset('recapPlacement') },
            }),
            h('button', {
              key: 'advanced',
              type: 'button',
              className: 'wdxs-advanced',
              'aria-expanded': advanced,
              onClick: function () { setAdvanced(function (value) { return !value }) },
            }, advanced ? tr(t, 'settings.recapAdvancedHide', '收起高级设置') : tr(t, 'settings.recapAdvanced', '高级（一般不用改）')),
            advanced
              ? h('div', { key: 'advancedFields' }, [
                  h(NumberField, {
                    key: 'minTurns',
                    t: t,
                    title: tr(t, 'settings.recapMinTurns.title', '从第几轮开始'),
                    description: tr(t, 'settings.recapMinTurns.description', ''),
                    field: recapMinTurns,
                    min: 1,
                    max: 50,
                    step: 1,
                    disabled: disabled,
                    onChange: function (next) { edit('recapMinTurns', next) },
                    onReset: function () { reset('recapMinTurns') },
                  }),
                  h(NumberField, {
                    key: 'cooldownTurns',
                    t: t,
                    title: tr(t, 'settings.recapCooldownTurns.title', '摘要更新间隔'),
                    description: tr(t, 'settings.recapCooldownTurns.description', ''),
                    field: recapCooldownTurns,
                    min: 1,
                    max: 50,
                    step: 1,
                    disabled: disabled,
                    onChange: function (next) { edit('recapCooldownTurns', next) },
                    onReset: function () { reset('recapCooldownTurns') },
                  }),
                  h(NumberField, {
                    key: 'maxWords',
                    t: t,
                    title: tr(t, 'settings.recapMaxWords.title', '摘要长度'),
                    description: tr(t, 'settings.recapMaxWords.description', ''),
                    field: recapMaxWords,
                    min: 5,
                    max: 200,
                    step: 1,
                    disabled: disabled,
                    onChange: function (next) { edit('recapMaxWords', next) },
                    onReset: function () { reset('recapMaxWords') },
                  }),
                  h(NumberField, {
                    key: 'similarity',
                    t: t,
                    title: tr(t, 'settings.recapSimilarityThreshold.title', '沿用旧摘要的阈值'),
                    description: tr(t, 'settings.recapSimilarityThreshold.description', ''),
                    field: recapSimilarityThreshold,
                    min: 0,
                    max: 1,
                    step: 0.05,
                    disabled: disabled,
                    onChange: function (next) { edit('recapSimilarityThreshold', next) },
                    onReset: function () { reset('recapSimilarityThreshold') },
                  }),
                  h(TextField, {
                    key: 'modelChain',
                    t: t,
                    title: tr(t, 'settings.recapModelChain.title', '摘要模型链'),
                    description: tr(t, 'settings.recapModelChain.description', ''),
                    placeholder: tr(t, 'settings.recapModelChain.placeholder', 'deepseek-v4-flash, deepseek-chat'),
                    field: recapModelChain,
                    disabled: disabled,
                    onChange: function (next) { edit('recapModelChain', next) },
                    onReset: function () { reset('recapModelChain') },
                  }),
                ])
              : null,
          ]),
          h('div', { key: 'length', className: 'wdxs-group' }, [
            h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'reply.group.length', '回复长度')),
            h(SelectField, {
              key: 'verbosity',
              t: t,
              title: tr(t, 'reply.verbosity.title', '输出详细程度'),
              description: tr(t, 'reply.verbosity.description', ''),
              options: verbosityOptions,
              value: verbosity.text || 'low',
              overridden: verbosity.overridden === true,
              disabled: disabled,
              onChange: function (next) { edit('verbosity', next) },
              onReset: function () { reset('verbosity') },
            }),
          ]),
          h('div', { key: 'writing', className: 'wdxs-group' }, [
            h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'reply.group.writing', '写作')),
            h(ToggleField, {
              key: 'actionable',
              t: t,
              title: tr(t, 'reply.actionable.title', '便于行动'),
              description: tr(t, 'reply.actionable.description', ''),
              field: actionable,
              disabled: disabled,
              onChange: function (next) { edit('actionable', String(next)) },
              onReset: function () { reset('actionable') },
            }),
            h(SelectField, {
              key: 'style',
              t: t,
              title: tr(t, 'reply.style.title', '回复风格'),
              description: tr(t, 'reply.style.description', ''),
              options: styleOptions,
              value: style.text,
              overridden: style.overridden === true,
              disabled: disabled,
              onChange: function (next) { edit('style', next) },
              onReset: function () { reset('style') },
            }),
          ]),
          h(CustomTextField, {
            key: 'custom',
            t: t,
            title: tr(t, 'reply.custom.title', '自定义指令'),
            description: tr(t, 'reply.custom.description', ''),
            placeholder: tr(t, 'reply.custom.placeholder', ''),
            field: customInstructions,
            disabled: disabled,
            onChange: function (next) { edit('customInstructions', next) },
            onReset: function () { reset('customInstructions') },
          }),
        ]),
      ])
    }

    // ---------------------------------------------------------------- apply

    var name = 'wdx-relief'
    var inject = ['slots', 'configForms', 'locale', 'sidebarRight', 'sidebarRightTabs', 'modelDirectories', 'sessions']

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'wdx-relief: dictionaries')

      var form = ctx.configForms.get(NS)
      var settings = createSettingsModel(form)
      ctx.effect(function () {
        return function () { settings.model.dispose() }
      }, 'wdx-relief: settings form')

      // 预测组件只需要只读的配置快照；配置页使用上面的暂存 model。
      var formSource = {
        getSnapshot: function () { return form.getSnapshot() },
        subscribe: function (listener) { return form.subscribe(listener) },
      }

      var boundT = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : function (key) { return key }

      function openReliefSession(id) {
        var workspace = ctx.get('uiWorkspace')
        if (workspace && typeof workspace.openSession === 'function') workspace.openSession(id)
      }

      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: RELIEF_TAB,
          kind: RELIEF_TAB,
          priority: 'extension',
          title: function () { return boundT('panel.title') },
          guide: [{
            id: 'wdx-relief',
            order: 35,
            title: function () { return boundT('panel.title') },
            description: function () { return boundT('panel.guide') },
            icon: ReliefIcon,
          }],
        })
      }, 'wdx-relief: sidebar page')

      ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: RELIEF_TAB,
          locale: NS,
        }, function ReliefTabBody(props) {
          return h(ReliefPanel, {
            sessionId: props && props.sessionId,
            t: props && props.t,
            openSession: openReliefSession,
            modelDirectories: ctx.modelDirectories,
          })
        })
      })

      ctx.slots.inject('conversation.input.overlay', function () {
        return ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'wdx-prediction',
          order: 50,
          locale: NS,
          inject: function (sessionId) {
            return { sessionId: sessionId, hooks: { settings: formSource } }
          },
        }, PredictionOverlay)
      })

      // 一行既可以放在输入框上方（input.dock），也可以放在 composer 底部
      // （composer.dock）。两个 slot 都注册，组件按配置只渲染其中一个。
      function readTurnFeed(sessionId) {
        try {
          var binding = ctx.sessions && typeof ctx.sessions.binding === 'function' ? ctx.sessions.binding(sessionId) : undefined
          return binding && binding.eventSource
        } catch (error) {
          return undefined
        }
      }

      function registerTurnLine(slot, id, placement) {
        ctx.slots.inject(slot, function () {
          return ctx.slots.register({
            name: slot,
            id: id,
            order: 30,
            locale: NS,
            inject: function (sessionId) {
              return {
                sessionId: sessionId,
                placement: placement,
                readFeed: readTurnFeed,
                hooks: { settings: formSource },
              }
            },
          }, TurnRecapDock)
        })
      }

      registerTurnLine('conversation.input.dock', 'wdx-turn-line-above', 'above')
      registerTurnLine('conversation.composer.dock', 'wdx-turn-line-below', 'below')

      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-wdx-relief',
          locale: NS,
          inject: function () {
            return {
              hooks: { settings: settings.store },
              ...settings.model.actions(),
            }
          },
        }, BundleSettingsPage)
      })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.PredictionOverlay = PredictionOverlay
    exports.TurnRecapDock = TurnRecapDock
    exports.RecapDock = TurnRecapDock
    exports.deriveTurnView = deriveTurnView
    exports.buildTurnSegments = buildTurnSegments
    exports.activityText = activityText
    exports.describeToolCall = describeToolCall
    exports.formatDuration = formatDuration
    exports.RECAP_PLACEMENTS = RECAP_PLACEMENTS
    exports.ReliefPanel = ReliefPanel
    exports.ReliefIcon = ReliefIcon
    exports.BtwSection = BtwSection
    exports.RecapHistorySection = RecapHistorySection
    exports.RELIEF_TAB = RELIEF_TAB
    exports.BundleSettingsPage = BundleSettingsPage
    exports.formatRecap = formatRecap
    exports.trf = trf
    return module.exports
  },
})