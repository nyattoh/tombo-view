import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

async function repeatedTrial(repair = false) {
  const out = await mkdtemp(join(tmpdir(), 'tombo-host-repeated-'));
  const child = spawn(process.execPath, ['scripts/metacognition-host-trial.mjs', '--case', 'work-01', '--arm', 'tombo', '--repeat', '1', '--origin', 'fixture', '--model-repair-attempts', repair ? '1' : '0', '--out', out]);
  let stderr = '', done;
  const observations = [], requests = [];
  child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('REQUEST ')) {
        const frame = JSON.parse(line.slice(8));
        const request = JSON.parse(await readFile(frame.path, 'utf8'));
        requests.push(request);
        assert.equal(/"(family|split|control|annotation)"/.test(JSON.stringify(request)), false);
        let output;
        if (request.stage === 'inspect') output = {
          claims: [{ id: 'c1', role: 'observation', text: 'Replay preserves one fulfilment row.', scope: 'trial' }, { id: 'c2', role: 'answer_claim', text: 'The order service is ready for replay traffic.', scope: 'trial' }],
          lenses: [{ id: 'l1', label: 'Replay', rationale: 'Check replay safety.', origin: 'initial', status: 'active' }],
          gaps: [1, 2].map(number => ({ id: `g${number}`, kind: 'unsupported_claim', lensId: 'l1', question: 'Is replay safe?', triggerRefs: [`c${number}`], whyItMatters: 'Replay safety controls readiness.', importance: 'required', claimIds: [`c${number}`], probeIds: [`p${number}`] })),
          probes: [1, 2].map(number => ({ id: `p${number}`, gapIds: [`g${number}`], method: 'counterexample', question: 'Read replay report.', requiredCapability: 'read_record', sourceGroups: ['replay-report'], successCondition: 'One row.', refutationCondition: 'Two rows.', inconclusiveCondition: 'Missing report.' }))
        };
        else if (request.stage === 'update') {
          observations.push(structuredClone(request.input.observations[0]));
          const evidenceIds = request.input.observations[0].evidence.map(item => item.id);
          const first = request.input.observations[0].probeId === 'p1';
          const claimId = first ? 'c1' : 'c2', gapId = first ? 'g1' : 'g2';
          output = {
            assessments: [{ claimId, evidenceIds, verdict: 'refutes', scopeMatched: true, reason: 'The same event produced two fulfilment rows.' }],
            resolutions: [{ gapId, reason: 'refuted', evidenceIds, explanation: 'Replay duplicates fulfilment.' }]
          };
          if (first) {
            await new Promise(resolve => setTimeout(resolve, 5));
            if (repair && !request.input.validationFeedback) output.claims = [{ id: 'c1', role: 'observation', text: 'Replay preserves one fulfilment row.', scope: 'trial' }];
          }
        } else output = { binding: request.input.binding, reviewedClaimIds: ['c1', 'c2'], completion: 'completed', limitations: [], proposal: {} };
        child.stdin.write(JSON.stringify({ sequence: frame.sequence, output: JSON.stringify(output), taskId: `fixture-${frame.sequence}`, model: { provider: 'codex', name: 'gpt-6.1-sol', effort: 'medium' } }) + '\n');
      } else if (line.startsWith('DONE ')) done = JSON.parse(line.slice(5));
    }
    assert.equal(await exited, 0, stderr);
    assert.ok(done);
    return { run: JSON.parse(await readFile(done.runPath, 'utf8')), trace: JSON.parse(await readFile(done.tracePath, 'utf8')), result: JSON.parse(await readFile(done.resultPath, 'utf8')), observations, requests };
  } finally { child.kill(); await rm(out, { recursive: true, force: true }); }
}

test('two physical reads of one record produce separate assessed observations and source references', async () => {
  const { run, trace, result, observations, requests } = await repeatedTrial();
  assert.deepEqual(requests.map(request => request.stage), ['inspect', 'update', 'update', 'reflect'], JSON.stringify({ reason: result.reason, stopReason: result.result.state.stopReason, pending: result.result.state.pendingAssessmentExecutionIds, calls: run.observed.calls, physicalChecks: run.checks.length, diagnostics: result.result.state.modelRepairDiagnostics }));
  assert.equal(run.status, 'success');
  assert.equal(result.status, 'completed');
  assert.equal(run.observed.calls, 6);
  assert.equal(run.observed.modelCalls, 4);
  assert.equal(run.observed.cost, 'UNKNOWN');
  assert.equal(run.observed.inputTokens, 'UNKNOWN');
  assert.equal(run.observed.outputTokens, 'UNKNOWN');
  assert.deepEqual(run.checks.map(check => check.sourceId), ['replay-report', 'replay-report']);
  const tools = trace.events.filter(event => event.kind === 'tool');
  assert.equal(new Set(tools.map(event => event.executionId)).size, 2);
  assert.equal(observations.length, 2);
  assert.equal(new Set(observations.flatMap(observation => observation.evidence.map(evidence => evidence.id))).size, 2);
  for (const observation of observations) {
    assert.equal(observation.toolCalls, 1);
    assert.equal(observation.costYen, null);
    assert.equal(observation.evidence[0].sourceGroup, 'replay-report');
    assert.equal(observation.evidence[0].locator, 'replay-report');
  }
  const state = result.result.state;
  assert.equal(state.usage.toolCalls, 2);
  assert.equal(state.usage.rounds, 2);
  assert.equal(state.usage.modelCalls, 4);
  assert.equal(state.usage.costYen, null);
  assert.equal(state.pendingAssessmentExecutionIds, undefined);
  assert.equal(state.modelRepairDiagnostics, undefined);
  assert.deepEqual(state.claims.flatMap(claim => claim.assessments.map(assessment => assessment.verdict)), ['refutes', 'refutes']);
  assert.deepEqual(state.claims.flatMap(claim => claim.assessments.flatMap(assessment => assessment.evidenceIds)), observations.flatMap(observation => observation.evidence.map(evidence => evidence.id)));
  assert.deepEqual(state.claims.map(claim => claim.status), ['contradicted', 'contradicted']);
  assert.deepEqual(state.gaps.map(gap => gap.status), ['resolved', 'resolved']);
  assert.equal(state.reflection.completion, 'completed');
  assert.equal(state.decision, 'ready_for_requested_step');
  const final = JSON.parse(run.output);
  assert.deepEqual(final.sourceRefs, ['replay-report']);
  assert.equal(final.decision, 'refuted');
  assert.deepEqual(final.uncertainties, []);
  assert.match(final.answer, /two fulfilment rows/);
});

test('repair reuses the saved observation and repeated reads still share the six-call cap', async () => {
  const { run, result, observations } = await repeatedTrial(true);
  assert.equal(run.status, 'error');
  assert.equal(run.observed.calls, 6);
  assert.equal(run.observed.modelCalls, 4);
  assert.equal(run.checks.length, 2);
  assert.equal(observations.length, 3);
  assert.deepEqual(observations[1], observations[0]);
  assert.notEqual(observations[2].executionId, observations[0].executionId);
  assert.notEqual(observations[2].evidence[0].id, observations[0].evidence[0].id);
  assert.equal(result.result.state.usage.toolCalls, 2);
  assert.equal(result.result.state.modelRepairDiagnostics.length, 1, JSON.stringify(result.result.state.modelRepairDiagnostics));
  assert.notEqual(result.result.state.decision, 'ready_for_requested_step');
  assert.equal(JSON.parse(run.output).decision, 'unknown');
});
