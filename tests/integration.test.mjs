import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import { serviceForAgent, mountForAgent } from '../src/preset-compat.js'
import Host, { FasterCompactionEngine } from '../src/index.js'
import { TraceJournal } from '../src/trace.js'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'

// Resolve the runtime peers from the installed DSH dependency graph, not a
// second copy of Cordis. No model, user profile or network access is involved.
const runtime = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry'))
const { default: Loader, Group } = await import(runtime.resolve('@deepseek-ai/cordis-plugin-loader'))
const { default: Projections } = await import(runtime.resolve('@deepseek-ai/dsh-session-projection'))
const { createScope, scopeOf, scopeTarget } = await import(runtime.resolve('@deepseek-ai/dsh-scope'))

async function fixture(t, { backend = BasicCompactionEngine, config = {}, hostConfig = {}, plugins } = {}) {
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { group: Group, stock: backend })
  await ctx.plugin(Projections)
  let remoteAccessModule
  try { remoteAccessModule = runtime.resolve('@deepseek-ai/dsh-api-remote-access') } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  if (remoteAccessModule) await ctx.plugin((await import(remoteAccessModule)).default)
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-token-meter', 'dsh-agent', 'dsh-typert-registry', 'dsh-api-gateway']) {
    const { default: Plugin } = await import(runtime.resolve('@deepseek-ai/' + name))
    await ctx.plugin(Plugin)
  }
  ctx.reflect.provide('sessionQuery', { async observeSession() { return { events: [], [Symbol.dispose]() {} } } })
  const commands = new Map()
  ctx.reflect.provide('commands', { register(command) { commands.set(command.name, command); return () => commands.delete(command.name) } })
  await ctx.plugin(Presets, { default: 'probe' })
  await ctx.agentPresets.register({ id: 'probe', plugins: plugins ?? [{
    id: 'compaction', name: 'cordis:group', group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [{ id: 'backend', name: 'cordis:stock', config: { headroomTokens: 100, retainTokens: 100, ...config } }],
  }] })
  const hostFiber = ctx.plugin(Host, { safetyMarginTokens: 50, ...hostConfig })
  await hostFiber
  const host = ctx.get('fasterCompressHost')
  host.trace = new TraceJournal({ directory: null })
  let serial = 0
  const agent = async (preset = 'probe') => {
    const scope = createScope(ctx, {})
    await ctx.agentPresets.mount(scope.ctx, preset)
    const session = Session.create(`integration-${++serial}`)
    session.append('turn/start', { turn: 1 })
    session.append('request/header', { turn: 1, step: 1, reason: 'initial', header: { config: { provider: 'test', model: 'test', maxTokens: 0 } } })
    for (let i = 0; i < 8; i++) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(100) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const value = { ctx: scope.ctx, session, id: session.id, options: {} }
    t.after(() => scope.dispose())
    return value
  }
  const step = agent => ctx.waterfall(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/pre-step', { agent, signal: new AbortController().signal }, () => 'continued')
  const peer = { id: 'test-owner', ctx, principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'none' }
  return { ctx, host, hostFiber, agent, step, commands, peer, engine: a => serviceForAgent(ctx, a, 'compaction') }
}

test('one preset backend handles scoped steps; host disposal restores native configuration', async t => {
  const f = await fixture(t)
  const a = await f.agent(), b = await f.agent()
  // AgentRegistry awaits scoped creation listeners before any first step.
  await Promise.all([f.ctx.agents.register(a), f.ctx.agents.register(b)])
  const engine = f.engine(a)
  assert.ok(engine instanceof FasterCompactionEngine)
  assert.equal(f.engine(b), engine)
  assert.equal(engine.trace, f.host.trace)
  assert.equal(engine.responses, f.host.responses)
  assert.equal(engine.config.retainTokens, 100)
  let calls = 0
  engine.compactIfNeeded = async () => { calls++; return null }
  assert.equal(await f.step(a), 'continued')
  assert.equal(await f.step(b), 'continued')
  assert.equal(calls, 2, 'one automatic handler per step')
  const tree = mountForAgent(f.ctx, a).tree
  assert.equal(tree.resolve('backend').disabled, true)
  await f.hostFiber.dispose()
  assert.equal(f.engine(a).constructor, BasicCompactionEngine)
  assert.equal(f.engine(a).config.retainTokens, 100)
  assert.equal(tree.resolve('backend').disabled, false)
  assert.equal(tree.store['faster-backend'], undefined)
})

