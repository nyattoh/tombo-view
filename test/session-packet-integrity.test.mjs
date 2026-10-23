import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as sdk from '../dist/index.js';

const helper = resolve('skills/tombo-view/scripts/session.mjs');
const storeModule = resolve(process.env.PR8_SESSION_STORE_MODULE ?? 'skills/tombo-view/scripts/session-store.mjs');
const { SessionStore } = await import(pathToFileURL(storeModule).href);
const { SessionStore: CurrentSessionStore } = await import(pathToFileURL(resolve('skills/tombo-view/scripts/session-store.mjs')).href);
const budget = { maxRounds: 8, maxModelCalls: 12, maxToolCalls: 8, maxElapsedMs: 60000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 };
const packet = (overrides = {}) => ({ schemaVersion: '0.1', taskId: 'packet-integrity', goal: 'Explain the declared runtime requirement.', mode: 'explain', successCriteria: ['Read the runtime requirement.'], proposedAnswer: 'Node 24 is required.', reflectionRequired: true, evidence: [], capabilities: ['read'], budget, ...overrides });
const evidence = (id, passage, overrides = {}) => ({ id, kind: 'document', locator: `local:${id}`, sourceGroup: 'source', retrievedAt: new Date().toISOString(), version: '1', scope: 'project', passage, contentHash: sdk.hashPassage(passage), validity: 'current', ...overrides });
const invalidPackets = () => [
  ['duplicate-evidence-ids', packet({ evidence: [evidence('duplicate', 'First passage.'), evidence('duplicate', 'Second passage.')] }), 'invalid_input'],
  ['passage-hash-mismatch', packet({ evidence: [evidence('mismatch', 'Authentic passage.', { contentHash: '0'.repeat(64) })] }), 'invalid_input'],
  ['unavailable-passage', packet({ evidence: [evidence('unavailable', '', { passageUnavailable: true })] }), 'invalid_input'],
  ['inspect-input-character-cap', packet({ budget: { ...budget, maxInputChars: 1 } }), 'input_too_large'],
];

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-packet-integrity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, ledger: join(dir, 'sdk.jsonl'), state: join(dir, 'state.json') };
}

function authorityFiles(dir, ledger, state) {
  return [join(dir, '.session', 'tombo-session.jsonl'), join(dir, '.session', 'tombo-session.json'), join(dir, '.session', 'tombo-session.jsonl.lock'), ledger, `${ledger}.lock`, state];
}

async function readBytes(paths) { return Promise.all(paths.map(path => readFile(path))); }
function changedSnapshotFields(before, after, prefix = '') {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) || Array.isArray(after)) return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [prefix];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => changedSnapshotFields(before[key], after[key], prefix ? `${prefix}.${key}` : key));
}

function exactSizePacket(overrides = {}) {
  let maxInputChars = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const task = packet({ ...overrides, budget: { ...budget, maxInputChars } });
    const actualLength = JSON.stringify(task).length;
    if (actualLength === maxInputChars) return task;
    maxInputChars = actualLength;
  }
  throw new Error('Could not construct an exact input-size boundary packet.');
}

