/**
 * Pressure budgets and policy resolution.
 *
 * These formulas separate background preparation and waiting from the native
 * synchronous compaction threshold. Policy resolution follows the upstream
 * basic backend; background timing deliberately uses its own capacity rules.
 *
 * This module is deliberately free of imports so its arithmetic can be tested
 * without a session, a model, or a harness.
 *
 * @module dsh-faster-compress/budgets
 */

/**
 * @typedef {object} Policy
 * @property {number} thresholdRatio Window fraction for the preparation threshold.
 * @property {number} headroomTokens Preparation headroom; half is held between preparation and input limit.
 * @property {number} [retainRatio] Recent tail retained verbatim, as a fraction of the message budget.
 * @property {number} [retainTokens] Recent tail retained verbatim, as an absolute budget.
 * @property {number} eagerRatio Fraction of the preparation threshold at which a summary is prepared.
 * @property {readonly Record<string, any>[]} modelPolicies Exact-target overrides.
 */

/**
 * @typedef {object} Budget
 * @property {number} thresholdTokens Preparation threshold before applying eagerRatio.
 * @property {number} eagerTokens Pressure at which a summary is generated in the background.
 * @property {number} waitTokens Pressure at which unfinished preparation blocks the next request.
 * @property {number} retainTokens Recent tail kept verbatim by a compaction.
 */

/** Fields an exact-target override may replace. */
const OVERRIDABLE = Object.freeze([
  'thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens',
  'summarizationProvider', 'summarizationModel', 'maxTokens',
  'compactionRetries', 'maxOverflowRetries',
])

/**
 * Merge the exact-target policy for one route over the default policy.
 *
 * Mirrors the field-by-field override performed by upstream
 * `resolveTargetPolicy`.
 *
 * @param {Policy} config Resolved backend config including `eagerRatio`.
 * @param {{ provider: string, model: string }} target Routed conversation target.
 * @returns {Policy} The policy that applies to `target`.
 */
export function policyFor(config, target) {
  const override = config.modelPolicies.find(
    item => item.provider === target.provider && item.model === target.model,
  )
  if (override === undefined) return config
  const merged = { ...config }
  for (const key of OVERRIDABLE) {
    if (override[key] !== undefined) merged[key] = override[key]
  }
  // Retention is one policy choice, not two independent numeric overrides.
  if (override.retainTokens !== undefined) delete merged.retainRatio
  else if (override.retainRatio !== undefined) delete merged.retainTokens
  return merged
}

/**
 * Derive the pressure budgets for one routed model.
 *
 * A preparation threshold at or below zero means the routed window cannot hold the
 * reserved output plus the configured headroom. That is a configuration error,
 * and the caller reports it; callers must not silently treat it as
 * "never compact".
 *
 * @param {Policy} policy Policy for the routed target.
 * @param {number} contextWindow Adapter-declared full context window.
 * @param {number} reservedCompletion Output tokens the routed request reserves.
 * @returns {Budget} Pressure and retention budgets.
 */
export function budgets(policy, contextWindow, reservedCompletion) {
  const messageBudget = contextWindow - reservedCompletion
  const waitTokens = Math.floor(messageBudget - (policy.safetyMarginTokens ?? 4096))
  const thresholdTokens = Math.floor(Math.min(
    waitTokens,
    contextWindow * policy.thresholdRatio,
    messageBudget - Math.ceil(policy.headroomTokens / 2),
  ))
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(messageBudget * policy.retainRatio)
    : policy.retainTokens
  return {
    thresholdTokens,
    eagerTokens: Math.floor(thresholdTokens * policy.eagerRatio),
    waitTokens,
    contextWindow,
    reservedCompletion,
    inputLimit: messageBudget,
    retainTokens,
  }
}
