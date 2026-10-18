import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/core.js';
import * as types from '../dist/types.js';
import { FileJournal } from '../dist/journal.js';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const now = () => Date.parse('2026-10-18T00:00:00Z');
const usage = { totalTokens: 0, outputTokens: 0, costYen: 0 };
const lens = { id: 'lens', label: 'Goal', rationale: 'Check the requested action.', origin: 'initial', status: 'active' };
const gap = (id = 'gap', extra = {}) => ({ id, kind: 'missing_fact', lensId: 'lens', question: 'Which route is required?',
  triggerRefs: ['task:criterion:0'], whyItMatters: 'The route determines the next operation.', importance: 'required', claimIds: [], probeIds: [], ...extra });
const probe = (id = 'probe', gapIds = ['gap']) => ({ id, gapIds, method: 'boundary', question: 'Check the route.', requiredCapability: 'read', sourceGroups: [],
  successCondition: 'Route known.', refutationCondition: 'Route invalid.', inconclusiveCondition: 'Route unknown.' });
const task = extra => ({ schemaVersion: '0.1', taskId: 'policy-test', goal: 'Select the authorised route.', mode: 'execute', successCriteria: ['Choose the route.'],
  evidence: [], capabilities: ['read'], budget: { maxRounds: 30, maxModelCalls: 60, maxToolCalls: 60, maxElapsedMs: 100000, maxInputChars: 1000000, maxOutputTokensPerCall: 1000 }, ...extra });
const evidence = (id = 'ev') => ({ id, kind: 'document', locator: 'fixture:route', sourceGroup: 'route', retrievedAt: '2026-10-18T00:00:00Z', version: '1', scope: 'route', passage: 'Route unknown.', contentHash: core.hashPassage('Route unknown.'), validity: 'current' });
const observation = (executionId, extra = {}) => ({ executionId, probeId: 'probe', outcome: 'no_result', evidence: [], toolCalls: 1, elapsedMs: 1, costYen: 0, ...extra });
function scenario(initial = { lenses: [lens], gaps: [gap('gap', { probeIds: ['probe'] })], probes: [probe()] }, packet = task()) {
  let proposal = {};
  const sdk = core.createTombo({ now, adapter: { async generate(input) { return { proposal: input.operation === 'inspect' ? initial : proposal, usage }; } } });
  return { sdk, packet, initial: () => sdk.inspect(packet), set: value => { proposal = value; } };
}
const critic = (proposal = {}, completion = 'completed') => ({ async reflect(input) { return { binding: input.binding, reviewedClaimIds: input.state.claims.map(c => c.id), completion, limitations: [], proposal, usage }; } });
function history(state, count = 0) {
  state.revision = Math.max(state.revision, count + 1);
  state.policyHistory = { consecutiveNoProgressRounds: count, lastUnderstandingHash: core.understandingHash(state), recentOutcomes: count ? ['no_result'] : ['progress'], lastProgressAtRevision: state.revision - count };
  return state;
}
function evaluate(state) { assert.equal(typeof core.evaluatePolicy, 'function'); return core.evaluatePolicy(state); }
function valid(state) {
  assert.doesNotThrow(() => core.validateState(state));
  assert.equal(state.policyHistory?.lastUnderstandingHash, core.understandingHash(state));
}

test('terminal states retain byte-stable JSON through schema parsing and redaction', async () => {
  const c = scenario(); const first = await c.initial();
  const reflected = await c.sdk.reflect(first.state, critic());
  const failed = await c.sdk.update(reflected.state, []);
  const deferred = await c.sdk.update(reflected.state, [observation('pending')], { deferAssessment: true });
  const inconclusive = await c.sdk.reflect(reflected.state, critic({}, 'inconclusive'));
  for (const state of [first.state, reflected.state, failed.state, deferred.state, inconclusive.state]) {
    assert.equal(JSON.stringify(types.stateSchema.parse(state)), JSON.stringify(state));
    const redacted = structuredClone(state);
    for (const e of redacted.evidence) { e.passage = ''; e.passageUnavailable = true; }
    assert.equal(JSON.stringify(core.validateState(redacted)), JSON.stringify(redacted));
  }
});

