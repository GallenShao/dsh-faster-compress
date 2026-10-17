/**
 * Checkpoint framing and request-prefix reconstruction.
 *
 * The summary text itself comes from the upstream summarizer, so the
 * summarization directive stays identical to the shipped backend's. What lives
 * here is the durable framing written into the replacement message and the
 * reconstruction of the request prefix a committed compaction will produce.
 *
 * @module dsh-faster-compress/checkpoint
 */

import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { systemHead } from './selection.js'

/** Tags wrapping the structured summary, matching the shipped backend's protocol. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE = [
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.',
  'It was written before the most recent messages below, so any step it describes as in progress or planned may already have been overtaken by them.',
  'Treat the captured context as established background and build on it without restating it.',
  'Continue the task directly from the messages that follow, without acknowledging this checkpoint.',
].join(' ')

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 *
 * @param {readonly import('@deepseek-ai/dsh-llm').ContentBlock[]} summary Safe text-only summary blocks.
 * @returns {import('@deepseek-ai/dsh-llm').ContentBlock[]} Content for the replacement user message.
 */
export function frameSummary(summary) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/**
 * Build the replacement user message for one compaction transaction.
 *
 * @param {readonly import('@deepseek-ai/dsh-llm').ContentBlock[]} summary Safe text-only summary blocks.
 * @param {number} compactionId Owning compaction identity.
 * @returns {import('@deepseek-ai/dsh-llm').UserMessage} The checkpoint message.
 */
export function checkpointMessage(summary, compactionId) {
  return createUserMessage({
    content: frameSummary(summary),
    source: compactCheckpointSource(compactionId),
  })
}

/**
 * Reconstruct the cacheable prefix of the last routed request for a span.
 *
 * The leading system message and the routed tool schemas are reproduced so the
 * summarization call is a genuine prefix of the conversation and reuses the
 * provider's warm prefix cache.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session Session supplying the head, header, and projections.
 * @param {readonly number[]} shadowedSeqs Surface sequences being compacted, in order.
 * @returns {{ tools?: readonly import('@deepseek-ai/dsh-llm').ToolSchema[], messages: import('@deepseek-ai/dsh-llm').Message[] }} The replayed prefix.
 */
export function summarizationInput(session, shadowedSeqs) {
  const header = session.requestHeader()
  const head = systemHead(session, session.surface.nodes[0])
  const system = head === undefined ? null : session.deriveEventMessage(head)
  const region = shadowedSeqs
    .map(seq => session.deriveEventMessage(session.eventAt(seq)))
    .filter(message => message !== null && message !== undefined)
  return {
    ...header?.tools === undefined ? {} : { tools: header.tools },
    messages: system === null ? region : [system, ...region],
  }
}

/**
 * Reconstruct the request prefix that a committed compaction will produce.
 *
 * Used to warm the provider's prefix cache for the new history before the
 * replacement lands, so the first request after a commit does not pay for a
 * cold prefill of the whole rewritten prefix.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session Session supplying the head and projections.
 * @param {import('./budget.js').Selection} selection The span the summary covers.
 * @param {import('@deepseek-ai/dsh-llm').UserMessage} checkpoint The replacement message.
 * @returns {{ tools?: readonly import('@deepseek-ai/dsh-llm').ToolSchema[], messages: import('@deepseek-ai/dsh-llm').Message[] }} The post-commit prefix.
 */
export function postCommitPrefix(session, selection, checkpoint) {
  const header = session.requestHeader()
  const surface = session.surface.nodes
  const head = systemHead(session, surface[0])
  const system = head === undefined ? null : session.deriveEventMessage(head)
  const shadowed = new Set(selection.seqs)
  const retained = surface
    .filter(seq => !shadowed.has(seq) && (head === undefined || seq !== head.seq))
    .map(seq => session.deriveEventMessage(session.eventAt(seq)))
    .filter(message => message !== null && message !== undefined)

  const messages = [...(system === null ? [] : [system]), checkpoint, ...retained]
  return {
    ...header?.tools === undefined ? {} : { tools: header.tools },
    messages,
  }
}