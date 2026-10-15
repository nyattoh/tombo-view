import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { outputDigest } from '../evaluation/metacognition-runner.mjs';

const root = new URL('../', import.meta.url);
const digest = value => outputDigest(JSON.stringify(value));
const recordCase = { id: 'contract-case', task: 'Check the recorded statement.', context: 'The statement requires a record.', draft: 'The statement is established.', capabilities: ['read_record', 'local_check'], sources: [
  { id: 'record-a', capability: 'read_record', description: 'First record.', status: 'ok', text: 'The statement is false.' },
  { id: 'record-b', capability: 'read_record', description: 'Second record.', status: 'ok', text: 'The statement is false.' },
  { id: 'machine', capability: 'local_check', description: 'A separate capability.', status: 'ok', text: 'Machine result.' }
] };

async function trial(respond, { cases = [recordCase], repairs = 2, maxCalls = 6, elapsedCap = 300000, repeat = 1 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-record-contract-'));
  const protocol = { version: 1, frozenBeforeResults: true, caseDigest: digest(cases), maximumElapsedMs: elapsedCap, requested: { maxCalls, maxOutputChars: 4000 } };
  const casesPath = join(directory, 'cases.json'), protocolPath = join(directory, 'protocol.json');
  await writeFile(casesPath, JSON.stringify(cases));
  await writeFile(protocolPath, JSON.stringify(protocol));
  const child = spawn(process.execPath, ['scripts/metacognition-host-trial.mjs', '--case', cases[0].id, '--arm', 'tombo', '--origin', 'fixture', '--repeat', String(repeat), '--model-repair-attempts', String(repairs), '--cases', casesPath, '--protocol', protocolPath, '--out', join(directory, 'trial')], { cwd: root });
  const requests = [];
  let stderr = '', done;
  child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('REQUEST ')) {
        const frame = JSON.parse(line.slice(8));
        const request = JSON.parse(await readFile(frame.path, 'utf8'));
        requests.push(request);
        const response = await respond(request);
        if (response !== undefined) child.stdin.write(JSON.stringify({ sequence: frame.sequence, output: typeof response === 'string' ? response : JSON.stringify(response), taskId: `fixture-contract-${frame.sequence}`, model: request.model ?? { provider: 'codex', name: 'gpt-6.1-sol', effort: 'medium' } }) + '\n');
      } else if (line.startsWith('DONE ')) done = JSON.parse(line.slice(5));
    }
    assert.equal(await exited, 0, stderr);
    assert.ok(done, stderr);
    return { requests, run: JSON.parse(await readFile(done.runPath, 'utf8')), trace: JSON.parse(await readFile(done.tracePath, 'utf8')), result: JSON.parse(await readFile(done.resultPath, 'utf8')) };
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
}

function candidate(sourceGroups = ['record-a'], suffix = '') {
  return {
    lenses: [{ id: `l${suffix}`, label: 'Record', rationale: 'Check the record.', origin: suffix ? 'proposed' : 'initial', status: suffix ? 'candidate' : 'active' }],
    gaps: [{ id: `g${suffix}`, kind: 'unsupported_claim', lensId: `l${suffix}`, question: 'Does the record establish the statement?', triggerRefs: ['c'], whyItMatters: 'The answer depends on the record.', importance: 'required', claimIds: ['c'], probeIds: [`p${suffix}`] }],
    probes: [{ id: `p${suffix}`, gapIds: [`g${suffix}`], method: 'counterexample', question: 'Read the record.', requiredCapability: 'read_record', sourceGroups, successCondition: 'Statement true.', refutationCondition: 'Statement false.', inconclusiveCondition: 'Record unavailable.' }]
  };
}
const inspect = sourceGroups => ({ claims: [{ id: 'c', role: 'answer_claim', text: 'The statement is established.', scope: 'trial' }], ...candidate(sourceGroups) });
function assess(request) {
  const evidenceIds = request.input.observations[0].evidence.map(e => e.id);
  return { assessments: [{ claimId: 'c', evidenceIds, verdict: 'refutes', scopeMatched: true, reason: 'The record states the statement is false.' }], resolutions: [{ gapId: 'g', evidenceIds, reason: 'refuted', explanation: 'The record refutes the statement.' }] };
}
const reflected = request => ({ binding: request.input.binding, reviewedClaimIds: ['c'], completion: 'completed', limitations: [], proposal: {} });
const legal = request => request.stage === 'inspect' ? inspect() : request.stage === 'update' ? assess(request) : reflected(request);

