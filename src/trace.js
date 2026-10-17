import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import contract from './trace-contract.cjs'

export const TRACE_LIMIT = 80
const TEXT_LIMIT = 24000
const SOURCE_LIMIT = 12000
const ACTIVE = new Set(['preparing', 'ready', 'waiting'])
const RESPONSE_ACTIVE = new Set(['awaiting-application', 'awaiting-request', 'streaming', 'retrying'])
const STATUSES = new Set([...ACTIVE, 'applied', 'superseded', 'discarded', 'failed', 'unapplied'])

function validRecord(record) {
  if (!record || typeof record.id !== 'string' || !record.id || !STATUSES.has(record.status)
    || !Number.isFinite(record.startedAt)) return false
  for (const key of ['summary', 'original', 'error', 'model', 'provider', 'reason']) {
    if (record[key] != null && typeof record[key] !== 'string') return false
  }
  for (const key of ['generationMs', 'waitMs', 'commitMs', 'inputTokens', 'outputTokens', 'nodeCount']) {
    if (record[key] != null && (!Number.isFinite(record[key]) || record[key] < 0)) return false
  }
  if (record.range != null && (!Number.isFinite(record.range.start) || !Number.isFinite(record.range.end))) return false
  if (record.warmup != null && (!['running', 'completed', 'failed', 'cancelled', 'stale'].includes(record.warmup.status)
    || record.warmup.error != null && typeof record.warmup.error !== 'string')) return false
  if (record.response != null) {
    const response = record.response
    if (typeof response !== 'object' || typeof response.status !== 'string' || !Array.isArray(response.attempts)
      || response.attempts.length > 8) return false
    for (const key of ['ttftMs', 'afterApplyMs', 'blockingMs', 'firstTextMs', 'firstReasoningMs', 'firstToolMs']) {
      if (response[key] != null && (!Number.isFinite(response[key]) || response[key] < 0)) return false
    }
    if (!response.attempts.every(attempt => attempt && typeof attempt.status === 'string'
      && (attempt.error == null || typeof attempt.error === 'string'))) return false
  }
  return true
}

export function textOf(content) {
  return (Array.isArray(content) ? content : []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

export function traceError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:Bearer\s+|sk-)[a-zA-Z0-9_.\-/+=]+/gi, '[redacted]')
    .replace(/((?:api[_-]?key|token|authorization|password)\s*[=:]\s*)[^\s&,;]+/gi, '$1[redacted]')
    .slice(0, 2000)
}

function clipped(text, limit) {
  const value = typeof text === 'string' ? text : ''
  return { text: value.slice(0, limit), truncated: value.length > limit }
}

/** Best-effort sidecar journal: diagnostic I/O must never gate model work. */
export class TraceJournal {
  constructor({ directory = dshHomePath('data', 'faster-compress', 'traces'), clock = Date.now } = {}) {
    this.directory = directory
    this.clock = clock
    this.generation = randomUUID()
    this.sessions = new Map()
    this.writes = new Map()
    this.warning = null
  }

