import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTombo, fixtureAdapter, FIXTURE_CASES, hashPassage } from '../dist/index.js';
import { runUnderstandingCheck } from '../dist/runner.js';

function packet(overrides = {}) {
  return { schemaVersion: '0.1', taskId: 'demo-account-close', goal: '原因を検証する', mode: 'execute', successCriteria: ['資料で検証する'], evidence: [], capabilities: ['read_document'], budget: { maxRounds: 4, maxModelCalls: 6, maxToolCalls: 6, maxElapsedMs: 10000, maxInputChars: 48000, maxOutputTokensPerCall: 4000, ...overrides } };
}
const critic = { async reflect(input) { return { binding: input.binding, reviewedClaimIds: input.state.claims.map(c => c.id), completion: 'completed', limitations: [], proposal: {}, usage: { totalTokens: 0, costYen: 0, outputTokens: 0 } }; } };
function executor(outcome = 'completed', alter = {}) {
  return { async execute(input) { const passage = FIXTURE_CASES.account.passage; return { executionId: input.executionId, probeId: input.probe.id, outcome, evidence: outcome === 'completed' ? [{ id: 'rule-1', kind: 'document', locator: 'fixture:rule', sourceGroup: 'rule', retrievedAt: new Date().toISOString(), version: '1', scope: 'synthetic-account-v1', passage, contentHash: hashPassage(passage), validity: 'current' }] : [], toolCalls: 1, elapsedMs: 1, costYen: 0, ...alter }; } };
}
const tombo = () => createTombo({ adapter: fixtureAdapter });

