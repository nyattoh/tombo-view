import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as sdk from '../dist/index.js';

const now = '2026-10-14T00:00:00.000Z';
const scope = 'release-A-latency';
const usage = { totalTokens: 3, outputTokens: 2, costYen: 1 };
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const evidence = (id, passage, overrides = {}) => ({ id, kind: 'document', locator: `local:${id}`, sourceGroup: id, retrievedAt: now, version: '1', scope, passage, contentHash: sdk.hashPassage(passage), validity: 'current', ...overrides });
const warm = evidence('warm', 'Warm p95 is 610 ms. Cold starts were not measured.');
const cold = evidence('cold', 'Cold p95 is 2130 ms.');
const assessment = (verdict = 'supports', overrides = {}) => ({ claimId: 'claim', evidenceIds: ['warm'], verdict, scopeMatched: true, reason: 'The report establishes both conditions.', ...overrides });
const wrong = assessment();
const replacement = assessment('inconclusive', { scopeMatched: false, reason: 'Warm-only coverage cannot establish both conditions.' });
const correction = (target = wrong, next = replacement, overrides = {}) => ({ claimId: 'claim', targetDigest: digest(target), replacementDigest: digest(next), groundingEvidenceIds: next.evidenceIds, reason: 'The original interpretation included an unmeasured condition.', ...overrides });
const observation = (executionId = 'read-1', items = [warm]) => ({ executionId, probeId: 'probe', outcome: 'completed', evidence: items, toolCalls: 1, elapsedMs: 1, costYen: 2 });
const initialProposal = {
  claims: [{ id: 'claim', role: 'answer_claim', text: 'Warm and cold p95 are both at most 800 ms.', scope }],
  lenses: [{ id: 'lens', label: 'Coverage', rationale: 'Check both conditions.', origin: 'initial', status: 'active' }],
  gaps: [{ id: 'gap', kind: 'unsupported_claim', lensId: 'lens', question: 'Are both conditions measured?', triggerRefs: ['claim'], whyItMatters: 'Both are part of the answer.', importance: 'required', claimIds: ['claim'], probeIds: ['probe'] }],
  probes: [{ id: 'probe', gapIds: ['gap'], method: 'boundary', question: 'Read the report.', requiredCapability: 'read_document', sourceGroups: [], successCondition: 'Both below 800 ms.', refutationCondition: 'Either exceeds 800 ms.', inconclusiveCondition: 'Missing measurements.' }],
};
const packet = overrides => ({ schemaVersion: '0.1', taskId: 'assessment-correction', mode: 'explain', goal: 'Check both start conditions.', successCriteria: ['Both conditions below 800 ms.'], proposedAnswer: 'Both are below 800 ms.', reflectionRequired: true, evidence: [], capabilities: ['read_document'], budget: { maxRounds: 20, maxModelCalls: 30, maxToolCalls: 20, maxElapsedMs: 120000, maxInputChars: 48000, maxOutputTokensPerCall: 4000 }, ...overrides });
const critic = { async reflect(input) { return { binding: input.binding, reviewedClaimIds: input.state.claims.map(item => item.id), completion: 'completed', limitations: [], proposal: {}, usage }; } };
function engine(options = {}) {
  let next = {};
  const inputs = [];
  const tombo = sdk.createTombo({ now: () => new Date(now), ...options, adapter: { estimateMaxCostYen: () => 1, async generate(input) { inputs.push(input); return { proposal: input.operation === 'inspect' ? initialProposal : typeof next === 'function' ? next(input) : next, usage }; } } });
  return { tombo, inputs, set(proposal) { next = proposal; } };
}
async function supported(options) {
  const context = engine(options);
  const first = await context.tombo.inspect(packet());
  context.set({ assessments: [wrong], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['warm'], explanation: 'Incorrect reading includes both conditions.' }] });
  const state = (await context.tombo.update(first.state, [observation()])).state;
  assert.equal(state.claims[0].status, 'supported');
  return { ...context, first, state };
}

