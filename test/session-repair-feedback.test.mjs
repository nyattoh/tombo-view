import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTombo, hashPassage, validateState } from '../dist/index.js';

const run = (...args) => spawnSync(process.execPath, [resolve('skills/tombo-view/scripts/session.mjs'), ...args], { encoding: 'utf8' });
const claim = { id: 'answer', role: 'answer_claim', text: 'A bounded claim.', scope: 'test' };
const initial = { claims: [claim], lenses: [{ id: 'lens', label: 'Check', rationale: 'Read the source.', origin: 'initial', status: 'active' }], gaps: [{ id: 'gap', kind: 'unsupported_claim', lensId: 'lens', question: 'Does the source support it?', triggerRefs: ['answer'], whyItMatters: 'The claim needs evidence.', importance: 'required', claimIds: ['answer'], probeIds: ['probe'] }], probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Read the source.', requiredCapability: 'read_file', sourceGroups: ['source'], successCondition: 'Support.', refutationCondition: 'Refute.', inconclusiveCondition: 'Unknown.' }] };
const packet = { schemaVersion: '0.1', taskId: 'session-repair', goal: 'Check the claim.', mode: 'explain', successCriteria: ['Check the supplied source.'], evidence: [], capabilities: ['read_file'], budget: { maxRounds: 4, maxModelCalls: 10, maxToolCalls: 2, maxElapsedMs: 60000, maxInputChars: 100000, maxOutputTokensPerCall: 1000 } };
const usage = { totalTokens: 4, outputTokens: 2, costYen: 0 };
const observation = { executionId: 'read-1', probeId: 'probe', outcome: 'completed', toolCalls: 1, elapsedMs: 2, costYen: 0, evidence: [{ id: 'e-source', kind: 'document', locator: 'fixture:source', sourceGroup: 'source', retrievedAt: '2026-10-14T00:00:00.000Z', version: '1', scope: 'test', passage: 'Supports.', contentHash: hashPassage('Supports.'), validity: 'current' }] };
const valid = { assessments: [{ claimId: 'answer', evidenceIds: ['e-source'], verdict: 'supports', scopeMatched: true, reason: 'The source supports the claim.' }], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['e-source'], explanation: 'The source supports it.' }] };
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-session-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sdk = createTombo({ maxModelRepairAttempts: 1, adapter: { async generate(input) { return { proposal: input.operation === 'inspect' ? initial : { claims: [claim] }, usage }; } } });
  const inspected = await sdk.inspect(packet);
  const failed = await sdk.update(inspected.state, [observation]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  const state = join(dir, 'state.json'), observations = join(dir, 'observations.json'), plan = join(dir, 'plan.json');
  await writeFile(state, JSON.stringify(failed));
  await writeFile(observations, JSON.stringify([observation]));
  return { dir, state, observations, plan, failed, inspected };
}

test('prepare binds bounded SDK rejection feedback to exact pending state and observations', async t => {
  const ctx = await setup(t);
  const prepared = run('prepare', '--state', ctx.state, '--observations', ctx.observations);
  assert.equal(prepared.status, 0, prepared.stderr);
  const context = JSON.parse(prepared.stdout);
  assert.deepEqual(context.request.validationFeedback, { code: 'invalid_model_output', message: 'Existing entity cannot be overwritten answer', rejectedAttempt: 2, maxAttempts: 2 });
  assert.equal(context.apiCallsMade, 0);
  assert.deepEqual(context.hostUsage, { totalTokens: null, costYen: null });
  await writeFile(ctx.plan, JSON.stringify({ binding: context.binding, proposal: valid }));
  const corrected = run('update', '--state', ctx.state, '--observations', ctx.observations, '--proposal', ctx.plan);
  assert.equal(corrected.status, 0, corrected.stderr);
  const result = JSON.parse(corrected.stdout);
  assert.equal(result.state.claims[0].status, 'supported');
  assert.equal(result.state.gaps[0].status, 'resolved');
  assert.equal(result.state.usage.modelCalls, ctx.failed.state.usage.modelCalls + 1);
  assert.equal(result.state.usage.rounds, ctx.failed.state.usage.rounds + 1);
  assert.equal(result.state.usage.toolCalls, 1);
  assert.equal(result.state.startedAt, ctx.failed.state.startedAt);
  assert.equal(result.state.pendingAssessmentExecutionIds, undefined);
  assert.equal(result.apiCallsMade, 0);
  assert.deepEqual(result.hostUsage, { totalTokens: null, costYen: null });
  assert.equal(result.state.usage.totalTokens, null);
  assert.equal(result.state.usage.costYen, null);
  const successful = join(ctx.dir, 'successful.json');
  await writeFile(successful, JSON.stringify(result));
  const next = run('prepare', '--state', successful, '--observations', ctx.observations);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).request.validationFeedback, undefined);
});

test('prepare rejects missing, altered and mixed pending batches before host proposal generation', async t => {
  const ctx = await setup(t);
  for (const observations of [[], [{ ...observation, elapsedMs: 3 }], [observation, { ...observation, executionId: 'read-2' }]]) {
    await writeFile(ctx.observations, JSON.stringify(observations));
    const result = run('prepare', '--state', ctx.state, '--observations', ctx.observations);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'invalid_input');
    assert.equal(result.stdout, '');
  }
});

