import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRecorded } from './helpers/unknown-progress.mjs';

for (const maxRounds of [2, 3]) {
  test(`duplicate record preserves unknown and stops for no progress with maxRounds=${maxRounds}`, async () => {
    const { states } = await replayRecorded({ budgetOverrides: { maxRounds } });
    const result = states.at(-1);
    assert.deepEqual(result.state.claims.map(({ id, status }) => ({ id, status })), [
      { id: 'c-unreachable', status: 'unverified' },
      { id: 'c-undetermined', status: 'supported' },
    ]);
    assert.deepEqual(result.state.gaps.map(({ id, status }) => ({ id, status })), [{ id: 'g-unreachable', status: 'open' }]);
    assert.equal(result.state.evidence.length, 3);
    assert.equal(result.state.appliedExecutions.length, 2);
    assert.equal(result.state.usage.toolCalls, 2);
    assert.equal(result.state.usage.modelCalls, 3);
    assert.equal(result.state.stopReason, 'no_progress');
    assert.equal(result.state.decision, 'blocked');
    assert.deepEqual(result.nextProbeIds, []);
  });
}

for (const [dimension, value] of Object.entries({ version: 'new-version', scope: 'new-scope', sourceGroup: 'independent-source', validity: 'superseded', passage: 'New record: C has now been exported.' })) {
  test(`a changed ${dimension} remains distinguishable from a duplicate record`, async () => {
    const { hashPassage } = await import('../dist/index.js');
    const evidenceOverride = { [dimension]: value };
    if (dimension === 'passage') evidenceOverride.contentHash = hashPassage(value);
    const { states } = await replayRecorded({ budgetOverrides: { maxRounds: 3 }, evidenceOverride });
    assert.equal(states.at(-1).state.stopReason, null);
    assert.equal(states.at(-1).state.decision, 'needs_check');
    assert.equal(states.at(-1).state.gaps[0].status, 'open');
  });
}


for (const maxRounds of [2, 3]) test(`undeclared rereads keep legacy behaviour with maxRounds=${maxRounds}`, async () => {
  const { states } = await replayRecorded({ budgetOverrides: { maxRounds }, staticSnapshot: null });
  assert.equal(states.at(-1).state.stopReason, maxRounds === 2 ? 'budget_exhausted' : null);
  assert.equal(states.at(-1).state.claims[0].status, 'unverified');
});

for (const dimension of ['kind', 'locator']) test(`declared snapshot respects a changed ${dimension}`, async () => {
  const { states } = await replayRecorded({ budgetOverrides: { maxRounds: 3 }, evidenceOverride: { [dimension]: dimension === 'kind' ? 'test' : 'record:new-location' } });
  assert.equal(states.at(-1).state.decision, 'needs_check');
  assert.equal(states.at(-1).state.stopReason, null);
});

import { progressScenario } from './helpers/unknown-progress.mjs';
import { assessmentDigest, understandingHash, runUnderstandingCheck, FileJournal, replayJournal } from '../dist/index.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function firstRead(context) {
  const initial = await context.sdk.inspect(context.task);
  return context.sdk.update(initial.state, [context.observation('first')]);
}

for (const kind of ['document', 'test']) test(`undeclared ${kind} reruns remain progress even with identical output`, async () => {
  const context = progressScenario();
  let result = await context.sdk.inspect(context.task);
  for (const id of ['first', 'second']) result = await context.sdk.update(result.state, [context.observation(id, { staticSnapshot: undefined, evidence: [context.evidence(id, { kind })] })]);
  assert.equal(result.state.decision, 'needs_check');
  assert.equal(result.state.usage.toolCalls, 2);
  assert.equal(result.state.evidence.length, 2);
});

test('a changed snapshot identity is new information despite identical evidence content', async () => {
  const context = progressScenario();
  const first = await firstRead(context);
  const result = await context.sdk.update(first.state, [context.observation('second', { staticSnapshot: 'export-run-2' })]);
  assert.equal(result.state.decision, 'needs_check');
  assert.equal(result.state.stopReason, null);
});

