import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { assessmentDigest, createTombo, hashPassage, validateState } from '../dist/index.js';

const source = await readFile(new URL('../scripts/metacognition-host-trial.mjs', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('function renderUnderstanding('), source.indexOf("let status = 'success'"));
const render = new Function('assessmentDigest', 'bridgeFailure', `${renderer}; return renderUnderstanding;`)(assessmentDigest, null);
const usage = { totalTokens: null, outputTokens: 0, costYen: null };
const evidence = (id, overrides = {}) => ({ id, kind: 'document', locator: id, sourceGroup: id, retrievedAt: '2026-10-14T00:00:00.000Z', version: null, scope: 'trial', passage: id, contentHash: hashPassage(id), validity: 'current', ...overrides });
const assessment = (id, reason, overrides = {}) => ({ claimId: 'c1', evidenceIds: [id], verdict: 'refutes', scopeMatched: true, reason, ...overrides });
const claim = { id: 'c1', role: 'answer_claim', text: 'Replay is safe.', scope: 'trial' };
async function stateFor(assessments, items, extra = {}) {
  const tombo = createTombo({ adapter: { async generate() { return { proposal: { claims: [claim], assessments, ...extra }, usage }; } } });
  const result = await tombo.inspect({ schemaVersion: '0.1', taskId: 'renderer', mode: 'explain', goal: 'Check replay.', successCriteria: ['Use current evidence.'], evidence: items, capabilities: ['read_record'], budget: { maxRounds: 5, maxModelCalls: 10, maxToolCalls: 5, maxElapsedMs: 300000, maxInputChars: 48000, maxOutputTokensPerCall: 4000 } });
  assert.equal(result.state.stopReason, null);
  validateState(result.state);
  return { tombo, result };
}
async function trial(respond, caseId = 'work-01', fourth = false) {
  const out = await mkdtemp(join(tmpdir(), 'tombo-answer-current-'));
  const child = spawn(process.execPath, ['scripts/metacognition-host-trial.mjs', '--case', caseId, ...(fourth ? ['--cases', 'evaluation/metacognition-fourth-cases.json', '--protocol', 'evaluation/metacognition-fourth-protocol.json'] : []), '--arm', 'tombo', '--origin', 'fixture', '--out', out]);
  let stderr = '', done;
  child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('REQUEST ')) {
        const frame = JSON.parse(line.slice(8));
        const request = JSON.parse(await readFile(frame.path, 'utf8'));
        const bridge = JSON.parse(await readFile(frame.bridgePath, 'utf8'));
        child.stdin.write(JSON.stringify({ sequence: frame.sequence, output: JSON.stringify(await respond(request)), taskId: `fixture-${frame.sequence}`, model: bridge.model }) + '\n');
      } else if (line.startsWith('DONE ')) done = JSON.parse(line.slice(5));
    }
    assert.equal(await exited, 0, stderr);
    assert.ok(done, stderr);
    return { run: JSON.parse(await readFile(done.runPath, 'utf8')), result: JSON.parse(await readFile(done.resultPath, 'utf8')), trace: JSON.parse(await readFile(done.tracePath, 'utf8')) };
  } finally { child.kill(); await rm(out, { recursive: true, force: true }); }
}
const lens = { id: 'l1', label: 'Replay', rationale: 'Check evidence.', origin: 'initial', status: 'active' };
const gap = number => ({ id: `g${number}`, kind: 'unsupported_claim', lensId: 'l1', question: `Check replay ${number}.`, triggerRefs: ['c1'], whyItMatters: 'Replay safety.', importance: 'required', claimIds: ['c1'], probeIds: [`p${number}`] });
const probe = number => ({ id: `p${number}`, gapIds: [`g${number}`], method: 'counterexample', question: 'Read replay.', requiredCapability: 'read_record', sourceGroups: ['replay-report'], successCondition: 'One row.', refutationCondition: 'Two rows.', inconclusiveCondition: 'No evidence.' });
const reflection = request => ({ binding: request.input.binding, reviewedClaimIds: request.input.state.claims.map(c => c.id), completion: 'completed', limitations: [], proposal: {} });

