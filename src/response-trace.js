import { isAgentLoopRequest, isTokenDelta } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { traceError } from './trace.js'
import { openTurnOf } from './selection.js'
import { prefixFingerprint, requestRoute, usageSnapshot } from './request-policy.js'

const MAX_ATTEMPTS = 8
const elapsed = (end, start) => start == null ? undefined : Math.max(0, end - start)

/** Observe the frozen DSH main-request boundary; never change or buffer its stream. */
export class ResponseTracker {
  constructor({ journal, now = () => performance.now(), wall = Date.now }) {
    this.journal = journal
    this.now = now
    this.wall = wall
    this.sessions = new Map()
    this.stopped = false
  }

  // Diagnostics cannot become a failure in the model path.
  safe(action) {
    try { return action() }
    catch (error) { this.journal().warning = traceError(error) }
  }

  attach(ctx) {
    ctx.on('session/event', (session, event) => this.safe(() => this.event(session, event)))
    ctx.on('agent/disposed', ({ agent }) => this.safe(() => this.closeSession(agent.session.id, 'interrupted')))
    ctx.on('llm/stream', (options, next) => this.stream(options, next))
  }

  state(session) {
    let state = this.sessions.get(session.id)
    if (state && state.session !== session) { this.closeSession(session.id, 'interrupted'); state = null }
    if (!state) {
      if (this.sessions.size >= 128) this.closeSession(this.sessions.keys().next().value, 'interrupted')
      state = { session, entries: new Map(), blocking: null }
      this.sessions.set(session.id, state)
    }
    return state
  }

  beginBlocking(session, trigger) {
    this.safe(() => {
      if (this.stopped) return
      this.state(session).blocking ??= { mono: this.now(), time: this.wall(), trigger }
    })
  }

  endBlocking(session) {
    const state = this.sessions.get(session.id)
    if (!state) return
    state.blocking = null
    this.prune(state)
  }

  persist(entry) {
    this.journal().update(entry.sessionId, entry.id, { response: structuredClone(entry.response) })
  }

  close(state, entry, status) {
    if (entry.closed) return
    entry.closed = true
    entry.response.status = status
    this.persist(entry)
    state.entries.delete(entry.id)
    this.prune(state)
  }

  prune(state) {
    if (!state.entries.size && !state.blocking && this.sessions.get(state.session.id) === state) this.sessions.delete(state.session.id)
  }

  closeSession(id, status) {
    const state = this.sessions.get(id)
    if (!state) return
    for (const entry of [...state.entries.values()]) this.close(state, entry, status)
    this.sessions.delete(id)
  }

  dispose() {
    this.stopped = true
    for (const id of [...this.sessions.keys()]) this.safe(() => this.closeSession(id, 'interrupted'))
  }

  event(session, event) {
    if (this.stopped) return
    const data = event.data ?? {}
    if (event.type === 'compaction/start') {
      const state = this.state(session)
      const journal = this.journal()
      if (!journal.cell(session.id).records.some(record => record.id === data.compactionId)) {
        journal.begin(session.id, { id: data.compactionId, mode: 'native' })
      }
      const blocking = state.blocking ?? (data.turn == null ? null : { mono: this.now(), time: this.wall(), trigger: 'native' })
      const entry = { id: data.compactionId, sessionId: session.id, turn: data.turn, blocking,
        response: { status: 'awaiting-application', boundary: 'dsh-main-request',
          trigger: blocking?.trigger ?? 'manual', blockingStartedAt: blocking?.time,
          requestCount: 0, attempts: [] } }
      state.entries.set(entry.id, entry)
      if (state.entries.size > 80) this.close(state, state.entries.values().next().value, 'interrupted')
      this.persist(entry)
      return
    }
    const state = this.sessions.get(session.id)
    if (!state) return
    if (event.surfaceOp?.op === 'replace') {
      const source = data.source
      const entry = source && isCompactCheckpointSource(source) ? state.entries.get(source.compactionId) : null
      if (entry) {
        entry.checkpointSeq = event.seq
        entry.messageId = data.id
        entry.appliedMono = this.now()
        entry.response.appliedAt = this.wall()
        entry.response.status = 'awaiting-request'
        this.persist(entry)
      }
      for (const previous of [...state.entries.values()]) {
        if (previous !== entry && previous.checkpointSeq != null && !session.surface.nodes.includes(previous.checkpointSeq)) {
          this.close(state, previous, 'superseded')
        }
      }
    } else if (event.type === 'compaction/end') {
      const entry = state.entries.get(data.compactionId)
      if (!entry) return
      // Native-only records must also leave the journal's active preparation state.
      this.journal().update(session.id, entry.id, { status: entry.checkpointSeq != null ? 'applied' : data.error ? 'failed' : 'unapplied' })
      if (entry.checkpointSeq == null) this.close(state, entry, 'not-applied')
    } else if (event.type === 'turn/end') {
      for (const entry of [...state.entries.values()]) {
        if (entry.turn === data.turn) this.close(state, entry,
          entry.response.status === 'retrying' ? 'failed' : entry.response.status === 'cancelled' ? 'cancelled' : 'ended')
      }
    }
  }