test('human question names the supplied next actions that the answer selects', async () => {
  const c = scenario({ lenses: [lens], gaps: [gap('human', { kind: 'ambiguous_intent', humanRole: 'priority' })] },
    task({ proposedActions: ['Run the rapid route.', 'Run the economical route.'] }));
  const r = await c.initial();
  assert.equal(r.state.decision, 'needs_user_input');
  assert.match(r.userQuestions[0], /Run the rapid route/);
  assert.match(r.userQuestions[0], /Run the economical route/);
});

test('policy metadata is additive and does not alter the legacy understanding hash', async () => {
  const s = (await scenario().initial()).state;
  const legacy = structuredClone(s); delete legacy.policyHistory; delete legacy.reflectionEffects;
  assert.doesNotThrow(() => core.validateState(legacy));
  assert.equal(core.understandingHash(history(s)), core.understandingHash(legacy));
  assert.deepEqual(s.policyHistory, { consecutiveNoProgressRounds: 0, lastUnderstandingHash: core.understandingHash(s), recentOutcomes: ['progress'], lastProgressAtRevision: 1 });
});

for (const field of ['policyHistory', 'reflectionEffects', 'confidence', 'interest']) test(`model self-report cannot write ${field}`, () => {
  assert.equal(types.proposalSchema.safeParse({ [field]: {} }).success, false);
  assert.equal(types.reflectionProposalSchema.safeParse({ [field]: {} }).success, false);
});
for (const kind of ['goal', 'priority', 'value', 'permission']) test(`human ${kind} is asked before an unrelated feasible probe`, async () => {
  const s = (await scenario().initial()).state;
  s.gaps.push({ ...gap('human', { kind: 'ambiguous_intent', humanRole: kind }), status: 'open' }); history(s);
  const before = structuredClone(s); const r = evaluate(s);
  assert.equal(r.state.decision, 'needs_user_input'); assert.deepEqual(r.nextProbeIds, []);
  assert.match(r.userQuestions[0], /Which route/); assert.match(r.userQuestions[0], /next|次/);
  assert.match(r.userQuestions[0], /Select the authorised route/); assert.match(r.userQuestions[0], /determines the next operation/);
  assert.deepEqual(s, before);
});
test('goal trigger is early only for ambiguous intent; mixed remaining gaps can still ask', async () => {
  const s = (await scenario().initial()).state; s.gaps[0].triggerRefs = ['task:goal']; history(s);
  assert.equal(evaluate(s).state.decision, 'needs_check');
  s.gaps.push({ ...gap('human', { kind: 'ambiguous_intent', triggerRefs: ['task:goal'] }), status: 'open' }); history(s);
  assert.equal(evaluate(s).state.decision, 'needs_user_input');
  s.probes[0].status = 'unavailable'; s.gaps[1].triggerRefs = ['task:criterion:0']; history(s);
  assert.equal(evaluate(s).state.decision, 'needs_user_input');
});
test('humanRole cannot label an objective fact', () => assert.equal(types.gapDefinitionSchema.safeParse(gap('gap', { humanRole: 'goal' })).success, false));

for (const [name, mutate] of [
  ['null hash', s => { s.policyHistory.lastUnderstandingHash = null; }],
  ['wrong hash', s => { s.policyHistory.lastUnderstandingHash = '0'.repeat(64); }],
  ['future progress', s => { s.policyHistory.lastProgressAtRevision = s.revision + 1; }],
  ['impossible count', s => { s.policyHistory.consecutiveNoProgressRounds = s.revision + 1; }],
  ['FIFO overflow', s => { s.policyHistory.recentOutcomes = Array(11).fill('no_result'); }],
]) test(`metadata rejects ${name}`, async () => {
  const s = history((await scenario().initial()).state); mutate(s);
  assert.throws(() => core.validateState(s), { code: 'invalid_input' });
});

