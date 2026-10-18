/**
 * dsh-faster-compress: context compaction that does not interrupt the agent.
 *
 * The shipped compaction backend generates a summary inside the `agent/pre-step`
 * waterfall and awaits it, so the next model request cannot leave until the
 * summary has been written. For a long conversation that is a visible stall: the
 * agent is idle, the user cannot steer, and nothing is happening except the
 * summary.
 *
 * This bundle keeps the shipped backend's transaction, pricing, invariant, and
 * crash recovery untouched and changes only when the work happens:
 *
 *   - at the preparation threshold, generate a summary while the task continues;
 *   - apply a ready summary at the next safe step boundary, preserving new tail;
 *   - wait before spending the output reservation or the remaining safety margin.
 *
 * Separate prefix warming is opt-in; the next real request normally performs
 * the rewritten prefix's prefill as useful work.
 *
 * @module dsh-faster-compress
 */

import { randomUUID } from 'node:crypto'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { budgets, policyFor } from './budgets.js'
import { openTurnOf, selectRange, selectionIntact, selectionSurfaceIntact } from './selection.js'
import { checkpointMessage, postCommitPrefix, summarizationInput } from './checkpoint.js'
import { commit } from './transaction.js'
import { TraceJournal, TraceService, textOf, sourceExcerpt, traceError } from './trace.js'
import { ResponseTracker } from './response-trace.js'
import { inheritReasoning, requestRoute, prefixFingerprint, usageSnapshot } from './request-policy.js'

const ratio = z.number()
const positiveInt = z.number().step(1).min(1)
const warmupTokens = z.number().step(1).min(1).max(8)

/**
 * Configuration of the shipped backend, restated so the Settings UI and
 * validation still cover it, plus the fields this bundle adds.
 *
 * Restated fields mirror `BasicCompactionConfig` in
 * `@deepseek-ai/dsh-compaction-basic`; unknown keys pass through, so a field
 * added upstream later is still forwarded to the inherited resolver.
 */
const configSchema = z.object({
  thresholdRatio: ratio,
  headroomTokens: positiveInt,
  retainRatio: ratio,
  retainTokens: positiveInt,
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: positiveInt,
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
  modelPolicies: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    thresholdRatio: ratio,
    headroomTokens: positiveInt,
    retainRatio: ratio,
    retainTokens: positiveInt,
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: positiveInt,
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
  })),
  auto: z.boolean(),

  /** Fraction of the preparation threshold at which preparation starts. Defaults to 1. */
  // Serializable bounds: the settings client rehydrates schemas
  // and cannot execute a server-only transform callback.
  eagerRatio: z.number().min(Number.MIN_VALUE).max(1).default(1).volatile(),
  /** Try to warm the rewritten prefix while a tool runs; cache retention is provider-owned. */
  warmup: z.boolean().default(false).volatile(),
  /** Generation cap of the warm-up request; it exists to populate the prefix cache, not to answer. */
  warmupMaxTokens: warmupTokens.default(1).volatile(),
  /** Summaries generated concurrently across all sessions of this host. */
  maxConcurrent: z.number().step(1).min(1).default(1).volatile(),
  /** Show the per-conversation diagnostic view; recording remains available when hidden. */
  traceTab: z.boolean().default(true).volatile(),
  outputReserveTokens: z.number().step(1).min(0).default(0).volatile(),
  safetyMarginTokens: z.number().step(1).min(0).default(4096).volatile(),
})

/** Defaults for the added fields. */
export const DEFAULTS = Object.freeze({
  eagerRatio: 1,
  warmup: false,
  warmupMaxTokens: 1,
  maxConcurrent: 1,
  traceTab: true,
  outputReserveTokens: 0,
  safetyMarginTokens: 4096,
})

