import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { FasterCompactionEngine } from '../src/index.js'

const envelope = () => ({
  summary: [{ type: 'text', text: 'summary' }],
  rawOutput: [{ type: 'text', text: 'summary' }],
  llmStreamCall: true,
  provider: 'test', model: 'test', maxTokens: 100,
})

/** Real session projection/validation and stock compaction; only I/O is stubbed. */
function harness(config = {}) {
  const listeners = new Map()
  const disposers = []
  const session = Session.create('regression')
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    turn: 1, step: 1, reason: 'initial',
    header: { config: { provider: 'test', model: 'test', maxTokens: 0 } },
  })
  function append(tokens = 100) {
    return session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'x'.repeat(tokens) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  for (let i = 0; i < 7; i += 1) append()

  const estimateMessage = message => message.source !== undefined && isCompactCheckpointSource(message.source)
    ? 1 : message.content.reduce((total, block) => total + (block.text?.length ?? 0), 0)
  const ctx = {
    reflect: { provide() {} },
    on(name, callback) {
      const callbacks = listeners.get(name) ?? []
      callbacks.push(callback)
      listeners.set(name, callbacks)
    },
    effect(setup) { disposers.push(setup()) },
    get() {},
    logger: { info() {}, debug() {} },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 1000 } }),
      stream: async function* () { throw new Error('unexpected model request') },
    },
    tokenMeter: {
      estimateMessage,
      measure() {
        const nodes = session.surface.nodes.map(seq => {
          const tokens = estimateMessage(session.deriveEventMessage(session.eventAt(seq)))
          return { seq, tokens, heuristicTokens: tokens }
        })
        return { nodes, totalTokens: nodes.reduce((total, node) => total + node.tokens, 0) }
      },
    },
  }
  const engine = new FasterCompactionEngine(ctx, { headroomTokens: 100, retainTokens: 100, ...config })
  const agent = { session, options: {} }
  const turn = new AbortController()
  const emit = (name, ...args) => {
    for (const callback of listeners.get(name) ?? []) callback(...args)
  }
  const summaries = []
  engine.summarize = async (input, owner, signal) => {
    summaries.push({ input, owner, signal })
    return envelope()
  }
  emit('agent/created', { agent })
  return {
    ctx, engine, agent, session, append, emit, summaries, turn,
    compact: (signal = turn.signal) => engine.compactIfNeeded(agent, 'pressure', signal),
    tool: () => emit('session/event', session, { type: 'tool/call' }),
    dispose: () => disposers.forEach(dispose => dispose()),
    records: () => session.snapshotEvents().filter(event => event.type.startsWith('compaction/')),
  }
}

test('all added settings load with the upstream constructor and preserve stock validation', () => {
  const config = { eagerRatio: 0.8, warmup: false, warmupMaxTokens: 2, maxConcurrent: 2 }
  const h = harness(FasterCompactionEngine.Config(config))
  assert.deepEqual(h.engine.eager, config)
  assert.equal(h.engine.config.headroomTokens, 100)
  assert.equal(h.engine.config.retainTokens, 100)
  assert.throws(() => harness({ unknownSetting: true }), /unknown key/)
  assert.throws(() => harness({ thresholdRatio: 2 }), /thresholdRatio/)
  assert.throws(() => harness({ eagerRatio: 1 }), /eagerRatio/)
})

test('preparation is log-free and a ready summary commits once, preserving new messages', async () => {
  const h = harness()
  const originalSeq = h.session.seq
  assert.equal(await h.compact(), null)
  assert.equal(h.session.seq, originalSeq)
  assert.equal(h.summaries.length, 1)
  const tail = h.append()
  const result = await h.compact()
  assert.ok(result)
  assert.equal(h.summaries.length, 1, 'a ready summary avoids another model call')
  assert.deepEqual(h.records().map(event => event.type), [
    'compaction/start', 'compaction/summary', 'compaction/end',
  ])
  assert.ok(h.session.surface.nodes.includes(tail.seq))
  assert.equal(h.ctx.tokenMeter.measure().totalTokens, 201)
  // The actual replacement and its source references must survive replay too.
  const replay = Session.create('replayed', h.session.snapshotEvents())
  assert.deepEqual(replay.surface.nodes, h.session.surface.nodes)
})