test('first no progress and repeated no progress take distinct paths before general check', async () => {
  const c = scenario({ lenses: [lens], gaps: [gap('gap', { kind: 'ambiguous_intent', probeIds: ['probe'] })], probes: [probe()] });
  const first = await c.initial(); const one = await c.sdk.update(first.state, [observation('one')]);
  assert.equal(one.state.policyHistory.consecutiveNoProgressRounds, 1); assert.equal(one.state.decision, 'blocked');
  const two = await c.sdk.update(one.state, [observation('two')]);
  assert.equal(two.state.policyHistory.consecutiveNoProgressRounds, 2); assert.equal(two.state.decision, 'needs_user_input');
  assert.equal(two.state.stopReason, null); assert.ok(two.userQuestions.length); valid(two.state);
  const repeated = structuredClone(two.state); repeated.task.reflectionRequired = true; history(repeated, 2); repeated.stopReason = 'no_progress';
  assert.equal(evaluate(repeated).state.decision, 'needs_user_input');
  delete repeated.policyHistory; assert.equal(evaluate(repeated).state.decision, 'blocked');
});
test('repeated objective no progress blocks and fatal stops never turn into ask', async () => {
  const s = history((await scenario().initial()).state, 2); s.stopReason = 'no_progress';
  assert.equal(evaluate(s).state.stopReason, 'no_progress');
  s.gaps[0].kind = 'ambiguous_intent'; history(s, 2);
  for (const stop of ['model_error', 'invalid_input', 'candidate_limit', 'budget_exhausted']) {
    s.stopReason = stop; assert.equal(evaluate(s).state.decision, 'blocked'); assert.equal(evaluate(s).state.stopReason, stop);
  }
});

test('deferred assessment holds history; exact replay is free; resume counts once; empty pending is invalid', async () => {
  const c = scenario(); const first = await c.initial(); const obs = observation('pending', { outcome: 'completed', evidence: [evidence()] });
  const deferred = await c.sdk.update(first.state, [obs], { deferAssessment: true });
  assert.equal(deferred.state.policyHistory.consecutiveNoProgressRounds, 0); assert.equal(deferred.state.policyHistory.recentOutcomes.at(-1), 'deferred'); valid(deferred.state);
  const replay = await c.sdk.update(deferred.state, [obs], { deferAssessment: true }); assert.deepEqual(replay.state, deferred.state);
  const invalid = await c.sdk.update(deferred.state, []); assert.equal(invalid.state.stopReason, 'invalid_input'); assert.deepEqual(invalid.state.policyHistory.recentOutcomes, deferred.state.policyHistory.recentOutcomes);
  const resumed = await c.sdk.update(invalid.state, [obs]); assert.equal(resumed.state.policyHistory.consecutiveNoProgressRounds, 1); assert.equal(resumed.state.policyHistory.recentOutcomes.at(-1), 'no_result');
  assert.equal(resumed.state.usage.toolCalls, 1); assert.equal(resumed.state.usage.modelCalls, 2); valid(resumed.state);
  assert.deepEqual((await c.sdk.update(resumed.state, [obs])).state, resumed.state);
  const legacy = structuredClone(resumed.state); delete legacy.policyHistory; assert.equal((await c.sdk.update(legacy, [obs])).state.policyHistory, undefined);
});
test('pending guard preserves a null stop reason ahead of early ask', async () => {
  const c = scenario(); const first = await c.initial(); const s = (await c.sdk.update(first.state, [observation('pending')], { deferAssessment: true })).state;
  s.stopReason = null; s.gaps[0].kind = 'ambiguous_intent'; s.gaps[0].humanRole = 'goal'; history(s);
  const r = evaluate(s); assert.equal(r.state.decision, 'blocked'); assert.equal(r.state.stopReason, null); assert.deepEqual(r.userQuestions, []);
});
test('invalid model output holds counters and refreshes terminal hash without counting a round', async () => {
  const c = scenario(); const first = await c.initial(); c.set({ policyHistory: { consecutiveNoProgressRounds: 99 } });
  const r = await c.sdk.update(first.state, [observation('invalid', { outcome: 'completed', evidence: [evidence()] })]);
  assert.equal(r.state.stopReason, 'invalid_model_output'); assert.equal(r.state.policyHistory.consecutiveNoProgressRounds, 0); valid(r.state);
});
test('normalised nonprogress chooses error before unavailable and bounds FIFO at ten', async () => {
  const c = scenario({ lenses: [lens], gaps: [gap('gap', { probeIds: ['probe', 'other'] })], probes: [probe(), probe('other')] });
  let s = (await c.initial()).state;
  for (let i = 0; i < 11; i++) {
    s = (await c.sdk.update(s, [observation(`error-${i}`, { outcome: 'error' }), observation(`off-${i}`, { probeId: 'other', outcome: 'unavailable' })])).state;
    valid(s);
  }
  assert.equal(s.policyHistory.consecutiveNoProgressRounds, 10); assert.deepEqual(s.policyHistory.recentOutcomes, Array(10).fill('error'));
});
test('old fresh receipt cannot make a no-op update progress', async () => {
  const c = scenario(); const first = await c.initial(); const reflected = await c.sdk.reflect(first.state, critic());
  const next = await c.sdk.update(reflected.state, [observation('noop')]);
  assert.equal(next.state.policyHistory.consecutiveNoProgressRounds, 1); assert.equal(next.state.policyHistory.recentOutcomes.at(-1), 'no_result'); valid(next.state);
});