test('background preparation does not invoke native pruning; overflow cancels it before pruning', async t => {
  const f = await fixture(t)
  const a = await f.agent()
  await f.host.bind(a)
  const engine = f.engine(a)
  let prunes = 0, summarySignal
  engine.ctx.reflect.provide('toolResultPruner', { async pruneSession() { prunes++; assert.equal(summarySignal.aborted, true); return 0 } })
  engine.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1000 } })
  engine.ctx.tokenMeter.measure = session => ({ totalTokens: 800, nodes: session.surface.nodes.map(seq => ({ seq, tokens: 100, heuristicTokens: 100 })) })
  engine.summarize = async (_input, _owner, signal) => {
    summarySignal = signal
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  assert.equal(await f.step(a), 'continued')
  assert.equal(prunes, 0)
  assert.equal(summarySignal.aborted, false)
  engine.summarize = async () => { throw new Error('stop test before model I/O') }
  await assert.rejects(engine.compactIfNeeded(a, 'context-overflow', new AbortController().signal), /stop test/)
  assert.equal(prunes, 1)
  assert.equal(summarySignal.aborted, true)
})

test('agents joining during backend replacement share the same installation', async t => {
  const f = await fixture(t)
  const a = await f.agent(), b = await f.agent()
  const tree = mountForAgent(f.ctx, a).tree
  const create = tree.create.bind(tree)
  const entered = Promise.withResolvers(), resume = Promise.withResolvers()
  let replacements = 0
  tree.create = async (...args) => {
    replacements++
    entered.resolve()
    await resume.promise
    return create(...args)
  }
  const first = f.host.bind(a)
  await entered.promise
  let second
  try {
    assert.equal(f.engine(a), undefined, 'native is disabled during the gap')
    second = f.host.bind(b)
    assert.equal(f.host.mounts.size, 1)
  } finally { resume.resolve() }
  await Promise.all([first, second])
  assert.equal(replacements, 1)
  assert.ok(f.engine(a) instanceof FasterCompactionEngine)
  assert.equal(f.engine(b), f.engine(a))
  assert.equal(f.host.integration.get(b.session.id).status, 'active')
})

test('preset service lookup and restoration stay inside their own host', async t => {
  const left = await fixture(t), right = await fixture(t)
  const a = await left.agent(), b = await right.agent()
  const leftNative = left.engine(a), rightNative = right.engine(b)
  assert.notEqual(leftNative, rightNative)
  await left.host.bind(a)
  assert.equal(right.engine(b), rightNative)
  await right.host.bind(b)
  const rightEngine = right.engine(b)
  assert.ok(rightEngine instanceof FasterCompactionEngine)
  assert.notEqual(left.engine(a), rightEngine)
  await left.hostFiber.dispose()
  assert.equal(left.engine(a).constructor, BasicCompactionEngine)
  assert.equal(right.engine(b), rightEngine)
})

test('a preset without a compaction backend remains unchanged', async t => {
  const f = await fixture(t, { plugins: [] })
  const a = await f.agent()
  await f.host.bind(a)
  assert.equal(f.engine(a), undefined)
  assert.equal(f.host.integration.get(a.session.id).status, 'native')
})

test('a third-party service without a Loader context is left intact', async t => {
  const custom = { compactIfNeeded: async () => null }
  class CustomBackend {
    constructor(ctx) { ctx.reflect.provide('compaction', custom) }
  }
  const f = await fixture(t, { backend: CustomBackend })
  const a = await f.agent()
  await f.host.bind(a)
  assert.equal(f.engine(a), custom)
  assert.equal(f.host.integration.get(a.session.id).status, 'native')
})

for (const variant of ['third-party', 'auto-disabled']) test(`preserves ${variant} preset policy`, async t => {
  class Custom extends BasicCompactionEngine {}
  const f = await fixture(t, variant === 'third-party' ? { backend: Custom } : { config: { auto: false } })
  const a = await f.agent(), before = f.engine(a)
  await f.host.bind(a)
  assert.equal(f.engine(a), before)
  assert.equal(f.host.integration.get(a.session.id).status, 'native')
})

test('failed replacement restores native backend instead of leaving an empty realm', async t => {
  const f = await fixture(t)
  const a = await f.agent(), tree = mountForAgent(f.ctx, a).tree
  const create = tree.create.bind(tree)
  tree.create = async () => { throw new Error('injected loader failure') }
  await f.host.bind(a)
  assert.equal(f.engine(a).constructor, BasicCompactionEngine)
  assert.equal(tree.resolve('backend').disabled, false)
  assert.equal(f.host.integration.get(a.session.id).reason, 'installation')
  tree.create = create
})

