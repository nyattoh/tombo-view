import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as sdk from '../dist/index.js';

const helper = resolve('skills/tombo-view/scripts/session.mjs');
const { SessionStore } = await import(pathToFileURL(resolve('skills/tombo-view/scripts/session-store.mjs')).href);
const budget = { maxRounds: 8, maxModelCalls: 12, maxToolCalls: 8, maxElapsedMs: 60000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 };
const packet = (overrides = {}) => ({ schemaVersion: '0.1', taskId: 'platform-contract', goal: 'Explain the current runtime requirement.', mode: 'explain', successCriteria: ['Use the current requirement.'], proposedAnswer: 'Node 24 is required.', reflectionRequired: true, evidence: [], capabilities: ['read'], budget, ...overrides });
const proposal = { claims: [{ id: 'claim', role: 'answer_claim', text: 'Node 24 is required.', scope: 'project' }] };

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-platform-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = join(dir, 'sdk.jsonl'), state = join(dir, 'state.json'), input = join(dir, 'task.json');
  await writeFile(input, JSON.stringify(packet()));
  let seq = 0;
  const json = async value => {
    const path = join(dir, `input-${seq++}.json`);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  const call = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  call('activate', '--input', input, '--ledger', ledger, '--out', state);
  const prepared = call('prepare', '--input', input, '--ledger', ledger);
  call('inspect', '--input', input, '--ledger', ledger, '--out', state, '--proposal', await json({ binding: prepared.binding, proposal }));
  return { dir, ledger, state, input, json, run, call };
}

function transitionFrom(prior, time) {
  const task = packet({ taskId: 'platform-transition', goal: 'Explain the updated runtime requirement.', successCriteria: ['Use the updated requirement.'] });
  const passage = 'Please update the task to explain the updated runtime requirement.';
  return {
    task,
    reason: 'The user requested a changed goal.',
    previousSessionId: prior.binding.sessionId,
    userChange: {
      id: 'user-change-platform', kind: 'user_statement', locator: 'conversation:platform-change', receivedAt: time,
      passage, contentHash: sdk.hashPassage(passage), previousGoal: prior.task.goal, newGoal: task.goal,
      previousSuccessCriteria: prior.task.successCriteria, newSuccessCriteria: task.successCriteria,
    },
    hand_over_summary: { unresolvedGapIds: [], unknowns: [] },
  };
}

async function bytes(path) { return readFile(path); }

test('workspace path spellings acquire the real lock while symlink redirection remains rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-path-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspaces = process.platform === 'win32'
    ? [
      [...dir].map((character, index) => /[a-z]/i.test(character) && index % 2 === 0 ? character.toUpperCase() : character).join('').replaceAll('\\', '/'),
      `\\\\?\\${dir}`,
    ]
    : [dir, `${dir}/.`];
  for (const workspace of workspaces) {
    const store = new SessionStore(workspace, sdk);
    assert.equal(await store.withLock(async () => 'locked'), 'locked', `canonical spelling must acquire a real filesystem lock: ${workspace}`);
  }
  const target = join(dir, 'target');
  const linked = join(dir, 'workspace-link');
  await mkdir(target);
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const redirected = new SessionStore(linked, sdk);
  await assert.rejects(redirected.withLock(async () => undefined), error => error.code === 'revision_conflict', 'real workspace redirection must remain rejected');
});

test('goal transition rejects non-canonical, impossible and over-skew dates without mutating either authority', async t => {
  const h = await harness(t);
  const store = new SessionStore(h.dir, sdk);
  await store.withLock(async () => { await store.load(); await store.reconcile(); });
  const prior = structuredClone(store.snapshot);
  const paths = [h.ledger, h.state, join(h.dir, '.session', 'tombo-session.jsonl'), join(h.dir, '.session', 'tombo-session.json')];
  const before = await Promise.all(paths.map(bytes));
  const invalidDates = [
    '2026-10-21',
    '2026-10-21T12:00:00',
    '2026-02-30T12:00:00Z',
    new Date(Date.now() + 60_000).toISOString(),
  ];
  for (const receivedAt of invalidDates) {
    await assert.rejects(store.withLock(() => store.transition(transitionFrom(prior, receivedAt), join(h.dir, 'next-sdk.jsonl'), join(h.dir, 'next-state.json'))), error => error.code === 'invalid_input', `transition must reject ${receivedAt}`);
    for (let index = 0; index < paths.length; index++) assert.deepEqual(await bytes(paths[index]), before[index], `authority changed after rejecting ${receivedAt}`);
    assert.equal(store.snapshot.binding.sessionId, prior.binding.sessionId);
    assert.equal(store.snapshot.binding.taskId, prior.binding.taskId);
    assert.equal(store.snapshot.head.revision, prior.head.revision);
    assert.equal(store.snapshot.transitions.length, prior.transitions.length);
  }
  const offsetFuture = new Date(Date.now() + 2000 + 60 * 60 * 1000).toISOString().replace('Z', '+01:00');
  await store.withLock(() => store.transition(transitionFrom(prior, offsetFuture), join(h.dir, 'next-sdk.jsonl'), join(h.dir, 'next-state.json')));
  assert.equal(store.snapshot.binding.taskId, 'platform-transition');
  assert.equal(store.snapshot.transitions.length, 1);
  assert.equal(store.snapshot.transitions[0].userChange.receivedAt, offsetFuture);
});
