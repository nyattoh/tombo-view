import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import * as sdk from '../dist/index.js';

const helper = resolve('skills/tombo-view/scripts/session.mjs');
const storePath = resolve('skills/tombo-view/scripts/session-store.mjs');
const budget = { maxRounds: 8, maxModelCalls: 12, maxToolCalls: 8, maxElapsedMs: 60000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 };
const packet = (extra = {}) => ({ schemaVersion: '0.1', taskId: 'bound-task', goal: 'Explain the actual runtime requirement.', mode: 'explain', successCriteria: ['Use the current requirement.'], proposedAnswer: 'Node 24 is required.', reflectionRequired: true, evidence: [], capabilities: ['read'], budget, ...extra });
const initial = { claims: [{ id: 'claim', role: 'answer_claim', text: 'Node 24 is required.', scope: 'project' }] };
async function harness(t, task = packet(), storage = '') {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-binding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, storage);
  await mkdir(data, { recursive: true });
  const ledger = join(data, 'sdk.jsonl'), state = join(data, 'state.json'), input = join(data, 'task.json');
  let sequence = 0;
  await writeFile(input, JSON.stringify(task));
  const json = async value => { const path = join(data, `input-${sequence++}.json`); await writeFile(path, JSON.stringify(value)); return path; };
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  const call = (...args) => { const output = run(...args); assert.equal(output.status, 0, output.stderr || output.stdout); return JSON.parse(output.stdout); };
  const activate = () => call('activate', '--input', input, '--ledger', ledger, '--out', state);
  async function apply(operation, proposal = initial, observations) {
    const args = operation === 'inspect' ? ['--input', input] : ['--state', state];
    if (observations) args.push('--observations', await json(observations));
    const prepared = call('prepare', ...args, ...operation === 'reflect' ? ['--operation', 'reflect'] : [], '--ledger', ledger);
    assert.ok(prepared.binding, JSON.stringify(prepared));
    const envelope = operation === 'reflect' ? { binding: prepared.binding, reflection: { binding: prepared.request.binding, reviewedClaimIds: prepared.request.state.claims.map(item => item.id), completion: 'completed', limitations: [], proposal } } : { binding: prepared.binding, proposal };
    return call(operation, ...args, '--proposal', await json(envelope), '--ledger', ledger, '--out', state);
  }
  return { dir, ledger, state, input, json, run, call, activate, apply, task };
}

test('activate pins workspace/task/ledger/out, seals SDK startedAt and never releases identity at ready', async t => {
  const h = await harness(t);
  const first = h.activate();
  assert.equal(first.mode, 'activated-session');
  assert.equal(first.session.binding.taskId, h.task.taskId);
  assert.equal(first.session.binding.startedAt, null);
  assert.equal(h.activate().session.binding.sessionId, first.session.binding.sessionId);
  const inspected = await h.apply('inspect');
  assert.equal(inspected.state.decision, 'needs_reflection');
  assert.equal(inspected.session.binding.startedAt, inspected.state.startedAt);
  const ready = await h.apply('reflect', {});
  assert.equal(ready.state.decision, 'ready_for_requested_step');
  assert.equal(ready.session.binding.sessionId, first.session.binding.sessionId);
  const again = h.run('inspect', '--input', h.input, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.json({}));
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(again.stderr).error.code, 'revision_conflict');
});

test('activated legacy commands reject omitted/changed ledger, changed out and edited state accounting', async t => {
  const h = await harness(t);
  h.activate();
  const first = await h.apply('inspect');
  for (const args of [[], ['--ledger', join(h.dir, 'another.jsonl')], ['--ledger', h.ledger, '--out', join(h.dir, 'another.json')]]) {
    const output = h.run('prepare', '--state', h.state, '--operation', 'reflect', ...args);
    assert.equal(output.status, 1);
    assert.equal(JSON.parse(output.stderr).error.code, 'revision_conflict');
  }
  for (const edited of [ { ...first.state, usage: { ...first.state.usage, modelCalls: 0 } }, { ...first.state, startedAt: new Date().toISOString() }, { ...first.state, task: { ...first.state.task, budget: { ...budget, maxElapsedMs: 900000 } } } ]) {
    const path = await h.json(edited);
    assert.equal(h.run('prepare', '--state', path, '--operation', 'reflect', '--ledger', h.ledger).status, 1);
  }
  const renamed = await h.json(packet({ taskId: 'renamed', proposedAnswer: 'A paraphrase.' }));
  assert.equal(h.run('activate', '--input', renamed, '--ledger', h.ledger, '--out', h.state).status, 1);
  assert.equal(h.run('prepare', '--input', renamed, '--ledger', join(h.dir, 'new.jsonl')).status, 1);
});