test('SDK reread correction reopens the required gap without withdrawing the source or erasing history', async () => {
  const context = await supported();
  const reviewed = await context.tombo.reflect(context.state, critic);
  assert.equal(reviewed.state.decision, 'ready_for_requested_step');
  context.set({ assessments: [replacement], assessmentCorrections: [correction()] });
  const fixed = await context.tombo.update(reviewed.state, [observation('reread')]);
  assert.equal(fixed.state.claims[0].status, 'unverified');
  assert.equal(fixed.state.gaps[0].status, 'open');
  assert.equal(fixed.state.gaps[0].resolution, undefined);
  assert.equal(fixed.state.stopReason, null);
  assert.equal(fixed.state.decision, 'needs_check');
  assert.deepEqual(fixed.state.claims[0].assessments, [wrong, replacement]);
  assert.deepEqual(fixed.state.evidence, [warm]);
  assert.deepEqual(fixed.state.assessmentCorrections, [correction()]);
  assert.notEqual(sdk.understandingHash(fixed.state), reviewed.state.reflection.binding.understandingHash);
  const rereviewed = await context.tombo.reflect(fixed.state, critic);
  assert.equal(rereviewed.state.decision, 'needs_check');
  assert.equal(sdk.validateState(rereviewed.state).claims[0].status, 'unverified');
});

test('SDK accepts refuted resolution after correcting the mistaken support and requires fresh reflection', async () => {
  const context = await supported();
  const reviewed = await context.tombo.reflect(context.state, critic);
  const refutes = assessment('refutes', { evidenceIds: ['cold'], reason: 'Cold p95 exceeds 800 ms.' });
  context.set({ assessments: [replacement, refutes], assessmentCorrections: [correction()], resolutions: [{ gapId: 'gap', reason: 'refuted', evidenceIds: ['cold'], explanation: 'The measured cold condition refutes the combined claim.' }] });
  const fixed = await context.tombo.update(reviewed.state, [observation('cold-read', [cold])]);
  assert.equal(fixed.state.claims[0].status, 'contradicted');
  assert.equal(fixed.state.gaps[0].resolution.reason, 'refuted');
  assert.equal(fixed.state.decision, 'needs_reflection');
  const stale = await context.tombo.reflect(fixed.state, { async reflect(input) { return { ...await critic.reflect(input), binding: reviewed.state.reflection.binding }; } });
  assert.equal(stale.state.stopReason, 'invalid_model_output');
  const fresh = await context.tombo.reflect(stale.state, critic);
  assert.equal(fresh.state.decision, 'ready_for_requested_step');
});

test('SDK preserves a real conflict and another claim correction cannot remove its refutation', async () => {
  const context = await supported();
  const refutes = assessment('refutes', { evidenceIds: ['cold'], reason: 'The second report disagrees.' });
  const otherWrong = assessment('supports', { claimId: 'other' });
  const otherReplacement = { ...replacement, claimId: 'other' };
  context.set({ claims: [{ id: 'other', role: 'observation', text: 'A separate interpretation.', scope }], assessments: [refutes, otherWrong] });
  const conflict = await context.tombo.update(context.state, [observation('conflict', [cold])]);
  assert.equal(conflict.state.claims[0].status, 'disputed');
  context.set({ assessments: [otherReplacement], assessmentCorrections: [correction(otherWrong, otherReplacement, { claimId: 'other' })] });
  const fixed = await context.tombo.update(conflict.state, [observation('other-reread')]);
  assert.equal(fixed.state.claims[0].status, 'disputed');
  assert.equal(fixed.state.claims[1].status, 'unverified');
  assert.equal(fixed.state.gaps[0].status, 'open');
});

test('SDK rejects malformed correction references atomically and retains observed tool accounting', async t => {
  const variants = {
    unknownTarget: { targetDigest: '0'.repeat(64) }, unknownReplacement: { replacementDigest: '1'.repeat(64) },
    wrongClaim: { claimId: 'other' }, sameTarget: { replacementDigest: digest(wrong) },
    unknownGrounding: { groundingEvidenceIds: ['missing'] }, unrelatedGrounding: { groundingEvidenceIds: ['cold'] },
    emptyGrounding: { groundingEvidenceIds: [] }, duplicateGrounding: { groundingEvidenceIds: ['warm', 'warm'] },
    invalidDigest: { targetDigest: 'bad' }, blankReason: { reason: '' }, extraField: { verified: true },
  };
  for (const [name, override] of Object.entries(variants)) await t.test(name, async () => {
    const context = await supported();
    const before = structuredClone(context.state);
    context.set({ assessments: [replacement], assessmentCorrections: [correction(wrong, replacement, override)] });
    const failed = await context.tombo.update(context.state, [observation('rejected', [cold])]);
    assert.equal(failed.state.stopReason, 'invalid_model_output');
    assert.deepEqual(failed.state.claims, before.claims);
    assert.deepEqual(failed.state.gaps, before.gaps);
    assert.equal(failed.state.assessmentCorrections, undefined);
    assert.deepEqual(failed.state.evidence, [warm, cold]);
    assert.equal(failed.state.usage.modelCalls, before.usage.modelCalls + 1);
    assert.equal(failed.state.usage.toolCalls, before.usage.toolCalls + 1);
    assert.equal(failed.state.usage.rounds, before.usage.rounds + 1);
    assert.equal(failed.state.usage.costYen, before.usage.costYen + 3);
    assert.deepEqual(context.state, before);
  });
});

