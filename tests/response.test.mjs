import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { checkpointMessage } from '../src/checkpoint.js'
import { commit } from '../src/transaction.js'
import { ResponseTracker } from '../src/response-trace.js'
import { TraceJournal, projectTrace } from '../src/trace.js'
import { prefixFingerprint } from '../src/request-policy.js'

function fixture({ manual = false, directory = null } = {}) {
  let time = 0
  const journal = new TraceJournal({ directory, clock: () => 1000 + time })
  const tracker = new ResponseTracker({ journal: () => journal, now: () => time, wall: () => 1000 + time })
  const session = Session.create('response-test')
  const append = session.append.bind(session)
  session.append = (...args) => { const event = append(...args); tracker.event(session, event); return event }
  if (!manual) session.append('turn/start', { turn: 1 })
  const original = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const at = value => { time = value }
  const apply = (id = 'c1', { background = true, start = original.seq, end = original.seq } = {}) => {
    if (background) {
      journal.begin(session.id, { id, original: 'original' })
      journal.update(session.id, id, { status: 'ready', summary: 'summary', generationMs: 20 })
    }
    const summary = [{ type: 'text', text: 'summary' }]
    return commit(session, { compactionId: id, selection: { start, end, seqs: [start], heuristicTokens: 500 },
      summary, rawOutput: summary, checkpoint: checkpointMessage(summary, id), provider: 'test', model: 'test', turn: manual ? null : 1 })
  }
  const request = (extra = {}, marked = true) => {
    const options = Object.freeze({ sessionId: session.id, provider: 'test', model: 'test', messages: session.deriveMessages(), ...extra })
    return marked ? markAgentLoopRequest(options) : options
  }
  const run = async (options, schedule) => {
    const source = async function* () { for (const [when, chunk] of schedule) { at(when); yield chunk } }
    const output = []
    for await (const chunk of tracker.stream(options, () => source())) output.push(chunk)
    assert.deepEqual(output, schedule.map(([, chunk]) => chunk), 'observer must preserve every chunk')
    return output
  }
  const record = async (id = 'c1') => (await journal.read(session.id)).find(record => record.id === id)
  return { tracker, journal, session, at, apply, request, run, record }
}
const reasoning = text => ({ type: 'reasoning-delta', index: 0, text })
const text = value => ({ type: 'text-delta', index: 1, text: value })
const finish = kind => ({ type: 'finish', reason: { kind } })

function prepared() {
  const f = fixture()
  f.tracker.beginBlocking(f.session, 'pressure')
  f.at(80); f.apply(); f.tracker.endBlocking(f.session)
  return f
}

test('measures blocking, post-apply and TTFT independently, with first reasoning/text/tool', async () => {
  const f = prepared()
  f.at(100)
  await f.run(f.request(), [
    [110, { type: 'block-start', index: 0, blockType: 'reasoning' }],
    [115, reasoning('')], [120, { type: 'usage', usage: { inputTokens: 20, outputTokens: 0 } }],
    [140, reasoning('thinking')], [200, text('answer')],
    [210, { type: 'tool-call-delta', index: 2, id: 'tool-1', name: 'read', argumentsDelta: '' }],
    [220, finish('stop')],
  ])
  const response = (await f.record()).response
  assert.equal(response.verified, true)
  assert.equal(response.status, 'completed')
  assert.equal(response.blockingMs, 140)
  assert.equal(response.afterApplyMs, 60)
  assert.equal(response.ttftMs, 40)
  assert.equal(response.firstReasoningMs, 60)
  assert.equal(response.firstTextMs, 120)
  assert.equal(response.firstToolMs, 130)
  assert.equal(response.firstKind, 'reasoning')
  assert.equal(response.attempts.length, 1)
  assert.equal(f.tracker.sessions.size, 0)
})

test('summary, warm-up and another session cannot supply the main-request timing', async () => {
  const f = prepared()
  f.at(100)
  await f.run(f.request({}, false), [[110, text('warm-up')]])
  await f.run(f.request({ sessionId: 'other' }), [[120, text('unrelated')]])
  const response = (await f.record()).response
  assert.equal(response.status, 'awaiting-request')
  assert.equal(response.requestCount, 0)
  assert.equal(response.ttftMs, undefined)
  assert.equal(response.verified, undefined)
})

