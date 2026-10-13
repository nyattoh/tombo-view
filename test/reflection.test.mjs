import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/core.js';
import { stateSchema, taskPacketSchema } from '../dist/types.js';
import { renderMarkdownReport } from '../dist/report.js';

const now = () => Date.parse('2026-10-14T00:00:00.000Z');
const usage = { totalTokens: 10, outputTokens: 5, costYen: 1 };
const claim = { id: 'answer', role: 'answer_claim', text: 'The operation is available.', scope: 'contract-v1' };
const lens = { id: 'boundary', label: 'Boundary', rationale: 'Check eligibility', origin: 'proposed', status: 'active' };
const gap = { id: 'eligibility', kind: 'missing_fact', lensId: lens.id, question: 'Is the account eligible?', triggerRefs: ['answer'], whyItMatters: 'Eligibility may prevent the operation.', importance: 'required', claimIds: ['answer'], probeIds: ['read-contract'] };
const probe = { id: 'read-contract', gapIds: [gap.id], method: 'counterexample', question: 'Read eligibility restrictions.', requiredCapability: 'read_document', sourceGroups: ['contract'], successCondition: 'The account is eligible.', refutationCondition: 'The account is ineligible.', inconclusiveCondition: 'Eligibility is absent.' };
const candidate = { lenses: [lens], gaps: [gap], probes: [probe] };
function packet(budget = {}) {
  return { schemaVersion: '0.1', taskId: 'reflection-test', goal: 'Check whether the operation is available.', mode: 'execute', successCriteria: ['Check the contract.'], proposedAnswer: claim.text, reflectionRequired: true, evidence: [], capabilities: ['read_document'], budget: { maxRounds: 5, maxModelCalls: 12, maxToolCalls: 6, maxElapsedMs: 10000, maxInputChars: 100000, maxOutputTokensPerCall: 1000, ...budget } };
}
function adapter(update = () => ({}), initial = { claims: [claim] }) {
  return { estimateMaxCostYen: () => 1, async generate(input) { assert.ok(['inspect', 'update'].includes(input.operation)); return { proposal: input.operation === 'inspect' ? initial : update(input), usage }; } };
}
function critic(proposal = {}, extra = {}) {
  return { estimateMaxCostYen: () => 1, async reflect(input) { assert.equal(input.operation, 'reflect'); assert.equal(input.maxOutputTokens, input.task.budget.maxOutputTokensPerCall); return { binding: input.binding, reviewedClaimIds: input.state.claims.map(item => item.id), completion: 'completed', limitations: ['Only supplied material was reviewed.'], proposal, usage, ...extra }; } };
}
function evidence() { const passage = 'This account is ineligible.'; return { id: 'restriction', kind: 'document', locator: 'fixture:contract', sourceGroup: 'contract', retrievedAt: '2026-10-14T00:00:00.000Z', version: '1', scope: 'contract-v1', passage, contentHash: core.hashPassage(passage), validity: 'current' }; }
function observation() { return { executionId: 'read-1', probeId: probe.id, outcome: 'completed', evidence: [evidence()], toolCalls: 1, elapsedMs: 2, costYen: 0 }; }
function assessed(input) { return { assessments: [{ claimId: 'answer', evidenceIds: ['restriction'], verdict: 'refutes', scopeMatched: true, reason: 'The contract excludes this account.' }], resolutions: [{ gapId: gap.id, reason: 'refuted', evidenceIds: ['restriction'], explanation: 'The restriction answers the eligibility check.' }] }; }

test('a strict empty-gap proposal requires reflection; a clean critic completes the current understanding', async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect(packet());
  assert.equal(first.state.decision, 'needs_reflection');
  assert.equal(first.state.reflection, undefined);
  const reflected = await tombo.reflect(first.state, critic());
  assert.equal(reflected.state.decision, 'ready_for_requested_step');
  assert.equal(reflected.state.reflection.completion, 'completed');
  assert.deepEqual(reflected.state.reflection.reviewedClaimIds, ['answer']);
  assert.deepEqual(reflected.state.usage, { rounds: 0, modelCalls: 2, toolCalls: 0, elapsedMs: 0, totalTokens: 20, costYen: 2 });
  assert.equal(reflected.state.revision, 2);
});

