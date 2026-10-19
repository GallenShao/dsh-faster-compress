import * as presets from '@deepseek-ai/dsh-agent-preset-registry'
import * as scopes from '@deepseek-ai/dsh-scope'
import { symbols } from '@deepseek-ai/cordis'

/** DSH 0.2.1 moved service lookup onto the registry instance. */
export function serviceForAgent(ctx, agent, name) {
  const service = typeof ctx.agentPresets.serviceFor === 'function'
    ? ctx.agentPresets.serviceFor(agent, name)
    : presets.serviceForAgent?.(ctx, agent, name)
  // Registry calls return a Cordis consumer proxy; replacement must retain the
  // provider's context (and private class fields), not the host caller's realm.
  return service?.[symbols.original] ?? service
}

/** Keep revision identity available while its backend is being replaced. */
export function presetKeyForAgent(ctx, agent) {
  if (typeof presets.standingMountFor === 'function') return presets.standingMountFor(agent.ctx)?.fiber
  if (!ctx.agentPresets.composedPreset?.(agent.ctx)) return undefined
  const key = scopes.scopeOf(agent.ctx)
  return key === undefined ? undefined : scopes.scopeParentOf?.(key)
}

/** Locate the bound backend's Loader tree without reading registry internals. */
export function mountForAgent(ctx, agent) {
  if (typeof presets.standingMountFor === 'function') return presets.standingMountFor(agent.ctx)
  const presetId = ctx.agentPresets.composedPreset?.(agent.ctx)
  if (!presetId) return undefined
  const backend = serviceForAgent(ctx, agent, 'compaction')
  const entry = backend?.ctx?.fiber?.entry
  const tree = entry?.parent?.tree
  const key = presetKeyForAgent(ctx, agent)
  // Only the live tree belonging to this exact preset scope can be modified.
  if (!tree || key === undefined || scopes.scopeOf(tree.ctx) !== key
    || tree.store[entry.options.id] !== entry) return undefined
  return { presetId, tree, fiber: tree.ctx.fiber }
}
