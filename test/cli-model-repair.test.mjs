import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTombo, hashPassage, renderMarkdownReport, replayJournal } from '../dist/index.js';

const run = (...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { encoding: 'utf8' });
const claim = { id: 'answer', role: 'answer_claim', text: 'A bounded claim.', scope: 'test' };
const packet = { schemaVersion: '0.1', taskId: 'cli-repair', goal: 'Check a bounded claim.', mode: 'explain', successCriteria: ['Check the supplied claim.'], reflectionRequired: true, evidence: [], capabilities: [], budget: { maxRounds: 3, maxModelCalls: 8, maxToolCalls: 2, maxElapsedMs: 60000, maxInputChars: 100000, maxOutputTokensPerCall: 1000 } };
const usage = { totalTokens: 10, outputTokens: 2, costYen: 0 };
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-cli-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'task.json'), state = join(dir, 'state.json'), module = join(dir, 'model.mjs'), calls = join(dir, 'calls.jsonl');
  await writeFile(input, JSON.stringify(packet));
  const initial = await createTombo({ adapter: { async generate() { return { proposal: { claims: [claim] }, usage }; } } }).inspect(packet);
  await writeFile(state, JSON.stringify(initial.state));
  return { dir, input, state, module, calls, initial };
}
async function adapter(ctx, body) {
  await writeFile(ctx.module, `import { appendFileSync } from 'node:fs'; let n = 0; export default { async generate(input) { n++; appendFileSync(${JSON.stringify(ctx.calls)}, JSON.stringify(input) + '\\n'); ${body} } };`);
  return `file:${ctx.module}`;
}