for (const stage of ['inspect', 'update', 'reflect']) {
  test(`${stage} rejects an undeclared record candidate before applying it and repairs within charged calls`, async () => {
    const result = await trial(request => {
      if (request.stage !== stage || request.input.validationFeedback) return legal(request);
      if (stage === 'inspect') return inspect(['context']);
      const proposal = candidate(['context'], '-rejected');
      return stage === 'reflect' ? { ...reflected(request), proposal } : { ...assess(request), ...proposal };
    });
    assert.equal(result.run.status, 'success');
    assert.equal(result.result.status, 'completed');
    assert.equal(result.run.observed.calls, 5);
    assert.equal(result.run.observed.modelCalls, 4);
    assert.deepEqual(result.run.checks.map(c => c.sourceId), ['record-a']);
    const repair = result.requests.find(r => r.stage === stage && r.input.validationFeedback);
    assert.equal(repair.input.validationFeedback.code, 'invalid_model_output');
    assert.equal(repair.input.validationFeedback.rejectedAttempt, 1);
    assert.equal(repair.input.validationFeedback.maxAttempts, 3);
    assert.equal(repair.input.state?.probes.some(p => p.id === 'p-rejected') ?? false, false);
    const rejection = result.trace.events.find(e => e.kind === 'model_rejection');
    assert.equal(rejection.stage, stage);
    assert.equal(rejection.reason, 'invalid_record_probe');
    assert.ok(rejection.message.length <= 512);
    assert.equal(result.result.result.state.modelRepairDiagnostics[0].operation, stage);
    assert.equal(result.result.result.state.usage.modelCalls, 4);
    assert.equal(result.result.result.state.usage.toolCalls, 1);
    assert.equal(result.result.result.state.usage.rounds, 1);
    assert.equal(result.trace.events.filter(e => e.kind === 'raw_reply').length, 4);
    assert.deepEqual(result.trace.events.filter(e => e.kind === 'reply').map(e => e.taskId), ['fixture-contract-1', 'fixture-contract-2', 'fixture-contract-3', 'fixture-contract-4']);
    assert.equal(JSON.parse(result.run.output).decision, 'refuted');
  });
}

for (const [label, groups] of [['undeclared ID', ['not-declared']], ['capability mismatch', ['machine']], ['multiple sources', ['record-a', 'record-b']], ['no source', []]]) {
  test(`record contract repairs ${label} and executes only a declared matching source`, async () => {
    const result = await trial(request => request.stage === 'inspect' ? inspect(request.input.validationFeedback ? ['record-b'] : groups) : legal(request));
    assert.equal(result.run.status, 'success');
    assert.deepEqual(result.run.checks.map(c => [c.sourceId, c.capability]), [['record-b', 'read_record']]);
    assert.equal(result.run.observed.calls, 5);
    assert.equal(result.requests[1].input.validationFeedback.code, 'invalid_model_output');
  });
}

test('persistent invalid destinations stop at the unchanged repair limit and preserve unknown', async () => {
  const result = await trial(() => inspect(['context']));
  assert.equal(result.result.result.state.stopReason, 'invalid_model_output');
  assert.equal(result.result.result.state.usage.modelCalls, 3);
  assert.equal(result.run.observed.calls, 3);
  assert.equal(result.run.observed.modelCalls, 3);
  assert.equal(result.run.checks.length, 0);
  assert.equal(result.trace.events.filter(e => e.kind === 'model_rejection').length, 3);
  assert.equal(result.requests[2].input.validationFeedback.rejectedAttempt, 2);
  assert.equal(result.run.status, 'error');
  assert.equal(JSON.parse(result.run.output).decision, 'unknown');
});

