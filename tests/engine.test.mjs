import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { FasterCompactionEngine } from '../src/index.js'
import { TraceJournal, projectTrace } from '../src/trace.js'
import { inheritReasoning } from '../src/request-policy.js'

const envelope = () => ({
  summary: [{ type: 'text', text: 'summary' }],
  rawOutput: [{ type: 'text', text: 'summary' }],
  llmStreamCall: true,
  provider: 'test', model: 'test', maxTokens: 100,
})

/** Real session projection/validation and stock compaction; only I/O is stubbed. */
function harness(config = {}, sessionId = 'regression') {
  const listeners = new Map()
  const disposers = []
  const session = Session.create(sessionId)
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
    logger: { info() {}, debug() {}, warn() {} },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 1000 } }),
      stream: async function* () { throw new Error('unexpected model request') },
    },
    tokenMeter: {
      estimateMessage,
      measure(current = session) {
        const nodes = current.surface.nodes.map(seq => {
          const tokens = estimateMessage(current.deriveEventMessage(current.eventAt(seq)))
          return { seq, tokens, heuristicTokens: tokens }
        })
        return { nodes, totalTokens: nodes.reduce((total, node) => total + node.tokens, 0) }
      },
    },
  }
  const engine = new FasterCompactionEngine(ctx, { headroomTokens: 100, safetyMarginTokens: 50, retainTokens: 100, eagerRatio: 0.85, warmup: true, ...config })
  engine.trace = new TraceJournal({ directory: null })
  const agent = { session, options: {} }
  const turn = new AbortController()
  const emit = (name, ...args) => {
    for (const callback of listeners.get(name) ?? []) callback(...args)
  }
  const appendEvent = session.append.bind(session)
  session.append = (...args) => {
    const event = appendEvent(...args)
    emit('session/event', session, event)
    return event
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
    step: next => listeners.get('agent/pre-step')[0]({ agent, signal: turn.signal }, next),
    tool: () => emit('session/event', session, { type: 'tool/call' }),
    dispose: () => disposers.forEach(dispose => dispose()),
    records: () => session.snapshotEvents().filter(event => event.type.startsWith('compaction/')),
  }
}

