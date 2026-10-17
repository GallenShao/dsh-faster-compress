import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actualInputTokens, actualUsage } from '../src/usage.js'
import { projectTrace } from '../src/trace.js'

const message = (seq, usage) => ({ type: 'assistant/message', seq, time: seq * 100,
  data: { usage }, surfaceOp: 'append' })
const compaction = [
  { type: 'compaction/start', seq: 2, time: 200, data: { compactionId: 'c' } },
  { type: 'compaction/summary', seq: 3, time: 300, data: { compactionId: 'c', shadowedTokenCount: 30000,
    usage: { inputTokens: 500, cacheReadTokens: 100000, outputTokens: 1500, totalTokens: 102000 } } },
  { type: 'user/message', seq: 4, time: 400, data: {},
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [3] },
  { type: 'compaction/end', seq: 5, time: 500, data: { compactionId: 'c' } },
]
const before = [message(0, { inputTokens: 2000, cacheReadTokens: 198000, outputTokens: 600 })]
const get = (events, records) => projectTrace(events, records).records.find(r => r.id === 'c')

test('normalized actual input includes cache reads and writes, never completion', () => {
  assert.equal(actualInputTokens({ inputTokens: 579, cacheReadTokens: 105216, outputTokens: 1525 }), 105795)
  assert.equal(actualInputTokens({ inputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }), 90)
  assert.equal(actualInputTokens({ totalTokens: 107320, outputTokens: 1525 }), 105795)
  assert.equal(actualInputTokens({ inputTokens: 0 }), 0)
})
test('missing and invalid usage stays unknown', () => {
  for (const usage of [undefined, {}, { outputTokens: 123 }, { inputTokens: NaN },
    { inputTokens: 2, cacheReadTokens: -1 }, { totalTokens: 1, outputTokens: 2 }]) {
    assert.equal(actualInputTokens(usage), undefined)
  }
  assert.deepEqual(actualUsage(undefined), { inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined })
})
test('historical native events recover adjacent main inputs and separate summary usage', () => {
  const result = get([...before, ...compaction, message(6, { inputTokens: 100000, cacheReadTokens: 6400, outputTokens: 300 })])
  assert.equal(result.contextUsage.before.inputTokens, 200000)
  assert.equal(result.contextUsage.after.inputTokens, 106400)
  assert.equal(result.contextUsage.afterStatus, 'measured')
  assert.equal(result.summaryUsage.inputTokens, 100500)
  assert.equal(result.summaryUsage.outputTokens, 1500)
  assert.equal(result.inputTokens, 30000)
})
test('uses the latest main response at commit, not the earlier preparation estimate', () => {
  const records = [{ id: 'c', startedAt: 0, inputTokens: 9999, outputTokens: 100 }]
  const result = get([...before, message(1, { inputTokens: 210000 }), ...compaction], records)
  assert.equal(result.contextUsage.before.inputTokens, 210000)
  assert.equal(result.contextUsage.afterStatus, 'pending')
  assert.equal(result.contextUsage.after, undefined)
  assert.equal(records[0].contextUsage, undefined)
})
test('a missing usage is not replaced by a later tool-loop response or an estimate', () => {
  const result = get([...before, ...compaction, message(6), message(7, { inputTokens: 120000 })])
  assert.equal(result.contextUsage.afterStatus, 'unavailable')
  assert.equal(result.contextUsage.after.inputTokens, undefined)
  assert.equal(result.contextUsage.after.seq, 6)
  const missingBefore = get([...before, message(1), ...compaction])
  assert.equal(missingBefore.contextUsage.before.inputTokens, undefined)
})
test('replacement before the next main response prevents false attribution', () => {
  const result = get([...before, ...compaction,
    { type: 'user/message', seq: 6, data: {}, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } },
    message(7, { inputTokens: 1 })])
  assert.equal(result.contextUsage.afterStatus, 'unavailable')
  assert.equal(result.contextUsage.after, undefined)
})
test('verified live usage is visible before the durable assistant event', () => {
  const response = { verified: true, attempts: [{ number: 1, status: 'streaming', startedAt: 650,
    usage: { inputTokens: 3, cacheReadTokens: 100000 } }] }
  const result = get([...before, ...compaction], [{ id: 'c', startedAt: 0, response }])
  assert.equal(result.contextUsage.after.inputTokens, 100003)
  assert.equal(result.contextUsage.after.source, 'verified-stream')
  const unverified = get([...before, ...compaction], [{ id: 'c', startedAt: 0, response: { ...response, verified: false } }])
  assert.equal(unverified.contextUsage.afterStatus, 'pending')
})
test('failed or discarded preparations never acquire a fake actual comparison', () => {
  const result = get(before, [{ id: 'c', startedAt: 0, status: 'discarded', inputTokens: 9000 }])
  assert.equal(result.contextUsage.afterStatus, 'not-applied')
  assert.equal(result.contextUsage.before, undefined)
})