test('repair cannot raise the shared call cap or dispatch a seventh generation', async () => {
  const result = await trial(request => {
    if (request.stage === 'inspect') return inspect();
    if (request.stage === 'update') return request.input.validationFeedback ? assess(request) : { ...assess(request), ...candidate(['context'], '-invalid') };
    return { ...reflected(request), proposal: candidate(['context'], '-invalid') };
  });
  assert.equal(result.run.observed.calls, 6);
  assert.equal(result.run.observed.modelCalls, 5);
  assert.deepEqual(result.run.checks.map(c => c.sourceId), ['record-a']);
  assert.equal(result.run.status, 'error');
  assert.equal(result.trace.events.filter(e => e.kind === 'request').length, 5);
  assert.equal(JSON.parse(result.run.output).decision, 'unknown');
});

test('a pending repair remains subject to the same elapsed deadline', async () => {
  const result = await trial(request => request.sequence === 1 ? inspect(['context']) : undefined, { elapsedCap: 600 });
  assert.equal(result.run.requested.maximumElapsedMs, 600);
  assert.equal(result.run.observed.modelCalls, 2);
  assert.equal(result.run.observed.calls, 2);
  assert.equal(result.run.checks.length, 0);
  assert.equal(result.run.status, 'error');
  assert.equal(result.result.result.state.stopReason, 'model_timeout');
  assert.equal(JSON.parse(result.run.output).decision, 'unknown');
});

