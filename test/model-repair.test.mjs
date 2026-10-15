import test from 'node:test';
import assert from 'node:assert/strict';
import { createTombo, hashPassage, understandingHash, validateState, stateSchema, TomboError, runUnderstandingCheck } from '../dist/index.js';

const now = () => Date.parse('2026-10-14T00:00:00.000Z');
const usage = { totalTokens: 10, outputTokens: 5, costYen: 1 };
const claim = { id: 'answer', role: 'answer_claim', text: 'The operation is available.', scope: 'contract-v1' };
const corrected = { ...claim, id: 'corrected', text: 'The operation is unavailable.' };
const lens = { id: 'boundary', label: 'Boundary', rationale: 'Check eligibility', origin: 'proposed', status: 'active' };
const gap = { id: 'eligibility', kind: 'missing_fact', lensId: lens.id, question: 'Is the account eligible?', triggerRefs: ['answer'], whyItMatters: 'Eligibility prevents the operation.', importance: 'required', claimIds: ['answer'], probeIds: ['read-contract'] };
const probe = { id: 'read-contract', gapIds: [gap.id], method: 'counterexample', question: 'Read restrictions.', requiredCapability: 'read_document', sourceGroups: ['contract'], successCondition: 'Eligible.', refutationCondition: 'Ineligible.', inconclusiveCondition: 'Absent.' };
const initial = { claims: [claim], lenses: [lens], gaps: [gap], probes: [probe] };
const repaired = { claims: [corrected], assessments: [
  { claimId: 'answer', evidenceIds: ['restriction'], verdict: 'refutes', scopeMatched: true, reason: 'The contract excludes this account.' },
  { claimId: 'corrected', evidenceIds: ['restriction'], verdict: 'supports', scopeMatched: true, reason: 'The contract excludes this account.' },
], resolutions: [{ gapId: gap.id, reason: 'refuted', evidenceIds: ['restriction'], explanation: 'The exclusion answers the check.' }] };
function packet(budget = {}) {
  return { schemaVersion: '0.1', taskId: 'repair-test', goal: 'Check availability.', mode: 'execute', successCriteria: ['Check the contract.'], proposedAnswer: claim.text, reflectionRequired: true, evidence: [], capabilities: ['read_document'], budget: { maxRounds: 1, maxModelCalls: 12, maxToolCalls: 1, maxElapsedMs: 10000, maxInputChars: 100000, maxOutputTokensPerCall: 1000, ...budget } };
}
function observation() {
  const passage = 'The account is ineligible.';
  return { executionId: 'read-1', probeId: probe.id, outcome: 'completed', toolCalls: 1, elapsedMs: 2, costYen: 0, evidence: [{ id: 'restriction', kind: 'document', locator: 'fixture:contract', sourceGroup: 'contract', retrievedAt: '2026-10-14T00:00:00.000Z', version: '1', scope: 'contract-v1', passage, contentHash: hashPassage(passage), validity: 'current' }] };
}
function adapter(update = () => repaired, inspect = () => initial) {
  return { estimateMaxCostYen: () => 1, async generate(input) { return { proposal: input.operation === 'inspect' ? inspect(input) : update(input), usage }; } };
}
function critic(change = () => ({})) {
  return { estimateMaxCostYen: () => 1, async reflect(input) { return { binding: input.binding, reviewedClaimIds: input.state.claims.map(item => item.id), completion: 'completed', limitations: [], proposal: {}, usage, ...change(input) }; } };
}
function tombo(generation = adapter(), extra = {}) { return createTombo({ adapter: generation, now, maxModelRepairAttempts: 1, ...extra }); }

for (const bad of [-1, 3, 0.5, NaN, Infinity, '1', null]) test(`invalid repair setting ${String(bad)} is rejected before generation`, () => {
  assert.throws(() => tombo(adapter(), { maxModelRepairAttempts: bad }), { code: 'invalid_input' });
});