test('runner requires reflection after actual probe evidence before ready', async () => {
  const runResult = await runUnderstandingCheck({ tombo: tombo(), task: packet(), critic, executor: executor() });
  const result = runResult.result;
  assert.equal(runResult.status, 'completed');
  assert.equal(result.state.decision, 'ready_for_requested_step');
  assert.equal(result.state.task.reflectionRequired, true);
  assert.equal(result.state.claims[0].status, 'supported');
  assert.equal(result.state.reflection.completion, 'completed');
  assert.equal(result.state.usage.toolCalls, 1);
  assert.equal(result.state.usage.modelCalls, 3);
});
for (const outcome of ['no_result', 'unavailable', 'error']) test(`runner retains ${outcome} without success or repeated tools`, async () => {
  const runResult = await runUnderstandingCheck({ tombo: tombo(), task: packet(), critic, executor: executor(outcome) });
  const result = runResult.result;
  assert.equal(result.state.decision, 'blocked');
  assert.equal(result.state.claims[0].status, 'unverified');
  assert.equal(result.state.appliedExecutions[0].outcome, outcome);
  assert.equal(result.state.usage.toolCalls, 1);
});
test('wrong probe binding discards claimed evidence and charges attempted tool', async () => {
  const runResult = await runUnderstandingCheck({ tombo: tombo(), task: packet(), critic, executor: executor('completed', { executionId: 'wrong' }) });
  const result = runResult.result;
  assert.equal(result.state.decision, 'blocked');
  assert.equal(runResult.reason, 'invalid_probe_output');
  assert.equal(result.state.evidence.length, 0);
  assert.equal(result.state.usage.toolCalls, 1);
  assert.equal(result.state.usage.costYen, null);
});
test('probe exception keeps attempted usage and unknown cost', async () => {
  const runResult = await runUnderstandingCheck({ tombo: tombo(), task: packet(), critic, executor: { async execute() { throw new Error('failed'); } } });
  const result = runResult.result;
  assert.equal(result.state.decision, 'blocked');
  assert.equal(result.state.appliedExecutions[0].outcome, 'error');
  assert.equal(result.state.usage.toolCalls, 1);
  assert.equal(result.state.usage.costYen, null);
});
test('abort rejects late completion and propagates signal to executor', async () => {
  const controller = new AbortController();
  const runResult = await runUnderstandingCheck({ tombo: tombo(), task: packet(), critic, signal: controller.signal, executor: { async execute(input) { assert.equal(input.signal.aborted, false); controller.abort(); return executor().execute(input); } } });
  const result = runResult.result;
  assert.equal(result.state.decision, 'blocked');
  assert.equal(runResult.reason, 'runner_aborted');
  assert.equal(result.state.evidence.length, 0);
  assert.equal(result.state.usage.toolCalls, 1);
  assert.equal(result.state.usage.costYen, null);
});
test('monetary cap without declared tool upper bound refuses execution', async () => {
  const runResult = await runUnderstandingCheck({ tombo: tombo(), task: packet({ maxCostYen: 1 }), critic, executor: executor() });
  const result = runResult.result;
  assert.equal(result.state.decision, 'blocked');
  assert.equal(runResult.reason ?? result.state.stopReason, 'budget_accounting_unavailable');
  assert.equal(result.state.usage.toolCalls, 0);
});
test('host reflection exact state binding and stale revision refusal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-reflect-'));
  const helper = resolve('skills/tombo-view/scripts/session.mjs');
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' });
  try {
    const stateFile = join(dir, 'state.json'), envelopeFile = join(dir, 'reflection.json'), output = join(dir, 'result.json');
    const sdk = createTombo({ adapter: { async generate() { return { proposal: {}, usage: { totalTokens: 0, costYen: 0 } }; } } });
    const initial = await sdk.inspect({ ...packet(), reflectionRequired: true });
    await writeFile(stateFile, JSON.stringify(initial));
    const prepared = run('prepare', '--operation', 'reflect', '--state', stateFile);
    assert.equal(prepared.status, 0, prepared.stderr);
    const context = JSON.parse(prepared.stdout);
    assert.equal(context.request.operation, 'reflect');
    await writeFile(envelopeFile, JSON.stringify({ binding: context.binding, reflection: { binding: context.request.binding, reviewedClaimIds: [], completion: 'completed', limitations: [], proposal: {} } }));
    const reflected = run('reflect', '--state', stateFile, '--proposal', envelopeFile, '--out', output);
    assert.equal(reflected.status, 0, reflected.stderr);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.state.decision, 'ready_for_requested_step');
    assert.equal(result.apiCallsMade, 0);
    assert.equal(result.state.usage.costYen, null);
    const wrong = run('reflect', '--state', output, '--proposal', envelopeFile);
    assert.equal(wrong.status, 1);
    assert.equal(JSON.parse(wrong.stderr).error.code, 'revision_conflict');
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('failed pending assessment is retained instead of repeating the physical probe', async () => {
  const adapter = { async generate(input) { if (input.operation === 'inspect') return fixtureAdapter.generate(input); throw new Error('assessment failure'); } };
  const runResult = await runUnderstandingCheck({ tombo: createTombo({ adapter }), task: packet(), critic, executor: executor() });
  const result = runResult.result;
  assert.equal(result.state.decision, 'blocked');
  assert.equal(result.state.stopReason, 'model_error');
  assert.equal(result.state.usage.toolCalls, 1);
  assert.equal(result.state.pendingAssessmentExecutionIds.length, 1);
  assert.equal(result.state.evidence[0].id, 'rule-1');
});
test('unavailable capability remains blocked with required gap and no tool calls', async () => {
  const task = { ...packet(), capabilities: [] };
  const runResult = await runUnderstandingCheck({ tombo: tombo(), task, critic, executor: executor() });
  const result = runResult.result;
  assert.equal(result.state.decision, 'blocked');
  assert.equal(result.state.stopReason, 'capability_limit');
  assert.equal(result.state.gaps[0].status, 'blocked');
  assert.equal(result.state.usage.toolCalls, 0);
});

test('already aborted execution returns no understanding state', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runUnderstandingCheck({ tombo: tombo(), task: packet(), critic, executor: executor(), signal: controller.signal });
  assert.deepEqual(result, { status: 'stopped', reason: 'runner_aborted', result: null });
});
test('bounded cycles stop before a physical probe and keep initial understanding', async () => {
  const result = await runUnderstandingCheck({ tombo: tombo(), task: packet(), critic, executor: executor(), maxCycles: 0 });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'cycle_limit');
  assert.equal(result.result.state.decision, 'needs_check');
  assert.equal(result.result.state.usage.toolCalls, 0);
});
