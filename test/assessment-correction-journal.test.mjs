import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTombo, assessmentDigest, hashPassage, understandingHash, validateState, FileJournal, replayJournal } from '../dist/index.js';

const timestamp = '2026-10-14T00:00:00.000Z';
const usage = { totalTokens: 0, outputTokens: 0, costYen: 0 };
const source = { id: 'source', kind: 'document', locator: 'local:source', sourceGroup: 'source', retrievedAt: timestamp, version: '1', scope: 'release-A', passage: 'Warm starts only. No cold measurements.', contentHash: hashPassage('Warm starts only. No cold measurements.'), validity: 'current' };
const wrong = { claimId: 'claim', evidenceIds: ['source'], verdict: 'supports', scopeMatched: true, reason: 'Misread as covering both start conditions.' };
const replacement = { ...wrong, verdict: 'inconclusive', scopeMatched: false, reason: 'The same source covers warm starts only.' };
const correction = () => ({ claimId: 'claim', targetDigest: assessmentDigest(wrong), replacementDigest: assessmentDigest(replacement), groundingEvidenceIds: ['source'], reason: 'The initial interpretation was too broad.' });
const correctionProposal = () => { const { replacementDigest, ...record } = correction(); return { ...record, replacement }; };
const observation = (executionId, evidence = []) => ({ executionId, probeId: 'probe', outcome: 'completed', evidence, toolCalls: 1, elapsedMs: 0, costYen: 0 });
const critic = { async reflect(input) { return { binding: input.binding, reviewedClaimIds: ['claim'], completion: 'completed', limitations: [], proposal: {}, usage }; } };
async function fixture() {
  let proposal = {};
  let calls = 0;
  const tombo = createTombo({ now: () => new Date(timestamp), adapter: { async generate(input) { calls++; return { usage, proposal: input.operation === 'inspect' ? {
    claims: [{ id: 'claim', role: 'answer_claim', text: 'Both conditions meet the threshold.', scope: 'release-A' }],
    lenses: [{ id: 'lens', label: 'Coverage', rationale: 'Both conditions matter.', origin: 'initial', status: 'active' }],
    gaps: [{ id: 'gap', kind: 'unsupported_claim', lensId: 'lens', question: 'Does the source cover both?', triggerRefs: ['claim'], whyItMatters: 'Both are claimed.', importance: 'required', claimIds: ['claim'], probeIds: ['probe'] }],
    probes: [{ id: 'probe', gapIds: ['gap'], method: 'boundary', question: 'Read the report.', requiredCapability: 'read_file', sourceGroups: [], successCondition: 'Both measured.', refutationCondition: 'A counterexample.', inconclusiveCondition: 'Missing coverage.' }],
    assessments: [wrong, replacement], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['source'], explanation: 'The uncorrected support still resolves this gap.' }],
  } : proposal }; } } });
  const first = await tombo.inspect({ schemaVersion: '0.1', taskId: 'journal-correction', goal: 'Check the stated threshold.', mode: 'explain', successCriteria: ['Both start conditions.'], reflectionRequired: true, proposedAnswer: 'Both pass.', evidence: [source], capabilities: ['read_file'], budget: { maxRounds: 20, maxModelCalls: 30, maxToolCalls: 20, maxElapsedMs: 120000, maxInputChars: 20000, maxOutputTokensPerCall: 3000 } });
  assert.equal(first.state.claims[0].status, 'supported');
  return { tombo, first, set(value) { proposal = value; }, calls: () => calls };
}
async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-correction-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('SDK correction-only changes invalidate reflection even when replacement already exists in history', async () => {
  const context = await fixture();
  const reviewed = await context.tombo.reflect(context.first.state, critic);
  context.set({ assessmentCorrections: [correctionProposal()] });
  const fixed = await context.tombo.update(reviewed.state, [observation('reread', [source])]);
  assert.equal(fixed.state.claims[0].status, 'unverified');
  assert.deepEqual(fixed.state.claims[0].assessments, reviewed.state.claims[0].assessments);
  assert.notEqual(understandingHash(fixed.state), understandingHash(reviewed.state));
  assert.equal(fixed.state.reflection.binding.understandingHash, understandingHash(reviewed.state));
  assert.equal(fixed.state.decision, 'needs_check');
});

test('journal preserves corrections through redaction, replay and rehydration with an unchanged prior event', () => temporary(async directory => {
  const context = await fixture();
  const journal = new FileJournal(join(directory, 'events.jsonl'), join(directory, 'cache.json'));
  await journal.commit(-1, context.first.state);
  const originalLine = await readFile(journal.path, 'utf8');
  context.set({ assessmentCorrections: [correctionProposal()] });
  const fixed = await context.tombo.update(context.first.state, [observation('reread', [source])]);
  assert.equal(fixed.state.claims[0].status, 'unverified');
  await journal.commit(context.first.state.revision, fixed.state);
  const saved = await journal.load();
  assert.equal(saved.evidence[0].passage, '');
  assert.equal(saved.evidence[0].passageUnavailable, true);
  assert.deepEqual(saved.assessmentCorrections, [correction()]);
  assert.equal(validateState(saved).claims[0].status, 'unverified');
  assert.equal(understandingHash(saved), understandingHash(fixed.state));
  assert.deepEqual(await replayJournal(journal.path), saved);
  await journal.assertCurrent(fixed.state);
  const oldPath = join(directory, 'prior-event.jsonl');
  await writeFile(oldPath, originalLine);
  const prior = await replayJournal(oldPath);
  assert.equal(prior.claims[0].status, 'supported');
  assert.equal(Object.hasOwn(prior, 'assessmentCorrections'), false);
  context.set({});
  const hydrated = await context.tombo.update(saved, [observation('hydrate', [source])]);
  assert.equal(hydrated.state.claims[0].status, 'unverified');
  assert.equal(hydrated.state.evidence[0].passage, source.passage);
  assert.deepEqual(hydrated.state.assessmentCorrections, [correction()]);
  assert.equal(understandingHash(hydrated.state), understandingHash(saved));
  await journal.commit(saved.revision, hydrated.state);
  assert.equal((await journal.load()).claims[0].status, 'unverified');
}));

