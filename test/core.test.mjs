import test from 'node:test';
import assert from 'node:assert/strict';
import { createTombo, hashPassage, fixtureAdapter, FIXTURE_CASES, stateSchema, renderMarkdownReport } from '../dist/index.js';

function evidence(id, passage, scope = 'synthetic-account-v1', validity = 'current') {
  return { id, kind: 'document', locator: `fixture:${id}`, sourceGroup: id, retrievedAt: '2026-10-14T00:00:00.000Z', version: '1', scope, passage, contentHash: hashPassage(passage), validity };
}
function packet(budget = {}) {
  return { schemaVersion: '0.1', taskId: 'demo-account-close', goal: '架空アカウントの CLOSE 409 の原因を確認し、次の確認を選ぶ。', mode: 'execute', successCriteria: ['原因を固定資料で確認する'], evidence: [], capabilities: ['read_document'], budget: { maxRounds: 2, maxModelCalls: 3, maxToolCalls: 6, maxElapsedMs: 120000, maxInputChars: 48000, maxOutputTokensPerCall: 4000, ...budget } };
}
function observation(probeId, ev = [], options = {}) {
  return { executionId: 'run-1', probeId, outcome: 'completed', evidence: ev, toolCalls: 1, elapsedMs: 10, costYen: 0, ...options };
}
const options = { adapter: fixtureAdapter, now: () => new Date('2026-10-14T00:00:00.000Z') };

test('fixed replay resolves only matching evidence and withdrawal reopens required gap', async () => {
  const tombo = createTombo(options);
  const first = await tombo.inspect(packet());
  assert.equal(first.state.decision, 'needs_check');
  assert.equal(first.state.claims[0].status, 'unverified');
  const ev = evidence('rule-1', FIXTURE_CASES.account.passage);
  const next = await tombo.update(first.state, [observation(first.nextProbeIds[0], [ev])]);
  assert.equal(next.state.decision, 'ready_for_requested_step');
  assert.equal(next.state.claims[0].status, 'supported');
  assert.equal(next.state.gaps[0].importance, 'required');
  assert.deepEqual(next.state.usage, { rounds: 1, modelCalls: 2, toolCalls: 1, elapsedMs: 10, totalTokens: 0, costYen: 0 });
  const reopened = tombo.invalidate(next.state, { evidenceIds: ['rule-1'], reason: '版が変更された' });
  assert.equal(reopened.state.gaps[0].status, 'open');
  assert.equal(reopened.state.claims[0].status, 'unverified');
  assert.equal(reopened.state.evidence[0].validity, 'withdrawn');
  assert.equal(reopened.state.decision, 'needs_check');
  assert.equal(next.state.evidence[0].validity, 'current');
});

test('no_result never resolves; repeated delivery is free, actual rerun costs usage', async () => {
  const tombo = createTombo(options);
  const first = await tombo.inspect(packet({ maxRounds: 5, maxModelCalls: 6 }));
  const obs = observation(first.nextProbeIds[0], [], { outcome: 'no_result' });
  const next = await tombo.update(first.state, [obs]);
  assert.equal(next.state.gaps[0].status, 'open');
  assert.equal(next.state.stopReason, 'no_progress');
  assert.equal(next.state.usage.toolCalls, 1);
  const duplicate = await tombo.update(next.state, [obs]);
  assert.deepEqual(duplicate.state, next.state);
  const rerun = await tombo.update(next.state, [{ ...obs, executionId: 'run-2' }]);
  assert.equal(rerun.state.usage.toolCalls, 2);
  assert.equal(rerun.state.usage.modelCalls, 3);
  assert.equal(rerun.state.revision, next.state.revision + 1);
  const collision = await tombo.update(next.state, [{ ...obs, elapsedMs: 20 }]);
  assert.equal(collision.state.stopReason, 'invalid_input');
  assert.equal(collision.state.usage.toolCalls, 1);
});