test('canonical path aliases preserve binding while cache absence is recovered from authorities', async t => {
  const h = await harness(t);
  const activated = h.activate();
  if (process.platform === 'win32') assert.equal(h.call('activate', '--input', h.input, '--ledger', h.ledger.toUpperCase(), '--out', h.state.toUpperCase()).session.binding.sessionId, activated.session.binding.sessionId);
  const first = await h.apply('inspect');
  const alias = h.call('activate', '--input', 'task.json', '--ledger', './sdk.jsonl', '--out', './state.json');
  assert.equal(alias.session.binding.sessionId, activated.session.binding.sessionId);
  await rm(join(h.dir, '.session', 'tombo-session.json'));
  await rm(h.state);
  const status = h.call('status');
  assert.equal(status.session.binding.startedAt, first.state.startedAt);
  assert.equal(status.state.revision, first.state.revision);
  assert.deepEqual(status.state.usage, first.state.usage);
  assert.equal(status.session.binding.sessionId, activated.session.binding.sessionId);
  const different = await h.json(packet({ budget: { ...budget, maxModelCalls: 40 } }));
  assert.equal(h.run('activate', '--input', different, '--ledger', h.ledger, '--out', h.state).status, 1);
});

test('session log rollback, cached-only identity, locks and ledger alias attacks fail closed', async t => {
  const h = await harness(t);
  h.activate();
  await h.apply('inspect');
  const originalLedger = await readFile(h.ledger, 'utf8');
  await h.apply('reflect', {});
  await writeFile(h.ledger, originalLedger);
  assert.equal(h.run('status').status, 1, 'A rolled-back SDK ledger must not revive old budget');
  const h2 = await harness(t);
  h2.activate();
  await rm(join(h2.dir, '.session', 'tombo-session.jsonl'));
  assert.equal(h2.run('activate', '--input', h2.input, '--ledger', h2.ledger, '--out', h2.state).status, 1, 'A cache is not activation authority');
  const h3 = await harness(t);
  h3.activate();
  await writeFile(join(h3.dir, '.session', 'tombo-session.jsonl.lock'), JSON.stringify({ pid: process.pid }));
  assert.equal(h3.run('status').status, 1, 'Live lock cannot be stolen');
  const h4 = await harness(t);
  await mkdir(join(h4.dir, 'target'));
  await symlink(join(h4.dir, 'target'), join(h4.dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const a = h4.call('activate', '--input', h4.input, '--ledger', join(h4.dir, 'target', 'sdk.jsonl'), '--out', h4.state);
  const b = h4.call('activate', '--input', h4.input, '--ledger', join(h4.dir, 'alias', 'sdk.jsonl'), '--out', h4.state);
  assert.equal(a.session.binding.sessionId, b.session.binding.sessionId);
});

test('public session transactions recover a committed SDK result and quarantine interrupted generation', async t => {
  const h = await harness(t);
  h.activate();
  const first = await h.apply('inspect');
  const { SessionStore } = await import(pathToFileURL(storePath).href);
  const store = new SessionStore(h.dir, sdk);
  await store.withLock(async () => {
    await store.load();
    await store.reconcile();
    await store.begin('reflect');
    const reflected = await sdk.createTombo({ adapter: { async generate() { throw new Error('unused'); } } }).reflect(first.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: ['claim'], completion: 'completed', limitations: [], proposal: {}, usage: { totalTokens: null, outputTokens: 0, costYen: null } }; } });
    await store.stage(reflected.state);
    await new sdk.FileJournal(h.ledger).commit(first.state.revision, reflected.state);
  });
  const recovered = h.call('status');
  assert.equal(recovered.state.decision, 'ready_for_requested_step');
  assert.equal(recovered.session.pendingOperation, null);
  assert.equal(recovered.state.usage.modelCalls, 2);
  await store.withLock(async () => { await store.load(); await store.reconcile(); await store.begin('reflect'); });
  const uncertain = h.call('status');
  assert.equal(uncertain.effectiveDecision, 'blocked');
  assert.equal(uncertain.session.accountingUncertain, true);
  assert.equal(uncertain.state.usage.modelCalls, recovered.state.usage.modelCalls);
  assert.equal(h.run('prepare', '--state', h.state, '--operation', 'reflect', '--ledger', h.ledger).status, 1);
});