test('request verification requires the actual checkpoint identity, not copied summary text', async () => {
  const f = prepared()
  const wrong = createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } })
  await f.run(f.request({ messages: [wrong] }), [[100, text('answer')]])
  const response = (await f.record()).response
  assert.equal(response.status, 'missing-checkpoint')
  assert.equal(response.verified, undefined)
  assert.equal(response.ttftMs, undefined)
})

test('failed attempts remain separate and recovery includes retry waiting', async () => {
  const f = prepared()
  f.at(100)
  await f.run(f.request(), [[150, { type: 'finish', reason: { kind: 'error', failure: { message: 'token=private unavailable' } } }]])
  assert.equal((await f.record()).response.status, 'retrying')
  f.at(200)
  await f.run(f.request(), [[250, text('recovered')], [270, finish('stop')]])
  const response = (await f.record()).response
  assert.equal(response.status, 'completed')
  assert.equal(response.requestCount, 2)
  assert.equal(response.firstAttempt, 2)
  assert.equal(response.blockingMs, 250)
  assert.equal(response.afterApplyMs, 170)
  assert.equal(response.ttftMs, 50)
  assert.equal(response.attempts[0].status, 'failed')
  assert.match(response.attempts[0].error, /token=\[redacted\]/)
  assert.equal(response.attempts[0].ttftMs, undefined)
})

test('cancelled and empty requests do not invent a zero first-token time', async () => {
  for (const kind of ['aborted', 'stop']) {
    const f = prepared()
    await f.run(f.request(), [[120, finish(kind)]])
    const response = (await f.record()).response
    assert.equal(response.status, kind === 'aborted' ? 'cancelled' : 'no-output')
    assert.equal(response.afterApplyMs, undefined)
    assert.equal(response.ttftMs, undefined)
    assert.equal(f.tracker.sessions.size, 0)
  }
})

test('consumer cancellation closes observation without draining or swallowing provider errors', async () => {
  const f = prepared()
  let pulled = 0, closed = false
  const source = async function* () { try { pulled++; yield text('one'); pulled++; yield text('two') } finally { closed = true } }
  for await (const chunk of f.tracker.stream(f.request(), () => source())) { assert.equal(chunk.text, 'one'); break }
  assert.equal(pulled, 1)
  assert.ok(closed)
  assert.equal((await f.record()).response.status, 'interrupted')
  const g = prepared(), error = new Error('provider failed')
  await assert.rejects(async () => { for await (const chunk of g.tracker.stream(g.request(), async function* () { throw error })) {} }, caught => caught === error)
  assert.equal((await g.record()).response.status, 'retrying')
  g.session.append('turn/end', { turn: 1, reason: 'completed' })
  assert.equal((await g.record()).response.status, 'failed')
})

test('a checkpoint replaced before a request is not credited with that request', async () => {
  const f = prepared()
  const checkpoint = f.session.surface.nodes[0]
  f.at(90); f.apply('c2', { start: checkpoint, end: checkpoint })
  f.at(100); await f.run(f.request(), [[140, text('answer')], [150, finish('stop')]])
  assert.equal((await f.record()).response.status, 'superseded')
  assert.equal((await f.record()).response.verified, undefined)
  assert.equal((await f.record('c2')).response.afterApplyMs, 50)
})

test('manual compaction records the next request but does not count user idle time as blocking', async () => {
  const f = fixture({ manual: true })
  f.at(10); f.apply('manual', { background: false })
  f.at(1000); f.session.append('turn/start', { turn: 1 })
  f.at(1100); await f.run(f.request(), [[1150, reasoning('first')], [1200, finish('stop')]])
  const record = await f.record('manual')
  assert.equal(record.mode, 'native')
  assert.equal(record.response.trigger, 'manual')
  assert.equal(record.response.blockingMs, undefined)
  assert.equal(record.response.afterApplyMs, 1140)
  assert.equal(record.response.ttftMs, 50)
  assert.equal(projectTrace(f.session.snapshotEvents(), [record]).records[0].mode, 'native')
})

test('native fallback has its own timing, without fabricated background generation', async () => {
  const f = fixture()
  f.tracker.beginBlocking(f.session, 'context-overflow')
  f.at(90); f.apply('native', { background: false }); f.tracker.endBlocking(f.session)
  f.at(120); await f.run(f.request(), [[150, text('first')], [160, finish('stop')]])
  const record = await f.record('native')
  assert.equal(record.generationMs, undefined)
  assert.equal(record.response.blockingMs, 150)
  assert.equal(record.response.afterApplyMs, 60)
  assert.equal(record.response.ttftMs, 30)
})