test('critic candidates require a probe and cannot certify the changed understanding in the same call', async () => {
  const tombo = core.createTombo({ adapter: adapter(assessed), now });
  const first = await tombo.inspect(packet());
  const challenged = await tombo.reflect(first.state, critic(candidate));
  assert.equal(challenged.state.decision, 'needs_check');
  assert.deepEqual(challenged.nextProbeIds, ['read-contract']);
  assert.equal(challenged.state.claims[0].status, 'unverified');
  assert.notEqual(challenged.state.reflection.binding.understandingHash, core.understandingHash(challenged.state));
  const revised = await tombo.update(challenged.state, [observation()]);
  assert.equal(revised.state.claims[0].status, 'contradicted');
  assert.equal(revised.state.gaps[0].status, 'resolved');
  assert.equal(revised.state.decision, 'needs_reflection');
  const checked = await tombo.reflect(revised.state, critic());
  assert.equal(checked.state.decision, 'ready_for_requested_step');
  const duplicate = await tombo.update(checked.state, [observation()]);
  assert.deepEqual(duplicate.state, checked.state);
  assert.equal(duplicate.state.usage.toolCalls, 1);
  const withdrawn = tombo.invalidate(checked.state, { evidenceIds: ['restriction'], reason: 'Contract withdrawn.' });
  assert.equal(withdrawn.state.claims[0].status, 'unverified');
  assert.equal(withdrawn.state.gaps[0].status, 'open');
  assert.equal(withdrawn.state.decision, 'needs_check');
  assert.notEqual(withdrawn.state.reflection.binding.understandingHash, core.understandingHash(withdrawn.state));
});

test('an optional critic candidate also invalidates its own receipt', async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect(packet());
  const next = await tombo.reflect(first.state, critic({ ...candidate, gaps: [{ ...gap, importance: 'optional' }] }));
  assert.equal(next.state.decision, 'needs_reflection');
  assert.equal(next.state.gaps[0].importance, 'optional');
  const clean = await tombo.reflect(next.state, critic());
  assert.equal(clean.state.decision, 'ready_for_requested_step');
});

for (const [name, change] of [
  ['task', input => ({ binding: { ...input.binding, taskId: 'other' } })],
  ['revision', input => ({ binding: { ...input.binding, basedRevision: input.binding.basedRevision - 1 } })],
  ['hash', input => ({ binding: { ...input.binding, understandingHash: '0'.repeat(64) } })],
  ['coverage', () => ({ reviewedClaimIds: [] })],
  ['unknown claim', () => ({ reviewedClaimIds: ['invented'] })],
]) test(`invalid reflection ${name} preserves meaning and charges actual usage`, async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect(packet());
  const base = critic();
  const failed = await tombo.reflect(first.state, { async reflect(input) { return { ...await base.reflect(input), ...change(input) }; } });
  assert.equal(failed.state.decision, 'blocked');
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  assert.deepEqual(failed.state.claims, first.state.claims);
  assert.deepEqual(failed.state.gaps, []);
  assert.equal(failed.state.usage.modelCalls, 2);
  assert.equal(failed.state.usage.totalTokens, 20);
  assert.equal(failed.state.usage.costYen, 2);
});

for (const field of ['claims', 'assessments', 'resolutions', 'evidence']) test(`critic cannot write ${field}`, async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect(packet());
  const failed = await tombo.reflect(first.state, critic({ [field]: [] }));
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  assert.equal(failed.state.usage.modelCalls, 2);
  assert.equal(failed.state.usage.costYen, 2);
  assert.deepEqual(failed.state.claims, first.state.claims);
});