test('inspect rejects an entire malformed candidate then accepts a fresh proposal with typed feedback', async () => {
  const inputs = [];
  const api = tombo(adapter(undefined, input => { inputs.push(input); return inputs.length === 1 ? { claims: [claim, claim] } : initial; }));
  const result = await api.inspect(packet());
  assert.equal(result.state.decision, 'needs_check');
  assert.deepEqual(result.state.claims.map(item => item.id), ['answer']);
  assert.equal(result.state.usage.modelCalls, 2);
  assert.equal(result.state.usage.totalTokens, 20);
  assert.equal(result.state.usage.costYen, 2);
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.startedAt, '2026-10-14T00:00:00.000Z');
  assert.equal(inputs[0].validationFeedback, undefined);
  assert.deepEqual(inputs[1].validationFeedback, { code: 'invalid_model_output', message: 'Existing entity cannot be overwritten answer', rejectedAttempt: 1, maxAttempts: 2 });
  assert.deepEqual(result.state.modelRepairDiagnostics, [{ operation: 'inspect', ...inputs[1].validationFeedback }]);
});

test('duplicate answer stays immutable while a repaired update uses the same observation once and needs a fresh critic', async () => {
  const inputs = [];
  const api = tombo(adapter(input => { inputs.push(input); return inputs.length === 1 ? { ...repaired, claims: [claim, corrected] } : repaired; }));
  const first = await api.inspect(packet());
  const original = structuredClone(first.state);
  const result = await api.update(first.state, [observation()]);
  assert.equal(result.state.decision, 'needs_reflection');
  assert.deepEqual(result.state.claims.map(item => [item.id, item.status]), [['answer', 'contradicted'], ['corrected', 'supported']]);
  assert.equal(result.state.claims[0].text, claim.text);
  assert.equal(result.state.gaps[0].status, 'resolved');
  assert.equal(result.state.pendingAssessmentExecutionIds, undefined);
  assert.deepEqual(result.state.usage, { rounds: 1, modelCalls: 3, toolCalls: 1, elapsedMs: 2, totalTokens: 30, costYen: 3 });
  assert.equal(result.state.appliedExecutions.length, 1);
  assert.equal(result.state.revision, 2);
  assert.deepEqual(first.state, original);
  assert.deepEqual(inputs[1].observations, inputs[0].observations);
  assert.deepEqual(inputs[1].state.claims, inputs[0].state.claims);
  assert.equal(inputs[1].validationFeedback.rejectedAttempt, 1);
  const ready = await api.reflect(result.state, critic());
  assert.equal(ready.state.decision, 'ready_for_requested_step');
  assert.deepEqual(ready.state.reflection.reviewedClaimIds, ['answer', 'corrected']);
  assert.equal(ready.state.reflection.binding.understandingHash, understandingHash(ready.state));
});

test('validation failure after candidate mutation leaks no claim, assessment or resolution', async () => {
  const inputs = [];
  const api = tombo(adapter(input => {
    inputs.push(input);
    return inputs.length === 1 ? { ...repaired, resolutions: [...repaired.resolutions, { ...repaired.resolutions[0], gapId: 'absent' }] } : repaired;
  }));
  const first = await api.inspect(packet());
  const next = await api.update(first.state, [observation()]);
  assert.deepEqual(inputs[1].state.claims.map(item => [item.id, item.status, item.assessments.length]), [['answer', 'unverified', 0]]);
  assert.equal(inputs[1].state.gaps[0].status, 'open');
  assert.equal(inputs[1].state.gaps[0].resolution, undefined);
  assert.equal(next.state.claims[1].status, 'supported');
  assert.equal(next.state.claims[0].assessments.length, 1);
});