test('a growing tail triggers stock compaction again before reporting success', async () => {
  const h = harness()
  await h.compact()
  h.append(1000)
  h.append(100)
  const result = await h.compact()
  assert.equal(h.summaries.length, 2)
  const summaries = h.records().filter(event => event.type === 'compaction/summary')
  assert.equal(summaries.length, 2)
  assert.equal(result.summarySeq, summaries[1].seq)
  assert.ok(h.ctx.tokenMeter.measure().totalTokens < 800)
})

for (const compactionRetries of [0, 1]) {
  test(`prepared commit counts toward the retry limit (${compactionRetries} retries)`, async () => {
    const h = harness({ compactionRetries })
    await h.compact()
    h.append(1000) // This newest message alone exceeds the threshold and must be retained.
    await assert.rejects(h.compact(), /compaction still above threshold/)
    assert.equal(h.summaries.length, compactionRetries + 1)
    assert.equal(h.records().filter(event => event.type === 'compaction/end').length, compactionRetries + 1)
  })
}

test('cancellation interrupts a pending commit even when the provider ignores abort', { timeout: 2000 }, async t => {
  const h = harness()
  const summary = Promise.withResolvers()
  let backgroundSignal
  h.engine.summarize = (_input, _agent, signal) => {
    backgroundSignal = signal
    return summary.promise
  }
  t.after(() => summary.resolve(envelope()))
  await h.compact()
  h.append()
  // Also covers a preparation started without the waiting caller's signal.
  const waitingTurn = new AbortController()
  const waiting = h.compact(waitingTurn.signal)
  await setImmediate()
  const reason = new Error('user stopped the turn')
  const rejected = assert.rejects(waiting, error => error === reason)
  waitingTurn.abort(reason)
  await rejected
  assert.ok(backgroundSignal.aborted)
  assert.deepEqual(h.records(), [], 'cancellation never opens a transaction or falls back inline')
  summary.resolve(envelope())
  await setImmediate()
  assert.deepEqual(h.records(), [], 'a late response cannot commit a discarded summary')
})