test('real driver removes a corrected old refutation and retains current reason and source', async () => {
  const { run, result } = await trial(request => {
    if (request.stage === 'inspect') return { claims: [claim], lenses: [lens], gaps: [gap(1), gap(2)], probes: [probe(1), probe(2)] };
    if (request.stage === 'reflect') return reflection(request);
    const observation = request.input.observations[0];
    const evidenceIds = observation.evidence.map(e => e.id);
    if (observation.probeId === 'p1') return { assessments: [{ ...assessment(evidenceIds[0], 'No fulfilment rows were created because every delivery failed.'), evidenceIds }], resolutions: [{ gapId: 'g1', reason: 'refuted', evidenceIds, explanation: 'Initial interpretation.' }] };
    const old = request.input.state.claims[0].assessments[0];
    const replacement = { ...old, verdict: 'inconclusive', scopeMatched: false, reason: 'The initial interpretation was incorrect.' };
    return { assessments: [replacement, assessment(evidenceIds[0], 'Two deliveries of event_id e17 created two fulfilment rows f1 and f2.')], assessmentCorrections: [{ claimId: 'c1', targetDigest: assessmentDigest(old), replacement, groundingEvidenceIds: old.evidenceIds, reason: 'Correct the reading.' }], resolutions: [1, 2].map(n => ({ gapId: `g${n}`, reason: 'refuted', evidenceIds, explanation: 'Two rows are present.' })) };
  });
  assert.equal(run.status, 'success', JSON.stringify({ output: run.output, reason: result.reason, state: result.result?.state }));
  assert.equal(run.observed.calls, 6);
  assert.equal(run.observed.modelCalls, 4);
  assert.equal(run.observed.cost, 'UNKNOWN');
  assert.equal(result.result.state.assessmentCorrections.length, 1);
  assert.equal(result.result.state.claims[0].assessments.length, 3);
  assert.deepEqual(JSON.parse(run.output), { decision: 'refuted', answer: 'Rejected claim: Replay is safe. Two deliveries of event_id e17 created two fulfilment rows f1 and f2.', uncertainties: [], sourceRefs: ['replay-report'] });
});

test('SDK invalidation drops withdrawn reasons and citations without changing history', async () => {
  const { tombo, result } = await stateFor([assessment('old', 'No rows were created.'), assessment('current', 'Two rows were created.')], [evidence('old'), evidence('current')]);
  const invalidated = tombo.invalidate(result.state, { evidenceIds: ['old'], reason: 'Withdraw obsolete evidence.' });
  const before = structuredClone(invalidated.state);
  assert.deepEqual(render(invalidated), { decision: 'refuted', answer: 'Rejected claim: Replay is safe. Two rows were created.', uncertainties: [], sourceRefs: ['current'] });
  assert.deepEqual(invalidated.state, before);
  assert.equal(invalidated.state.claims[0].assessments.length, 2);
});

test('SDK scope and validity eligibility excludes other scope and superseded evidence', async () => {
  const { result } = await stateFor([assessment('wrong-scope', 'Wrong scope.'), assessment('superseded', 'Old version.'), assessment('unmatched', 'Unmatched.', { scopeMatched: false }), assessment('current', 'Two current rows.')], [evidence('wrong-scope', { scope: 'other' }), evidence('superseded', { validity: 'superseded' }), evidence('unmatched'), evidence('current', { sourceGroup: 'canonical-current' })]);
  assert.deepEqual(render(result), { decision: 'refuted', answer: 'Rejected claim: Replay is safe. Two current rows.', uncertainties: [], sourceRefs: ['canonical-current'] });
});

