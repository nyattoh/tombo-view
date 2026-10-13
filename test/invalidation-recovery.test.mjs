import test from 'node:test';
import assert from 'node:assert/strict';
import { createTombo, hashPassage, validateState } from '../dist/index.js';

const timestamp = '2026-10-14T00:00:00.000Z';
const invalidProposal = { assessments: [{ claimId: 'unknown', evidenceIds: ['observed'], verdict: 'supports', scopeMatched: true, reason: 'Unknown claim.' }] };

function evidence(id = 'observed', validity = 'current') {
  const passage = 'enabled=true';
  return { id, kind: 'code', locator: 'config.txt', sourceGroup: 'config', retrievedAt: timestamp, version: '1', scope: 'config', passage, contentHash: hashPassage(passage), validity };
}
function observation(executionId = 'read-1', evidenceId = 'observed') {
  return { executionId, probeId: 'probe', outcome: 'completed', evidence: [evidence(evidenceId)], toolCalls: 1, elapsedMs: 10, costYen: 2 };
}
function repairedProposal(evidenceId) {
  return {
    assessments: [{ claimId: 'claim', evidenceIds: [evidenceId], verdict: 'supports', scopeMatched: true, reason: 'The configuration enables the setting.' }],
    resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [evidenceId], explanation: 'The setting is enabled.' }],
  };
}
function scenario(importance = 'required', originalEvidence = [], proposals = [invalidProposal, repairedProposal('fresh')]) {
  const initialProposal = {
    claims: [{ id: 'claim', role: 'answer_claim', text: 'The setting is enabled.', scope: 'config' }],
    lenses: [{ id: 'lens', label: 'Configuration', rationale: 'Read the setting.', origin: 'initial', status: 'active' }],
    gaps: [{ id: 'gap', kind: 'unsupported_claim', lensId: 'lens', question: 'Is the setting enabled?', triggerRefs: ['claim'], whyItMatters: 'Check the answer.', importance, claimIds: ['claim'], probeIds: ['probe'] }],
    probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Read the setting.', requiredCapability: 'read_file', sourceGroups: ['config'], successCondition: 'Enabled.', refutationCondition: 'Disabled.', inconclusiveCondition: 'Unavailable.' }],
  };
  let index = 0;
  const tombo = createTombo({ now: () => Date.parse(timestamp), adapter: {
    async generate(input) {
      return { proposal: input.operation === 'inspect' ? initialProposal : proposals[index++], usage: { totalTokens: 4, outputTokens: 2, costYen: 1 } };
    },
  } });
  const task = { schemaVersion: '0.1', taskId: 'invalidation-recovery', goal: 'Check the setting.', mode: 'explain', successCriteria: ['Cite the configuration.'], evidence: originalEvidence, capabilities: ['read_file'], budget: { maxRounds: 5, maxModelCalls: 8, maxToolCalls: 5, maxElapsedMs: 120000, maxInputChars: 48000, maxOutputTokensPerCall: 4000 } };
  return { tombo, task };
}

const failedUsage = { rounds: 1, modelCalls: 2, toolCalls: 1, elapsedMs: 10, totalTokens: 8, costYen: 4 };
const recoveredUsage = { rounds: 2, modelCalls: 3, toolCalls: 2, elapsedMs: 20, totalTokens: 12, costYen: 7 };

