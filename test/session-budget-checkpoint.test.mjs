import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '../dist/index.js';

const started = Date.parse('2026-10-20T13:00:00.000Z');
const usage = { totalTokens: null, costYen: null, outputTokens: 0 };
const ev = { id: 'source', kind: 'document', locator: 'local:source', sourceGroup: 'source', retrievedAt: new Date(started).toISOString(), version: '1', scope: 'test', passage: 'A source.', contentHash: sdk.hashPassage('A source.'), validity: 'current' };
const proposal = { claims: [{ id: 'claim', role: 'answer_claim', text: 'A bounded claim.', scope: 'test' }], lenses: [{ id: 'lens', label: 'Coverage', rationale: 'Check the claim.', origin: 'initial', status: 'active' }], gaps: [{ id: 'gap', lensId: 'lens', kind: 'unsupported_claim', question: 'Does the source cover it?', triggerRefs: ['claim'], whyItMatters: 'The answer depends on it.', importance: 'required', claimIds: ['claim'], probeIds: ['probe'] }], probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Read the source.', requiredCapability: 'read', sourceGroups: ['source'], successCondition: 'Supports it.', refutationCondition: 'Refutes it.', inconclusiveCondition: 'Unavailable.' }] };
async function initial(overrides = {}) {
  const task = { schemaVersion: '0.1', taskId: 'checkpoint', goal: 'Check the source.', mode: 'explain', successCriteria: ['Bounded evidence'], evidence: [ev], capabilities: ['read'], budget: { maxRounds: 2, maxModelCalls: 5, maxToolCalls: 2, maxElapsedMs: 1000, maxInputChars: 100000, maxOutputTokensPerCall: 2000, ...overrides } };
  let next = proposal;
  const api = sdk.createTombo({ now: () => started, adapter: { async generate() { return { proposal: next, usage }; } } });
  return { api, state: (await api.inspect(task)).state, set(value) { next = value; } };
}

test('non-generating checkpoint leaves a usable state byte-for-byte unchanged inside budget', async () => {
  const { state } = await initial();
  const before = structuredClone(state);
  assert.equal(typeof sdk.checkpointBudget, 'function', 'SDK exports checkpointBudget');
  const checked = sdk.checkpointBudget(state, { operation: 'update', now: started + 100 });
  assert.equal(checked.budgetCheckpoint.exhausted, false);
  assert.equal(checked.budgetCheckpoint.elapsedMs, 100);
  assert.deepEqual(checked.state, before);
  assert.deepEqual(state, before);
  assert.equal(sdk.understandingHash(checked.state), sdk.understandingHash(before));
});

test('expired checkpoint preserves understanding, accounting, start and original stop without generation', async () => {
  const { api, state } = await initial();
  const stopped = await api.update(state, [{ executionId: 'bad', probeId: 'missing', outcome: 'no_result', evidence: [], toolCalls: 0, elapsedMs: 0, costYen: null }]);
  assert.equal(stopped.state.stopReason, 'invalid_input');
  assert.equal(typeof sdk.checkpointBudget, 'function');
  const result = sdk.checkpointBudget(stopped.state, { now: started + 1500 });
  assert.equal(result.state.decision, 'blocked');
  assert.equal(result.state.stopReason, 'invalid_input');
  assert.equal(result.budgetCheckpoint.previousStopReason, 'invalid_input');
  assert.equal(result.budgetCheckpoint.exhausted, true);
  assert.equal(result.state.revision, stopped.state.revision + 1);
  assert.equal(result.state.usage.elapsedMs, 1500);
  assert.deepEqual({ ...result.state.usage, elapsedMs: 0 }, { ...stopped.state.usage, elapsedMs: 0 });
  assert.deepEqual(result.state.claims, stopped.state.claims);
  assert.deepEqual(result.state.evidence, stopped.state.evidence);
  assert.deepEqual(result.state.task, stopped.state.task);
  assert.equal(result.state.startedAt, stopped.state.startedAt);
  const back = sdk.checkpointBudget(result.state, { now: started + 500 });
  assert.equal(back.state.usage.elapsedMs, 1500);
  assert.equal(back.state.decision, 'blocked');
});

test('checkpoint works on redacted pending state and respects update versus reflection round budgets', async t => {
  const { api, state, set } = await initial({ maxRounds: 1 });
  const obs = [{ executionId: 'read', probeId: 'probe', outcome: 'completed', evidence: [ev], toolCalls: 1, elapsedMs: 1, costYen: null }];
  const pending = await api.update(state, obs, { deferAssessment: true });
  const directory = await mkdtemp(join(tmpdir(), 'tombo-checkpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new sdk.FileJournal(join(directory, 'events.jsonl'));
  await journal.commit(-1, pending.state);
  const redacted = await journal.load();
  assert.equal(typeof sdk.checkpointBudget, 'function');
  const expired = sdk.checkpointBudget(redacted, { now: started + 1001 });
  assert.deepEqual(expired.state.pendingAssessmentExecutionIds, ['read']);
  assert.equal(expired.state.evidence[0].passageUnavailable, true);
  assert.equal(expired.state.stopReason, 'assessment_pending');
  set({ assessments: [{ claimId: 'claim', evidenceIds: ['source'], verdict: 'supports', scopeMatched: true, reason: 'The source supports it.' }], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['source'], explanation: 'Checked.' }] });
  const complete = await api.update(pending.state, obs);
  assert.equal(complete.state.usage.rounds, 1);
  assert.equal(sdk.checkpointBudget(complete.state, { operation: 'update', now: started + 20 }).budgetCheckpoint.exhausted, true);
  assert.equal(sdk.checkpointBudget(complete.state, { operation: 'reflect', now: started + 20 }).budgetCheckpoint.exhausted, false);
});

test('checkpoint seals exhausted model-call limits and validates clock and operation inputs', async () => {
  const { state } = await initial({ maxModelCalls: 1 });
  assert.equal(typeof sdk.checkpointBudget, 'function');
  const result = sdk.checkpointBudget(state, { now: started });
  assert.equal(result.state.stopReason, 'budget_exhausted');
  assert.equal(result.state.usage.modelCalls, 1);
  assert.equal(result.state.usage.totalTokens, null);
  assert.throws(() => sdk.checkpointBudget(state, { now: NaN }), { code: 'invalid_input' });
  assert.throws(() => sdk.checkpointBudget(state, { operation: 'reset' }), { code: 'invalid_input' });
});

test('checkpoint checks pending actual usage without incorporating it twice into SDK accounting', async () => {
  const { state } = await initial({ maxToolCalls: 1 });
  const checked = sdk.checkpointBudget(state, { now: started, pendingUsage: { toolCalls: 2, costYen: null } });
  assert.equal(checked.budgetCheckpoint.exhausted, true);
  assert.equal(checked.state.stopReason, 'budget_exhausted');
  assert.deepEqual(checked.state.usage, state.usage);
});