test('saved redacted correction history is valid but new correction application requires available passages', () => temporary(async directory => {
  const context = await fixture();
  const journal = new FileJournal(join(directory, 'events.jsonl'));
  await journal.commit(-1, context.first.state);
  const redacted = await journal.load();
  context.set({ assessmentCorrections: [correctionProposal()] });
  const callsBefore = context.calls();
  const blocked = await context.tombo.update(redacted, [observation('missing-passage')]);
  assert.equal(blocked.state.stopReason, 'passage_unavailable');
  assert.equal(context.calls(), callsBefore);
  assert.equal(blocked.state.assessmentCorrections, undefined);
  const recovered = await context.tombo.update(redacted, [observation('reacquire', [source])]);
  assert.equal(recovered.state.claims[0].status, 'unverified');
  assert.deepEqual(recovered.state.assessmentCorrections, [correction()]);
}));

test('state validation rejects forged correction histories including redacted false resolutions', async t => {
  const context = await fixture();
  context.set({ assessmentCorrections: [correctionProposal()] });
  const fixed = await context.tombo.update(context.first.state, [observation('reread', [source])]);
  assert.equal(fixed.state.claims[0].status, 'unverified');
  const variants = [
    state => state.assessmentCorrections.push(correction()),
    state => { state.assessmentCorrections[0].targetDigest = '0'.repeat(64); },
    state => state.assessmentCorrections.push({ ...correction(), targetDigest: assessmentDigest(replacement), replacementDigest: assessmentDigest(wrong) }),
    state => { state.assessmentCorrections[0].claimId = 'missing'; },
    state => { state.assessmentCorrections[0].groundingEvidenceIds = ['missing']; },
    state => { state.claims[0].status = 'supported'; state.gaps[0] = structuredClone(context.first.state.gaps[0]); for (const item of [...state.evidence, ...state.task.evidence]) { item.passage = ''; item.passageUnavailable = true; } },
  ];
  for (const [index, forge] of variants.entries()) await t.test(String(index), () => {
    const state = structuredClone(fixed.state);
    forge(state);
    assert.throws(() => validateState(state), error => error.code === 'invalid_input');
  });
});

test('journal accepts later source withdrawal without resurrecting the corrected target', () => temporary(async directory => {
  const context = await fixture();
  const journal = new FileJournal(join(directory, 'events.jsonl'));
  context.set({ assessmentCorrections: [correctionProposal()] });
  const fixed = await context.tombo.update(context.first.state, [observation('reread', [source])]);
  await journal.commit(-1, fixed.state);
  const withdrawn = context.tombo.invalidate(fixed.state, { evidenceIds: ['source'], reason: 'The source was later withdrawn.' });
  assert.equal(withdrawn.state.claims[0].status, 'unverified');
  await journal.commit(fixed.state.revision, withdrawn.state);
  const replayed = await replayJournal(journal.path);
  assert.equal(replayed.evidence[0].validity, 'withdrawn');
  assert.deepEqual(replayed.assessmentCorrections, [correction()]);
  assert.equal(replayed.claims[0].status, 'unverified');
}));

test('SDK invalidation of a redacted corrected journal remains valid when another claim has unavailable current evidence', () => temporary(async directory => {
  const context = await fixture();
  context.set({ assessmentCorrections: [correctionProposal()] });
  const fixed = await context.tombo.update(context.first.state, [observation('reread', [source])]);
  const other = { ...source, id: 'other-source', sourceGroup: 'other-source', passage: 'A separate claim is supported.', contentHash: hashPassage('A separate claim is supported.') };
  const state = structuredClone(fixed.state);
  state.evidence.push(other);
  state.claims.push({ id: 'other', role: 'observation', text: 'A separate claim.', scope: source.scope, status: 'supported', assessments: [{ ...wrong, claimId: 'other', evidenceIds: [other.id] }] });
  assert.equal(validateState(state).claims[1].status, 'supported');
  const journal = new FileJournal(join(directory, 'events.jsonl'));
  await journal.commit(-1, state);
  const redacted = await journal.load();
  const invalidated = context.tombo.invalidate(redacted, { evidenceIds: ['source'], reason: 'The corrected source was withdrawn.' });
  assert.equal(invalidated.state.claims[0].status, 'unverified');
  assert.equal(invalidated.state.claims[1].status, 'unverified');
  assert.equal(invalidated.state.evidence[1].validity, 'current');
  await journal.commit(redacted.revision, invalidated.state);
  assert.equal((await journal.load()).claims[1].status, 'unverified');
}));