test('optional pending assessment withdrawal returns a valid ready state', async () => {
  const { tombo, task } = scenario('optional');
  const first = await tombo.inspect(task);
  assert.equal(first.state.decision, 'ready_for_requested_step');
  const failed = await tombo.update(first.state, [observation()]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  assert.deepEqual(failed.state.pendingAssessmentExecutionIds, ['read-1']);
  const withdrawn = tombo.invalidate(failed.state, { evidenceIds: ['observed'], reason: 'The source was withdrawn.' });
  assert.deepEqual(validateState(withdrawn.state), withdrawn.state);
  assert.equal(withdrawn.state.decision, 'ready_for_requested_step');
  assert.equal(Object.hasOwn(withdrawn.state, 'pendingAssessmentExecutionIds'), false);
  assert.equal(withdrawn.state.evidence[0].validity, 'withdrawn');
  assert.deepEqual(withdrawn.state.usage, failedUsage);
  assert.deepEqual(withdrawn.state.appliedExecutions, failed.state.appliedExecutions);
  assert.deepEqual(withdrawn.state.task, first.state.task);
});

test('required pending withdrawal schedules a fresh execution and preserves duplicate accounting', async () => {
  const { tombo, task } = scenario();
  const first = await tombo.inspect(task);
  const failed = await tombo.update(first.state, [observation()]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  const withdrawn = tombo.invalidate(failed.state, { evidenceIds: ['observed'], reason: 'Acquire a replacement source.' });
  assert.equal(withdrawn.state.decision, 'needs_check');
  assert.deepEqual(withdrawn.nextProbeIds, ['probe']);
  assert.equal(Object.hasOwn(withdrawn.state, 'pendingAssessmentExecutionIds'), false);
  assert.deepEqual(withdrawn.state.usage, failedUsage);
  assert.deepEqual(validateState(withdrawn.state), withdrawn.state);
  const duplicate = await tombo.update(withdrawn.state, [observation()]);
  assert.deepEqual(duplicate.state, withdrawn.state);
  assert.deepEqual(duplicate.nextProbeIds, ['probe']);
  const recovered = await tombo.update(duplicate.state, [observation('read-2', 'fresh')]);
  assert.equal(recovered.state.decision, 'ready_for_requested_step');
  assert.equal(recovered.state.claims[0].status, 'supported');
  assert.equal(recovered.state.gaps[0].status, 'resolved');
  assert.deepEqual(recovered.state.usage, recoveredUsage);
  assert.deepEqual(recovered.state.appliedExecutions.map(item => item.executionId), ['read-1', 'read-2']);
  assert.deepEqual(recovered.state.task, first.state.task);
  const oldDuplicate = await tombo.update(recovered.state, [observation()]);
  const newDuplicate = await tombo.update(oldDuplicate.state, [observation('read-2', 'fresh')]);
  assert.deepEqual(oldDuplicate.state, recovered.state);
  assert.deepEqual(newDuplicate.state, recovered.state);
});

test('withdrawing unrelated evidence abandons assessment of the old state snapshot', async () => {
  const { tombo, task } = scenario('required', [evidence('original')]);
  const first = await tombo.inspect(task);
  const failed = await tombo.update(first.state, [observation()]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  const withdrawn = tombo.invalidate(failed.state, { evidenceIds: ['original'], reason: 'The original context changed.' });
  assert.equal(withdrawn.state.decision, 'needs_check');
  assert.deepEqual(withdrawn.nextProbeIds, ['probe']);
  assert.equal(Object.hasOwn(withdrawn.state, 'pendingAssessmentExecutionIds'), false);
  assert.equal(withdrawn.state.evidence.find(item => item.id === 'observed').validity, 'current');
  assert.deepEqual(withdrawn.state.usage, failedUsage);
  assert.deepEqual(withdrawn.state.task, first.state.task);
  const duplicate = await tombo.update(withdrawn.state, [observation()]);
  assert.deepEqual(duplicate.state, withdrawn.state);
  const recovered = await tombo.update(duplicate.state, [observation('read-2', 'fresh')]);
  assert.equal(recovered.state.decision, 'ready_for_requested_step');
  assert.deepEqual(recovered.state.usage, recoveredUsage);
});

test('repeated withdrawal keeps a pending batch and still permits its exact repair', async () => {
  const { tombo, task } = scenario('required', [evidence('original', 'withdrawn')], [invalidProposal, repairedProposal('observed')]);
  const first = await tombo.inspect(task);
  const failed = await tombo.update(first.state, [observation()]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  const unchanged = tombo.invalidate(failed.state, { evidenceIds: ['original'], reason: 'Already withdrawn.' });
  assert.deepEqual(unchanged.state, failed.state);
  assert.deepEqual(unchanged.state.pendingAssessmentExecutionIds, ['read-1']);
  const rejected = await tombo.update(unchanged.state, [observation('read-2', 'fresh')]);
  assert.equal(rejected.state.stopReason, 'invalid_input');
  assert.deepEqual(rejected.state.usage, failedUsage);
  const recovered = await tombo.update(rejected.state, [observation()]);
  assert.equal(recovered.state.decision, 'ready_for_requested_step');
  assert.deepEqual(recovered.state.usage, { rounds: 2, modelCalls: 3, toolCalls: 1, elapsedMs: 10, totalTokens: 12, costYen: 5 });
});

test('withdrawing one source abandons the full pending batch without replaying either execution', async () => {
  const { tombo, task } = scenario();
  const first = await tombo.inspect(task);
  const batch = [observation(), observation('read-2', 'other')];
  const failed = await tombo.update(first.state, batch);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  assert.deepEqual(failed.state.pendingAssessmentExecutionIds, ['read-1', 'read-2']);
  const withdrawn = tombo.invalidate(failed.state, { evidenceIds: ['observed'], reason: 'Part of the observation batch changed.' });
  assert.equal(withdrawn.state.decision, 'needs_check');
  assert.deepEqual(withdrawn.nextProbeIds, ['probe']);
  assert.equal(Object.hasOwn(withdrawn.state, 'pendingAssessmentExecutionIds'), false);
  assert.deepEqual(withdrawn.state.usage, { rounds: 1, modelCalls: 2, toolCalls: 2, elapsedMs: 20, totalTokens: 8, costYen: 6 });
  for (const delivered of batch) {
    const duplicate = await tombo.update(withdrawn.state, [delivered]);
    assert.deepEqual(duplicate.state, withdrawn.state);
  }
  const recovered = await tombo.update(withdrawn.state, [observation('read-3', 'fresh')]);
  assert.equal(recovered.state.decision, 'ready_for_requested_step');
  assert.deepEqual(recovered.state.usage, { rounds: 2, modelCalls: 3, toolCalls: 3, elapsedMs: 30, totalTokens: 12, costYen: 9 });
  assert.deepEqual(recovered.state.appliedExecutions.map(item => item.executionId), ['read-1', 'read-2', 'read-3']);
});