test('explicit inconclusive remains blocked and the report records limitations', async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect(packet());
  const next = await tombo.reflect(first.state, critic({}, { completion: 'inconclusive', limitations: ['Missing contract appendix.'] }));
  assert.equal(next.state.decision, 'blocked');
  assert.equal(next.state.stopReason, 'reflection_inconclusive');
  assert.equal(next.state.reflection.completion, 'inconclusive');
  assert.match(renderMarkdownReport(next), /再考/);
  assert.match(renderMarkdownReport(next), /Missing contract appendix/);
});

test('a proposed answer without claims cannot obtain ready from an empty critic', async () => {
  const tombo = core.createTombo({ adapter: adapter(undefined, {}), now });
  const first = await tombo.inspect(packet());
  const next = await tombo.reflect(first.state, critic());
  assert.equal(next.state.decision, 'blocked');
  assert.equal(next.state.stopReason, 'no_progress');
});

test('hash excludes bookkeeping and passage cache but includes evidence validity and task content', async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect({ ...packet(), evidence: [evidence()] });
  const changed = structuredClone(first.state);
  changed.revision += 5; changed.usage.modelCalls += 5; changed.stopReason = 'model_error'; changed.decision = 'blocked';
  for (const item of [...changed.evidence, ...changed.task.evidence]) { item.passage = ''; item.passageUnavailable = true; }
  assert.equal(core.understandingHash(first.state), core.understandingHash(changed));
  changed.evidence[0].validity = 'withdrawn';
  assert.notEqual(core.understandingHash(first.state), core.understandingHash(changed));
  changed.evidence[0].validity = 'current'; changed.task.goal = 'Different goal';
  assert.notEqual(core.understandingHash(first.state), core.understandingHash(changed));
});

test('failed assessment cannot be bypassed with reflection and does not repeat the tool', async () => {
  const tombo = core.createTombo({ adapter: adapter(() => ({ assessments: [{ claimId: 'unknown', evidenceIds: ['restriction'], verdict: 'refutes', scopeMatched: true, reason: 'Invalid target.' }] })), now });
  const first = await tombo.inspect(packet());
  const challenged = await tombo.reflect(first.state, critic(candidate));
  const failed = await tombo.update(challenged.state, [observation()]);
  const next = await tombo.reflect(failed.state, critic());
  assert.equal(next.state.decision, 'blocked');
  assert.deepEqual(next.state.pendingAssessmentExecutionIds, ['read-1']);
  assert.equal(next.state.usage.modelCalls, 3);
  assert.equal(next.state.usage.toolCalls, 1);
});

test('reflection failures and timeouts count actual model attempts', async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect(packet());
  const failed = await tombo.reflect(first.state, { async reflect() { throw new Error('Unavailable'); } });
  assert.equal(failed.state.stopReason, 'model_error');
  assert.equal(failed.state.usage.modelCalls, 3);
  assert.equal(failed.state.usage.costYen, null);
  const short = await tombo.inspect(packet({ maxElapsedMs: 10, maxModelCalls: 2 }));
  const timed = await tombo.reflect(short.state, { reflect() { return new Promise(() => {}); } });
  assert.equal(timed.state.stopReason, 'model_timeout');
  assert.equal(timed.state.usage.modelCalls, 2);
});

test('reflection uses reservation guards and model/input/output caps', async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect(packet({ maxCostYen: 2 }));
  const missing = await tombo.reflect(first.state, { reflect: critic().reflect });
  assert.equal(missing.state.stopReason, 'budget_accounting_unavailable');
  assert.equal(missing.state.usage.modelCalls, 1);
  const over = await tombo.reflect(first.state, { ...critic(), estimateMaxCostYen: () => 2 });
  assert.equal(over.state.stopReason, 'budget_exhausted');
  assert.equal(over.state.usage.modelCalls, 1);
  const unknown = await tombo.reflect(first.state, critic({}, { usage: { totalTokens: 10, outputTokens: 5, costYen: null } }));
  assert.equal(unknown.state.stopReason, 'budget_accounting_unavailable');
  assert.equal(unknown.state.usage.costYen, null);
  const capped = await tombo.inspect(packet({ maxModelCalls: 1 }));
  assert.equal(capped.state.decision, 'blocked');
  const noCall = await tombo.reflect(capped.state, critic());
  assert.equal(noCall.state.usage.modelCalls, 1);
  assert.equal(noCall.state.stopReason, 'budget_exhausted');
  const limited = await tombo.reflect(first.state, critic({}, { usage: { totalTokens: 1001, outputTokens: 1001, costYen: 1 } }));
  assert.equal(limited.state.stopReason, 'budget_exhausted');
});

