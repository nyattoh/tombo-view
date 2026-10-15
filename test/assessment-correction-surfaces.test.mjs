import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTombo, hashPassage, assessmentDigest, FileJournal, replayJournal, renderMarkdownReport } from '../dist/index.js';

const helper = resolve('skills/tombo-view/scripts/session.mjs');
const cli = resolve('dist/cli.js');
const scope = 'latency';
const now = '2026-10-14T00:00:00.000Z';
const evidence = (id, passage) => ({ id, kind: 'document', locator: `local:${id}`, sourceGroup: id, retrievedAt: now, version: '1', scope, passage, contentHash: hashPassage(passage), validity: 'current' });
const warm = evidence('warm', 'Warm p95 is 610 ms. Cold starts were not measured.');
const cold = evidence('cold', 'Cold p95 is 2130 ms.');
const wrong = { claimId: 'answer', evidenceIds: ['warm'], verdict: 'supports', scopeMatched: true, reason: 'Both start conditions are below 800 ms.' };
const replacement = { ...wrong, verdict: 'inconclusive', scopeMatched: false, reason: 'Warm-only measurements do not cover cold starts.' };
const correction = { claimId: 'answer', targetDigest: assessmentDigest(wrong), replacement, groundingEvidenceIds: ['warm'], reason: 'Correct the unmeasured cold condition. <script>\n*not a fact*' };
const initialProposal = {
  claims: [{ id: 'answer', role: 'answer_claim', text: 'Warm and cold p95 are both at most 800 ms.', scope }],
  lenses: [{ id: 'coverage', label: 'Coverage', rationale: 'Read both conditions.', origin: 'initial', status: 'active' }],
  gaps: [{ id: 'gap', kind: 'unsupported_claim', lensId: 'coverage', question: 'Are both conditions covered?', triggerRefs: ['answer'], whyItMatters: 'The answer includes both.', importance: 'required', claimIds: ['answer'], probeIds: ['read'] }],
  probes: [{ id: 'read', gapIds: ['gap'], method: 'boundary', question: 'Read the report.', requiredCapability: 'read_document', sourceGroups: [], successCondition: 'Both at most 800 ms.', refutationCondition: 'Either above 800 ms.', inconclusiveCondition: 'A condition is missing.' }],
};
const observation = (executionId, items = [warm]) => ({ executionId, probeId: 'read', outcome: 'completed', evidence: items, toolCalls: 1, elapsedMs: 1, costYen: null });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-correction-surfaces-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packet = { schemaVersion: '0.1', taskId: 'correction-surfaces', mode: 'explain', goal: 'Check both conditions.', successCriteria: ['Both at most 800 ms.'], proposedAnswer: 'Both below 800 ms.', reflectionRequired: true, evidence: [], capabilities: ['read_document'], budget: { maxRounds: 10, maxModelCalls: 15, maxToolCalls: 10, maxElapsedMs: 120000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 } };
  let proposal = initialProposal;
  const tombo = createTombo({ adapter: { async generate() { return { proposal, usage: { totalTokens: 10, outputTokens: 2, costYen: 0 } }; } } });
  const first = await tombo.inspect(packet);
  proposal = { assessments: [wrong], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['warm'], explanation: 'Incorrect interpretation.' }] };
  const supported = await tombo.update(first.state, [observation('initial-read')]);
  const state = join(dir, 'state.json'), observations = join(dir, 'observations.json'), envelope = join(dir, 'proposal.json'), ledger = join(dir, 'events.jsonl');
  await writeFile(state, JSON.stringify(supported.state));
  await writeFile(observations, JSON.stringify([observation('reread')]));
  const journal = new FileJournal(ledger);
  await journal.commit(-1, first.state);
  await journal.commit(first.state.revision, supported.state);
  const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: process.cwd() } });
  const prepare = (...args) => run(helper, 'prepare', '--state', state, '--observations', observations, '--ledger', ledger, ...args);
  const apply = (...args) => run(helper, 'update', '--state', state, '--observations', observations, '--proposal', envelope, '--ledger', ledger, ...args);
  return { dir, state, observations, envelope, ledger, supported, run, prepare, apply };
}