test('duplicate static probe yields to another required probe and does not revive after its unknown result', async () => {
  const context = progressScenario({ secondProbe: true });
  const first = await firstRead(context);
  const second = await context.sdk.update(first.state, [context.observation('second')]);
  assert.deepEqual(second.nextProbeIds, ['p-other']);
  assert.equal(second.state.probes.find(p => p.id === 'p-static').status, 'exhausted');
  const third = await context.sdk.update(second.state, [context.observation('third', { probeId: 'p-other' })]);
  assert.equal(third.state.stopReason, 'no_progress');
  assert.equal(third.state.gaps[0].status, 'open');
  assert.equal(third.state.claims[0].status, 'unverified');
  assert.deepEqual(third.state.probes.map(p => p.status), ['exhausted', 'exhausted']);
});

test('runner advances past an exhausted static probe using the SDK decision', async () => {
  const context = progressScenario({ secondProbe: true });
  const calls = [];
  const run = await runUnderstandingCheck({ tombo: context.sdk, task: context.task, critic: context.critic, executor: { async execute(input) {
    calls.push(input.probe.id);
    return context.observation(input.executionId, { executionId: input.executionId, probeId: input.probe.id });
  } } });
  assert.equal(run.reason, 'no_progress');
  assert.equal(run.result.state.claims[0].status, 'unverified');
  assert.equal(run.result.state.gaps[0].status, 'open');
  assert.ok(calls.includes('p-static') && calls.includes('p-other'));
  assert.equal(run.result.state.usage.toolCalls, calls.length);
});

for (const entity of ['claims', 'lenses', 'gaps', 'probes']) test(`a new ${entity} candidate remains progress on a static reread`, async () => {
  const context = progressScenario();
  const first = await firstRead(context);
  const proposal = entity === 'claims' ? { claims: [{ id: 'new-claim', role: 'hypothesis', text: 'C might connect to D.', scope: 'graph' }] } :
    entity === 'lenses' ? { lenses: [{ id: 'new-lens', label: 'Boundary', rationale: 'Check C.', origin: 'proposed', status: 'candidate' }] } :
    { gaps: [{ id: 'new-gap', kind: 'missing_fact', lensId: 'lens', question: 'What are C rows?', triggerRefs: ['claim'], whyItMatters: 'C can reach D.', importance: 'required', claimIds: ['claim'], probeIds: ['new-probe'] }], probes: [{ ...context.probe('new-probe'), gapIds: ['new-gap'] }] };
  context.setProposal(proposal);
  const result = await context.sdk.update(first.state, [context.observation('second')]);
  assert.equal(result.state.stopReason, null);
  assert.equal(result.state.decision, 'needs_check');
  assert.equal(result.state[entity].length, 2);
});

test('an explicit assessment correction stays progress with the same claim status and static evidence', async () => {
  const context = progressScenario();
  const first = await firstRead(context);
  const old = first.state.claims[0].assessments[0];
  const replacement = { ...old, evidenceIds: ['second'], reason: 'The result concerns missing C rows, not missing D rows.' };
  context.setProposal({ assessmentCorrections: [{ claimId: 'claim', targetDigest: assessmentDigest(old), groundingEvidenceIds: ['second'], replacement, reason: 'Correct the scope of the interpretation.' }] });
  const result = await context.sdk.update(first.state, [context.observation('second')]);
  assert.equal(result.state.claims[0].status, 'unverified');
  assert.equal(result.state.assessmentCorrections.length, 1);
  assert.equal(result.state.stopReason, null);
  assert.equal(result.state.decision, 'needs_check');
});