for (const kind of ['ambiguous_intent', 'missing_fact', 'lens-only']) test(`reflection derives ${kind} provenance and action`, async () => {
  const c = scenario({}, task({ reflectionRequired: true })); const first = await c.initial();
  const added = { ...lens, id: 'new-lens', origin: 'proposed' };
  const proposal = { lenses: [added], ...(kind === 'lens-only' ? {} : { gaps: [gap('new-goal', { kind, lensId: added.id, triggerRefs: ['task:goal'], probeIds: kind === 'missing_fact' ? ['new-probe'] : [] })], ...(kind === 'missing_fact' ? { probes: [probe('new-probe', ['new-goal'])] } : {}) }) };
  const r = await c.sdk.reflect(first.state, critic(proposal)); valid(r.state);
  assert.deepEqual(r.state.reflectionEffects.addedGoalGapIds, kind === 'lens-only' ? [] : ['new-goal']);
  assert.deepEqual(r.state.reflectionEffects.addedLensIds, ['new-lens']);
  assert.equal(r.state.reflectionEffects.appliedRevision, r.state.revision);
  assert.equal(r.state.decision, kind === 'ambiguous_intent' ? 'needs_user_input' : kind === 'missing_fact' ? 'needs_check' : 'needs_reflection');
  if (kind === 'lens-only') assert.deepEqual(r.userQuestions, []);
});
test('effects retain through defer/replay, clear on semantic update/invalidate, and replace on reflection', async () => {
  const c = scenario(); const first = await c.initial(); const reflected = await c.sdk.reflect(first.state, critic());
  const obs = observation('deferred');
  const deferred = await c.sdk.update(reflected.state, [obs], { deferAssessment: true }); assert.deepEqual(deferred.state.reflectionEffects, reflected.state.reflectionEffects); valid(deferred.state);
  const resumed = await c.sdk.update(deferred.state, [obs]); assert.deepEqual(resumed.state.reflectionEffects, reflected.state.reflectionEffects); valid(resumed.state);
  const changed = await c.sdk.update(resumed.state, [observation('new', { outcome: 'completed', evidence: [evidence('new')] })]); assert.equal(changed.state.reflectionEffects, undefined); valid(changed.state);
  const replaced = await c.sdk.reflect(changed.state, critic()); assert.equal(replaced.state.reflectionEffects.binding.basedRevision, changed.state.revision); valid(replaced.state);
  const invalidated = c.sdk.invalidate(replaced.state, { evidenceIds: ['new'], reason: 'Withdrawn.' }); assert.equal(invalidated.state.reflectionEffects, undefined); valid(invalidated.state);
  assert.deepEqual(c.sdk.invalidate(invalidated.state, { evidenceIds: ['new'], reason: 'Already withdrawn.' }).state, invalidated.state);
  const inconclusive = await c.sdk.reflect(replaced.state, critic({}, 'inconclusive')); assert.equal(inconclusive.state.reflectionEffects, undefined); assert.equal(inconclusive.state.policyHistory.consecutiveNoProgressRounds, replaced.state.policyHistory.consecutiveNoProgressRounds); valid(inconclusive.state);
});
for (const [name, mutate] of [
  ['receipt absent', s => { delete s.reflection; }], ['binding task', s => { s.reflectionEffects.binding.taskId = 'other'; }],
  ['binding revision', s => { s.reflectionEffects.binding.basedRevision++; }], ['binding hash', s => { s.reflectionEffects.binding.understandingHash = '0'.repeat(64); }],
  ['applied revision', s => { s.reflectionEffects.appliedRevision++; }], ['unknown gap', s => { s.reflectionEffects.addedGoalGapIds = ['unknown']; }],
  ['unknown lens', s => { s.reflectionEffects.addedLensIds = ['unknown']; }], ['duplicate lens', s => { s.reflectionEffects.addedLensIds = ['new-lens', 'new-lens']; }],
]) test(`reflection metadata rejects ${name}`, async () => {
  const c = scenario(); const s = (await c.sdk.reflect((await c.initial()).state, critic({ lenses: [{ ...lens, id: 'new-lens', origin: 'proposed' }] }))).state;
  assert.ok(s.reflectionEffects); mutate(s); assert.throws(() => core.validateState(s), { code: 'invalid_input' });
});