async function managedHarness(t) {
  const root = await workspace(t), input = join(root.dir, 'task.json');
  const task = packet();
  await writeFile(input, JSON.stringify(task));
  let sequence = 0;
  const json = async value => {
    const path = join(root.dir, `input-${sequence++}.json`);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: root.dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  const call = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  call('activate', '--input', input, '--ledger', root.ledger, '--out', root.state);
  const prepared = call('prepare', '--input', input, '--ledger', root.ledger);
  const proposal = { claims: [{ id: 'runtime-claim', role: 'answer_claim', text: task.proposedAnswer, scope: 'project' }] };
  const proposalPath = await json({ binding: prepared.binding, proposal });
  call('inspect', '--input', input, '--ledger', root.ledger, '--out', root.state, '--proposal', proposalPath);
  return { ...root, task, input, json, run, call };
}

function transitionPacket(prior, task) {
  const passage = 'The user requested a different runtime topic.';
  return {
    task,
    reason: 'The user requested a different subject.',
    previousSessionId: prior.binding.sessionId,
    userChange: {
      id: 'integrity-transition-change', kind: 'user_statement', locator: 'conversation:integrity-change',
      receivedAt: new Date().toISOString(), passage, contentHash: sdk.hashPassage(passage),
      previousGoal: prior.task.goal, newGoal: task.goal,
      previousSuccessCriteria: prior.task.successCriteria, newSuccessCriteria: task.successCriteria,
    },
    hand_over_summary: { unresolvedGapIds: [], unknowns: [] },
  };
}

test('activation rejects structurally parsed but integrity-invalid packets before persistence', async t => {
  for (const [name, task, expectedCode] of invalidPackets()) await t.test(name, async t => {
    const h = await workspace(t), store = new SessionStore(h.dir, sdk);
    let storeCode = null;
    try {
      await store.withLock(async () => { await store.load(); await store.activate(task, h.ledger, h.state); });
    } catch (error) { storeCode = error.code ?? 'unknown'; }
    const present = authorityFiles(h.dir, h.ledger, h.state).map(path => existsSync(path));
    let inspectCode = null, apiCalls = 0;
    try {
      await sdk.createTombo({ adapter: { async generate() { apiCalls++; throw new Error('must not generate'); } } }).inspect(task);
    } catch (error) { inspectCode = error.code ?? 'unknown'; }
    t.diagnostic(JSON.stringify({ storeCode, expectedCode, inspectCode, apiCalls, authorityFileCount: present.filter(Boolean).length, snapshotAbsent: store.snapshot === null }));
    assert.equal(storeCode, expectedCode, 'store activation must reject with the SDK inspect integrity code');
    assert.equal(inspectCode, expectedCode, 'SDK inspect must reject this packet');
    assert.equal(apiCalls, 0, 'invalid packet must be rejected before adapter generation');
    assert.ok(present.every(value => !value), 'invalid activation must persist no journal, cache, lock or SDK artifact');
    assert.equal(store.snapshot, null, 'invalid activation must not leave an in-memory session or pending operation');
  });
});

test('direct transition rejects invalid packets without changing prior session, SDK or cache bytes', async t => {
  for (const [name, invalidTask, expectedCode] of invalidPackets()) await t.test(name, async t => {
    const h = await managedHarness(t), store = new CurrentSessionStore(h.dir, sdk);
    await store.withLock(async () => { await store.load(); await store.reconcile(); });
    const priorBinding = structuredClone(store.snapshot.binding), priorState = structuredClone(store.state);
    const paths = authorityFiles(h.dir, h.ledger, h.state).filter(path => existsSync(path));
    const before = await readBytes(paths);
    const nextTask = packet({ ...invalidTask, taskId: `next-${invalidTask.taskId}`, goal: 'Explain the next runtime requirement.', successCriteria: ['Read the next runtime requirement.'] });
    let storeCode = null;
    try {
      await store.withLock(() => store.transition(transitionPacket(store.snapshot, nextTask), join(h.dir, 'next-sdk.jsonl'), join(h.dir, 'next-state.json')));
    } catch (error) { storeCode = error.code ?? 'unknown'; }
    let inspectCode = null, apiCalls = 0;
    try {
      await sdk.createTombo({ adapter: { async generate() { apiCalls++; throw new Error('must not generate'); } } }).inspect(nextTask);
    } catch (error) { inspectCode = error.code ?? 'unknown'; }
    const after = await readBytes(paths);
    const authorityUnchanged = before.every((bytes, index) => bytes.equals(after[index]));
    t.diagnostic(JSON.stringify({ storeCode, expectedCode, inspectCode, apiCalls, authorityUnchanged, sameSessionId: store.snapshot.binding.sessionId === priorBinding.sessionId, sameStateRevision: store.state?.revision === priorState.revision }));
    assert.equal(storeCode, expectedCode, 'transition must reject before appending the new task');
    assert.equal(inspectCode, expectedCode, 'SDK inspect must reject this packet');
    assert.equal(apiCalls, 0, 'invalid packet must be rejected before adapter generation');
    assert.ok(authorityUnchanged, 'rejected transition must preserve previous session, SDK ledger and both caches byte-for-byte');
    assert.equal(store.snapshot.binding.sessionId, priorBinding.sessionId, 'rejection must preserve the current session identity');
    assert.equal(store.state?.revision, priorState.revision, 'rejection must preserve the current SDK state');
    assert.equal(store.snapshot.pendingOperation, null, 'rejection must leave no pending operation');
    assert.equal(store.snapshot.accountingUncertain, false, 'rejection must not manufacture accounting uncertainty');
  });
});

test('actual managed activation rejects invalid packets before creating authority', async t => {
  for (const [name, task, expectedCode] of invalidPackets()) await t.test(name, async t => {
    const h = await workspace(t), input = join(h.dir, 'invalid-task.json');
    await writeFile(input, JSON.stringify(task));
    const result = spawnSync(process.execPath, [helper, 'activate', '--input', input, '--ledger', h.ledger, '--out', h.state], { cwd: h.dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
    const code = result.status === 1 ? JSON.parse(result.stderr).error.code : null;
    const present = authorityFiles(h.dir, h.ledger, h.state).map(path => existsSync(path));
    t.diagnostic(JSON.stringify({ exitCode: result.status, code, expectedCode, authorityFileCount: present.filter(Boolean).length }));
    assert.equal(result.status, 1, 'managed activation must reject invalid packet');
    assert.equal(code, expectedCode, 'managed activation must surface the SDK integrity error');
    assert.ok(present.every(value => !value), 'managed invalid activation must create no session or SDK authority');
  });
});

test('actual managed transition distinguishes packet rejection from its preceding checkpoint bytes', async t => {
  for (const [name, invalidTask, expectedCode] of invalidPackets()) await t.test(name, async t => {
    const h = await managedHarness(t), store = new SessionStore(h.dir, sdk);
    await store.withLock(async () => { await store.load(); await store.reconcile(); });
    const prior = JSON.parse((await readFile(join(h.dir, '.session', 'tombo-session.jsonl'), 'utf8')).trimEnd().split('\n').at(-1)).snapshot;
    const nextTask = packet({ ...invalidTask, taskId: `managed-${invalidTask.taskId}`, goal: 'Explain the next runtime requirement.', successCriteria: ['Read the next runtime requirement.'] });
    const input = await h.json(transitionPacket(prior, nextTask));
    const artifacts = [
      ['sessionJournal', join(h.dir, '.session', 'tombo-session.jsonl')],
      ['sessionCache', join(h.dir, '.session', 'tombo-session.json')],
      ['sdkLedger', h.ledger],
      ['stateCache', h.state],
    ].filter(([, path]) => existsSync(path));
    const before = await readBytes(artifacts.map(([, path]) => path));
    const eventsBefore = (await readFile(join(h.dir, '.session', 'tombo-session.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const result = h.run('transition', '--input', input, '--ledger', join(h.dir, 'next-sdk.jsonl'), '--out', join(h.dir, 'next-state.json'));
    const code = result.status === 1 ? JSON.parse(result.stderr).error.code : null;
    const after = await readBytes(artifacts.map(([, path]) => path));
    const eventsAfter = (await readFile(join(h.dir, '.session', 'tombo-session.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const priorSnapshot = eventsBefore.at(-1).snapshot, latestSnapshot = eventsAfter.at(-1).snapshot;
    const changedArtifacts = artifacts.filter((item, index) => !before[index].equals(after[index])).map(([artifact]) => artifact).sort();
    const hashesBefore = Object.fromEntries(artifacts.map(([artifact], index) => [artifact, createHash('sha256').update(before[index]).digest('hex')]));
    const hashesAfter = Object.fromEntries(artifacts.map(([artifact], index) => [artifact, createHash('sha256').update(after[index]).digest('hex')]));
    let inspectCode = null, apiCalls = 0;
    try {
      await sdk.createTombo({ adapter: { async generate() { apiCalls++; throw new Error('must not generate'); } } }).inspect(nextTask);
    } catch (error) { inspectCode = error.code ?? 'unknown'; }
    const snapshotChanges = changedSnapshotFields(priorSnapshot, latestSnapshot);
    const sameBinding = JSON.stringify(latestSnapshot.binding) === JSON.stringify(priorSnapshot.binding);
    const sameTask = JSON.stringify(latestSnapshot.task) === JSON.stringify(priorSnapshot.task);
    const sameHead = JSON.stringify(latestSnapshot.head) === JSON.stringify(priorSnapshot.head);
    const sameTransitions = JSON.stringify(latestSnapshot.transitions) === JSON.stringify(priorSnapshot.transitions);
    const sameUpdates = JSON.stringify(latestSnapshot.updates) === JSON.stringify(priorSnapshot.updates);
    t.diagnostic(JSON.stringify({ exitCode: result.status, code, expectedCode, inspectCode, apiCalls, changedArtifacts, hashesBefore, hashesAfter, eventCountDelta: eventsAfter.length - eventsBefore.length, changedSnapshotFields: snapshotChanges, sameBinding, sameTask, sameHead, sameTransitions, sameUpdates, pendingOperation: latestSnapshot.pendingOperation, accountingUncertain: latestSnapshot.accountingUncertain }));
    assert.equal(result.status, 1, 'managed transition must reject the invalid packet');
    assert.equal(code, expectedCode, 'managed transition must return the matching SDK integrity error');
    assert.equal(inspectCode, expectedCode, 'SDK inspect must reject the same packet before generation');
    assert.equal(apiCalls, 0, 'packet validation must not call the adapter');
    assert.deepEqual(changedArtifacts, ['sessionCache', 'sessionJournal'], 'only the existing checkpoint observation may append session journal/cache');
    assert.equal(eventsAfter.length - eventsBefore.length, 1, 'the existing checkpoint contributes exactly one journal event');
    assert.ok(snapshotChanges.length === 0 || JSON.stringify(snapshotChanges) === '["lastObservedAt"]', 'checkpoint may only advance its observation time');
    assert.ok(sameBinding && sameTask && sameHead && sameTransitions && sameUpdates, 'invalid task must not alter the prior session, state head, or history');
    assert.equal(hashesBefore.sdkLedger, hashesAfter.sdkLedger, 'checkpoint must not alter the SDK ledger');
    assert.equal(hashesBefore.stateCache, hashesAfter.stateCache, 'checkpoint must not alter the SDK state cache');
    assert.equal(latestSnapshot.pendingOperation, null, 'rejection must leave no pending operation');
    assert.equal(latestSnapshot.accountingUncertain, false, 'rejection must not manufacture accounting uncertainty');
  });
});

test('actual managed transition accepts a genuine task at the exact inspect input-size cap', async t => {
  const h = await managedHarness(t), store = new CurrentSessionStore(h.dir, sdk);
  await store.withLock(async () => { await store.load(); await store.reconcile(); });
  const prior = JSON.parse((await readFile(join(h.dir, '.session', 'tombo-session.jsonl'), 'utf8')).trimEnd().split('\n').at(-1)).snapshot;
  const task = exactSizePacket({ taskId: 'exact-input-boundary', goal: 'Explain the next runtime requirement.', successCriteria: ['Read the next runtime requirement.'] });
  assert.equal(JSON.stringify(task).length, task.budget.maxInputChars, 'fixture must be exactly at the SDK inspect cap');
  const result = h.call('transition', '--input', await h.json(transitionPacket(prior, task)), '--ledger', join(h.dir, 'next-sdk.jsonl'), '--out', join(h.dir, 'next-state.json'));
  assert.equal(result.session.binding.taskId, task.taskId, 'a genuine transition at the exact input cap must commit');
  assert.equal(result.session.pendingOperation, null);
});
