/**
 * The durable commit for one prepared compaction.
 *
 * A commit appends the same four-event transaction the shipped backend uses:
 * an opening bracket that is also the compaction lock, the summary record with
 * its shadow price, the surface replacement, and the closing bracket. Keeping
 * the durable shape identical means the compaction invariant, replay, pricing,
 * and crash recovery all behave exactly as they do without this bundle.
 *
 * @module dsh-faster-compress/transaction
 */

/**
 * @typedef {object} CommitInput
 * @property {number} compactionId Identity shared by this transaction's events.
 * @property {import('./budget.js').Selection} selection The span being replaced.
 * @property {import('@deepseek-ai/dsh-llm').UserMessage} checkpoint The replacement message.
 * @property {import('@deepseek-ai/dsh-compaction').CompactionResult['summary']} summary Summary content blocks.
 * @property {readonly import('@deepseek-ai/dsh-llm').ContentBlock[]} rawOutput Complete provider output before projection.
 * @property {string} provider Route that produced the summary.
 * @property {string} model Model that produced the summary.
 * @property {number} [maxTokens] Generation cap the summary call sent.
 * @property {import('@deepseek-ai/dsh-llm').TokenUsage} [usage] Provider usage for the summary call.
 * @property {number} turn Owner turn enclosing the bracket.
 */

/**
 * Append one completed compaction transaction.
 *
 * Every failure after the opening bracket still closes the bracket exactly
 * once, carrying the failure text, so the log never leaves an unmatched opening
 * marker behind a handled error.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session Session to append to.
 * @param {CommitInput} input The prepared transaction.
 * @returns {import('@deepseek-ai/dsh-compaction').CompactionResult} The committed result.
 */
export function commit(session, input) {
  const lifecycle = { compactionId: input.compactionId, turn: input.turn }
  const startEvent = session.append('compaction/start', lifecycle)
  const { selection } = input

  let summaryEvent
  try {
    summaryEvent = session.append('compaction/summary', {
      compactionId: input.compactionId,
      summary: input.summary,
      rawOutput: input.rawOutput,
      llmStreamCall: true,
      shadowedRange: { start: selection.start, end: selection.end },
      shadowedSeqs: [...selection.seqs],
      shadowedTokenCount: selection.heuristicTokens,
      provider: input.provider,
      model: input.model,
      ...input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens },
      ...input.usage === undefined ? {} : { usage: input.usage },
    })
    session.append('user/message', input.checkpoint, {
      surfaceOp: { op: 'replace', startSeq: selection.start, endSeq: selection.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.seqs],
    })
    const endEvent = session.append('compaction/end', lifecycle)
    return {
      compactionId: input.compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: input.summary,
      shadowedRange: { start: selection.start, end: selection.end },
      shadowedSeqs: [...selection.seqs],
      shadowedTokenCount: selection.heuristicTokens,
    }
  } catch (error) {
    try {
      session.append('compaction/end', {
        ...lifecycle,
        error: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // A log that cannot accept the closing marker is already unusable; the
      // original failure is the one worth reporting.
    }
    throw error
  }
}