test('a duplicate still appends immutable evidence and invalidates the old reflection receipt', async () => {
  const context = progressScenario();
  const first = await firstRead(context);
  const reviewed = await context.sdk.reflect(first.state, context.critic);
  assert.equal(reviewed.state.reflection.binding.understandingHash, understandingHash(reviewed.state));
  const result = await context.sdk.update(reviewed.state, [context.observation('second')]);
  assert.equal(result.state.stopReason, 'no_progress');
  assert.equal(result.state.evidence.length, 2);
  assert.equal(result.state.claims[0].assessments.length, 2);
  assert.notEqual(result.state.reflection.binding.understandingHash, understandingHash(result.state));
  assert.deepEqual(result.state.evidence[0], reviewed.state.evidence[0]);
});

for (const mutation of ['changed', 'removed']) test(`deferred replay refuses ${mutation} snapshot declaration and accepts the exact batch`, async () => {
  const context = progressScenario();
  const first = await firstRead(context);
  const observation = context.observation('second');
  const deferred = await context.sdk.update(first.state, [observation], { deferAssessment: true });
  const altered = structuredClone(observation);
  if (mutation === 'changed') altered.staticSnapshot = 'another-run'; else delete altered.staticSnapshot;
  const rejected = await context.sdk.update(deferred.state, [altered]);
  assert.equal(rejected.state.stopReason, 'invalid_input');
  assert.equal(rejected.state.usage.modelCalls, 2);
  assert.equal(rejected.state.usage.toolCalls, 2);
  const replayed = await context.sdk.update(rejected.state, [observation]);
  assert.equal(replayed.state.stopReason, 'no_progress');
  assert.equal(replayed.state.usage.toolCalls, 2);
  assert.equal(replayed.state.usage.modelCalls, 3);
  assert.equal(replayed.state.appliedExecutions.at(-1).staticSnapshot.id, 'export-run-1');
});

for (const bad of ['', 1, { kind: 'static' }]) test(`invalid snapshot declaration ${JSON.stringify(bad)} is rejected before assessment`, async () => {
  const context = progressScenario();
  const first = await firstRead(context);
  const result = await context.sdk.update(first.state, [context.observation('bad', { staticSnapshot: bad })]);
  assert.equal(result.state.stopReason, 'invalid_input');
  assert.equal(result.state.usage.modelCalls, 2);
  assert.equal(result.state.evidence.length, 1);
});

test('model proposal cannot inject a static snapshot declaration', async () => {
  const context = progressScenario();
  const first = await firstRead(context);
  context.setProposal({ staticSnapshot: 'fake' });
  const result = await context.sdk.update(first.state, [context.observation('second')]);
  assert.equal(result.state.stopReason, 'invalid_model_output');
  assert.deepEqual(result.state.pendingAssessmentExecutionIds, ['exec-second']);
});

test('a static declaration requires completed evidence', async () => {
  const context = progressScenario();
  const first = await firstRead(context);
  const result = await context.sdk.update(first.state, [context.observation('second', { outcome: 'no_result', evidence: [] })]);
  assert.equal(result.state.stopReason, 'invalid_input');
  assert.equal(result.state.usage.toolCalls, 1);
});

test('the pre-generation round cap still rejects another declared duplicate', async () => {
  const context = progressScenario({ budget: { maxRounds: 1 } });
  const first = await firstRead(context);
  const result = await context.sdk.update(first.state, [context.observation('second')]);
  assert.equal(result.state.stopReason, 'budget_exhausted');
  assert.equal(result.state.usage.modelCalls, 2);
  assert.equal(result.state.usage.toolCalls, 2);
  assert.deepEqual(result.state.pendingAssessmentExecutionIds, ['exec-second']);
});

test('withdrawal reopens an exhausted static probe without resolving the unknown gap', async () => {
  const context = progressScenario();
  const first = await firstRead(context);
  const second = await context.sdk.update(first.state, [context.observation('second')]);
  const reopened = context.sdk.invalidate(second.state, { evidenceIds: ['first', 'second'], reason: 'The export was withdrawn.' });
  assert.deepEqual(reopened.nextProbeIds, ['p-static']);
  assert.equal(reopened.state.gaps[0].status, 'open');
  const updated = await context.sdk.update(reopened.state, [context.observation('third')]);
  assert.equal(updated.state.decision, 'needs_check');
  assert.equal(updated.state.stopReason, null);
  assert.deepEqual(updated.state.evidence.map(e => e.validity), ['withdrawn', 'withdrawn', 'current']);
});

