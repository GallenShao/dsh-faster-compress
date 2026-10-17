// Only for an isolated DSH_HOME browser smoke test. Never shipped in the npm package.
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { setTimeout as pause } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { checkpointMessage } from '../../src/checkpoint.js'
import { commit } from '../../src/transaction.js'

export const inject = ['sessions', 'fasterCompressHost', 'llm']
export async function apply(ctx) {
  if (!process.env.DSH_HOME || process.env.DSH_TRACE_FIXTURE !== '1') throw new Error('Trace fixture requires an isolated DSH_HOME and DSH_TRACE_FIXTURE=1')
  const session = ctx.sessions.create(`trace-demo-${randomUUID()}`, { meta: { cwd: process.env.DSH_HOME } })
  session.append('session/title', { title: '压缩轨迹 · 联调样例（测试数据）' })
  session.append('turn/start', { turn: 1 })
  const text = '正在为订单服务补齐幂等性校验与回归测试。\n\n已检查路由、中间件与数据写入：同一请求重复提交时，先查幂等键，再返回先前的订单结果。测试覆盖并发请求、超时重试，以及失败后的再次提交。\n\n保留约束：不要修改对外接口；迁移脚本必须可回滚；请求记录不能包含访问凭据。'
  const a = session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const b = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '回归结果：重复请求只生成一条订单，写入失败不占用幂等键。下一步检查边界输入。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const journal = ctx.fasterCompressHost.trace
  const now = Date.now()
  const add = (id, patch, offset) => {
    journal.begin(session.id, { id, original: text, range: { start: a.seq, end: b.seq }, nodeCount: 24, inputTokens: 86400 })
    journal.update(session.id, id, { startedAt: now - offset, ...patch })
  }
  const summary1 = [{ type: 'text', text: '项目：订单服务幂等性改造。\n\n已完成\n• 路由层接收并校验幂等键，服务层保证写入与键登记的原子性。\n• 并发重试返回同一订单；写入失败允许安全重试。\n• 相关回归测试全部通过。\n\n下一步\n检查空键、过长键与跨账号复用，随后整理变更说明。\n\n约束\n保留现有接口，不记录敏感凭据，数据库迁移必须可回滚。' }]
  const first = 'demo-20261017-0001'
  add(first, { status: 'ready', summary: summary1[0].text, generationMs: 12480, waitMs: 142, outputTokens: 1250,
    readyAt: now - 150000, warmup: { status: 'completed', durationMs: 820 }, provider: 'demo-provider', model: 'demo-model' }, 180000)
  const perform = (id, selection, summary) => commit(session, {
    compactionId: id, selection, checkpoint: checkpointMessage(summary, id), summary, rawOutput: summary,
    provider: 'demo-provider', model: 'demo-model', turn: 1,
  })
  perform(first, { start: a.seq, end: b.seq, seqs: [a.seq, b.seq], heuristicTokens: 86400 }, summary1)
  const checkpoint = session.surface.nodes[0]
  const second = 'demo-20261017-0002'
  add(second, { status: 'ready', summary: summary1[0].text, generationMs: 8420, waitMs: 0, outputTokens: 982,
    readyAt: now - 60000, warmup: { status: 'completed', durationMs: 480 } }, 90000)
  ctx.fasterCompressHost.responses.beginBlocking(session, 'pressure')
  perform(second, { start: checkpoint, end: checkpoint, seqs: [checkpoint], heuristicTokens: 1240 }, summary1)
  ctx.fasterCompressHost.responses.endBlocking(session)
  // Exercise the real llm/stream waterfall without contacting any provider.
  ctx.on('llm/stream', (options, next) => options.provider === 'faster-trace-fixture'
    ? (async function* () {
      await pause(40)
      yield { type: 'reasoning-delta', index: 0, text: '检查边界条件。' }
      await pause(80)
      yield { type: 'text-delta', index: 1, text: '回归检查完成。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() : next())
  for await (const chunk of ctx.llm.stream(markAgentLoopRequest(Object.freeze({
    sessionId: session.id, provider: 'faster-trace-fixture', model: 'demo-model',
    messages: session.deriveMessages(),
  })))) {}
  add('demo-20261017-0003', { status: 'discarded', reason: 'stale', summary: '这个摘要对应的历史片段已经变化，因此不会提交。', generationMs: 3890, provider: 'demo-provider', model: 'demo-model' }, 45000)
  add('demo-20261017-0004', { status: 'failed', reason: 'summary', error: 'Provider returned 503: temporarily unavailable. Retry after 3 seconds.', generationMs: 1300, provider: 'demo-provider', model: 'demo-model' }, 20000)
  add('demo-20261017-0005', { status: 'ready', summary: summary1[0].text, generationMs: 11240,
    readyAt: now - 1000, provider: 'demo-provider', model: 'demo-model' }, 15000)
  session.append('turn/end', { turn: 1, reason: 'completed' })
  await journal.flush()
}