test('malformed probes stay under SDK schema validation rather than record rejection', async () => {
  const result = await trial(request => {
    if (request.stage !== 'inspect') return legal(request);
    if (request.input.validationFeedback) return inspect();
    const output = inspect(['context']);
    output.probes[0].sourceGroups = 7;
    return output;
  });
  assert.equal(result.run.status, 'success');
  assert.deepEqual(result.run.checks.map(c => c.sourceId), ['record-a']);
  assert.equal(result.trace.events.filter(e => e.kind === 'model_rejection').length, 0);
  assert.equal(result.result.result.state.modelRepairDiagnostics[0].code, 'invalid_model_output');
});
const savedP6n1Outputs = [{"claims":[{"id":"c-draft","role":"answer_claim","text":"A12、version a12-r1 の全12行の局所的な数値遷移は、宣言された漸化式を満たす。","scope":"trial"},{"id":"c-row11","role":"observation","text":"第11行の期待チェック値は (162*31+7)%251=0 であり、保存値9と一致しない。","scope":"trial"},{"id":"c-answer","role":"answer_claim","text":"草案は誤りである。","scope":"trial"},{"id":"c-other-rows","role":"observation","text":"第1〜10行と第12行の局所的な数値遷移は、宣言された漸化式を満たす。","scope":"trial"}],"lenses":[{"id":"l-local","label":"直前の保存チェック値による局所検証","rationale":"各行を直前行の保存値から計算し、誤った保存値を修正して後続行へ伝播させない。","origin":"initial","status":"active"}],"gaps":[{"id":"g-draft","kind":"unsupported_claim","lensId":"l-local","question":"全12行の保存チェック値は、それぞれ直前の保存チェック値から計算した期待値と一致するか。","triggerRefs":["c-draft","e-context"],"whyItMatters":"全行についての主張は、1行でも不一致があれば成立しない。","importance":"required","claimIds":["c-draft"],"probeIds":[]}],"assessments":[{"claimId":"c-draft","evidenceIds":["e-context"],"verdict":"refutes","scopeMatched":true,"reason":"第11行では (162*31+7)%251=5029%251=0 となるが、保存チェック値は9である。"},{"claimId":"c-row11","evidenceIds":["e-context"],"verdict":"supports","scopeMatched":true,"reason":"第10行の保存値162と第11行の値7・保存値9から、不一致を直接確認できる。"},{"claimId":"c-answer","evidenceIds":["e-context"],"verdict":"supports","scopeMatched":true,"reason":"decision: incorrect。answer: 全12行が漸化式を満たすという草案は、第11行の不一致によって否定される。uncertainties: 最終かつ完全と指定されたこの12行の局所整合性について、結論を妨げる未確認事項はない。sourceRefs: e-context。"},{"claimId":"c-other-rows","evidenceIds":["e-context"],"verdict":"supports","scopeMatched":true,"reason":"直前の保存値を使った第1〜12行の期待値は順に17,67,78,222,133,181,124,90,125,162,0,109。第11行だけが不一致である。第12行は保存値9を使い、(9*31+81)%251=109となる。"}],"resolutions":[{"reason":"refuted","evidenceIds":["e-context"],"explanation":"完全な対象一覧と計算規則が提供されており、第11行の期待値0と保存値9の不一致が全称主張への反例となる。追加の資料取得は不要。","gapId":"g-draft"}]},{"binding":{"taskId":"trial-p6n1-2","basedRevision":1,"understandingHash":"049a4c79774b4147bf0a86a099e076ac4bb9591220aa8605e16656d8fbc21ca8"},"reviewedClaimIds":["c-draft","c-row11","c-answer","c-other-rows"],"completion":"completed","limitations":["decision: 現在の誤り判定は再確認が必要。answer: 第11行を反例とする計算に疑義があり、下記の候補チェックで検証する。uncertainties: このレビューは候補の提案に限られ、既存の評価や解決状態は更新していない。sourceRefs: e-context。評価訂正の履歴は提示されていない。"],"proposal":{"lenses":[{"id":"l-remainder-verification","label":"商と余りによる算術検算","rationale":"全称主張を否定する唯一の反例について、剰余計算を独立に検算することが結論を左右する。","origin":"proposed","status":"candidate"}],"gaps":[{"id":"g-row11-remainder","kind":"conflicting_evidence","lensId":"l-remainder-verification","question":"第11行に関する assessmentIndex=0 の c-draft、c-row11、c-answer の評価は、5029を251で割った余りを正しく扱っているか。","triggerRefs":["e-context","c-draft","c-row11","c-answer"],"whyItMatters":"第11行の剰余を0とする計算が誤っていれば、草案を否定する根拠と既存の解決が成立しない。c-other-rows の assessmentIndex=0 に含まれる全行の期待値列も同時に検算する必要がある。","importance":"required","claimIds":["c-draft","c-row11","c-answer","c-other-rows"],"probeIds":["p-reconstruct-remainders"]}],"probes":[{"id":"p-reconstruct-remainders","gapIds":["g-row11-remainder"],"method":"reconstruction","question":"e-context の全12行について、直前の保存チェック値を使い、各計算の被除数を251×整数商＋余りの形で検算すると、保存値との不一致は存在するか。特に第11行の余りは0か9か。","requiredCapability":"read_record","sourceGroups":["context"],"successCondition":"全12行の余りが保存値と一致し、第11行を反例とする既存評価の再検討が必要と確認できる。","refutationCondition":"宣言された規則と保存値を使った正しい計算で、少なくとも1行の不一致を確認できる。","inconclusiveCondition":"対象の行または計算規則が不足し、全12行の検算を完了できない。"}]}}];
const savedP6n1Case = {"id":"p6n1","task":"Assess the draft statement about the numeric transitions in integer audit record A12, version a12-r1. Decide whether the statement is correct, incorrect, or cannot be determined from the available information, and justify your conclusion. An integer audit record is available if you need it.","context":"This is a fictional exercise record. Integer audit record A12, version a12-r1. Scope: the 12 numbered rows in this captured fixture. The listing is final and complete. Genesis check_0=0. For each row i, check_i=(previousStoredCheck*31+value_i)%251, where previousStoredCheck is the check saved in row i-1, or the genesis check for row 1. Values and checks are integers at least zero. Evaluate every local transition against the previous saved check. This rule measures local arithmetic consistency.\nseq=1 value=17 check=17\nseq=2 value=42 check=67\nseq=3 value=9 check=78\nseq=4 value=63 check=222\nseq=5 value=28 check=133\nseq=6 value=74 check=181\nseq=7 value=35 check=124\nseq=8 value=11 check=90\nseq=9 value=96 check=125\nseq=10 value=52 check=162\nseq=11 value=7 check=9\nseq=12 value=81 check=109","draft":"All 12 local numeric transitions in A12, version a12-r1, satisfy its declared recurrence.","capabilities":["read_record"],"sources":[{"id":"p6n1-src","capability":"read_record","description":"Integer audit record A12, version a12-r1, for its twelve numbered rows.","status":"ok","text":"Integer audit record A12, version a12-r1. Scope: the 12 numbered rows in this captured fixture. The listing is final and complete. Genesis check_0=0. For each row i, check_i=(previousStoredCheck*31+value_i)%251, where previousStoredCheck is the check saved in row i-1, or the genesis check for row 1. Values and checks are integers at least zero. Evaluate every local transition against the previous saved check. This rule measures local arithmetic consistency.\nseq=1 value=17 check=17\nseq=2 value=42 check=67\nseq=3 value=9 check=78\nseq=4 value=63 check=222\nseq=5 value=28 check=133\nseq=6 value=74 check=181\nseq=7 value=35 check=124\nseq=8 value=11 check=90\nseq=9 value=96 check=125\nseq=10 value=52 check=162\nseq=11 value=7 check=9\nseq=12 value=81 check=109"}]};