test('journal redaction retains declarations and permits exact rehydration before fresh review', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-static-'));
  try {
    const context = progressScenario();
    const first = await firstRead(context);
    const journal = new FileJournal(join(directory, 'events.jsonl'));
    await journal.commit(-1, first.state);
    const saved = await replayJournal(journal.path);
    assert.equal(saved.appliedExecutions[0].staticSnapshot.id, 'export-run-1');
    assert.equal(saved.evidence[0].passageUnavailable, true);
    const rehydrated = await context.sdk.update(saved, [context.observation('rehydrate', { evidence: [first.state.evidence[0]] })]);
    assert.equal(rehydrated.state.stopReason, null);
    assert.equal(rehydrated.state.evidence[0].passage, first.state.evidence[0].passage);
    assert.equal(rehydrated.state.usage.toolCalls, 2);
    const duplicate = await context.sdk.update(rehydrated.state, [context.observation('next')]);
    assert.equal(duplicate.state.stopReason, 'no_progress');
    const forged = structuredClone(first.state);
    forged.appliedExecutions[0].staticSnapshot.id = 'forged';
    await assert.rejects(journal.assertCurrent(forged), { code: 'revision_conflict' });
    const text = await readFile(journal.path, 'utf8');
    assert.equal(text.includes(first.state.evidence[0].passage), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a mixed batch retires only the duplicate static probe and preserves an unexecuted probe', async () => {
  const context = progressScenario({ secondProbe: true });
  const first = await firstRead(context);
  const extra = { ...context.probe('p-third'), gapIds: ['extra-gap'] };
  context.setProposal({ gaps: [{ id: 'extra-gap', kind: 'missing_fact', lensId: 'lens', question: 'Is there another record?', triggerRefs: ['claim'], whyItMatters: 'A separate record can fill the gap.', importance: 'required', claimIds: ['claim'], probeIds: ['p-third'] }], probes: [extra] });
  const expanded = await context.sdk.update(first.state, [context.observation('expanded')]);
  context.setProposal({});
  const result = await context.sdk.update(expanded.state, [context.observation('duplicate'), context.observation('no-result', { probeId: 'p-other', outcome: 'no_result', evidence: [], staticSnapshot: undefined })]);
  assert.equal(result.state.stopReason, null);
  assert.equal(result.state.probes.find(p => p.id === 'p-static').status, 'exhausted');
  assert.ok(result.nextProbeIds.includes('p-third'));
  assert.equal(result.state.gaps.find(g => g.id === 'gap').status, 'open');
});

test('the first static snapshot remains new information after deferred assessment', async () => {
  const context = progressScenario();
  const initial = await context.sdk.inspect(context.task);
  const observation = context.observation('first');
  const deferred = await context.sdk.update(initial.state, [observation], { deferAssessment: true });
  const result = await context.sdk.update(deferred.state, [observation]);
  assert.equal(result.state.decision, 'needs_check');
  assert.equal(result.state.stopReason, null);
  assert.equal(result.state.usage.toolCalls, 1);
  assert.equal(result.state.usage.modelCalls, 2);
});

test('new evidence from another probe reopens a previously exhausted static probe', async () => {
  const context = progressScenario({ secondProbe: true });
  const first = await firstRead(context);
  const second = await context.sdk.update(first.state, [context.observation('second')]);
  const result = await context.sdk.update(second.state, [context.observation('third', { probeId: 'p-other', evidence: [context.evidence('third', { version: '2' })] })]);
  assert.equal(result.state.probes.find(p => p.id === 'p-static').status, 'pending');
  assert.ok(result.nextProbeIds.includes('p-static'));
  assert.equal(result.state.stopReason, null);
});