const yaml = runtime('js-yaml')
const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
for (const preset of ['standard', 'ptc', 'cordis', 'minimal']) test(`installed ${preset} preset compaction group uses the same backend for commands and steps`, async t => {
  const webRoot = dirname(runtime.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const patches = yaml.load(await readFile(join(webRoot, 'presets', `${preset}.patch.yml`), 'utf8'), { schema })
  const plugins = patches[0].insert[0].config.plugins.filter(row => row.id === 'compaction')
  for (const group of plugins) for (const row of group.config) {
    if (row.name.startsWith('@')) row.name = pathToFileURL(runtime.resolve(row.name)).href
  }
  const f = await fixture(t, { plugins })
  const a = await f.agent()
  await f.ctx.agents.register(a)
  if (!plugins.length) {
    assert.equal(f.engine(a), undefined)
    assert.equal(f.commands.has('compact'), false)
    return
  }
  const engine = f.engine(a)
  assert.ok(engine instanceof FasterCompactionEngine)
  const pruner = serviceForAgent(f.ctx, a, 'toolResultPruner')
  const hasPruner = plugins.some(group => group.config.some(row => row.id === 'tool-result-pruner'))
  if (hasPruner) {
    assert.ok(pruner)
    assert.equal(pruner.config.thresholdChars, 8192)
  } else assert.equal(pruner, undefined)
  let manual = 0, automatic = 0
  engine.compactNow = async agent => { assert.equal(agent, a); manual++; return null }
  engine.compactIfNeeded = async () => { automatic++; return null }
  assert.equal(await f.step(a), 'continued')
  const answer = await f.commands.get('compact').handler({ agent: a, rawInput: '', signal: new AbortController().signal })
  assert.equal(answer.kind, 'success')
  assert.equal(manual, 1)
  assert.equal(automatic, 1)
})

test('hot loading leaves a revision with preexisting agents untouched', async t => {
  const f = await fixture(t)
  await f.hostFiber.dispose()
  const a = await f.agent()
  await f.ctx.agents.register(a)
  await f.ctx.plugin(Host)
  const host = f.ctx.get('fasterCompressHost'), b = await f.agent()
  await f.ctx.agents.register(b)
  assert.equal(f.engine(a).constructor, BasicCompactionEngine)
  assert.equal(f.engine(b).constructor, BasicCompactionEngine)
  assert.equal(host.integration.get(a.session.id).reason, 'restart-required')
  assert.match(host.integration.get(b.session.id).error, /restart DSH/)
})

test('different preset revisions share one background admission limit', async t => {
  const f = await fixture(t)
  await f.ctx.agentPresets.register({ id: 'other', plugins: [{ id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [{ id: 'backend', name: 'cordis:stock', config: { headroomTokens: 100, retainTokens: 100 } }] }] })
  const a = await f.agent(), b = await f.agent('other')
  await Promise.all([f.ctx.agents.register(a), f.ctx.agents.register(b)])
  assert.notEqual(f.engine(a), f.engine(b))
  f.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1000 } })
  f.ctx.tokenMeter.measure = session => ({ totalTokens: 800, nodes: session.surface.nodes.map(seq => ({ seq, tokens: 100, heuristicTokens: 100 })) })
  let calls = 0
  for (const agent of [a, b]) f.engine(agent).summarize = async (_input, _owner, signal) => {
    calls++
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  await Promise.all([f.step(a), f.step(b)])
  assert.equal(calls, 1)
  assert.equal(f.host.work.inFlight, 1)
  await f.host.stop()
  assert.equal(f.host.work.inFlight, 0)
})

test('real pruner preserves the original log and runs only on fallback after cancellation', async t => {
  const f = await fixture(t)
  const a = await f.agent()
  const tree = mountForAgent(f.ctx, a).tree
  await tree.create({ id: 'pruner', name: pathToFileURL(runtime.resolve('@deepseek-ai/dsh-compaction-tool-result-pruner')).href }, 'compaction')
  await tree.await()
  await f.ctx.agents.register(a)
  const engine = f.engine(a)
  a.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }], source: { provider: 'test', model: 'test' } }) }, { surfaceOp: 'append' })
  const original = a.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'c1', content: [{ type: 'text', text: 'x'.repeat(10000) }], isError: false }) }, { surfaceOp: 'append' })
  a.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  engine.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1000 } })
  engine.ctx.tokenMeter.measure = session => ({ totalTokens: 800, nodes: session.surface.nodes.map(seq => ({ seq, tokens: 70, heuristicTokens: 70 })) })
  let summarySignal
  engine.summarize = async (_input, _agent, signal) => {
    summarySignal = signal
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  await f.step(a)
  assert.equal(a.session.snapshotEvents().some(e => e.type === 'compaction/prune'), false)
  const pruner = serviceForAgent(f.ctx, a, 'toolResultPruner'), prune = pruner.pruneSession.bind(pruner)
  pruner.pruneSession = session => { assert.equal(summarySignal.aborted, true); return prune(session) }
  engine.summarize = async () => { throw new Error('stop after actual pruning') }
  await assert.rejects(engine.compactIfNeeded(a, 'context-overflow', new AbortController().signal), /stop after actual pruning/)
  assert.equal(a.session.eventAt(original.seq).data.message.content[0].text.length, 10000)
  assert.equal(a.session.snapshotEvents().filter(e => e.type === 'compaction/prune').length, 1)
  assert.equal(a.session.surface.nodes.includes(original.seq), false)
  assert.deepEqual(Session.create('replay', a.session.snapshotEvents()).surface.nodes, a.session.surface.nodes)
})


