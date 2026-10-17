// Browser factory body. `locales` is supplied by the build wrapper.
const { createElement: h } = require('react')
const { SettingsForm, SettingsValueField, SettingsFormModel, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
const NS = 'settings.fasterCompress'
const ENTRY = 'faster-compress'
const FIELDS = ['eagerRatio', 'warmup', 'maxConcurrent', 'warmupMaxTokens']

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
    numberField('eagerRatio', value => value > 0 && value < 1, 100),
    {
      field: 'warmup',
      format: value => value === undefined ? '' : String(value),
      parse: text => text === '' ? { kind: 'clear' }
        : ['true', 'false'].includes(text) ? { kind: 'set', value: text === 'true' } : undefined,
    },
    numberField('maxConcurrent', value => Number.isInteger(value) && value >= 1),
    numberField('warmupMaxTokens', value => Number.isInteger(value) && value >= 1 && value <= 8),
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
  return h(SettingsForm, {
    state, onSave: props.save, onDiscard: props.discard,
    labels: Object.fromEntries(['unavailable', 'readOnly', 'saveFailed', 'save', 'saving'].map(key => [key, t(key)])),
  },
  h('p', { style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('liveHint')),
  field('eagerRatio'),
  h('div', { style: { display: 'grid', gap: 8 } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 } },
      h('span', null, t('warmup')),
      h(Switch, { label: t('warmup'), checked: state.warmup.text === 'true', disabled,
        onChange: value => props.edit('warmup', String(value)) })),
    h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('warmupHint'))),
  h('details', null, h('summary', { style: { cursor: 'pointer', marginBottom: 12 } }, t('advanced')),
    h('div', { style: { display: 'grid', gap: 16 } }, field('maxConcurrent'), field('warmupMaxTokens'))),
  h('button', { type: 'button', disabled, onClick: () => FIELDS.forEach(key => props.resetField(key)),
    style: { alignSelf: 'flex-start', cursor: disabled ? 'default' : 'pointer', font: 'inherit', fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: 0, padding: '4px 0', textDecoration: 'underline' },
  }, t('resetAll')))
}

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, locales))
  const t = ctx.locale.bind(NS)
  const form = createForm(ctx.configForms.get(ENTRY))
  const store = form.bind(() => ({ ...form.shell(), ...Object.fromEntries(FIELDS.map(key => [key, form.field(key)])) }))
  ctx.effect(() => () => form.dispose())
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: ENTRY, order: 45, label: () => t('title'), locale: NS,
    inject: () => ({ hooks: { fasterCompress: store }, ...form.actions() }),
  }, SettingsCard))))
}

module.exports = { inject: ['slots', 'locale', 'configForms'], apply, createForm, SettingsCard }