test('reflection repairs exact binding and coverage without making criticism evidence', async () => {
  const api = tombo(adapter(undefined, () => ({ claims: [claim] })));
  const first = await api.inspect(packet());
  const inputs = [];
  const result = await api.reflect(first.state, critic(input => { inputs.push(input); return inputs.length === 1 ? { reviewedClaimIds: [] } : {}; }));
  assert.equal(result.state.decision, 'ready_for_requested_step');
  assert.equal(result.state.usage.modelCalls, 3);
  assert.equal(result.state.usage.totalTokens, 30);
  assert.equal(result.state.claims[0].status, 'unverified');
  assert.deepEqual(result.state.evidence, []);
  assert.deepEqual(inputs[1].binding, inputs[0].binding);
  assert.equal(inputs[1].validationFeedback.code, 'invalid_model_output');
  assert.equal(result.state.modelRepairDiagnostics[0].operation, 'reflect');
  const forged = structuredClone(result.state);
  forged.reflection.binding.understandingHash = '0'.repeat(64);
  assert.throws(() => validateState(forged), { code: 'invalid_input' });
  const bookkeeping = structuredClone(result.state);
  delete bookkeeping.modelRepairDiagnostics;
  assert.equal(understandingHash(bookkeeping), understandingHash(result.state));
});

test('persistent rejection stops after three attempts with preserved pending evidence and diagnostics', async () => {
  const api = tombo(adapter(() => ({ ...repaired, claims: [claim, corrected] })), { maxModelRepairAttempts: 2 });
  const first = await api.inspect(packet());
  const next = await api.update(first.state, [observation()]);
  assert.equal(next.state.stopReason, 'invalid_model_output');
  assert.equal(next.state.decision, 'blocked');
  assert.deepEqual(next.state.pendingAssessmentExecutionIds, ['read-1']);
  assert.deepEqual(next.state.claims, first.state.claims);
  assert.equal(next.state.evidence[0].id, 'restriction');
  assert.equal(next.state.usage.rounds, 1);
  assert.equal(next.state.usage.toolCalls, 1);
  assert.equal(next.state.usage.modelCalls, 4);
  assert.equal(next.state.usage.costYen, 4);
  assert.deepEqual(next.state.modelRepairDiagnostics.map(item => item.rejectedAttempt), [1, 2, 3]);
  assert.equal(next.state.modelRepairDiagnostics[2].maxAttempts, 3);
});

for (const config of [{}, { maxModelRepairAttempts: 0 }]) test(`default repair remains off ${JSON.stringify(config)}`, async () => {
  const api = createTombo({ adapter: adapter(() => ({ claims: [claim] })), now, ...config });
  const first = await api.inspect(packet());
  const next = await api.update(first.state, [observation()]);
  assert.equal(next.state.stopReason, 'invalid_model_output');
  assert.equal(next.state.usage.modelCalls, 2);
  assert.equal(Object.hasOwn(next.state, 'modelRepairDiagnostics'), false);
  assert.deepEqual(stateSchema.parse(next.state), next.state);
  const invalid = createTombo({ adapter: adapter(undefined, () => ({ claims: [claim, claim] })), now, ...config });
  await assert.rejects(invalid.inspect(packet()), { code: 'invalid_model_output' });
});

test('rejected inspect exposes actual usage and bounded diagnostics when opted in', async () => {
  const api = tombo(adapter(undefined, () => ({ claims: [{ ...claim, id: 'x'.repeat(200) }, { ...claim, id: 'x'.repeat(200) }] })));
  const next = await api.inspect(packet());
  assert.equal(next.state.stopReason, 'invalid_model_output');
  assert.deepEqual(next.state.claims, []);
  assert.equal(next.state.usage.modelCalls, 2);
  assert.equal(next.state.usage.costYen, 2);
  assert.equal(next.state.modelRepairDiagnostics.length, 2);
  assert.ok(next.state.modelRepairDiagnostics.every(item => item.message.length <= 512));
});

for (const failure of ['model_error', 'model_timeout', 'budget_accounting_unavailable', 'invalid_input', 'untyped']) test(`repair stops provider or operational failure ${failure}`, async () => {
  let calls = 0;
  const api = tombo({ async generate() { calls++; if (failure === 'untyped') throw new Error('Provider unavailable'); throw new TomboError(failure, 'Operational failure'); } });
  const next = await api.inspect(packet());
  assert.equal(next.state.stopReason, failure === 'untyped' ? 'model_error' : failure);
  assert.equal(next.state.usage.modelCalls, 1);
  assert.equal(calls, 1);
  assert.equal(next.state.usage.costYen, null);
});

