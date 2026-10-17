/** DSH usage separates uncached input from cache reads/writes. Never infer
 * missing usage from character estimates or treat an absent count as zero. */
const count = value => Number.isFinite(value) && value >= 0

export function actualInputTokens(usage) {
  if (!usage) return undefined
  if (count(usage.inputTokens)) {
    if ([usage.cacheReadTokens, usage.cacheWriteTokens].some(value => value != null && !count(value))) return undefined
    return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  }
  if (count(usage.totalTokens) && count(usage.outputTokens) && usage.totalTokens >= usage.outputTokens) {
    return usage.totalTokens - usage.outputTokens
  }
  return undefined
}

export function actualUsage(usage) {
  return {
    inputTokens: actualInputTokens(usage),
    outputTokens: count(usage?.outputTokens) ? usage.outputTokens : undefined,
    cacheReadTokens: count(usage?.cacheReadTokens) ? usage.cacheReadTokens : undefined,
  }
}

/** Reconstruct adjacent main-request measurements from native events, including
 * old records. Summary requests are not assistant/message events. A missing
 * first response usage stays unknown instead of borrowing a later tool step. */
export function projectContextUsage(events, records) {
  const starts = new Map(), checkpoints = new Map(), pending = new Map()
  for (const record of records.values()) {
    record.summaryUsage = actualUsage(record.usage)
    record.contextUsage = { afterStatus: record.checkpointSeq == null ? 'not-applied' : 'pending' }
    if (record.startSeq != null) starts.set(record.startSeq, record)
    if (record.checkpointSeq != null) checkpoints.set(record.checkpointSeq, record)
  }
  let previous
  const surface = []
  for (const event of events) {
    const record = starts.get(event.seq)
    if (record) record.contextUsage.before = previous
    if (event.surfaceOp === 'append') surface.push(event.seq)
    else if (event.surfaceOp?.op === 'replace') {
      const start = surface.indexOf(event.surfaceOp.startSeq), end = surface.indexOf(event.surfaceOp.endSeq)
      if (start >= 0 && end >= start) surface.splice(start, end - start + 1, event.seq)
      for (const [seq, waiting] of pending) if (!surface.includes(seq)) {
        waiting.contextUsage.afterStatus = 'unavailable'
        pending.delete(seq)
      }
      const applied = checkpoints.get(event.seq)
      if (applied) pending.set(event.seq, applied)
    }
    if (event.type === 'assistant/message') {
      const inputTokens = actualInputTokens(event.data?.usage)
      previous = { seq: event.seq, at: event.time, inputTokens }
      for (const waiting of pending.values()) {
        waiting.contextUsage.after = previous
        waiting.contextUsage.afterStatus = inputTokens == null ? 'unavailable' : 'measured'
      }
      pending.clear()
    }
  }
  // Usage may arrive on the verified live stream before its durable message.
  for (const record of pending.values()) {
    if (!record.response?.verified) continue
    const attempt = record.response.attempts?.find(item =>
      ['streaming', 'completed', 'no-output'].includes(item.status))
    const inputTokens = actualInputTokens(attempt?.usage)
    if (inputTokens != null) {
      record.contextUsage.after = { at: attempt.startedAt, inputTokens, source: 'verified-stream' }
      record.contextUsage.afterStatus = 'measured'
    }
  }
}