test('static duplicates count, mixed new evidence and candidates win, and correction counts as progress', async () => {
  const c = scenario({ claims: [{ id: 'claim', role: 'hypothesis', text: 'Route exists.', scope: 'route' }], lenses: [lens], gaps: [gap('gap', { probeIds: ['probe', 'other'] })], probes: [probe(), probe('other')] });
  const initial = await c.initial();
  const one = await c.sdk.update(initial.state, [observation('one', { outcome: 'completed', evidence: [evidence()], staticSnapshot: 'snapshot' })]);
  const two = await c.sdk.update(one.state, [observation('two', { outcome: 'completed', evidence: [evidence('copy')], staticSnapshot: 'snapshot' })]);
  assert.equal(two.state.policyHistory.consecutiveNoProgressRounds, 1); valid(two.state);
  const mixed = await c.sdk.update(one.state, [observation('mixed', { outcome: 'completed', evidence: [evidence('copy')], staticSnapshot: 'snapshot' }), observation('fresh', { probeId: 'other', outcome: 'completed', evidence: [evidence('fresh')] })]);
  assert.equal(mixed.state.policyHistory.consecutiveNoProgressRounds, 0); valid(mixed.state);
  c.set({ lenses: [{ ...lens, id: 'candidate', origin: 'proposed' }] });
  const candidate = await c.sdk.update(two.state, [observation('candidate', { outcome: 'completed', evidence: [evidence('three')], staticSnapshot: 'snapshot' })]);
  assert.equal(candidate.state.policyHistory.consecutiveNoProgressRounds, 0); valid(candidate.state);
  c.set({ assessments: [{ claimId: 'claim', evidenceIds: ['ev'], verdict: 'inconclusive', scopeMatched: true, reason: 'Route remains unknown.' }] });
  const assessed = await c.sdk.update(one.state, [observation('assess', { outcome: 'completed', evidence: [evidence('assess')], staticSnapshot: 'snapshot' })]);
  const old = assessed.state.claims[0].assessments[0];
  c.set({ assessmentCorrections: [{ claimId: 'claim', targetDigest: core.assessmentDigest(old), groundingEvidenceIds: ['correct'], replacement: { ...old, evidenceIds: ['correct'], reason: 'Corrected interpretation.' }, reason: 'Scope corrected.' }] });
  const corrected = await c.sdk.update(assessed.state, [observation('correct', { outcome: 'completed', evidence: [evidence('correct')], staticSnapshot: 'snapshot' })]);
  assert.equal(corrected.state.policyHistory.consecutiveNoProgressRounds, 0); assert.equal(corrected.state.assessmentCorrections.length, 1); valid(corrected.state);
});
test('redaction rehydration preserves the hash and remains a valid accepted transition', async () => {
  const c = scenario(); const first = await c.initial();
  const read = await c.sdk.update(first.state, [observation('read', { outcome: 'completed', evidence: [evidence()] })]);
  const redacted = structuredClone(read.state); redacted.evidence[0].passage = ''; redacted.evidence[0].passageUnavailable = true;
  assert.equal(core.understandingHash(redacted), core.understandingHash(read.state)); valid(redacted);
  const hydrated = await c.sdk.update(redacted, [observation('hydrate', { outcome: 'completed', evidence: [evidence()] })]); valid(hydrated.state); assert.equal(hydrated.state.evidence[0].passageUnavailable, undefined);
});
test('contradiction-only arbitration has a question, but refutation alone is not arbitration', async () => {
  const evs = [evidence('for'), evidence('against')];
  const c = scenario({ claims: [{ id: 'claim', role: 'answer_claim', text: 'Route A is authoritative.', scope: 'route' }], assessments: evs.map((ev, i) => ({ claimId: 'claim', evidenceIds: [ev.id], verdict: i ? 'refutes' : 'supports', scopeMatched: true, reason: 'Conflicting specifications.' })) }, task({ evidence: evs }));
  const s = (await c.initial()).state; const r = evaluate(s);
  assert.equal(r.state.decision, 'needs_user_input'); assert.ok(r.userQuestions.length); assert.match(r.userQuestions[0], /Route A/);
  s.claims[0].assessments.shift(); s.claims[0].status = 'contradicted'; history(s);
  assert.notEqual(evaluate(s).state.decision, 'needs_user_input');
});
test('already resolved approved intent does not ask again', async () => {
  const ev = { ...evidence(), kind: 'user_statement' }; const c = scenario({ lenses: [lens], gaps: [gap('human', { kind: 'ambiguous_intent', humanRole: 'permission', triggerRefs: ['task:goal'] })], resolutions: [{ gapId: 'human', reason: 'not_applicable', evidenceIds: [ev.id], explanation: 'User already approved the route.' }] }, task({ evidence: [ev] }));
  const r = await c.initial(); assert.equal(r.state.decision, 'ready_for_requested_step'); assert.deepEqual(r.userQuestions, []); valid(r.state);
});
test('legacy reflection tool budget uses > while unresolved general budget uses >=', async () => {
  const c = scenario({}, task({ reflectionRequired: true })); const s = (await c.initial()).state;
  s.usage.toolCalls = s.task.budget.maxToolCalls; s.usage.rounds = s.task.budget.maxRounds; history(s);
  assert.equal(evaluate(s).state.decision, 'needs_reflection');
  s.usage.toolCalls++; assert.equal(evaluate(s).state.stopReason, 'budget_exhausted');
  const unresolved = (await scenario().initial()).state; unresolved.usage.toolCalls = unresolved.task.budget.maxToolCalls; history(unresolved);
  assert.equal(evaluate(unresolved).state.stopReason, 'budget_exhausted');
  unresolved.excludedCandidates = [{ id: 'excluded', importance: 'required', reason: 'Cap reached.' }]; history(unresolved); assert.equal(evaluate(unresolved).state.stopReason, 'candidate_limit');
});

