import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectRange, selectionIntact } from '../src/selection.js'

/**
 * A session stand-in exposing only what span selection and tool-pairing read:
 * the surface node list, its replacement generation, and event lookup.
 */
function makeSession(events, replaceGeneration = 0) {
  const log = events.map((event, seq) => ({ ...event, seq }))
  return {
    seq: log.length,
    surface: { nodes: log.map(event => event.seq), replaceGeneration },
    eventAt: seq => log[seq] ?? null,
  }
}

const system = { type: 'system/message', data: { turn: 1, step: 1, message: { role: 'system', content: [] } } }
const user = { type: 'user/message', data: { message: { role: 'user', content: [] } } }
const text = { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } }
const toolCall = { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } } }
const toolResult = { type: 'tool/result', data: { callId: 'c1', content: [] } }

/** Uniform pricing so a test can reason about counts rather than prices. */
function measure(nodes, tokens = 100) {
  return { nodes: nodes.map(seq => ({ seq, tokens, heuristicTokens: tokens })) }
}

test('the system head is never inside the compacted span', () => {
  const session = makeSession([system, user, user, user, user])
  const selection = selectRange(session, measure([0, 1, 2, 3, 4]), 150)
  assert.ok(selection !== null)
  assert.equal(selection.start, 1, 'span starts after the system head')
  assert.equal(selection.seqs[0], 1)
})

test('the retained tail is at least the retention budget', () => {
  const session = makeSession([system, user, user, user, user, user])
  const selection = selectRange(session, measure([0, 1, 2, 3, 4, 5]), 250)
  // Four retained nodes at 100 tokens each cover the 250-token budget.
  assert.deepEqual(selection.seqs, [1, 2])
})

test('a surface entirely inside the retention budget yields no span', () => {
  const session = makeSession([system, user, user])
  // 300 tokens of content against a 1000-token retention budget: the keep
  // boundary would have to reach past the system head, so there is nothing to do.
  assert.equal(selectRange(session, measure([0, 1, 2]), 1000), null)
})

test('an assistant call left unanswered is excluded from the span', () => {
  // The trailing tool call has no result yet, so the span must end before it.
  const session = makeSession([system, user, toolCall])
  const selection = selectRange(session, measure([0, 1, 2]), 100)
  assert.ok(selection !== null)
  assert.deepEqual(selection.seqs, [1], 'the open step is retained, not shadowed')
})

test('a call and its result inside the span keep the edges balanced', () => {
  const session = makeSession([system, user, toolCall, toolResult, user, user])
  const selection = selectRange(session, measure([0, 1, 2, 3, 4, 5]), 200)
  assert.ok(selection !== null)
  assert.ok(!selection.seqs.includes(2) || selection.seqs.includes(3), 'a call is never split from its result')
})

test('a meter that disagrees with the surface selects nothing', () => {
  const session = makeSession([system, user, user, user])
  assert.equal(selectRange(session, measure([0, 1, 99, 3]), 100), null)
})

test('a prepared span survives nodes appended after it', () => {
  const events = [system, user, user, user]
  const session = makeSession(events)
  const selection = selectRange(session, measure([0, 1, 2, 3]), 150)
  const grown = makeSession([...events, user, user])
  assert.ok(
    selectionIntact(grown, selection, measure([0, 1, 2, 3, 4, 5])),
    'appended nodes do not invalidate a summary of an unchanged span',
  )
})

test('a repriced span is no longer valid to replace', () => {
  const events = [system, user, user, user]
  const session = makeSession(events)
  const selection = selectRange(session, measure([0, 1, 2, 3]), 150)
  // A pruner rewriting one shadowed node changes its price.
  assert.equal(
    selectionIntact(session, selection, {
      nodes: [{ seq: 0, tokens: 100, heuristicTokens: 100 }, { seq: 1, tokens: 10, heuristicTokens: 10 },
        { seq: 2, tokens: 100, heuristicTokens: 100 }, { seq: 3, tokens: 100, heuristicTokens: 100 }],
    }),
    false,
  )
})

test('a span whose start left the surface is no longer valid', () => {
  const session = makeSession([system, user, user, user])
  const selection = selectRange(session, measure([0, 1, 2, 3]), 150)
  const replaced = makeSession([system, user, user, user], 1)
  replaced.surface.nodes = [0, 2, 3]
  assert.equal(selectionIntact(replaced, selection, measure([0, 2, 3])), false)
})