test('unavailable passage is not a current reason or citation even in a redacted supported state', async () => {
  const { result } = await stateFor([assessment('private', 'Hidden refutation.'), assessment('current', 'Available refutation.')], [evidence('private'), evidence('current')]);
  const redacted = structuredClone(result);
  Object.assign(redacted.state.evidence[0], { passage: '', passageUnavailable: true });
  Object.assign(redacted.state.task.evidence[0], { passage: '', passageUnavailable: true });
  validateState(redacted.state);
  assert.deepEqual(render(redacted), { decision: 'refuted', answer: 'Rejected claim: Replay is safe. Available refutation.', uncertainties: [], sourceRefs: ['current'] });
});

test('current inconclusive reason remains unknown and a scope-mismatched later reason stays absent', async () => {
  const { result } = await stateFor([assessment('current', 'Cold starts were not measured.', { verdict: 'inconclusive' }), assessment('other', 'Unmatched obsolete uncertainty.', { verdict: 'inconclusive', scopeMatched: false })], [evidence('current'), evidence('other')]);
  assert.deepEqual(render(result), { decision: 'unknown', answer: 'Cold starts were not measured.', uncertainties: ['Unverified: Replay is safe.'], sourceRefs: ['current'] });
});




for (const control of [
  { id: 'b8s4', answer: 'Motion M9, version m9-r1, was approved.', reason: 'Six yes votes meet the requirement of at least five.' },
  { id: 'k4r8', answer: 'Schedule S6, version s6-r1, contains each unordered team pair exactly once.', reason: 'The complete 15 rows contain the 15 distinct unordered pairs of six teams.' },
  { id: 'p6n1', answer: 'All 12 local numeric transitions in A12, version a12-r1, satisfy its declared recurrence.', reason: 'The 12 stored checks are 17, 67, 78, 222, 133, 181, 124, 90, 125, 162, 9, and 109, matching each local recurrence.' },
]) test(`real fourth control ${control.id} preserves its supporting reason and canonical context reference`, async () => {
  const { run, result } = await trial(request => request.stage === 'inspect' ? { claims: [{ ...claim, text: control.answer }], assessments: [assessment('e-context', control.reason, { verdict: 'supports' })] } : reflection(request), control.id, true);
  assert.equal(run.status, 'success');
  assert.equal(run.observed.calls, 2);
  assert.equal(result.result.state.claims[0].status, 'supported');
  assert.deepEqual(JSON.parse(run.output), { decision: 'supported', answer: `${control.answer} ${control.reason}`, uncertainties: [], sourceRefs: ['context'] });
});

test('all unavailable evidence keeps a redacted supported claim unverified in the answer', async () => {
  const { result } = await stateFor([assessment('private', 'Hidden support.', { verdict: 'supports' })], [evidence('private')]);
  for (const item of [...result.state.evidence, ...result.state.task.evidence]) Object.assign(item, { passage: '', passageUnavailable: true });
  validateState(result.state);
  assert.deepEqual(render(result), { decision: 'unknown', answer: 'No grounded final answer.', uncertainties: ['Unverified: Replay is safe.'], sourceRefs: [] });
});

test('a required gap and inconclusive reflection keep the current supported answer unknown', async () => {
  const { tombo, result } = await stateFor([assessment('current', 'One current row.', { verdict: 'supports' })], [evidence('current')], { lenses: [lens], gaps: [gap(1)], probes: [probe(1)] });
  const reviewed = await tombo.reflect(result.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: ['c1'], completion: 'inconclusive', limitations: ['Coverage is incomplete.'], proposal: {}, usage }; } });
  assert.equal(reviewed.state.reflection.completion, 'inconclusive');
  assert.equal(reviewed.state.gaps[0].status, 'open');
  assert.deepEqual(render(reviewed), { decision: 'unknown', answer: 'Replay is safe. One current row.', uncertainties: ['Check replay 1.', 'Coverage is incomplete.', 'reflection_inconclusive'], sourceRefs: ['current'] });
});