test('saved p6n1 Reflection enters model repair before any execution of context', async () => {
  const result = await trial(request => {
    if (request.stage === 'inspect') return savedP6n1Outputs[0];
    if (request.stage === 'reflect') {
      const output = structuredClone(savedP6n1Outputs[1]);
      output.binding = request.input.binding;
      if (request.input.validationFeedback) {
        assert.equal(request.input.validationFeedback.code, 'invalid_model_output');
        assert.equal(request.input.state.gaps.some(g => g.id === 'g-row11-remainder'), false);
        output.proposal.probes[0].sourceGroups = ['p6n1-src'];
      }
      return output;
    }
    return {};
  }, { cases: [savedP6n1Case], repeat: 2 });
  assert.deepEqual(result.requests.map(r => r.stage), ['inspect', 'reflect', 'reflect', 'update']);
  assert.equal(result.trace.events.find(e => e.kind === 'model_rejection').stage, 'reflect');
  assert.deepEqual(result.run.checks.map(c => c.sourceId), ['p6n1-src', 'p6n1-src']);
  assert.equal(result.run.observed.modelCalls, 4);
  assert.equal(result.run.observed.calls, 6);
  assert.equal(result.result.result.state.usage.toolCalls, 2);
  assert.equal(result.result.result.state.usage.rounds, 2);
  assert.equal(result.result.result.state.modelRepairDiagnostics[0].operation, 'reflect');
  assert.equal(result.result.result.state.pendingAssessmentExecutionIds.length, 1);
  assert.equal(result.result.reason, 'budget_exhausted');
  assert.equal(result.run.status, 'error');
  assert.equal(JSON.parse(result.run.output).decision, 'unknown');
  assert.equal(result.trace.events.filter(e => e.kind === 'raw_reply').length, 4);
});

test('ignored critic usage cannot bypass record validation before repair', async () => {
  const result = await trial(request => {
    if (request.stage !== 'reflect' || request.input.validationFeedback) return legal(request);
    return { ...reflected(request), usage: 'ignored by the driver', proposal: candidate(['context'], '-usage') };
  });
  assert.equal(result.run.status, 'success');
  assert.deepEqual(result.requests.map(r => r.stage), ['inspect', 'update', 'reflect', 'reflect']);
  assert.equal(result.result.result.state.modelRepairDiagnostics[0].operation, 'reflect');
  assert.deepEqual(result.run.checks.map(c => c.sourceId), ['record-a']);
  assert.equal(result.run.observed.calls, 5);
});

test('other capabilities retain their existing executor contract', async () => {
  const result = await trial(request => {
    if (request.stage !== 'inspect') return legal(request);
    const output = inspect(['machine']);
    output.probes[0].requiredCapability = 'local_check';
    return output;
  });
  assert.equal(result.run.status, 'success');
  assert.deepEqual(result.run.checks.map(c => [c.sourceId, c.capability]), [['machine', 'local_check']]);
  assert.equal(result.run.observed.calls, 4);
  assert.equal(result.result.result.state.modelRepairDiagnostics, undefined);
});

test('context is executable only when explicitly declared as a matching record tool', async () => {
  const c = structuredClone(recordCase);
  c.sources[1].id = 'context';
  const result = await trial(request => request.stage === 'inspect' ? inspect(['context']) : legal(request), { cases: [c] });
  assert.equal(result.run.status, 'success');
  assert.deepEqual(result.run.checks.map(check => check.sourceId), ['context']);
  assert.equal(result.run.observed.calls, 4);
  assert.equal(result.result.result.state.modelRepairDiagnostics, undefined);
});