test('helper publishes assessment references and accepts one inline correction with honest usage and journal replay', async t => {
  const ctx = await setup(t);
  const prepared = ctx.prepare();
  assert.equal(prepared.status, 0, prepared.stderr);
  const context = JSON.parse(prepared.stdout);
  assert.deepEqual(context.request.assessmentReferences, [{ claimId: 'answer', assessmentIndex: 0, digest: assessmentDigest(wrong) }]);
  assert.equal(context.apiCallsMade, 0);
  await writeFile(ctx.envelope, JSON.stringify({ binding: context.binding, proposal: { assessmentCorrections: [correction] }, hostUsage: { totalTokens: 1, costYen: 0 } }));
  const applied = ctx.apply();
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.state.claims[0].status, 'unverified');
  assert.equal(result.state.gaps[0].status, 'open');
  assert.deepEqual(result.state.claims[0].assessments, [wrong, replacement]);
  assert.deepEqual(result.state.evidence, [warm]);
  assert.deepEqual(result.hostUsage, { totalTokens: null, costYen: null });
  assert.equal(result.state.usage.costYen, null);
  assert.equal(result.state.usage.totalTokens, null);
  assert.equal(result.state.usage.toolCalls, 2);
  assert.equal(result.apiCallsMade, 0);
  const replay = await replayJournal(ctx.ledger);
  assert.equal(replay.claims[0].status, 'unverified');
  assert.equal(replay.evidence[0].passageUnavailable, true);
  assert.equal(replay.assessmentCorrections[0].replacementDigest, assessmentDigest(replacement));
  await writeFile(ctx.state, JSON.stringify(result.state));
  const reflect = ctx.run(helper, 'prepare', '--operation', 'reflect', '--state', ctx.state, '--ledger', ctx.ledger);
  assert.equal(reflect.status, 0, reflect.stderr);
  assert.equal(JSON.parse(reflect.stdout).request.assessmentReferences.length, 2);
  const repeated = ctx.apply();
  assert.equal(repeated.status, 1);
  assert.equal(JSON.parse(repeated.stderr).error.code, 'revision_conflict');
  const newContext = JSON.parse(ctx.prepare().stdout);
  await writeFile(ctx.envelope, JSON.stringify({ binding: newContext.binding, proposal: { assessmentCorrections: [correction] } }));
  const redelivery = JSON.parse(ctx.apply().stdout);
  assert.deepEqual(redelivery.state, result.state);
});

test('helper rejects a pre-correction request binding after the assessment table changes', async t => {
  const ctx = await setup(t);
  const context = JSON.parse(ctx.prepare().stdout);
  const oldRequest = structuredClone(context.request);
  delete oldRequest.assessmentReferences;
  const { createHash } = await import('node:crypto');
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  const binding = { ...context.binding, requestHash: createHash('sha256').update(canonical(oldRequest)).digest('hex') };
  await writeFile(ctx.envelope, JSON.stringify({ binding, proposal: { assessmentCorrections: [correction] } }));
  const output = ctx.apply();
  assert.equal(output.status, 1);
  assert.equal(JSON.parse(output.stderr).error.code, 'revision_conflict');
  assert.equal((await replayJournal(ctx.ledger)).claims[0].status, 'supported');
});

test('public CLI adapter performs a correction and refutation in one update then journals it', async t => {
  const ctx = await setup(t), adapter = join(ctx.dir, 'adapter.mjs');
  await writeFile(ctx.observations, JSON.stringify([observation('cold-read', [cold])]));
  const refutes = { ...wrong, evidenceIds: ['cold'], verdict: 'refutes', reason: 'Cold p95 exceeds 800 ms.' };
  await writeFile(adapter, `export default { async generate(input) { return { proposal: { assessmentCorrections: [{ ...${JSON.stringify(correction)}, targetDigest: input.assessmentReferences[0].digest }], assessments: [${JSON.stringify(refutes)}], resolutions: [{ gapId: 'gap', reason: 'refuted', evidenceIds: ['cold'], explanation: 'The cold measurement refutes the combined claim.' }] }, usage: { totalTokens: 5, outputTokens: 3, costYen: 0 } }; } };`);
  const output = ctx.run(cli, 'update', '--state', ctx.state, '--observations', ctx.observations, '--adapter', `file:${adapter}`, '--ledger', ctx.ledger);
  assert.equal(output.status, 0, output.stderr);
  const state = JSON.parse(output.stdout);
  assert.equal(state.claims[0].status, 'contradicted');
  assert.equal(state.gaps[0].resolution.reason, 'refuted');
  assert.equal(state.decision, 'needs_reflection');
  assert.equal(state.claims[0].assessments.length, 3);
  assert.equal((await replayJournal(ctx.ledger)).claims[0].status, 'contradicted');
});