test('boundary rejects wrong hash and extra input fields before generation', async () => {
  const tombo = createTombo(options);
  await assert.rejects(tombo.inspect({ ...packet(), unexpected: true }), { code: 'invalid_input' });
  await assert.rejects(tombo.inspect({ ...packet(), evidence: [{ ...evidence('wrong', 'text'), contentHash: '0'.repeat(64) }] }), { code: 'invalid_input' });
  await assert.rejects(tombo.inspect(packet({ maxInputChars: 1 })), { code: 'input_too_large' });
});

function adapterFor(update, config = {}) {
  return { ...fixtureAdapter, async generate(input) {
    if (input.operation === 'inspect') return fixtureAdapter.generate(input);
    return { proposal: typeof update === 'function' ? update(input) : update, usage: { totalTokens: 12, outputTokens: 12, costYen: 0 }, ...config };
  } };
}
function assessment(input, verdict = 'supports', evId = input.observations[0].evidence[0].id) {
  return { claimId: input.state.claims[0].id, evidenceIds: [evId], verdict, scopeMatched: true, reason: '対象範囲に一致する証拠を照合した' };
}

test('opposed current assessments dispute a supported claim and reopen its gap', async () => {
  const adapter = adapterFor(input => ({ assessments: [assessment(input, 'refutes')] }));
  const initial = await createTombo(options).inspect(packet({ maxRounds: 4, maxModelCalls: 5 }));
  const supported = await createTombo(options).update(initial.state, [observation(initial.nextProbeIds[0], [evidence('supports', FIXTURE_CASES.account.passage)])]);
  const disputed = await createTombo({ ...options, adapter }).update(supported.state, [observation(initial.nextProbeIds[0], [evidence('refutes', '契約がなくても同じエラーを確認した')], { executionId: 'run-2' })]);
  assert.equal(disputed.state.claims[0].status, 'disputed');
  assert.equal(disputed.state.gaps[0].status, 'open');
  assert.equal(disputed.state.decision, 'needs_check');
  assert.equal(supported.state.claims[0].role, 'hypothesis');
});

test('mismatched scope and withdrawn evidence cannot support a claim', async () => {
  const tombo = createTombo({ ...options, adapter: adapterFor(input => ({ assessments: [assessment(input)] })) });
  const first = await tombo.inspect(packet({ maxRounds: 4, maxModelCalls: 5 }));
  const mismatch = await tombo.update(first.state, [observation(first.nextProbeIds[0], [evidence('other', '別の対象を確認', 'other-scope')])]);
  assert.equal(mismatch.state.claims[0].status, 'unverified');
  assert.equal(mismatch.state.gaps[0].status, 'open');
  const withdrawn = await tombo.update(first.state, [observation(first.nextProbeIds[0], [evidence('old', '対象を確認', 'synthetic-account-v1', 'withdrawn')])]);
  assert.equal(withdrawn.state.claims[0].status, 'unverified');
  assert.equal(withdrawn.state.decision, 'needs_check');
});

test('unknown model references reject all model changes and keep registered observations', async () => {
  const tombo = createTombo({ ...options, adapter: adapterFor(input => ({ claims: [{ id: 'invented', role: 'hypothesis', text: '採用してはいけない追加候補', scope: 'synthetic-account-v1' }], assessments: [assessment(input, 'supports', 'missing-evidence')] })) });
  const first = await tombo.inspect(packet());
  const obs = observation(first.nextProbeIds[0], [evidence('observed', '登録済みの新しい本文')]);
  const next = await tombo.update(first.state, [obs]);
  assert.equal(next.state.stopReason, 'invalid_model_output');
  assert.deepEqual(next.state.claims, first.state.claims);
  assert.deepEqual(next.state.gaps, first.state.gaps);
  assert.equal(next.state.evidence[0].id, 'observed');
  assert.equal(next.state.usage.modelCalls, 2);
  assert.equal(next.state.usage.toolCalls, 1);
  assert.equal(next.state.revision, first.state.revision + 1);
  const deliveredAgain = await tombo.update(next.state, [obs]);
  assert.equal(deliveredAgain.state.stopReason, 'invalid_model_output');
  assert.deepEqual(deliveredAgain.state.claims, next.state.claims);
  assert.deepEqual(deliveredAgain.state.gaps, next.state.gaps);
  assert.deepEqual(deliveredAgain.state.evidence, next.state.evidence);
  assert.deepEqual(deliveredAgain.state.appliedExecutions, next.state.appliedExecutions);
  assert.equal(deliveredAgain.state.usage.modelCalls, 3);
  assert.equal(deliveredAgain.state.usage.rounds, 2);
  assert.equal(deliveredAgain.state.usage.toolCalls, 1);
  assert.equal(deliveredAgain.state.usage.elapsedMs, 10);
  assert.equal(deliveredAgain.state.revision, next.state.revision + 1);
  assert.equal(first.state.evidence.length, 0);
});