test('legacy task and state parsing add no reflection defaults', async () => {
  const legacy = packet(); delete legacy.reflectionRequired;
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect(legacy);
  assert.equal(first.state.decision, 'ready_for_requested_step');
  assert.equal(Object.hasOwn(taskPacketSchema.parse(legacy), 'reflectionRequired'), false);
  assert.equal(Object.hasOwn(stateSchema.parse(first.state), 'reflection'), false);
  assert.equal(taskPacketSchema.safeParse({ ...legacy, reflectionRequired: false }).success, false);
});

test('strict ready survives journal redaction and replay without changing old journal digests', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FileJournal, replayJournal } = await import('../dist/journal.js');
  const directory = await mkdtemp(join(tmpdir(), 'tombo-reflection-'));
  try {
    const tombo = core.createTombo({ adapter: adapter(), now });
    const first = await tombo.inspect({ ...packet(), evidence: [evidence()] });
    const ready = await tombo.reflect(first.state, critic());
    const journal = new FileJournal(join(directory, 'strict.jsonl'));
    await journal.commit(-1, first.state);
    await journal.commit(first.state.revision, ready.state);
    const replayed = await replayJournal(journal.path);
    assert.equal(replayed.decision, 'ready_for_requested_step');
    assert.equal(replayed.reflection.binding.understandingHash, core.understandingHash(replayed));
    assert.equal(replayed.evidence[0].passageUnavailable, true);
    const legacyPacket = packet(); delete legacyPacket.reflectionRequired;
    const legacy = (await tombo.inspect(legacyPacket)).state;
    const event = { schemaVersion: '0.1', sequence: 0, expectedRevision: -1, previousHash: null, stateHash: core.hashPassage(JSON.stringify(legacy)), state: legacy };
    const legacyPath = join(directory, 'legacy.jsonl');
    await writeFile(legacyPath, JSON.stringify(event) + '\n');
    assert.deepEqual(await replayJournal(legacyPath), legacy);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('strict ready rejects a forged or stale receipt and a failed attempt cannot keep ready', async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect({ ...packet(), evidence: [evidence()] });
  const ready = await tombo.reflect(first.state, critic());
  const forged = structuredClone(ready.state);
  forged.reflection.binding.understandingHash = '0'.repeat(64);
  assert.throws(() => core.validateState(forged), { code: 'invalid_input' });
  const withdrawn = tombo.invalidate(ready.state, { evidenceIds: ['restriction'], reason: 'Withdrawn without related gap.' });
  assert.equal(withdrawn.state.decision, 'needs_reflection');
  const failed = await tombo.reflect(ready.state, critic({}, { reviewedClaimIds: [] }));
  assert.equal(failed.state.decision, 'blocked');
  assert.equal(failed.state.stopReason, 'invalid_model_output');
});

test('reflection refuses unavailable passages and oversized input without a model call', async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect({ ...packet(), evidence: [evidence()] });
  const redacted = structuredClone(first.state);
  for (const item of [...redacted.evidence, ...redacted.task.evidence]) { item.passage = ''; item.passageUnavailable = true; }
  const missing = await tombo.reflect(redacted, critic());
  assert.equal(missing.state.stopReason, 'passage_unavailable');
  assert.equal(missing.state.usage.modelCalls, 1);
  const limited = await tombo.inspect(packet({ maxInputChars: 1300 }));
  const oversized = await tombo.reflect(limited.state, critic());
  assert.equal(oversized.state.stopReason, 'input_too_large');
  assert.equal(oversized.state.usage.modelCalls, 1);
});