for (const config of [{}, { maxModelRepairAttempts: 0 }]) test(`legacy transport retry remains available ${JSON.stringify(config)}`, async () => {
  let calls = 0;
  const api = createTombo({ adapter: { async generate() { if (++calls === 1) throw new Error('Transient'); return { proposal: initial, usage }; } }, now, ...config });
  const result = await api.inspect(packet());
  assert.equal(result.state.decision, 'needs_check');
  assert.equal(result.state.usage.modelCalls, 2);
  assert.equal(result.state.usage.costYen, null);
});

test('typed host output rejection can be repaired without inventing unknown usage', async () => {
  let calls = 0;
  const api = tombo({ async generate(input) {
    if (++calls === 1) throw new TomboError('invalid_model_output', 'Output exceeds character cap. Shorten the proposal.');
    assert.equal(input.validationFeedback.message, 'Output exceeds character cap. Shorten the proposal.');
    return { proposal: initial, usage };
  } });
  const next = await api.inspect(packet());
  assert.equal(next.state.decision, 'needs_check');
  assert.equal(next.state.usage.modelCalls, 2);
  assert.equal(next.state.usage.totalTokens, null);
  assert.equal(next.state.usage.costYen, null);
});

test('unknown monetary usage stops before a repair reservation and preserves rejection diagnostics', async () => {
  let calls = 0;
  const api = tombo({ estimateMaxCostYen: () => 1, async generate() { calls++; throw new TomboError('invalid_model_output', 'Output exceeds character cap.'); } });
  const next = await api.inspect(packet({ maxCostYen: 10 }));
  assert.equal(next.state.stopReason, 'budget_accounting_unavailable');
  assert.equal(next.state.usage.modelCalls, 1);
  assert.equal(calls, 1);
  assert.equal(next.state.usage.costYen, null);
});

for (const [name, reported, expected] of [
  ['unknown cost', { ...usage, costYen: null }, 'budget_accounting_unavailable'],
  ['invalid usage', { ...usage, totalTokens: -1 }, 'budget_accounting_unavailable'],
  ['missing output accounting', { totalTokens: null, costYen: 1 }, 'budget_accounting_unavailable'],
  ['output token cap', { ...usage, outputTokens: 1001 }, 'budget_exhausted'],
  ['excess cost', { ...usage, costYen: 2 }, 'budget_accounting_unavailable'],
]) test(`accounting precedes proposal validation for ${name}`, async () => {
  let calls = 0;
  const api = tombo({ estimateMaxCostYen: () => 1, async generate() { calls++; return { proposal: { unexpected: true }, usage: reported }; } });
  const next = await api.inspect(packet({ maxCostYen: 10 }));
  assert.equal(next.state.stopReason, expected);
  assert.equal(next.state.usage.modelCalls, 1);
  assert.equal(calls, 1);
});

test('each repair reserves its remaining monetary budget', async () => {
  const api = tombo(adapter(undefined, () => ({ claims: [claim, claim] })));
  const next = await api.inspect(packet({ maxCostYen: 1.5 }));
  assert.equal(next.state.stopReason, 'budget_exhausted');
  assert.equal(next.state.usage.modelCalls, 1);
  assert.equal(next.state.usage.costYen, 1);
  assert.equal(next.state.modelRepairDiagnostics.length, 1);
});

test('exact call cap stops retries without new tools or rounds', async () => {
  const api = tombo(adapter(() => ({ claims: [claim] })), { maxModelRepairAttempts: 2 });
  const first = await api.inspect(packet({ maxModelCalls: 2 }));
  const next = await api.update(first.state, [observation()]);
  assert.equal(next.state.stopReason, 'budget_exhausted');
  assert.equal(next.state.usage.modelCalls, 2);
  assert.equal(next.state.usage.rounds, 1);
  assert.equal(next.state.usage.toolCalls, 1);
  assert.deepEqual(next.state.pendingAssessmentExecutionIds, ['read-1']);
});