test('a required gap cannot be silently overwritten or downgraded', async () => {
  const tombo = createTombo({ ...options, adapter: adapterFor(input => ({ gaps: [{ ...Object.fromEntries(Object.entries(input.state.gaps[0]).filter(([key]) => key !== 'status')), importance: 'optional' }] })) });
  const first = await tombo.inspect(packet());
  const next = await tombo.update(first.state, [observation(first.nextProbeIds[0], [evidence('observed', '取得した本文')])]);
  assert.equal(next.state.stopReason, 'invalid_model_output');
  assert.equal(next.state.gaps[0].importance, 'required');
  assert.equal(next.state.gaps[0].status, 'open');
});

test('not_applicable needs current scope-matched evidence and withdrawal reopens it', async () => {
  const adapter = adapterFor(input => ({ resolutions: [{ gapId: input.state.gaps[0].id, reason: 'not_applicable', evidenceIds: [input.observations[0].evidence[0].id], explanation: 'この証拠によりタスクで問題にした条件は対象外と判断した' }] }));
  const tombo = createTombo({ ...options, adapter });
  const first = await tombo.inspect(packet());
  const next = await tombo.update(first.state, [observation(first.nextProbeIds[0], [evidence('excluded', '今回の条件では適用されない')])]);
  assert.equal(next.state.gaps[0].resolution.reason, 'not_applicable');
  assert.equal(next.state.decision, 'ready_for_requested_step');
  const reopened = tombo.invalidate(next.state, { evidenceIds: ['excluded'], reason: '対象条件が変化した' });
  assert.equal(reopened.state.gaps[0].status, 'open');
  assert.equal(reopened.state.gaps[0].resolution, undefined);
  const mismatched = await tombo.update(first.state, [observation(first.nextProbeIds[0], [evidence('unrelated', '無関係の条件', 'unrelated')])]);
  assert.equal(mismatched.state.stopReason, 'invalid_model_output');
  assert.equal(mismatched.state.gaps[0].status, 'open');
});

test('no_result cannot be transformed into not_applicable using old evidence', async () => {
  const adapter = adapterFor(input => ({ resolutions: [{ gapId: input.state.gaps[0].id, reason: 'not_applicable', evidenceIds: ['original'], explanation: '探索結果がなかったため対象外と判断' }] }));
  const tombo = createTombo({ ...options, adapter });
  const first = await tombo.inspect({ ...packet(), evidence: [evidence('original', '元の資料')] });
  const next = await tombo.update(first.state, [observation(first.nextProbeIds[0], [], { outcome: 'no_result' })]);
  assert.equal(next.state.stopReason, 'invalid_model_output');
  assert.equal(next.state.gaps[0].status, 'open');
});