test('deferred assessment records real observations without generation, then resumes the same batch once', async () => {
  const tombo = core.createTombo({ adapter: adapter(assessed, { claims: [claim], ...candidate }), now });
  const legacy = packet(); delete legacy.reflectionRequired;
  const first = await tombo.inspect(legacy);
  const deferred = await tombo.update(first.state, [observation()], { deferAssessment: true });
  assert.equal(deferred.state.decision, 'blocked');
  assert.equal(deferred.state.stopReason, 'assessment_pending');
  assert.deepEqual(deferred.state.pendingAssessmentExecutionIds, ['read-1']);
  assert.equal(deferred.state.claims[0].status, 'unverified');
  assert.equal(deferred.state.evidence[0].id, 'restriction');
  assert.deepEqual(deferred.state.usage, { rounds: 0, modelCalls: 1, toolCalls: 1, elapsedMs: 2, totalTokens: 10, costYen: 1 });
  assert.equal(deferred.state.revision, 2);
  const resumed = await tombo.update(deferred.state, [observation()]);
  assert.equal(resumed.state.claims[0].status, 'contradicted');
  assert.equal(resumed.state.decision, 'ready_for_requested_step');
  assert.deepEqual(resumed.state.usage, { rounds: 1, modelCalls: 2, toolCalls: 1, elapsedMs: 2, totalTokens: 20, costYen: 2 });
});

test('reflection reservation and late output cannot evade the elapsed cap', async () => {
  let timestamp = now();
  const tombo = core.createTombo({ adapter: adapter(), now: () => timestamp });
  const first = await tombo.inspect(packet({ maxElapsedMs: 100, maxCostYen: 10 }));
  const reserved = await tombo.reflect(first.state, { ...critic(), estimateMaxCostYen() { timestamp += 100; return 1; } });
  assert.equal(reserved.state.stopReason, 'budget_exhausted');
  assert.equal(reserved.state.usage.modelCalls, 1);
  assert.equal(reserved.state.usage.elapsedMs, 100);
  timestamp = now();
  const late = await tombo.reflect(first.state, { ...critic(), async reflect(input) { const output = await critic().reflect(input); timestamp += 101; return output; } });
  assert.equal(late.state.stopReason, 'budget_exhausted');
  assert.equal(late.state.usage.modelCalls, 2);
  assert.equal(late.state.usage.costYen, 2);
  assert.equal(late.state.reflection, undefined);
});

test('a ninth required critic candidate stays visible as a blocker', async () => {
  const tombo = core.createTombo({ adapter: adapter(), now });
  const first = await tombo.inspect(packet());
  const next = await tombo.reflect(first.state, critic({ lenses: [lens], gaps: Array.from({ length: 9 }, (_, i) => ({ ...gap, id: `gap-${i}`, probeIds: [], importance: i === 8 ? 'required' : 'optional' })) }));
  assert.equal(next.state.decision, 'blocked');
  assert.equal(next.state.stopReason, 'candidate_limit');
  assert.deepEqual(next.state.excludedCandidates, [{ id: 'gap-8', reason: 'Candidate cap of 8 reached', importance: 'required' }]);
});

test('repeated deferred delivery preserves the pending state and actual usage', async () => {
  const tombo = core.createTombo({ adapter: adapter(assessed, { claims: [claim], ...candidate }), now });
  const first = await tombo.inspect(packet());
  const deferred = await tombo.update(first.state, [observation()], { deferAssessment: true });
  const duplicate = await tombo.update(deferred.state, [observation()], { deferAssessment: true });
  assert.deepEqual(duplicate.state, deferred.state);
  assert.equal(duplicate.state.usage.toolCalls, 1);
  assert.deepEqual(duplicate.state.pendingAssessmentExecutionIds, ['read-1']);
});