  file(id) { return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`) }

  cell(id) {
    let cell = this.sessions.get(id)
    if (!cell) {
      cell = { records: [], loaded: false, loading: null, revision: 0 }
      this.sessions.set(id, cell)
    }
    return cell
  }

  async load(id) {
    const cell = this.cell(id)
    if (cell.loaded) return cell
    if (cell.loading) return cell.loading
    cell.loading = (async () => {
      try {
        if (this.directory === null) { cell.loaded = true; return cell }
        const path = this.file(id)
        if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('Trace file exceeds size limit')
        const saved = JSON.parse(await readFile(path, 'utf8'))
        if (saved.version !== 1 || saved.sessionId !== id || !Array.isArray(saved.records)) throw new Error('Unsupported trace file')
        if (!saved.records.every(validRecord)) throw new Error('Invalid trace record')
        const current = new Set(cell.records.map(record => record.id))
        const restored = saved.records.filter(record => !current.has(record.id)).slice(-TRACE_LIMIT)
          .map(record => {
            if (record.generation === this.generation) return record
            return { ...record,
              ...(ACTIVE.has(record.status) ? { status: 'discarded', reason: 'restart', recovered: true } : {}),
              ...(RESPONSE_ACTIVE.has(record.response?.status) ? {
                response: { ...record.response, status: 'interrupted' },
              } : {}),
              ...(record.warmup?.status === 'running' ? { warmup: { ...record.warmup, status: 'cancelled' } } : {}),
            }
          })
        cell.records = [...restored, ...cell.records].slice(-TRACE_LIMIT)
      } catch (error) {
        if (error.code !== 'ENOENT') this.warning = traceError(error)
      }
      cell.loaded = true
      return cell
    })()
    return cell.loading
  }

  begin(sessionId, record) {
    const cell = this.cell(sessionId)
    const original = clipped(record.original, SOURCE_LIMIT)
    cell.records.push({ ...record, original: original.text, originalTruncated: original.truncated,
      generation: this.generation, startedAt: this.clock(), updatedAt: this.clock(), status: 'preparing' })
    cell.records = cell.records.slice(-TRACE_LIMIT)
    this.save(sessionId)
  }

  update(sessionId, id, patch) {
    const cell = this.cell(sessionId)
    const index = cell.records.findIndex(record => record.id === id)
    if (index < 0) return
    const next = { ...patch }
    if (typeof next.summary === 'string') {
      const value = clipped(next.summary, TEXT_LIMIT)
      next.summary = value.text
      next.summaryTruncated = value.truncated
    }
    cell.records[index] = { ...cell.records[index], ...next, updatedAt: this.clock() }
    this.save(sessionId)
  }

  save(sessionId) {
    if (this.directory === null) return
    const cell = this.cell(sessionId)
    cell.revision += 1
    if (this.writes.has(sessionId)) return
    const task = (async () => {
      await this.load(sessionId)
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      let written
      do {
        written = cell.revision
        const path = this.file(sessionId)
        const temp = `${path}.${this.generation}.tmp`
        try {
          await writeFile(temp, JSON.stringify({ version: 1, sessionId, records: cell.records }), { mode: 0o600 })
          await rename(temp, path)
        } finally { await unlink(temp).catch(() => {}) }
      } while (written !== cell.revision)
    })().catch(error => { this.warning = traceError(error) }).finally(() => {
      this.writes.delete(sessionId)
      // Bound resident history; active work is never evicted.
      this.evict()
    })
    this.writes.set(sessionId, task)
  }

  evict() {
    if (this.sessions.size > 24) for (const [id, entry] of this.sessions) {
      if (!this.writes.has(id) && entry.loaded && !entry.records.some(record => ACTIVE.has(record.status) || RESPONSE_ACTIVE.has(record.response?.status))) {
        this.sessions.delete(id)
        if (this.sessions.size <= 24) break
      }
    }
  }

  async read(id) {
    const records = (await this.load(id)).records.map(record => ({ ...record }))
    this.evict()
    return records
  }
  async flush() { await Promise.all(this.writes.values()) }
}

/** Native committed history wins over diagnostics, including after restart or eviction. */
export function projectTrace(events, telemetry = []) {
  const records = new Map(telemetry.map(record => [record.id, { ...record, mode: record.mode ?? 'background' }]))
  const nodes = []
  const bySeq = new Map()
  for (const event of events) {
    bySeq.set(event.seq, event)
    if (event.surfaceOp === 'append') nodes.push(event.seq)
    else if (event.surfaceOp?.op === 'replace') {
      const start = nodes.indexOf(event.surfaceOp.startSeq), end = nodes.indexOf(event.surfaceOp.endSeq)
      if (start >= 0 && end >= start) nodes.splice(start, end - start + 1, event.seq)
    }
    const data = event.data ?? {}
    const id = data.compactionId
    if (typeof id !== 'string' || !event.type.startsWith('compaction/')) continue
    let record = records.get(id)
    if (!record) {
      record = { id, mode: 'native', startedAt: event.time, status: 'preparing' }
      records.set(id, record)
    }
    if (event.type === 'compaction/start') {
      record.commitStartedAt = event.time
      record.startSeq = event.seq
    } else if (event.type === 'compaction/summary') {
      const summary = clipped(textOf(data.summary), TEXT_LIMIT)
      Object.assign(record, { summary: summary.text, summaryTruncated: summary.truncated, summarySeq: event.seq,
        range: data.shadowedRange, nodeCount: data.shadowedSeqs?.length, inputTokens: data.shadowedTokenCount,
        provider: data.provider, model: data.model, usage: data.usage })
      if (!record.original && data.shadowedSeqs) {
        const original = clipped(data.shadowedSeqs.map(seq => {
          const source = bySeq.get(seq)?.data
          return textOf(source?.content ?? source?.message?.content)
        }).filter(Boolean).join('\n\n'), SOURCE_LIMIT)
        record.original = original.text
        record.originalTruncated = original.truncated
      }
    } else if (event.type === 'compaction/end') {
      record.endedAt = event.time
      record.commitMs = record.commitStartedAt == null ? null : Math.max(0, event.time - record.commitStartedAt)
      record.error = data.error ? traceError(data.error) : record.error
      record.status = data.error ? 'failed' : 'unapplied'
    }
  }
  const active = new Set(nodes)
  for (const event of events) {
    if (event.surfaceOp?.op !== 'replace') continue
    for (const seq of event.sourceEventSeqs ?? []) {
      const source = bySeq.get(seq)
      if (source?.type !== 'compaction/summary') continue
      const record = records.get(source.data.compactionId)
      if (!record) continue
      record.checkpointSeq = event.seq
      record.appliedAt = event.time
      record.status = active.has(event.seq) ? 'applied' : 'superseded'
      if (!record.error) delete record.reason
    }
  }
  const result = [...records.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
  return { records: result.slice(0, TRACE_LIMIT), total: result.length, limit: TRACE_LIMIT }
}

export class TraceService extends TypertRemoteService {
  constructor(ctx, { journal, integration = () => undefined }) {
    super(ctx, 'fasterCompressTrace')
    this.journal = journal
    this.integration = integration
    ctx.typert.register({ package: 'dsh-faster-compress', face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] }, invocations: [contract.traceDescriptor] })
  }

  async read(sessionId, signal) {
    signal.throwIfAborted()
    // The existing query capability resolves live and archived sessions and validates replay.
    const observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
    try {
      const records = await this.journal.read(sessionId)
      signal.throwIfAborted()
      return { ...projectTrace(observation.events, records), storageWarning: this.journal.warning, integration: this.integration(sessionId), sampledAt: Date.now() }
    } finally { observation[Symbol.dispose]() }
  }
}
