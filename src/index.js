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
 *   - once pressure passes an eager threshold, the summary is generated in the
 *     background while the turn keeps running;
 *   - the replacement is committed at a step boundary, where the surface is
 *     quiescent, so an in-flight request is never left behind a rewritten
 *     prefix;
 *   - optionally, the rewritten request prefix is warmed while a tool runs, so
 *     the first request after a commit does not pay for a cold prefill.
 *
 * Committing at the threshold rather than as soon as a summary exists is
 * deliberate. A committed compaction replaces the conversation prefix, which
 * invalidates the provider's cached prefix for every later request; committing
 * early therefore spends a full-price prefill that the still-valid cached
 * prefix would have avoided.
 *
 * @module dsh-faster-compress
 */

import { randomUUID } from 'node:crypto'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { budgets, policyFor } from './budgets.js'
import { openTurnOf, selectRange, selectionIntact } from './selection.js'
import { checkpointMessage, postCommitPrefix, summarizationInput } from './checkpoint.js'
import { commit } from './transaction.js'

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

  /** Fraction of the commit threshold at which a summary is generated ahead of time. Below 1. */
  // Serializable open-interval bounds: the settings client rehydrates schemas
  // and cannot execute a server-only transform callback.
  eagerRatio: z.number().min(Number.MIN_VALUE).max(1 - Number.EPSILON / 2).default(0.85).volatile(),
  /** Warm the rewritten request prefix while a tool runs, so committing costs no cold prefill. */
  warmup: z.boolean().default(true).volatile(),
  /** Generation cap of the warm-up request; it exists to populate the prefix cache, not to answer. */
  warmupMaxTokens: warmupTokens.default(1).volatile(),
  /** Summaries generated concurrently across all sessions of this host. */
  maxConcurrent: z.number().step(1).min(1).default(1).volatile(),
})