test('all added settings load with the upstream constructor and preserve stock validation', () => {
  const config = { eagerRatio: 0.8, warmup: false, warmupMaxTokens: 2, maxConcurrent: 2, traceTab: true }
  const h = harness(FasterCompactionEngine.Config(config))
  assert.deepEqual(h.engine.eager, { ...config, outputReserveTokens: 0, safetyMarginTokens: 4096 })
  assert.equal(h.engine.config.headroomTokens, 100)
  assert.equal(h.engine.config.retainTokens, 100)
  assert.throws(() => harness({ unknownSetting: true }), /unknown key/)
  assert.throws(() => harness({ thresholdRatio: 2 }), /thresholdRatio/)
  assert.throws(() => harness({ eagerRatio: 1.01 }), /eagerRatio/)
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
  h.append(250)
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

for (const lifecycle of ['disposed', 'unload', 'turn-abort']) {
  test(`${lifecycle} cancels background work and leaves no compaction records`, async () => {
    const h = harness()
    let backgroundSignal
    h.engine.summarize = (_input, _agent, signal) => {
      backgroundSignal = signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    await h.compact()
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
  const config = FasterCompactionEngine.Config({ eagerRatio: 0.99, safetyMarginTokens: 50 })
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

test('unloading during a threshold wait falls back while the user turn remains live', async () => {
  const h = harness()
  let calls = 0
  h.engine.summarize = async () => {
    calls += 1
    if (calls === 1) return new Promise(() => {}) // Provider ignores cancellation.
    return envelope()
  }
  await h.compact()
  h.append(250)
  const waiting = h.compact()
  await setImmediate()
  h.dispose()
  const result = await waiting
  assert.ok(result)
  assert.equal(calls, 2)
  assert.equal(h.turn.signal.aborted, false)
  const records = await h.engine.trace.read(h.session.id)
  assert.equal(records[0].reason, 'unloaded')
  assert.equal(records[0].status, 'discarded')
})

test('a new engine with no preparation can synchronously compact an existing session', async () => {
  const h = harness()
  await h.compact()
  h.dispose()
  h.append(250)
  const fresh = new FasterCompactionEngine(h.ctx, { headroomTokens: 100, safetyMarginTokens: 50, retainTokens: 100 })
  fresh.trace = new TraceJournal({ directory: null })
  fresh.summarize = async () => envelope()
  const result = await fresh.compactIfNeeded(h.agent, 'pressure', h.turn.signal)
  assert.ok(result)
  assert.equal(h.records().length, 3)
})

test('trace distinguishes prepared from applied without changing the session log', async () => {
  const h = harness()
  const before = h.session.seq
  await h.compact()
  const prepared = await h.engine.trace.read(h.session.id)
  assert.equal(prepared[0].status, 'ready')
  assert.equal(prepared[0].summary, 'summary')
  assert.equal(h.session.seq, before)
  h.append()
  await h.compact()
  const result = projectTrace(h.session.snapshotEvents(), await h.engine.trace.read(h.session.id))
  assert.equal(result.records[0].status, 'applied')
  assert.equal(result.records[0].mode, 'background')
  assert.ok(result.records[0].generationMs >= 0)
  assert.ok(result.records[0].waitMs >= 0)
  assert.ok(result.records[0].checkpointSeq >= 0)
})

test('failed warmup stays diagnostic and does not change successful application', async () => {
  const h = harness()
  h.ctx.llm.stream = async function* () { throw new Error('provider unavailable; token=secret') }
  await h.compact()
  h.tool()
  await setImmediate()
  h.append()
  await h.compact()
  const result = projectTrace(h.session.snapshotEvents(), await h.engine.trace.read(h.session.id)).records[0]
  assert.equal(result.status, 'applied')
  assert.equal(result.warmup.status, 'failed')
  assert.ok(!result.warmup.error.includes('secret'))
})

function route(h, config) {
  h.session.append('request/header', { reason: 'change', header: {
    config: Object.fromEntries(Object.entries({ provider: 'test', model: 'test', maxTokens: 0, ...config }).filter(([, value]) => value !== undefined)),
  } })
}

function useStockSummary(h, requests) {
  delete h.engine.summarize
  h.ctx.llm.stream = async function* (request) {
    requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'summary' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'summary' } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 1, cacheReadTokens: 600 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('stock background summary and warmup inherit conversation effort, preserving their own token caps', async () => {
  const h = harness({ maxTokens: 90, warmupMaxTokens: 2 })
  const requests = []
  useStockSummary(h, requests)
  route(h, { reasoningEffort: 'medium' })
  await h.compact(); await setImmediate()
  h.tool(); await setImmediate()
  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map(request => request.reasoningEffort), ['medium', 'medium'])
  assert.deepEqual(requests.map(request => request.maxTokens), [90, 2])
  assert.equal(requests[0].purpose, 'compaction')
  assert.match(requests[0].messages.at(-1).content[0].text, /compaction engine/)
  const record = (await h.engine.trace.read(h.session.id))[0]
  assert.equal(record.summaryRequest.reasoningEffort, 'medium')
  assert.equal(record.warmup.usage.cacheReadTokens, 600)
})

for (const path of ['pressure', 'manual', 'context-overflow']) {
  test(`stock ${path} compaction also inherits reasoning without a pending summary`, async () => {
    const h = harness({ auto: false })
    const requests = []
    useStockSummary(h, requests)
    route(h, { reasoningEffort: 'low' })
    h.append()
    if (path === 'manual') {
      const nodes = h.session.surface.nodes
      await h.engine.compactRegion(nodes[0], nodes.at(-2), h.agent, h.turn.signal)
    } else await h.engine.compactIfNeeded(h.agent, path, h.turn.signal)
    assert.ok(requests.length > 0)
    assert.ok(requests.every(request => request.reasoningEffort === 'low'))
  })
}

test('different summary model retains its own defaults; explicit auxiliary effort is not overwritten', async () => {
  const h = harness({ summarizationProvider: 'other', summarizationModel: 'small' })
  const requests = []
  useStockSummary(h, requests)
  route(h, { reasoningEffort: 'medium' })
  await h.compact(); await setImmediate()
  assert.equal(requests[0].provider, 'other')
  assert.equal(requests[0].reasoningEffort, undefined)
  const explicit = Object.freeze({ provider: 'test', model: 'test', reasoningEffort: 'low' })
  assert.equal(inheritReasoning(explicit, h.session.requestHeader().config), explicit)
})

test('overlapping stock summaries snapshot each session effort without global stream mutation', async () => {
  const h = harness()
  delete h.engine.summarize
  route(h, { reasoningEffort: 'medium' })
  const second = Session.create('second', h.session.snapshotEvents())
  second.append('request/header', { reason: 'change', header: { config: { provider: 'test', model: 'test', reasoningEffort: 'low' } } })
  const gate = Promise.withResolvers(), requests = []
  h.ctx.llm.stream = async function* (options) {
    requests.push(options)
    await gate.promise
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'summary' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const originalStream = h.ctx.llm.stream
  const a = h.engine.summarize({ messages: h.session.deriveMessages() }, h.agent, h.turn.signal)
  const b = h.engine.summarize({ messages: second.deriveMessages() }, { session: second, options: {} }, h.turn.signal)
  route(h, { reasoningEffort: 'xhigh' })
  gate.resolve()
  await Promise.all([a, b])
  assert.deepEqual(requests.map(request => request.reasoningEffort), ['medium', 'low'])
  assert.equal(h.ctx.llm.stream, originalStream)
})

for (const change of ['reasoning', 'model', 'tools', 'system']) {
  test(`a ${change} change invalidates warmup without discarding the prepared summary`, async () => {
    const h = harness()
    route(h, { reasoningEffort: 'medium' })
    if (change === 'system') {
      const first = h.session.surface.nodes[0]
      h.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('s'.repeat(100)) }, { surfaceOp: { op: 'replace', startSeq: first, endSeq: first }, sourceEventSeqs: [first] })
    }
    h.ctx.llm.stream = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }
    await h.compact(); h.tool(); await setImmediate()
    assert.equal((await h.engine.trace.read(h.session.id))[0].warmup.status, 'completed')
    if (change === 'tools') h.session.append('request/header', { reason: 'change', header: {
      config: h.session.requestHeader().config, tools: [{ name: 'newTool', description: 'test', parameters: { type: 'object', properties: {} } }],
    } })
    else if (change === 'system') {
      const first = h.session.surface.nodes[0]
      h.session.append('system/message', { turn: 1, step: 2, message: createSystemMessage('t'.repeat(100)) }, { surfaceOp: { op: 'replace', startSeq: first, endSeq: first }, sourceEventSeqs: [first] })
    } else route(h, change === 'reasoning' ? { reasoningEffort: 'low' } : { model: 'different', reasoningEffort: 'medium' })
    h.tool(); await setImmediate()
    assert.equal((await h.engine.trace.read(h.session.id))[0].warmup.status, 'stale')
    h.append()
    assert.ok(await h.compact())
    assert.equal(h.summaries.length, 1)
  })
}

test('warmup protocol errors are failures, and stale running warmup ignores late completion', async () => {
  const h = harness()
  h.ctx.llm.stream = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider failed' } } } }
  await h.compact(); h.tool(); await setImmediate()
  assert.equal((await h.engine.trace.read(h.session.id))[0].warmup.status, 'failed')
  const g = harness(), gate = Promise.withResolvers()
  route(g, { reasoningEffort: 'medium' })
  let signal
  g.ctx.llm.stream = async function* (options) { signal = options.signal; await gate.promise; yield { type: 'finish', reason: { kind: 'stop' } } }
  await g.compact(); g.tool(); await setImmediate()
  route(g, { reasoningEffort: 'low' }); g.tool()
  assert.equal(signal.aborted, true)
  gate.resolve(); await setImmediate()
  assert.equal((await g.engine.trace.read(g.session.id))[0].warmup.status, 'stale')
})

// Exercise the new defaults explicitly; older cases above retain custom early
// preparation and opt-in warming to cover existing saved configurations.
function defaultFlow(config = {}) { return harness(FasterCompactionEngine.Config({ safetyMarginTokens: 50, ...config })) }

test('defaults start at the stock threshold and apply at the next boundary without warming', async () => {
  const h = defaultFlow()
  assert.equal(await h.compact(), null) // 700 < 800
  h.tool(); await setImmediate()
  assert.equal(h.summaries.length, 0)
  h.append(100)
  assert.equal(await h.compact(), null) // launch at exactly 800
  const seq = h.session.seq
  await setImmediate()
  assert.equal(h.summaries.length, 1)
  assert.equal(h.session.seq, seq, 'completion alone cannot replace an active request prefix')
  let warmups = 0
  h.ctx.llm.stream = async function* () { warmups += 1 }
  h.tool(); await setImmediate()
  const tail = h.append(10)
  assert.ok(await h.compact()) // ready, even though well below the 950 wait line
  assert.equal(warmups, 0)
  assert.ok(h.session.surface.nodes.includes(tail.seq))
  const record = (await h.engine.trace.read(h.session.id))[0]
  assert.equal(record.eagerTokens, 800)
  assert.equal(record.waitTokens, 950)
  assert.equal(record.status, 'applied')
})

test('custom early preparation applies when ready even below the stock threshold', async () => {
  const h = defaultFlow({ eagerRatio: 0.85 })
  await h.compact()
  assert.equal(h.ctx.tokenMeter.measure().totalTokens, 700)
  assert.ok(await h.compact())
  assert.equal(h.summaries.length, 1)
})

test('unfinished summary lets the task continue until the safety line, then waits', { timeout: 2000 }, async t => {
  const h = defaultFlow(), gate = Promise.withResolvers()
  t.after(() => gate.resolve(envelope()))
  h.engine.summarize = () => gate.promise
  h.append(100)
  assert.equal(await h.compact(), null)
  h.append(149)
  assert.equal(await h.compact(), null) // 949 < 950: main request may proceed
  h.append(1)
  let finished = false
  const waiting = h.compact().then(result => { finished = true; return result })
  await setImmediate()
  assert.equal(finished, false)
  assert.equal((await h.engine.trace.read(h.session.id))[0].status, 'waiting')
  gate.resolve(envelope())
  assert.ok(await waiting)
  assert.ok(h.ctx.tokenMeter.measure().totalTokens < 800)
})

test('a fresh engine at the safety line uses stock compaction without background work', async () => {
  const h = defaultFlow()
  h.append(250)
  assert.ok(await h.compact())
  assert.equal(h.summaries.length, 1)
  assert.equal((await h.engine.trace.read(h.session.id))[0].mode, 'native')
})

test('failed background preparation falls back below the safety line without a restart loop', async () => {
  const h = defaultFlow()
  let calls = 0
  h.engine.summarize = async () => {
    if (++calls === 1) throw new Error('background failed')
    return envelope()
  }
  h.append(100)
  await h.compact(); await setImmediate()
  h.tool(); await setImmediate()
  assert.equal(calls, 1, 'tool events must not repeatedly launch failed preparation')
  assert.ok(await h.compact())
  assert.equal(calls, 2)
  assert.equal((await h.engine.trace.read(h.session.id))[0].status, 'failed')
})

test('a smaller routed window is rechecked before allowing further progress', async () => {
  const h = defaultFlow(), gate = Promise.withResolvers()
  h.engine.summarize = async (_input, _agent, signal) => {
    if (signal.aborted) throw signal.reason
    return gate.promise
  }
  h.append(100)
  await h.compact()
  route(h, { maxTokens: 150 }) // wait line drops from 950 to 800
  let finished = false
  const waiting = h.compact().then(result => { finished = true; return result })
  await setImmediate()
  assert.equal(finished, false)
  gate.resolve(envelope())
  assert.ok(await waiting)
})

test('concurrency saturation defers within the budget and falls back at the safety line', async t => {
  const h = defaultFlow(), gate = Promise.withResolvers()
  t.after(() => gate.resolve(envelope()))
  let calls = 0
  h.engine.summarize = async () => ++calls === 1 ? gate.promise : envelope()
  h.append(100)
  await h.compact() // occupies the sole background slot
  const second = Session.create('saturated', h.session.snapshotEvents())
  const agent = { session: second, options: {} }
  assert.equal(await h.engine.compactIfNeeded(agent, 'pressure', h.turn.signal), null)
  assert.equal(calls, 1)
  second.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(150) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  assert.ok(await h.engine.compactIfNeeded(agent, 'pressure', h.turn.signal))
  assert.equal(calls, 2, 'safety fallback does not wait for another session to free a background slot')
  gate.resolve(envelope())
  await setImmediate()
  assert.ok(await h.compact())
})

test('ready summary never waits for optional warmup before committing', async t => {
  const h = defaultFlow({ warmup: true }), gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  let warmSignal
  h.ctx.llm.stream = async function* (options) { warmSignal = options.signal; await gate.promise }
  h.append(100)
  await h.compact()
  h.tool(); await setImmediate()
  assert.equal(warmSignal.aborted, false)
  assert.ok(await h.compact())
  assert.equal(warmSignal.aborted, true, 'unfinished optional warmup must not delay the real request')
  gate.resolve()
  await setImmediate()
})


test('the inherited pre-step waterfall continues during preparation and waits at the safety limit', async () => {
  const h = defaultFlow(), gate = Promise.withResolvers()
  h.engine.summarize = () => gate.promise
  let requests = 0
  const next = () => { requests += 1 }
  h.append(100)
  await h.step(next)
  assert.equal(requests, 1)
  assert.equal(h.records().length, 0)
  h.append(150)
  const waiting = h.step(next)
  await setImmediate()
  assert.equal(requests, 1, 'no main request before the summary is applied')
  gate.resolve(envelope())
  await waiting
  assert.equal(requests, 2)
  assert.equal(h.records().filter(event => event.type === 'compaction/end').length, 1)
})

test('failed custom early preparation is not restarted on each step below the stock threshold', async () => {
  const h = defaultFlow({ eagerRatio: 0.85 })
  let calls = 0
  h.engine.summarize = async () => {
    if (++calls === 1) throw new Error('background failed')
    return envelope()
  }
  await h.compact(); await setImmediate()
  assert.equal(await h.compact(), null)
  assert.equal(await h.compact(), null)
  h.tool(); await setImmediate()
  assert.equal(calls, 1)
  h.append(100)
  assert.ok(await h.compact())
  assert.equal(calls, 2)
})

test('unknown output reservation does not grant background headroom', async () => {
  const h = defaultFlow()
  route(h, { maxTokens: undefined })
  h.append(100)
  assert.ok(await h.compact(), 'uses native synchronous compaction at its threshold')
  assert.equal(h.summaries.length, 1)
  assert.equal((await h.engine.trace.read(h.session.id)).some(r => r.mode === 'background'), false)
})

test('explicit output floor supplies missing metadata without modifying generation parameters', async () => {
  const h = defaultFlow({ outputReserveTokens: 100 })
  route(h, { maxTokens: undefined })
  h.append(100)
  assert.equal(await h.compact(), null)
  const record = (await h.engine.trace.read(h.session.id))[0]
  assert.equal(record.reservedCompletion, 100)
  assert.equal(record.inputLimit, 900)
  assert.equal(record.waitTokens, 850)
  assert.equal(h.session.requestHeader().config.maxTokens, undefined)
})

test('a declared larger output cap always takes priority over the reservation floor', async () => {
  const h = defaultFlow({ outputReserveTokens: 50 })
  route(h, { maxTokens: 100 })
  h.append(100)
  await h.compact()
  assert.equal((await h.engine.trace.read(h.session.id))[0].reservedCompletion, 100)
})

test('a selected surface replacement immediately aborts unfinished work', async () => {
  const h = defaultFlow(), gate = Promise.withResolvers()
  let preparationSignal
  h.engine.summarize = async (_input, _agent, signal) => { preparationSignal = signal; return gate.promise }
  h.append(100)
  await h.compact()
  const first = h.session.surface.nodes[0]
  h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'changed' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: first, endSeq: first }, sourceEventSeqs: [first] })
  assert.equal(preparationSignal.aborted, true)
  assert.equal((await h.engine.trace.read(h.session.id))[0].reason, 'stale')
  gate.resolve(envelope())
  await setImmediate()
  assert.equal(h.records().length, 0)
})

test('invalid output/safety budgets stop before issuing another model request', async () => {
  const h = defaultFlow({ outputReserveTokens: 1000 })
  await assert.rejects(h.compact(), /invalid context\/output\/safety\/retention budget/)
  assert.equal(h.summaries.length, 0)
})

test('native policy cannot silently bypass a tighter plugin safety limit', async () => {
  const h = defaultFlow({ thresholdRatio: 0.99, headroomTokens: 100, safetyMarginTokens: 300 })
  await assert.rejects(h.compact(), /native fallback did not reduce input below the safety limit/)
})

for (const readyBeforeEnd of [false, true]) {
  test(`normal turn completion preserves ${readyBeforeEnd ? 'ready' : 'running'} summary for the next turn`, async () => {
    const h = harness({ warmup: false })
    const generated = Promise.withResolvers()
    let calls = 0, signal
    h.engine.summarize = (_input, _agent, nextSignal) => {
      calls += 1; signal = nextSignal
      return generated.promise
    }
    await h.compact()
    if (readyBeforeEnd) { generated.resolve(envelope()); await setImmediate() }
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    h.emit('agent/status', { agent: h.agent, status: 'idle' })
    h.turn.abort() // cleanup of an old turn must not kill retained work
    assert.equal(signal.aborted, false)
    generated.resolve(envelope())
    await setImmediate()
    assert.equal((await h.engine.trace.read(h.session.id))[0].status, 'ready')
    assert.equal(h.records().length, 0, 'completion alone cannot commit')
    h.session.append('turn/start', { turn: 2 })
    const tail = h.append(25)
    await h.compact(new AbortController().signal)
    assert.equal(calls, 1)
    assert.equal(h.records().filter(e => e.type === 'compaction/summary').length, 1)
    assert.ok(h.session.surface.nodes.includes(tail.seq))
    h.dispose()
  })
}

for (const lifecycle of ['idle', 'disposed', 'turn-end', 'unload']) {
  test(`late capacity resolution cannot admit work after ${lifecycle}`, async () => {
    const h = harness({ warmup: false })
    const info = Promise.withResolvers()
    h.ctx.llm.resolveModelInfo = () => info.promise
    h.tool()
    if (lifecycle === 'idle') h.emit('agent/status', { agent: h.agent, status: 'idle' })
    if (lifecycle === 'disposed') h.emit('agent/disposed', { agent: h.agent })
    if (lifecycle === 'turn-end') h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    if (lifecycle === 'unload') h.dispose()
    info.resolve({ context: { contextWindow: 1000 } })
    await setImmediate()
    assert.equal(h.summaries.length, 0)
    h.dispose()
  })
}

test('adapter invalidation during resolution cannot repopulate old capacity', async () => {
  const h = harness({ warmup: false })
  const stale = Promise.withResolvers()
  let calls = 0
  h.ctx.llm.resolveModelInfo = () => ++calls === 1 ? stale.promise : Promise.resolve({ context: { contextWindow: 1100 } })
  h.tool()
  h.emit('llm/adapters-updated')
  stale.resolve({ context: { contextWindow: 1000 } })
  await setImmediate()
  assert.equal(calls, 2)
  // 700 tokens is below the new preparation line (748).
  assert.equal(h.summaries.length, 0)
  h.append(100)
  await h.compact()
  assert.equal((await h.engine.trace.read(h.session.id))[0].contextWindow, 1100)
  assert.equal(calls, 2)
  h.dispose()
})

test('an old admission cannot restart work after idle followed immediately by a new turn', async () => {
  const h = harness({ warmup: false })
  const info = Promise.withResolvers()
  h.ctx.llm.resolveModelInfo = () => info.promise
  h.tool()
  h.emit('agent/status', { agent: h.agent, status: 'idle' })
  h.emit('session/event', h.session, { type: 'turn/start' })
  info.resolve({ context: { contextWindow: 1000 } })
  await setImmediate()
  assert.equal(h.summaries.length, 0)
  await h.compact(new AbortController().signal)
  assert.equal(h.summaries.length, 1)
  h.dispose()
})

test('explicit cancellation of a resumed turn aborts its retained summary', async () => {
  const h = harness({ warmup: false })
  const generated = Promise.withResolvers()
  let signal
  h.engine.summarize = (_input, _agent, value) => { signal = value; return generated.promise }
  await h.compact()
  h.emit('agent/status', { agent: h.agent, status: 'idle' })
  const next = new AbortController()
  await h.compact(next.signal)
  next.abort()
  assert.equal(signal.aborted, true)
  generated.resolve(envelope())
  await setImmediate()
  assert.equal(h.records().length, 0)
  h.dispose()
})

test('idle retention is bounded and unload releases all retained preparations', async () => {
  const h = harness({ warmup: false })
  for (let index = 0; index < 25; index++) {
    const other = harness({ auto: false, warmup: false }, `retained-${index}`)
    h.emit('agent/created', { agent: other.agent })
    await h.engine.compactIfNeeded(other.agent, 'pressure', other.turn.signal)
    await setImmediate()
    h.emit('agent/status', { agent: other.agent, status: 'idle' })
    other.dispose()
  }
  assert.equal(h.summaries.length, 25)
  assert.equal((await h.engine.trace.read('retained-0'))[0].reason, 'retention-limit')
  assert.equal((await h.engine.trace.read('retained-1'))[0].status, 'ready')
  assert.equal((await h.engine.trace.read('retained-24'))[0].status, 'ready')
  h.dispose()
  assert.ok(h.summaries.every(call => call.signal.aborted))
  assert.equal((await h.engine.trace.read('retained-24'))[0].reason, 'unloaded')
})

test('tail replacements avoid whole-surface pricing but commit still rejects repriced selections', async () => {
  const h = harness({ warmup: false })
  await h.compact()
  await setImmediate()
  const measure = h.ctx.tokenMeter.measure
  let measurements = 0
  h.ctx.tokenMeter.measure = (...args) => { measurements++; return measure(...args) }
  const tail = h.session.surface.nodes.at(-1)
  h.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new tail' }], source: { kind: 'user' } }), {
    surfaceOp: { op: 'replace', startSeq: tail, endSeq: tail }, sourceEventSeqs: [tail],
  })
  assert.equal(measurements, 0)
  assert.equal((await h.engine.trace.read(h.session.id))[0].status, 'ready')
  // A price change outside an event still cannot evade the commit-time check.
  h.ctx.tokenMeter.measure = (...args) => {
    const result = measure(...args)
    result.nodes[0].tokens += 1
    return result
  }
  await h.compact()
  assert.equal(h.records().length, 0)
  assert.equal((await h.engine.trace.read(h.session.id))[0].reason, 'stale')
  h.dispose()
})

