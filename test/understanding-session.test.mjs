import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as sdk from '../dist/index.js';

const helper = resolve('skills/tombo-view/scripts/session.mjs');
const cli = resolve('dist/cli.js');
const scope = 'project-runtime';
const budget = { maxRounds: 12, maxModelCalls: 20, maxToolCalls: 20, maxElapsedMs: 120000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 };
const packet = (overrides = {}) => ({ schemaVersion: '0.1', taskId: 'understanding-runtime', goal: 'Check the project runtime and explain the supported requirement.', mode: 'explain', successCriteria: ['Use the actual runtime requirement.'], proposedAnswer: 'Node.js 24 is the minimum.', reflectionRequired: true, evidence: [], capabilities: ['read_file', 'receive_user_answer'], budget, ...overrides });
const evidence = (id, passage, overrides = {}) => ({ id, kind: 'code', locator: `local:${id}`, sourceGroup: 'project-config', retrievedAt: '2026-10-20T08:00:00.000Z', version: '1', scope, passage, contentHash: sdk.hashPassage(passage), validity: 'current', ...overrides });
const claim = (id = 'runtime', text = 'Node.js 24 is the minimum.') => ({ id, text, role: 'answer_claim', scope });
const lens = { id: 'runtime-lens', label: 'Runtime requirement', rationale: 'Check the configured requirement.', origin: 'initial', status: 'active' };
const gap = (id = 'runtime-gap', claimId = 'runtime', probeId = 'runtime-probe', extra = {}) => ({ id, lensId: lens.id, kind: 'unsupported_claim', question: 'What runtime does the project require?', triggerRefs: [claimId], whyItMatters: 'The installation advice depends on it.', importance: 'required', claimIds: [claimId], probeIds: [probeId], ...extra });
const probe = (id = 'runtime-probe', gapId = 'runtime-gap', extra = {}) => ({ id, gapIds: [gapId], method: 'corroboration', question: 'Read the project configuration.', requiredCapability: 'read_file', sourceGroups: ['project-config'], successCondition: 'The configured minimum is 24.', refutationCondition: 'The configured minimum differs.', inconclusiveCondition: 'The configuration is unavailable.', ...extra });
const initial = { claims: [claim()], lenses: [lens], gaps: [gap()], probes: [probe()] };
const assessment = (id, verdict = 'supports', overrides = {}) => ({ claimId: 'runtime', evidenceIds: [id], verdict, scopeMatched: true, reason: 'The configuration states the minimum.', ...overrides });
const resolution = (id, reason = 'supported', gapId = 'runtime-gap') => ({ gapId, reason, evidenceIds: [id], explanation: 'The observation determines this condition.' });
const observation = (executionId, items, overrides = {}) => ({ executionId, probeId: 'runtime-probe', outcome: 'completed', evidence: items, toolCalls: 1, elapsedMs: 1, costYen: null, ...overrides });

