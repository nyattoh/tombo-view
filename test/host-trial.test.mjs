import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

async function trial(arm, respond) {
  const out = await mkdtemp(join(tmpdir(), 'tombo-host-'));
  const child = spawn(process.execPath, ['scripts/metacognition-host-trial.mjs', '--case', 'work-01', '--arm', arm, '--repeat', '1', '--origin', 'fixture', '--out', out]);
  let stderr = '', done;
  child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('REQUEST ')) {
        const frame = JSON.parse(line.slice(8));
        const request = JSON.parse(await readFile(frame.path, 'utf8'));
        assert.equal(/"(family|split|control|annotation)"/.test(JSON.stringify(request)), false);
        const output = await respond(request);
        if (output === null) child.stdin.end();
        else child.stdin.write(JSON.stringify({ sequence: frame.sequence, output: JSON.stringify(output), taskId: `fixture-${frame.sequence}`, model: { provider: 'codex', name: 'gpt-6.1-sol', effort: 'medium' } }) + '\n');
      } else if (line.startsWith('DONE ')) done = JSON.parse(line.slice(5));
    }
    const code = await exited;
    assert.ok(done, stderr || `exit ${code}`);
    return { run: JSON.parse(await readFile(done.runPath, 'utf8')), trace: JSON.parse(await readFile(done.tracePath, 'utf8')), result: JSON.parse(await readFile(done.resultPath, 'utf8')) };
  } finally { child.kill(); await rm(out, { recursive: true, force: true }); }
}

test('baseline executes a requested source and records grounded final output', async () => {
  const result = await trial('baseline', r => r.sequence === 1 ? { action: 'read', sourceId: 'replay-report' } : { action: 'finish', decision: 'refuted', answer: 'Replay created two fulfilment rows.', uncertainties: [], sourceRefs: ['replay-report'] });
  assert.equal(result.run.status, 'success');
  assert.equal(result.run.origin, 'fixture');
  assert.equal(result.run.observed.calls, 3);
  assert.equal(result.run.checks[0].status, 'ok');
  assert.equal(JSON.parse(result.run.output).decision, 'refuted');
  assert.equal(result.trace.events.filter(e => e.kind === 'reply').length, 2);
});

test('TOMBO actual runner assesses counterevidence and requires reflection', async () => {
  const result = await trial('tombo', r => {
    if (r.stage === 'inspect') return {
      claims: [{ id: 'c1', role: 'answer_claim', text: 'The order service is ready for replay traffic.', scope: 'trial' }],
      lenses: [{ id: 'l1', label: 'Evidence', rationale: 'Review the claim.', origin: 'initial', status: 'active' }],
      gaps: [{ id: 'g1', kind: 'unsupported_claim', lensId: 'l1', question: 'Does replay preserve one fulfilment?', triggerRefs: ['c1'], whyItMatters: 'Readiness depends on replay.', importance: 'required', claimIds: ['c1'], probeIds: ['p1'] }],
      probes: [{ id: 'p1', gapIds: ['g1'], method: 'counterexample', question: 'Read replay evidence.', requiredCapability: 'read_record', sourceGroups: ['replay-report'], successCondition: 'One row.', refutationCondition: 'Two rows.', inconclusiveCondition: 'No evidence.' }]
    };
    if (r.stage === 'update') return { assessments: [{ claimId: 'c1', evidenceIds: ['replay-report'], verdict: 'refutes', scopeMatched: true, reason: 'Two deliveries created two fulfilment rows.' }], resolutions: [{ gapId: 'g1', reason: 'refuted', evidenceIds: ['replay-report'], explanation: 'Replay duplicates fulfilment.' }] };
    return { binding: r.input.binding, reviewedClaimIds: ['c1'], completion: 'completed', limitations: [], proposal: {} };
  });
  assert.equal(result.run.status, 'success');
  assert.equal(JSON.parse(result.run.output).decision, 'refuted');
  assert.equal(result.result.result.state.claims[0].status, 'contradicted');
  assert.equal(result.run.observed.calls, 4);
  assert.deepEqual(result.trace.events.filter(e => e.kind === 'request').map(e => e.stage), ['inspect', 'update', 'reflect']);
});

test('invalid model response is retained and cannot claim success', async () => {
  const result = await trial('baseline', () => ({ action: 'invent' }));
  assert.equal(result.run.status, 'error');
  assert.equal(result.trace.events.find(e => e.kind === 'reply').taskId, 'fixture-1');
});

test('closed host input records cancellation', async () => {
  const result = await trial('baseline', () => null);
  assert.equal(result.run.status, 'cancelled');
  assert.equal(result.run.observed.modelCalls, 1);
});