test('report distinguishes corrected interpretations and escaped reasons from verified facts in redacted history', async t => {
  const ctx = await setup(t);
  const context = JSON.parse(ctx.prepare().stdout);
  await writeFile(ctx.envelope, JSON.stringify({ binding: context.binding, proposal: { assessmentCorrections: [correction] } }));
  const result = JSON.parse(ctx.apply().stdout);
  const report = renderMarkdownReport(result.state);
  assert.match(report, /## 証拠の解釈の訂正/);
  assert.match(report, /訂正前: 支持/);
  assert.match(report, /訂正後: 不明/);
  assert.match(report, /モデルの解釈/);
  assert.match(report, /\\<script\\>/);
  assert.doesNotMatch(report, /<script>/);
  assert.match(report, /現在の範囲で証拠により確かめた主張はまだない/);
  const saved = await replayJournal(ctx.ledger);
  const cachedReport = renderMarkdownReport(saved);
  assert.match(cachedReport, /保存時の訂正履歴。本文未取得・未再検証/);
  assert.equal(saved.claims[0].status, 'unverified');
  assert.equal(saved.evidence[0].contentHash, warm.contentHash);
  assert.equal(saved.evidence[0].validity, 'current');
  await writeFile(ctx.state, JSON.stringify(saved));
  const helperReport = ctx.run(helper, 'report', '--state', ctx.state);
  assert.equal(helperReport.status, 0, helperReport.stderr);
  assert.match(helperReport.stdout, /追加API呼出しは0件/);
});

test('uncorrected legacy state keeps the same report when empty optional history is omitted', async t => {
  const ctx = await setup(t);
  const report = renderMarkdownReport(ctx.supported.state);
  assert.doesNotMatch(report, /証拠の解釈の訂正/);
  const fromCli = ctx.run(cli, 'report', '--state', ctx.state);
  assert.equal(fromCli.status, 0, fromCli.stderr);
  assert.equal(fromCli.stdout, report);
  assert.equal(ctx.supported.state.assessmentCorrections, undefined);
});

test('report does not present a corrected historical inconclusive reason as a current unknown', async t => {
  const ctx = await setup(t);
  const caveat = { ...wrong, verdict: 'inconclusive', reason: 'A discarded caveat.' };
  let proposal = { assessments: [caveat] };
  const tombo = createTombo({ adapter: { async generate() { return { proposal, usage: { totalTokens: null, outputTokens: 0, costYen: null } }; } } });
  const added = await tombo.update(ctx.supported.state, [observation('caveat-read')]);
  proposal = { assessmentCorrections: [{ claimId: 'answer', targetDigest: assessmentDigest(caveat), replacement: wrong, groundingEvidenceIds: ['warm'], reason: 'Return to the interpretation supported by this report.' }] };
  const corrected = await tombo.update(added.state, [observation('correct-caveat')]);
  assert.equal(corrected.state.stopReason, null);
  assert.equal(corrected.state.claims[0].status, 'supported');
  const report = renderMarkdownReport(corrected.state);
  assert.doesNotMatch(report, /## 証拠評価の理由（不明）/);
  assert.match(report, /訂正前: 不明/);
  assert.match(report, /訂正後: 支持/);
});

test('report preserves an earlier current inconclusive reason when a later assessment evidence is withdrawn', async () => {
  let proposal = initialProposal;
  const tombo = createTombo({ adapter: { async generate() { return { proposal, usage: { totalTokens: null, outputTokens: 0, costYen: null } }; } } });
  const packet = { schemaVersion: '0.1', taskId: 'report-current-reason', mode: 'explain', goal: 'Check both conditions.', successCriteria: ['Both at most 800 ms.'], proposedAnswer: 'Both below 800 ms.', reflectionRequired: true, evidence: [], capabilities: ['read_document'], budget: { maxRounds: 10, maxModelCalls: 15, maxToolCalls: 10, maxElapsedMs: 120000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 } };
  const first = await tombo.inspect(packet);
  proposal = { assessments: [{ ...wrong, verdict: 'inconclusive', reason: 'Earlier current reason.' }] };
  const assessed = await tombo.update(first.state, [observation('warm-read')]);
  proposal = { assessments: [{ ...wrong, evidenceIds: ['cold'], verdict: 'inconclusive', reason: 'Later withdrawn reason.' }] };
  const later = await tombo.update(assessed.state, [observation('cold-read', [cold])]);
  const withdrawn = tombo.invalidate(later.state, { evidenceIds: ['cold'], reason: 'The later report was withdrawn.' });
  const report = renderMarkdownReport(withdrawn.state);
  assert.match(report, /Earlier current reason\./);
  assert.doesNotMatch(report, /Later withdrawn reason\./);
});