/** Defaults for the added fields. */
const DEFAULTS = Object.freeze({
  eagerRatio: 0.85,
  warmup: true,
  warmupMaxTokens: 1,
  maxConcurrent: 1,
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
 * A basic compaction backend that generates summaries ahead of the threshold
 * and commits them at the step boundary.
 */
export class FasterCompactionEngine extends BasicCompactionEngine {
  /** Row configuration schema, extending the inherited backend's fields. */
  static Config = configSchema

  /** Prepared summary that has not been committed yet. */
  #pending = new WeakMap()
  /** Summaries currently being generated, for the concurrency cap. */
  #inFlight = 0
  /** Agents seen since load, keyed by session id, to reach a session's owner. */
  #agents = new Map()
  /** Adapter metadata per routed target; it does not change within a process. */
  #capacity = new Map()
  /** Cancellation for background work, independent of any single turn. */
  #abort = new AbortController()
  /** Loader-owned live settings; reads never remount the compaction service. */
  #eagerConfig

  get eager() {
    return Object.freeze(Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => {
      const value = this.#eagerConfig[key]
      return [key, (isVolatile(value) ? value.get() : value) ?? fallback]
    })))
  }

  constructor(ctx, config = {}) {
    const { eagerRatio: configuredRatio, warmup, warmupMaxTokens, maxConcurrent, ...basicConfig } = config
    super(ctx, basicConfig)
    this.#eagerConfig = { eagerRatio: configuredRatio, warmup, warmupMaxTokens, maxConcurrent }
    const { eagerRatio } = this.eager
    if (!(eagerRatio > 0 && eagerRatio < 1)) {
      throw new Error(`dsh-faster-compress: eagerRatio (${eagerRatio}) must be greater than 0 and less than 1`)
    }
    ctx.effect(() => () => this.#abort.abort())
    if (this.config.auto) this.#registerTriggers()
  }

  /**
   * Prepare below the pressure threshold; at the threshold, wait cancellably
   * for a pending summary and enforce the inherited retry budget.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent Agent whose latest routed request is measured.
   * @param {'pressure' | 'context-overflow'} trigger Normal step pressure or provider-confirmed overflow.
   * @param {AbortSignal} signal Cancellation of the live turn.
   * @returns {Promise<import('@deepseek-ai/dsh-compaction').CompactionResult | null>} The committed compaction, if any.
   */
  async compactIfNeeded(agent, trigger, signal) {
    signal.throwIfAborted()
    // Overflow recovery is a repair, not a scheduled compaction: it forces a
    // reduction below the normal thresholds and must run inline.
    if (trigger === 'context-overflow') {
      this.#discard(agent.session)
      return super.compactIfNeeded(agent, trigger, signal)
    }

    const budget = await this.#budget(agent, signal)
    signal.throwIfAborted()
    // Without a resolvable capacity the inherited path reports the
    // configuration error, which is the diagnosis the operator needs.
    if (budget === null) return super.compactIfNeeded(agent, trigger, signal)

    const session = agent.session
    const total = this.ctx.tokenMeter.measure(session).totalTokens
    if (total < budget.eagerTokens) return null

    if (total < budget.thresholdTokens) {
      this.#start(agent, budget, signal)
      return null
    }

    const pending = this.#pending.get(session)
    if (pending === undefined) return super.compactIfNeeded(agent, trigger, signal)

    const committed = await this.#commit(agent, pending, signal)
    if (committed !== null) {
      this.ctx.logger.info(
        `faster-compress: committed a pre-generated summary shadowing ${committed.shadowedSeqs.length} `
        + `surface nodes (seqs ${committed.shadowedRange.start}-${committed.shadowedRange.end}, `
        + `~${committed.shadowedTokenCount} tokens)`,
      )
      // A large result may have arrived after selection. Count the prepared
      // commit as the first attempt, then use the stock transaction for retries.
      const policy = policyFor(this.config, session.requestHeader().config)
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
    return super.compactIfNeeded(agent, trigger, signal)
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
    if (agent === undefined) return
    const pending = this.#pending.get(session)
    if (pending !== undefined) {
      if (this.eager.warmup && pending.summary !== undefined && !pending.warmed) void this.#warmup(agent, pending)
      return
    }
    void this.#tryStart(agent).catch(error => {
      this.ctx.logger.debug?.(`faster-compress: background preparation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Register the listeners this bundle adds to the inherited ones. */
  #registerTriggers() {
    const { ctx } = this
    ctx.on('agent/created', ({ agent }) => this.#agents.set(agent.session.id, agent))
    ctx.on('agent/disposed', ({ agent }) => {
      this.#discard(agent.session)
      this.#agents.delete(agent.session.id)
    })
    // A turn that ended without reaching the threshold leaves a summary nobody
    // will commit; the next turn re-measures and regenerates if still eager.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.#discard(agent.session)
    })
    ctx.on('session/event', (session, event) => {
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
    const budget = await this.#budget(agent)
    if (budget === null) return
    const total = this.ctx.tokenMeter.measure(agent.session).totalTokens
    if (total >= budget.eagerTokens) this.#start(agent, budget)
  }

  /**
   * Resolve the pressure budgets for the routed conversation target.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent Agent whose route defines the budgets.
   * @returns {Promise<import('./budget.js').Budget | null>} Budgets, or `null` when capacity is unknown.
   */
  async #budget(agent, signal = this.#abort.signal) {
    const config = agent.session.requestHeader()?.config
    if (config === undefined || config.provider.length === 0 || config.model.length === 0) return null
    const target = { provider: config.provider, model: config.model }
    const key = `${target.provider}/${target.model}`
    let info = this.#capacity.get(key)
    if (info === undefined) {
      info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
      this.#capacity.set(key, info)
    }
    if (info.context?.contextWindow === undefined) return null
    const policy = policyFor({ ...this.config, eagerRatio: this.eager.eagerRatio }, target)
    const reserved = config.maxTokens ?? info.defaultMaxTokens ?? 0
    return budgets(policy, info.context.contextWindow, reserved)
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
    if (this.#abort.signal.aborted || turnSignal?.aborted || this.#pending.has(session) || this.#inFlight >= this.eager.maxConcurrent) return

    const selection = selectRange(session, this.ctx.tokenMeter.measure(session), budget.retainTokens)
    if (selection === null) return

    const abort = new AbortController()
    const signal = AbortSignal.any([this.#abort.signal, abort.signal, ...(turnSignal === undefined ? [] : [turnSignal])])
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
    }
    this.#pending.set(session, prepared)
    this.#inFlight += 1
    prepared.settled = (async () => {
      try {
        const result = await this.summarize(input, agent, signal)
        // Discarded while generating: the surface moved on, so the summary is
        // for a span nobody intends to replace any more.
        if (this.#pending.get(session) !== prepared) return
        prepared.summary = result.summary
        prepared.envelope = result
      } catch (error) {
        if (this.#pending.get(session) === prepared) this.#pending.delete(session)
        this.ctx.logger.debug?.(
          `faster-compress: background summary failed, falling back to inline compaction: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        this.#inFlight -= 1
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
    try {
      operationSignal.throwIfAborted()
      if (pending.summary === undefined) await waitForSummary(pending.settled, operationSignal)
    } catch (error) {
      if (this.#pending.get(agent.session) === pending) this.#discard(agent.session)
      throw error
    }
    if (this.#pending.get(agent.session) !== pending) return null
    if (pending.summary === undefined) return null

    const session = agent.session
    const measurement = this.ctx.tokenMeter.measure(session)
    if (!selectionIntact(session, pending.selection, measurement)) {
      this.#discard(session)
      this.ctx.logger.info('faster-compress: prepared summary no longer matches its span; committing inline instead')
      return null
    }

    const checkpoint = checkpointMessage(pending.summary, pending.compactionId)
    const framed = this.ctx.tokenMeter.estimateMessage(checkpoint)
    if (framed >= pending.selection.routeTokens) {
      this.#discard(session)
      this.ctx.logger.info(
        `faster-compress: prepared summary (${framed} tokens) is not smaller than its span `
        + `(${pending.selection.routeTokens} tokens); committing inline instead`,
      )
      return null
    }

    const turn = openTurnOf(session)
    if (turn === null) {
      this.#discard(session)
      return null
    }

    const envelope = pending.envelope
    this.#discard(session)
    return commit(session, {
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
  }

  /**
   * Warm the prefix cache for the history a commit would produce.
   *
   * The first request after a commit sends a rewritten prefix that matches no
   * cached entry, so it pays for a full prefill of the summary plus the
   * retained tail. Sending that same prefix with a minimal cap while a tool
   * occupies the turn moves the prefill to a moment nobody is waiting on; the
   * work is not additional, only earlier.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent Agent owning the session.
   * @param {object} pending A prepared summary.
   * @returns {Promise<void>}
   */
  async #warmup(agent, pending) {
    pending.warmed = true
    try {
      pending.signal.throwIfAborted()
      const config = agent.session.requestHeader()?.config
      if (config === undefined || config.provider.length === 0 || config.model.length === 0) return
      const prefix = postCommitPrefix(agent.session, pending.selection, checkpointMessage(pending.summary, pending.compactionId))
      for await (const chunk of this.ctx.llm.stream({
        provider: config.provider,
        model: config.model,
        messages: prefix.messages,
        ...prefix.tools === undefined ? {} : { tools: [...prefix.tools] },
        toolHistory: agent.session.toolHistory(),
        maxTokens: this.eager.warmupMaxTokens,
        sessionId: agent.session.id,
        signal: pending.signal,
      })) {
        // Consuming the stream drives the request; generated output is unused.
      }
    } catch {
      // A failed warm-up only means the first request after the commit pays
      // its own prefill, which is the behaviour with warm-up disabled.
    }
  }

  /**
   * Drop a prepared summary.
   *
   * @param {import('@deepseek-ai/dsh-session').Session} session Session whose summary is obsolete.
   * @returns {void}
   */
  #discard(session) {
    const pending = this.#pending.get(session)
    this.#pending.delete(session)
    pending?.abort.abort()
  }
}

export default FasterCompactionEngine