async function correctionFixture() {
  let next = {};
  const initial = { claims: [{ id: 'claim', role: 'answer_claim', text: 'Both routes are available.', scope: 'route' }], lenses: [lens],
    gaps: [gap('gap', { kind: 'unsupported_claim', triggerRefs: ['claim'], claimIds: ['claim'], probeIds: ['probe'] })], probes: [probe()] };
  const sdk = core.createTombo({ now, adapter: { estimateMaxCostYen: () => 1, async generate(input) {
    return { proposal: input.operation === 'inspect' ? initial : next, usage: { totalTokens: 3, outputTokens: 2, costYen: 1 } };
  } } });
  const first = await sdk.inspect(task({ reflectionRequired: true }));
  const wrong = { claimId: 'claim', evidenceIds: ['ev'], verdict: 'supports', scopeMatched: true, reason: 'Read as covering both routes.' };
  const replacement = { ...wrong, verdict: 'inconclusive', scopeMatched: false, reason: 'Only one route was measured.' };
  const correction = { claimId: 'claim', targetDigest: core.assessmentDigest(wrong), replacement, groundingEvidenceIds: ['ev'], reason: 'Correct coverage.' };
  next = { assessments: [wrong], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['ev'], explanation: 'Initially read as both routes.' }] };
  const state = (await sdk.update(first.state, [observation('supported', { outcome: 'completed', evidence: [evidence()], costYen: 2 })])).state;
  assert.equal(state.claims[0].status, 'supported');
  return { sdk, state, correction, wrong, set: proposal => { next = proposal; } };
}

