import { createHash } from 'node:crypto'

/** Only inherit template-affecting settings when the auxiliary target is the same model. */
export function inheritReasoning(options, conversation) {
  if (options.reasoningEffort !== undefined || conversation?.reasoningEffort === undefined
    || options.provider !== conversation.provider || options.model !== conversation.model) return options
  return { ...options, reasoningEffort: conversation.reasoningEffort }
}

export function requestRoute(options) {
  return { provider: options.provider, model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
  return value
}

/** Logical request identity, not a provider token hash or evidence of a cache hit. */
export function prefixFingerprint(options, count = options.messages.length) {
  if (!Number.isInteger(count) || count < 1 || options.messages.length < count) return null
  const messages = options.messages.slice(0, count).map(({ id, ...message }) => message)
  return createHash('sha256').update(JSON.stringify(canonical({ ...requestRoute(options),
    tools: options.tools ?? [], messages }))).digest('hex')
}

/** Keep unknown usage unknown, and persist only portable numeric counters. */
export function usageSnapshot(usage) {
  if (!usage) return undefined
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens']
  const values = Object.fromEntries(fields.filter(key => Number.isFinite(usage[key]) && usage[key] >= 0)
    .map(key => [key, usage[key]]))
  return Object.keys(values).length ? values : undefined
}