test('deferred assessment remains pending with its required gap and no invented current source', async () => {
  const { tombo, result } = await stateFor([], [], { lenses: [lens], gaps: [gap(1)], probes: [probe(1)] });
  const pending = await tombo.update(result.state, [{ executionId: 'deferred-1', probeId: 'p1', outcome: 'completed', evidence: [evidence('unassessed')], toolCalls: 1, elapsedMs: 1, costYen: null }], { deferAssessment: true });
  assert.equal(pending.state.stopReason, 'assessment_pending');
  assert.deepEqual(render(pending), { decision: 'unknown', answer: 'No grounded final answer.', uncertainties: ['Check replay 1.', 'Unverified: Replay is safe.', 'Evidence assessments are pending.', 'assessment_pending'], sourceRefs: [] });
});

test('a current correction replacement can support an answer without reviving its old refutation', async () => {
  let proposal = { claims: [claim], lenses: [lens], gaps: [gap(1)], probes: [probe(1)], assessments: [assessment('current', 'Incorrect original refutation.')] };
  const tombo = createTombo({ adapter: { async generate() { return { proposal, usage }; } } });
  const initial = await tombo.inspect({ schemaVersion: '0.1', taskId: 'replacement', mode: 'explain', goal: 'Check replay.', successCriteria: ['Check evidence.'], evidence: [evidence('current')], capabilities: ['read_record'], budget: { maxRounds: 5, maxModelCalls: 10, maxToolCalls: 5, maxElapsedMs: 300000, maxInputChars: 48000, maxOutputTokensPerCall: 4000 } });
  const old = initial.state.claims[0].assessments[0];
  const replacement = assessment('current', 'Corrected support uses one row.', { verdict: 'supports' });
  proposal = { assessmentCorrections: [{ claimId: 'c1', targetDigest: assessmentDigest(old), replacement, groundingEvidenceIds: ['current'], reason: 'Correct the interpretation.' }] };
  const corrected = await tombo.update(initial.state, [{ executionId: 'correction-read', probeId: 'p1', outcome: 'completed', evidence: [evidence('current')], toolCalls: 1, elapsedMs: 1, costYen: null }]);
  assert.equal(corrected.state.claims[0].status, 'supported');
  assert.deepEqual(render(corrected), { decision: 'unknown', answer: 'Replay is safe. Corrected support uses one row.', uncertainties: ['Check replay 1.'], sourceRefs: ['current'] });
  assert.equal(corrected.state.claims[0].assessments.length, 2);
});

test('real driver fails explicitly when complete current reasons exceed the final character cap', async () => {
  const { run, result } = await trial(request => {
    if (request.stage === 'inspect') return { claims: [1, 2].map(n => ({ ...claim, id: `c${n}`, text: `Claim ${n}. ` + 'C'.repeat(1100) })), lenses: [lens], gaps: [{ ...gap(1), claimIds: ['c1', 'c2'] }], probes: [probe(1)] };
    if (request.stage === 'reflect') return reflection(request);
    const evidenceIds = request.input.observations[0].evidence.map(e => e.id);
    return { assessments: [1, 2].map(n => ({ ...assessment(evidenceIds[0], `Reason ${n}. ` + 'R'.repeat(1100), { verdict: 'supports' }), claimId: `c${n}` })), resolutions: [{ gapId: 'g1', reason: 'supported', evidenceIds, explanation: 'Both checked.' }] };
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.state.decision, 'ready_for_requested_step');
  assert.equal(result.result.state.claims.length, 2);
  assert.equal(run.status, 'error');
  assert.equal(run.observed.calls, 4);
  assert.deepEqual(JSON.parse(run.output), { decision: 'unknown', answer: 'The trial did not complete.', uncertainties: ['final_character_cap'], sourceRefs: ['replay-report'] });
  assert.equal(result.result.state.claims[0].assessments[0].reason, 'Reason 1. ' + 'R'.repeat(1100));
});