for (const budget of [{ maxModelCalls: 3 }, { maxRounds: 2 }, { maxElapsedMs: 2 }, { maxCostYen: 7 }]) {
  test(`metadata-consistent correction retry preserves the ${Object.keys(budget)[0]} limit`, async () => {
    const c = await correctionFixture(); const state = structuredClone(c.state);
    Object.assign(state.task.budget, budget);
    assert.throws(() => core.validateState(state), { code: 'invalid_input' });
    state.policyHistory.lastUnderstandingHash = core.understandingHash(state);
    valid(state);
    c.set({ assessmentCorrections: [c.correction, c.correction] });
    const obs = observation('retry', { outcome: 'completed', evidence: [evidence()], costYen: 2 });
    const failed = await c.sdk.update(state, [obs]);
    assert.equal(failed.state.claims[0].status, 'supported'); assert.equal(failed.state.usage.toolCalls, 2);
    c.set({ assessmentCorrections: [c.correction] });
    const stopped = await c.sdk.update(failed.state, [obs]);
    assert.equal(stopped.state.stopReason, 'budget_exhausted'); assert.equal(stopped.state.claims[0].status, 'supported');
    assert.equal(stopped.state.usage.modelCalls, failed.state.usage.modelCalls); assert.equal(stopped.state.usage.rounds, failed.state.usage.rounds);
    assert.equal(stopped.state.usage.toolCalls, failed.state.usage.toolCalls); valid(stopped.state);
  });
}
test('metadata-consistent corrected journal invalidation preserves another redacted current claim', async () => {
  const c = await correctionFixture(); c.set({ assessmentCorrections: [c.correction] });
  const fixed = await c.sdk.update(c.state, [observation('corrected', { outcome: 'completed', evidence: [evidence()] })]);
  const state = structuredClone(fixed.state); state.evidence.push(evidence('other-ev'));
  state.claims.push({ id: 'other', role: 'observation', text: 'A separate claim.', scope: 'route', status: 'supported', assessments: [{ ...c.wrong, claimId: 'other', evidenceIds: ['other-ev'] }] });
  assert.throws(() => core.validateState(state), { code: 'invalid_input' });
  state.policyHistory.lastUnderstandingHash = core.understandingHash(state); valid(state);
  const directory = await mkdtemp(join(tmpdir(), 'tombo-policy-journal-'));
  try {
    const journal = new FileJournal(join(directory, 'events.jsonl')); await journal.commit(-1, state);
    const redacted = await journal.load(); const invalidated = c.sdk.invalidate(redacted, { evidenceIds: ['ev'], reason: 'Source withdrawn.' });
    assert.equal(invalidated.state.claims[0].status, 'unverified'); assert.equal(invalidated.state.claims[1].status, 'unverified');
    assert.equal(invalidated.state.evidence[1].validity, 'current'); valid(invalidated.state);
    await journal.commit(redacted.revision, invalidated.state); assert.equal((await journal.load()).claims[1].status, 'unverified');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('journal snapshot conflicts precede metadata integrity while malformed shapes remain invalid input', async () => {
  const state = (await scenario().initial()).state;
  const directory = await mkdtemp(join(tmpdir(), 'tombo-policy-order-'));
  try {
    const journal = new FileJournal(join(directory, 'events.jsonl')); await journal.commit(-1, state);
    const before = await readFile(journal.path, 'utf8');
    const fork = structuredClone(state); fork.task.goal = 'A different goal.';
    assert.throws(() => core.validateState(fork), { code: 'invalid_input' });
    await assert.rejects(journal.assertCurrent(fork), { code: 'revision_conflict' });
    fork.revision++;
    await assert.rejects(journal.commit(state.revision, fork), { code: 'revision_conflict' });
    for (const malformed of [{}, { ...state, task: null }, { ...state, policyHistory: { impossible: true } }]) {
      await assert.rejects(journal.assertCurrent(malformed), { code: 'invalid_input' });
      await assert.rejects(journal.commit(state.revision, malformed), { code: 'invalid_input' });
    }
    assert.equal(await readFile(journal.path, 'utf8'), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('journal-backed CLI rejects a fork before importing generation and preserves malformed-input errors', async () => {
  const state = (await scenario().initial()).state;
  const directory = await mkdtemp(join(tmpdir(), 'tombo-policy-cli-'));
  try {
    const ledger = join(directory, 'events.jsonl'); await new FileJournal(ledger).commit(-1, state);
    const before = await readFile(ledger, 'utf8'); const path = join(directory, 'state.json');
    const adapter = join(directory, 'adapter.mjs'); const marker = join(directory, 'imported.txt');
    await writeFile(adapter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export default { generate() { throw new Error('Generation must not run.'); } };`);
    const fork = structuredClone(state); fork.task.goal = 'Forked task.';
    for (const [payload, code] of [[JSON.stringify(fork), 'revision_conflict'], ['{', 'invalid_input'], ['null', 'invalid_input'], [JSON.stringify({ ...state, gaps: 'bad' }), 'invalid_input']]) {
      await writeFile(path, payload);
      const run = spawnSync(process.execPath, [resolve('dist/cli.js'), 'update', '--state', path, '--observations', join(directory, 'unread.json'), '--adapter', `file:${adapter}`, '--ledger', ledger], { encoding: 'utf8' });
      assert.equal(run.status, 1); assert.equal(JSON.parse(run.stderr).error.code, code);
      assert.equal(run.stdout, ''); assert.equal(await readFile(ledger, 'utf8'), before);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('session preparation binds a fork without executing it; journal-backed execution checks authority first', async () => {
  const state = (await scenario().initial()).state;
  const directory = await mkdtemp(join(tmpdir(), 'tombo-policy-session-'));
  try {
    const ledger = join(directory, 'events.jsonl'); await new FileJournal(ledger).commit(-1, state);
    const before = await readFile(ledger, 'utf8'); const path = join(directory, 'state.json'); const observations = join(directory, 'obs.json');
    const helper = resolve('skills/tombo-view/scripts/session.mjs');
    const run = (...args) => spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: process.cwd() } });
    await writeFile(observations, JSON.stringify([observation('attempt')]));
    const fork = structuredClone(state); fork.task.goal = 'Forked task.'; await writeFile(path, JSON.stringify(fork));
    const prepared = run('prepare', '--state', path, '--observations', observations);
    assert.equal(prepared.status, 0, prepared.stderr); assert.equal(JSON.parse(prepared.stdout).apiCallsMade, 0);
    assert.deepEqual(JSON.parse(prepared.stdout).request.state.policyHistory, fork.policyHistory);
    assert.throws(() => core.validateState(fork), { code: 'invalid_input' });
    const unbound = run('update', '--state', path, '--observations', observations, '--proposal', join(directory, 'unread-plan.json'));
    assert.equal(unbound.status, 1); assert.equal(JSON.parse(unbound.stderr).error.code, 'invalid_input');
    for (const command of ['prepare', 'update']) {
      const rejected = run(command, '--state', path, '--observations', observations, '--proposal', join(directory, 'unread-plan.json'), '--ledger', ledger);
      assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stderr).error.code, 'revision_conflict'); assert.equal(rejected.stdout, '');
    }
    for (const payload of ['{', 'null', JSON.stringify({ ...state, claims: null })]) {
      await writeFile(path, payload);
      const rejected = run('update', '--state', path, '--observations', observations, '--proposal', join(directory, 'unread-plan.json'), '--ledger', ledger);
      assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_input');
    }
    assert.equal(await readFile(ledger, 'utf8'), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