for (const lifecycle of ['idle', 'disposed', 'unload', 'turn-abort']) {
  test(`${lifecycle} cancels background work and leaves no compaction records`, async () => {
    const h = harness()
    let backgroundSignal
    h.engine.summarize = (_input, _agent, signal) => {
      backgroundSignal = signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    await h.compact()
    if (lifecycle === 'idle') h.emit('agent/status', { agent: h.agent, status: 'idle' })
    if (lifecycle === 'disposed') h.emit('agent/disposed', { agent: h.agent })
    if (lifecycle === 'unload') h.dispose()
    if (lifecycle === 'turn-abort') h.turn.abort()
    await setImmediate()
    assert.ok(backgroundSignal.aborted)
    assert.deepEqual(h.records(), [])
  })
}

test('warmup consumes the async stream once with the configured output cap', async () => {
  const h = harness({ warmupMaxTokens: 2 })
  let options, consumed = 0
  h.ctx.llm.stream = async function* (request) {
    options = request
    consumed += 1
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await h.compact()
  const before = h.session.seq
  h.tool()
  h.tool()
  await setImmediate()
  assert.equal(consumed, 1)
  assert.equal(options.maxTokens, 2)
  assert.equal(options.provider, 'test')
  assert.ok(isCompactCheckpointSource(options.messages[0].source))
  assert.equal(h.session.seq, before, 'warmup does not append a durable event')
  h.append()
  assert.ok(await h.compact())
})

test('warmup false prevents even invoking the stream', async () => {
  const h = harness({ warmup: false })
  let invoked = 0
  h.ctx.llm.stream = () => { invoked += 1; throw new Error('must not be invoked') }
  await h.compact()
  h.tool()
  await setImmediate()
  assert.equal(invoked, 0)
})

for (const failure of ['synchronous', 'iteration']) {
  test(`${failure} warmup failure does not prevent committing the summary`, async () => {
    const h = harness()
    h.ctx.llm.stream = failure === 'synchronous'
      ? () => { throw new Error('dispatch failed') }
      : async function* () { throw new Error('stream failed') }
    await h.compact()
    h.tool()
    await setImmediate()
    h.append()
    assert.ok(await h.compact())
    assert.equal(h.summaries.length, 1)
  })
}

test('background summary failure falls back to the inherited transaction', async () => {
  const h = harness()
  let calls = 0
  h.engine.summarize = async () => {
    if (++calls === 1) throw new Error('summary failed')
    return envelope()
  }
  await h.compact()
  await setImmediate()
  h.append()
  assert.ok(await h.compact())
  assert.equal(calls, 2)
  assert.equal(h.records().length, 3)
})

test('a replaced selected span discards its summary and compacts inline', async () => {
  const h = harness()
  await h.compact()
  const seq = h.session.surface.nodes[0]
  h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'y'.repeat(100) }], source: { kind: 'user' } }), {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
  })
  h.append()
  assert.ok(await h.compact())
  assert.equal(h.summaries.length, 2)
  assert.equal(h.records().length, 3, 'discarded preparation has no durable bracket')
})

test('a tool-triggered capacity lookup failure is contained and can be retried', async () => {
  const h = harness()
  const messages = []
  h.ctx.logger.debug = message => messages.push(message)
  h.ctx.llm.resolveModelInfo = async () => { throw new Error('model unavailable') }
  h.tool()
  await setImmediate()
  assert.equal(h.summaries.length, 0)
  assert.ok(messages.some(message => message.includes('model unavailable')))
  h.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1000 } })
  h.tool()
  await setImmediate()
  assert.equal(h.summaries.length, 1)
})

test('overflow recovery cancels pending preparation and uses the stock transaction', async () => {
  const h = harness()
  let calls = 0, backgroundSignal
  h.engine.summarize = async (_input, _agent, signal) => {
    if (++calls !== 1) return envelope()
    backgroundSignal = signal
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  await h.compact()
  const result = await h.engine.compactIfNeeded(h.agent, 'context-overflow', h.turn.signal)
  assert.ok(backgroundSignal.aborted)
  assert.ok(result)
  assert.equal(calls, 2)
  assert.equal(h.records().length, 3)
})

test('saved settings affect the existing engine without remounting or losing its summary', async () => {
  const config = FasterCompactionEngine.Config({ eagerRatio: 0.99 })
  const h = harness(config)
  let warmups = 0
  h.ctx.llm.stream = async function* () { warmups += 1 }
  await h.compact()
  assert.equal(h.summaries.length, 0)
  const changed = FasterCompactionEngine.Config({ eagerRatio: 0.7, warmup: false, maxConcurrent: 2, warmupMaxTokens: 3 })
  for (const key of ['eagerRatio', 'warmup', 'maxConcurrent', 'warmupMaxTokens']) updateVolatile(config[key], changed[key])
  await h.compact()
  assert.equal(h.summaries.length, 1)
  assert.equal(h.engine.eager.maxConcurrent, 2)
  assert.equal(h.engine.eager.warmupMaxTokens, 3)
  h.tool()
  await setImmediate()
  assert.equal(warmups, 0)
  updateVolatile(config.warmup, FasterCompactionEngine.Config({ warmup: true }).warmup)
  h.tool()
  await setImmediate()
  assert.equal(warmups, 1)
  h.append()
  assert.ok(await h.compact())
  assert.equal(h.summaries.length, 1, 'live edits preserve the already prepared summary')
})
