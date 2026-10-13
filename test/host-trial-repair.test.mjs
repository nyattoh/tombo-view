import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

async function trial(arm, respond, repairs = 1) {
  const out = await mkdtemp(join(tmpdir(), 'tombo-host-repair-'));
  const child = spawn(process.execPath, ['scripts/metacognition-host-trial.mjs', '--case', 'work-01', '--arm', arm, '--repeat', '1', '--origin', 'fixture', '--model-repair-attempts', String(repairs), '--out', out]);
  let stderr = '', done;
  child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('REQUEST ')) {
        const frame = JSON.parse(line.slice(8));
        const request = JSON.parse(await readFile(frame.path, 'utf8'));
        const response = await respond(request);
        child.stdin.write(JSON.stringify({ sequence: frame.sequence, output: typeof response === 'string' ? response : JSON.stringify(response), taskId: `fixture-${frame.sequence}`, model: { provider: 'codex', name: 'gpt-6.1-sol', effort: 'medium' } }) + '\n');
      } else if (line.startsWith('DONE ')) done = JSON.parse(line.slice(5));
    }
    assert.equal(await exited, 0, stderr);
    assert.ok(done);
    return { run: JSON.parse(await readFile(done.runPath, 'utf8')), trace: JSON.parse(await readFile(done.tracePath, 'utf8')), result: JSON.parse(await readFile(done.resultPath, 'utf8')) };
  } finally { child.kill(); await rm(out, { recursive: true, force: true }); }
}

const finish = { action: 'finish', decision: 'unknown', answer: 'Replay safety has not been verified.', uncertainties: ['No replay record has been read.'], sourceRefs: [] };
test('baseline syntax repair receives feedback and charges the rejected generation', async () => {
  const result = await trial('baseline', request => {
    if (request.sequence === 1) return { action: 'invent' };
    assert.equal(request.input.validationFeedback.code, 'invalid_model_output');
    return finish;
  });
  assert.equal(result.run.status, 'success');
  assert.equal(result.run.observed.modelCalls, 2);
  assert.equal(result.run.observed.calls, 2);
  assert.equal(result.trace.events.filter(e => e.kind === 'model_rejection').length, 1);
});

test('oversized output is retained then corrected without lifting the cap', async () => {
  const result = await trial('baseline', request => {
    if (request.sequence === 1) return 'x'.repeat(4001);
    assert.match(request.input.validationFeedback.message, /character/);
    return finish;
  });
  assert.equal(result.run.status, 'success');
  assert.equal(result.run.requested.maxOutputChars, 4000);
  assert.equal(result.run.observed.modelCalls, 2);
  assert.equal(result.trace.events.find(e => e.kind === 'reply').output.length, 4001);
});

test('persistent malformed baseline stops at the declared repair bound', async () => {
  const result = await trial('baseline', () => ({ action: 'invent' }), 2);
  assert.equal(result.run.status, 'error');
  assert.equal(result.run.observed.modelCalls, 3);
  assert.equal(result.run.checks.length, 0);
});

test('TOMBO repairs an update without replaying its physical source check', async () => {
  const result = await trial('tombo', request => {
    if (request.stage === 'inspect') return {
      claims: [{ id: 'c1', role: 'answer_claim', text: 'The order service is ready for replay traffic.', scope: 'trial' }],
      lenses: [{ id: 'l1', label: 'Replay', rationale: 'Read the replay record.', origin: 'initial', status: 'active' }],
      gaps: [{ id: 'g1', kind: 'unsupported_claim', lensId: 'l1', question: 'Is replay safe?', triggerRefs: ['c1'], whyItMatters: 'The claim requires replay safety.', importance: 'required', claimIds: ['c1'], probeIds: ['p1'] }],
      probes: [{ id: 'p1', gapIds: ['g1'], method: 'counterexample', question: 'Read replay report.', requiredCapability: 'read_record', sourceGroups: ['replay-report'], successCondition: 'One row.', refutationCondition: 'Two rows.', inconclusiveCondition: 'Missing report.' }]
    };
    if (request.stage === 'update') {
      const proposal = { assessments: [{ claimId: 'c1', evidenceIds: ['replay-report'], verdict: 'refutes', scopeMatched: true, reason: 'The same event produced two fulfilment rows.' }], resolutions: [{ gapId: 'g1', reason: 'refuted', evidenceIds: ['replay-report'], explanation: 'Replay creates duplicate rows.' }] };
      return request.input.validationFeedback ? proposal : { ...proposal, claims: [{ id: 'c1', role: 'answer_claim', text: 'The order service is ready for replay traffic.', scope: 'trial' }] };
    }
    return { binding: request.input.binding, reviewedClaimIds: ['c1'], completion: 'completed', limitations: [], proposal: {} };
  });
  assert.equal(result.run.status, 'success');
  assert.equal(result.run.observed.modelCalls, 4);
  assert.equal(result.run.observed.calls, 5);
  assert.equal(result.run.checks.length, 1);
  assert.equal(result.result.result.state.usage.rounds, 1);
  assert.equal(result.result.result.state.modelRepairDiagnostics.length, 1);
});

test('failed TOMBO inspection labels its draft unverified rather than affirming it', async () => {
  const result = await trial('tombo', () => ({ claims: [{ id: 'c', role: 'wrong', text: 'Ready.', scope: 'trial' }] }));
  assert.equal(result.run.status, 'error');
  assert.match(JSON.parse(result.run.output).answer, /unverified|not established/i);
});
