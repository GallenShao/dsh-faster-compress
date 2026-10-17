import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TraceJournal, TraceService, projectTrace, traceError, TRACE_LIMIT } from '../src/trace.js'
import contract from '../src/trace-contract.cjs'

async function journalFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'faster-trace-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, journal: new TraceJournal({ directory }) }
}

test('journal persists updates and invalidates unfinished preparation after restart', async t => {
  const { directory, journal } = await journalFixture(t)
  journal.begin('session-a', { id: 'one', original: 'source' })
  journal.update('session-a', 'one', { status: 'ready', summary: 'prepared summary', generationMs: 20 })
  await journal.flush()
  const restarted = new TraceJournal({ directory })
  const records = await restarted.read('session-a')
  assert.equal(records[0].summary, 'prepared summary')
  assert.equal(records[0].status, 'discarded')
  assert.equal(records[0].reason, 'restart')
  const saved = JSON.parse(await readFile(journal.file('session-a'), 'utf8'))
  assert.equal(saved.sessionId, 'session-a')
  assert.equal(saved.records[0].generationMs, 20)
})

test('new records merge with older disk history before asynchronous writes', async t => {
  const { directory, journal } = await journalFixture(t)
  journal.begin('session', { id: 'old' })
  journal.update('session', 'old', { status: 'discarded', reason: 'idle' })
  await journal.flush()
  const next = new TraceJournal({ directory })
  next.begin('session', { id: 'new' })
  next.update('session', 'new', { status: 'ready', summary: 'new' })
  await next.flush()
  assert.deepEqual((await next.read('session')).map(record => record.id), ['old', 'new'])
})

test('journal bounds text and records, hashes session paths, and separates sessions', async t => {
  const { journal } = await journalFixture(t)
  for (let i = 0; i < TRACE_LIMIT + 5; i++) journal.begin('../session', { id: String(i), original: 'a'.repeat(13000) })
  journal.update('../session', String(TRACE_LIMIT + 4), { summary: 'b'.repeat(25000), status: 'ready' })
  await journal.flush()
  const records = await journal.read('../session')
  assert.equal(records.length, TRACE_LIMIT)
  assert.equal(records[0].id, '5')
  assert.equal(records.at(-1).summary.length, 24000)
  assert.equal(records.at(-1).original.length, 12000)
  assert.equal(records.at(-1).summaryTruncated, true)
  assert.equal(records.at(-1).originalTruncated, true)
  assert.ok(!journal.file('../session').includes('/../'))
  assert.deepEqual(await journal.read('other-session'), [])
})

test('corrupt or unavailable storage does not fail live diagnostic collection', async t => {
  const { directory, journal } = await journalFixture(t)
  await writeFile(journal.file('corrupt'), '{bad json')
  assert.deepEqual(await journal.read('corrupt'), [])
  assert.ok(journal.warning)
  await writeFile(journal.file('bad-record'), JSON.stringify({ version: 1, sessionId: 'bad-record',
    records: [{ id: 'one', startedAt: 1, status: 'ready', summary: { broken: true } }] }))
  assert.deepEqual(await journal.read('bad-record'), [])
  assert.equal(journal.warning, 'Invalid trace record')
  const blocked = join(directory, 'file-not-directory')
  await writeFile(blocked, '')
  const memory = new TraceJournal({ directory: blocked })
  memory.begin('session', { id: 'one' })
  memory.update('session', 'one', { status: 'ready', summary: 'usable' })
  await memory.flush()
  assert.equal((await memory.read('session'))[0].summary, 'usable')
  assert.ok(memory.warning)
})

const events = [
  { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'original' }] }, surfaceOp: 'append' },
  { type: 'compaction/start', seq: 1, time: 100, data: { compactionId: 'c1' } },
  { type: 'compaction/summary', seq: 2, time: 190, data: { compactionId: 'c1', summary: [{ type: 'text', text: 'summary' }], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 120 } },
  { type: 'user/message', seq: 3, time: 200, data: {}, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [1, 2, 0] },
  { type: 'compaction/end', seq: 4, time: 210, data: { compactionId: 'c1' } },
]

test('native records prove application, recover history, and detect later replacement', () => {
  const telemetry = [{ id: 'c1', startedAt: 20, status: 'discarded', reason: 'restart', generationMs: 15 }]
  const record = projectTrace(events, telemetry).records[0]
  assert.equal(record.status, 'applied')
  assert.equal(record.summary, 'summary')
  assert.equal(record.original, 'original')
  assert.equal(record.commitMs, 110)
  assert.equal(telemetry[0].status, 'discarded', 'projection must not mutate telemetry')
  const native = projectTrace(events).records[0]
  assert.equal(native.mode, 'native')
  assert.equal(native.generationMs, undefined, 'do not invent historical preparation duration')
  const superseded = projectTrace([...events, {
    type: 'user/message', seq: 5, time: 220, data: {}, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
  }]).records[0]
  assert.equal(superseded.status, 'superseded')
  assert.equal(superseded.appliedAt, 200)
})

test('a summary or successful end without a replacement is not called applied', () => {
  const missing = events.filter(event => event.seq !== 3)
  assert.equal(projectTrace(missing).records[0].status, 'unapplied')
  const failed = missing.map(event => event.type === 'compaction/end' ? { ...event, data: { compactionId: 'c1', error: 'write failed' } } : event)
  assert.equal(projectTrace(failed).records[0].status, 'failed')
})

test('RPC validates identity, observes the target session, and always releases its lease', async () => {
  const parse = contract.traceDescriptor.parameters[0].codec.create().parse
  for (const invalid of ['', null, {}, 'x'.repeat(257)]) assert.throws(() => parse(invalid))
  let disposed = false, readId
  const service = { integration: () => ({ status: 'active', preset: 'standard' }), ctx: { sessionQuery: { observeSession: async id => {
    readId = id
    return { events, [Symbol.dispose]() { disposed = true } }
  } } }, journal: { read: async () => [], warning: null } }
  const answer = await TraceService.prototype.read.call(service, 'session', new AbortController().signal)
  assert.equal(readId, 'session')
  assert.equal(answer.integration.status, 'active')
  assert.equal(answer.records[0].status, 'applied')
  assert.ok(disposed)
  service.ctx.sessionQuery.observeSession = async () => { throw new Error('session unavailable') }
  service.journal.read = async () => { throw new Error('should not read sidecar before resolving session') }
  await assert.rejects(TraceService.prototype.read.call(service, 'missing', new AbortController().signal), /session unavailable/)
})

test('diagnostics redact common credential forms and bound errors', () => {
  assert.equal(traceError(new Error('Bearer abc123 api_key=secret token=private')), '[redacted] api_key=[redacted] token=[redacted]')
  assert.ok(traceError('x'.repeat(5000)).length <= 2000)
})