test('prepared SDK commit is recovered before publication and a divergent direct SDK commit is refused', async t => {
  const h = await harness(t);
  h.activate();
  const first = await h.apply('inspect');
  const { SessionStore } = await import(pathToFileURL(storePath).href);
  const store = new SessionStore(h.dir, sdk);
  const api = sdk.createTombo({ adapter: { async generate() { throw new Error('unused'); } } });
  const critic = { async reflect(input) { return { binding: input.binding, reviewedClaimIds: ['claim'], completion: 'completed', limitations: [], proposal: {}, usage: { totalTokens: null, outputTokens: 0, costYen: null } }; } };
  const reflected = await api.reflect(first.state, critic);
  await store.withLock(async () => { await store.load(); await store.reconcile(); await store.begin('reflect'); await store.stage(reflected.state); });
  const recovered = h.call('status');
  assert.equal(recovered.state.revision, reflected.state.revision);
  assert.equal(recovered.state.usage.modelCalls, reflected.state.usage.modelCalls);
  assert.equal(recovered.session.pendingOperation, null);
  const divergent = await api.reflect(recovered.state, critic);
  await new sdk.FileJournal(h.ledger).commit(recovered.state.revision, divergent.state);
  assert.equal(h.run('status').status, 1, 'A direct SDK commit outside a prepared session transaction cannot be silently adopted');
});

test('session-only storage runs the real helper cycle without moving cwd or writing outside .session', async t => {
  const h = await harness(t, packet(), '.session');
  const activated = h.call('activate', '--input', '.session/task.json', '--ledger', '.session/sdk.jsonl', '--out', '.session/state.json');
  const lens = { id: 'lens', label: 'Runtime', rationale: 'Check the declared requirement.', origin: 'initial', status: 'active' };
  const first = await h.apply('inspect', { ...initial, lenses: [lens], gaps: [{ id: 'gap', lensId: 'lens', kind: 'unsupported_claim', question: 'What is required?', triggerRefs: ['claim'], whyItMatters: 'The setup advice depends on it.', importance: 'required', claimIds: ['claim'], probeIds: ['probe'] }], probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Read the configuration.', requiredCapability: 'read', sourceGroups: ['source'], successCondition: 'The minimum is 24.', refutationCondition: 'The minimum differs.', inconclusiveCondition: 'Unavailable.' }] });
  assert.equal(first.state.decision, 'needs_check');
  const source = join(h.dir, '.session', 'package.json');
  await writeFile(source, '{"engines":{"node":">=24"}}');
  const passage = await readFile(source, 'utf8');
  const evidence = { id: 'source', kind: 'code', locator: source, sourceGroup: 'source', retrievedAt: new Date().toISOString(), version: '1', scope: 'project', passage, contentHash: sdk.hashPassage(passage), validity: 'current' };
  await h.apply('update', { assessments: [{ claimId: 'claim', evidenceIds: ['source'], verdict: 'supports', scopeMatched: true, reason: 'The configuration explicitly requires 24.' }], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['source'], explanation: 'The actual configuration was read.' }] }, [{ executionId: 'read-config', probeId: 'probe', outcome: 'completed', evidence: [evidence], toolCalls: 1, elapsedMs: 1, costYen: null }]);
  const ready = await h.apply('reflect', {});
  assert.equal(ready.effectiveDecision, 'ready_for_requested_step');
  assert.equal(ready.state.usage.toolCalls, 1);
  assert.equal(ready.session.binding.sessionId, activated.session.binding.sessionId);
  const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
  assert.equal(report.status, 0, report.stderr);
  await writeFile(join(h.dir, '.session', 'report.md'), report.stdout);
  assert.match(report.stdout, /支持/);
  assert.deepEqual(await readdir(h.dir), ['.session']);
  assert.notEqual(ready.session.binding.ledger, join(h.dir, '.session', 'tombo-session.jsonl'));
  assert.equal((await sdk.replayJournal(h.ledger)).taskId, ready.state.taskId);
});

test('session-only nested storage and non-reserved similar names preserve canonical binding', async t => {
  const h = await harness(t, packet(), '.session/runs/one');
  const activated = h.activate();
  const alias = h.call('activate', '--input', h.input, '--ledger', '.session/runs/one/../one/sdk.jsonl', '--out', '.session/runs/one/state.json');
  assert.equal(alias.session.binding.sessionId, activated.session.binding.sessionId);
  if (process.platform === 'win32') assert.equal(h.call('activate', '--input', h.input, '--ledger', h.ledger.toUpperCase(), '--out', h.state.toUpperCase()).session.binding.sessionId, activated.session.binding.sessionId);
  await h.apply('inspect');
  assert.equal((await h.apply('reflect', {})).effectiveDecision, 'ready_for_requested_step');
  const other = await harness(t, packet(), '.session');
  const similar = other.call('activate', '--input', other.input, '--ledger', '.session/tombo-session-notes.jsonl', '--out', '.session/tombo-session.json.notes');
  assert.equal(similar.session.binding.startedAt, null);
  assert.deepEqual(await readdir(other.dir), ['.session']);
});