test('unavailable probe blocks required gap and missing capability blocks inspect', async () => {
  const tombo = createTombo(options);
  const first = await tombo.inspect(packet());
  const unavailable = await tombo.update(first.state, [observation(first.nextProbeIds[0], [], { outcome: 'unavailable' })]);
  assert.equal(unavailable.state.gaps[0].status, 'blocked');
  assert.equal(unavailable.state.decision, 'blocked');
  assert.equal(unavailable.state.stopReason, 'capability_limit');
  const missingCapability = await tombo.inspect({ ...packet(), capabilities: [] });
  assert.equal(missingCapability.state.gaps[0].status, 'blocked');
  assert.equal(missingCapability.state.stopReason, 'capability_limit');
});

test('zero budget precheck does not consume generation calls', async () => {
  const next = await createTombo(options).inspect(packet({ maxModelCalls: 0 }));
  assert.equal(next.state.decision, 'blocked');
  assert.equal(next.state.stopReason, 'budget_exhausted');
  assert.deepEqual(next.state.usage, { rounds: 0, modelCalls: 0, toolCalls: 0, elapsedMs: 0, totalTokens: 0, costYen: 0 });
  const first = await createTombo(options).inspect(packet({ maxModelCalls: 1 }));
  const stopped = await createTombo(options).update(first.state, [observation('p-account-contract', [], { outcome: 'no_result' })]);
  assert.equal(stopped.state.usage.modelCalls, 1);
  assert.equal(stopped.state.stopReason, 'budget_exhausted');
});

test('monetary cap requires a reservation and rejects unknown actual tool cost', async () => {
  const unpriced = { generate: fixtureAdapter.generate };
  await assert.rejects(createTombo({ ...options, adapter: unpriced }).inspect(packet({ maxCostYen: 100 })), { code: 'budget_accounting_unavailable' });
  await assert.rejects(createTombo({ ...options, adapter: { ...fixtureAdapter, estimateMaxCostYen: () => 101 } }).inspect(packet({ maxCostYen: 100 })), { code: 'budget_exhausted' });
  const tombo = createTombo(options);
  const first = await tombo.inspect(packet({ maxCostYen: 100 }));
  const unknown = await tombo.update(first.state, [observation(first.nextProbeIds[0], [], { outcome: 'no_result', costYen: null })]);
  assert.equal(unknown.state.stopReason, 'budget_accounting_unavailable');
  assert.equal(unknown.state.usage.modelCalls, 1);
  assert.equal(unknown.state.usage.toolCalls, 1);
  assert.equal(unknown.state.usage.costYen, null);
  assert.equal(unknown.state.appliedExecutions[0].executionId, 'run-1');
  const report = renderMarkdownReport({ ...first.state, usage: { ...first.state.usage, costYen: null } });
  assert.match(report, /費用: 未取得/);
});

test('output count and model failure cannot evade token or call caps', async () => {
  const excessive = { ...fixtureAdapter, async generate(input) { const output = await fixtureAdapter.generate(input); return { ...output, usage: { totalTokens: 100, outputTokens: 100, costYen: 0 } }; } };
  await assert.rejects(createTombo({ ...options, adapter: excessive }).inspect(packet({ maxOutputTokensPerCall: 20 })), { code: 'budget_exhausted' });
  const unknown = { ...fixtureAdapter, async generate(input) { const output = await fixtureAdapter.generate(input); return { ...output, usage: { totalTokens: null, costYen: null } }; } };
  await assert.rejects(createTombo({ ...options, adapter: unknown }).inspect(packet()), { code: 'budget_accounting_unavailable' });
  let attempts = 0;
  const transient = { async generate(input) { attempts++; if (attempts === 1) throw new Error('temporary outage'); return fixtureAdapter.generate(input); } };
  const recovered = await createTombo({ ...options, adapter: transient }).inspect(packet());
  assert.equal(recovered.state.usage.modelCalls, 2);
  assert.equal(recovered.state.usage.totalTokens, null);
  assert.equal(recovered.state.usage.costYen, null);
  const failing = { ...fixtureAdapter, async generate(input) { if (input.operation === 'inspect') return fixtureAdapter.generate(input); throw new Error('outage'); } };
  const tombo = createTombo({ ...options, adapter: failing });
  const first = await tombo.inspect(packet());
  const failed = await tombo.update(first.state, [observation(first.nextProbeIds[0], [], { outcome: 'no_result' })]);
  assert.equal(failed.state.usage.modelCalls, 3);
  assert.equal(failed.state.stopReason, 'model_error');
  assert.deepEqual(failed.state.claims, first.state.claims);
});