/** Stop waiting immediately on cancellation, even if the provider ignores it. */
async function waitForSummary(settled, signal) {
  signal.throwIfAborted()
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([settled, aborted])
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * A basic compaction backend that prepares summaries in the background
 * and applies them when ready at the next safe step boundary.
 */
export class FasterCompactionEngine extends BasicCompactionEngine {
  /** Row configuration schema, extending the inherited backend's fields. */
  static Config = configSchema

  /** Prepared summary that has not been committed yet. */
  #pending = new WeakMap()
  /** Summaries currently being generated, for the concurrency cap. */
  #work = { inFlight: 0 }
  /** Failed preparation falls back once at the preparation threshold instead of looping. */
  #fallback = new WeakSet()
  /** Agents seen since load, keyed by session id, to reach a session's owner. */
  #agents = new Map()
  /** Adapter metadata per routed target, invalidated on adapter updates. */
  #capacity = new Map()
  #capacityEpoch = 0
  #admission = new WeakMap()
  #idle = new WeakSet()
  // Bound summaries retained across idle sessions; no persisted executable state.
  #parked = new Map()
  #turns = new WeakMap()
  /** Cancellation for background work, independent of any single turn. */
  #abort = new AbortController()
  /** Loader-owned live settings; reads never remount the compaction service. */
  #eagerConfig

  #eagerSnapshot
  get eager() {
    let next
    for (const key in DEFAULTS) {
      const setting = this.#eagerConfig[key]
      const value = (isVolatile(setting) ? setting.get() : setting) ?? DEFAULTS[key]
      if (!this.#eagerSnapshot || value !== this.#eagerSnapshot[key]) {
        next ??= { ...this.#eagerSnapshot }
        next[key] = value
      }
    }
    if (next) this.#eagerSnapshot = Object.freeze(next)
    return this.#eagerSnapshot
  }

  constructor(ctx, config = {}) {
    const basicConfig = Object.fromEntries(Object.entries(config).filter(([key]) => !(key in DEFAULTS)))
    super(ctx, basicConfig)
    const host = ctx.get?.('fasterCompressHost', false)
    this.#eagerConfig = host?.config ?? config
    this.#work = host?.work ?? this.#work
    this.trace = host?.trace ?? new TraceJournal()
    this.responses = host?.responses ?? new ResponseTracker({ journal: () => this.trace })
    if (!host) {
      this.responses.attach(ctx)
      ctx.inject?.(['typert', 'sessionQuery'], scope => { scope.plugin(TraceService, { journal: this.trace }) })
    }
    const { eagerRatio } = this.eager
    if (!(eagerRatio > 0 && eagerRatio <= 1)) {
      throw new Error(`dsh-faster-compress: eagerRatio (${eagerRatio}) must be greater than 0 and at most 1`)
    }
    ctx.effect(() => () => {
      for (const agent of this.#agents.values()) this.#discard(agent.session, 'unloaded')
      for (const agent of this.#agents.values()) this.#releaseTurn(agent.session)
      this.#abort.abort()
      if (!host) this.responses.dispose()
      return this.trace.flush()
    })
    ctx.on('llm/adapters-updated', () => { this.#capacityEpoch += 1; this.#capacity.clear() })
    if (this.config.auto) this.#registerTriggers()
  }

  bindAgent(agent) {
    if (this.config.auto) this.#agents.set(agent.session.id, agent)
  }

  async compactRegion(start, end, agent, signal) {
    this.#discard(agent.session, 'manual')
    return super.compactRegion(start, end, agent, signal)
  }

  /**
   * Keep the stock prompt, policy resolution and output validation. Its public
   * summarizer only needs config and ctx.llm.stream; a per-call receiver adapts
   * that one boundary without mutating the shared context or another session.
   * All inherited compaction paths (including manual/overflow) use this hook.
   */
  async summarize(input, agent, signal) {
    const conversation = { ...agent.session.requestHeader()?.config }
    let requestConfig
    const receiver = { config: this.config, ctx: { llm: { stream: options => {
      const request = inheritReasoning(options, conversation)
      requestConfig = requestRoute(request)
      return this.ctx.llm.stream(request)
    } } } }
    const result = await super.summarize.call(receiver, input, agent, signal)
    return { ...result, requestConfig }
  }

  /**
   * Start at the preparation threshold, commit as soon as ready at this safe boundary,
   * and wait cancellably only at the safety limit. Keep stock retry guarantees.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent Agent whose latest routed request is measured.
   * @param {'pressure' | 'context-overflow'} trigger Normal step pressure or provider-confirmed overflow.
   * @param {AbortSignal} signal Cancellation of the live turn.
   * @returns {Promise<import('@deepseek-ai/dsh-compaction').CompactionResult | null>} The committed compaction, if any.
   */
  async compactIfNeeded(agent, trigger, signal) {
    try { return await this.#compactIfNeeded(agent, trigger, signal) }
    finally { this.responses.endBlocking(agent.session) }
  }

  async #nativeFallback(agent, trigger, signal, budget) {
    this.#discard(agent.session, trigger === 'context-overflow' ? 'overflow' : 'fallback')
    this.responses.beginBlocking(agent.session, trigger)
    const result = await super.compactIfNeeded(agent, trigger, signal)
    if (budget && this.ctx.tokenMeter.measure(agent.session).totalTokens >= budget.waitTokens) {
      throw new Error('faster-compress: native fallback did not reduce input below the safety limit; adjust compaction policy or reduce context')
    }
    return result
  }

  async #compactIfNeeded(agent, trigger, signal) {
    signal.throwIfAborted()
    this.#idle.delete(agent.session)
    this.#parked.delete(agent.session)
    this.#bindTurn(agent.session, signal)
    // Overflow recovery is a repair, not a scheduled compaction: it forces a
    // reduction below the normal thresholds and must run inline.
    if (trigger === 'context-overflow') {
      this.responses.beginBlocking(agent.session, trigger)
      this.#discard(agent.session, 'overflow')
      this.#fallback.delete(agent.session)
      return this.#nativeFallback(agent, trigger, signal)
    }

    const budget = await this.#budget(agent, signal)
    signal.throwIfAborted()
    // Without a resolvable capacity the inherited path reports the
    // configuration error, which is the diagnosis the operator needs.
    if (budget === null) {
      this.#discard(agent.session, 'budget-unknown')
      return this.#nativeFallback(agent, trigger, signal, budget)
    }

    const session = agent.session
    const total = this.ctx.tokenMeter.measure(session).totalTokens
    if (!(budget.thresholdTokens > 0)) return this.#nativeFallback(agent, trigger, signal, budget)
    const pending = this.#pending.get(session)
    if (pending === undefined && this.#fallback.has(session) && total >= budget.thresholdTokens) {
      this.#fallback.delete(session)
      this.responses.beginBlocking(session, trigger)
      return this.#nativeFallback(agent, trigger, signal, budget)
    }
    if (pending === undefined && !this.#fallback.has(session) && total >= budget.eagerTokens && total < budget.waitTokens) {
      this.#start(agent, budget, signal)
      // Never commit from an asynchronous completion callback or this launch:
      // the next pre-step revalidates the selected surface and the current route.
      return null
    }
    if (pending?.summary === undefined && total < budget.waitTokens) return null

    this.responses.beginBlocking(session, trigger)
    if (pending === undefined) return this.#nativeFallback(agent, trigger, signal, budget)

    const committed = await this.#commit(agent, pending, signal)
    if (committed !== null) {
      this.ctx.logger.info(
        `faster-compress: committed a pre-generated summary shadowing ${committed.shadowedSeqs.length} `
        + `surface nodes (seqs ${committed.shadowedRange.start}-${committed.shadowedRange.end}, `
        + `~${committed.shadowedTokenCount} tokens)`,
      )
      // A large result may have arrived after selection. Count the prepared
      // commit as the first attempt, then use the stock transaction for retries.
      const config = session.requestHeader()?.config
      if (!config) throw new Error('faster-compress: request header missing after prepared commit')
      const policy = policyFor(this.config, config)
      let result = committed
      let measurement = this.ctx.tokenMeter.measure(session)
      for (let retry = 0; measurement.totalTokens >= budget.thresholdTokens && retry < policy.compactionRetries; retry += 1) {
        signal.throwIfAborted()
        const selection = selectRange(session, measurement, budget.retainTokens)
        if (selection === null) break
        result = await this.compactRegion(selection.start, selection.end, agent, signal)
        measurement = this.ctx.tokenMeter.measure(session)
      }
      if (measurement.totalTokens >= budget.thresholdTokens) {
        throw new Error(`compaction still above threshold after ${policy.compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${budget.thresholdTokens})`)
      }
      return result
    }
    // The prepared summary went stale or did not shrink enough; fall back to
    // the inherited path rather than skipping a compaction the surface needs.
    this.#fallback.delete(session)
    return this.#nativeFallback(agent, trigger, signal, budget)
  }

  /**
   * Start a background summary as soon as a tool begins running.
   *
   * A tool call is the best available window: the surface is quiescent until
   * its result lands, the model is not decoding, and the tool usually runs
   * long enough for the summary to finish before the next step boundary.
   *
   * @param {import('@deepseek-ai/dsh-session').Session} session Session that recorded the call.
   * @returns {void}
   */
  #onToolCall(session) {
    const agent = this.#agents.get(session.id)
    if (agent === undefined || this.#idle.has(session)) return
    const pending = this.#pending.get(session)
    if (pending !== undefined) {
      this.#validateWarmup(agent, pending)
      if (this.eager.warmup && pending.summary !== undefined && !pending.warmed) void this.#warmup(agent, pending)
      return
    }
    const admission = this.#admission.get(session)
    void this.#tryStart(agent).catch(error => {
      this.ctx.logger.debug?.(`faster-compress: background preparation failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!this.#abort.signal.aborted && this.#agents.get(session.id) === agent
        && !this.#idle.has(session) && this.#admission.get(session) === admission) {
        const id = randomUUID()
        this.trace.begin(session.id, { id })
        this.trace.update(session.id, id, { status: 'failed', reason: 'preparation', error: traceError(error) })
      }
    })
  }

  /** Register the listeners this bundle adds to the inherited ones. */
  #registerTriggers() {
    const { ctx } = this
    ctx.on('agent/created', ({ agent }) => this.bindAgent(agent))
    ctx.on('agent/disposed', ({ agent }) => {
      this.#discard(agent.session, 'disposed')
      this.#agents.delete(agent.session.id)
      this.#releaseTurn(agent.session)
    })
    // Normal completion closes admission, not the reusable selected prefix.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') {
        this.#park(agent.session)
        this.#fallback.delete(agent.session)
      }
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') this.#idle.delete(session)
      if (event.type === 'turn/end') {
        if (event.data.reason?.kind === 'aborted' || event.data.reason?.kind === 'error') this.#discard(session, 'cancelled')
        this.#park(session)
      }
      const pending = this.#pending.get(session)
      if (pending && event.surfaceOp?.op === 'replace'
        && !selectionSurfaceIntact(session, pending.selection)) {
        this.#discard(session, 'stale')
        this.#fallback.add(session)
      }
      if (event.type === 'tool/call') this.#onToolCall(session)
    })
  }

  /**
   * Measure pressure against the routed model's capacity.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent Agent to measure.
   * @returns {Promise<import('./budget.js').Budget | null>} Budgets, or `null` when the route is unresolved.
   */
  async #tryStart(agent) {
    const session = agent.session
    const admission = this.#admission.get(session)
    const budget = await this.#budget(agent)
    if (budget === null || this.#agents.get(session.id) !== agent || this.#idle.has(session)
      || this.#admission.get(session) !== admission) return
    const total = this.ctx.tokenMeter.measure(agent.session).totalTokens
    if (budget.thresholdTokens > 0 && total >= budget.eagerTokens && total < budget.waitTokens && !this.#fallback.has(agent.session)) this.#start(agent, budget)
  }

  /**
   * Resolve the pressure budgets for the routed conversation target.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent Agent whose route defines the budgets.
   * @returns {Promise<import('./budget.js').Budget | null>} Budgets, or `null` when capacity is unknown.
   */
  async #budget(agent, signal = this.#abort.signal) {
    let config, target, info
    for (;;) {
      signal.throwIfAborted()
      config = agent.session.requestHeader()?.config
      if (config === undefined || config.provider.length === 0 || config.model.length === 0) return null
      target = { provider: config.provider, model: config.model }
      const key = JSON.stringify([target.provider, target.model])
      const epoch = this.#capacityEpoch
      info = this.#capacity.get(key)
      if (info === undefined) {
        info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
        signal.throwIfAborted()
        if (epoch !== this.#capacityEpoch) continue
        this.#capacity.set(key, info)
      }
      const current = agent.session.requestHeader()?.config
      if (current?.provider !== target.provider || current?.model !== target.model) continue
      config = current
      break
    }
    if (info.context?.contextWindow === undefined) return null
    const policy = policyFor({ ...this.config, ...this.eager }, target)
    const declared = config.maxTokens ?? info.defaultMaxTokens
    const reserve = this.eager.outputReserveTokens
    const known = Number.isFinite(declared) && declared >= 0
    const host = this.ctx.get?.('fasterCompressHost', false)
    const integration = host?.integration.get(agent.session.id)
    if (!known && reserve === 0) {
      if (integration) integration.budgetWarning = 'output-reserve-unknown'
      return null
    }
    const result = budgets(policy, info.context.contextWindow, Math.max(known ? declared : 0, reserve))
    if (!Number.isInteger(result.contextWindow) || result.contextWindow <= 0
      || !Number.isInteger(result.reservedCompletion) || result.reservedCompletion < 0
      || result.thresholdTokens <= 0 || result.retainTokens >= result.thresholdTokens) {
      this.#discard(agent.session, 'budget-invalid')
      throw new Error('faster-compress: invalid context/output/safety/retention budget; no safe background progress is possible')
    }
    if (integration) { delete integration.budgetWarning; integration.budget = result }
    return result
  }

  /**
   * Generate a summary for the selected span in the background.
   *
   * Nothing is written to the session log here. The durable bracket is opened
   * only at commit, so an abandoned summary leaves no trace and the compaction
   * lock is never held across a background wait.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent Agent owning the session.
   * @param {import('./budget.js').Budget} budget Budgets measured for this decision.
   * @param {AbortSignal} [turnSignal] Cancellation of the turn that starts preparation.
   * @returns {void}
   */
  #start(agent, budget, turnSignal) {
    const session = agent.session
    if (this.#abort.signal.aborted || turnSignal?.aborted || this.#idle.has(session) || this.#pending.has(session) || this.#work.inFlight >= this.eager.maxConcurrent) return

    const selection = selectRange(session, this.ctx.tokenMeter.measure(session), budget.retainTokens)
    if (selection === null) return

    const abort = new AbortController()
    const signal = AbortSignal.any([this.#abort.signal, abort.signal])
    const input = summarizationInput(session, selection.seqs)
    const prepared = {
      abort,
      signal,
      compactionId: CompactionId(randomUUID()),
      selection,
      summary: undefined,
      envelope: undefined,
      settled: undefined,
      warmed: false,
      startedAt: performance.now(),
    }
    this.#pending.set(session, prepared)
    const target = session.requestHeader()?.config
    this.trace.begin(session.id, {
      id: prepared.compactionId, range: { start: selection.start, end: selection.end },
      nodeCount: selection.seqs.length, inputTokens: selection.heuristicTokens,
      thresholdTokens: budget.thresholdTokens, eagerTokens: budget.eagerTokens, waitTokens: budget.waitTokens,
      contextWindow: budget.contextWindow, reservedCompletion: budget.reservedCompletion, inputLimit: budget.inputLimit,
      provider: target?.provider, model: target?.model,
      ...sourceExcerpt((function* () {
        for (const seq of selection.seqs) yield session.deriveEventMessage(session.eventAt(seq))?.content
      })()),
    })
    this.#work.inFlight += 1
    prepared.settled = (async () => {
      try {
        const result = await this.summarize(input, agent, signal)
        signal.throwIfAborted()
        // Discarded while generating: the surface moved on, so the summary is
        // for a span nobody intends to replace any more.
        if (this.#pending.get(session) !== prepared) return
        prepared.summary = result.summary
        prepared.envelope = result
        this.trace.update(session.id, prepared.compactionId, { status: 'ready', readyAt: Date.now(),
          generationMs: performance.now() - prepared.startedAt, summary: textOf(result.summary),
          provider: result.provider, model: result.model, usage: result.usage, summaryRequest: result.requestConfig })
      } catch (error) {
        if (this.#pending.get(session) === prepared) {
          this.#pending.delete(session)
          this.#parked.delete(session)
          if (!signal.aborted) this.#fallback.add(session)
          this.trace.update(session.id, prepared.compactionId, { status: signal.aborted ? 'discarded' : 'failed',
            reason: signal.aborted ? 'cancelled' : 'summary', generationMs: performance.now() - prepared.startedAt,
            ...signal.aborted ? {} : { error: traceError(error) } })
        }
        this.ctx.logger.debug?.(
          `faster-compress: background summary failed, falling back to inline compaction: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        this.#work.inFlight -= 1
      }
    })()
  }

  /**
   * Commit a prepared summary at a quiescent step boundary.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent Agent owning the session.
   * @param {object} pending A prepared summary.
   * @param {AbortSignal} signal Cancellation of the live turn.
   * @returns {Promise<import('@deepseek-ai/dsh-compaction').CompactionResult | null>} The result, or `null` when the summary was dropped.
   */
  async #commit(agent, pending, signal) {
    const operationSignal = AbortSignal.any([signal, pending.signal])
    const waitStart = performance.now()
    try {
      operationSignal.throwIfAborted()
      if (pending.summary === undefined) {
        this.trace.update(agent.session.id, pending.compactionId, { status: 'waiting', waitStartedAt: Date.now() })
        await waitForSummary(pending.settled, operationSignal)
      }
    } catch (error) {
      if (this.#pending.get(agent.session) === pending) this.#discard(agent.session)
      // A plugin unload or abandoned preparation is not cancellation of the
      // user's live turn. Let that turn use the stock synchronous transaction.
      if (signal.aborted) throw error
      return null
    } finally {
      this.trace.update(agent.session.id, pending.compactionId, { waitMs: performance.now() - waitStart })
    }
    if (this.#pending.get(agent.session) !== pending) return null
    if (pending.summary === undefined) return null

    const session = agent.session
    const measurement = this.ctx.tokenMeter.measure(session)
    if (!selectionIntact(session, pending.selection, measurement)) {
      this.#discard(session, 'stale')
      this.ctx.logger.info('faster-compress: prepared summary no longer matches its span; committing inline instead')
      return null
    }

    const checkpoint = checkpointMessage(pending.summary, pending.compactionId)
    const framed = this.ctx.tokenMeter.estimateMessage(checkpoint)
    if (framed >= pending.selection.routeTokens) {
      this.#discard(session, 'not-smaller')
      this.ctx.logger.info(
        `faster-compress: prepared summary (${framed} tokens) is not smaller than its span `
        + `(${pending.selection.routeTokens} tokens); committing inline instead`,
      )
      return null
    }

    const turn = openTurnOf(session)
    if (turn === null) {
      this.#discard(session, 'no-turn')
      return null
    }

    const envelope = pending.envelope
    this.#validateWarmup(agent, pending)
    this.#discard(session, 'committing')
    const commitStart = performance.now()
    try {
      const result = commit(session, {
      compactionId: pending.compactionId,
      selection: pending.selection,
      checkpoint,
      summary: pending.summary,
      rawOutput: envelope.rawOutput ?? pending.summary,
      provider: envelope.provider,
      model: envelope.model,
      ...envelope.maxTokens === undefined ? {} : { maxTokens: envelope.maxTokens },
      ...envelope.usage === undefined ? {} : { usage: envelope.usage },
      turn,
      })
      this.trace.update(session.id, pending.compactionId, { status: 'applied', appliedAt: Date.now(),
        outputTokens: framed, commitMs: performance.now() - commitStart })
      return result
    } catch (error) {
      this.trace.update(session.id, pending.compactionId, { status: 'failed', reason: 'commit', error: traceError(error) })
      throw error
    }
  }

  /**
   * Warm the prefix cache for the history a commit would produce.
   *
   * The first request after a commit sends a rewritten prefix that matches no
   * cached entry, so it pays for a full prefill of the summary plus the
   * retained tail. Reuse requires matching template settings and retained
   * provider cache state. A short tool can finish while this work is still
   * running; a low output cap does not make prompt ingestion cheap.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent Agent owning the session.
   * @param {object} pending A prepared summary.
   * @returns {Promise<void>}
   */
  async #warmup(agent, pending) {
    pending.warmed = true
    const start = performance.now()
    pending.warmupAbort = new AbortController()
    const signal = AbortSignal.any([pending.signal, pending.warmupAbort.signal])
    pending.warmup = { status: 'running', startedAt: Date.now() }
    const report = patch => {
      const stale = pending.warmup.status === 'stale'
      Object.assign(pending.warmup, patch, stale ? { status: 'stale' } : {})
      this.trace.update(agent.session.id, pending.compactionId, { warmup: { ...pending.warmup } })
    }
    try {
      signal.throwIfAborted()
      const config = agent.session.requestHeader()?.config
      if (config === undefined || config.provider.length === 0 || config.model.length === 0) return
      const prefix = postCommitPrefix(agent.session, pending.selection, checkpointMessage(pending.summary, pending.compactionId))
      const request = {
        ...requestRoute(config),
        messages: prefix.messages,
        ...prefix.tools === undefined ? {} : { tools: [...prefix.tools] },
        toolHistory: agent.session.toolHistory(),
        maxTokens: this.eager.warmupMaxTokens,
        sessionId: agent.session.id,
        signal,
      }
      report({ request: requestRoute(request), prefixFingerprint: prefixFingerprint(request), messageCount: request.messages.length })
      for await (const chunk of this.ctx.llm.stream(request)) {
        signal.throwIfAborted()
        if (chunk.type === 'usage') report({ usage: { ...pending.warmup.usage, ...usageSnapshot(chunk.usage) } })
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? 'Warm-up request failed')
        if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') {
          report({ status: 'cancelled', durationMs: performance.now() - start })
          return
        }
      }
      if (!signal.aborted) this.#validateWarmup(agent, pending)
      report({ status: signal.aborted ? 'cancelled' : 'completed', durationMs: performance.now() - start })
    } catch (error) {
      report({ status: signal.aborted ? 'cancelled' : 'failed', durationMs: performance.now() - start,
        ...signal.aborted ? {} : { error: traceError(error) } })
      // A failed warm-up only means the first request after the commit pays
      // its own prefill, which is the behaviour with warm-up disabled.
    }
  }

  #validateWarmup(agent, pending) {
    const warmup = pending.warmup
    if (!warmup?.prefixFingerprint || !['running', 'completed'].includes(warmup.status)) return
    const prefix = postCommitPrefix(agent.session, pending.selection, checkpointMessage(pending.summary, pending.compactionId))
    const current = { ...requestRoute(agent.session.requestHeader()?.config ?? {}), ...prefix }
    if (prefixFingerprint(current, warmup.messageCount) === warmup.prefixFingerprint) return
    warmup.status = 'stale'
    pending.warmupAbort.abort()
    this.trace.update(agent.session.id, pending.compactionId, { warmup: { ...warmup } })
  }

  #releaseTurn(session) {
    this.#turns.get(session)?.()
    this.#turns.delete(session)
  }

  #bindTurn(session, signal) {
    this.#releaseTurn(session)
    const cancel = () => {
      this.#discard(session, 'cancelled')
      this.#idle.add(session)
    }
    signal.addEventListener('abort', cancel, { once: true })
    this.#turns.set(session, () => signal.removeEventListener('abort', cancel))
  }

  #park(session) {
    this.#admission.set(session, (this.#admission.get(session) ?? 0) + 1)
    this.#idle.add(session)
    this.#releaseTurn(session)
    const pending = this.#pending.get(session)
    if (!pending) return
    // An optional warm-up is tied to the current tail, unlike the summary.
    pending.warmupAbort?.abort()
    this.#parked.delete(session)
    this.#parked.set(session, pending)
    while (this.#parked.size > 24) this.#discard(this.#parked.keys().next().value, 'retention-limit')
  }

  /**
   * Drop a prepared summary.
   *
   * @param {import('@deepseek-ai/dsh-session').Session} session Session whose summary is obsolete.
   * @returns {void}
   */
  #discard(session, reason = 'cancelled') {
    this.#admission.set(session, (this.#admission.get(session) ?? 0) + 1)
    this.#parked.delete(session)
    const pending = this.#pending.get(session)
    this.#pending.delete(session)
    if (pending && reason !== 'committing') this.trace.update(session.id, pending.compactionId, {
      status: 'discarded', reason, endedAt: Date.now(),
    })
    pending?.abort.abort()
  }
}

export default FasterCompactionEngine