test('a stale metadata failure does not create a new diagnostic after disposal', async () => {
  const h = harness({ warmup: false })
  const info = Promise.withResolvers()
  h.ctx.llm.resolveModelInfo = () => info.promise
  h.tool()
  h.emit('agent/disposed', { agent: h.agent })
  info.reject(new Error('late adapter failure'))
  await setImmediate()
  assert.deepEqual(await h.engine.trace.read(h.session.id), [])
  h.dispose()
})

test('route changes during metadata resolution are priced against the new route', async () => {
  const h = harness({ warmup: false })
  const old = Promise.withResolvers(), resolved = []
  h.ctx.llm.resolveModelInfo = (_provider, model) => {
    resolved.push(model)
    return model === 'test' ? old.promise : Promise.resolve({ context: { contextWindow: 1100 } })
  }
  h.tool()
  route(h, { model: 'new' })
  old.resolve({ context: { contextWindow: 1000 } })
  await setImmediate()
  assert.deepEqual(resolved, ['test', 'new'])
  assert.equal(h.summaries.length, 0)
  h.append(100)
  await h.compact()
  assert.equal((await h.engine.trace.read(h.session.id))[0].contextWindow, 1100)
  assert.equal(h.session.requestHeader().config.model, 'new')
  h.dispose()
})

test('normal completion cancels optional warmup without discarding the ready summary', async () => {
  const h = harness({ warmup: true })
  const stopped = Promise.withResolvers()
  let warmSignal
  h.ctx.llm.stream = async function* (request) {
    warmSignal = request.signal
    await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
    stopped.resolve()
  }
  await h.compact()
  await setImmediate()
  h.tool()
  assert.ok(warmSignal)
  h.emit('agent/status', { agent: h.agent, status: 'idle' })
  await stopped.promise
  await setImmediate()
  assert.equal(warmSignal.aborted, true)
  const record = (await h.engine.trace.read(h.session.id))[0]
  assert.equal(record.status, 'ready')
  assert.equal(record.warmup.status, 'cancelled')
  await h.compact(new AbortController().signal)
  assert.equal(h.summaries.length, 1)
  assert.equal(h.records().filter(e => e.type === 'compaction/summary').length, 1)
  h.dispose()
})