test('generation timeout rejects late application and preserves old claims', async () => {
  const adapter = { ...fixtureAdapter, async generate(input) { if (input.operation === 'inspect') return fixtureAdapter.generate(input); return new Promise(() => {}); } };
  const tombo = createTombo({ ...options, adapter });
  const first = await tombo.inspect(packet({ maxElapsedMs: 15, maxModelCalls: 2 }));
  const failed = await tombo.update(first.state, [observation(first.nextProbeIds[0], [], { outcome: 'no_result', elapsedMs: 0 })]);
  assert.equal(failed.state.stopReason, 'model_timeout');
  assert.equal(failed.state.usage.modelCalls, 2);
  assert.deepEqual(failed.state.claims, first.state.claims);
});

test('state integrity rejects a fabricated supported status or reference', async () => {
  const tombo = createTombo(options);
  const first = await tombo.inspect(packet());
  const changed = structuredClone(first.state);
  changed.claims[0].status = 'supported';
  await assert.rejects(tombo.update(changed, []), { code: 'invalid_input' });
  const unknown = structuredClone(first.state);
  unknown.gaps[0].triggerRefs = ['task:criterion:999'];
  assert.throws(() => tombo.invalidate(unknown, { evidenceIds: ['missing'], reason: '撤回' }), { code: 'invalid_input' });
  const invented = structuredClone(first.state);
  invented.gaps[0].status = 'resolved';
  invented.gaps[0].resolution = { reason: 'supported', evidenceIds: ['missing'], explanation: '架空の根拠' };
  assert.equal(stateSchema.safeParse(invented).success, true);
  await assert.rejects(tombo.update(invented, []), { code: 'invalid_input' });
});

test('redacted evidence is replayable but cannot be evaluated without reacquisition', async () => {
  const tombo = createTombo(options);
  const first = await tombo.inspect({ ...packet(), evidence: [evidence('original', '元の資料')] });
  const redacted = structuredClone(first.state);
  for (const ev of [...redacted.task.evidence, ...redacted.evidence]) { ev.passage = ''; ev.passageUnavailable = true; }
  assert.equal(stateSchema.safeParse(redacted).success, true);
  const blocked = await tombo.update(redacted, [observation(first.nextProbeIds[0], [], { outcome: 'no_result' })]);
  assert.equal(blocked.state.stopReason, 'passage_unavailable');
  assert.equal(blocked.state.usage.modelCalls, 1);
  const restored = await tombo.update(redacted, [observation(first.nextProbeIds[0], [evidence('original', '元の資料')])]);
  assert.equal(restored.state.evidence[0].passage, '元の資料');
  assert.equal(restored.state.evidence[0].passageUnavailable, undefined);
  assert.equal(restored.state.task.evidence[0].passage, '元の資料');
  assert.equal(restored.state.usage.modelCalls, 2);
});

test('fixed fixture rejects unrelated tasks and unrelated text never resolves the demo', async () => {
  await assert.rejects(createTombo(options).inspect({ ...packet(), goal: '実在サービスの請求問題を解決する' }), { code: 'unsupported_fixture' });
  const first = await createTombo(options).inspect(packet());
  const next = await createTombo(options).update(first.state, [observation(first.nextProbeIds[0], [evidence('unrelated', '単なる関連のない説明')])]);
  assert.equal(next.state.claims[0].status, 'unverified');
  assert.equal(next.state.gaps[0].status, 'open');
  assert.equal(next.state.decision, 'needs_check');
});

