import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../dist/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const time = '2026-10-20T08:00:00.000Z';
const evidence = (id, scope = 'release-A', validity = 'current') => ({ id, scope, validity, kind: 'document', locator: `local:${id}`, sourceGroup: id, retrievedAt: time, version: '1', passage: id, contentHash: sdk.hashPassage(id) });
const assessment = (evidenceIds, scopeMatched = true, reason = 'Coverage differs.') => ({ claimId: 'claim', evidenceIds, scopeMatched, reason, verdict: 'supports' });
async function context(evidences, assessments) {
  let proposal = { claims: [{ id: 'claim', role: 'answer_claim', text: 'Release A meets the requirement.', scope: 'release-A' }], assessments };
  const tombo = sdk.createTombo({ now: () => new Date(time), adapter: { async generate() { return { proposal, usage: { totalTokens: null, outputTokens: 0, costYen: null } }; } } });
  const result = await tombo.inspect({ schemaVersion: '0.1', taskId: 'scope-diagnostic', goal: 'Check release A.', mode: 'explain', successCriteria: ['Check coverage'], evidence: evidences, capabilities: [], budget: { maxRounds: 8, maxModelCalls: 12, maxToolCalls: 8, maxElapsedMs: 120000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 } });
  return { tombo, state: result.state, set(value) { proposal = value; } };
}

test('baseline: scope mismatch does not support claims or universally block a task', async () => {
  const { state } = await context([evidence('other', 'release-B')], [assessment(['other'])]);
  assert.equal(state.claims[0].status, 'unverified');
  assert.equal(state.evidence[0].validity, 'current');
  assert.equal(state.decision, 'ready_for_requested_step');
});

test('diagnostics distinguish interpretation from literal scope mismatch without changing state or policy', async () => {
  const first = assessment(['same', 'other'], false);
  const { state } = await context([evidence('same'), evidence('other', 'release-B'), evidence('support')], [first, assessment(['support'])]);
  const before = structuredClone(state);
  const hash = sdk.understandingHash(state);
  const policy = sdk.evaluatePolicy(state);
  assert.equal(typeof sdk.assessmentScopeDiagnostics, 'function', 'SDK must export the pure scope diagnostic function');
  const diagnostics = sdk.assessmentScopeDiagnostics(state);
  assert.deepEqual(diagnostics, [
    { claimId: 'claim', assessmentIndex: 0, digest: sdk.assessmentDigest(first), evidenceId: 'same', claimScope: 'release-A', evidenceScope: 'release-A', kind: 'assessment_scope_unmatched', reason: first.reason, passageUnavailable: false },
    { claimId: 'claim', assessmentIndex: 0, digest: sdk.assessmentDigest(first), evidenceId: 'other', claimScope: 'release-A', evidenceScope: 'release-B', kind: 'assessment_scope_unmatched', reason: first.reason, passageUnavailable: false },
    { claimId: 'claim', assessmentIndex: 0, digest: sdk.assessmentDigest(first), evidenceId: 'other', claimScope: 'release-A', evidenceScope: 'release-B', kind: 'evidence_scope_mismatch', reason: first.reason, passageUnavailable: false },
  ]);
  assert.deepEqual(state, before);
  assert.equal(sdk.understandingHash(state), hash);
  assert.deepEqual(sdk.evaluatePolicy(state), policy);
  assert.equal(state.claims[0].status, 'supported');
  diagnostics[0].reason = 'Caller changed its own result.';
  assert.deepEqual(state, before);
});

test('diagnostics exclude corrected history and withdrawn or superseded evidence', async () => {
  const wrong = assessment(['same'], false);
  const ctx = await context([evidence('same'), evidence('old', 'release-B', 'withdrawn'), evidence('superseded', 'release-B', 'superseded')], [wrong, assessment(['old']), assessment(['superseded'])]);
  const reflected = await ctx.tombo.reflect(ctx.state, { async reflect(input) { return { usage: { totalTokens: null, outputTokens: 0, costYen: null }, binding: input.binding, reviewedClaimIds: ['claim'], completion: 'completed', limitations: [], proposal: { lenses: [{ id: 'lens', label: 'Reread', rationale: 'Revisit source coverage.', origin: 'proposed', status: 'active' }], gaps: [{ id: 'gap', lensId: 'lens', kind: 'unsupported_claim', question: 'Does the source cover A?', triggerRefs: ['claim'], whyItMatters: 'Check the answer.', importance: 'optional', claimIds: ['claim'], probeIds: ['probe'] }], probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Reread A.', requiredCapability: 'read', sourceGroups: [], successCondition: 'Covers A.', refutationCondition: 'Contradicts A.', inconclusiveCondition: 'No coverage.' }] } }; } });
  const next = assessment(['same'], true, 'Reread confirms A coverage.');
  ctx.set({ assessmentCorrections: [{ claimId: 'claim', targetDigest: sdk.assessmentDigest(wrong), replacement: next, groundingEvidenceIds: ['same'], reason: 'Original coverage reading was mistaken.' }] });
  const updated = await ctx.tombo.update(reflected.state, [{ executionId: 'reread', probeId: 'probe', outcome: 'completed', evidence: [evidence('same')], toolCalls: 1, elapsedMs: 1, costYen: null }]);
  assert.equal(updated.state.stopReason, null);
  assert.equal(typeof sdk.assessmentScopeDiagnostics, 'function');
  assert.deepEqual(sdk.assessmentScopeDiagnostics(updated.state), []);
  const invalidated = ctx.tombo.invalidate(ctx.state, { evidenceIds: ['same'], reason: 'Source withdrawn.' });
  assert.deepEqual(sdk.assessmentScopeDiagnostics(invalidated.state), []);
});

test('journal replay exposes saved diagnostics without claiming passage revalidation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-scope-'));
  try {
    const { state } = await context([evidence('other', 'release-B')], [assessment(['other'])]);
    const journal = new sdk.FileJournal(join(directory, 'events.jsonl'));
    await journal.commit(-1, state);
    const replayed = await sdk.replayJournal(journal.path);
    assert.equal(typeof sdk.assessmentScopeDiagnostics, 'function');
    assert.equal(sdk.assessmentScopeDiagnostics(replayed)[0].passageUnavailable, true);
    assert.equal(sdk.understandingHash(replayed), sdk.understandingHash(state));
    assert.equal(replayed.evidence[0].passage, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