test('history strict RPC survives preset replacement and first session read', async t => {
  const f = await fixture(t)
  await new Promise(resolve => setImmediate(resolve))
  const endpoint = 'fasterCompressTrace/read'
  assert.ok(f.ctx.typert.local.get(endpoint), 'registered at startup')
  const a = await f.agent()
  await f.ctx.agents.register(a)
  assert.ok(f.ctx.typert.local.get(endpoint), 'still registered after backend replacement')
  const result = await f.ctx.typertGateway.invoke({ namespace: 'fasterCompressTrace', method: 'read', args: { sessionId: a.session.id }, signal: new AbortController().signal, peer: f.peer })
  assert.equal(result.integration.status, 'active')
  assert.ok(f.ctx.typert.local.get(endpoint), 'still registered after read')
})


test('history strict RPC is withdrawn on host unload and restored on reload', async t => {
  const f = await fixture(t)
  await new Promise(resolve => setImmediate(resolve))
  const request = { namespace: 'fasterCompressTrace', method: 'read', args: { sessionId: 'isolated-rpc' }, signal: new AbortController().signal, peer: f.peer }
  assert.ok(await f.ctx.typertGateway.invoke(request))
  await f.hostFiber.dispose()
  await assert.rejects(f.ctx.typertGateway.invoke(request), /strict definition was withdrawn/)
  const reloaded = f.ctx.plugin(Host)
  await reloaded.await()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(await f.ctx.typertGateway.invoke(request))
  await assert.rejects(f.ctx.typertGateway.invoke({ ...request, args: { sessionId: '' } }), error => error.code === 'gateway/input-invalid')
})

for (const order of ['before-backend', 'after-backend']) {
  test(`DS Bot wrapper isolates owned sessions on a shared preset (${order})`, async t => {
    const f = await fixture(t)
    const bot = await f.agent(), ordinary = await f.agent()
    const owned = new Set([bot.session.id])
    const adopted = new Map()
    const marker = Symbol.for('ds-bot/compaction')
    // Released DS Bot 0.2.1 adopts the preset backend in a prepended pre-step
    // handler and returns null only for its own sessions. Exercise real scoped
    // Cordis dispatch, including both listener registration orders.
    const installBot = () => f.ctx.on('agent/pre-step', ({ agent }, next) => {
      const engine = f.engine(agent)
      if (!engine[marker]) {
        const original = engine[marker] = { compactIfNeeded: engine.compactIfNeeded }
        adopted.set(engine, original)
        engine.compactIfNeeded = function (target, trigger, signal) {
          if (owned.has(target.session.id)) return Promise.resolve(null)
          return original.compactIfNeeded.call(this, target, trigger, signal)
        }
      }
      return next()
    }, { prepend: true })
    let stopBot
    if (order === 'before-backend') stopBot = installBot()
    await f.ctx.agents.register(bot)
    await f.ctx.agents.register(ordinary)
    if (order === 'after-backend') stopBot = installBot()
    const engine = f.engine(bot)
    assert.equal(f.engine(ordinary), engine)
    engine.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1000 } })
    engine.ctx.tokenMeter.measure = session => ({ totalTokens: 800, nodes: session.surface.nodes.map(seq => ({ seq, tokens: 100, heuristicTokens: 100 })) })
    const requests = []
    engine.summarize = async (_input, owner, signal) => {
      requests.push(owner.session.id)
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    assert.equal(await f.step(bot), 'continued')
    assert.deepEqual(requests, [])
    assert.equal(await f.step(ordinary), 'continued')
    assert.deepEqual(requests, [ordinary.session.id])
    // Taking ownership later cancels preparation, even though the shared engine
    // was already adopted and the other session previously passed its wrapper.
    owned.add(ordinary.session.id)
    await f.step(ordinary)
    const record = f.host.trace.cell(ordinary.session.id).records[0]
    assert.equal(record.status, 'discarded')
    assert.equal(record.reason, 'ds-bot')
    // Match DS Bot's unload: restore entry points and remove the marker.
    stopBot()
    for (const [backend, original] of adopted) {
      backend.compactIfNeeded = original.compactIfNeeded
      delete backend[marker]
    }
    await f.step(bot)
    assert.deepEqual(requests, [ordinary.session.id, bot.session.id])
  })
}
