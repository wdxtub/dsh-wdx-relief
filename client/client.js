/**
 * dsh-wdx-relief 网页客户端。
 *
 * 四块 UI：
 * 1. 右侧栏 WDX Relief 页面：默认「会话回顾」，另一个 Tab 是「旁问」。
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
    var RECAPS_PATH = '/api/wdx-relief/recaps'
    var PROGRESS_PATH = '/api/wdx-relief/progress'
    var BTW_PATH = '/api/wdx-relief/btw'
    var TOOLREPAIR_LANGS = ['zh', 'en']
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
    var DEFAULT_TAB_VALUES = ['recaps', 'btw']

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
      '.wdxt-row{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);min-height:28px;align-items:center;gap:6px;padding:4px 6px 4px 10px;font-size:12px;line-height:18px;display:flex;animation:wdxt-fade .18s ease-out}',
      '@keyframes wdxt-fade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.wdxt-row{animation:none}}',
      '.wdxt-row[data-state="running"]{border-color:var(--dsw-alias-state-business-tertiary)}',
      '.wdxt-row[data-state="stalled"]{border-color:var(--dsw-alias-state-warn-secondary)}',
      '.wdxt-seg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.wdxt-progress{color:var(--dsw-alias-label-tertiary);flex:0 1 auto;min-width:0;font-variant-numeric:tabular-nums}',
      '.wdxt-progressStalled{color:var(--dsw-alias-state-warn-label)}',
      '.wdxt-activity{color:var(--dsw-alias-label-tertiary);flex:0 1 auto;max-width:46%}',
      '.wdxt-summary{color:var(--dsw-alias-label-secondary);flex:1 1 auto;min-width:0}',
      '.wdxt-sep{color:var(--dsw-alias-border-l3);flex:none}',
      '.wdxt-status{box-sizing:border-box;height:18px;border-radius:999px;flex:none;align-items:center;gap:4px;padding:0 6px;font-size:11px;line-height:16px;display:inline-flex;border:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}',
      '.wdxt-status[data-kind="running"]{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-base)}',
      '.wdxt-status[data-kind="stalled"]{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-secondary);background:var(--dsw-alias-bg-base)}',
      '.wdxt-status[data-kind="done"]{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-base)}',
      '.wdxt-status[data-kind="error"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary);background:var(--dsw-alias-bg-base)}',
      '.wdxt-status[data-kind="aborted"],.wdxt-status[data-kind="interrupted"],.wdxt-status[data-kind="forked"]{color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-base)}',
      '.wdxt-status[data-kind="blocked"],.wdxt-status[data-kind="maxTokens"]{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-secondary);background:var(--dsw-alias-bg-base)}',
      '.wdxt-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;animation:wdxt-pulse 1.4s ease-in-out infinite}',
      '.wdxt-dotStatic{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;opacity:.65}',
      '@keyframes wdxt-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}',
      '@media (prefers-reduced-motion:reduce){.wdxt-dot{animation:none;opacity:1}}',
      '.wdxt-check{font-size:10px;line-height:1;flex:none}',
      '.wdxt-close{width:16px;height:16px;color:var(--dsw-alias-label-caption);cursor:pointer;opacity:0;background:0 0;border:0;border-radius:999px;flex:none;place-items:center;padding:0;font:inherit;font-size:12px;line-height:1;display:grid}',
      '.wdxt-open{width:20px;height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:.7;background:0 0;border:0;border-radius:var(--dsw-radius-sm);flex:none;place-items:center;padding:0;font:inherit;font-size:14px;line-height:1;display:grid}',
      '@media (hover:hover){.wdxt-open:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}',
      '.wdxt-open:focus-visible{opacity:1;outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}',
      '.wdxt-row:hover .wdxt-close,.wdxt-close:focus-visible{opacity:1}',
      // 触屏没有 hover：让关闭键保持低透明度可见，否则用户看不到这个控件。
      '@media (hover:none){.wdxt-close{opacity:.55}}',
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
      '.wdxp-tabs{box-sizing:border-box;align-items:center;gap:14px;border-bottom:.5px solid var(--dsw-alias-border-l3);display:flex}',
      '.wdxp-tab{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;margin:0;padding:2px 0 9px;font:inherit;font-size:13px;font-weight:500;line-height:18px;position:relative;align-items:center;gap:6px;display:inline-flex}',
      '@media (hover:hover){.wdxp-tab:hover{color:var(--dsw-alias-label-primary)}}',
      '.wdxp-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:var(--dsw-radius-sm)}',
      '.wdxp-tabActive{color:var(--dsw-alias-label-primary)}',
      '.wdxp-tabActive:after{content:"";position:absolute;right:0;bottom:-1px;left:0;background:var(--dsw-alias-state-business-primary);border-radius:2px;height:2px}',
      '.wdxp-pane{min-width:0;flex-direction:column;gap:8px;display:flex}',
      '.wdxp-pane[hidden]{display:none}',
      '.wdxp-body{min-width:0}',
      '.wdxp-rows{flex-direction:column;gap:8px;display:flex}',
      '.wdxp-list{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}',
      '.wdxp-item{min-width:0;flex-direction:column;gap:2px;margin:0;padding:0;display:flex}',
      '.wdxp-row{box-sizing:border-box;width:100%;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:inherit;font:inherit;text-align:left;cursor:pointer;align-items:flex-start;gap:10px;padding:8px 10px;display:flex}',
      '@media (hover:hover){.wdxp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}}',
      '.wdxp-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-1px}',
      '.wdxp-rowText{overflow-wrap:anywhere;white-space:normal;flex:1;min-width:0;font-size:13px;line-height:19px}',
      '.wdxp-rowMetaCol{flex-direction:column;align-items:flex-end;flex:none;gap:0;display:flex}',
      '.wdxp-rowInterval{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums;flex:none;margin-top:1px;font-size:10px;line-height:11px}',
      '.wdxp-rowMeta{color:var(--dsw-alias-label-caption);white-space:nowrap;font-variant-numeric:tabular-nums;flex:none;margin-top:2px;font-size:11px;line-height:15px}',
      '.wdxp-note{color:var(--dsw-alias-label-tertiary);align-items:center;gap:6px;margin:2px 0 0;font-size:12px;line-height:18px;display:flex}',
      '.wdxp-link{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;padding:0;font:inherit;font-size:12px;line-height:18px;text-decoration:underline;align-self:flex-start;text-align:left}',
      '@media (hover:hover){.wdxp-link:hover{color:var(--dsw-alias-label-primary)}}',
      '.wdxp-confirm{background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);align-items:center;flex-wrap:wrap;gap:6px 10px;padding:6px 10px;display:flex}',
      '.wdxp-confirmText{color:var(--dsw-alias-label-secondary);flex:1;min-width:0;font-size:11px;line-height:16px}',
      '.wdxp-danger{color:var(--dsw-alias-state-error-primary)}',
      '.wdxh-row{align-items:flex-start;flex:none}',
      '.wdxh-toolbar{align-items:center;flex-wrap:wrap;gap:6px 8px;min-height:18px;display:flex}',
      '.wdxp-filters{align-items:center;flex-wrap:wrap;gap:4px;display:flex}',
      '.wdxp-filter{box-sizing:border-box;height:22px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);cursor:pointer;border:.5px solid transparent;align-items:center;gap:4px;padding:0 7px;font:inherit;font-size:11px;line-height:16px;display:inline-flex}',
      '@media (hover:hover){.wdxp-filter:hover{color:var(--dsw-alias-label-primary)}}',
      '.wdxp-filter:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}',
      '.wdxp-filterActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}',
      '.wdxp-filterCount{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption);font-size:10px}',
      '.wdxh-kind{color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-base);border-radius:4px;flex:none;margin-top:1px;padding:0 5px;font-size:10px;line-height:16px}',
      '.wdxp-groups{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}',
      '.wdxp-group{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);min-width:0;overflow:hidden}',
      '.wdxp-groupHead{box-sizing:border-box;width:100%;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:7px 9px;display:flex}',
      '@media (hover:hover){.wdxp-groupHead:hover{background:var(--dsw-alias-interactive-bg-hover)}}',
      '.wdxp-groupHead:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-1px}',
      '.wdxp-groupTitle{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;flex:0 1 auto;min-width:0;font-size:12px;line-height:18px;font-weight:600;overflow:hidden}',
      '.wdxp-groupCount{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-base);border-radius:4px;flex:none;padding:0 5px;font-size:10px;line-height:16px;font-variant-numeric:tabular-nums}',
      '.wdxp-groupPending{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-bg-base);border-radius:4px;flex:none;padding:0 5px;font-size:10px;line-height:16px}',
      '.wdxp-groupTime{color:var(--dsw-alias-label-caption);white-space:nowrap;font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:10px;line-height:16px}',
      '.wdxp-groupCaret{color:var(--dsw-alias-label-caption);flex:none;font-size:10px;line-height:1}',
      '.wdxp-groupBody{border-top:.5px solid var(--dsw-alias-border-l3);padding:4px 6px 6px}',
      '.wdxp-groupList{margin-top:2px}',
      '.wdxp-groupBody .wdxp-row{background:var(--dsw-alias-bg-base)}',
      '.wdxh-count{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
      '.wdxh-detail{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);max-height:260px;flex-direction:column;gap:6px;margin-top:2px;padding:8px 10px;display:flex;overflow:auto}',
      '.wdxh-line{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap;margin:0;font-size:12px;line-height:18px}',
      '.wdxh-label{color:var(--dsw-alias-label-caption);margin-right:4px;font-size:11px}',
      '.wdxp-skeleton{flex-direction:column;gap:2px;display:flex}',
      '.wdxp-skeletonRow{height:38px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-skeleton)}',
    ].join('')

    // 顶栏入口只挂 4 条规则，不跟着面板一起重复注入整份 CSS。
    var HEADER_CSS = [
      '.wdxr-headerBtn{width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .14s,color .14s}',
      '@media (hover:hover){.wdxr-headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}',
      '.wdxr-headerBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.wdxr-headerBtn svg{display:block}',
    ].join('')

    function PluginStyles(props) {
      var scope = props && props.scope ? ':' + props.scope : ''
      return h('style', { 'data-plugin-css': NS + scope }, CSS)
    }

    // -------------------------------------------------------------- locale

    var zh = {
      'settings.intro': '上半部分是各功能开关，下半部分是回复偏好；回复偏好只打进 system prompt，不改变工具权限。',
      'settings.group.features': '功能',
      'reply.group.reply': '回复方式',
      'reply.verbosity.title': '输出详细程度',
      'reply.verbosity.description': '选择回复包含细节的详细程度',
      'reply.verbosity.low': '短',
      'reply.verbosity.medium': '标准',
      'reply.verbosity.high': '详细',
      'reply.actionable.title': '便于行动',
      'reply.actionable.description': '先给结果和下一步，少铺垫；能一句话说清就不展开；保留风险与失败条件',
      'reply.eli5.title': 'ELI5 模式',
      'reply.eli5.description': '默认用 ELI5 的方式和我说话，如果我要求则深入讲解',
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
      'settings.turnLine.note': '这一行只是界面提示，不进入模型上下文；实时进度和活动流水本地生成，语义摘要打开时每轮调用一次便宜模型。',
      'settings.recap.title': '语义摘要',
      'settings.recap.description': '每轮用一次便宜模型，写一行「现在到哪」；模型失败时退回本地摘要',
      'settings.recapProgress.title': '实时进度',
      'settings.recapProgress.description': '一轮跑久了还没给你回复时，按设置的间隔（默认 10 分钟）在「会话回顾」里记一条进度；工具调用和思考不算回复',
      'settings.recapStallSeconds.title': '进度记录间隔（秒）',
      'settings.recapStallSeconds.description': '一轮运行中多久没给你回复后开始记进度，之后每隔这么久再记一条；默认 600 秒 = 10 分钟',
      'settings.pendingTurns.title': '待跟进窗口（最近 N 轮）',
      'settings.pendingTurns.description': '在「会话回顾」里把最近这么多轮的问题/下一步标成待跟进；默认 3',
      'settings.recapActivity.title': '活动流水',
      'settings.recapActivity.description': '正在读文件、跑命令、改代码；本地生成，零模型调用（默认关闭）',
      'settings.advanced': '高级（一般不用改）',
      'settings.advancedHide': '收起高级设置',
      'settings.recapModelChain.title': '摘要模型链',
      'settings.recapModelChain.description': '按顺序尝试 provider/model；留空自动挑便宜模型，全部失败退回当前默认模型',
      'settings.recapModelChain.placeholder': 'deepseek-v4-flash, deepseek-chat',
      'settings.btwHint': '提示：右侧 WDX Relief 面板的「旁问」Tab 可以直接问当前模型，底部可以选旁问模型；问答不会进入主上下文。',
      'settings.summary': '预测下一句，输入框上给一行实时进度；右侧面板按轮次看摘要、进度和待跟进，并可旁问且不污染上下文。',
      'reply.group.toolRepair': '工具调用守卫',
      'settings.toolRepair.title': '工具调用泄漏守卫',
      'settings.toolRepair.description': '模型把工具调用写成正文、这一步没有工具卡却正常结束时，当场检测并在同一轮内纠正重发',
      'settings.toolRepairLang.title': '修复提示语言',
      'settings.toolRepairLang.description': '注入的纠正与拦截原因用中文还是英文',
      'settings.toolRepairLang.zh': '中文',
      'settings.toolRepairLang.en': 'English',
      'settings.toolRepairMaxCorrections.title': '每轮最多纠正次数',
      'settings.toolRepairMaxCorrections.description': '0 表示只标记不自动纠正；默认 2',
      'settings.toolRepairDebugLog.title': '诊断日志',
      'settings.toolRepairDebugLog.description': '输出检测、拦截与修复过程日志（默认关闭）',
      'turn.pending': '还没回复',
      'turn.dismiss': '本轮不再显示这一行',
      'turn.thinking': '思考中…',
      'turn.answering': '正在回复…',
      'turn.tool': '调用工具…',
      'turn.status.running': '进行中',
      'turn.status.stalled': '无新输出',
      'turn.status.done': '已完成',
      'turn.status.aborted': '已取消',
      'turn.status.error': '出错',
      'turn.status.blocked': '已拦截',
      'turn.status.interrupted': '已中断',
      'turn.status.maxTokens': '输出上限',
      'turn.status.forked': '已分叉',
      'turn.runningFor': '第 {turn} 轮 · 已进行 {duration}',
      'turn.took': '第 {turn} 轮 · 用时 {duration}',
      'turn.waitingFor': '等待 {duration}',
      'turn.progressHint': '每 {duration} 在「会话回顾」记一条进度',
      'duration.seconds': '{s} 秒',
      'duration.minutes': '{m} 分 {s} 秒',
      'duration.minuteOnly': '{m} 分',
      'duration.hours': '{h} 小时 {m} 分',
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
      'settings.defaultTab.title': '默认 Tab',
      'settings.defaultTab.description': '打开右侧 WDX Relief 面板时先显示哪个 Tab；默认「会话回顾」',
      'settings.defaultTab.recaps': '会话回顾',
      'settings.defaultTab.btw': '旁问',
      'panel.title': 'WDX Relief',
      'panel.guide': '按轮次看进度与摘要，也可以随手旁问',
      'panel.open': '打开 WDX Relief：会话回顾 / 旁问',
      'panel.refresh': '刷新',
      'section.recaps': '会话回顾',
      'panel.recapEmpty': '还没有生成过摘要或进度记录；聊过一轮，或一轮跑久了还没回复时就会出现',
      'panel.recapEmptySummary': '还没有摘要；聊过一轮后会出现',
      'panel.recapEmptyProgress': '还没有进度记录；一轮跑久了还没给你回复时会出现',
      'panel.recapEmptyOff': '语义摘要和实时进度都已关闭；在插件设置里打开一个后才会记录',
      'panel.recapNoSession': '先打开一个会话',
      'panel.recapError': '回顾历史读取失败',
      'panel.recapRouteMissing': '回顾历史路由没加载；重启 DSH 后再试',
      'panel.recapRetry': '重试',
      'panel.recapCount': '共 {count} 条',
      'panel.recapClear': '清空',
      'panel.recapClearConfirm': '删除当前会话的全部摘要和进度记录？',
      'panel.recapClearYes': '确认清空',
      'panel.recapClearNo': '取消',
      'panel.recapClearFailed': '清空失败，请重试',
      'panel.recapRequest': '要求',
      'panel.recapReply': '回复',
      'panel.recapQuestion': '待回答',
      'panel.recapFilterAll': '全部',
      'panel.recapFilterSummary': '摘要',
      'panel.recapFilterProgress': '进度',
      'panel.recapTagSummary': '摘要',
      'panel.recapTagLocal': '本地摘要',
      'panel.recapTagProgress': '进度',
      'panel.recapFilterEmpty': '这个筛选下还没有记录',
      'panel.recapUnknownTurn': '更早的记录',
      'panel.recapOrderDesc': '最新在前',
      'panel.recapOrderAsc': '最早在前',
      'panel.recapGroupProgress': '进度 {count}',
      'panel.recapGroupSummary': '摘要 {count}',
      'panel.recapGroupSpan': '{time} · 用时 {duration}',
      'panel.recapPending': '待跟进',
      'panel.recapFilterPending': '待跟进',
      'panel.recapPendingCount': '{count} 轮',
      'panel.recapPendingCountOne': '{count} 轮',
      'panel.recapPendingEmpty': '目前没有待跟进的轮次',
      'panel.recapPendingRunning': '正在跑的这轮不标待跟进；已结束的轮次仍会保留',
      'panel.recapPendingNoSummary': '语义摘要已关闭；待跟进标记来自摘要记录，打开摘要后才会出现',
      'panel.recapPendingHint': '这一轮结束时留下了问题或下一步',
      'progress.turn': '第 {turn} 轮',
      'progress.turnLabel': '轮次',
      'progress.quietLabel': '未回复',
      'progress.elapsedLabel': '总耗时',
      'progress.stepsLabel': '步数',
      'progress.interval': '第 {from}–{to} 分',
      'progress.intervalOne': '第 {minute} 分',
      'progress.intervalShort': '{from}–{to} 分',
      'progress.intervalOneShort': '{minute} 分',
      'progress.intervalLabel': '时间窗',
      'progress.doing': '在{actions}',
      'progress.actions': '本段动作',
      'progress.noOutput': '这段时间没有新输出',
      'progress.command': '运行命令',
      'progress.open': '查看进度',
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
      'btw.errorNetwork': '请求失败：{reason}',
      'btw.errorRead': 'HTTP {status} · 读取响应失败',
      'btw.errorEmptyResponse': 'HTTP {status} · 空响应',
      'btw.errorNoAnswer': '模型没有返回可用的回答。',
      'prediction.accept': '按 Tab 填入预测',
      'form.unavailable': '配置暂不可用。',
      'form.readOnly': '当前部署只读。',
      'form.saveFailed': '本部署没有接受这些值；已保留供你修改。',
      'form.save': '保存',
      'form.saving': '保存中…',
      'form.reset': '恢复默认',
    }

    var en = {
      'settings.intro': 'Feature switches come first, reply preferences after; reply preferences only shape the system prompt and never change tool permissions.',
      'settings.group.features': 'Features',
      'reply.group.reply': 'Reply style',
      'reply.verbosity.title': 'Output detail',
      'reply.verbosity.description': 'How much detail replies should include',
      'reply.verbosity.low': 'Short',
      'reply.verbosity.medium': 'Standard',
      'reply.verbosity.high': 'Detailed',
      'reply.actionable.title': 'Actionable replies',
      'reply.actionable.description': 'Lead with the result and next step; one sentence when one suffices; keep risks and failure conditions',
      'reply.eli5.title': 'ELI5 mode',
      'reply.eli5.description': "Talk to me like I'm 5 by default; go deeper when I ask",
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
      'settings.turnLine.note': 'This line is UI only and never enters the model context. Live progress and the activity stream are local; when semantic summaries are on, they make one cheap-model call per turn.',
      'settings.recap.title': 'Semantic summary',
      'settings.recap.description': 'Every turn, one cheap-model line describing where things stand; falls back to a local summary when the model fails',
      'settings.recapProgress.title': 'Live progress',
      'settings.recapProgress.description': 'When a turn runs long without replying to you, record a progress entry at the configured interval (default 10 minutes) in Session review; tool calls and reasoning do not count as a reply',
      'settings.recapStallSeconds.title': 'Progress interval (seconds)',
      'settings.recapStallSeconds.description': 'How long a running turn goes without a reply before the first progress entry, then one per interval; default 600 seconds = 10 minutes',
      'settings.pendingTurns.title': 'Follow-up window (recent turns)',
      'settings.pendingTurns.description': 'Mark questions / next steps from this many recent turns as Follow up in Session review; default 3',
      'settings.recapActivity.title': 'Activity stream',
      'settings.recapActivity.description': 'Reading files, running commands, editing code; local, no model call (off by default)',
      'settings.advanced': 'Advanced (rarely needed)',
      'settings.advancedHide': 'Hide advanced settings',
      'settings.recapModelChain.title': 'Summary model chain',
      'settings.recapModelChain.description': 'Try provider/model in order. Empty picks cheap models automatically, then falls back to the current default',
      'settings.recapModelChain.placeholder': 'deepseek-v4-flash, deepseek-chat',
      'settings.btwHint': 'Tip: the Aside tab in the WDX Relief panel asks the current model; pick a model at the bottom. The exchange never enters the model context.',
      'settings.summary': 'Predict the next message, keep a live progress line above the composer, and use the right panel for per-turn summaries, progress and follow-ups, and side questions that stay out of context.',
      'reply.group.toolRepair': 'Tool-call guard',
      'settings.toolRepair.title': 'Tool-call leak guard',
      'settings.toolRepair.description': 'When a tool call is written as text, produces no tool card, yet the turn closes normally: detect it and inject a correction in the same turn',
      'settings.toolRepairLang.title': 'Correction language',
      'settings.toolRepairLang.description': 'Use Chinese or English for injected corrections and denial reasons',
      'settings.toolRepairLang.zh': '中文',
      'settings.toolRepairLang.en': 'English',
      'settings.toolRepairMaxCorrections.title': 'Max corrections per turn',
      'settings.toolRepairMaxCorrections.description': '0 means flag only, never auto-correct; default 2',
      'settings.toolRepairDebugLog.title': 'Diagnostic log',
      'settings.toolRepairDebugLog.description': 'Log detection, denials and repairs (off by default)',
      'turn.pending': 'no reply yet',
      'turn.dismiss': 'Hide this line for this turn',
      'turn.thinking': 'Thinking…',
      'turn.answering': 'Replying…',
      'turn.tool': 'Running a tool…',
      'turn.status.running': 'Running',
      'turn.status.stalled': 'No output',
      'turn.status.done': 'Done',
      'turn.status.aborted': 'Cancelled',
      'turn.status.error': 'Failed',
      'turn.status.blocked': 'Blocked',
      'turn.status.interrupted': 'Interrupted',
      'turn.status.maxTokens': 'Token limit',
      'turn.status.forked': 'Forked',
      'turn.runningFor': 'Turn {turn} · {duration} elapsed',
      'turn.took': 'Turn {turn} · {duration}',
      'turn.waitingFor': 'waiting {duration}',
      'turn.progressHint': 'One progress entry every {duration} in Session review',
      'duration.seconds': '{s}s',
      'duration.minutes': '{m}m {s}s',
      'duration.minuteOnly': '{m}m',
      'duration.hours': '{h}h {m}m',
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
      'settings.defaultTab.title': 'Default tab',
      'settings.defaultTab.description': 'Which tab the WDX Relief panel shows first; Session review by default',
      'settings.defaultTab.recaps': 'Session review',
      'settings.defaultTab.btw': 'Aside',
      'panel.title': 'WDX Relief',
      'panel.guide': 'Review per-turn progress and recaps, and ask aside',
      'panel.open': 'Open WDX Relief: session review / aside',
      'panel.refresh': 'Refresh',
      'section.recaps': 'Recaps',
      'panel.recapEmpty': 'No summary or progress yet; one appears after the first turn, or when a turn runs long without replying',
      'panel.recapEmptySummary': 'No summaries yet; one appears after a turn',
      'panel.recapEmptyProgress': 'No progress yet; entries appear when a turn runs long without replying',
      'panel.recapEmptyOff': 'Semantic summaries and live progress are both off; turn on either in the plugin settings to record',
      'panel.recapNoSession': 'Open a session first',
      'panel.recapError': 'Could not read recap history',
      'panel.recapRouteMissing': 'The recap history route is not loaded; restart DSH and try again',
      'panel.recapRetry': 'Retry',
      'panel.recapCount': '{count} entries',
      'panel.recapClear': 'Clear',
      'panel.recapClearConfirm': 'Delete every summary and progress entry in this session?',
      'panel.recapClearYes': 'Clear all',
      'panel.recapClearNo': 'Cancel',
      'panel.recapClearFailed': 'Could not clear; try again',
      'panel.recapRequest': 'Asked',
      'panel.recapReply': 'Replied',
      'panel.recapQuestion': 'Waiting on',
      'panel.recapFilterAll': 'All',
      'panel.recapFilterSummary': 'Summaries',
      'panel.recapFilterProgress': 'Progress',
      'panel.recapTagSummary': 'Summary',
      'panel.recapTagLocal': 'Local summary',
      'panel.recapTagProgress': 'Progress',
      'panel.recapFilterEmpty': 'No entries under this filter',
      'panel.recapUnknownTurn': 'Earlier entries',
      'panel.recapOrderDesc': 'Newest first',
      'panel.recapOrderAsc': 'Oldest first',
      'panel.recapGroupProgress': 'Progress {count}',
      'panel.recapGroupSummary': 'Summaries {count}',
      'panel.recapGroupSpan': '{time} · {duration}',
      'panel.recapPending': 'Follow up',
      'panel.recapFilterPending': 'Follow up',
      'panel.recapPendingCount': '{count} turns',
      'panel.recapPendingCountOne': '{count} turn',
      'panel.recapPendingEmpty': 'No turn needs a follow-up',
      'panel.recapPendingRunning': 'The running turn is not marked; finished turns keep their markers',
      'panel.recapPendingNoSummary': 'Semantic summaries are off; follow-ups come from summary entries, so none can be marked',
      'panel.recapPendingHint': 'This turn ended with a question or a next step',
      'progress.turn': 'Turn {turn}',
      'progress.turnLabel': 'Turn',
      'progress.quietLabel': 'No reply yet',
      'progress.elapsedLabel': 'Elapsed',
      'progress.stepsLabel': 'Steps',
      'progress.interval': 'min {from}–{to}',
      'progress.intervalOne': 'min {minute}',
      'progress.intervalShort': '{from}–{to} min',
      'progress.intervalOneShort': '{minute} min',
      'progress.intervalLabel': 'Window',
      'progress.doing': 'Working on {actions}',
      'progress.actions': 'Actions',
      'progress.noOutput': 'No new output in this window',
      'progress.command': 'Run command',
      'progress.open': 'View progress',
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
      'btw.errorNetwork': 'Request failed: {reason}',
      'btw.errorRead': 'HTTP {status} · could not read the response',
      'btw.errorEmptyResponse': 'HTTP {status} · empty response',
      'btw.errorNoAnswer': 'The model returned no usable answer.',
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
     * 一次旁问 RPC。
     * 返回 { items } / { unavailable } / { disabled }；网络或服务失败返回 { error }。
     */
    async function requestBtw(sessionId, question, selection, signal, t) {
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
        return { error: true, message: trf(t, 'btw.errorNetwork', { reason: reason }, '请求失败：' + reason) }
      }
      if (response.status === 404) {
        return { error: true, code: 'route-missing', message: tr(t, 'btw.routeMissing', '旁问路由未加载；请重启 DSH 后再试。') }
      }
      var text = ''
      try {
        text = await response.text()
      } catch (error) {
        return { error: true, message: trf(t, 'btw.errorRead', { status: response.status }, 'HTTP ' + response.status + ' · 读取响应失败') }
      }
      var body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch (error) {
        var snippet = text.replace(/\s+/g, ' ').slice(0, 140)
        return { error: true, message: snippet === ''
          ? trf(t, 'btw.errorEmptyResponse', { status: response.status }, 'HTTP ' + response.status + ' · 空响应')
          : 'HTTP ' + response.status + ' · ' + snippet }
      }
      if (!body || body.ok !== true) {
        var failure = body && body.error ? body.error : {}
        var detail = typeof failure.message === 'string' && failure.message !== '' ? failure.message : 'HTTP ' + response.status
        return { error: true, message: detail }
      }
      var answer = body.data && body.data.answer
      if (typeof answer !== 'string' || answer === '') return { error: true, message: tr(t, 'btw.errorNoAnswer', '模型没有返回可用的回答。') }
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


    /** 追加一条运行中的进度快照；失败静默，不打扰主任务。 */
    async function requestProgress(sessionId, entry, signal) {
      try {
        await fetch(PROGRESS_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, entry: entry }),
          signal: signal,
        })
      } catch (error) {
        // 断网、超时或路由未加载都按「这条没记上」处理，下一条继续。
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

    /**
     * 进度条目覆盖的累计时间窗：「第 1–20 分」。旧记录没有 windowMs 时返回空。
     * style 传 'short' 时去掉前缀，给列表右侧的小字用（完整说法留给展开详情）。
     */
    function progressIntervalText(item, t, style) {
      var short = style === 'short'
      var bucket = Number(item && item.bucket)
      var windowMs = Number(item && item.windowMs)
      var turnStartedAt = Number(item && item.turnStartedAt)
      var windowFromMs = Number(item && item.windowFromMs)
      var windowToMs = Number(item && item.windowToMs)

      var from = 0
      var to = 0
      var anchor = Number(item && item.anchor)
      if (turnStartedAt > 0 && windowFromMs >= turnStartedAt && windowToMs > windowFromMs) {
        // 时间窗落在本轮里的哪几分钟；中途回复过或跳档时也准确。
        from = Math.max(1, Math.floor((windowFromMs - turnStartedAt) / 60000) + 1)
        to = Math.max(from, Math.ceil((windowToMs - turnStartedAt) / 60000))
        // 从本轮开始就一直没回复：第 2 条按累计口径显示「1–20 分」。
        if (anchor === turnStartedAt) from = 1
      } else if (isFinite(windowMs) && windowMs >= 1000 && isFinite(bucket) && bucket >= 1) {
        var span = Math.max(1, Math.round(windowMs / 60000))
        from = 1
        to = bucket * span
      }
      if (to < 1) return ''
      if (from === to) {
        return short
          ? trf(t, 'progress.intervalOneShort', { minute: to }, to + ' 分')
          : trf(t, 'progress.intervalOne', { minute: to }, '第 ' + to + ' 分')
      }
      return short
        ? trf(t, 'progress.intervalShort', { from: from, to: to }, from + '–' + to + ' 分')
        : trf(t, 'progress.interval', { from: from, to: to }, '第 ' + from + '–' + to + ' 分')
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
     * 两种语义各自独立开关：
     * - activity：活动流水，读文件 / 跑命令 / 改代码，本地零成本；
     * - summary：语义摘要，走 Host 的便宜模型链，不进入模型上下文。
     *
     * 前者只读会话事件；后者由 `POST /api/wdx-relief/recap` 生成。
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

    /** 长思考保留最近的尾部：越靠后越接近当前进展。 */
    function clipTextTail(text, maxChars) {
      var value = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
      if (value.length <= maxChars) return value
      return '…' + value.slice(-maxChars).trim()
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
      // 命令的目标就是脚本参数，活动和进度都只保留「运行命令」。
      if (tool.verb === 'command') return tr(t, 'progress.command', '运行命令')
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

    /**
     * 消息里有没有「给用户看的正文」。reasoning 和 tool-call 不算：
     * 它们只出现在过程里，用户并没有因此收到一句回复。
     */
    function hasReplyText(message) {
      var content = message && message.content
      if (!Array.isArray(content)) return false
      for (var index = 0; index < content.length; index += 1) {
        var block = content[index]
        if (!block || block.type !== 'text') continue
        if (typeof block.text === 'string' && block.text.trim() !== '') return true
      }
      return false
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

    /** turn/end 的 reason 归一成界面状态；未知或旧格式按正常结束处理。 */
    function turnStatusOfReason(reason) {
      var kind = reason && typeof reason.kind === 'string' ? reason.kind : ''
      if (kind === 'completed' || kind === 'stop' || kind === '') return 'done'
      if (kind === 'aborted' || kind === 'legacy') return 'aborted'
      if (kind === 'error') return 'error'
      if (kind === 'blocked') return 'blocked'
      if (kind === 'max-tokens') return 'maxTokens'
      if (kind === 'interrupted') return 'interrupted'
      if (kind === 'forked') return 'forked'
      return 'done'
    }

    function turnStatusLabel(status, t) {
      if (status === 'running') return tr(t, 'turn.status.running', '进行中')
      if (status === 'done') return tr(t, 'turn.status.done', '已完成')
      if (status === 'aborted') return tr(t, 'turn.status.aborted', '已取消')
      if (status === 'error') return tr(t, 'turn.status.error', '出错')
      if (status === 'blocked') return tr(t, 'turn.status.blocked', '已拦截')
      if (status === 'interrupted') return tr(t, 'turn.status.interrupted', '已中断')
      if (status === 'maxTokens') return tr(t, 'turn.status.maxTokens', '输出上限')
      if (status === 'forked') return tr(t, 'turn.status.forked', '已分叉')
      return tr(t, 'turn.status.done', '已完成')
    }

    /**
     * 从事件窗口里推导当前这一轮。
     * @param {Array<object>} entries - `binding.eventSource.getSnapshot().entries`
     * @param {number} now - 当前时间，用来在运行中累计耗时
     * @param {{ running?: boolean }} [options]
     * @returns {{ turn: number, running: boolean, startedAt: number, elapsedMs: number, lastEventAt: number, silenceMs: number, lastReplyAt: number, quietMs: number, endedAt: number, endReason: object|null, status: string, steps: number, actions: Array<object>, tool: object|null, reasoning: string, phase: string }}
     *
     * 两个「静默」不是一回事：
     * - `silenceMs`：距最后一个事件多久，用来判断真的卡住了（无新输出）；
     * - `quietMs`：距最后一次给用户的正文回复多久，用来判断「跑很久了还没回话」。
     *   工具调用、思考、步骤事件都会刷新 `silenceMs`，但不会刷新 `quietMs`。
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
          return { turn: 0, running: false, startedAt: 0, elapsedMs: 0, lastEventAt: 0, silenceMs: 0, lastReplyAt: 0, quietMs: 0, endedAt: 0, endReason: null, status: 'idle', steps: 0, actions: [], tool: null, reasoning: '', phase: 'idle' }
        }
        while (anchor > 0 && eventTurn(eventOf(list[anchor - 1])) === turn) anchor -= 1
      }

      var first = eventOf(list[anchor]) || {}
      var startedAt = typeof first.time === 'number' ? first.time : (typeof now === 'number' ? now : Date.now())
      var lastTime = startedAt
      var lastReplyAt = startedAt
      var endedAt = 0
      var endReason = null
      var steps = 0
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
          steps += 1
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
          if (typeof resultId === 'string') {
            for (var actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
              if (actions[actionIndex].callId === resultId) actions[actionIndex].done = true
            }
            if (tool !== null && resultId === tool.callId) phase = 'tool-done'
          } else if (tool !== null) {
            tool.done = true
            phase = 'tool-done'
          }
        } else if (event.type === 'assistant/live-chunk') {
          var chunk = objectOf(data.chunk)
          if (chunk.type === 'reasoning-delta') {
            reasoning += String(chunk.text || '')
            phase = 'reasoning'
          } else if (chunk.type === 'text-delta') {
            if (typeof chunk.text === 'string' && chunk.text.trim() !== '' && typeof event.time === 'number') lastReplyAt = event.time
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
          var assistantMessage = objectOf(data.message)
          var contentReasoning = reasoningFromContent(assistantMessage.content)
          if (contentReasoning !== '') reasoning = contentReasoning
          if (hasReplyText(assistantMessage) && typeof event.time === 'number') lastReplyAt = event.time
          phase = 'answering'
        } else if (event.type === 'turn/end') {
          endedAt = lastTime
          endReason = data.reason && typeof data.reason === 'object' ? data.reason : null
          phase = 'done'
        }
      }

      var running = endedAt === 0 && !(options && options.running === false)
      if (endedAt === 0 && options && options.running === false) endedAt = lastTime
      var nowMs = typeof now === 'number' ? now : Date.now()
      var elapsedMs = Math.max(0, (endedAt > 0 ? endedAt : nowMs) - startedAt)
      var silenceMs = running ? Math.max(0, nowMs - lastTime) : 0
      var quietMs = running ? Math.max(0, nowMs - lastReplyAt) : 0
      var status = running ? 'running' : (endReason === null ? 'interrupted' : turnStatusOfReason(endReason))

      return {
        turn: turn,
        running: running,
        startedAt: startedAt,
        elapsedMs: elapsedMs,
        lastEventAt: lastTime,
        silenceMs: silenceMs,
        lastReplyAt: lastReplyAt,
        quietMs: quietMs,
        endedAt: endedAt,
        endReason: endReason,
        status: status,
        steps: steps,
        actions: actions,
        tool: tool,
        reasoning: latestReasoningLine(reasoning),
        phase: phase,
      }
    }

    /** 把毫秒压成「2 分 10 秒」；t 只负责单位，数值格式保持稳定。 */
    function formatDuration(ms, t) {
      var seconds = typeof ms === 'number' && isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0
      if (seconds < 60) return trf(t, 'duration.seconds', { s: seconds }, seconds + ' 秒')
      var minutes = Math.floor(seconds / 60)
      var rest = seconds % 60
      if (minutes < 60) {
        if (rest === 0) return trf(t, 'duration.minuteOnly', { m: minutes }, minutes + ' 分')
        return trf(t, 'duration.minutes', { m: minutes, s: rest }, minutes + ' 分 ' + rest + ' 秒')
      }
      var hours = Math.floor(minutes / 60)
      return trf(t, 'duration.hours', { h: hours, m: minutes % 60 }, hours + ' 小时 ' + minutes % 60 + ' 分')
    }

    /** user/message 的 data 有的包在 message 里，有的直接是消息体。 */
    function messageOf(data) {
      if (data && data.message && typeof data.message === 'object') return data.message
      return data && typeof data === 'object' ? data : {}
    }

    function userPromptOf(data) {
      var message = messageOf(data)
      if (!Array.isArray(message.content)) return ''
      var source = message.source
      if (source && typeof source === 'object' && source.kind !== 'user' && source.kind !== 'user-question-reply') return ''
      var parts = []
      for (var index = 0; index < message.content.length; index += 1) {
        var block = message.content[index]
        if (!block || block.type !== 'text' || typeof block.text !== 'string' || block.text.trim() === '') continue
        parts.push(block.text.trim())
      }
      return clipText(parts.join('\n'), 200)
    }

    function StatusChip(props) {
      var children = []
      if (props.kind === 'running') {
        children.push(h('span', { key: 'dot', className: 'wdxt-dot' }))
      } else if (props.kind === 'stalled') {
        children.push(h('span', { key: 'dot', className: 'wdxt-dotStatic' }))
      } else if (props.kind === 'done') {
        children.push(h('span', { key: 'check', className: 'wdxt-check', 'aria-hidden': 'true' }, '✓'))
      }
      children.push(h('span', { key: 'label' }, props.label))
      return h('span', { className: 'wdxt-status', 'data-kind': props.kind, role: props.live === true ? 'status' : undefined, 'aria-live': props.live === true ? 'polite' : undefined }, children)
    }

    function turnStatusInfo(view, t, stalled) {
      if (!view || view.turn === 0) return null
      if (view.running) {
        return {
          kind: stalled ? 'stalled' : 'running',
          label: stalled ? tr(t, 'turn.status.stalled', '无新输出') : tr(t, 'turn.status.running', '进行中'),
        }
      }
      var status = typeof view.status === 'string' && view.status !== 'idle' ? view.status : 'done'
      return { kind: status, label: turnStatusLabel(status, t) }
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
    function buildTurnSegments(view, settings, t, summary, pinned) {
      var segments = []
      if (!view || view.turn === 0) return segments
      var progress = settings.progress === true
      // 判定只看「多久没给用户正文回复」：一直跑工具、一直思考也算没回复。
      var due = view.running && progress && typeof view.quietMs === 'number' && view.quietMs >= settings.stallMs
      var keepActivity = due || pinned === true
      if (progress) {
        var duration = formatDuration(view.elapsedMs, t)
        var text = view.running
          ? trf(t, 'turn.runningFor', { turn: view.turn, duration: duration }, '第 ' + view.turn + ' 轮 · 已进行 ' + duration)
          : trf(t, 'turn.took', { turn: view.turn, duration: duration }, '第 ' + view.turn + ' 轮 · 用时 ' + duration)
        if (due) {
          var waitingMs = Math.floor(view.quietMs / settings.stallMs) * settings.stallMs
          text += RECAP_SEP + trf(t, 'turn.waitingFor', { duration: formatDuration(waitingMs, t) }, '等待 ' + formatDuration(waitingMs, t))
        }
        segments.push({ key: 'progress', text: text, className: due ? 'wdxt-progress wdxt-progressStalled' : 'wdxt-progress' })
      }
      var activityShown = false
      if (settings.activity || keepActivity) {
        var activity = activityText(view, t)
        if (activity !== '') {
          segments.push({ key: 'activity', text: activity, className: 'wdxt-activity' })
          activityShown = true
        }
      }
      if (settings.summary && summary && summary.text) {
        segments.push({ key: 'summary', text: '※ ' + summary.text, className: 'wdxt-summary' })
      }
      // 完成后没有摘要时，至少留一句「最后做了什么」，否则这一行只剩状态和耗时。
      if (!view.running && progress && !activityShown && !(settings.summary && summary && summary.text)) {
        var lastActivity = activityText(view, t)
        if (lastActivity !== '') segments.push({ key: 'activity', text: lastActivity, className: 'wdxt-activity' })
      }
      return segments
    }

    function lineSettings(settings) {
      var value = (settings && settings.value) || settings || {}
      var stall = value.recapStallSeconds
      var stallSeconds = typeof stall === 'number' ? stall : Number(stall)
      if (!isFinite(stallSeconds) || stallSeconds < 60) stallSeconds = 600
      if (stallSeconds > 3600) stallSeconds = 3600
      return {
        activity: value.recapActivity === true,
        summary: value.recap !== false,
        progress: value.recapProgress !== false,
        stallMs: stallSeconds * 1000,
      }
    }

    /**
     * 只看与「当前轮 + 当前时间窗」相交的事件，并把这段时间压成
     * 叙述摘要的输入：思考片段和去参数的动作。
     * 命令的目标就是脚本参数，这里只保留动词；读写文件保留文件名。
     */
    function collectProgressDigest(entries, view, bucket, windowMs) {
      var span = Math.max(1, Number(windowMs) || 1)
      var turn = view && typeof view.turn === 'number' ? view.turn : 0
      var anchorTime = view && typeof view.lastReplyAt === 'number' ? view.lastReplyAt : 0
      var from = anchorTime + Math.max(0, bucket - 1) * span
      var to = anchorTime + bucket * span
      var empty = { from: from, to: to, windowMs: span, reasoning: '', actions: [] }
      if (turn === 0) return empty

      var reasoning = ''
      var actions = []
      var list = Array.isArray(entries) ? entries : []
      for (var index = 0; index < list.length; index += 1) {
        var event = eventOf(list[index])
        if (!event || eventTurn(event) !== turn) continue
        var time = typeof event.time === 'number' ? event.time : 0
        if (time < from || time >= to) continue
        var data = objectOf(event.data)

        if (event.type === 'assistant/live-chunk') {
          var chunk = objectOf(data.chunk)
          if (chunk.type === 'reasoning-delta') reasoning += String(chunk.text || '')
          continue
        }
        if (event.type === 'assistant/message') {
          var message = objectOf(data.message)
          var contentReasoning = reasoningFromContent(message.content)
          if (contentReasoning !== '') {
            // 同一步可能既有 live-chunk 又有完整 message：忽略空白差异后能互相包含时
            // 只留更全的一份，不同步骤的思考则追加，不能因为窗口里已有思考就整段丢弃。
            if (reasoning === '') reasoning = contentReasoning
            else {
              var normalizedReasoning = reasoning.replace(/\s+/gu, '')
              var normalizedContent = contentReasoning.replace(/\s+/gu, '')
              if (normalizedReasoning.indexOf(normalizedContent) === -1) {
                reasoning = normalizedContent.indexOf(normalizedReasoning) !== -1
                  ? contentReasoning
                  : reasoning + '\n' + contentReasoning
              } else if (normalizedContent.length > normalizedReasoning.length) {
                reasoning = contentReasoning
              }
            }
          }
          continue
        }
        if (event.type === 'tool/call') {
          var described = describeToolCall(data.name, data.arguments)
          var keepTarget = described.verb !== 'command' && described.verb !== 'search' && described.verb !== 'web'
          var target = keepTarget ? described.target : ''
          var found = null
          for (var actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
            if (actions[actionIndex].verb === described.verb && actions[actionIndex].target === target) {
              found = actions[actionIndex]
              break
            }
          }
          if (found === null) actions.push({ verb: described.verb, target: target, count: 1 })
          else found.count += 1
        }
      }
      return {
        from: from,
        to: to,
        windowMs: span,
        reasoning: clipTextTail(reasoning, 6000),
        actions: actions,
      }
    }

    function progressActionLabels(digest, t) {
      var labels = []
      var actions = digest && Array.isArray(digest.actions) ? digest.actions : []
      for (var index = 0; index < actions.length; index += 1) {
        var action = actions[index]
        var label = toolLabel({ verb: action.verb, target: action.target }, t)
        if (label === '') continue
        if (action.count > 1) label += ' ×' + action.count
        labels.push(label)
      }
      return labels
    }

    /** 本地兜底也要避开命令句，否则模型摘要被拦下后仍会显示脚本参数。 */
    function containsCommandText(text) {
      return /\/Users\/|\/home\/|\s--[A-Za-z][\w-]*|`[^`]+`/u.test(String(text || ''))
    }

    /** 模型失败时的本地兜底：思考片段里第一句不含命令的话 > 这段在做什么动作。 */
    function progressLocalSummary(digest, actions, t) {
      var reasoning = String((digest && digest.reasoning) || '')
        .replace(/<[^>]*signature[^>]*>/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
      if (reasoning !== '') {
        var sentences = reasoning.match(/[^。！？!?]{6,}[。！？!?]/gu) || [reasoning]
        for (var index = 0; index < sentences.length; index += 1) {
          if (!containsCommandText(sentences[index])) return clipText(sentences[index], 160)
        }
      }
      if (actions.length > 0) {
        return trf(t, 'progress.doing', { actions: actions.slice(0, 3).join('、') }, '在' + actions.slice(0, 3).join('、'))
      }
      return tr(t, 'progress.noOutput', '这段时间没有新输出')
    }

    /** DSH 会把当前语言同步到 <html lang>；只区分中英文，和插件字典一致。 */
    function activeUiLang() {
      try {
        var lang = document && document.documentElement ? String(document.documentElement.lang || '') : ''
        if (lang === '' && typeof navigator !== 'undefined') lang = String(navigator.language || '')
        if (lang !== '') return lang.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (error) {
        // 非浏览器环境按中文处理。
      }
      return 'zh'
    }

    /**
     * 运行中的进度快照：每 `stallMs` 没给用户回复记一条。
     * 摘要写「这 10 分钟的思路和进展」，不再罗列命令；真正的模型摘要由
     * Host 的 progress 路由生成，这里只带时间窗和思考片段过去。
     */
    function progressEntryOf(view, settings, t, entries, lang) {
      var bucket = Math.max(1, Math.floor(view.quietMs / settings.stallMs))
      var windowMs = settings.stallMs
      var digest = collectProgressDigest(entries, view, bucket, windowMs)
      var actions = progressActionLabels(digest, t)
      return {
        turn: view.turn,
        bucket: bucket,
        // 锚点跟着「上一次回复」走：同一次等待、同一个档位只记一条。
        anchor: typeof view.lastReplyAt === 'number' ? view.lastReplyAt : 0,
        status: 'stalled',
        summary: progressLocalSummary(digest, actions, t),
        activity: actions.join('；'),
        digest: {
          reasoning: digest.reasoning,
          actions: actions,
        },
        lang: lang === 'en' ? 'en' : 'zh',
        windowMs: windowMs,
        windowFromMs: digest.from,
        windowToMs: digest.to,
        turnStartedAt: typeof view.startedAt === 'number' ? view.startedAt : 0,
        elapsedMs: view.elapsedMs,
        silenceMs: bucket * windowMs,
        steps: view.steps,
      }
    }

    /**
     * 当前档位是不是「刚跨过去」。
     *
     * 只按 `floor(quietMs / stallMs)` 判断的话，切回会话、整页刷新、从休眠或
     * 后台唤醒后第一次看到的档位往往已经过去一大半；这时立刻记一条，下一条
     * 边界可能几十秒后就到，同一轮里就会出现两条只隔一两分钟的进度。
     *
     * 所以只有距档位起点不超过「间隔的一半，且不超过 1 分钟」才记（正常每秒
     * tick 时是 0–1 秒，后台节流到 1 分钟一次也还赶得上）；已经过期的档位直接
     * 跳过，等下一档。相邻两条因此至少隔「间隔 - 容差」。
     */
    function progressWindowOf(quietMs, stallMs) {
      var span = Math.max(1, Number(stallMs) || 1)
      var quiet = Math.max(0, Number(quietMs) || 0)
      var bucket = Math.floor(quiet / span)
      var offset = quiet - bucket * span
      var tolerance = Math.max(1000, Math.min(60000, Math.floor(span / 2)))
      return { bucket: bucket, fresh: bucket >= 1 && offset <= tolerance }
    }

    /**
     * 这一秒该不该记一条进度；该记时返回档位和去重键，不该记时返回 null。
     * 同一次等待、同一个档位只发一次：键里带 turn + 上一次回复时间和档位。
     */
    function progressDueOf(view, cfg, reported) {
      if (!view || view.running !== true || view.turn === 0) return null
      if (!cfg || cfg.progress !== true) return null
      var window = progressWindowOf(view.quietMs, cfg.stallMs)
      if (!window.fresh) return null
      var key = view.turn + ':' + view.lastReplyAt + ':' + window.bucket
      if (reported && reported[key] === true) return null
      return { bucket: window.bucket, key: key }
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
     * 组件本身不写任何状态到会话；activity 来自事件窗口，
     * summary 来自 Host 的 `recap` 路由。开关在插件配置里，不进入 prompt。
     */
    function TurnRecapDock(props) {
      var sessionId = props.sessionId
      var useSession = props.useSession
      var useInput = props.useInput
      var useSettings = props.useSettings
      var readFeed = props.readFeed
      var openProgress = props.openProgress
      var t = props.t

      var running = (useSession ? useSession(function (s) { return s && s.running }) : false) || false
      var input = (useInput ? useInput(function (s) { return s }) : undefined) || {}
      var settings = useSettings ? useSettings(function (s) { return s }) : undefined
      var draft = typeof input.draft === 'string' ? input.draft : ''
      var attachments = Array.isArray(input.attachmentIds) ? input.attachmentIds.length : 0
      var cfg = lineSettings(settings)

      var [entries, setEntries] = useState([])
      var [tick, setTick] = useState(0)
      var [summary, setSummary] = useState(null)
      var [dismissedTurn, setDismissedTurn] = useState(0)
      var [waitedTurn, setWaitedTurn] = useState(0)
      var requested = useRef('')
      var activeSession = useRef('')
      var reportedBuckets = useRef({})

      // 切换会话时清掉上一会话的摘要、静默标记和请求去重键。
      useEffect(function () {
        setEntries([])
        setSummary(null)
        setDismissedTurn(0)
        setWaitedTurn(0)
        requested.current = ''
        activeSession.current = ''
        reportedBuckets.current = {}
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

      // 两种情况分开：`stalled` 只表示「没有任何事件」（真卡住）；`due` 表示
      // 「跑够久了还没给用户正文回复」，即使工具一直在动也算。
      var stalled = Boolean(view.running && cfg.progress && view.silenceMs >= cfg.stallMs)
      var due = Boolean(view.running && cfg.progress && view.quietMs >= cfg.stallMs)
      useEffect(function () {
        if (!due) return
        setWaitedTurn(function (current) { return current === view.turn ? current : view.turn })
      }, [due, view.turn])
      var stickyProgress = due || (view.running && waitedTurn === view.turn)

      // 超过一个间隔还没回复，就往「会话回顾」记一条进度；同一轮同一次等待同一档只发一次。
      // 只记「刚跨过去」的档位：切回会话、刷新、从休眠唤醒时，当前档位常常已经
      // 过了一大半，这时补记一条，下一条边界几十秒后就跟上，看起来像两条只隔 1 分钟。
      var progressWindow = view.running && cfg.progress ? progressWindowOf(view.quietMs, cfg.stallMs) : null
      var progressBucket = progressWindow === null ? 0 : progressWindow.bucket
      useEffect(function () {
        if (!sessionId) return
        var plan = progressDueOf(view, cfg, reportedBuckets.current)
        if (plan === null) return
        reportedBuckets.current[plan.key] = true
        requestProgress(sessionId, progressEntryOf(view, cfg, t, entries, activeUiLang())).catch(function () {
          // 失败不重试；下一个间隔继续。
        })
      }, [progressBucket, sessionId, view.turn, view.lastReplyAt])

      // 轮次结束后去 Host 要一次语义摘要。Host 侧按 minTurns / cooldown /
      // similarity 决定是否真的调用模型；这里只按轮次去重。
      useEffect(function () {
        if (!cfg.summary) {
          setSummary(null)
          requested.current = ''
          return undefined
        }
        if (!sessionId || running || view.turn === 0) return undefined
        if (activeSession.current !== sessionId) return undefined
        var key = sessionId + ':' + view.turn
        if (requested.current === key) return undefined
        requested.current = key
        // 不在下一轮开始时 abort：上一轮的摘要还在 Host 侧生成，取消会让
        // 它既不出现在这一行，也永远进不了「会话回顾」，上一轮就丢了记录。
        requestRecap(sessionId).then(function (recap) {
          if (activeSession.current !== sessionId) return
          var text = formatRecap(recap, t)
          if (text === '') return
          // 上一轮的请求可能比新一轮晚回来；不要让旧摘要覆盖已经拿到的新摘要。
          setSummary(function (previous) {
            if (previous !== null && typeof previous.turn === 'number' && previous.turn > view.turn) return previous
            return { text: text, turn: view.turn }
          })
        }).catch(function () {
          // 摘要失败时静默：本地三种信息仍然可用，不打扰主任务。
        })
      }, [cfg.summary, sessionId, running, view.turn])

      if (!sessionId) return null
      if (draft.trim() !== '' || attachments > 0) return null

      // 运行中先展示本地活动；语义摘要只在上一条轮次结束后出现，避免把旧摘要说成这一轮。
      var visibleSummary = summary !== null && summary.turn === view.turn && !running ? summary : null
      var segments = buildTurnSegments(view, cfg, t, visibleSummary, stickyProgress)
      // 可见性可以「钉住」，状态永远用实时静默判断，避免恢复输出后还显示无新输出。
      var status = cfg.progress ? turnStatusInfo(view, t, stalled) : null
      var showRunning = view.running && (cfg.activity || (cfg.progress && stickyProgress))
      // 完成态只在三种情况下出现：有摘要、用户开了活动流水、或这一轮曾经无新输出。
      // 普通轮次结束后不常驻一条「已完成」，否则又变回噪音。
      var showCompleted = !view.running && ((cfg.summary && visibleSummary !== null) || cfg.activity || (cfg.progress && waitedTurn === view.turn))
      if (view.turn === 0 || (!showRunning && !showCompleted)) return null
      if ((segments.length === 0 && status === null) || dismissedTurn === view.turn) return null

      var fullTitle = (status === null ? [] : [status.label]).concat(segments.map(function (segment) { return segment.text })).join(RECAP_SEP)
      var progressInterval = formatDuration(cfg.stallMs, t)
      var progressHint = trf(t, 'turn.progressHint', { duration: progressInterval }, '每 ' + progressInterval + ' 在「会话回顾」记一条进度')
      var children = [h(PluginStyles, { key: 'style', scope: 'turn-line' })]
      if (status !== null) children.push(h(StatusChip, { key: 'status', kind: status.kind, label: status.label, live: true, t: t }))
      for (var index = 0; index < segments.length; index += 1) {
        if (index > 0) children.push(h('span', { key: 'sep' + index, className: 'wdxt-sep' }, '·'))
        children.push(h('span', {
          key: segments[index].key,
          className: 'wdxt-seg ' + segments[index].className,
          title: segments[index].key === 'progress' ? progressHint : undefined,
        }, segments[index].text))
      }
      if (typeof openProgress === 'function') {
        children.push(h('button', {
          key: 'open',
          type: 'button',
          className: 'wdxt-open',
          title: tr(t, 'progress.open', '查看进度'),
          'aria-label': tr(t, 'progress.open', '查看进度'),
          onClick: openProgress,
        }, '›'))
      }
      children.push(h('button', {
        key: 'close',
        type: 'button',
        className: 'wdxt-close',
        title: tr(t, 'turn.dismiss', '本轮不再显示这一行'),
        'aria-label': tr(t, 'turn.dismiss', '本轮不再显示这一行'),
        onClick: function () { setDismissedTurn(view.turn) },
      }, '×'))

      return h('div', { className: 'wdxt-root', 'data-wdx-turn-line': true, 'data-placement': 'above' }, [
        h('div', {
          className: 'wdxt-row',
          title: fullTitle,
          'data-state': view.running ? (stalled ? 'stalled' : 'running') : view.status,
        }, children),
      ])
    }

    // --------------------------------------------------------------- relief

    /**
     * WDX Relief 的右侧栏页面。
     *
     * 两个 Tab：会话回顾（摘要 + 进度 + 待跟进）和旁问；
     * 待跟进不再跨会话，而是落在当前会话最新一轮的「待跟进」标记上。
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
    /** 摘要/回复里以「下一步 / 需要你 / 等你」开头时，视为这一轮留给用户的待跟进。 */
    var RECAP_NEXT_STEP_RE = /^(下一步|接下来|还需要|需要你|需要您|等你|请你|请您|next step|you need|please|waiting for)/iu

    function recapEntryTime(item) {
      return typeof item.at === 'number' ? item.at : 0
    }

    /** 进度记录带 elapsedMs，可以反推出这一轮的开始时间；摘要只能取记录时间。 */
    function recapEntryStart(item) {
      var at = recapEntryTime(item)
      if (item.kind === 'progress' && typeof item.elapsedMs === 'number' && item.elapsedMs > 0) {
        return Math.max(0, at - item.elapsedMs)
      }
      return at
    }

    /**
     * 按轮次分组：同一轮的进度快照和摘要放在一起。
     * 组按最后一条记录的时间排序，order 为 desc 时反转；组内也按同样方向排序。
     * 旧记录没有 turn 时归到「更早的记录」。
     */
    function groupRecapEntries(items, order) {
      var groups = []
      var byKey = new Map()
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index]
        var hasTurn = typeof item.turn === 'number'
        var key = hasTurn ? 't:' + item.turn : 'u'
        var group = byKey.get(key)
        if (group === undefined) {
          group = { key: key, turn: hasTurn ? item.turn : null, entries: [], firstAt: 0, lastAt: 0 }
          byKey.set(key, group)
          groups.push(group)
        }
        group.entries.push(item)
        var at = recapEntryTime(item)
        var start = recapEntryStart(item)
        if (group.firstAt === 0 || start < group.firstAt) group.firstAt = start
        if (at > group.lastAt) group.lastAt = at
      }
      groups.sort(function (left, right) { return (left.lastAt || 0) - (right.lastAt || 0) })
      if (order === 'desc') groups.reverse()
      for (var cursor = 0; cursor < groups.length; cursor += 1) {
        groups[cursor].entries.sort(function (left, right) { return recapEntryTime(left) - recapEntryTime(right) })
        if (order === 'desc') groups[cursor].entries.reverse()
      }
      // 「更早的记录」没有轮次信息，固定放到列表末尾，不夹在轮次中间。
      var unknown = groups.filter(function (group) { return group.key === 'u' })
      if (unknown.length > 0) groups = groups.filter(function (group) { return group.key !== 'u' }).concat(unknown)
      return groups
    }

    function recapItemKey(item) {
      if (item.kind === 'progress') return 'p:' + item.seq + ':' + item.turn + ':' + (item.anchor || 0) + ':' + item.bucket
      return 's:' + item.seq
    }

    function recapGroupTime(group, t) {
      var last = formatRecapTime(group.lastAt)
      if (last === '') return ''
      var span = group.lastAt - group.firstAt
      if (!(span > 0)) return last
      return trf(t, 'panel.recapGroupSpan', { time: last, duration: formatDuration(span, t) }, last + ' · 用时 ' + formatDuration(span, t))
    }

    /** 空列表提示只承诺当前开关真的会产出什么，避免关掉功能后还提示「聊一轮就会出现」。 */
    function recapEmptyText(summaryEnabled, progressEnabled, t) {
      if (!summaryEnabled && !progressEnabled) return tr(t, 'panel.recapEmptyOff', '语义摘要和实时进度都已关闭；在插件设置里打开一个后才会记录')
      if (summaryEnabled && !progressEnabled) return tr(t, 'panel.recapEmptySummary', '还没有摘要；聊过一轮后会出现')
      if (!summaryEnabled && progressEnabled) return tr(t, 'panel.recapEmptyProgress', '还没有进度记录；一轮跑久了还没给你回复时会出现')
      return tr(t, 'panel.recapEmpty', '还没有生成过摘要或进度记录；聊过一轮，或一轮跑久了还没回复时就会出现')
    }

    /** 「待跟进」筛选按轮次计数，和按条计数的摘要 / 进度分开标注单位。 */
    function pendingCountLabel(count, t) {
      if (count === 1) return trf(t, 'panel.recapPendingCountOne', { count: count }, count + ' 轮')
      return trf(t, 'panel.recapPendingCount', { count: count }, count + ' 轮')
    }

    function latestRecordedTurn(entries) {
      var list = Array.isArray(entries) ? entries : []
      for (var index = list.length - 1; index >= 0; index -= 1) {
        var event = eventOf(list[index])
        if (event && event.type === 'turn/start') return eventTurn(event)
      }
      return 0
    }

    /**
     * 当前会话的最新轮次，用来判断「待跟进」是否真的属于最后这一轮。
     * 历史里最大的 turn 可能落后于刚结束、但摘要没写进历史的一轮，不能只看历史。
     */
    function useCurrentTurn(readFeed, sessionId) {
      var [turn, setTurn] = useState(0)
      useEffect(function () {
        if (!sessionId || typeof readFeed !== 'function') {
          setTurn(0)
          return undefined
        }
        var feed = null
        try {
          feed = readFeed(sessionId)
        } catch (error) {
          feed = null
        }
        if (!feed) {
          setTurn(0)
          return undefined
        }
        function update() {
          try {
            var snapshot = feed.getSnapshot()
            setTurn(latestRecordedTurn(snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : []))
          } catch (error) {
            // 会话关闭时静默。
          }
        }
        update()
        return feed.subscribe(update)
      }, [sessionId, readFeed])
      return turn
    }

    /**
     * 会话回顾：摘要和进度快照按轮次分组，组可折叠；支持最新在前 / 最早在前。
     * 只读本地记录，不重新生成；打开期间每 30 秒静默刷新一次。
     */
    function RecapHistorySection(props) {
      var sessionId = props.sessionId
      var t = props.t
      var initialFilter = props.initialFilter
      var initialFilterRevision = props.initialFilterRevision
      var initialOrder = props.initialOrder
      var running = props.running === true
      var summaryEnabled = props.summaryEnabled !== false
      var progressEnabled = props.progressEnabled !== false
      var currentTurn = typeof props.currentTurn === 'number' ? props.currentTurn : 0
      var configuredPendingTurns = Number(props.pendingTurns)
      var pendingTurns = Number.isFinite(configuredPendingTurns) ? Math.max(1, Math.min(20, Math.round(configuredPendingTurns))) : 3
      var [state, setState] = useState({ status: 'loading', items: [] })
      var [filter, setFilter] = useState(initialFilter === 'progress' || initialFilter === 'summary' || initialFilter === 'pending' ? initialFilter : 'all')
      var [order, setOrder] = useState(initialOrder === 'asc' ? 'asc' : 'desc')
      var [openKey, setOpenKey] = useState(null)
      var [confirmClear, setConfirmClear] = useState(false)
      var [clearError, setClearError] = useState(false)
      var [openTurn, setOpenTurn] = useState(undefined)
      var controllerRef = useRef(null)
      var pendingRef = useRef(false)

      function load(silent) {
        if (!sessionId) {
          if (!silent) setState({ status: 'empty', items: [] })
          return
        }
        // 自动轮询不打断正在进行的手动加载，避免把 loading 状态卡住。
        if (silent && pendingRef.current) return
        if (controllerRef.current) controllerRef.current.abort()
        var controller = new AbortController()
        controllerRef.current = controller
        pendingRef.current = true
        if (!silent) setState({ status: 'loading', items: [] })
        requestRecapHistory(sessionId, controller.signal).then(function (result) {
          pendingRef.current = false
          if (controller.signal.aborted) return
          if (result.error) {
            if (!silent) setState({ status: 'error', items: [], code: result.code || '' })
            return
          }
          var items = result.items || []
          setState({ status: items.length === 0 ? 'empty' : 'ready', items: items })
        }).catch(function () {
          pendingRef.current = false
          if (!controller.signal.aborted && !silent) setState({ status: 'error', items: [] })
        })
      }

      function clearAll() {
        if (!sessionId) return
        if (controllerRef.current) controllerRef.current.abort()
        var controller = new AbortController()
        controllerRef.current = controller
        requestRecapHistory(sessionId, controller.signal, true).then(function (result) {
          if (controller.signal.aborted) return
          if (result.error) {
            setClearError(true)
            return
          }
          setOpenKey(null)
          setConfirmClear(false)
          setClearError(false)
          setState({ status: 'empty', items: [] })
        }).catch(function () {
          if (!controller.signal.aborted) setClearError(true)
        })
      }

      useEffect(function () {
        load(false)
        var timer = setInterval(function () { load(true) }, 30000)
        return function () {
          clearInterval(timer)
          if (controllerRef.current) controllerRef.current.abort()
        }
      }, [sessionId])

      useEffect(function () {
        if (initialFilter === 'all' || initialFilter === 'summary' || initialFilter === 'progress' || initialFilter === 'pending') {
          setFilter(initialFilter)
          setOpenKey(null)
        }
      }, [initialFilter, initialFilterRevision])

      // 轮次结束时刷新一次：上一轮的摘要可能刚写入历史，30 秒轮询太慢。
      // 摘要生成有模型延迟，3 秒后再补一次，尽量不让「主对话有、面板没有」停留在界面上。
      useEffect(function () {
        if (!sessionId || running) return undefined
        load(true)
        var timer = setTimeout(function () { load(true) }, 3000)
        return function () { clearTimeout(timer) }
      }, [running, sessionId])

      useEffect(function () {
        setOpenTurn(undefined)
        setOpenKey(null)
        setConfirmClear(false)
        setClearError(false)
      }, [sessionId])

      var items = state.items
      var groups = groupRecapEntries(items, order)
      var summaryCount = 0
      var progressCount = 0
      for (var index = 0; index < items.length; index += 1) {
        if (items[index].kind === 'progress') progressCount += 1
        else summaryCount += 1
      }

      function groupPending(group) {
        if (currentTurn === 0 || typeof group.turn !== 'number') return false
        // 正在跑的这一轮还没结束，不标；已经结束的上一轮即使会话在跑也保留标记。
        if (running && group.turn >= currentTurn) return false
        if (group.turn < currentTurn - pendingTurns + 1 || group.turn > currentTurn) return false
        for (var pendingIndex = 0; pendingIndex < group.entries.length; pendingIndex += 1) {
          var entry = group.entries[pendingIndex]
          if (entry.kind === 'progress') continue
          if (entry.kind === 'question') return true
          if (typeof entry.question === 'string' && entry.question !== '') return true
          if (typeof entry.assistant === 'string' && RECAP_NEXT_STEP_RE.test(entry.assistant.trim())) return true
          if (typeof entry.summary === 'string' && RECAP_NEXT_STEP_RE.test(entry.summary.trim())) return true
        }
        return false
      }

      var pendingCount = 0
      for (var pendingIndex = 0; pendingIndex < groups.length; pendingIndex += 1) {
        if (groupPending(groups[pendingIndex])) pendingCount += 1
      }

      var visibleGroups = []
      var visibleCount = 0
      for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        var group = groups[groupIndex]
        var pending = groupPending(group)
        var entries
        if (filter === 'pending') {
          if (!pending) continue
          entries = group.entries
        } else {
          entries = group.entries.filter(function (item) {
            if (filter === 'progress') return item.kind === 'progress'
            if (filter === 'summary') return item.kind !== 'progress'
            return true
          })
        }
        if (entries.length === 0) continue
        var shownProgress = 0
        var shownSummary = 0
        for (var entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
          if (entries[entryIndex].kind === 'progress') shownProgress += 1
          else shownSummary += 1
        }
        visibleGroups.push({
          key: group.key,
          turn: group.turn,
          firstAt: group.firstAt,
          lastAt: group.lastAt,
          entries: entries,
          shownProgress: shownProgress,
          shownSummary: shownSummary,
          pending: pending,
        })
        visibleCount += entries.length
      }

      var newestKey = ''
      var newestAt = -1
      for (var newestIndex = 0; newestIndex < visibleGroups.length; newestIndex += 1) {
        // 「更早的记录」不参与默认展开，优先展开最新的真实轮次。
        if (visibleGroups[newestIndex].turn === null) continue
        if ((visibleGroups[newestIndex].lastAt || 0) >= newestAt) {
          newestAt = visibleGroups[newestIndex].lastAt || 0
          newestKey = visibleGroups[newestIndex].key
        }
      }
      if (newestKey === '') {
        for (var fallbackIndex = 0; fallbackIndex < visibleGroups.length; fallbackIndex += 1) {
          if ((visibleGroups[fallbackIndex].lastAt || 0) >= newestAt) {
            newestAt = visibleGroups[fallbackIndex].lastAt || 0
            newestKey = visibleGroups[fallbackIndex].key
          }
        }
      }
      var expandedKey = openTurn === undefined ? newestKey : openTurn

      function chooseFilter(id) {
        setFilter(id)
        setOpenKey(null)
        setConfirmClear(false)
        setClearError(false)
        setOpenTurn(undefined)
        if (typeof props.onFilterChange === 'function') props.onFilterChange(id)
      }

      function chooseOrder(id) {
        setOrder(id)
        if (typeof props.onOrderChange === 'function') props.onOrderChange(id)
      }

      function pill(id, label, active, onClick, countValue, countText) {
        return h('button', {
          key: id,
          type: 'button',
          className: 'wdxp-filter' + (active ? ' wdxp-filterActive' : ''),
          'aria-pressed': active,
          onClick: onClick,
        }, [
          h('span', { key: 'label' }, label),
          typeof countValue === 'number' && countValue > 0
            ? h('span', { key: 'count', className: 'wdxp-filterCount' }, countText !== undefined ? countText : String(countValue))
            : null,
        ])
      }

      function toggleGroup(key) {
        setOpenTurn(expandedKey === key ? null : key)
      }

      function progressDetail(item) {
        var elapsed = formatDuration(item.elapsedMs, t)
        var silence = formatDuration(item.silenceMs, t)
        var interval = progressIntervalText(item, t)
        return h('div', { key: 'detail', className: 'wdxh-detail' }, [
          typeof item.turn === 'number' ? h('p', { key: 'turn', className: 'wdxh-line' }, [
            h('span', { key: 'label', className: 'wdxh-label' }, tr(t, 'progress.turnLabel', '轮次')),
            trf(t, 'progress.turn', { turn: item.turn }, '第 ' + item.turn + ' 轮'),
          ]) : null,
          interval !== '' ? h('p', { key: 'interval', className: 'wdxh-line' }, [
            h('span', { key: 'label', className: 'wdxh-label' }, tr(t, 'progress.intervalLabel', '时间窗')),
            interval,
          ]) : null,
          h('p', { key: 'elapsed', className: 'wdxh-line' }, [
            h('span', { key: 'label', className: 'wdxh-label' }, tr(t, 'progress.elapsedLabel', '总耗时')),
            elapsed,
          ]),
          h('p', { key: 'silence', className: 'wdxh-line' }, [
            h('span', { key: 'label', className: 'wdxh-label' }, tr(t, 'progress.quietLabel', '未回复')),
            silence,
          ]),
          typeof item.steps === 'number' && item.steps > 0 ? h('p', { key: 'steps', className: 'wdxh-line' }, [
            h('span', { key: 'label', className: 'wdxh-label' }, tr(t, 'progress.stepsLabel', '步数')),
            String(item.steps),
          ]) : null,
          item.activity ? h('p', { key: 'activity', className: 'wdxh-line' }, [
            h('span', { key: 'label', className: 'wdxh-label' }, tr(t, 'progress.actions', '本段动作')),
            item.activity,
          ]) : null,
        ])
      }

      function recapDetail(item) {
        return h('div', { key: 'detail', className: 'wdxh-detail' }, [
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
      }

      function entryRow(item) {
        var key = recapItemKey(item)
        var open = openKey === key
        var isProgress = item.kind === 'progress'
        var interval = isProgress ? progressIntervalText(item, t, 'short') : ''
        return h('li', { key: key, className: 'wdxp-item' }, [
          h('button', {
            key: 'row',
            type: 'button',
            className: 'wdxp-row wdxh-row',
            title: item.summary,
            'aria-expanded': open,
            onClick: function () { setOpenKey(open ? null : key) },
          }, [
            h('span', { key: 'kind', className: 'wdxh-kind' }, isProgress
              ? tr(t, 'panel.recapTagProgress', '进度')
              : (item.degraded === true
                  ? tr(t, 'panel.recapTagLocal', '本地摘要')
                  : tr(t, 'panel.recapTagSummary', '摘要'))),
            h('span', { key: 'text', className: 'wdxp-rowText' }, item.summary),
            h('span', { key: 'meta', className: 'wdxp-rowMetaCol' }, [
              h('span', { key: 'time', className: 'wdxp-rowMeta' }, formatRecapTime(item.at)),
              interval !== '' ? h('span', { key: 'interval', className: 'wdxp-rowInterval' }, interval) : null,
            ]),
          ]),
          open ? (isProgress ? progressDetail(item) : recapDetail(item)) : null,
        ])
      }

      function groupBlock(group) {
        var expanded = expandedKey === group.key
        var title = group.turn === null
          ? tr(t, 'panel.recapUnknownTurn', '更早的记录')
          : trf(t, 'progress.turn', { turn: group.turn }, '第 ' + group.turn + ' 轮')
        var time = recapGroupTime(group, t)
        return h('li', { key: group.key, className: 'wdxp-group' }, [
          h('button', {
            key: 'head',
            type: 'button',
            className: 'wdxp-groupHead',
            'aria-expanded': expanded,
            onClick: function () { toggleGroup(group.key) },
          }, [
            h('span', { key: 'title', className: 'wdxp-groupTitle' }, title),
            group.shownProgress > 0
              ? h('span', { key: 'progress', className: 'wdxp-groupCount' }, trf(t, 'panel.recapGroupProgress', { count: group.shownProgress }, '进度 ' + group.shownProgress))
              : null,
            group.shownSummary > 0
              ? h('span', { key: 'summary', className: 'wdxp-groupCount' }, trf(t, 'panel.recapGroupSummary', { count: group.shownSummary }, '摘要 ' + group.shownSummary))
              : null,
            group.pending
              ? h('span', {
                  key: 'pending',
                  className: 'wdxp-groupPending',
                  title: tr(t, 'panel.recapPendingHint', '这一轮结束时留下了问题或下一步'),
                }, tr(t, 'panel.recapPending', '待跟进'))
              : null,
            time !== '' ? h('span', { key: 'time', className: 'wdxp-groupTime' }, time) : null,
            h('span', { key: 'caret', className: 'wdxp-groupCaret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
          ]),
          expanded
            ? h('div', { key: 'body', className: 'wdxp-groupBody' },
                h('ul', { className: 'wdxp-list wdxp-groupList' }, group.entries.map(entryRow)))
            : null,
        ])
      }

      var body
      if (state.status === 'loading') {
        body = h('div', { key: 'skeleton', className: 'wdxp-skeleton' }, [
          h('div', { key: 'a', className: 'wdxp-skeletonRow' }),
          h('div', { key: 'b', className: 'wdxp-skeletonRow' }),
        ])
      } else if (state.status === 'error') {
        body = h('div', { key: 'error', className: 'wdxp-rows' }, [
          h('p', { key: 'message', className: 'wdxp-note' },
            state.code === 'route-missing'
              ? tr(t, 'panel.recapRouteMissing', '回顾历史路由没加载；重启 DSH 后再试')
              : tr(t, 'panel.recapError', '回顾历史读取失败')),
          state.code === 'route-missing'
            ? null
            : h('button', {
                key: 'retry',
                type: 'button',
                className: 'wdxp-link',
                onClick: function () { load(false) },
              }, tr(t, 'panel.recapRetry', '重试')),
        ])
      } else if (state.status === 'empty') {
        body = h('p', { key: 'empty', className: 'wdxp-note' }, sessionId
          ? recapEmptyText(summaryEnabled, progressEnabled, t)
          : tr(t, 'panel.recapNoSession', '先打开一个会话'))
      } else {
        var list = visibleGroups.length === 0
          ? h('p', { key: 'filterEmpty', className: 'wdxp-note' }, filter === 'pending'
              ? (!summaryEnabled
                  ? tr(t, 'panel.recapPendingNoSummary', '语义摘要已关闭；待跟进标记来自摘要记录，打开摘要后才会出现')
                  : (running
                      ? tr(t, 'panel.recapPendingRunning', '正在跑的这轮不标待跟进；已结束的轮次仍会保留')
                      : tr(t, 'panel.recapPendingEmpty', '目前没有待跟进的轮次')))
              : tr(t, 'panel.recapFilterEmpty', '这个筛选下还没有记录'))
          : h('ul', { key: 'groups', className: 'wdxp-groups' }, visibleGroups.map(groupBlock))
        body = h('div', { key: 'rows', className: 'wdxp-rows' }, [
          h('div', { key: 'toolbar', className: 'wdxh-toolbar' }, [
            h('span', { key: 'count', className: 'wdxh-count' },
              trf(t, 'panel.recapCount', { count: visibleCount }, '共 ' + visibleCount + ' 条')),
            h('div', { key: 'filters', className: 'wdxp-filters' }, [
              pill('all', tr(t, 'panel.recapFilterAll', '全部'), filter === 'all', function () { chooseFilter('all') }, items.length),
              pill('summary', tr(t, 'panel.recapFilterSummary', '摘要'), filter === 'summary', function () { chooseFilter('summary') }, summaryCount),
              pill('progress', tr(t, 'panel.recapFilterProgress', '进度'), filter === 'progress', function () { chooseFilter('progress') }, progressCount),
              pill('pending', tr(t, 'panel.recapFilterPending', '待跟进'), filter === 'pending', function () { chooseFilter('pending') }, pendingCount, pendingCountLabel(pendingCount, t)),
            ]),
            h('div', { key: 'order', className: 'wdxp-filters' }, [
              pill('desc', tr(t, 'panel.recapOrderDesc', '最新在前'), order === 'desc', function () { chooseOrder('desc') }),
              pill('asc', tr(t, 'panel.recapOrderAsc', '最早在前'), order === 'asc', function () { chooseOrder('asc') }),
            ]),
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'wdxp-link',
              onClick: function () { load(false) },
            }, tr(t, 'panel.refresh', '刷新')),
            h('button', {
              key: 'clear',
              type: 'button',
              className: 'wdxp-link',
              onClick: function () {
                setClearError(false)
                setConfirmClear(true)
              },
            }, tr(t, 'panel.recapClear', '清空')),
          ]),
          confirmClear
            ? h('div', { key: 'confirm', className: 'wdxp-confirm' }, [
                h('span', { key: 'text', className: 'wdxp-confirmText' }, tr(t, 'panel.recapClearConfirm', '删除当前会话的全部摘要和进度记录？')),
                clearError
                  ? h('span', { key: 'error', className: 'wdxp-confirmText wdxp-danger' }, tr(t, 'panel.recapClearFailed', '清空失败，请重试'))
                  : null,
                h('button', { key: 'yes', type: 'button', className: 'wdxp-link wdxp-danger', onClick: clearAll }, tr(t, 'panel.recapClearYes', '确认清空')),
                h('button', { key: 'no', type: 'button', className: 'wdxp-link', onClick: function () { setConfirmClear(false); setClearError(false) } }, tr(t, 'panel.recapClearNo', '取消')),
              ])
            : null,
          list,
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
        requestBtw(sessionId, question, override, controller.signal, t).then(function (result) {
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
              ? { ...item, status: 'cancelled', error: tr(t, 'btw.cancelled', '已取消') }
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
            } else if (item.status === 'cancelled') {
              body = h('div', { key: 'body', className: 'wdxa-note' }, item.error || tr(t, 'btw.cancelled', '已取消'))
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
      var modelDirectories = props.modelDirectories
      var readFeed = props.readFeed
      var currentTurn = useCurrentTurn(readFeed, sessionId)
      var t = props.t
      var requestedTab = props.requestedTab
      var requestedRevision = props.requestedRevision
      var requestedFilter = props.requestedFilter
      var configuredTab = props.defaultTab
      var sessionRunning = props.running === true
      var summaryEnabled = props.summaryEnabled !== false
      var progressEnabled = props.progressEnabled !== false
      var configuredPendingTurns = Number(props.pendingTurns)
      var pendingTurns = Number.isFinite(configuredPendingTurns) ? Math.max(1, Math.min(20, Math.round(configuredPendingTurns))) : 3
      var initialTab = configuredTab === 'btw' ? 'btw' : 'recaps'
      var [tab, setTab] = useState(initialTab)
      var [recapFilter, setRecapFilter] = useState('all')
      var [recapFilterRevision, setRecapFilterRevision] = useState(0)
      var [recapOrder, setRecapOrder] = useState('desc')

      // 从输入框上方那一行跳进来时，直接落到「会话回顾」并按「进度」筛选；
      // 重复点击靠 revision 再触发一次。
      useEffect(function () {
        if (requestedTab === 'recaps' || requestedTab === 'btw') setTab(requestedTab)
      }, [requestedTab, requestedRevision])

      useEffect(function () {
        if (requestedFilter === 'all' || requestedFilter === 'summary' || requestedFilter === 'progress' || requestedFilter === 'pending') {
          setRecapFilter(requestedFilter)
          setRecapFilterRevision(function (value) { return value + 1 })
        }
      }, [requestedFilter, requestedRevision])

      function tabClass(id) {
        return 'wdxp-tab' + (tab === id ? ' wdxp-tabActive' : '')
      }

      return h('div', { className: 'wdxp-page' }, [
        h(PluginStyles, { key: 'style', scope: 'relief' }),
        h('div', { key: 'tabs', className: 'wdxp-tabs', role: 'tablist' }, [
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
        ]),
        h('div', {
          key: 'recaps',
          id: 'wdxp-pane-recaps',
          role: 'tabpanel',
          'aria-labelledby': 'wdxp-tab-recaps',
          className: 'wdxp-pane',
          hidden: tab !== 'recaps',
        }, tab === 'recaps' ? h(RecapHistorySection, {
          key: 'recaps-body',
          sessionId: sessionId,
          t: t,
          initialFilter: recapFilter,
          initialFilterRevision: recapFilterRevision,
          initialOrder: recapOrder,
          running: sessionRunning,
          summaryEnabled: summaryEnabled,
          progressEnabled: progressEnabled,
          pendingTurns: pendingTurns,
          currentTurn: currentTurn,
          onFilterChange: setRecapFilter,
          onOrderChange: setRecapOrder,
        }) : null),
        h('div', {
          key: 'btw',
          id: 'wdxp-pane-btw',
          role: 'tabpanel',
          'aria-labelledby': 'wdxp-tab-btw',
          className: 'wdxp-pane',
          hidden: tab !== 'btw',
        }, tab === 'btw' ? h(BtwSection, { key: 'btw-body', sessionId: sessionId, t: t, modelDirectories: modelDirectories }) : null),
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
        { field: 'recapProgress', format: booleanText, parse: parseBoolean },
        numberField('recapStallSeconds', 600, 60, 3600, 60),
        numberField('pendingTurns', 3, 1, 20, 1),
        { field: 'recapActivity', format: booleanText, parse: parseBoolean },
        textField('recapModelChain'),
        choiceField('defaultTab', DEFAULT_TAB_VALUES, 'recaps'),
        choiceField('verbosity', VERBOSITY_OPTIONS, 'low'),
        { field: 'actionable', format: booleanText, parse: parseBoolean },
        { field: 'eli5', format: booleanText, parse: parseBoolean },
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
        { field: 'toolRepair', format: booleanText, parse: parseBoolean },
        choiceField('toolRepairLang', TOOLREPAIR_LANGS, 'zh'),
        numberField('toolRepairMaxCorrections', 2, 0, 10, 1),
        { field: 'toolRepairDebugLog', format: booleanText, parse: parseBoolean },
      ])

      var store = model.bind(function () {
        return {
          ...model.shell(),
          enabled: model.field('enabled'),
          recap: model.field('recap'),
          recapProgress: model.field('recapProgress'),
          recapStallSeconds: model.field('recapStallSeconds'),
          pendingTurns: model.field('pendingTurns'),
          recapActivity: model.field('recapActivity'),
          recapModelChain: model.field('recapModelChain'),
          defaultTab: model.field('defaultTab'),
          verbosity: model.field('verbosity'),
          actionable: model.field('actionable'),
          eli5: model.field('eli5'),
          style: model.field('style'),
          customInstructions: model.field('customInstructions'),
          toolRepair: model.field('toolRepair'),
          toolRepairLang: model.field('toolRepairLang'),
          toolRepairMaxCorrections: model.field('toolRepairMaxCorrections'),
          toolRepairDebugLog: model.field('toolRepairDebugLog'),
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
      if (props.view === 'summary') return tr(t, 'settings.summary', '预测下一句，输入框上给一行进度；右侧面板按轮次看摘要、进度和待跟进，并可旁问且不污染上下文。')

      var useSettings = props.useSettings
      var lineAdvancedState = useState(false)
      var toolAdvancedState = useState(false)
      var state = useSettings ? useSettings(function (s) { return s }) : undefined
      if (!state) return null

      var lineAdvanced = lineAdvancedState[0]
      var setLineAdvanced = lineAdvancedState[1]
      var toolAdvanced = toolAdvancedState[0]
      var setToolAdvanced = toolAdvancedState[1]
      var disabled = state.writable === false || state.saving === true
      var emptyField = { text: '', overridden: false, invalid: false }
      var enabled = state.enabled || emptyField
      var recap = state.recap || emptyField
      var recapProgress = state.recapProgress || emptyField
      var recapStallSeconds = state.recapStallSeconds || emptyField
      var pendingTurns = state.pendingTurns || emptyField
      var recapActivity = state.recapActivity || emptyField
      var recapModelChain = state.recapModelChain || emptyField
      var defaultTab = state.defaultTab || emptyField
      var verbosity = state.verbosity || emptyField
      var actionable = state.actionable || emptyField
      var eli5 = state.eli5 || emptyField
      var style = state.style || emptyField
      var customInstructions = state.customInstructions || emptyField
      var toolRepair = state.toolRepair || emptyField
      var toolRepairLang = state.toolRepairLang || emptyField
      var toolRepairMaxCorrections = state.toolRepairMaxCorrections || emptyField
      var toolRepairDebugLog = state.toolRepairDebugLog || emptyField

      function edit(name, value) {
        if (typeof props.edit === 'function') props.edit(name, value)
      }

      function reset(name) {
        if (typeof props.resetField === 'function') props.resetField(name)
      }

      var verbosityOptions = VERBOSITY_OPTIONS.map(function (id) {
        return { id: id, label: tr(t, 'reply.verbosity.' + id, id) }
      })
      var toolRepairLangOptions = TOOLREPAIR_LANGS.map(function (id) {
        return { id: id, label: tr(t, 'settings.toolRepairLang.' + id, id === 'en' ? 'English' : '中文') }
      })
      var defaultTabOptions = DEFAULT_TAB_VALUES.map(function (id) {
        return { id: id, label: tr(t, 'settings.defaultTab.' + id, id) }
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
        h('div', { key: 'intro', className: 'wdxs-intro' }, tr(t, 'settings.intro', '上半部分是各功能开关，下半部分是回复偏好；回复偏好只打进 system prompt，不改变工具权限。')),
        h(Form, {
          key: 'form',
          labels: formLabels,
          state: state,
          onSave: function () { if (typeof props.save === 'function') props.save() },
          onDiscard: function () { if (typeof props.discard === 'function') props.discard() },
        }, [
          h('div', { key: 'features', className: 'wdxs-group' }, [
            h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'settings.group.features', '功能')),
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
            h(SelectField, {
              key: 'defaultTab',
              t: t,
              title: tr(t, 'settings.defaultTab.title', '默认 Tab'),
              description: tr(t, 'settings.defaultTab.description', '打开右侧 WDX Relief 面板时先显示哪个 Tab；默认「会话回顾」'),
              options: defaultTabOptions,
              value: defaultTab.text || 'recaps',
              overridden: defaultTab.overridden === true,
              disabled: disabled,
              onChange: function (next) { edit('defaultTab', next) },
              onReset: function () { reset('defaultTab') },
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
              key: 'recapProgress',
              t: t,
              title: tr(t, 'settings.recapProgress.title', '实时进度'),
              description: tr(t, 'settings.recapProgress.description', ''),
              field: recapProgress,
              disabled: disabled,
              onChange: function (next) { edit('recapProgress', String(next)) },
              onReset: function () { reset('recapProgress') },
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
            h('button', {
              key: 'advanced',
              type: 'button',
              className: 'wdxs-advanced',
              'aria-expanded': lineAdvanced,
              onClick: function () { setLineAdvanced(function (value) { return !value }) },
            }, lineAdvanced ? tr(t, 'settings.advancedHide', '收起高级设置') : tr(t, 'settings.advanced', '高级（一般不用改）')),
            lineAdvanced
              ? h('div', { key: 'advancedFields' }, [
                  h(NumberField, {
                    key: 'stallSeconds',
                    t: t,
                    title: tr(t, 'settings.recapStallSeconds.title', '进度记录间隔（秒）'),
                    description: tr(t, 'settings.recapStallSeconds.description', ''),
                    field: recapStallSeconds,
                    min: 60,
                    max: 3600,
                    step: 60,
                    disabled: disabled || recapProgress.text === 'false',
                    onChange: function (next) { edit('recapStallSeconds', next) },
                    onReset: function () { reset('recapStallSeconds') },
                  }),
                  h(NumberField, {
                    key: 'pendingTurns',
                    t: t,
                    title: tr(t, 'settings.pendingTurns.title', '待跟进窗口（最近 N 轮）'),
                    description: tr(t, 'settings.pendingTurns.description', '在「会话回顾」里把最近这么多轮的问题/下一步标成待跟进；默认 3'),
                    field: pendingTurns,
                    min: 1,
                    max: 20,
                    step: 1,
                    disabled: disabled,
                    onChange: function (next) { edit('pendingTurns', next) },
                    onReset: function () { reset('pendingTurns') },
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
          h('div', { key: 'toolRepair', className: 'wdxs-group' }, [
            h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'reply.group.toolRepair', '工具调用守卫')),
            h(ToggleField, {
              key: 'toolRepair',
              t: t,
              title: tr(t, 'settings.toolRepair.title', '工具调用泄漏守卫'),
              description: tr(t, 'settings.toolRepair.description', ''),
              field: toolRepair,
              disabled: disabled,
              onChange: function (next) { edit('toolRepair', String(next)) },
              onReset: function () { reset('toolRepair') },
            }),
            h('button', {
              key: 'advanced',
              type: 'button',
              className: 'wdxs-advanced',
              'aria-expanded': toolAdvanced,
              onClick: function () { setToolAdvanced(function (value) { return !value }) },
            }, toolAdvanced ? tr(t, 'settings.advancedHide', '收起高级设置') : tr(t, 'settings.advanced', '高级（一般不用改）')),
            toolAdvanced
              ? h('div', { key: 'advancedFields' }, [
                  h(SelectField, {
                    key: 'toolRepairLang',
                    t: t,
                    title: tr(t, 'settings.toolRepairLang.title', '修复提示语言'),
                    description: tr(t, 'settings.toolRepairLang.description', ''),
                    options: toolRepairLangOptions,
                    value: toolRepairLang.text || 'zh',
                    overridden: toolRepairLang.overridden === true,
                    disabled: disabled || toolRepair.text === 'false',
                    onChange: function (next) { edit('toolRepairLang', next) },
                    onReset: function () { reset('toolRepairLang') },
                  }),
                  h(NumberField, {
                    key: 'toolRepairMaxCorrections',
                    t: t,
                    title: tr(t, 'settings.toolRepairMaxCorrections.title', '每轮最多纠正次数'),
                    description: tr(t, 'settings.toolRepairMaxCorrections.description', ''),
                    field: toolRepairMaxCorrections,
                    min: 0,
                    max: 10,
                    step: 1,
                    disabled: disabled || toolRepair.text === 'false',
                    onChange: function (next) { edit('toolRepairMaxCorrections', next) },
                    onReset: function () { reset('toolRepairMaxCorrections') },
                  }),
                  h(ToggleField, {
                    key: 'toolRepairDebugLog',
                    t: t,
                    title: tr(t, 'settings.toolRepairDebugLog.title', '诊断日志'),
                    description: tr(t, 'settings.toolRepairDebugLog.description', ''),
                    field: toolRepairDebugLog,
                    disabled: disabled || toolRepair.text === 'false',
                    onChange: function (next) { edit('toolRepairDebugLog', String(next)) },
                    onReset: function () { reset('toolRepairDebugLog') },
                  }),
                ])
              : null,
          ]),
          h('div', { key: 'reply', className: 'wdxs-group' }, [
            h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'reply.group.reply', '回复方式')),
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
            h(ToggleField, {
              key: 'eli5',
              t: t,
              title: tr(t, 'reply.eli5.title', 'ELI5 模式'),
              description: tr(t, 'reply.eli5.description', ''),
              field: eli5,
              disabled: disabled,
              onChange: function (next) { edit('eli5', String(next)) },
              onReset: function () { reset('eli5') },
            }),
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

      /** 打开右侧 WDX Relief 面板；params 可选，用来落到指定筛选。 */
      function openReliefTab(params) {
        try {
          var sidebar = ctx.sidebarRight || (typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined)
          if (sidebar && typeof sidebar.openTab === 'function') {
            sidebar.openTab(RELIEF_TAB, params ? { params: params } : undefined)
          }
        } catch (error) {
          console.warn('[wdx-relief] open panel failed', error)
        }
      }

      /** 从输入框上方那一行跳到「会话回顾」并筛选出进度记录。 */
      function openProgressTab() {
        openReliefTab({ wdxReliefTab: 'recaps', wdxRecapFilter: 'progress' })
      }

      /** 顶栏入口：和 wdx-git 的按钮并排，点一下打开右侧面板。 */
      function HeaderReliefButton() {
        var label = boundT('panel.open')
        return h(React.Fragment, null,
          h('style', { key: 'wdx-relief-header-css', 'data-plugin-css': NS + ':header' }, HEADER_CSS),
          h('button', {
            type: 'button',
            className: 'wdxr-headerBtn',
            title: label,
            'aria-label': label,
            onClick: function () { openReliefTab() },
          }, h(ReliefIcon, { size: 16 })))
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

      // 顶栏按钮：order 12 紧跟在 wdx-git 的 11 后面。
      ctx.slots.inject('conversation.session.header.utilities', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'wdx-relief',
          order: 12,
          label: function () { return boundT('panel.open') },
        }, HeaderReliefButton)
      })

      ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: RELIEF_TAB,
          locale: NS,
          inject: function (sessionId) {
            var value = {}
            try {
              var snapshot = formSource.getSnapshot()
              if (snapshot && snapshot.value && typeof snapshot.value === 'object') value = snapshot.value
            } catch (error) {
              // 配置未就绪时按默认 Tab 处理。
            }
            var defaultTab = value.defaultTab === 'btw' ? 'btw' : 'recaps'
            var runningSource = null
            try {
              var binding = ctx.sessions && typeof ctx.sessions.binding === 'function' ? ctx.sessions.binding(sessionId) : null
              runningSource = binding && binding.session ? binding.session : null
            } catch (error) {
              runningSource = null
            }
            var hooks = { settings: formSource }
            if (runningSource !== null) hooks.running = runningSource
            return { sessionId: sessionId, defaultTab: defaultTab, readFeed: readTurnFeed, hooks: hooks }
          },
        }, function ReliefTabBody(props) {
          var tabInfo = props && typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
          var navigation = tabInfo && tabInfo.tab && tabInfo.tab.navigation ? tabInfo.tab.navigation : null
          var params = navigation && navigation.params && typeof navigation.params === 'object' ? navigation.params : null
          var running = props && typeof props.useRunning === 'function'
            ? props.useRunning(function (snapshot) { return Boolean(snapshot && snapshot.running) })
            : false
          var settings = props && typeof props.useSettings === 'function'
            ? props.useSettings(function (snapshot) { return snapshot })
            : undefined
          var configuredTurns = settings && settings.value ? Number(settings.value.pendingTurns) : 3
          var pendingTurns = Number.isFinite(configuredTurns) ? Math.max(1, Math.min(20, Math.round(configuredTurns))) : 3
          var settingsValue = settings && settings.value ? settings.value : {}
          return h(ReliefPanel, {
            sessionId: props && props.sessionId,
            t: props && props.t,
            running: running,
            summaryEnabled: settingsValue.recap !== false,
            progressEnabled: settingsValue.recapProgress !== false,
            modelDirectories: ctx.modelDirectories,
            defaultTab: props && props.defaultTab,
            readFeed: props && props.readFeed,
            requestedTab: params ? params.wdxReliefTab : undefined,
            requestedFilter: params ? params.wdxRecapFilter : undefined,
            requestedRevision: navigation && typeof navigation.revision === 'number' ? navigation.revision : 0,
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

      // 一行固定放在输入框上方（input.dock）。
      function readTurnFeed(sessionId) {
        try {
          var binding = ctx.sessions && typeof ctx.sessions.binding === 'function' ? ctx.sessions.binding(sessionId) : undefined
          return binding && binding.eventSource
        } catch (error) {
          return undefined
        }
      }

      function registerTurnLine(slot, id) {
        ctx.slots.inject(slot, function () {
          return ctx.slots.register({
            name: slot,
            id: id,
            order: 30,
            locale: NS,
            inject: function (sessionId) {
              return {
                sessionId: sessionId,
                readFeed: readTurnFeed,
                openProgress: openProgressTab,
                hooks: { settings: formSource },
              }
            },
          }, TurnRecapDock)
        })
      }

      registerTurnLine('conversation.input.dock', 'wdx-turn-line-above')

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
    exports.formatDuration = formatDuration
    exports.lineSettings = lineSettings
    exports.groupRecapEntries = groupRecapEntries
    exports.progressEntryOf = progressEntryOf
    exports.progressWindowOf = progressWindowOf
    exports.progressDueOf = progressDueOf
    exports.collectProgressDigest = collectProgressDigest
    exports.progressIntervalText = progressIntervalText
    exports.turnStatusInfo = turnStatusInfo
    exports.buildTurnSegments = buildTurnSegments
    exports.activityText = activityText
    exports.describeToolCall = describeToolCall
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