test('unapplied and ended turns do not leak into a subsequent turn', async () => {
  const f = fixture()
  f.session.append('compaction/start', { compactionId: 'failed', turn: 1 })
  f.session.append('compaction/end', { compactionId: 'failed', turn: 1, error: 'summary failed' })
  assert.equal((await f.record('failed')).response.status, 'not-applied')
  assert.equal(f.tracker.sessions.size, 0)
  f.apply()
  f.session.append('turn/end', { turn: 1, reason: 'completed' })
  f.session.append('turn/start', { turn: 2 })
  await f.run(f.request(), [[120, text('next turn')]])
  assert.equal((await f.record()).response.status, 'ended')
  assert.equal((await f.record()).response.ttftMs, undefined)
})

test('restart preserves measured data and marks unfinished response observation interrupted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'response-journal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const f = fixture({ directory })
  f.apply()
  f.at(20)
  await f.run(f.request(), [[50, reasoning('partial')], [60, finish('error')]])
  f.journal.update(f.session.id, 'c1', { warmup: { status: 'stale', usage: { cacheReadTokens: 0 } } })
  await f.journal.flush()
  const restarted = new TraceJournal({ directory })
  const record = (await restarted.read(f.session.id))[0]
  assert.equal(record.status, 'applied')
  assert.equal(record.response.status, 'interrupted')
  assert.equal(record.response.ttftMs, 30)
  assert.equal(record.response.firstTextMs, undefined)
  assert.equal(record.warmup.status, 'stale')
  assert.equal(record.warmup.usage.cacheReadTokens, 0)
})

test('attempt retention is bounded and only the first token is recorded once per attempt', async () => {
  const f = prepared()
  for (let i = 0; i < 11; i++) {
    f.at(100 + i * 100)
    await f.run(f.request(), [[110 + i * 100, finish('error')]])
  }
  const response = (await f.record()).response
  assert.equal(response.requestCount, 11)
  assert.equal(response.attempts.length, 8)
  assert.equal(response.attempts[0].number, 4)
  f.tracker.dispose()
  assert.equal((await f.record()).response.status, 'interrupted')
})

test('diagnostic write failures never stop the model stream', async () => {
  const f = prepared()
  f.journal.update = () => { throw new Error('diagnostic unavailable') }
  const result = await f.run(f.request(), [[100, text('still delivered')], [120, finish('stop')]])
  assert.equal(result[0].text, 'still delivered')
  assert.match(f.journal.warning, /diagnostic unavailable/)
})

for (const status of ['matched', 'mismatch', 'not-ready']) {
  test(`main request verifies warmup prefix (${status}) and preserves provider cache usage`, async () => {
    const f = prepared()
    const request = f.request({ reasoningEffort: 'medium' })
    f.journal.update(f.session.id, 'c1', { warmup: {
      status: status === 'not-ready' ? 'running' : 'completed',
      prefixFingerprint: prefixFingerprint({ ...request, reasoningEffort: status === 'mismatch' ? 'xhigh' : 'medium' }),
      messageCount: request.messages.length,
    } })
    await f.run(request, [[100, text('first')], [110, { type: 'usage', usage: {
      inputTokens: 20, outputTokens: 10, cacheReadTokens: status === 'matched' ? 400 : 0,
    } }], [120, finish('stop')]])
    const response = (await f.record()).response
    assert.equal(response.warmupPrefix, status)
    assert.equal(response.attempts[0].reasoningEffort, 'medium')
    assert.equal(response.attempts[0].usage.cacheReadTokens, status === 'matched' ? 400 : 0)
    assert.equal(response.attempts[0].usage.cacheWriteTokens, undefined)
  })
}

test('missing provider cache statistics remain unknown even with a matching warmup prefix', async () => {
  const f = prepared(), request = f.request()
  f.journal.update(f.session.id, 'c1', { warmup: {
    status: 'completed', prefixFingerprint: prefixFingerprint(request), messageCount: request.messages.length,
  } })
  await f.run(request, [[100, text('first')], [110, { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }], [120, finish('stop')]])
  const response = (await f.record()).response
  assert.equal(response.warmupPrefix, 'matched')
  assert.equal(response.attempts[0].usage.cacheReadTokens, undefined)
})
