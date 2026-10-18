/**
 * Compactable-span selection and stability checks.
 *
 * The rules mirror `selectCompactableRange` and `assertSelectedSpanStable` in
 * `packages/compaction/compaction-basic/src/region.ts`. They are re-derived
 * here rather than imported because that package does not export them.
 *
 * @module dsh-faster-compress/selection
 */

import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { SessionSeq } from '@deepseek-ai/dsh-session'

/**
 * @typedef {object} Selection
 * @property {number} start First shadowed surface sequence, inclusive.
 * @property {number} end Last shadowed surface sequence, inclusive.
 * @property {number[]} seqs Shadowed surface sequences in surface order.
 * @property {number} routeTokens Route price of the selected span.
 * @property {number} heuristicTokens Fixed-heuristic price of the selected span.
 */

/**
 * One surface node priced under the measured route and under the fixed
 * heuristic, as reported by the token meter.
 *
 * @typedef {object} MeterNode
 * @property {number} seq Sequence of the surface event.
 * @property {number} tokens Route price of the node's message.
 * @property {number} heuristicTokens Fixed-heuristic price of the same message.
 */

/**
 * The `system/message` holding surface node 0, when one starts the surface.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session Session to inspect.
 * @param {number} [headSeq] Sequence of surface node 0.
 * @returns {import('@deepseek-ai/dsh-session').SessionEvent<'system/message'> | undefined} The head event.
 */
export function systemHead(session, headSeq = session.surface.nodes[0]) {
  if (headSeq === undefined) return undefined
  const head = session.eventAt(headSeq)
  return head !== null && head !== undefined && head.type === 'system/message' ? head : undefined
}

/**
 * Select the oldest compactable span while retaining a priced recent tail.
 *
 * Both returned edges are balanced, so an assistant tool call is never
 * separated from its result. Returns `null` when no useful span exists, which
 * covers an empty surface, a surface whose whole content fits the retention
 * budget, and an unbalanced candidate edge.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session Session supplying surface positions.
 * @param {{ nodes: readonly MeterNode[] }} measurement Meter reading for the same surface.
 * @param {number} retainTokens Minimum recent tail budget retained verbatim.
 * @returns {Selection | null} The span to compact, or `null`.
 */
export function selectRange(session, measurement, retainTokens) {
  const surface = session.surface.nodes
  const priced = measurement.nodes
  if (priced.length === 0 || surface.length !== priced.length) return null
  for (let index = 0; index < surface.length; index += 1) {
    if (surface[index] !== priced[index]?.seq) return null
  }

  const firstIdx = systemHead(session, surface[0]) === undefined ? 0 : 1

  let accumulated = 0
  let keepFromIdx = priced.length
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index].tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null

  // Widen the retained tail until its first node opens at a step boundary.
  while (keepFromIdx > firstIdx && !toolPairingBalancedBefore(session, surface[keepFromIdx])) {
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null

  const endIdx = keepFromIdx - 1
  if (!toolPairingBalancedAfter(session, surface[endIdx])) return null

  const selected = priced.slice(firstIdx, endIdx + 1)
  return {
    start: surface[firstIdx],
    end: surface[endIdx],
    seqs: surface.slice(firstIdx, endIdx + 1),
    routeTokens: selected.reduce((total, node) => total + node.tokens, 0),
    heuristicTokens: selected.reduce((total, node) => total + node.heuristicTokens, 0),
  }
}

/**
 * Whether a previously selected span is still a valid replacement target.
 *
 * Nodes appended outside the span do not invalidate a summary. This cheap
 * check validates node identity and tool boundaries; selectionIntact additionally
 * validates prices immediately before committing.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session Session to inspect.
 * @param {Selection} selection The span as selected when the summary was built.
 * @returns {boolean} Whether the summary may still replace the span.
 */
export function selectionSurfaceIntact(session, selection) {
  const surface = session.surface.nodes
  const startIdx = surface.indexOf(selection.start)
  const endIdx = surface.indexOf(selection.end)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return false
  if (endIdx - startIdx + 1 !== selection.seqs.length) return false
  for (let index = 0; index < selection.seqs.length; index += 1) {
    if (surface[startIdx + index] !== selection.seqs[index]) return false
  }
  if (!toolPairingBalancedBefore(session, selection.start)) return false
  if (!toolPairingBalancedAfter(session, selection.end)) return false

  return true
}

/** Full commit-time validation includes the current route's prices. */
export function selectionIntact(session, selection, measurement) {
  if (!selectionSurfaceIntact(session, selection)) return false
  const surface = session.surface.nodes
  const startIdx = surface.indexOf(selection.start)
  const endIdx = surface.indexOf(selection.end)
  const priced = measurement.nodes
  if (priced.length !== surface.length) return false
  let routeTokens = 0
  let heuristicTokens = 0
  for (let index = startIdx; index <= endIdx; index += 1) {
    const node = priced[index]
    if (node === undefined || node.seq !== surface[index]) return false
    routeTokens += node.tokens
    heuristicTokens += node.heuristicTokens
  }
  return routeTokens === selection.routeTokens && heuristicTokens === selection.heuristicTokens
}

/**
 * The number of the turn currently open, or `null` when no turn is open.
 *
 * Automatic compaction events must be enclosed by a turn, so a commit needs
 * this owner for its bracket.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session Session to inspect.
 * @returns {number | null} The open turn number.
 */
export function openTurnOf(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === null || event === undefined) continue
    if (event.type === 'turn/start') return event.data.turn
    if (event.type === 'turn/end') return null
  }
  return null
}