test('new candidate limit retains explicit exclusion reasons and validates references', async () => {
  const adapter = adapterFor(input => ({ gaps: Array.from({ length: 9 }, (_, index) => ({ id: `extra-${index}`, kind: 'missing_fact', lensId: input.state.lenses[0].id, question: `条件 ${index} は何か`, triggerRefs: ['task:goal'], whyItMatters: '対象条件を確認するため', importance: 'optional', claimIds: [], probeIds: [] })) }));
  const tombo = createTombo({ ...options, adapter });
  const first = await tombo.inspect(packet());
  const next = await tombo.update(first.state, [observation(first.nextProbeIds[0], [], { outcome: 'no_result' })]);
  assert.equal(next.state.gaps.length, 8);
  assert.deepEqual(next.state.excludedCandidates.map(item => item.id), ['extra-7', 'extra-8']);
  assert.match(next.state.excludedCandidates[0].reason, /cap/);
});

test('ninth required candidate is a blocker even when eight retained candidates are optional', async () => {
  const adapter = { async generate() { return {
    proposal: {
      lenses: [{ id: 'lens', label: '条件', rationale: '入力の目的を確かめる', origin: 'initial', status: 'active' }],
      gaps: Array.from({ length: 9 }, (_, index) => ({ id: `gap-${index}`, kind: 'missing_fact', lensId: 'lens', question: `確認 ${index}`, triggerRefs: ['task:goal'], whyItMatters: '目的の条件を確認する', importance: index === 8 ? 'required' : 'optional', claimIds: [], probeIds: [] })),
    }, usage: { totalTokens: 10, outputTokens: 10, costYen: 0 },
  }; } };
  const next = await createTombo({ ...options, adapter }).inspect(packet());
  assert.equal(next.state.gaps.length, 8);
  assert.equal(next.state.gaps.every(gap => gap.importance === 'optional'), true);
  assert.equal(next.state.decision, 'blocked');
  assert.equal(next.state.stopReason, 'candidate_limit');
  assert.deepEqual(next.state.excludedCandidates, [{ id: 'gap-8', importance: 'required', reason: 'Candidate cap of 8 reached' }]);
});

test('cost reservation refreshes remaining elapsed time before generation', async () => {
  let now = Date.parse('2026-10-14T00:00:00.000Z');
  const started = now;
  const adapter = { ...fixtureAdapter, estimateMaxCostYen(input) { if (input.operation === 'update') now = started + 100; return 0; } };
  const tombo = createTombo({ adapter, now: () => now });
  const first = await tombo.inspect(packet({ maxElapsedMs: 100, maxCostYen: 100 }));
  const next = await tombo.update(first.state, [observation(first.nextProbeIds[0], [evidence('observed', '新しい証拠')], { elapsedMs: 0 })]);
  assert.equal(next.state.stopReason, 'budget_exhausted');
  assert.equal(next.state.usage.modelCalls, 1);
  assert.equal(next.state.usage.elapsedMs, 100);
  assert.equal(next.state.evidence[0].id, 'observed');
  assert.deepEqual(next.state.claims, first.state.claims);
});

test('late model output is rejected even when its proposal would remove all required gaps', async () => {
  let now = Date.parse('2026-10-14T00:00:00.000Z');
  const started = now;
  const adapter = { ...fixtureAdapter, async generate(input) { const output = await fixtureAdapter.generate(input); if (input.operation === 'update') now = started + 101; return output; } };
  const tombo = createTombo({ adapter, now: () => now });
  const first = await tombo.inspect(packet({ maxElapsedMs: 100 }));
  const next = await tombo.update(first.state, [observation(first.nextProbeIds[0], [evidence('proof', FIXTURE_CASES.account.passage)], { elapsedMs: 0 })]);
  assert.equal(next.state.stopReason, 'budget_exhausted');
  assert.equal(next.state.decision, 'blocked');
  assert.equal(next.state.usage.modelCalls, 2);
  assert.equal(next.state.usage.elapsedMs, 101);
  assert.equal(next.state.gaps[0].status, 'open');
  assert.equal(next.state.claims[0].status, 'unverified');
});

