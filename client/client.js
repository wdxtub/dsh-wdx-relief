/**
 * dsh-wdx-relief 网页客户端。
 *
 * 两块 UI：
 * 1. `conversation.input.overlay`：在输入框里显示「下一句消息」灰字预测，
 *    Tab 填入（Codex 式），点击也可以填入。
 * 2. `plugins.bundle.config`：侧边栏「插件」里 dsh-wdx-relief 的配置页（预测 + 回复风格）。
 *
 * 预测由 Host 侧 `/api/wdx-relief/predict` 生成；这里只负责节流触发、
 * 定位灰字、处理 Tab/Escape，以及开关的读写。
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
    var useLayoutEffect = React.useLayoutEffect
    var useRef = React.useRef

    var NS = 'wdx-relief'
    var RPC_PATH = '/api/wdx-relief/predict'
    var SWITCH = primitives && primitives.Switch
    var MENU = primitives && primitives.Menu
    var CHEVRON = primitives && primitives.IconChevronDownOutlineRegular

    // ------------------------------------------------------------------ CSS

    var CSS = [
      '.wdxr-row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:16px 0;display:flex}',
      '.wdxr-text{min-width:0}',
      '.wdxr-title{font-size:14px;line-height:20px}',
      '.wdxr-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}',
      '.wdxr-error{color:var(--dsw-alias-state-error-primary);margin-top:4px;font-size:12px;line-height:18px}',
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
      '.wdxs-select{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);height:36px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;align-items:center;gap:12px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;display:inline-flex}',
      '@media (hover:hover){.wdxs-select:hover{background:var(--dsw-alias-interactive-bg-hover)}}',
      '.wdxs-chevron{flex:none}',
      '.wdxs-custom{padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.wdxs-textarea{box-sizing:border-box;width:100%;min-height:104px;resize:vertical;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);outline:none;margin-top:10px;padding:10px 12px;font:inherit;font-size:13px;line-height:20px}',
      '.wdxs-textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary)}',
      '.wdxs-textarea::placeholder{color:var(--dsw-alias-label-caption)}',
      '.wdxs-status{color:var(--dsw-alias-state-success-primary);margin-top:6px;font-size:12px;line-height:18px}',
      '.wdxs-error{color:var(--dsw-alias-state-error-primary);margin-top:6px;font-size:12px;line-height:18px}',
    ].join('')

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-wdx-relief"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-wdx-relief'
      tag.dataset.pluginCss = 'dsh-wdx-relief'
      tag.textContent = CSS
      document.head.appendChild(tag)
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
      'reply.saved': '已保存',
      'reply.saveError': '保存失败，请重试',
      'settings.title': '显示预测消息',
      'settings.description': '根据对话预测你接下来要发送的消息',
      'settings.error': '保存失败，请重试',
      'hint.accept': '按 Tab 填入预测',
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
      'reply.saved': 'Saved',
      'reply.saveError': 'Could not save. Try again.',
      'settings.title': 'Show predicted messages',
      'settings.description': 'Predict what you might send next based on the conversation',
      'settings.error': 'Could not save. Try again.',
      'hint.accept': 'Press Tab to insert the prediction',
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

    // ------------------------------------------------------------- overlay

    /**
     * 输入框里的灰字预测。
     * 定位：读 composer 卡片的矩形和编辑器 padding，把灰字放在空输入的光标起始位置。
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
        setDismissed(suggestion)
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
              'aria-hidden': 'true',
              title: t ? t('hint.accept') : undefined,
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
                style: {
                  color: 'var(--dsw-alias-label-caption, #8b93a1)',
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
              h('span', {
                key: 'key',
                onPointerDown: function (event) {
                  if (event.button !== 0) return
                  event.preventDefault()
                  event.stopPropagation()
                  accept()
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
                  border: '0.5px solid var(--dsw-alias-border-l2, #3a3a3a)',
                  color: 'var(--dsw-alias-label-caption, #8b93a1)',
                  fontSize: '10px',
                  fontFamily: 'ui-monospace, Menlo, monospace',
                  opacity: 0.75,
                },
              }, 'Tab'),
            ])
          : null)
    }

    // ------------------------------------------------------ reply settings

    var STYLE_OPTIONS = ['default', 'professional', 'friendly', 'blunt', 'follow']

    function tr(t, key, fallback) {
      if (t) {
        var value = t(key)
        if (value !== key) return value
      }
      return fallback
    }

    function SelectRow(props) {
      var [open, setOpen] = useState(false)
      var options = props.options
      var selected = options.filter(function (option) { return option.id === props.value })[0] || options[0]
      var anchor = h('button', {
        type: 'button',
        className: 'wdxs-select',
        'aria-label': props.title || undefined,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        disabled: props.disabled === true,
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
            disabled: props.disabled === true,
            onChange: function (event) { props.onChange(event.target.value) },
          }, options.map(function (option) {
            return h('option', { key: option.id, value: option.id }, option.label)
          }))


      return h('div', { className: 'wdxs-row' }, [
        h('div', { key: 'text', className: 'wdxs-rowText' }, [
          h('div', { key: 'title', className: 'wdxs-title' }, props.title),
          props.description ? h('div', { key: 'desc', className: 'wdxs-desc' }, props.description) : null,
        ]),
        control,
      ])
    }

    function ToggleRow(props) {
      return h('div', { className: 'wdxs-row' }, [
        h('div', { key: 'text', className: 'wdxs-rowText' }, [
          h('div', { key: 'title', className: 'wdxs-title' }, props.title),
          props.description ? h('div', { key: 'desc', className: 'wdxs-desc' }, props.description) : null,
        ]),
        SWITCH
          ? h(SWITCH, {
              key: 'switch',
              checked: props.value === true,
              label: props.title,
              onChange: props.onChange,
            })
          : h('button', {
              key: 'fallback',
              type: 'button',
              'aria-pressed': props.value === true,
              onClick: function () { props.onChange(props.value !== true) },
              className: 'wdxs-select',
            }, props.value === true ? 'On' : 'Off'),
      ])
    }

    function CustomInstructionsRow(props) {
      var value = typeof props.value === 'string' ? props.value : ''
      var [draft, setDraft] = useState(value)
      var focused = useRef(false)
      var timer = useRef(null)

      useEffect(function () {
        if (!focused.current) setDraft(value)
      }, [value])

      useEffect(function () {
        return function () {
          if (timer.current !== null) clearTimeout(timer.current)
        }
      }, [])

      function commit(next) {
        if (next === value) return
        props.onChange(next)
      }

      function schedule(next) {
        var clipped = next.slice(0, 2000)
        setDraft(clipped)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(function () {
          timer.current = null
          commit(clipped)
        }, 700)
      }

      return h('div', { className: 'wdxs-custom' }, [
        h('div', { key: 'text', className: 'wdxs-rowText' }, [
          h('div', { key: 'title', className: 'wdxs-title' }, props.title),
          h('div', { key: 'desc', className: 'wdxs-desc' }, props.description),
        ]),
        h('textarea', {
          key: 'input',
          className: 'wdxs-textarea',
          value: draft,
          maxLength: 2000,
          placeholder: props.placeholder,
          spellCheck: false,
          onFocus: function () { focused.current = true },
          onChange: function (event) { schedule(event.target.value) },
          onBlur: function () {
            focused.current = false
            if (timer.current !== null) {
              clearTimeout(timer.current)
              timer.current = null
            }
            commit(draft)
          },
        }),
      ])
    }

    function BundleSettingsPage(props) {
      var useSettings = props.useSettings
      var setField = props.setField
      var t = props.t
      var settings = useSettings ? useSettings(function (s) { return s }) : undefined
      var value = settings && settings.value ? settings.value : {}
      var [error, setError] = useState('')
      var [saved, setSaved] = useState(false)
      var savedTimer = useRef(null)

      useEffect(function () {
        return function () {
          if (savedTimer.current !== null) clearTimeout(savedTimer.current)
        }
      }, [])

      function update(field, next) {
        setError('')
        Promise.resolve(setField(field, next)).then(function () {
          setSaved(true)
          if (savedTimer.current !== null) clearTimeout(savedTimer.current)
          savedTimer.current = setTimeout(function () { setSaved(false) }, 1800)
        }).catch(function () {
          setError(tr(t, 'reply.saveError', '保存失败，请重试'))
        })
      }

      var verbosityOptions = ['low', 'medium', 'high'].map(function (id) {
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

      // 旧配置只有 writingStyle/baseStyle，没有 style；这里按同样的优先级显示。
      var selectedStyle = value.style
      if (selectedStyle === undefined) {
        if (value.writingStyle === true) selectedStyle = 'follow'
        else if (value.baseStyle === 'professional' || value.baseStyle === 'friendly' || value.baseStyle === 'blunt') selectedStyle = value.baseStyle
        else selectedStyle = 'default'
      }

      return h('div', { className: 'wdxs-page' }, [
        h('div', { key: 'intro', className: 'wdxs-intro' }, tr(t, 'reply.intro', '')),

        h('div', { key: 'input', className: 'wdxs-group' }, [
          h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'reply.group.input', '输入')),
          h(ToggleRow, {
            key: 'prediction',
            title: tr(t, 'settings.title', '显示预测消息'),
            description: tr(t, 'settings.description', '根据对话预测你接下来要发送的消息'),
            value: value.enabled !== false,
            onChange: function (next) { update('enabled', next) },
          }),
        ]),

        h('div', { key: 'length', className: 'wdxs-group' }, [
          h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'reply.group.length', '回复长度')),
          h(SelectRow, {
            key: 'verbosity',
            title: tr(t, 'reply.verbosity.title', '输出详细程度'),
            description: tr(t, 'reply.verbosity.description', ''),
            options: verbosityOptions,
            value: value.verbosity || 'low',
            onChange: function (next) { update('verbosity', next) },
          }),
        ]),

        h('div', { key: 'writing', className: 'wdxs-group' }, [
          h('div', { key: 'head', className: 'wdxs-groupHead' }, tr(t, 'reply.group.writing', '写作')),
          h(ToggleRow, {
            key: 'actionable',
            title: tr(t, 'reply.actionable.title', '便于行动'),
            description: tr(t, 'reply.actionable.description', ''),
            value: value.actionable !== false,
            onChange: function (next) { update('actionable', next) },
          }),
          h(SelectRow, {
            key: 'style',
            title: tr(t, 'reply.style.title', '回复风格'),
            description: tr(t, 'reply.style.description', ''),
            options: styleOptions,
            value: selectedStyle,
            onChange: function (next) { update('style', next) },
          }),
        ]),

        h(CustomInstructionsRow, {
          key: 'custom',
          title: tr(t, 'reply.custom.title', '自定义指令'),
          description: tr(t, 'reply.custom.description', ''),
          placeholder: tr(t, 'reply.custom.placeholder', ''),
          value: typeof value.customInstructions === 'string' ? value.customInstructions : '',
          onChange: function (next) { update('customInstructions', next) },
        }),

        error ? h('div', { key: 'error', className: 'wdxs-error', role: 'alert' }, error) : null,
        saved && !error ? h('div', { key: 'saved', className: 'wdxs-status', role: 'status' }, tr(t, 'reply.saved', '已保存')) : null,
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
      var formSource = {
        getSnapshot: function () { return form.getSnapshot() },
        subscribe: function (listener) { return form.subscribe(listener) },
      }
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

      var configInjected = function () {
        return {
          hooks: { settings: formSource },
          setField: function (field, next) {
            return form.set(field, next).then(function (accepted) {
              if (accepted !== true) throw new Error('settings write refused')
              return accepted
            })
          },
        }
      }

      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-wdx-relief',
          locale: NS,
          inject: configInjected,
        }, BundleSettingsPage)
      })

    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.PredictionOverlay = PredictionOverlay
    exports.BundleSettingsPage = BundleSettingsPage
    return module.exports
  },
})