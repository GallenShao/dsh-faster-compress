import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgets, policyFor } from '../src/budgets.js'

/** A default policy with the shipped defaults plus this bundle's eagerRatio. */
const base = {
  thresholdRatio: 0.8,
  headroomTokens: 32768,
  retainRatio: 0.16,
  eagerRatio: 0.85,
  modelPolicies: [],
}

test('threshold is the smaller of the window fraction and the budget minus headroom', () => {
  // window 131072, reserved 8192 -> message budget 122880
  // window fraction 104857.6 vs budget minus headroom 90112 -> headroom wins
  assert.deepEqual(budgets(base, 131072, 8192), {
    thresholdTokens: 90112,
    eagerTokens: 76595,
    retainTokens: 19660,
  })

  // A small headroom lets the window fraction decide instead.
  const smallHeadroom = { ...base, headroomTokens: 1024 }
  assert.equal(budgets(smallHeadroom, 131072, 8192).thresholdTokens, 104857)
})

test('eager threshold sits below the commit threshold', () => {
  const budget = budgets(base, 131072, 8192)
  assert.ok(budget.eagerTokens < budget.thresholdTokens)
  assert.equal(budget.eagerTokens, Math.floor(budget.thresholdTokens * base.eagerRatio))
})

test('an eagerRatio of 1 defers generation to the commit threshold', () => {
  const budget = budgets({ ...base, eagerRatio: 1 }, 131072, 8192)
  assert.equal(budget.eagerTokens, budget.thresholdTokens)
})

test('an explicit retainTokens budget replaces the ratio', () => {
  const budget = budgets({ ...base, retainRatio: undefined, retainTokens: 5000 }, 131072, 8192)
  assert.equal(budget.retainTokens, 5000)
})

test('a window too small for the reservation yields a non-positive threshold', () => {
  // 65536 window, 65536 reserved output, 65536 headroom: nothing is left.
  // The inherited backend reports this as a configuration error; the caller
  // must not read it as "never needs compaction".
  const budget = budgets({ ...base, headroomTokens: 65536 }, 65536, 65536)
  assert.ok(budget.thresholdTokens <= 0, 'expected a degenerate threshold')
})

test('policyFor returns the default policy when no target matches', () => {
  const config = { ...base, modelPolicies: [{ provider: 'p', model: 'other', thresholdRatio: 0.5 }] }
  assert.equal(policyFor(config, { provider: 'p', model: 'm' }), config)
})

test('policyFor replaces only the fields an override states', () => {
  const config = {
    ...base,
    modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.6, retainTokens: 4096 }],
  }
  const policy = policyFor(config, { provider: 'p', model: 'm' })
  assert.equal(policy.thresholdRatio, 0.6)
  assert.equal(policy.retainTokens, 4096)
  assert.equal(policy.retainRatio, undefined, 'absolute retention replaces the inherited ratio')
  assert.equal(policy.headroomTokens, base.headroomTokens, 'unstated fields keep the default')
  assert.equal(policy.eagerRatio, base.eagerRatio, 'eagerRatio is not overridable per target')
})

test('a per-model ratio replaces inherited absolute retention without mutating defaults', () => {
  const config = {
    ...base, retainRatio: undefined, retainTokens: 500,
    modelPolicies: [{ provider: 'p', model: 'm', retainRatio: 0.1 }],
  }
  const policy = policyFor(config, { provider: 'p', model: 'm' })
  assert.equal(policy.retainTokens, undefined)
  assert.equal(budgets(policy, 1000, 0).retainTokens, 100)
  assert.equal(config.retainTokens, 500)
})

test('per-target thresholds follow the override', () => {
  const config = { ...base, modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.5 }] }
  const policy = policyFor(config, { provider: 'p', model: 'm' })
  assert.equal(budgets(policy, 131072, 8192).thresholdTokens, 65536)
})
