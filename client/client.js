/**
 * dsh-wdx-relief 网页客户端。
 *
 * 两块 UI：
 * 1. `conversation.composer.dock`：在输入框下方显示「下一句消息」建议，
 *    Tab 填入（Codex 式），点击也可以填入。
 * 2. `plugins.bundle.config`：侧边栏「插件」里 dsh-wdx-relief 的配置页（预测 + 回复风格）。
 *
 * 预测由 Host 侧 `/api/wdx-relief/predict` 生成；这里只负责节流触发、
 * 渲染建议、处理 Tab/Escape，以及开关的读写。
 *
 * 官方约束：
 * - 工厂函数不产生模块级副作用；样式随组件挂载，卸载时由 React 移除。
 * - 只使用 slot 已经分配的空间，不读取宿主或其他插件的 DOM 来估算位置。
 * - 配置页使用官方 SettingsFormModel / SettingsForm 的暂存-保存模型。
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

    var NS = 'wdx-relief'
    var RPC_PATH = '/api/wdx-relief/predict'
    var MAX_CUSTOM_CHARS = 2000
    var SWITCH = primitives && primitives.Switch
    var MENU = primitives && primitives.Menu
    var CHEVRON = primitives && primitives.IconChevronDownOutlineRegular
    var SETTINGS_FORM = primitives && primitives.SettingsForm
    var SETTINGS_FORM_MODEL = primitives && primitives.SettingsFormModel

    var VERBOSITY_OPTIONS = ['low', 'medium', 'high']
    var STYLE_OPTIONS = ['default', 'professional', 'friendly', 'blunt', 'follow']

    // ------------------------------------------------------------------ CSS

    var CSS = [
      '.wdxp-dock{width:100%;display:flex;justify-content:center;padding-top:4px}',
      '.wdxp-suggestion{max-width:100%;min-width:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;display:inline-flex;align-items:center;gap:8px;padding:4px 8px;border-radius:var(--dsw-radius-md);cursor:pointer;text-align:left}',
      '@media (hover:hover){.wdxp-suggestion:hover{background:var(--dsw-alias-interactive-bg-hover)}}',
      '.wdxp-label{color:var(--dsw-alias-label-caption);flex:none}',
      '.wdxp-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wdxp-key{flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-caption);font-size:10px;line-height:16px;padding:0 4px;font-family:ui-monospace,Menlo,monospace}',
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
      '.wdxs-fallback{border:0;padding:0;margin:0}',
    ].join('')

    function PluginStyles() {
      return h('style', { 'data-plugin-css': NS }, CSS)
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
      'settings.summary': '预测下一句，并设置回复长度、风格和便于行动。',
      'prediction.label': '下一句',
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
      'settings.summary': 'Predict the next message, and set reply length, style, and actionable replies.',
      'prediction.label': 'Next',
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

    // ---------------------------------------------------------- prediction

    /**
     * 输入框下方的「下一句」建议。
     * 它注册在官方 `conversation.composer.dock` 里，使用该 slot 分配的空间；
     * 不查询 composer 的 DOM、不隐藏 placeholder，也不做像素定位。
     */
    function PredictionSuggestion(props) {
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

      var requestSeq = useRef(0)
      var [prediction, setPrediction] = useState(null)
      var [dismissed, setDismissed] = useState('')

      var idle = enabled && !running && phase === 'plain' && draft.trim() === '' && attachments === 0
      var suggestion = idle && prediction !== null && prediction.text !== dismissed ? prediction.text : ''

      // 切会话时清掉上一条会话的预测。
      useEffect(function () {
        setPrediction(null)
        setDismissed('')
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

      function accept() {
        if (suggestion === '') return
        try {
          if (inputActions && typeof inputActions.setDraft === 'function') {
            inputActions.setDraft(suggestion)
            if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
          }
        } catch (error) {
          // 编辑器锁定时 setDraft 会失败；保持建议可见即可。
        }
        setDismissed(suggestion)
        setPrediction(null)
      }

      // Tab 填入、Escape 暂时忽略。只在编辑区持有焦点时拦截，避免抢别的快捷键。
      useEffect(function () {
        if (suggestion === '') return undefined
        var onKeyDown = function (event) {
          if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
          var target = event.target
          var editing = target !== null && typeof target === 'object' && target.isContentEditable === true
          if (!editing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setDismissed(suggestion)
            return
          }
          if (event.key !== 'Tab' || event.shiftKey) return
          event.preventDefault()
          event.stopPropagation()
          accept()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return function () {
          window.removeEventListener('keydown', onKeyDown, true)
        }
      }, [suggestion])

      if (suggestion === '') return null

      return h('div', { className: 'wdxp-dock' }, [
        h(PluginStyles, { key: 'style' }),
        h('button', {
          key: 'suggestion',
          type: 'button',
          className: 'wdxp-suggestion',
          title: t ? t('prediction.accept') : undefined,
          'aria-label': (t ? t('prediction.accept') : 'Press Tab to insert the prediction') + ': ' + suggestion,
          // 指针按下时阻止按钮抢走编辑器的焦点；键盘/辅助技术产生的 click 仍可填入。
          onPointerDown: function (event) {
            if (event.button !== 0) return
            event.preventDefault()
            accept()
          },
          onClick: function (event) {
            if (event.detail === 0) accept()
          },
        }, [
          h('span', { key: 'label', className: 'wdxp-label' }, tr(t, 'prediction.label', '下一句')),
          h('span', { key: 'text', className: 'wdxp-text' }, suggestion),
          h('kbd', { key: 'key', className: 'wdxp-key' }, 'Tab'),
        ]),
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

    function createSettingsModel(scope) {
      var model = new SETTINGS_FORM_MODEL(scope, [
        { field: 'enabled', format: booleanText, parse: parseBoolean },
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
      if (props.view === 'summary') return tr(t, 'settings.summary', '预测下一句，并设置回复长度、风格和便于行动。')

      var useSettings = props.useSettings
      var state = useSettings ? useSettings(function (s) { return s }) : undefined
      if (!state) return null

      var disabled = state.writable === false || state.saving === true
      var emptyField = { text: '', overridden: false, invalid: false }
      var enabled = state.enabled || emptyField
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
        h(PluginStyles, { key: 'style' }),
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
    var inject = ['slots', 'configForms', 'locale']

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

      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'wdx-prediction',
          order: 50,
          locale: NS,
          inject: function (sessionId) {
            return { sessionId: sessionId, hooks: { settings: formSource } }
          },
        }, PredictionSuggestion)
      })

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
    exports.PredictionSuggestion = PredictionSuggestion
    exports.PredictionOverlay = PredictionSuggestion
    exports.BundleSettingsPage = BundleSettingsPage
    return module.exports
  },
})