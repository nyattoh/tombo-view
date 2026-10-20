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
