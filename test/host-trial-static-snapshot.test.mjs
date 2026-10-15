import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { outputDigest } from '../evaluation/metacognition-runner.mjs';
import { recordedFixture } from './helpers/unknown-progress.mjs';

const digest = value => outputDigest(JSON.stringify(value));

async function trial({ policy = true, arm = 'tombo', mutate = () => {} } = {}) {
  const recording = await recordedFixture();
  const source = { id: 'next-05-src', capability: 'read_record', description: 'Read the recorded exporter coverage.', status: 'incomplete', text: recording.observations[0][0].evidence[0].passage };
  const cases = [{ id: 'next-05', task: recording.task.goal, context: recording.task.evidence[0].passage, draft: recording.task.proposedAnswer, capabilities: ['read_record'], sources: [source] }];
  const protocol = { version: policy ? 2 : 1, frozenBeforeResults: true, caseDigest: digest(cases), requested: { maxCalls: 6, maxOutputChars: 4000 } };
  if (policy) protocol.staticSnapshotPolicy = { version: 1, mode: 'immutable_case_records', records: [{ caseId: 'next-05', sourceId: source.id, recordDigest: digest(source) }] };
  mutate(protocol, cases);
  const directory = await mkdtemp(join(tmpdir(), 'tombo-host-static-'));
  const protocolPath = join(directory, 'protocol.json'), casesPath = join(directory, 'cases.json');
  await writeFile(protocolPath, JSON.stringify(protocol));
  await writeFile(casesPath, JSON.stringify(cases));
  const child = spawn(process.execPath, ['scripts/metacognition-host-trial.mjs', '--case', 'next-05', '--arm', arm, '--origin', 'fixture', '--cases', casesPath, '--protocol', protocolPath, '--out', join(directory, 'trial')]);
  let stderr = '', done, updateIndex = 0;
  const requests = [], mappedIds = new Map();
  child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('REQUEST ')) {
        const frame = JSON.parse(line.slice(8));
        const request = JSON.parse(await readFile(frame.path, 'utf8'));
        requests.push(request);
        let output;
        if (arm === 'baseline') output = requests.length <= 2 ? { action: 'read', sourceId: source.id } : { action: 'finish', decision: 'unknown', answer: 'C rows remain unknown.', uncertainties: ['C rows are not exported.'], sourceRefs: [source.id] };
        else if (request.stage === 'inspect') output = recording.proposals[0];
        else if (request.stage === 'update') {
          mappedIds.set(recording.observations[updateIndex][0].evidence[0].id, request.input.observations[0].evidence[0].id);
          let encoded = JSON.stringify(recording.proposals[++updateIndex]);
          for (const [previous, current] of mappedIds) encoded = encoded.replaceAll(previous, current);
          output = JSON.parse(encoded);
        } else output = { binding: request.input.binding, reviewedClaimIds: request.input.state.claims.map(c => c.id), completion: 'completed', limitations: [], proposal: {} };
        child.stdin.write(JSON.stringify({ sequence: frame.sequence, output: JSON.stringify(output), taskId: `fixture-static-${frame.sequence}`, model: { provider: 'codex', name: 'gpt-6.1-sol', effort: 'medium' } }) + '\n');
      } else if (line.startsWith('DONE ')) done = JSON.parse(line.slice(5));
    }
    const code = await exited;
    return { code, stderr, requests, protocol, source, run: done ? JSON.parse(await readFile(done.runPath, 'utf8')) : null, trace: done ? JSON.parse(await readFile(done.tracePath, 'utf8')) : null, result: done ? JSON.parse(await readFile(done.resultPath, 'utf8')) : null };
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
}

test('explicit immutable record policy binds real SDK observations and retains unknown on no progress', async () => {
  const { code, stderr, requests, protocol, source, run, trace, result } = await trial();
  assert.equal(code, 0, stderr);
  assert.equal(run.status, 'success');
  assert.deepEqual(requests.map(r => r.stage), ['inspect', 'update', 'update']);
  const state = result.result.state;
  assert.equal(state.stopReason, 'no_progress');
  assert.equal(state.decision, 'blocked');
  assert.equal(state.probes[0].status, 'exhausted');
  assert.equal(state.claims[0].status, 'unverified');
  assert.equal(state.gaps[0].status, 'open');
  assert.equal(JSON.parse(run.output).decision, 'unknown');
  assert.equal(run.observed.calls, 5);
  assert.equal(run.observed.modelCalls, 3);
  assert.equal(run.observed.cost, 'UNKNOWN');
  assert.equal(state.usage.toolCalls, 2);
  assert.equal(state.usage.rounds, 2);
  const observations = requests.filter(r => r.stage === 'update').map(r => r.input.observations[0]);
  const expected = `case-record:${digest([protocol.caseDigest, 'next-05', source.id, digest(source)])}`;
  assert.deepEqual(observations.map(o => o.staticSnapshot), [expected, expected]);
  assert.equal(new Set(observations.map(o => o.executionId)).size, 2);
  assert.equal(new Set(observations.map(o => o.evidence[0].id)).size, 2);
  assert.deepEqual(observations.map(o => [o.evidence[0].passage, o.toolCalls, o.costYen]), [[source.text, 1, null], [source.text, 1, null]]);
  assert.deepEqual(trace.methodConfiguration.staticSnapshotPolicy, protocol.staticSnapshotPolicy);
  assert.deepEqual(trace.events.filter(e => e.kind === 'tool').map(e => e.staticSnapshot), [expected, expected]);
  assert.deepEqual(state.appliedExecutions.map(e => e.staticSnapshot.id), [expected, expected]);
});

