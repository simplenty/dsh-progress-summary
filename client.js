/**
 * Browser half of dsh-progress-summary: one quiet line above the composer.
 *
 * The value arrives through the `progressSummary` session projection, which the
 * host publishes from an ignorable plugin record — no client-side folding and
 * no extra polling. The component is plain `React.createElement` on purpose:
 * no JSX build step, no CSS module, and nothing but `react` resolved through
 * the client module loader.
 * @module dsh-progress-summary/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-progress-summary',
  factory: (require) => {
    const React = require('react')

    /** Projection key registered by the host half. */
    const KEY = 'progressSummary'

    const rowStyle = {
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      // Align with the chat text column, not the wider composer card: the dock
      // row is centered on the same axis as the transcript.
      maxWidth: 'var(--dsh-chat-content-width, 748px)',
      margin: '0 auto',
      minWidth: 0,
      padding: '2px 0 4px',
      color: 'var(--dsw-alias-label-secondary, #666)',
      fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      lineHeight: '18px',
    }

    const dotStyle = {
      flex: '0 0 auto',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: 'currentColor',
      opacity: 0.55,
    }

    const textStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      // Up to two lines: a 128-character line is too long for one row, but
      // ellipsizing it on line one would defeat the point of the larger cap.
      display: '-webkit-box',
      WebkitBoxOrient: 'vertical',
      WebkitLineClamp: 2,
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
    }

    /**
     * The dock entry: the host-composed progress line, or nothing at all while
     * the turn is idle or no summary has arrived yet.
     * @param props - dock slot props (the session standard kit).
     * @returns the rendered row or null.
     */
    function ProgressRow(props) {
      const value = props.useProjection(KEY)
      if (value === undefined || value.state !== 'running' || value.line === '') return null
      return React.createElement(
        'div',
        { 'data-progress-summary': '', style: rowStyle, title: value.line },
        React.createElement('span', { 'aria-hidden': 'true', style: dotStyle }),
        React.createElement('span', { style: textStyle }, value.line),
      )
    }

    const inject = ['slots']

    /** Settings namespace the host serves for this row's Config. */
    const CONFIG_NS = 'progress-summary'

    /** Slot key the Plugins page uses for one row: `<package>#<row id>`. */
    const ROW_CONFIG_KEY = 'dsh-progress-summary#progress-summary'

    /** Bundle-page config key: the package name itself. */
    const BUNDLE_CONFIG_KEY = 'dsh-progress-summary'

    const LABELS = {
      zh: {
        summary: '用低成本模型把实时思考压成一行进度摘要。',
        title: '摘要模型',
        model: '模型',
        provider: '供应商',
        effort: '思考强度',
        lang: '语言',
        interval: '最短间隔（秒）',
        tokens: '触发所需 token',
        perTurn: '每轮上限',
        autoHint: '填 auto 表示跟随当前会话的模型；填具体型号可固定成更便宜的模型。',
        policyHint: '只在工具调用前触发：思考量达到 token 阈值、且距上次超过最短间隔时才播报。',
        toggleTitle: '显示进度摘要',
        toggleHint: '在输入框上方用一行文字说明当前在做什么；关闭后不产生任何额外模型调用。',
        save: '保存',
        saving: '保存中…',
        failed: '保存失败，已恢复为保存前的值。',
        readOnly: '本部署的设置为只读。',
        loading: '正在读取配置…',
        unavailable: '当前插件未加载，暂时无法配置。',
        changed: '有未保存的修改',
      },
      en: {
        summary: 'Turns live reasoning into one progress line with a cheap model.',
        title: 'Summary model',
        model: 'Model',
        provider: 'Provider',
        effort: 'Reasoning effort',
        lang: 'Language',
        interval: 'Minimum interval (s)',
        tokens: 'Tokens per summary',
        perTurn: 'Calls per turn',
        autoHint: 'Use auto to follow the session model, or pin a cheaper model id.',
        policyHint: 'Fires only before a tool call, when enough new reasoning accumulated and the interval elapsed.',
        toggleTitle: 'Show progress summary',
        toggleHint: 'One line above the composer describing what the agent is doing. Off means no extra model calls.',
        save: 'Save',
        saving: 'Saving…',
        failed: 'Save failed; the previous values were kept.',
        readOnly: 'This deployment stores settings read-only.',
        loading: 'Reading configuration…',
        unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        changed: 'Unsaved changes',
      },
    }

    /** @returns {object} the dictionary for the browser language. */
    function labels() {
      const lang = String(globalThis.navigator?.language ?? 'zh').toLowerCase()
      return lang.startsWith('zh') ? LABELS.zh : LABELS.en
    }

    const panelStyle = { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '520px' }
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' }
    const labelStyle = { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #666)' }
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      fontSize: '13px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-specific-input-major, transparent)',
      border: '0.5px solid var(--dsw-alias-border-l2, #0000001f)',
      borderRadius: '6px',
    }
    const hintStyle = { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' }
    const errorStyle = { ...hintStyle, color: 'var(--dsw-alias-state-error-primary, #c33)' }

    const FIELDS = ['model', 'provider', 'effort']
    const EFFORTS = ['off', 'low', 'high', 'max']

    /**
     * The Settings → General row: one switch over the live `enabled` field.
     * @param props - the row's settings form.
     * @returns the labelled switch row.
     */
    function SummaryToggle(props) {
      const t = labels()
      const form = props.form
      const subscribe = React.useCallback(callback => form.subscribe(callback), [form])
      const snapshot = React.useSyncExternalStore(subscribe, () => form.getSnapshot())
      const enabled = snapshot.value?.enabled !== false
      const toggle = () => {
        if (snapshot.writable === false) return
        void form.set('enabled', !enabled)
      }
      return React.createElement(
        'div',
        { style: switchRowStyle },
        React.createElement(
          'div',
          { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' } },
          React.createElement('span', { style: { fontSize: '14px', lineHeight: '22px' } }, t.toggleTitle),
          React.createElement('span', { style: hintStyle }, t.toggleHint),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': t.toggleTitle,
            disabled: snapshot.writable === false,
            onClick: toggle,
            style: {
              flex: '0 0 auto',
              width: '36px',
              height: '20px',
              padding: 0,
              borderRadius: '10px',
              border: 'none',
              cursor: snapshot.writable === false ? 'default' : 'pointer',
              background: enabled
                ? 'var(--dsw-alias-state-business-primary, #4b6fff)'
                : 'var(--dsw-alias-interactive-bg-hover, #e5e5e5)',
              position: 'relative',
              transition: 'background .15s ease',
              opacity: snapshot.writable === false ? 0.5 : 1,
            },
          },
          React.createElement('span', {
            'aria-hidden': 'true',
            style: {
              position: 'absolute',
              top: '2px',
              left: enabled ? '18px' : '2px',
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              background: '#fff',
              transition: 'left .15s ease',
            },
          }),
        ),
      )
    }

    const switchRowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '16px 0',
      borderBottom: '0.5px solid var(--dsw-alias-border-l1, #00000014)',
    }

    /**
     * The row's configuration page: model, provider, and effort over the
     * `progress-summary` settings namespace the host serves.
     * @param props - the Plugins page view and the row's settings form.
     * @returns the one-liner, or the editable panel.
     */
    function SummaryConfig(props) {
      const t = labels()
      const form = props.form
      const subscribe = React.useCallback(callback => form.subscribe(callback), [form])
      const snapshot = React.useSyncExternalStore(subscribe, () => form.getSnapshot())
      const [draft, setDraft] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)

      if (props.view === 'summary') return t.summary
      if (snapshot.status === 'loading') return React.createElement('p', { style: hintStyle }, t.loading)
      if (snapshot.status === 'unavailable') return React.createElement('p', { style: hintStyle }, t.unavailable)
      if (snapshot.writable === false) return React.createElement('p', { style: hintStyle }, t.readOnly)

      const value = snapshot.value ?? {}
      const current = draft ?? {
        model: value.model ?? 'auto',
        provider: value.provider ?? 'auto',
        effort: value.effort ?? 'off',
        lang: value.lang ?? 'auto',
        minIntervalSec: Math.round((value.minIntervalMs ?? 30000) / 1000),
        minTokens: value.minTokens ?? 600,
        maxPerTurn: value.maxPerTurn ?? 40,
      }
      const dirty = FIELDS.some(field => String(current[field]) !== String(value[field] ?? current[field]))

      // Draft key → settings field and wire value.
      const OPS = {
        model: { path: 'model', value: draftValue => String(draftValue) },
        provider: { path: 'provider', value: draftValue => String(draftValue) },
        effort: { path: 'effort', value: draftValue => String(draftValue) },
        lang: { path: 'lang', value: draftValue => String(draftValue) },
        minIntervalSec: { path: 'minIntervalMs', value: draftValue => Math.max(0, Math.round(Number(draftValue) * 1000)) },
        minTokens: { path: 'minTokens', value: draftValue => Math.max(0, Math.round(Number(draftValue))) },
        maxPerTurn: { path: 'maxPerTurn', value: draftValue => Math.max(0, Math.round(Number(draftValue))) },
      }
      const dirtyFields = Object.keys(OPS).filter(field => {
        const baseline = field === 'minIntervalSec'
          ? Math.round((value.minIntervalMs ?? 30000) / 1000)
          : (value[OPS[field].path] ?? current[field])
        return String(current[field]) !== String(baseline)
      })

      const save = async () => {
        if (busy || dirtyFields.length === 0) return
        setBusy(true)
        setFailed(false)
        const ops = dirtyFields.map(field => ({
          op: 'set',
          path: [OPS[field].path],
          value: OPS[field].value(current[field]),
        }))
        let accepted = false
        try {
          accepted = await form.mutate(ops, snapshot.revision)
        } catch {
          accepted = false
        }
        setBusy(false)
        if (accepted) setDraft(undefined)
        else setFailed(true)
      }

      const text = (field, label) => React.createElement(
        'label',
        { style: fieldStyle, key: field },
        React.createElement('span', { style: labelStyle }, label),
        React.createElement('input', {
          style: inputStyle,
          value: current[field],
          placeholder: 'auto',
          spellCheck: false,
          onChange: event => setDraft({ ...current, [field]: event.target.value }),
        }),
      )

      const number = (field, label, hint) => React.createElement(
        'label',
        { style: fieldStyle, key: field },
        React.createElement('span', { style: labelStyle }, label),
        React.createElement('input', {
          style: inputStyle,
          type: 'number',
          min: 0,
          value: current[field],
          onChange: event => setDraft({ ...current, [field]: event.target.value }),
        }),
        hint === undefined ? null : React.createElement('span', { style: hintStyle }, hint),
      )

      const select = (field, label, options) => React.createElement(
        'label',
        { style: fieldStyle, key: field },
        React.createElement('span', { style: labelStyle }, label),
        React.createElement(
          'select',
          {
            style: inputStyle,
            value: current[field],
            onChange: event => setDraft({ ...current, [field]: event.target.value }),
          },
          options.map(option => React.createElement('option', { key: option, value: option }, option)),
        ),
      )

      return React.createElement(
        'div',
        { style: panelStyle },
        React.createElement('p', { style: { ...hintStyle, fontSize: '13px' } }, t.autoHint),
        text('model', t.model),
        text('provider', t.provider),
        select('effort', t.effort, EFFORTS),
        select('lang', t.lang, ['auto', 'zh', 'en']),
        React.createElement('p', { style: hintStyle }, t.policyHint),
        number('minIntervalSec', t.interval),
        number('minTokens', t.tokens),
        number('maxPerTurn', t.perTurn),
        failed ? React.createElement('p', { style: errorStyle }, t.failed) : null,
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy || dirtyFields.length === 0,
              onClick: save,
              style: {
                padding: '5px 14px',
                fontSize: '13px',
                borderRadius: '6px',
                border: '0.5px solid var(--dsw-alias-border-l2, #0000001f)',
                background: 'var(--dsw-alias-interactive-bg-hover, #f2f2f2)',
                color: 'var(--dsw-alias-label-primary, inherit)',
                cursor: busy || dirtyFields.length === 0 ? 'default' : 'pointer',
                opacity: busy || dirtyFields.length === 0 ? 0.55 : 1,
              },
            },
            busy ? t.saving : t.save,
          ),
          dirtyFields.length > 0 && !busy ? React.createElement('span', { style: hintStyle }, t.changed) : null,
        ),
      )
    }

    /**
     * Register the composer row and the row's configuration page.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      // Observable probe for headless verification: the attribute existing on
      // <html> means this client half applied, not merely loaded.
      try {
        globalThis.document?.documentElement?.setAttribute('data-dsh-progress-summary', 'on')
      } catch {
        // A non-DOM host is not an error.
      }
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'progress-summary',
            order: 16,
            registrant: 'dsh-progress-summary',
          },
          ProgressRow,
        ),
      )

      // The settings form needs `configForms`, which the Settings client plugin
      // provides. Keep it optional so a deployment without that plugin still
      // gets the composer row.
      ctx.inject(['configForms'], configCtx => {
        const form = configCtx.configForms.get(CONFIG_NS)
        const page = props => React.createElement(SummaryConfig, { form, view: props.view })
        // Two seats, same form: the bundle page (always one click away) and the
        // row page (the Plugins page's own Configure control).
        configCtx.slots.inject('plugins.bundle.config', () =>
          configCtx.slots.register(
            { name: 'plugins.bundle.config', key: BUNDLE_CONFIG_KEY },
            page,
          ),
        )
        configCtx.slots.inject('plugins.row.config', () =>
          configCtx.slots.register(
            { name: 'plugins.row.config', key: ROW_CONFIG_KEY },
            page,
          ),
        )
        configCtx.slots.inject('settings.general.item', () =>
          configCtx.slots.register(
            { name: 'settings.general.item', id: 'progress-summary', order: 60 },
            () => React.createElement(SummaryToggle, { form }),
          ),
        )
      })
    }

    const module = { exports: {} }
    module.exports.name = 'progress-summary'
    module.exports.inject = inject
    module.exports.apply = apply
    module.exports.ProgressRow = ProgressRow
    module.exports.SummaryConfig = SummaryConfig
    module.exports.SummaryToggle = SummaryToggle
    return module.exports
  },
})