test('storage rejects specific authority, locks, cache temp namespaces and file parent collisions', async t => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const pairs = [
    ['.session/tombo-session.jsonl', '.session/state.json'], ['.session/sdk.jsonl', '.session/tombo-session.jsonl'],
    ['.session/tombo-session.json', '.session/state.json'], ['.session/sdk.jsonl', '.session/tombo-session.json'],
    ['.session/tombo-session.jsonl.lock', '.session/state.json'], ['.session/sdk.jsonl', '.session/tombo-session.jsonl.lock'],
    ['.session', '.session/state.json'], ['.session/sdk.jsonl', '.session'],
    ['.session/same', '.session/same'], ['.session/sdk', '.session/sdk.lock'], ['.session/state.lock', '.session/state'],
    ['.session/record', '.session/record/state.json'], ['.session/record/sdk.jsonl', '.session/record'],
    ['.session/tombo-session.json/child', '.session/state.json'], ['.session/sdk.jsonl', '.session/tombo-session.jsonl/child'],
    [`.session/tombo-session.json.${uuid}.tmp`, '.session/state.json'], [`.session/tombo-session.json.${uuid}.tmp/child`, '.session/state.json'],
    [`.session/state.json.${uuid}.tmp`, '.session/state.json'], ['.session/sdk.jsonl', `.session/tombo-session.json.${uuid}.tmp`],
  ];
  if (process.platform === 'win32') pairs.push(['.SESSION/TOMBO-SESSION.JSONL', '.session/state.json']);
  for (const [ledger, state] of pairs) {
    const h = await harness(t, packet(), '.session');
    const result = h.run('activate', '--input', h.input, '--ledger', ledger, '--out', state);
    assert.equal(result.status, 1, `${ledger} / ${state} must be rejected`);
    assert.equal((await readFile(h.input, 'utf8')), JSON.stringify(h.task));
    assert.equal((await readdir(join(h.dir, '.session'))).includes('tombo-session.jsonl'), false);
  }
});

test('storage preserves existing SDK locks and does not replace an activated ledger or cache', async t => {
  const fresh = await harness(t, packet(), '.session');
  await writeFile(`${fresh.ledger}.lock`, 'A pre-existing SDK lock.');
  assert.equal(fresh.run('activate', '--input', fresh.input, '--ledger', fresh.ledger, '--out', fresh.state).status, 1);
  assert.equal(await readFile(`${fresh.ledger}.lock`, 'utf8'), 'A pre-existing SDK lock.');
  const h = await harness(t, packet(), '.session');
  h.activate();
  const before = await h.apply('inspect');
  const ledgerBytes = await readFile(h.ledger, 'utf8');
  for (const args of [['--ledger', join(h.dir, '.session', 'new-sdk.jsonl')], ['--ledger', h.ledger, '--out', join(h.dir, '.session', 'new-state.json')]]) {
    assert.equal(h.run('prepare', '--state', h.state, '--operation', 'reflect', ...args).status, 1);
    assert.equal(await readFile(h.ledger, 'utf8'), ledgerBytes);
    assert.equal(h.call('status').session.binding.sessionId, before.session.binding.sessionId);
  }
  await rm(h.state);
  await rm(join(h.dir, '.session', 'tombo-session.json'));
  const restored = h.call('status');
  assert.equal(restored.state.startedAt, before.state.startedAt);
  assert.deepEqual(restored.state.usage, before.state.usage);
  assert.deepEqual(await readdir(h.dir), ['.session']);
});