test('SDK rejects double correction, cycles and an already corrected replacement while allowing a chain', async () => {
  const context = await supported();
  context.set({ assessments: [replacement], assessmentCorrections: [correction()] });
  const fixed = await context.tombo.update(context.state, [observation('reread')]);
  assert.equal(fixed.state.claims[0].status, 'unverified');
  for (const record of [correction(), correction(replacement, wrong)]) {
    context.set({ assessmentCorrections: [record] });
    const failed = await context.tombo.update(fixed.state, [observation('invalid-chain')]);
    assert.equal(failed.state.stopReason, 'invalid_model_output');
    assert.deepEqual(failed.state.assessmentCorrections, [correction()]);
  }
  const third = assessment('refutes', { reason: 'Both conditions are now covered and one exceeds the limit.' });
  context.set({ assessments: [third], assessmentCorrections: [correction(replacement, third)] });
  const chained = await context.tombo.update(fixed.state, [observation('chain')]);
  assert.equal(chained.state.claims[0].status, 'contradicted');
  assert.equal(chained.state.assessmentCorrections.length, 2);
  assert.equal(sdk.validateState(chained.state).claims[0].assessments.length, 3);
  context.set({ assessmentCorrections: [correction(third, replacement)] });
  const failed = await context.tombo.update(chained.state, [observation('cycle')]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
});

test('SDK rolls back the whole proposal if a later correction or resolution is invalid', async t => {
  for (const suffix of ['correction', 'resolution']) await t.test(suffix, async () => {
    const context = await supported();
    context.set({ assessments: [replacement], assessmentCorrections: [correction(), ...(suffix === 'correction' ? [correction()] : [])], ...(suffix === 'resolution' ? { resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['warm'], explanation: 'This closure has lost its support.' }] } : {}) });
    const failed = await context.tombo.update(context.state, [observation('partial')]);
    assert.equal(failed.state.stopReason, 'invalid_model_output');
    assert.deepEqual(failed.state.claims[0].assessments, [wrong]);
    assert.equal(failed.state.gaps[0].status, 'resolved');
    assert.equal(failed.state.assessmentCorrections, undefined);
  });
});

test('SDK retries rejected proposals without carrying their partial corrections and charges each model attempt', async () => {
  const context = await supported({ maxModelRepairAttempts: 1 });
  const before = context.state.usage;
  context.set(input => ({ assessments: [replacement], assessmentCorrections: input.validationFeedback ? [correction()] : [correction(), correction()] }));
  const fixed = await context.tombo.update(context.state, [observation('retry')]);
  assert.equal(fixed.state.claims[0].status, 'unverified');
  assert.equal(fixed.state.assessmentCorrections.length, 1);
  assert.equal(fixed.state.usage.modelCalls, before.modelCalls + 2);
  assert.equal(fixed.state.usage.toolCalls, before.toolCalls + 1);
  assert.equal(fixed.state.usage.rounds, before.rounds + 1);
  assert.equal(fixed.state.usage.costYen, before.costYen + 4);
  assert.equal(fixed.state.modelRepairDiagnostics.at(-1).operation, 'update');
});

