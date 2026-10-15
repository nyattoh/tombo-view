import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

async function profileTrial(participantModel, replyEffort = 'low') {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-host-profile-'));
  const protocol = JSON.parse(await readFile('evaluation/metacognition-protocol.json', 'utf8'));
  if (participantModel === undefined) delete protocol.participantModel;
  else protocol.participantModel = participantModel;
  const protocolPath = join(directory, 'protocol.json');
  await writeFile(protocolPath, JSON.stringify(protocol));
  const child = spawn(process.execPath, ['scripts/metacognition-host-trial.mjs', '--case', 'work-01', '--arm', 'baseline', '--origin', 'fixture', '--protocol', protocolPath, '--out', join(directory, 'trial')]);
  let stderr = '', done;
  const requests = [];
  child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('REQUEST ')) {
        const frame = JSON.parse(line.slice(8));
        requests.push(JSON.parse(await readFile(frame.path, 'utf8')));
        child.stdin.write(JSON.stringify({ sequence: frame.sequence, output: JSON.stringify({ action: 'finish', decision: 'unknown', answer: 'Replay safety remains unverified.', uncertainties: ['No replay record was retrieved.'], sourceRefs: [] }), taskId: `fixture-profile-${frame.sequence}`, model: { provider: 'codex', name: 'gpt-6.1-sol', effort: replyEffort } }) + '\n');
      } else if (line.startsWith('DONE ')) done = JSON.parse(line.slice(5));
    }
    const code = await exited;
    return { code, stderr, requests, run: done ? JSON.parse(await readFile(done.runPath, 'utf8')) : null, trace: done ? JSON.parse(await readFile(done.tracePath, 'utf8')) : null };
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
}

test('protocol low profile accepts a matching fixture reply and persists the selected model', async () => {
  const { code, run, trace, requests } = await profileTrial({ provider: 'codex', name: 'gpt-6.1-sol', effort: 'low' });
  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(requests.length, 1);
  assert.deepEqual(run.model, { provider: 'codex', name: 'gpt-6.1-sol', effort: 'low' });
  assert.deepEqual(trace.model, run.model);
  assert.equal(JSON.parse(run.output).answer, 'Replay safety remains unverified.');
});

test('protocol low profile rejects a medium reply before accepting its answer', async () => {
  const { code, run } = await profileTrial({ provider: 'codex', name: 'gpt-6.1-sol', effort: 'low' }, 'medium');
  assert.equal(code, 0);
  assert.equal(run.status, 'error');
  assert.equal(run.observed.modelCalls, 1);
  assert.deepEqual(JSON.parse(run.output).uncertainties, ['invalid_host_binding']);
});

test('legacy protocol retains medium and accepts its matching fixture reply', async () => {
  const { code, run } = await profileTrial(undefined, 'medium');
  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.deepEqual(run.model, { provider: 'codex', name: 'gpt-6.1-sol', effort: 'medium' });
  assert.equal(JSON.parse(run.output).answer, 'Replay safety remains unverified.');
});

test('invalid protocol profiles fail before writing a generation request', async () => {
  for (const model of [null, { provider: 'codex', name: 'gpt-6.1-sol' }, { provider: '', name: 'gpt-6.1-sol', effort: 'low' }, { provider: 'codex', name: 'gpt-6.1-sol', effort: 'low', extra: true }]) {
    const { code, stderr, requests, run } = await profileTrial(model);
    assert.equal(code, 1);
    assert.match(stderr, /ZodError/);
    assert.equal(requests.length, 0);
    assert.equal(run, null);
  }
});
