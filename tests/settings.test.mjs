import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import z from '@deepseek-ai/schemastery'
import { FasterCompactionEngine } from '../src/index.js'

const fields = ['eagerRatio', 'warmup', 'maxConcurrent', 'warmupMaxTokens', 'traceTab', 'outputReserveTokens', 'safetyMarginTokens']
const source = await readFile(new URL('../client/index.js', import.meta.url), 'utf8')
const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'))

function loadClient() {
  let plugin, specs
  const primitives = {
    SettingsForm: 'native-form', SettingsValueField: 'native-field', Switch: 'native-switch',
    SettingsFormModel: class {
      constructor(_scope, fields) { specs = fields }
      bind() { return {} }
      dispose() {}
    },
  }
  runInNewContext(source, {
    document: { createElement: () => ({ remove() {} }), head: { append() {} } },
    window: { __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, 'dsh-faster-compress')
      plugin = factory(id => {
        if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }) }
        assert.equal(id, '@deepseek-ai/dsh-client-ui-primitives')
        return primitives
      })
    } } },
  })
  plugin.createForm({})
  return { plugin, specs }
}

test('settings are exposed as live fields with usable schema defaults', () => {
  const schema = FasterCompactionEngine.Config
  const config = FasterCompactionEngine.Config({})
  for (const field of fields) assert.equal(schema.dict[field].meta.volatile, true)
  assert.equal(config.eagerRatio.get(), 1)
  assert.equal(config.warmup.get(), false)
  assert.equal(config.maxConcurrent.get(), 1)
  assert.equal(config.traceTab.get(), true)
  assert.equal(config.warmupMaxTokens.get(), 1)
  for (const invalid of [
    { eagerRatio: 0 }, { eagerRatio: 1.01 }, { eagerRatio: -1 },
    { maxConcurrent: 0 }, { maxConcurrent: 1.5 }, { warmup: 'false' },
    { warmupMaxTokens: 0 }, { warmupMaxTokens: 9 },
  ]) assert.throws(() => FasterCompactionEngine.Config(invalid))
})

test('browser fields validate values and convert percentages to host ratios', () => {
  const { specs } = loadClient()
  const spec = key => specs.find(item => item.field === key)
  assert.equal(spec('eagerRatio').format(0.85), '85')
  assert.equal(spec('eagerRatio').parse('80').value, 0.8)
  assert.equal(spec('eagerRatio').parse('100').value, 1)
  assert.equal(spec('eagerRatio').parse('0'), undefined)
  assert.equal(spec('eagerRatio').parse('oops'), undefined)
  assert.equal(spec('warmup').parse('false').value, false)
  assert.equal(spec('maxConcurrent').parse('1.5'), undefined)
  assert.equal(spec('warmupMaxTokens').parse('9'), undefined)
  for (const field of specs) assert.equal(field.parse('').kind, 'clear')
})

test('the settings schema survives the host-to-browser JSON round trip', () => {
  const form = z.object(Object.fromEntries(fields.map(key => [key, FasterCompactionEngine.Config.dict[key]])))
  const clientSchema = new z(JSON.parse(JSON.stringify(form)))
  for (const field of Object.values(clientSchema.dict)) delete field.meta.volatile
  assert.deepEqual(clientSchema({ eagerRatio: 0.85, warmup: true, maxConcurrent: 1, warmupMaxTokens: 1 }), {
    eagerRatio: 0.85, warmup: true, maxConcurrent: 1, warmupMaxTokens: 1, traceTab: true, outputReserveTokens: 0, safetyMarginTokens: 4096,
  })
  assert.throws(() => clientSchema({ eagerRatio: 1.01 }))
})

test('settings card stages changes, disables read-only controls, and offers resets', () => {
  const { plugin } = loadClient()
  const edits = [], resets = []
  const state = { writable: false, saving: false, ...Object.fromEntries(fields.map(key => [key, { text: key === 'warmup' ? 'true' : '1' }])) }
  const tree = plugin.SettingsCard({
    t: key => zh[key], useFasterCompress: select => select(state),
    edit: (...args) => edits.push(args), resetField: key => resets.push(key),
  })
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flat(Infinity).flatMap(walk)] : []
  const nodes = walk(tree)
  const toggle = nodes.find(node => node.type === 'native-switch')
  assert.equal(toggle.props.disabled, true)
  assert.equal(toggle.props.checked, true)
  toggle.props.onChange(false)
  assert.deepEqual(edits, [['warmup', 'false']])
  nodes.find(node => node.type === 'button').props.onClick()
  assert.deepEqual(resets, fields)
  assert.equal(tree.type, 'native-form', 'saving uses the native revision-fenced form')
})

test('Chinese and English settings expose the same copy keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const dictionary of [zh, en]) {
    for (const value of Object.values(dictionary)) assert.ok(value.length > 0)
  }
})

test('Trace registration follows saved settings and injects its mounted remote namespace', async () => {
  const { plugin } = loadClient()
  const disposers = [], views = new Map()
  let snapshot = { status: 'ready', value: { traceTab: true } }, changed, unmounted = false
  const scope = { getSnapshot: () => snapshot, subscribe: listener => { changed = listener; return () => { changed = null } } }
  const effect = callback => { const dispose = callback(); if (dispose) disposers.push(dispose) }
  const ctx = {
    effect,
    locale: { register: () => () => {}, bind: () => key => key },
    configForms: { get: () => scope, whileServed: (_entries, callback) => callback() },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        views.set(options.name, { options, component })
        return () => views.delete(options.name)
      },
    },
    remote: {
      $mount: async contribution => {
        assert.equal(contribution.descriptors[0].namespace, 'fasterCompressTrace')
        return () => { unmounted = true }
      },
      get fasterCompressTrace() { throw new Error('namespace must be injected before access') },
    },
    inject: (dependencies, callback) => {
      assert.deepEqual(Array.from(dependencies), ['remote.fasterCompressTrace'])
      callback({ effect, remote: { fasterCompressTrace: { read: async sessionId => ({ ok: true, value: { sessionId } }) } } })
    },
  }
  await plugin.apply(ctx)
  assert.equal(views.has('plugins.item'), false, 'community bundles must not create a separate official settings card')
  assert.equal(views.get('plugins.bundle.config').options.key, 'dsh-faster-compress', 'settings belong on the installed package detail page')
  assert.ok(views.has('conversation.view'))
  const view = views.get('conversation.view')
  const result = await view.options.inject('session-a').readTrace(new AbortController().signal)
  assert.equal(result.sessionId, 'session-a')
  changed()
  assert.equal(views.get('conversation.view'), view, 'unchanged snapshots must not re-register the tab')
  snapshot = { status: 'ready', value: { traceTab: false } }
  changed()
  assert.equal(views.has('conversation.view'), false)
  snapshot = { status: 'ready', value: { traceTab: true } }
  changed()
  assert.ok(views.has('conversation.view'))
  for (const dispose of disposers.reverse()) await dispose()
  assert.equal(views.size, 0)
  assert.equal(changed, null)
  assert.ok(unmounted)
})