test('late malformed output cannot obtain another attempt', async () => {
  let timestamp = now();
  let calls = 0;
  const api = tombo({ async generate() { calls++; timestamp += 100; return { proposal: { unexpected: true }, usage }; } }, { now: () => timestamp });
  const next = await api.inspect(packet({ maxElapsedMs: 100 }));
  assert.equal(next.state.stopReason, 'budget_exhausted');
  assert.equal(next.state.usage.elapsedMs, 100);
  assert.equal(next.state.usage.modelCalls, 1);
  assert.equal(next.state.usage.costYen, 1);
  assert.equal(calls, 1);
});

test('timeout does not retry or apply late proposals', async () => {
  let calls = 0;
  const api = tombo({ async generate() { calls++; await new Promise(resolve => setTimeout(resolve, 25)); return { proposal: initial, usage }; } });
  const next = await api.inspect(packet({ maxElapsedMs: 5 }));
  assert.equal(next.state.stopReason, 'model_timeout');
  assert.equal(next.state.usage.modelCalls, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.deepEqual(next.state.claims, []);
});

test('runner executes one probe while update repair consumes only model calls', async () => {
  let updates = 0;
  let tools = 0;
  const api = tombo(adapter(() => ++updates === 1 ? { ...repaired, claims: [claim, corrected] } : repaired), { now: Date.now });
  const result = await runUnderstandingCheck({ tombo: api, task: packet(), critic: critic(), executor: { async execute(input) { tools++; return { ...observation(), executionId: input.executionId }; } } });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.state.decision, 'ready_for_requested_step');
  assert.equal(result.result.state.usage.modelCalls, 4);
  assert.equal(result.result.state.usage.toolCalls, 1);
  assert.equal(result.result.state.usage.rounds, 1);
  assert.equal(tools, 1);
});

test('a reservation failure labelled as invalid output is never a model repair', async () => {
  let reservations = 0;
  let generations = 0;
  const api = tombo({ estimateMaxCostYen() { reservations++; throw new TomboError('invalid_model_output', 'Estimator failed.'); }, async generate() { generations++; return { proposal: initial, usage }; } });
  const next = await api.inspect(packet({ maxCostYen: 10 }));
  assert.equal(next.state.stopReason, 'invalid_model_output');
  assert.equal(next.state.usage.modelCalls, 0);
  assert.equal(reservations, 1);
  assert.equal(generations, 0);
  assert.equal(next.state.modelRepairDiagnostics, undefined);
});

test('an exact deferred batch repairs without replay, then successful redelivery is free', async () => {
  let updates = 0;
  const api = tombo(adapter(() => ++updates === 1 ? { claims: [claim] } : repaired));
  const first = await api.inspect(packet());
  const pending = await api.update(first.state, [observation()], { deferAssessment: true });
  const next = await api.update(pending.state, [observation()]);
  assert.equal(next.state.decision, 'needs_reflection');
  assert.equal(next.state.usage.rounds, 1);
  assert.equal(next.state.usage.toolCalls, 1);
  assert.equal(next.state.usage.modelCalls, 3);
  assert.deepEqual((await api.update(next.state, [observation()])).state, next.state);
  const collision = await api.update(pending.state, [{ ...observation(), elapsedMs: 3 }]);
  assert.equal(collision.state.stopReason, 'invalid_input');
  assert.equal(collision.state.usage.modelCalls, 1);
});

test('valid output token accounting permits unknown totals and costs without a monetary cap', async () => {
  let calls = 0;
  const api = tombo({ async generate() { return { proposal: ++calls === 1 ? { claims: [claim, claim] } : initial, usage: { totalTokens: null, outputTokens: 5, costYen: null } }; } });
  const next = await api.inspect(packet());
  assert.equal(next.state.decision, 'needs_check');
  assert.equal(next.state.usage.modelCalls, 2);
  assert.equal(next.state.usage.totalTokens, null);
  assert.equal(next.state.usage.costYen, null);
});