test('legacy protocols omit declarations and retain the original budget stop and accounting', async () => {
  for (const version of [1, 2]) {
    const { code, run, result, trace, requests } = await trial({ policy: false, mutate: protocol => { protocol.version = version; } });
    assert.equal(code, 0);
    assert.equal(run.status, 'error');
    assert.equal(result.result.state.stopReason, 'budget_exhausted');
    assert.equal(run.observed.calls, 5);
    assert.equal(run.observed.modelCalls, 3);
    assert.equal(run.checks.length, 2);
    assert.equal(Object.hasOwn(trace.methodConfiguration, 'staticSnapshotPolicy'), false);
    assert.equal(requests.filter(r => r.stage === 'update').every(r => !Object.hasOwn(r.input.observations[0], 'staticSnapshot')), true);
    assert.equal(JSON.parse(run.output).decision, 'unknown');
  }
});

test('both arms retrieve the same physical records and retain declared capabilities', async () => {
  const baseline = await trial({ arm: 'baseline' });
  const tombo = await trial();
  assert.equal(baseline.run.status, 'success');
  assert.deepEqual(baseline.run.checks, tombo.run.checks);
  assert.deepEqual(baseline.requests[0].packet, tombo.requests[0].packet);
  assert.deepEqual(baseline.run.requested, tombo.run.requested);
  assert.deepEqual(baseline.trace.events.filter(e => e.kind === 'tool').map(e => e.response), tombo.trace.events.filter(e => e.kind === 'tool').map(e => e.response));
  assert.equal(baseline.run.observed.calls, 5);
  assert.equal(baseline.run.observed.cost, 'UNKNOWN');
});

test('invalid snapshot policies fail before generation dispatch', async () => {
  const mutations = [
    p => { p.version = 1; },
    p => { p.frozenBeforeResults = 1; },
    p => { p.staticSnapshotPolicy = null; },
    p => { p.staticSnapshotPolicy.extra = true; },
    p => { p.staticSnapshotPolicy.mode = 'automatic'; },
    p => { p.staticSnapshotPolicy.version = 2; },
    p => { p.staticSnapshotPolicy.records = []; },
    p => { p.staticSnapshotPolicy.records[0].recordDigest = '0'.repeat(64); },
    p => { p.staticSnapshotPolicy.records[0].sourceId = 'missing'; },
    p => { p.staticSnapshotPolicy.records[0].caseId = 'missing'; },
    p => { p.staticSnapshotPolicy.records.push(p.staticSnapshotPolicy.records[0]); },
    (p, cases) => { cases[0].sources[0].capability = 'mechanical_check'; p.caseDigest = digest(cases); p.staticSnapshotPolicy.records[0].recordDigest = digest(cases[0].sources[0]); },
    (p, cases) => { cases[0].sources[0].status = 'unavailable'; p.caseDigest = digest(cases); p.staticSnapshotPolicy.records[0].recordDigest = digest(cases[0].sources[0]); },
    (p, cases) => { cases[0].sources[0].status = 'invalid'; p.caseDigest = digest(cases); p.staticSnapshotPolicy.records[0].recordDigest = digest(cases[0].sources[0]); },
    (p, cases) => { cases[0].sources[0].text = ' '; p.caseDigest = digest(cases); p.staticSnapshotPolicy.records[0].recordDigest = digest(cases[0].sources[0]); },
    (p, cases) => { cases[0].sources[0].text = 1; p.caseDigest = digest(cases); p.staticSnapshotPolicy.records[0].recordDigest = digest(cases[0].sources[0]); },
    (p, cases) => { cases.push(structuredClone(cases[0])); p.caseDigest = digest(cases); },
    (p, cases) => { cases[0].sources[0].text += ' New content.'; },
  ];
  for (const mutate of mutations) {
    const { code, stderr, requests, run } = await trial({ mutate });
    assert.equal(code, 1, stderr);
    assert.match(stderr, /Static snapshot policy|ZodError|Invalid immutable case record binding|Frozen dataset mismatch/);
    assert.deepEqual(requests, []);
    assert.equal(run, null);
  }
});


test('a newly frozen record version gets a distinct snapshot binding even with the same text', async () => {
  const original = await trial();
  const changed = await trial({ mutate: (protocol, cases) => {
    cases[0].sources[0].description = 'A separately frozen record version.';
    protocol.caseDigest = digest(cases);
    protocol.staticSnapshotPolicy.records[0].recordDigest = digest(cases[0].sources[0]);
  } });
  assert.equal(changed.run.status, 'success');
  assert.equal(changed.result.result.state.stopReason, 'no_progress');
  assert.deepEqual(changed.run.checks, original.run.checks);
  assert.notEqual(changed.trace.events.find(e => e.kind === 'tool').staticSnapshot, original.trace.events.find(e => e.kind === 'tool').staticSnapshot);
});

test('a policy for another record does not declare the selected source immutable', async () => {
  const { run, result, requests, trace } = await trial({ mutate: (protocol, cases) => {
    cases.push({ ...structuredClone(cases[0]), id: 'another-case' });
    protocol.caseDigest = digest(cases);
    protocol.staticSnapshotPolicy.records[0].caseId = 'another-case';
  } });
  assert.equal(run.status, 'error');
  assert.equal(result.result.state.stopReason, 'budget_exhausted');
  assert.equal(requests.filter(r => r.stage === 'update').every(r => !Object.hasOwn(r.input.observations[0], 'staticSnapshot')), true);
  assert.equal(trace.events.filter(e => e.kind === 'tool').every(e => !Object.hasOwn(e, 'staticSnapshot')), true);
  assert.equal(run.checks.length, 2);
});