test('historical mismatched diagnostics stay report-only and changed diagnostics invalidate binding', async t => {
  const ctx = await setup(t);
  const prepared = JSON.parse(run('prepare', '--state', ctx.state, '--observations', ctx.observations).stdout);
  await writeFile(ctx.plan, JSON.stringify({ binding: prepared.binding, proposal: valid }));
  ctx.failed.state.modelRepairDiagnostics.at(-1).message = 'A different bounded validation failure';
  await writeFile(ctx.state, JSON.stringify(ctx.failed));
  const stale = run('update', '--state', ctx.state, '--observations', ctx.observations, '--proposal', ctx.plan);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stderr).error.code, 'revision_conflict');
  ctx.failed.state.modelRepairDiagnostics.at(-1).operation = 'reflect';
  await writeFile(ctx.state, JSON.stringify(ctx.failed));
  const context = run('prepare', '--state', ctx.state, '--observations', ctx.observations);
  assert.equal(context.status, 0, context.stderr);
  assert.equal(JSON.parse(context.stdout).request.validationFeedback, undefined);
});

test('helper applies a rejected cached proposal once and retains pending evidence', async t => {
  const ctx = await setup(t);
  const context = JSON.parse(run('prepare', '--state', ctx.state, '--observations', ctx.observations).stdout);
  await writeFile(ctx.plan, JSON.stringify({ binding: context.binding, proposal: { claims: [claim] } }));
  const applied = run('update', '--state', ctx.state, '--observations', ctx.observations, '--proposal', ctx.plan);
  assert.equal(applied.status, 1);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.state.stopReason, 'invalid_model_output');
  assert.equal(result.state.usage.modelCalls, ctx.failed.state.usage.modelCalls + 1);
  assert.equal(result.state.usage.toolCalls, 1);
  assert.deepEqual(result.state.pendingAssessmentExecutionIds, ['read-1']);
  assert.equal(result.state.evidence[0].id, 'e-source');
  assert.deepEqual(result.state.modelRepairDiagnostics, ctx.failed.state.modelRepairDiagnostics);
  assert.equal(result.apiCallsMade, 0);
  assert.deepEqual(result.hostUsage, { totalTokens: null, costYen: null });
});

test('failed inspect state cannot be silently resumed as a new inspect', async t => {
  const ctx = await setup(t);
  const sdk = createTombo({ maxModelRepairAttempts: 1, adapter: { async generate() { return { proposal: { claims: [claim, claim] }, usage }; } } });
  const failed = await sdk.inspect(packet);
  await writeFile(ctx.state, JSON.stringify(failed));
  const result = run('prepare', '--state', ctx.state);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'invalid_input');
  assert.match(JSON.parse(result.stderr).error.message, /inspect.*resume/i);
  assert.equal(validateState(failed.state).usage.modelCalls, 2);
});

test('prepare provides reflection feedback only for a current matching reflection stop', async t => {
  const ctx = await setup(t);
  const sdk = createTombo({ maxModelRepairAttempts: 1, adapter: { async generate() { return { proposal: { claims: [claim] }, usage }; } } });
  const first = await sdk.inspect({ ...packet, reflectionRequired: true });
  const failed = await sdk.reflect(first.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: [], completion: 'completed', limitations: [], proposal: {}, usage }; } });
  await writeFile(ctx.state, JSON.stringify(failed));
  const prepared = run('prepare', '--operation', 'reflect', '--state', ctx.state);
  assert.equal(prepared.status, 0, prepared.stderr);
  const context = JSON.parse(prepared.stdout);
  assert.equal(context.request.validationFeedback.message, 'Reflection claim coverage does not match current claims');
  assert.equal(context.request.binding.basedRevision, failed.state.revision);
});


test('historical inspect diagnostics do not prevent recovery of a later failed update', async t => {
  const ctx = await setup(t);
  let calls = 0;
  const sdk = createTombo({ maxModelRepairAttempts: 1, adapter: { async generate() { calls++; return { proposal: calls === 1 ? { claims: [claim, claim] } : initial, usage }; } } });
  const inspected = await sdk.inspect(packet);
  const failed = await createTombo({ adapter: { async generate() { return { proposal: { claims: [claim] }, usage }; } } }).update(inspected.state, [observation]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  assert.equal(failed.state.modelRepairDiagnostics.at(-1).operation, 'inspect');
  assert.deepEqual(failed.state.pendingAssessmentExecutionIds, ['read-1']);
  await writeFile(ctx.state, JSON.stringify(failed));
  const prepared = run('prepare', '--state', ctx.state, '--observations', ctx.observations);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).request.validationFeedback, undefined);
});

test('helper reflection correction applies once and overrides claimed host usage', async t => {
  const ctx = await setup(t);
  const sdk = createTombo({ maxModelRepairAttempts: 1, adapter: { async generate() { return { proposal: { claims: [claim] }, usage }; } } });
  const first = await sdk.inspect({ ...packet, reflectionRequired: true });
  const failed = await sdk.reflect(first.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: [], completion: 'completed', limitations: [], proposal: {}, usage }; } });
  await writeFile(ctx.state, JSON.stringify(failed));
  const context = JSON.parse(run('prepare', '--operation', 'reflect', '--state', ctx.state).stdout);
  await writeFile(ctx.plan, JSON.stringify({ binding: context.binding, reflection: { binding: context.request.binding, reviewedClaimIds: ['answer'], completion: 'completed', limitations: [], proposal: {}, usage: { totalTokens: 900, outputTokens: 800, costYen: 700 } }, hostUsage: { totalTokens: 600, costYen: 500 } }));
  const output = run('reflect', '--state', ctx.state, '--proposal', ctx.plan);
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.state.decision, 'ready_for_requested_step');
  assert.equal(result.state.usage.modelCalls, failed.state.usage.modelCalls + 1);
  assert.equal(result.state.usage.totalTokens, null);
  assert.equal(result.state.usage.costYen, null);
  assert.deepEqual(result.hostUsage, { totalTokens: null, costYen: null });
  assert.equal(result.apiCallsMade, 0);
  assert.deepEqual(result.state.evidence, []);
  assert.equal(result.state.claims[0].status, 'unverified');
});