async function session(t, task = packet()) {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-understanding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let sequence = 0;
  let current;
  const ledger = join(directory, 'events.jsonl');
  async function save(value) { const path = join(directory, `input-${sequence++}.json`); await writeFile(path, JSON.stringify(value)); return path; }
  const input = await save(task);
  function raw(script, args) { return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } }); }
  function call(args, expected = 0) { const result = raw(helper, args); assert.equal(result.status, expected, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`); return result; }
  async function prepare(operation, observations, ledgerCheck = true) {
    const args = operation === 'inspect' ? ['--input', input] : ['--state', current];
    if (operation === 'reflect') args.push('--operation', 'reflect');
    if (operation === 'update') args.push('--observations', await save(observations));
    if (ledgerCheck) args.push('--ledger', ledger);
    const prepared = JSON.parse(call(['prepare', ...args]).stdout);
    return { prepared, args: args.filter((value, index) => value !== '--operation' && args[index - 1] !== '--operation') };
  }
  async function apply(operation, proposal, observations, options = {}) {
    const { prepared, args } = await prepare(operation, observations, options.ledger !== false);
    const envelope = operation === 'reflect' ? { binding: prepared.binding, reflection: { binding: prepared.request.binding, reviewedClaimIds: prepared.request.state.claims.map(item => item.id), completion: 'completed', limitations: ['A completed review does not guarantee completeness.'], proposal } } : { binding: prepared.binding, proposal };
    const path = await save(envelope);
    const out = join(directory, `state-${sequence++}.json`);
    call([operation, ...args, '--proposal', path, '--out', out], options.exit ?? 0);
    current = out;
    return JSON.parse(await readFile(out, 'utf8'));
  }
  return { directory, ledger, input, save, raw, call, prepare, apply, get current() { return current; }, async use(state) { current = await save(state); } };
}

test('helper exposes derived diagnostics on prepare/results and recomputes report from state', async t => {
  const s = await session(t);
  const prepared = await s.prepare('inspect');
  assert.deepEqual(prepared.prepared.assessmentScopeDiagnostics, [], 'prepare must include additive scope diagnostics');
  const first = await s.apply('inspect', initial);
  assert.deepEqual(first.assessmentScopeDiagnostics, []);
  const ev = evidence('other-project', 'Node 24', { scope: 'another-project' });
  const next = await s.apply('update', { assessments: [assessment(ev.id)] }, [observation('read-other', [ev])]);
  assert.equal(next.state.claims[0].status, 'unverified');
  assert.equal(next.state.gaps[0].status, 'open');
  assert.equal(next.state.decision, 'needs_check');
  assert.equal(next.assessmentScopeDiagnostics[0].kind, 'evidence_scope_mismatch');
  const reflectInput = await s.prepare('reflect');
  assert.deepEqual(reflectInput.prepared.assessmentScopeDiagnostics, next.assessmentScopeDiagnostics);
  await s.use({ ...next, assessmentScopeDiagnostics: [{ reason: 'FORGED DIAGNOSTIC' }] });
  const report = s.call(['report', '--state', s.current]).stdout;
  assert.match(report, /適用できなかった証拠評価/);
  assert.doesNotMatch(report, /FORGED DIAGNOSTIC/);
});

test('real helper cycle checks evidence, reframes after a counterexample, resumes and revisits ready understanding', async t => {
  const s = await session(t);
  const first = await s.apply('inspect', initial);
  assert.equal(first.state.decision, 'needs_check');
  const ev22 = evidence('config-22', '{"engines":{"node":">=22"}}');
  const checked = await s.apply('update', { claims: [claim('corrected', 'Node.js 22 is the minimum.')], assessments: [assessment(ev22.id, 'refutes'), assessment(ev22.id, 'supports', { claimId: 'corrected' })], resolutions: [resolution(ev22.id, 'refuted')] }, [observation('read-config-22', [ev22])]);
  assert.equal(checked.state.claims[0].status, 'contradicted');
  assert.equal(checked.state.claims[1].status, 'supported');
  assert.equal(checked.state.decision, 'needs_reflection');
  const ready = await s.apply('reflect', {});
  assert.equal(ready.state.decision, 'ready_for_requested_step');
  assert.deepEqual(ready.userQuestions, []);
  const report = s.call(['report', '--state', s.current]).stdout;
  assert.match(report, /反証/);
  assert.match(report, /再考を完了/);
  const stale = await s.prepare('reflect');
  const wrong = assessment('config-24', 'supports', { reason: 'Initially read the current minimum as 24.' });
  const ev24 = evidence('config-24', 'The CI image is 24, while engines still requires 22.');
  const followup = await s.apply('update', { assessments: [wrong] }, [observation('follow-up', [ev24])]);
  assert.equal(followup.state.claims[0].status, 'disputed');
  assert.equal(followup.state.gaps[0].status, 'open');
  assert.notEqual(sdk.understandingHash(followup.state), ready.state.reflection.binding.understandingHash);
  const staleEnvelope = await s.save({ binding: stale.prepared.binding, reflection: { binding: stale.prepared.request.binding, reviewedClaimIds: ['runtime', 'corrected'], completion: 'completed', limitations: [], proposal: {} } });
  const rejected = s.call(['reflect', '--state', s.current, '--proposal', staleEnvelope, '--ledger', s.ledger], 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'revision_conflict');
  const corrected = await s.apply('update', { assessmentCorrections: [{ claimId: 'runtime', targetDigest: sdk.assessmentDigest(wrong), replacement: { ...wrong, verdict: 'inconclusive', scopeMatched: false, reason: 'A CI version does not determine the minimum.' }, groundingEvidenceIds: [ev24.id], reason: 'Reread the source and distinguish CI from engines.' }], resolutions: [resolution(ev22.id, 'refuted')] }, [observation('reread-config', [ev24])]);
  assert.equal(corrected.state.claims[0].status, 'contradicted');
  assert.equal(corrected.state.evidence.every(item => item.validity === 'current'), true);
  assert.equal(corrected.state.decision, 'needs_reflection');
  const final = await s.apply('reflect', {});
  assert.equal(final.state.decision, 'ready_for_requested_step');
  const replay = s.raw(cli, ['replay', '--ledger', s.ledger]);
  assert.equal(replay.status, 0, replay.stderr);
  const restored = JSON.parse(replay.stdout);
  assert.equal(restored.startedAt, first.state.startedAt);
  assert.deepEqual(restored.usage, final.state.usage);
  assert.equal(sdk.understandingHash(restored), sdk.understandingHash(final.state));
  assert.equal(restored.evidence.every(item => item.passageUnavailable && item.passage === ''), true);
  await s.use(restored);
  assert.match(s.call(['report', '--state', s.current]).stdout, /保存時の診断。本文未取得・未再検証/);
  const blocked = await s.apply('reflect', {}, undefined, { exit: 1 });
  assert.equal(blocked.state.stopReason, 'passage_unavailable');
  const rehydrated = await s.apply('update', {}, [observation('reacquire-sources', [ev22, ev24])]);
  assert.equal(rehydrated.state.evidence.some(item => item.passageUnavailable), false);
  const resumed = await s.apply('reflect', {});
  assert.equal(resumed.state.decision, 'ready_for_requested_step');
  assert.equal(resumed.state.startedAt, first.state.startedAt);
  assert.ok(resumed.state.usage.modelCalls > final.state.usage.modelCalls);
});

test('human-only ask accepts an actual user statement through the initially linked probe', async t => {
  const s = await session(t, packet({ proposedAnswer: 'Choose the smallest change.', proposedActions: ['Make the smallest change', 'Undertake the larger redesign'] }));
  const proposal = { claims: [claim('choice', 'The user chooses the smallest change.')], lenses: [lens], gaps: [gap('choice-gap', 'choice', 'answer-probe', { kind: 'ambiguous_intent', humanRole: 'priority', triggerRefs: ['task:goal'], question: 'Which scope do you prefer?' })], probes: [probe('answer-probe', 'choice-gap', { requiredCapability: 'receive_user_answer', question: 'Receive the user choice.' })] };
  const asked = await s.apply('inspect', proposal);
  assert.equal(asked.state.decision, 'needs_user_input');
  assert.equal(asked.userQuestions.length, 1);
  const answer = evidence('user-choice', 'Please make the smallest change.', { kind: 'user_statement', sourceGroup: 'user-priority', locator: 'conversation:answer' });
  const updated = await s.apply('update', { assessments: [assessment(answer.id, 'supports', { claimId: 'choice', reason: 'The user explicitly selected that scope.' })], resolutions: [resolution(answer.id, 'supported', 'choice-gap')] }, [observation('received-answer', [answer], { probeId: 'answer-probe', toolCalls: 0 })]);
  assert.equal(updated.state.gaps[0].status, 'resolved');
  const ready = await s.apply('reflect', {});
  assert.equal(ready.state.decision, 'ready_for_requested_step');
  assert.deepEqual(ready.userQuestions, []);
  assert.equal(ready.state.evidence[0].kind, 'user_statement');
});

test('reflect adds a new gap/probe pair for follow-up instead of overwriting existing entities', async t => {
  const s = await session(t);
  await s.apply('inspect', initial);
  const ev = evidence('config', 'Minimum is 24.');
  await s.apply('update', { assessments: [assessment(ev.id)], resolutions: [resolution(ev.id)] }, [observation('read-first', [ev])]);
  const next = await s.apply('reflect', { gaps: [gap('followup-gap', 'runtime', 'followup-probe', { kind: 'missing_fact', question: 'Does the follow-up file agree?' })], probes: [probe('followup-probe', 'followup-gap')] });
  assert.equal(next.state.decision, 'needs_check');
  const more = evidence('followup', 'The independent runtime declaration also requires 24.');
  const update = await s.apply('update', { assessments: [assessment(more.id)], resolutions: [resolution(more.id, 'supported', 'followup-gap')] }, [observation('followup-check', [more], { probeId: 'followup-probe' })]);
  assert.equal(update.state.gaps.every(item => item.status === 'resolved'), true);
  assert.equal((await s.apply('reflect', {})).state.decision, 'ready_for_requested_step');
});

test('ledger authority and identical redelivery retain usage and reject payload collisions', async t => {
  const s = await session(t);
  const first = await s.apply('inspect', initial);
  const stalePath = s.current;
  const ev = evidence('config', 'Minimum is 24.');
  const obs = [observation('read-once', [ev])];
  const updated = await s.apply('update', { assessments: [assessment(ev.id)], resolutions: [resolution(ev.id)] }, obs);
  const replayed = await s.apply('update', {}, obs);
  assert.deepEqual(replayed.state, updated.state);
  const stale = s.call(['prepare', '--state', stalePath, '--operation', 'reflect', '--ledger', s.ledger], 1);
  assert.equal(JSON.parse(stale.stderr).error.code, 'revision_conflict');
  assert.equal(first.state.revision + 1, updated.state.revision);
  const collision = await s.apply('update', {}, [{ ...obs[0], elapsedMs: 2 }], { exit: 1 });
  assert.equal(collision.state.stopReason, 'invalid_input');
  assert.equal(collision.state.usage.toolCalls, updated.state.usage.toolCalls);
  assert.equal(collision.state.usage.modelCalls, updated.state.usage.modelCalls);
});

test('budget time elapsed across a real process resume and unavailable checks cannot become ready', async t => {
  const s = await session(t);
  await s.apply('inspect', initial);
  const failed = await s.apply('update', {}, [observation('unavailable', [], { outcome: 'unavailable' })]);
  assert.equal(failed.state.decision, 'blocked');
  assert.equal(failed.state.stopReason, 'capability_limit');
  assert.equal(failed.state.gaps[0].status, 'blocked');
  const task = packet({ taskId: 'elapsed-session', budget: { ...budget, maxElapsedMs: 50 } });
  const past = Date.now() - 5000;
  const old = await sdk.createTombo({ now: () => past, adapter: { async generate() { return { proposal: initial, usage: { totalTokens: null, outputTokens: 0, costYen: null } }; } } }).inspect(task);
  const journal = new sdk.FileJournal(join(s.directory, 'elapsed.jsonl'));
  await journal.commit(-1, old.state);
  const context = await s.save(old.state);
  const prepared = JSON.parse(s.call(['prepare', '--state', context, '--operation', 'reflect', '--ledger', journal.path]).stdout);
  const plan = await s.save({ binding: prepared.binding, reflection: { binding: prepared.request.binding, reviewedClaimIds: ['runtime'], completion: 'completed', limitations: [], proposal: {} } });
  const expired = JSON.parse(s.call(['reflect', '--state', context, '--proposal', plan, '--ledger', journal.path]).stdout);
  assert.equal(expired.state.decision, 'blocked');
  assert.equal(expired.state.stopReason, 'budget_exhausted');
  assert.equal(expired.state.startedAt, old.state.startedAt);
  assert.ok(expired.state.usage.elapsedMs >= task.budget.maxElapsedMs);
  assert.equal(expired.state.usage.modelCalls, old.state.usage.modelCalls);
});