test('SDK duplicate observation delivery is idempotent but a newly emitted duplicate correction is rejected', async () => {
  const context = await supported();
  context.set({ assessments: [replacement], assessmentCorrections: [correction(), correction()] });
  const obs = observation('redeliver');
  const failed = await context.tombo.update(context.state, [obs]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  context.set({ assessments: [replacement], assessmentCorrections: [correction()] });
  const fixed = await context.tombo.update(failed.state, [obs]);
  assert.equal(fixed.state.claims[0].status, 'unverified');
  assert.equal(fixed.state.usage.toolCalls, failed.state.usage.toolCalls);
  assert.equal(fixed.state.usage.modelCalls, failed.state.usage.modelCalls + 1);
  assert.equal(fixed.state.usage.rounds, failed.state.usage.rounds + 1);
  const duplicate = await context.tombo.update(fixed.state, [obs, obs]);
  assert.deepEqual(duplicate.state, fixed.state);
  const rejected = await context.tombo.update(fixed.state, [observation('new-delivery')]);
  assert.equal(rejected.state.stopReason, 'invalid_model_output');
  assert.deepEqual(rejected.state.assessmentCorrections, [correction()]);
});

test('SDK rejects withdrawn grounding at application and never revives a corrected assessment after withdrawal', async () => {
  const context = await supported();
  const withdrawn = context.tombo.invalidate(context.state, { evidenceIds: ['warm'], reason: 'Source withdrawn after initial assessment.' });
  context.set({ assessments: [replacement], assessmentCorrections: [correction()] });
  const rejected = await context.tombo.update(withdrawn.state, [observation('withdrawn-grounding', [cold])]);
  assert.equal(rejected.state.stopReason, 'invalid_model_output');
  const newSupport = assessment('supports', { evidenceIds: ['cold'], reason: 'A replacement source is interpreted as supporting the claim.' });
  context.set({ assessments: [newSupport], assessmentCorrections: [correction(wrong, newSupport)] });
  const fixed = await context.tombo.update(context.state, [observation('replacement-source', [cold])]);
  assert.equal(fixed.state.claims[0].status, 'supported');
  const expired = context.tombo.invalidate(fixed.state, { evidenceIds: ['cold'], reason: 'Replacement source withdrawn.' });
  assert.equal(expired.state.claims[0].status, 'unverified');
  assert.equal(expired.state.evidence.find(item => item.id === 'warm').validity, 'current');
  assert.equal(sdk.validateState(expired.state).assessmentCorrections.length, 1);
});

test('SDK allows correction only in update proposals', async () => {
  const tombo = sdk.createTombo({ now: () => new Date(now), adapter: { async generate() { return { proposal: { ...initialProposal, assessments: [wrong, replacement], assessmentCorrections: [correction()] }, usage }; } } });
  await assert.rejects(tombo.inspect(packet({ evidence: [warm] })), error => error.code === 'invalid_model_output');
  const context = await supported();
  const rejected = await context.tombo.reflect(context.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: ['claim'], completion: 'completed', limitations: [], proposal: { assessmentCorrections: [correction()] }, usage }; } });
  assert.equal(rejected.state.stopReason, 'invalid_model_output');
  assert.equal(rejected.state.assessmentCorrections, undefined);
});

test('SDK canonical assessment digest is exported, validates its input and preserves property-order independence', () => {
  assert.equal(typeof sdk.assessmentDigest, 'function');
  assert.equal(sdk.assessmentDigest(wrong), digest(wrong));
  assert.equal(sdk.assessmentDigest({ reason: wrong.reason, scopeMatched: true, verdict: 'supports', evidenceIds: ['warm'], claimId: 'claim' }), digest(wrong));
  assert.throws(() => sdk.assessmentDigest({ ...wrong, extra: true }), error => error.code === 'invalid_input');
  assert.throws(() => sdk.assessmentDigest({ ...wrong, evidenceIds: [] }), error => error.code === 'invalid_input');
});

test('SDK legacy understanding hashes remain identical when corrections are absent', async () => {
  const context = await supported();
  const state = context.state;
  const metadata = items => items.map(({ passage, passageUnavailable, ...item }) => item);
  const legacyHash = digest({ task: { ...state.task, evidence: metadata(state.task.evidence) }, evidence: metadata(state.evidence), claims: state.claims, lenses: state.lenses, gaps: state.gaps, probes: state.probes, excludedCandidates: state.excludedCandidates });
  assert.equal(sdk.understandingHash(state), legacyHash);
  assert.equal(Object.hasOwn(sdk.validateState(state), 'assessmentCorrections'), false);
});