test('feedback characters count towards the same input cap before another generation', async () => {
  const task = packet();
  task.budget.maxInputChars = JSON.stringify({ operation: 'inspect', task, maxOutputTokens: task.budget.maxOutputTokensPerCall }).length + 50;
  let calls = 0;
  const api = tombo({ async generate() { calls++; return { proposal: { claims: [claim, claim] }, usage }; } });
  const next = await api.inspect(task);
  assert.equal(next.state.stopReason, 'input_too_large');
  assert.equal(next.state.usage.modelCalls, 1);
  assert.equal(calls, 1);
  assert.equal(next.state.modelRepairDiagnostics[0].code, 'invalid_model_output');
});

test('repair cannot resolve unknown observations or turn critic candidates into completion', async () => {
  const api = tombo(adapter(() => repaired));
  const first = await api.inspect(packet());
  const unknown = await api.update(first.state, [{ ...observation(), outcome: 'no_result', evidence: [] }]);
  assert.equal(unknown.state.stopReason, 'invalid_model_output');
  assert.equal(unknown.state.gaps[0].status, 'open');
  assert.equal(unknown.state.claims[0].status, 'unverified');
  assert.deepEqual(unknown.state.pendingAssessmentExecutionIds, ['read-1']);
  const cannotBypass = await api.reflect(unknown.state, critic());
  assert.equal(cannotBypass.state.stopReason, 'assessment_pending');
  assert.equal(cannotBypass.state.usage.modelCalls, 3);
  const empty = await tombo(adapter(undefined, () => ({ claims: [claim] }))).inspect(packet());
  let reviews = 0;
  const challenged = await api.reflect(empty.state, critic(() => ++reviews === 1 ? { proposal: { assessments: [] } } : { proposal: { lenses: [lens], gaps: [gap], probes: [probe] } }));
  assert.equal(challenged.state.decision, 'needs_check');
  assert.equal(challenged.state.claims[0].status, 'unverified');
  assert.notEqual(challenged.state.reflection.binding.understandingHash, understandingHash(challenged.state));
  assert.equal(challenged.state.usage.modelCalls, 3);
});

test('inconclusive reflection is a stop and never an invitation to repair', async () => {
  const api = tombo(adapter(undefined, () => ({ claims: [claim] })));
  const first = await api.inspect(packet());
  const next = await api.reflect(first.state, critic(() => ({ completion: 'inconclusive', limitations: ['The appendix is unavailable.'] })));
  assert.equal(next.state.stopReason, 'reflection_inconclusive');
  assert.equal(next.state.usage.modelCalls, 2);
  assert.equal(next.state.modelRepairDiagnostics, undefined);
});

test('repair diagnostics survive journal replay without certifying changed evidence', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FileJournal, replayJournal } = await import('../dist/journal.js');
  const directory = await mkdtemp(join(tmpdir(), 'tombo-repair-'));
  try {
    let updates = 0;
    const api = tombo(adapter(() => ++updates === 1 ? { claims: [claim] } : repaired));
    const first = await api.inspect(packet());
    const next = await api.update(first.state, [observation()]);
    const ready = await api.reflect(next.state, critic());
    const journal = new FileJournal(join(directory, 'repair.jsonl'));
    await journal.commit(-1, first.state);
    await journal.commit(first.state.revision, next.state);
    await journal.commit(next.state.revision, ready.state);
    const replayed = await replayJournal(journal.path);
    assert.equal(replayed.decision, 'ready_for_requested_step');
    assert.deepEqual(replayed.modelRepairDiagnostics, ready.state.modelRepairDiagnostics);
    const stale = structuredClone(ready.state);
    stale.evidence[0].validity = 'withdrawn';
    assert.throws(() => validateState(stale), { code: 'invalid_input' });
    const legacy = (await createTombo({ adapter: adapter(), now }).inspect(packet())).state;
    const serialized = JSON.stringify(legacy);
    assert.equal(JSON.stringify(stateSchema.parse(legacy)), serialized);
    const event = { schemaVersion: '0.1', sequence: 0, expectedRevision: -1, previousHash: null, stateHash: hashPassage(serialized), state: legacy };
    const path = join(directory, 'legacy.jsonl');
    await writeFile(path, JSON.stringify(event) + '\n');
    assert.deepEqual(await replayJournal(path), legacy);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