test('storage transitions retain current and historical artifact and temp reservations even without cache files', async t => {
  const h = await harness(t, packet(), '.session/old');
  h.activate();
  await h.apply('inspect');
  const before = await h.apply('reflect', {});
  const makeChange = (prior, task) => {
    const passage = `Please change the task to: ${task.goal}`;
    return { task, reason: 'The user requested a different subject.', previousSessionId: prior.session.binding.sessionId, userChange: { id: `change-${task.taskId}`, kind: 'user_statement', locator: `conversation:${task.taskId}`, receivedAt: new Date().toISOString(), passage, contentHash: sdk.hashPassage(passage), previousGoal: prior.state.task.goal, newGoal: task.goal, previousSuccessCriteria: prior.state.task.successCriteria, newSuccessCriteria: task.successCriteria }, hand_over_summary: { unresolvedGapIds: [], unknowns: [] } };
  };
  const secondTask = packet({ taskId: 'licence', goal: 'Explain the licence.', successCriteria: ['Read the licence.'], proposedAnswer: 'The licence is MIT.' });
  const secondLedger = join(h.dir, '.session', 'current', 'sdk.jsonl'), secondState = join(h.dir, '.session', 'current', 'state.json');
  h.call('transition', '--input', await h.json(makeChange(before, secondTask)), '--ledger', secondLedger, '--out', secondState);
  const secondInput = await h.json(secondTask);
  const prepared = h.call('prepare', '--input', secondInput, '--ledger', secondLedger);
  const second = h.call('inspect', '--input', secondInput, '--ledger', secondLedger, '--out', secondState, '--proposal', await h.json({ binding: prepared.binding, proposal: { claims: [{ id: 'licence-claim', role: 'answer_claim', text: 'The licence is MIT.', scope: 'licence' }] } }));
  await rm(h.state);
  await rm(secondState);
  const nextTask = packet({ taskId: 'next-goal', goal: 'Explain the project packaging.', successCriteria: ['Read packaging metadata.'] });
  const request = await h.json(makeChange(second, nextTask));
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const ledgerBytes = await readFile(secondLedger, 'utf8');
  for (const candidate of [h.state, `${h.ledger}.lock`, `${h.state}.${uuid}.tmp`, secondState]) {
    const result = h.run('transition', '--input', request, '--ledger', candidate, '--out', join(h.dir, '.session', 'next-state.json'));
    assert.equal(result.status, 1, `Historical/current artifact must stay reserved: ${candidate}`);
    assert.equal(await readFile(secondLedger, 'utf8'), ledgerBytes);
  }
  const next = h.call('transition', '--input', request, '--ledger', '.session/next/sdk.jsonl', '--out', '.session/next/state.json');
  assert.equal(next.session.transitions.length, 2);
  assert.equal(next.session.transitions[0].previous.taskId, before.state.taskId);
  assert.deepEqual(next.session.transitions[1].previous.usage, second.state.usage);
});

test('session storage keeps safe directory aliases and ancestor binding detection', async t => {
  const h = await harness(t, packet(), '.session/records');
  const activated = h.activate();
  await symlink(join(h.dir, '.session', 'records'), join(h.dir, '.session', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const alias = h.call('activate', '--input', h.input, '--ledger', '.session/alias/sdk.jsonl', '--out', '.session/alias/state.json');
  assert.equal(alias.session.binding.sessionId, activated.session.binding.sessionId);
  const child = join(h.dir, '.session', 'child');
  await mkdir(child);
  const run = args => spawnSync(process.execPath, [helper, ...args], { cwd: child, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  for (const args of [['activate', '--input', h.input, '--ledger', h.ledger, '--out', h.state], ['prepare', '--input', h.input]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'revision_conflict');
  }
});

test('session-only storage keeps expired same-goal follow-up unassessed with original state and accounting', async t => {
  const h = await harness(t, packet({ budget: { ...budget, maxElapsedMs: 5000 } }), '.session');
  h.activate();
  await h.apply('inspect');
  const ready = await h.apply('reflect', {});
  await delay(Math.max(1, Date.parse(ready.state.startedAt) + h.task.budget.maxElapsedMs - Date.now() + 40));
  const receipt = await h.json({ id: 'late-followup', source: { kind: 'document', locator: 'conversation:followup', receivedAt: new Date().toISOString() }, text: 'A same-goal follow-up requiring reconsideration.' });
  const result = h.call('receive', '--input', receipt);
  assert.equal(result.effectiveDecision, 'blocked');
  assert.equal(result.state.stopReason, 'budget_exhausted');
  assert.equal(result.session.binding.sessionId, ready.session.binding.sessionId);
  assert.equal(result.state.startedAt, ready.state.startedAt);
  assert.deepEqual(result.state.task.budget, ready.state.task.budget);
  assert.deepEqual(result.state.claims, ready.state.claims);
  assert.deepEqual({ ...result.state.usage, elapsedMs: 0 }, { ...ready.state.usage, elapsedMs: 0 });
  assert.equal(result.session.pendingUpdates[0].status, 'received_unassessed');
  const escaped = await h.json(packet({ taskId: 'new-budget', budget: { ...budget, maxElapsedMs: 600000 } }));
  assert.equal(h.run('activate', '--input', escaped, '--ledger', '.session/escaped-sdk.jsonl', '--out', '.session/escaped-state.json').status, 1);
  assert.deepEqual(await readdir(h.dir), ['.session']);
});