  startRequest(options) {
    const state = this.sessions.get(options.sessionId)
    if (!state || this.stopped) return []
    const requests = []
    const mono = this.now(), time = this.wall()
    for (const entry of [...state.entries.values()]) {
      if (entry.checkpointSeq == null || entry.inRequest) continue
      if (!state.session.surface.nodes.includes(entry.checkpointSeq)) { this.close(state, entry, 'superseded'); continue }
      const included = options.messages.some(message => message.role === 'user'
        && message.id === entry.messageId && message.source && isCompactCheckpointSource(message.source)
        && message.source.compactionId === entry.id)
      if (!included) { this.close(state, entry, 'missing-checkpoint'); continue }
      entry.turn ??= openTurnOf(state.session)
      entry.inRequest = true
      entry.response.status = 'streaming'
      entry.response.verified = true
      entry.response.verifiedAt ??= time
      const warmup = this.journal().cell(options.sessionId).records.find(record => record.id === entry.id)?.warmup
      if (warmup?.prefixFingerprint && Number.isInteger(warmup.messageCount) && warmup.messageCount > 0) {
        entry.response.warmupPrefix = warmup.status === 'stale'
          || prefixFingerprint(options, warmup.messageCount) !== warmup.prefixFingerprint ? 'mismatch'
          : warmup.status === 'completed' ? 'matched' : 'not-ready'
      }
      const attempt = { number: ++entry.response.requestCount, startedAt: time,
        ...requestRoute(options), status: 'streaming' }
      entry.response.attempts.push(attempt)
      entry.response.attempts = entry.response.attempts.slice(-MAX_ATTEMPTS)
      this.persist(entry)
      requests.push({ state, entry, attempt, mono, finish: null })
    }
    return requests
  }

  chunk(request, chunk) {
    const { entry, attempt, mono } = request
    if (entry.closed || this.stopped) return
    if (chunk.type === 'usage') {
      attempt.usage = { ...attempt.usage, ...usageSnapshot(chunk.usage) }
      this.persist(entry)
      return
    }
    if (chunk.type === 'finish') { request.finish = chunk.reason; return }
    const token = isTokenDelta(chunk)
    const kind = chunk.type === 'reasoning-delta' ? 'reasoning' : chunk.type === 'tool-call-delta' ? 'tool' : 'text'
    if (!token) return
    const current = this.now(), time = this.wall()
    let changed = false
    if (attempt.ttftMs == null) {
      attempt.ttftMs = elapsed(current, mono)
      attempt.firstTokenAt = time
      attempt.firstKind = kind
      changed = true
    }
    if (entry.response.firstTokenAt == null) {
      Object.assign(entry.response, { firstTokenAt: time, firstKind: kind, firstAttempt: attempt.number,
        ttftMs: attempt.ttftMs, afterApplyMs: elapsed(current, entry.appliedMono),
        blockingMs: elapsed(current, entry.blocking?.mono) })
      changed = true
    }
    const field = kind === 'reasoning' ? 'firstReasoning' : kind === 'text' ? 'firstText' : 'firstTool'
    if ((kind === 'tool' || chunk.text.trim()) && entry.response[`${field}At`] == null) {
      entry.response[`${field}At`] = time
      entry.response[`${field}Ms`] = elapsed(current, entry.appliedMono)
      changed = true
    }
    if (changed) this.persist(entry)
  }

  settle(request, options, thrown, completed) {
    const { entry, attempt, state } = request
    if (entry.closed || this.stopped) return
    const cancelled = options.signal?.aborted || request.finish?.kind === 'aborted'
    const failed = thrown != null || request.finish?.kind === 'error'
    attempt.status = cancelled ? 'cancelled' : failed ? 'failed' : !completed ? 'interrupted'
      : attempt.firstTokenAt == null ? 'no-output' : 'completed'
    attempt.endedAt = this.wall()
    const error = thrown ?? request.finish?.failure?.message
    if (error != null) attempt.error = traceError(error)
    entry.inRequest = false
    if (failed && !cancelled) {
      entry.response.status = 'retrying'
      this.persist(entry)
    } else this.close(state, entry, attempt.status)
  }

  stream(options, next) {
    if (this.stopped || !isAgentLoopRequest(options) || !this.sessions.has(options.sessionId)) return next()
    const tracker = this
    return (async function* () {
      const requests = tracker.safe(() => tracker.startRequest(options)) ?? []
      let thrown, completed = false
      try {
        for await (const chunk of next()) {
          for (const request of requests) tracker.safe(() => tracker.chunk(request, chunk))
          yield chunk
        }
        completed = true
      } catch (error) { thrown = error; throw error }
      finally {
        for (const request of requests) tracker.safe(() => tracker.settle(request, options, thrown, completed))
      }
    })()
  }
}