test('host elapsed time and wall elapsed time are combined without double counting', async () => {
  let now = Date.parse('2026-10-14T00:00:00.000Z');
  const tombo = createTombo({ adapter: fixtureAdapter, now: () => now });
  const first = await tombo.inspect(packet());
  now += 80;
  const next = await tombo.update(first.state, [observation(first.nextProbeIds[0], [], { outcome: 'no_result', elapsedMs: 80 })]);
  assert.equal(next.state.usage.elapsedMs, 80);
  assert.equal(next.state.usage.toolCalls, 1);
});

test('only ambiguous required gaps request user input; optional gaps permit a bounded ready decision', async () => {
  const adapter = { async generate(input) { return { proposal: {
    lenses: [{ id: 'intent', label: '本人の希望', rationale: '目的を絞るため', origin: 'initial', status: 'active' }],
    gaps: [{ id: 'intent-gap', kind: 'ambiguous_intent', lensId: 'intent', question: 'どの条件を優先するか。', triggerRefs: ['task:goal'], whyItMatters: '本人の希望が目的を変えるため', importance: input.task.mode === 'execute' ? 'required' : 'optional', claimIds: [], probeIds: [] }],
  }, usage: { totalTokens: 10, outputTokens: 10, costYen: null } }; } };
  const tombo = createTombo({ ...options, adapter });
  const required = await tombo.inspect(packet());
  assert.equal(required.state.decision, 'needs_user_input');
  assert.deepEqual(required.userQuestions, ['どの条件を優先するか。']);
  const optional = await tombo.inspect({ ...packet(), mode: 'explain' });
  assert.equal(optional.state.decision, 'ready_for_requested_step');
  assert.equal(optional.state.gaps[0].status, 'open');
  assert.equal(optional.state.usage.costYen, null);
});

test('actual host overspend is recorded while generation remains blocked', async () => {
  const tombo = createTombo(options);
  const first = await tombo.inspect(packet({ maxToolCalls: 1, maxCostYen: 5 }));
  const obs = observation(first.nextProbeIds[0], [evidence('observed', '実際に取得した証拠')], { toolCalls: 2, costYen: 6 });
  const stopped = await tombo.update(first.state, [obs]);
  assert.equal(stopped.state.stopReason, 'budget_exhausted');
  assert.equal(stopped.state.usage.toolCalls, 2);
  assert.equal(stopped.state.usage.costYen, 6);
  assert.equal(stopped.state.usage.modelCalls, 1);
  assert.equal(stopped.state.evidence[0].id, 'observed');
  assert.equal(stopped.state.appliedExecutions[0].executionId, 'run-1');
  const resent = await tombo.update(stopped.state, [obs]);
  assert.deepEqual(resent.state, stopped.state);
  const malformed = await tombo.update(first.state, [obs, { ...obs, executionId: 'other', probeId: 'missing' }]);
  assert.equal(malformed.state.stopReason, 'invalid_input');
  assert.equal(malformed.state.usage.toolCalls, 0);
  assert.equal(malformed.state.evidence.length, 0);
});

test('missing redacted passage stops generation after accounting a valid new run', async () => {
  const tombo = createTombo(options);
  const first = await tombo.inspect({ ...packet(), evidence: [evidence('original', '元の本文')] });
  const redacted = structuredClone(first.state);
  for (const item of [...redacted.task.evidence, ...redacted.evidence]) { item.passage = ''; item.passageUnavailable = true; }
  const stopped = await tombo.update(redacted, [observation(first.nextProbeIds[0], [evidence('new', '新しい本文')])]);
  assert.equal(stopped.state.stopReason, 'passage_unavailable');
  assert.equal(stopped.state.usage.toolCalls, 1);
  assert.equal(stopped.state.usage.modelCalls, 1);
  assert.equal(stopped.state.evidence[1].id, 'new');
  assert.equal(stopped.state.appliedExecutions[0].executionId, 'run-1');
});
