import { Service } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { standingMountFor, serviceForAgent } from '@deepseek-ai/dsh-agent-preset-registry'
import { FasterCompactionEngine, DEFAULTS } from './engine.js'
import { TraceJournal, TraceService, traceError } from './trace.js'
import { ResponseTracker } from './response-trace.js'

export { FasterCompactionEngine }
const ENGINE = new URL('./engine.js', import.meta.url).href

/** Host settings/diagnostics only. Automatic compaction belongs to the preset. */
export default class FasterCompressHost extends Service {
  static inject = ['agentPresets', 'loader', 'llm', 'tokenMeter', 'sessions']
  static Config = FasterCompactionEngine.Config

  constructor(ctx, config = {}) {
    super(ctx, 'fasterCompressHost')
    this.config = config
    this.trace = new TraceJournal()
    this.responses = new ResponseTracker({ journal: () => this.trace })
    this.responses.attach(ctx)
    this.work = { inFlight: 0 }
    this.mounts = new Map()
    this.bindings = new Map()
    this.integration = new Map()
    this.stopped = false
    this.preexisting = new Set(ctx.get('agents', false)?.list() ?? [])
    // Plugin callbacks may return an effect/disposer, not a child Fiber.
    // Returning scope.plugin(...) causes Invalid effect and withdraws the RPC.
    ctx.inject(['typert', 'sessionQuery'], scope => {
      scope.plugin(TraceService, { journal: this.trace, integration: id => this.integration.get(id) })
    })
    // DSH awaits this event before releasing any queued agent work. A shared
    // revision has one installation promise even when sessions open together.
    ctx.on('agent/created', ({ agent }) => this.bind(agent))
    ctx.on('agent/disposed', ({ agent }) => {
      this.preexisting.delete(agent)
      this.bindings.get(agent.session.id)?.agents.delete(agent)
      this.bindings.delete(agent.session.id)
      this.integration.delete(agent.session.id)
    })
    for (const agent of this.preexisting) {
      this.integration.set(agent.session.id, { status: 'native', reason: 'restart-required' })
    }
    ctx.effect(() => () => this.stop())
  }

  async bind(agent) {
    if (this.stopped) return
    const id = agent.session.id
    const mount = standingMountFor(agent.ctx)
    if (!mount) { this.integration.set(id, { status: 'native', reason: 'no-preset' }); return }
    let job = this.mounts.get(mount.fiber)
    if (!job) {
      job = { mount, agents: new Set(), task: null }
      this.mounts.set(mount.fiber, job)
      job.task = this.install(job, agent)
    }
    job.agents.add(agent)
    this.bindings.set(id, job)
    try {
      const engine = await job.task
      if (this.stopped) return
      if (engine) {
        engine.bindAgent(agent) // its listener was created during this event
        this.integration.set(id, { status: 'active', preset: mount.presetId })
      } else this.integration.set(id, { status: 'native', reason: 'not-stock', preset: mount.presetId })
    } catch (error) {
      this.integration.set(id, { status: 'native', reason: 'installation', error: traceError(error), preset: mount.presetId })
      if (job.restoreFailed) throw error // do not release work without a backend
      this.ctx.logger.warn(`faster-compress: preset integration inactive; using native backend: ${traceError(error)}`)
    }
  }

  async install(job, agent) {
    const { mount } = job
    const native = serviceForAgent(this.ctx, agent, 'compaction')
    // Exact stock implementation only. Do not replace third-party backends,
    // auto:false policies, or presets intentionally providing no compaction.
    if (!(native instanceof BasicCompactionEngine) || native.constructor !== BasicCompactionEngine) return null
    const entries = [...mount.tree.entries()].filter(row => row.fiber?.runtime.callback === BasicCompactionEngine && !row.disabled)
    // Ambiguous custom compositions keep their native policy.
    if (entries.length !== 1 || native.config.auto === false) return null
    const [entry] = entries
    // Hot installation must not rewrite a revision already serving a turn.
    if ([...this.preexisting].some(other => standingMountFor(other.ctx)?.fiber === mount.fiber)) {
      throw new Error('Preset already has live agents; restart DSH to activate safely')
    }
    const overrides = Object.fromEntries(Object.entries(this.config)
      .filter(([key, value]) => !(key in DEFAULTS) && value !== undefined))
    job.entry = entry
    job.disabled = entry.options.disabled
    job.original = { ...entry.options }
    job.id = `faster-${entry.options.id}`
    if (mount.tree.store[job.id]) throw new Error(`Preset entry ${job.id} already exists`)
    job.owns = false
    try {
      await entry.update({ disabled: true })
      await mount.tree.await()
      if (this.stopped) throw new Error('Plugin stopped during integration')
      // Same group => same compaction realm and same command/overflow consumers.
      job.owns = true
      await mount.tree.create({ ...job.original, id: job.id, name: ENGINE, config: { ...job.original.config, ...overrides } },
        entry.parent.ctx.fiber.entry?.options.id ?? null)
      await mount.tree.await()
      const engine = serviceForAgent(this.ctx, agent, 'compaction')
      if (!(engine instanceof FasterCompactionEngine)) throw new Error('Replacement backend did not activate')
      job.engine = engine
      return engine
    } catch (error) {
      try { await this.restore(job) } catch (rollbackError) {
        job.restoreFailed = true
        throw new Error(`Preset integration and native restoration failed: ${traceError(error)}; ${traceError(rollbackError)}`)
      }
      throw error
    }
  }

  async restore(job) {
    const { mount, entry } = job
    if (!entry) return
    if (job.owns && mount.tree.store[job.id]?.options.name === ENGINE) mount.tree.remove(job.id)
    await mount.tree.await()
    // A retired/disposed preset no longer owns this row; never resurrect it.
    if (mount.tree.store[entry.options.id] === entry && entry.options.name === job.original.name
      && entry.options.disabled === true) {
      await entry.update({ disabled: job.disabled ?? null })
      await mount.tree.await()
    }
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    const results = await Promise.allSettled([...this.mounts.values()].map(async job => {
      await job.task.catch(() => {})
      await this.restore(job)
    }))
    for (const result of results) if (result.status === 'rejected') {
      this.ctx.logger.warn(`faster-compress: could not restore a preset: ${traceError(result.reason)}`)
    }
    this.responses.dispose()
    await this.trace.flush()
    this.mounts.clear()
    this.bindings.clear()
    this.integration.clear()
  }
}
