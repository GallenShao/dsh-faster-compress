// Browser factory body. `locales` is supplied by the build wrapper.
const { createElement: h } = require('react')
const { SettingsForm, SettingsValueField, SettingsFormModel, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
const NS = 'settings.fasterCompress'
const ENTRY = 'faster-compress'
const FIELDS = ['eagerRatio', 'warmup', 'maxConcurrent', 'warmupMaxTokens', 'traceTab', 'outputReserveTokens', 'safetyMarginTokens']

const booleanField = field => ({ field,
  format: value => value === undefined ? '' : String(value),
  parse: text => text === '' ? { kind: 'clear' }
    : ['true', 'false'].includes(text) ? { kind: 'set', value: text === 'true' } : undefined,
})

function numberField(field, valid, scale = 1) {
  return {
    field,
    format: value => typeof value === 'number' ? String(Number((value * scale).toFixed(8))) : '',
    parse: text => {
      if (text.trim() === '') return { kind: 'clear' }
      const value = Number(text) / scale
      return Number.isFinite(value) && valid(value) ? { kind: 'set', value } : undefined
    },
  }
}

function createForm(scope) {
  return new SettingsFormModel(scope, [
    numberField('eagerRatio', value => value > 0 && value <= 1, 100),
    booleanField('warmup'),
    numberField('maxConcurrent', value => Number.isInteger(value) && value >= 1),
    numberField('warmupMaxTokens', value => Number.isInteger(value) && value >= 1 && value <= 8),
    booleanField('traceTab'),
    numberField('outputReserveTokens', value => Number.isInteger(value) && value >= 0),
    numberField('safetyMarginTokens', value => Number.isInteger(value) && value >= 0),
  ])
}

function SettingsCard(props) {
  const { t } = props
  const state = props.useFasterCompress(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable || state.saving
  const field = key => h(SettingsValueField, {
    key, id: `faster-compress-${key}`, label: t(key), hint: t(`${key}Hint`),
    overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t(`${key}Invalid`),
    numeric: true, disabled, ...state[key],
    onEdit: text => props.edit(key, text), onReset: () => props.resetField(key),
  })
  const toggle = key => h('div', {
    key, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'start',
      gap: 24, paddingTop: 24, borderTop: '1px solid var(--dsw-alias-border-l2)' },
  },
  h('div', { style: { display: 'grid', gap: 8 } },
    h('span', { style: { fontSize: 13, fontWeight: 500, lineHeight: 1.5 } }, t(key)),
    h('p', { style: { margin: 0, maxWidth: 640, fontSize: 12, lineHeight: 1.7,
      color: 'var(--dsw-alias-label-tertiary)' } }, t(`${key}Hint`))),
  h('div', { style: { paddingTop: 1 } },
    h(Switch, { label: t(key), checked: state[key].text === 'true', disabled,
      onChange: value => props.edit(key, String(value)) })))
  return h(SettingsForm, {
    state, onSave: props.save, onDiscard: props.discard,
    labels: Object.fromEntries(['unavailable', 'readOnly', 'saveFailed', 'save', 'saving'].map(key => [key, t(key)])),
  },
  h('div', { className: 'fc-settings', style: { display: 'grid', gap: 24, width: '100%', maxWidth: 760 } },
    h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.7,
      color: 'var(--dsw-alias-label-secondary)' } }, t('liveHint')),
    field('eagerRatio'),
    toggle('warmup'),
    toggle('traceTab'),
    h('details', { style: { paddingTop: 24, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
      h('summary', { style: { cursor: 'pointer', fontSize: 13, fontWeight: 500, lineHeight: 1.5 } }, t('advanced')),
      h('div', { style: { display: 'grid', gap: 12, paddingTop: 16 } }, field('outputReserveTokens'), field('safetyMarginTokens'), field('maxConcurrent'), field('warmupMaxTokens'))),
    h('button', { type: 'button', disabled, onClick: () => FIELDS.forEach(key => props.resetField(key)),
      style: { justifySelf: 'start', cursor: disabled ? 'default' : 'pointer', font: 'inherit', fontSize: 12,
        lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: 0,
        padding: '4px 0', textDecoration: 'underline', textUnderlineOffset: 3 },
    }, t('resetAll')))
  )
}

async function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, locales))
  const t = ctx.locale.bind(NS)
  const scope = ctx.configForms.get(ENTRY)
  const form = createForm(scope)
  const store = form.bind(() => ({ ...form.shell(), ...Object.fromEntries(FIELDS.map(key => [key, form.field(key)])) }))
  ctx.effect(() => () => form.dispose())
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-faster-compress', locale: NS,
    inject: () => ({ hooks: { fasterCompress: store }, ...form.actions() }),
  }, SettingsCard))))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = traceCss
    document.head.append(style)
    return () => style.remove()
  })
  const unmount = await ctx.remote.$mount({ package: 'dsh-faster-compress', descriptors: [traceDescriptor] })
  ctx.effect(() => unmount)
  ctx.inject(['remote.fasterCompressTrace'], traceCtx => {
    traceCtx.effect(() => ctx.configForms.whileServed([ENTRY], () => {
      let removeView
      const sync = () => {
        const snapshot = scope.getSnapshot()
        const enabled = snapshot.status === 'ready' && snapshot.value?.traceTab !== false
        if (enabled && !removeView) removeView = ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'faster-compress-trace', order: 20, locale: NS,
          label: () => t('trace.tab'),
          inject: sessionId => ({ readTrace: async signal => {
            const answer = await traceCtx.remote.fasterCompressTrace.read(sessionId, signal)
            if (!answer.ok) throw new Error(answer.error?.message || 'Trace unavailable')
            return answer.value
          } }),
        }, TraceView))
        else if (!enabled && removeView) { removeView(); removeView = undefined }
      }
      const unsubscribe = scope.subscribe(sync)
      sync()
      return () => { unsubscribe(); removeView?.() }
    }))
  })
}

module.exports = { inject: ['slots', 'locale', 'configForms', 'remote'], apply, createForm, SettingsCard, TraceView }