test('CLI inspect repairs an actual rejected file proposal and journals accepted state', async t => {
  const ctx = await setup(t), ledger = join(ctx.dir, 'events.jsonl');
  const name = await adapter(ctx, `return { proposal: { claims: n === 1 ? [${JSON.stringify(claim)}, ${JSON.stringify(claim)}] : [${JSON.stringify(claim)}] }, usage: ${JSON.stringify(usage)} };`);
  const output = run('inspect', '--input', ctx.input, '--adapter', name, '--model-repair-attempts', '1', '--ledger', ledger);
  assert.equal(output.status, 0, output.stderr);
  const state = JSON.parse(output.stdout);
  assert.equal(state.decision, 'needs_reflection');
  assert.equal(state.usage.modelCalls, 2);
  assert.deepEqual(state.claims.map(c => c.id), ['answer']);
  assert.deepEqual(state.modelRepairDiagnostics, [{ operation: 'inspect', code: 'invalid_model_output', message: 'Existing entity cannot be overwritten answer', rejectedAttempt: 1, maxAttempts: 2 }]);
  const inputs = (await readFile(ctx.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(inputs[0].validationFeedback, undefined);
  assert.deepEqual(inputs[1].validationFeedback, { code: 'invalid_model_output', message: 'Existing entity cannot be overwritten answer', rejectedAttempt: 1, maxAttempts: 2 });
  assert.deepEqual((await replayJournal(ledger)).modelRepairDiagnostics, state.modelRepairDiagnostics);
});

for (const count of ['0', '1', '2']) test(`CLI repeated inspect rejection respects repair limit ${count}`, async t => {
  const ctx = await setup(t);
  const name = await adapter(ctx, `return { proposal: { claims: [${JSON.stringify(claim)}, ${JSON.stringify(claim)}] }, usage: ${JSON.stringify(usage)} };`);
  const output = run('inspect', '--input', ctx.input, '--adapter', name, '--model-repair-attempts', count);
  assert.equal(output.status, 1);
  const inputs = (await readFile(ctx.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(inputs.length, Number(count) + 1);
  if (count === '0') assert.equal(JSON.parse(output.stderr).error.code, 'invalid_model_output');
  else {
    const state = JSON.parse(output.stdout);
    assert.equal(state.stopReason, 'invalid_model_output');
    assert.equal(state.claims.length, 0);
    assert.equal(state.modelRepairDiagnostics.length, Number(count) + 1);
  }
});

test('CLI critic repairs claim coverage and creates a fresh receipt', async t => {
  const ctx = await setup(t);
  await writeFile(ctx.module, `import { appendFileSync } from 'node:fs'; let n = 0; export const critic = { async reflect(input) { n++; appendFileSync(${JSON.stringify(ctx.calls)}, JSON.stringify(input) + '\\n'); return { binding: input.binding, reviewedClaimIds: n === 1 ? [] : ['answer'], completion: 'completed', limitations: [], proposal: {}, usage: ${JSON.stringify(usage)} }; } };`);
  const output = run('reflect', '--state', ctx.state, '--critic', `file:${ctx.module}`, '--model-repair-attempts', '1');
  assert.equal(output.status, 0, output.stderr);
  const state = JSON.parse(output.stdout);
  assert.equal(state.decision, 'ready_for_requested_step');
  assert.equal(state.usage.modelCalls, 3);
  assert.deepEqual(state.reflection.reviewedClaimIds, ['answer']);
  assert.equal(state.modelRepairDiagnostics[0].operation, 'reflect');
  const inputs = (await readFile(ctx.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(inputs[1].binding, inputs[0].binding);
  assert.equal(inputs[1].validationFeedback.code, 'invalid_model_output');
});

for (const value of ['-1', '3', '1.5', '01', 'NaN', '']) test(`CLI rejects invalid repair flag ${JSON.stringify(value)} before module import`, async t => {
  const ctx = await setup(t), marker = join(ctx.dir, 'imported');
  await writeFile(ctx.module, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export default {};`);
  for (const [command, args] of [['inspect', ['--input', ctx.input, '--adapter', `file:${ctx.module}`]], ['reflect', ['--state', ctx.state, '--critic', `file:${ctx.module}`]]]) {
    const output = run(command, ...args, '--model-repair-attempts', value);
    assert.equal(output.status, 1);
    assert.equal(JSON.parse(output.stderr).error.code, 'invalid_input');
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

for (const command of ['report', 'replay', 'invalidate', 'unknown']) test(`CLI rejects repair flag for ${command}`, () => {
  const output = run(command, '--model-repair-attempts', '0');
  assert.equal(output.status, 1);
  assert.equal(JSON.parse(output.stderr).error.code, 'invalid_input');
});

for (const flag of [[], ['--model-repair-attempts', '0'], ['--model-repair-attempts', '1']]) test(`CLI general provider errors preserve only default transport retries ${JSON.stringify(flag)}`, async t => {
  const ctx = await setup(t), name = await adapter(ctx, "throw new Error('provider unavailable');");
  const output = run('inspect', '--input', ctx.input, '--adapter', name, ...flag);
  assert.equal(output.status, 1);
  assert.equal((await readFile(ctx.calls, 'utf8')).trim().split('\n').length, flag.at(-1) === '1' ? 1 : 2);
  const error = output.stdout ? JSON.parse(output.stdout).stopReason : JSON.parse(output.stderr).error.code;
  assert.equal(error, 'model_error');
});

test('report keeps diagnostics separate from evidence and escapes rejected text', async t => {
  const ctx = await setup(t), state = ctx.initial.state;
  const plain = renderMarkdownReport(state);
  assert.doesNotMatch(plain, /提案の検証と訂正/);
  state.modelRepairDiagnostics = [{ operation: 'inspect', code: 'invalid_model_output', message: '<fake>\n# rejected *claim*', rejectedAttempt: 1, maxAttempts: 2 }];
  const report = renderMarkdownReport(state);
  assert.match(report, /## 提案の検証と訂正/);
  assert.match(report, /証拠や未確認事項の解決を表さない/);
  assert.equal(report.includes(String.raw`\<fake\> \# rejected \*claim\*`), true);
  assert.match(report, /試行1\/2を拒否/);
  assert.match(report, /現在の範囲で証拠により確かめた主張はまだない/);
});

test('CLI update repairs a rejected immutable ID against the same recorded observation', async t => {
  const ctx = await setup(t);
  const initialProposal = { claims: [claim], lenses: [{ id: 'lens', label: 'Read', rationale: 'Check evidence.', origin: 'initial', status: 'active' }], gaps: [{ id: 'gap', kind: 'unsupported_claim', lensId: 'lens', question: 'Supported?', triggerRefs: ['answer'], whyItMatters: 'Evidence is required.', importance: 'required', claimIds: ['answer'], probeIds: ['probe'] }], probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Read.', requiredCapability: 'read_file', sourceGroups: ['source'], successCondition: 'Support.', refutationCondition: 'Refute.', inconclusiveCondition: 'Unknown.' }] };
  const api = createTombo({ adapter: { async generate() { return { proposal: initialProposal, usage }; } } });
  const first = await api.inspect({ ...packet, capabilities: ['read_file'] });
  await writeFile(ctx.state, JSON.stringify(first.state));
  const observations = join(ctx.dir, 'observations.json');
  const observation = { executionId: 'read-1', probeId: 'probe', outcome: 'completed', toolCalls: 1, elapsedMs: 2, costYen: 0, evidence: [{ id: 'source', kind: 'document', locator: 'fixture:source', sourceGroup: 'source', retrievedAt: '2026-10-14T00:00:00.000Z', version: '1', scope: 'test', passage: 'Supports.', contentHash: hashPassage('Supports.'), validity: 'current' }] };
  await writeFile(observations, JSON.stringify([observation]));
  const valid = { assessments: [{ claimId: 'answer', evidenceIds: ['source'], verdict: 'supports', scopeMatched: true, reason: 'The source supports it.' }], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['source'], explanation: 'Supported by source.' }] };
  const name = await adapter(ctx, `return { proposal: n === 1 ? { claims: [${JSON.stringify(claim)}] } : ${JSON.stringify(valid)}, usage: ${JSON.stringify(usage)} };`);
  const output = run('update', '--state', ctx.state, '--observations', observations, '--adapter', name, '--model-repair-attempts', '1');
  assert.equal(output.status, 0, output.stderr);
  const state = JSON.parse(output.stdout);
  assert.equal(state.claims[0].status, 'supported');
  assert.equal(state.gaps[0].status, 'resolved');
  assert.equal(state.decision, 'needs_reflection');
  assert.equal(state.usage.rounds, 1);
  assert.equal(state.usage.toolCalls, 1);
  assert.equal(state.usage.modelCalls, 3);
  assert.equal(state.appliedExecutions.length, 1);
  assert.equal(state.modelRepairDiagnostics[0].operation, 'update');
  const inputs = (await readFile(ctx.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(inputs[1].observations, inputs[0].observations);
  assert.equal(inputs[1].validationFeedback.message, 'Existing entity cannot be overwritten answer');
});

test('CLI zero repair accepts valid output without injecting diagnostics', async t => {
  const ctx = await setup(t), name = await adapter(ctx, `return { proposal: { claims: [${JSON.stringify(claim)}] }, usage: ${JSON.stringify(usage)} };`);
  const output = run('inspect', '--input', ctx.input, '--adapter', name, '--model-repair-attempts', '0');
  assert.equal(output.status, 0, output.stderr);
  const state = JSON.parse(output.stdout);
  assert.equal(state.decision, 'needs_reflection');
  assert.equal(state.usage.modelCalls, 1);
  assert.equal(state.modelRepairDiagnostics, undefined);
});

async function inconclusiveReportState({ oldReason = 'Old no-record-yet explanation.', reason = 'The current record does not identify the boundary.', latestVerdict = 'inconclusive', validity = 'current', scope = 'test', scopeMatched = true } = {}) {
  const source = (id, passage) => ({ id, kind: 'document', locator: `fixture:${id}`, sourceGroup: 'source', retrievedAt: '2026-10-14T00:00:00.000Z', version: '1', scope: 'test', passage, contentHash: hashPassage(passage), validity: 'current' });
  const evidence = [source('old-record', 'No record yet.'), { ...source('current-record', 'A record exists, but its boundary is not specified.'), validity, scope }];
  const proposal = { claims: [claim], assessments: [{ claimId: 'answer', evidenceIds: ['old-record'], verdict: 'inconclusive', scopeMatched: true, reason: oldReason }, { claimId: 'answer', evidenceIds: ['current-record'], verdict: latestVerdict, scopeMatched, reason }] };
  return (await createTombo({ adapter: { async generate() { return { proposal, usage }; } } }).inspect({ ...packet, evidence })).state;
}

test('report shows the latest bounded inconclusive reason without turning it into a confirmed claim', async () => {
  const state = await inconclusiveReportState({ reason: '<source> cannot identify *this boundary*\nfrom the current record.' });
  const report = renderMarkdownReport(state);
  assert.match(report, /## 証拠評価の理由（不明）/);
  assert.equal(report.includes(String.raw`\<source\> cannot identify \*this boundary\* from the current record.`), true);
  assert.match(report, /参照証拠: current-record/);
  assert.doesNotMatch(report, /Old no-record-yet explanation/);
  assert.match(report, /現在の範囲で証拠により確かめた主張はまだない/);
  assert.equal(state.claims[0].status, 'unverified');
});

for (const [name, options] of [['withdrawn', { validity: 'withdrawn' }], ['superseded', { validity: 'superseded' }], ['mismatched evidence scope', { scope: 'different-range' }], ['unmatched assessment scope', { scopeMatched: false }]]) test(`report keeps an earlier current inconclusive reason after a later ${name} assessment`, async () => {
  const state = await inconclusiveReportState(options);
  const report = renderMarkdownReport(state);
  assert.match(report, /証拠評価の理由（不明）/);
  const inconclusiveSection = report.split(/^## /m).find(section => section.startsWith('証拠評価の理由（不明）\n'));
  assert.ok(inconclusiveSection);
  assert.match(inconclusiveSection, /Old no-record-yet explanation/);
  assert.match(inconclusiveSection, /参照証拠: old-record/);
  assert.doesNotMatch(inconclusiveSection, /The current record does not identify the boundary/);
  assert.doesNotMatch(inconclusiveSection, /参照証拠: current-record/);
  if (options.scope !== undefined || options.scopeMatched === false) {
    const diagnosticSection = report.split(/^## /m).find(section => section.startsWith('適用できなかった証拠評価\n'));
    assert.ok(diagnosticSection);
    assert.match(diagnosticSection, /The current record does not identify the boundary/);
    assert.match(diagnosticSection, /主張: answer。/);
    assert.match(diagnosticSection, /参照証拠: current-record。/);
    assert.match(diagnosticSection, /主張の範囲: test。/);
    assert.equal(diagnosticSection.includes(`証拠の範囲: ${options.scope ?? 'test'}。`), true);
    assert.match(diagnosticSection, options.scopeMatched === false ? /不一致を宣言（モデルの解釈）/ : /scope文字列の不一致/);
    assert.doesNotMatch(diagnosticSection, /Old no-record-yet explanation/);
  } else {
    assert.doesNotMatch(report, /The current record does not identify the boundary/);
    assert.doesNotMatch(report, /適用できなかった証拠評価/);
  }
});

test('report does not show an earlier inconclusive reason after a later current support assessment', async () => {
  const state = await inconclusiveReportState({ latestVerdict: 'supports' });
  const report = renderMarkdownReport(state);
  assert.doesNotMatch(report, /証拠評価の理由（不明）/);
  assert.doesNotMatch(report, /Old no-record-yet explanation/);
  assert.doesNotMatch(report, /The current record does not identify the boundary/);
});

test('report labels an inconclusive cached assessment as saved and not revalidated', async () => {
  const state = await inconclusiveReportState();
  state.evidence[1].passage = '';
  state.evidence[1].passageUnavailable = true;
  const report = renderMarkdownReport(state);
  assert.match(report, /証拠評価の理由（不明）/);
  assert.match(report, /保存時の評価。本文未取得・未再検証/);
  assert.match(report, /The current record does not identify the boundary/);
  assert.match(report, /参照証拠: current-record/);
  assert.equal(state.claims[0].status, 'unverified');
});

test('report includes a latest inconclusive reason for a disputed answer while preserving the dispute', async () => {
  const state = await inconclusiveReportState();
  const assessments = [{ claimId: 'answer', evidenceIds: ['old-record'], verdict: 'supports', scopeMatched: true, reason: 'One source supports it.' }, { claimId: 'answer', evidenceIds: ['current-record'], verdict: 'refutes', scopeMatched: true, reason: 'The other source refutes it.' }, state.claims[0].assessments.at(-1)];
  state.claims[0].assessments = assessments;
  state.claims[0].status = 'disputed';
  const report = renderMarkdownReport(state);
  assert.match(report, /証拠が対立/);
  assert.match(report, /証拠評価の理由（不明）/);
  assert.match(report, /The current record does not identify the boundary/);
  assert.equal(state.claims[0].status, 'disputed');
});

test('report suppresses a latest inconclusive reason if any referenced evidence is withdrawn', async () => {
  const state = await inconclusiveReportState();
  state.claims[0].assessments.at(-1).evidenceIds = ['old-record', 'current-record'];
  state.evidence[0].validity = 'withdrawn';
  const report = renderMarkdownReport(state);
  assert.doesNotMatch(report, /証拠評価の理由（不明）/);
  assert.doesNotMatch(report, /The current record does not identify the boundary/);
  assert.doesNotMatch(report, /Old no-record-yet explanation/);
});

// F1 deterministic SDK contracts. No external model or transport is used.
const f1Sdk = await import('../dist/index.js');
const f1Usage = { totalTokens: 11, outputTokens: 2, costYen: 2 };
const f1Definition = { claims: [claim], lenses: [{ id: 'lens', label: 'Evidence', rationale: 'Use the source.', origin: 'initial', status: 'active' }], gaps: [{ id: 'gap', lensId: 'lens', kind: 'unsupported_claim', question: 'Is the bounded claim supported?', triggerRefs: ['answer'], whyItMatters: 'The conclusion depends on it.', importance: 'required', claimIds: ['answer'], probeIds: ['probe'] }], probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Read the source.', requiredCapability: 'read', sourceGroups: ['source'], successCondition: 'Supports.', refutationCondition: 'Refutes.', inconclusiveCondition: 'Unknown.' }] };
const f1Evidence = (extra = {}) => ({ id: 'source', kind: 'document', locator: 'fixture:source', sourceGroup: 'source', retrievedAt: new Date().toISOString(), version: '1', scope: 'test', passage: 'PRIVATE_PASSAGE_SENTINEL', contentHash: hashPassage('PRIVATE_PASSAGE_SENTINEL'), validity: 'current', ...extra });
const f1Observation = (extra = {}) => ({ executionId: 'execution', probeId: 'probe', outcome: 'completed', evidence: [f1Evidence()], toolCalls: 1, elapsedMs: 2, costYen: 3, ...extra });
const f1Resolution = (extra = {}) => ({ gapId: 'gap', reason: 'supported', evidenceIds: ['source'], explanation: 'PRIVATE_EXPLANATION_SENTINEL', ...extra });
const f1Assessment = { claimId: 'answer', evidenceIds: ['source'], verdict: 'supports', scopeMatched: true, reason: 'PRIVATE_ASSESSMENT_SENTINEL' };
async function f1Seed({ definition = f1Definition, options = {}, task = {} } = {}) {
  const calls = [];
  let response = () => ({ resolutions: [f1Resolution()] });
  const api = createTombo({ adapter: { async generate(input) { calls.push(input); return { proposal: input.operation === 'inspect' ? definition : await response(input), usage: f1Usage }; } }, captureProposalRejection: true, ...options });
  const first = await api.inspect({ ...packet, capabilities: ['read'], budget: { ...packet.budget, maxRounds: 8, maxToolCalls: 10, maxModelCalls: 16 }, ...task });
  return { api, first, calls, respond(fn) { response = fn; } };
}
function f1Record(state, operation, kind, target, attempts = 1) {
  assert.ok(state.lastProposalRejection, 'F1 actual terminal proposal failure must persist a bounded rejection object');
  assert.deepEqual(state.lastProposalRejection, { operation, taskId: state.taskId, atRevision: state.revision, understandingHash: f1Sdk.understandingHash(state), code: 'invalid_model_output', kind, ...(target ? { target } : {}), rejectedAttempt: attempts, maxAttempts: attempts });
  return state.lastProposalRejection;
}

for (const repairs of [0, 1, 2]) test(`F1 SDK terminal update captures actual returned revision and retained observations with ${repairs} automatic repairs`, async () => {
  const f = await f1Seed({ options: { maxModelRepairAttempts: repairs } });
  const obs = f1Observation();
  const stopped = await f.api.update(f.first.state, [obs]);
  assert.equal(stopped.state.stopReason, 'invalid_model_output');
  assert.equal(f.calls.length, 2 + repairs);
  assert.equal(stopped.state.usage.modelCalls, f.first.state.usage.modelCalls + repairs + 1);
  assert.equal(stopped.state.usage.rounds, 1);
  assert.equal(stopped.state.usage.toolCalls, 1);
  assert.equal(stopped.state.usage.costYen, 2 + 3 + 2 * (repairs + 1));
  assert.deepEqual(stopped.state.pendingAssessmentExecutionIds, ['execution']);
  assert.equal(stopped.state.gaps[0].status, 'open');
  assert.equal(stopped.state.gaps[0].resolution, undefined);
  assert.notEqual(f1Sdk.understandingHash(stopped.state), f1Sdk.understandingHash(f.first.state));
  f1Record(stopped.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' }, repairs + 1);
  assert.equal(stopped.state.modelRepairDiagnostics?.length ?? 0, repairs ? repairs + 1 : 0);
  f1Sdk.validateState(stopped.state);
});

test('F1 SDK same-batch recovery adds only real model/round usage, clears rejection and keeps original failure immutable', async () => {
  const f = await f1Seed(), obs = f1Observation();
  const failed = await f.api.update(f.first.state, [obs]);
  const saved = structuredClone(f1Record(failed.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' }));
  f.respond(() => ({ assessments: [f1Assessment], resolutions: [f1Resolution()] }));
  const fixed = await f.api.update(failed.state, [obs]);
  assert.equal(fixed.state.gaps[0].status, 'resolved');
  assert.equal(fixed.state.pendingAssessmentExecutionIds, undefined);
  assert.equal(fixed.state.lastProposalRejection, undefined);
  assert.equal(fixed.state.usage.modelCalls, failed.state.usage.modelCalls + 1);
  assert.equal(fixed.state.usage.rounds, failed.state.usage.rounds + 1);
  assert.equal(fixed.state.usage.toolCalls, failed.state.usage.toolCalls);
  assert.equal(fixed.state.usage.costYen, failed.state.usage.costYen + f1Usage.costYen);
  assert.deepEqual(failed.state.lastProposalRejection, saved);
});

for (const variant of ['binding', 'missing-claim', 'unknown-claim']) test(`F1 SDK critic ${variant} failure has private provenance and one real call`, async () => {
  const f = await f1Seed();
  let calls = 0;
  const rejected = await f.api.reflect(f.first.state, { async reflect(input) { calls++; return { binding: variant === 'binding' ? { ...input.binding, taskId: 'wrong-task' } : input.binding, reviewedClaimIds: variant === 'missing-claim' ? [] : variant === 'unknown-claim' ? ['PRIVATE_NEW_CLAIM_ID'] : ['answer'], completion: 'completed', limitations: ['PRIVATE_LIMITATION_SENTINEL'], proposal: {}, usage: f1Usage }; } });
  assert.equal(calls, 1);
  assert.equal(rejected.state.stopReason, 'invalid_model_output');
  assert.equal(rejected.state.usage.modelCalls, f.first.state.usage.modelCalls + 1);
  f1Record(rejected.state, 'reflect', variant === 'binding' ? 'reflection_binding_mismatch' : 'reflection_claim_coverage_mismatch', variant === 'missing-claim' ? { kind: 'claim', id: 'answer' } : undefined);
  assert.doesNotMatch(JSON.stringify(rejected.state.lastProposalRejection), /PRIVATE_/);
});

for (const reason of ['supported', 'refuted']) test(`F1 claimless required gap rejects ${reason} without repairing F3`, async () => {
  const f = await f1Seed({ definition: { claims: [claim], lenses: f1Definition.lenses } });
  const introduced = await f.api.reflect(f.first.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: ['answer'], completion: 'completed', limitations: [], proposal: { gaps: [{ ...f1Definition.gaps[0], claimIds: [], triggerRefs: ['task:goal'] }], probes: f1Definition.probes }, usage: f1Usage }; } });
  f.respond(() => ({ resolutions: [f1Resolution({ reason })] }));
  const failed = await f.api.update(introduced.state, [f1Observation()]);
  assert.equal(failed.state.gaps[0].importance, 'required');
  assert.equal(failed.state.gaps[0].claimIds.length, 0);
  assert.equal(failed.state.gaps[0].status, 'open');
  assert.equal(failed.state.gaps[0].resolution, undefined);
  f1Record(failed.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' });
});

for (const variant of ['adapter-lookalike', 'schema-body', 'new-candidate', 'unknown-evidence']) test(`F1 private provenance and generic fallback omit raw strings for ${variant}`, async () => {
  const f = await f1Seed();
  f.respond(() => {
    if (variant === 'adapter-lookalike') throw new f1Sdk.TomboError('invalid_model_output', 'Resolution lacks current matching evidence gap PRIVATE_ADAPTER_SENTINEL');
    if (variant === 'schema-body') return { claims: [{ ...claim, id: 'PRIVATE_NEW_CANDIDATE', role: 'PRIVATE_BAD_ENUM' }] };
    if (variant === 'new-candidate') return { gaps: [{ ...f1Definition.gaps[0], id: 'PRIVATE_NEW_GAP', lensId: 'PRIVATE_MISSING_LENS' }] };
    return { assessments: [{ ...f1Assessment, evidenceIds: ['PRIVATE_EVIDENCE_ID'] }] };
  });
  const failed = await f.api.update(f.first.state, [f1Observation()]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  f1Record(failed.state, 'update', 'proposal_validation_failed');
  assert.doesNotMatch(JSON.stringify(failed.state.lastProposalRejection), /PRIVATE_|Resolution lacks|issues|message|passage|reason/);
  assert.equal(failed.state.lastProposalRejection.target, undefined);
});

for (const gapId of ['gap with whitespace', 'gap\nwith-control']) test(`F1 unsuitable existing target ID is omitted without changing global IDs ${JSON.stringify(gapId)}`, async () => {
  const definition = structuredClone(f1Definition);
  definition.gaps[0].id = gapId;
  definition.probes[0].gapIds = [gapId];
  const f = await f1Seed({ definition });
  assert.equal(f.first.state.gaps[0].id, gapId);
  f.respond(() => ({ resolutions: [f1Resolution({ gapId })] }));
  const failed = await f.api.update(f.first.state, [f1Observation()]);
  f1Record(failed.state, 'update', 'resolution_not_justified');
});

test('F1 newest rejection is one object and semantic hash excludes only rejection metadata while whole-state journals retain it', async t => {
  const ctx = await setup(t), f = await f1Seed(), obs = f1Observation();
  const first = await f.api.update(f.first.state, [obs]);
  const record = structuredClone(f1Record(first.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' }));
  const second = await f.api.update(first.state, [obs]);
  f1Record(second.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' });
  assert.equal(Array.isArray(second.state.lastProposalRejection), false);
  assert.ok(second.state.lastProposalRejection.atRevision > record.atRevision);
  assert.deepEqual(first.state.lastProposalRejection, record);
  const without = structuredClone(second.state); delete without.lastProposalRejection;
  assert.equal(f1Sdk.understandingHash(without), f1Sdk.understandingHash(second.state));
  const { stateDigest } = await import('../skills/tombo-view/scripts/session-store.mjs');
  assert.notEqual(stateDigest(without), stateDigest(second.state));
  const path = join(ctx.dir, 'f1-journal.jsonl'), journal = new f1Sdk.FileJournal(path);
  await journal.commit(-1, f.first.state); await journal.commit(f.first.state.revision, first.state); await journal.commit(first.state.revision, second.state);
  const original = await readFile(path, 'utf8'), replay = await replayJournal(path);
  assert.deepEqual(replay.lastProposalRejection, second.state.lastProposalRejection);
  assert.equal(replay.evidence[0].passageUnavailable, true);
  assert.doesNotMatch(JSON.stringify(replay.lastProposalRejection), /PRIVATE_/);
  const event = JSON.parse(original.trim().split('\n').at(-1));
  assert.equal(event.stateHash, hashPassage(JSON.stringify(event.state)));
  assert.equal(await readFile(path, 'utf8'), original);
});

test('F1 non-proposal revisions retain unchanged inactive history, while same-revision no-op preserves context', async () => {
  const f = await f1Seed(), obs = f1Observation();
  const failed = await f.api.update(f.first.state, [obs]);
  const record = structuredClone(f1Record(failed.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' }));
  const duplicate = await f.api.update(failed.state, [obs], { deferAssessment: true });
  assert.deepEqual(duplicate.state, failed.state);
  const invalidated = f.api.invalidate(failed.state, { evidenceIds: ['source'], reason: 'The source was withdrawn.' });
  assert.ok(invalidated.state.revision > failed.state.revision);
  assert.deepEqual(invalidated.state.lastProposalRejection, record);
  assert.ok(invalidated.state.lastProposalRejection.atRevision < invalidated.state.revision, 'Historical rejection must be inactive by revision, without restamping its binding');
  const checkpoint = f1Sdk.checkpointBudget(failed.state, { now: Date.parse(failed.state.startedAt) + failed.state.task.budget.maxElapsedMs + 1 });
  assert.ok(checkpoint.state.revision > failed.state.revision);
  assert.deepEqual(checkpoint.state.lastProposalRejection, record);
  assert.ok(checkpoint.state.lastProposalRejection.atRevision < checkpoint.state.revision, 'Historical rejection must be inactive by revision, without restamping its binding');
  assert.equal(checkpoint.state.usage.modelCalls, failed.state.usage.modelCalls);
  const conflict = await f.api.update(failed.state, [{ ...obs, toolCalls: 2 }]);
  assert.equal(conflict.state.stopReason, 'invalid_input');
  assert.deepEqual(conflict.state.lastProposalRejection, record);
  assert.ok(conflict.state.lastProposalRejection.atRevision < conflict.state.revision, 'Historical rejection must be inactive by revision, without restamping its binding');
  assert.equal(conflict.state.usage.modelCalls, failed.state.usage.modelCalls);
});

test('F1 state validation accepts actual rejection metadata and rejects wrong task, future revision and unknown target', async () => {
  const f = await f1Seed(), failed = await f.api.update(f.first.state, [f1Observation()]);
  const record = f1Record(failed.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' });
  f1Sdk.validateState(failed.state);
  for (const changed of [{ ...record, taskId: 'wrong-task' }, { ...record, atRevision: failed.state.revision + 1 }, { ...record, target: { kind: 'gap', id: 'unknown' } }, { ...record, target: { kind: 'gap', id: 'gap with space' } }]) assert.throws(() => f1Sdk.validateState({ ...failed.state, lastProposalRejection: changed }), error => error.code === 'invalid_input');
});

for (const value of ['yes', null, 1]) test(`F1 capture option validates boolean ${JSON.stringify(value)}`, () => {
  assert.throws(() => createTombo({ adapter: { async generate() { throw new Error('unused'); } }, captureProposalRejection: value }), error => error.code === 'invalid_input');
});

test('F1 default opt-out, inspect-zero throw, positive repair and legacy replay remain compatible', async t => {
  const f = await f1Seed({ options: { captureProposalRejection: false } });
  const failed = await f.api.update(f.first.state, [f1Observation()]);
  assert.equal(failed.state.lastProposalRejection, undefined);
  assert.equal(failed.state.modelRepairDiagnostics, undefined);
  const throwing = createTombo({ captureProposalRejection: true, adapter: { async generate() { return { proposal: { claims: [claim, claim] }, usage: f1Usage }; } } });
  await assert.rejects(throwing.inspect(packet), error => error.code === 'invalid_model_output');
  const positive = await f1Seed({ options: { maxModelRepairAttempts: 1 } });
  let tries = 0;
  positive.respond(() => ++tries === 1 ? { claims: [claim] } : { assessments: [f1Assessment], resolutions: [f1Resolution()] });
  const repaired = await positive.api.update(positive.first.state, [f1Observation()]);
  assert.equal(tries, 2);
  assert.equal(repaired.state.gaps[0].status, 'resolved');
  assert.equal(repaired.state.modelRepairDiagnostics.length, 1);
  assert.equal(repaired.state.lastProposalRejection, undefined);
  const ctx = await setup(t), path = join(ctx.dir, 'legacy-f1.jsonl'), journal = new f1Sdk.FileJournal(path);
  await journal.commit(-1, f.first.state); await journal.commit(f.first.state.revision, failed.state);
  const bytes = await readFile(path, 'utf8');
  assert.equal((await replayJournal(path)).lastProposalRejection, undefined);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('F1 opt-out creation preserves inherited history on failure and valid inconclusive reflection clears it', async () => {
  const f = await f1Seed(), obs = f1Observation();
  const failed = await f.api.update(f.first.state, [obs]);
  const record = structuredClone(f1Record(failed.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' }));
  const legacy = createTombo({ adapter: { async generate() { return { proposal: { resolutions: [f1Resolution()] }, usage: f1Usage }; } } });
  const retried = await legacy.update(failed.state, [obs]);
  assert.equal(retried.state.stopReason, 'invalid_model_output');
  assert.deepEqual(retried.state.lastProposalRejection, record);
  assert.ok(retried.state.lastProposalRejection.atRevision < retried.state.revision);
  assert.equal(retried.state.usage.modelCalls, failed.state.usage.modelCalls + 1);
  assert.equal(retried.state.usage.toolCalls, failed.state.usage.toolCalls);
  const rejectedReflection = await f.api.reflect(f.first.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: [], completion: 'completed', limitations: [], proposal: {}, usage: f1Usage }; } });
  f1Record(rejectedReflection.state, 'reflect', 'reflection_claim_coverage_mismatch', { kind: 'claim', id: 'answer' });
  const inconclusive = await legacy.reflect(rejectedReflection.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: ['answer'], completion: 'inconclusive', limitations: ['The current review remains inconclusive.'], proposal: {}, usage: f1Usage }; } });
  assert.equal(inconclusive.state.stopReason, 'reflection_inconclusive');
  assert.equal(inconclusive.state.lastProposalRejection, undefined);
  assert.equal(inconclusive.state.usage.modelCalls, rejectedReflection.state.usage.modelCalls + 1);
});

test('F1 internal resolution guards classify known gaps but never expose a rejected new candidate target', async () => {
  for (const variant of ['duplicate', 'unknown-resolution-evidence', 'unsuccessful-probe', 'new-candidate-resolution']) {
    const f = await f1Seed();
    const obs = variant === 'unsuccessful-probe' ? f1Observation({ outcome: 'no_result', evidence: [] }) : f1Observation();
    f.respond(() => variant === 'duplicate' ? { assessments: [f1Assessment], resolutions: [f1Resolution(), f1Resolution()] } : variant === 'unknown-resolution-evidence' ? { resolutions: [f1Resolution({ evidenceIds: ['PRIVATE_UNKNOWN_EVIDENCE'] })] } : variant === 'new-candidate-resolution' ? { gaps: [{ ...f1Definition.gaps[0], id: 'PRIVATE_NEW_GAP', probeIds: ['PRIVATE_NEW_PROBE'] }], probes: [{ ...f1Definition.probes[0], id: 'PRIVATE_NEW_PROBE', gapIds: ['PRIVATE_NEW_GAP'] }], resolutions: [f1Resolution({ gapId: 'PRIVATE_NEW_GAP' })] } : { resolutions: [f1Resolution()] });
    const failed = await f.api.update(f.first.state, [obs]);
    assert.equal(failed.state.stopReason, 'invalid_model_output');
    assert.equal(failed.state.usage.modelCalls, f.first.state.usage.modelCalls + 1);
    f1Record(failed.state, 'update', variant === 'new-candidate-resolution' ? 'proposal_validation_failed' : 'resolution_not_justified', variant === 'new-candidate-resolution' ? undefined : { kind: 'gap', id: 'gap' });
    assert.equal(failed.state.gaps.length, 1);
    assert.equal(failed.state.gaps[0].status, 'open');
    assert.doesNotMatch(JSON.stringify(failed.state.lastProposalRejection), /PRIVATE_/);
  }
});

test('F1 pre-generation budget and input-size stops retain observations without creating proposal rejection metadata', async () => {
  for (const variant of ['model-budget', 'input-size']) {
    const limits = { ...packet.budget, maxRounds: 8, maxToolCalls: 10, maxModelCalls: variant === 'model-budget' ? 1 : 16, maxInputChars: variant === 'input-size' ? 4000 : 100000 };
    const f = await f1Seed({ task: { budget: limits } });
    const passage = 'Actual bounded observation '.repeat(500);
    const obs = variant === 'input-size' ? f1Observation({ evidence: [f1Evidence({ passage, contentHash: hashPassage(passage) })] }) : f1Observation();
    const stopped = await f.api.update(f.first.state, [obs]);
    assert.equal(stopped.state.stopReason, variant === 'model-budget' ? 'budget_exhausted' : 'input_too_large');
    assert.equal(stopped.state.lastProposalRejection, undefined);
    assert.equal(stopped.state.usage.modelCalls, f.first.state.usage.modelCalls);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(stopped.state.pendingAssessmentExecutionIds, ['execution']);
    assert.equal(stopped.state.usage.toolCalls, 1);
  }
});
