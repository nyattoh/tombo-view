import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import * as sdk from '../dist/index.js';

const helper = resolve('skills/tombo-view/scripts/session.mjs');
const budget = { maxRounds: 8, maxModelCalls: 16, maxToolCalls: 10, maxElapsedMs: 60000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 };
const packet = extra => ({ schemaVersion: '0.1', taskId: 'followup', goal: 'Check the project runtime requirement.', mode: 'explain', successCriteria: ['Use actual configuration.'], reflectionRequired: true, proposedAnswer: 'Node 24 is the minimum.', evidence: [], capabilities: ['read', 'receive_user_answer'], budget, ...extra });
const initial = { claims: [{ id: 'claim', role: 'answer_claim', text: 'Node 24 is the minimum.', scope: 'project' }], lenses: [{ id: 'lens', label: 'Requirement', rationale: 'Check the source.', origin: 'initial', status: 'active' }], gaps: [{ id: 'gap', lensId: 'lens', kind: 'unsupported_claim', question: 'What is the minimum?', triggerRefs: ['claim'], whyItMatters: 'The advice depends on it.', importance: 'required', claimIds: ['claim'], probeIds: ['probe'] }], probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Read the source.', requiredCapability: 'read', sourceGroups: ['source'], successCondition: 'Minimum is 24.', refutationCondition: 'Minimum differs.', inconclusiveCondition: 'Unavailable.' }] };
const evidence = (id, passage, extra = {}) => ({ id, kind: 'document', locator: `local:${id}`, sourceGroup: 'source', retrievedAt: new Date().toISOString(), version: '1', scope: 'project', passage, contentHash: sdk.hashPassage(passage), validity: 'current', ...extra });
const observation = (executionId, ev, extra = {}) => ({ executionId, probeId: 'probe', outcome: 'completed', evidence: [ev], toolCalls: 1, elapsedMs: 2, costYen: null, ...extra });
const assessment = (id, verdict = 'supports') => ({ claimId: 'claim', evidenceIds: [id], verdict, scopeMatched: true, reason: 'The current source determines the requirement.' });
const receipt = (id, text, observations = []) => ({ id, source: { kind: 'document', locator: `conversation:${id}`, receivedAt: new Date().toISOString() }, text, observations });
async function harness(t, task = packet({}), taskClock, seed = !!taskClock) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-followup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = join(dir, 'sdk.jsonl'), state = join(dir, 'state.json'), input = join(dir, 'task.json');
  let sequence = 0;
  await writeFile(input, JSON.stringify(task));
  const json = async value => { const path = join(dir, `input-${sequence++}.json`); await writeFile(path, JSON.stringify(value)); return path; };
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  const call = (...args) => { const output = run(...args); assert.equal(output.status, 0, output.stderr || output.stdout); return JSON.parse(output.stdout); };
  async function prepared(operation, observations) {
    const args = operation === 'inspect' ? ['--input', input] : ['--state', state];
    if (observations) args.push('--observations', await json(observations));
    return { args, value: call('prepare', ...args, ...operation === 'reflect' ? ['--operation', 'reflect'] : [], '--ledger', ledger) };
  }
  async function envelope(operation, prepared, proposal) {
    return json(operation === 'reflect' ? { binding: prepared.binding, reflection: { binding: prepared.request.binding, reviewedClaimIds: prepared.request.state.claims.map(item => item.id), completion: 'completed', limitations: [], proposal } } : { binding: prepared.binding, proposal });
  }
  async function apply(operation, proposal, observations, extra = []) {
    const { args, value } = await prepared(operation, observations);
    assert.ok(value.binding, JSON.stringify(value));
    return call(operation, ...args, '--ledger', ledger, '--out', state, '--proposal', await envelope(operation, value, proposal), ...extra);
  }
  if (seed) {
    const { SessionStore } = await import(pathToFileURL(resolve('skills/tombo-view/scripts/session-store.mjs')).href);
    const store = new SessionStore(dir, sdk);
    await store.withLock(async () => { await store.load(); await store.activate(task, ledger, state, taskClock); if (typeof seed === 'function') await seed(store); });
  }
  const activation = seed ? call('status') : call('activate', '--input', input, '--ledger', ledger, '--out', state);
  return { dir, ledger, state, input, task, json, run, call, prepared, envelope, apply, activation };
}

const cappedBudget = { ...budget, maxCostYen: 10 };
// Legacy fixture only: an SDK adapter with an estimator seeds a valid head that the helper's own adapters cannot extend.
const sealedInspect = task => async store => {
  const result = await sdk.createTombo({ adapter: { estimateMaxCostYen: () => 0, async generate() { return { proposal: initial, usage: { totalTokens: null, outputTokens: 0, costYen: 0 } }; } } }).inspect(task);
  await store.begin('inspect');
  await store.commit(result.state);
};
const authority = h => Promise.all([join(h.dir, '.session', 'tombo-session.jsonl'), join(h.dir, '.session', 'tombo-session.json'), h.ledger, h.state].map(path => readFile(path, 'utf8').catch(() => null)));
const listing = async dir => (await readdir(dir, { recursive: true })).sort();
const certain = result => { assert.equal(result.session.pendingOperation, null); assert.equal(result.session.accountingUncertain, false); };
async function rejectedWithout(h, args, code) {
  const before = await authority(h), files = await listing(h.dir);
  const result = h.run(...args);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(JSON.parse(result.stderr).error.code, code);
  assert.deepEqual(await authority(h), before, 'the rejection must not append to the session journal or rewrite its cache, SDK ledger or state');
  assert.deepEqual(await listing(h.dir), files, 'the rejection must create no session, lock, SDK ledger or state artifact');
}
function goalChange(current, previous, task) {
  const passage = `Change the task: ${task.goal}`;
  return { task, reason: 'The user changed the requested subject.', previousSessionId: current.session.binding.sessionId, userChange: { id: `change-${task.taskId}`, kind: 'user_statement', locator: `conversation:change-${task.taskId}`, receivedAt: new Date().toISOString(), passage, contentHash: sdk.hashPassage(passage), previousGoal: previous.goal, newGoal: task.goal, previousSuccessCriteria: previous.successCriteria, newSuccessCriteria: task.successCriteria }, hand_over_summary: { unresolvedGapIds: current.state?.gaps.filter(gap => gap.status !== 'resolved').map(gap => gap.id) ?? [], unknowns: ['The previous goal remains unresolved.'] } };
}
function sameGoalRecovery(current, previous, task, transitionId) {
  const passage = 'The user requests recovery of the same goal under a new task ID after removing unsupported maxCostYen. The legacy SDK state was not generated, so prior total SDK usage is unknown.';
  return {
    task,
    reason: 'The user requested recovery of the same goal without the unsupported monetary cap.',
    previousSessionId: current.session.binding.sessionId,
    userChange: {
      id: transitionId,
      kind: 'user_statement',
      locator: `conversation:${transitionId}`,
      receivedAt: new Date().toISOString(),
      passage,
      contentHash: sdk.hashPassage(passage),
      previousGoal: previous.goal,
      newGoal: task.goal,
      previousSuccessCriteria: previous.successCriteria,
      newSuccessCriteria: task.successCriteria,
    },
    hand_over_summary: {
      unresolvedGapIds: [],
      unknowns: ['The legacy SDK state was not generated.', 'Prior total SDK usage is unknown.', 'Any pending receipts remain unassessed and archived.'],
    },
  };
}
const nextGoal = taskId => packet({ taskId, goal: 'Explain the packaging licence instead.', successCriteria: ['Read the licence terms.'] });

test('fresh managed activation with an unsupported monetary cap leaves no authority and the same goal activates with the corrected budget', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-cost-cap-activate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = join(dir, 'sdk.jsonl'), state = join(dir, 'state.json'), capped = join(dir, 'capped.json'), corrected = join(dir, 'corrected.json');
  await writeFile(capped, JSON.stringify(packet({ budget: { ...budget, maxCostYen: 10 } })));
  await writeFile(corrected, JSON.stringify(packet({})));
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  const rejected = run('activate', '--input', capped, '--ledger', ledger, '--out', state);
  const artifacts = (await readdir(dir, { recursive: true })).sort();
  const retried = run('activate', '--input', corrected, '--ledger', ledger, '--out', state);
  t.diagnostic(JSON.stringify({ rejectedStatus: rejected.status, rejectedError: rejected.stderr.trim(), artifactsAfterRejection: artifacts, retriedStatus: retried.status, retriedError: retried.stderr.trim() }));

  assert.equal(rejected.status, 1, 'activation must reject a maxCostYen the managed adapters cannot estimate');
  assert.equal(JSON.parse(rejected.stderr).error.code, 'budget_accounting_unavailable');
  assert.deepEqual(artifacts, ['capped.json', 'corrected.json'], 'the rejected activation must create no session directory, lock, journal, cache, SDK ledger or state file');

  assert.equal(retried.status, 0, retried.stderr);
  const activated = JSON.parse(retried.stdout);
  assert.equal(activated.session.binding.taskId, 'followup');
  assert.deepEqual(activated.session.binding.budget, budget, 'the corrected same-goal budget omits maxCostYen');
  assert.equal(activated.session.pendingOperation, null);
  assert.equal(activated.session.accountingUncertain, false);
});

test('unsupported managed monetary cap rejects before opening an operation and leaves the session usable', async t => {
  const task = packet({ budget: { ...budget, maxCostYen: 10 } });
  // CLI activation rejects this cap; seed the already-sealed legacy session directly.
  const h = await harness(t, task, undefined, true);
  const { args, value } = await h.prepared('inspect');
  const rejected = h.run('inspect', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('inspect', value, initial));

  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'budget_accounting_unavailable');

  const persisted = (await readFile(join(h.dir, '.session', 'tombo-session.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(persisted.every(event => event.snapshot.pendingOperation === null), 'no pending operation may be appended before unsupported-cost rejection');
  assert.ok(persisted.every(event => event.snapshot.accountingUncertain === false), 'rejection must not persist uncertain accounting');

  const status = h.call('status');
  assert.equal(status.session.pendingOperation, null, 'failed preflight must not leave an operation to reconcile');
  assert.equal(status.session.accountingUncertain, false, 'no proposal consumption means the session remains certain');

  const received = h.call('receive', '--input', await h.json(receipt('after-unsupported-cost-cap', 'A follow-up can still be received.')), '--ledger', h.ledger);
  assert.equal(received.session.pendingOperation, null);
  assert.equal(received.session.accountingUncertain, false);
  assert.equal(received.session.pendingUpdates.length, 1, 'normal session operations remain available after the rejected inspect');
});

test('legacy capped session with SDK state keeps reads, receipts and invalidation while generation rejects before begin', async t => {
  const source = evidence('legacy-source', 'Minimum is 24.');
  const capped = packet({ evidence: [source], budget: cappedBudget });
  const h = await harness(t, capped, undefined, sealedInspect(capped));
  assert.ok(h.activation.state, 'the legacy fixture has a committed SDK head');
  const sealed = result => { assert.equal(result.session.binding.sessionId, h.activation.session.binding.sessionId); assert.deepEqual(result.session.binding.budget, cappedBudget); certain(result); };
  sealed(h.activation);
  await t.test('activate replays the sealed capped task', () => sealed(h.call('activate', '--input', h.input, '--ledger', h.ledger, '--out', h.state)));
  await t.test('activate with a corrected budget cannot replace the sealed budget', async () => rejectedWithout(h, ['activate', '--input', await h.json(packet({ evidence: [source] })), '--ledger', h.ledger, '--out', h.state], 'revision_conflict'));
  await t.test('status remains available', () => sealed(h.call('status')));
  await t.test('report remains available', () => {
    const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /旧理解のスナップショット/);
  });
  await t.test('receive remains available', async () => {
    const received = h.call('receive', '--input', await h.json(receipt('legacy-followup', 'A follow-up for the capped session.')));
    sealed(received);
    assert.equal(received.session.pendingUpdates.length, 1);
  });
  for (const operation of ['update', 'reflect']) await t.test(`${operation} prepares but its generation rejects before begin`, async () => {
    const { args, value } = await h.prepared(operation, operation === 'update' ? [observation('legacy-read', evidence('legacy-read-source', 'Minimum is 24.'), { costYen: 0 })] : undefined);
    assert.ok(value.binding, JSON.stringify(value));
    sealed(value);
    await rejectedWithout(h, [operation, ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope(operation, value, {})], 'budget_accounting_unavailable');
  });
  await t.test('inspect stays closed after the task started', async () => rejectedWithout(h, ['inspect', '--input', h.input, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.json({})], 'revision_conflict'));
  await t.test('invalidate remains a non-generating transaction', async () => {
    const withdrawn = h.call('invalidate', '--state', h.state, '--input', await h.json({ evidenceIds: [source.id], reason: 'The legacy source was withdrawn.' }), '--ledger', h.ledger);
    sealed(withdrawn);
    assert.equal(withdrawn.state.evidence.find(item => item.id === source.id).validity, 'withdrawn');
  });
  await t.test('checkpoint with unknown pending cost records the existing SDK accounting stop', async () => {
    const received = h.call('receive', '--input', await h.json(receipt('unknown-cost', 'A check with unknown cost.', [observation('unknown-cost-read', evidence('unknown-cost-source', 'Minimum is 24.'))])));
    sealed(received);
    assert.equal(received.budgetCheckpoint.accountingUnavailable, true);
    assert.equal(received.state.stopReason, 'budget_accounting_unavailable');
  });
  await t.test('transition to a cap-free new goal is available', async () => {
    const moved = h.call('transition', '--input', await h.json(goalChange(h.call('status'), capped, nextGoal('legacy-cap-free'))), '--ledger', join(h.dir, 'next-sdk.jsonl'), '--out', join(h.dir, 'next-state.json'));
    assert.equal(moved.session.binding.taskId, 'legacy-cap-free');
    assert.deepEqual(moved.session.binding.budget, budget);
    assert.deepEqual(moved.session.transitions.at(-1).previous.budget, cappedBudget, 'the sealed capped budget is archived unchanged');
    certain(moved);
  });
});

test('legacy capped session without SDK state keeps reads and receipts and refuses transition without new artifacts', async t => {
  const capped = packet({ budget: cappedBudget });
  const h = await harness(t, capped, undefined, true);
  const sealed = result => { assert.equal(result.session.binding.sessionId, h.activation.session.binding.sessionId); assert.deepEqual(result.session.binding.budget, cappedBudget); assert.equal(result.state, null); certain(result); };
  await t.test('status remains available', () => sealed(h.call('status')));
  await t.test('report remains available', () => {
    const report = h.run('report', '--ledger', h.ledger);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /SDK理解スナップショットは未生成/);
  });
  await t.test('prepare remains available', () => {
    const prepared = h.call('prepare', '--input', h.input, '--ledger', h.ledger);
    assert.ok(prepared.binding, JSON.stringify(prepared));
    sealed(prepared);
  });
  await t.test('receive remains available', async () => {
    const received = h.call('receive', '--input', await h.json(receipt('null-state-followup', 'A follow-up before any inspect.')));
    sealed(received);
    assert.equal(received.session.pendingUpdates.length, 1);
  });
  await t.test('transition without SDK state keeps the existing refusal', async t => {
    const input = await h.json(goalChange(h.call('status'), capped, nextGoal('null-state-next')));
    const files = await listing(h.dir), events = (await authority(h))[0].trimEnd().split('\n').length;
    const refused = h.run('transition', '--input', input, '--ledger', join(h.dir, 'next-sdk.jsonl'), '--out', join(h.dir, 'next-state.json'));
    t.diagnostic(JSON.stringify({ status: refused.status, error: refused.stderr.trim(), journalEventDelta: (await authority(h))[0].trimEnd().split('\n').length - events }));
    assert.equal(refused.status, 1, refused.stdout);
    assert.equal(JSON.parse(refused.stderr).error.code, 'revision_conflict');
    assert.deepEqual(await listing(h.dir), files, 'the refusal creates no new SDK ledger, state cache or lock');
    const after = h.call('status');
    sealed(after);
    assert.equal(after.session.transitions.length, 0);
  });
});

test('legacy capped session without SDK state can transition the same goal to a new cap-free task without inventing usage', async t => {
  const capped = packet({ budget: cappedBudget });
  const h = await harness(t, capped, undefined, true);
  assert.equal(h.activation.state, null, 'the pre-fix fixture has no SDK state');
  assert.equal(await readFile(h.ledger, 'utf8').catch(() => null), null, 'the pre-fix fixture has no SDK ledger');
  assert.equal(await readFile(h.state, 'utf8').catch(() => null), null, 'the pre-fix fixture has no SDK state cache');

  const correctedInput = await h.json(packet({ budget }));
  await rejectedWithout(h, ['activate', '--input', correctedInput, '--ledger', h.ledger, '--out', h.state], 'revision_conflict');

  const received = h.call('receive', '--input', await h.json(receipt('legacy-unassessed-receipt', 'The same goal needs another source check.')));
  const archivedReceipt = structuredClone(received.session.pendingUpdates[0]);
  assert.equal(archivedReceipt.status, 'received_unassessed');

  const recoveryBudget = { ...cappedBudget };
  delete recoveryBudget.maxCostYen;
  const recoveryTask = packet({ taskId: 'recovered-followup', budget: recoveryBudget });
  const current = h.call('status');
  const passage = 'Please recover the same goal with a new task ID after removing the unsupported maxCostYen cap. Prior SDK usage is unknown, and the pending receipt remains unassessed.';
  const transition = {
    task: recoveryTask,
    reason: 'The user requested recovery of the same goal without the unsupported monetary cap.',
    previousSessionId: current.session.binding.sessionId,
    userChange: {
      id: 'change-recovered-followup',
      kind: 'user_statement',
      locator: 'conversation:change-recovered-followup',
      receivedAt: new Date().toISOString(),
      passage,
      contentHash: sdk.hashPassage(passage),
      previousGoal: capped.goal,
      newGoal: recoveryTask.goal,
      previousSuccessCriteria: capped.successCriteria,
      newSuccessCriteria: recoveryTask.successCriteria,
    },
    hand_over_summary: {
      unresolvedGapIds: [],
      unknowns: [
        'The legacy SDK state was not generated.',
        'Prior total SDK usage is unknown.',
        'The pending receipt remains unassessed and archived.',
      ],
    },
  };
  const nextLedger = join(h.dir, 'recovered-sdk.jsonl'), nextState = join(h.dir, 'recovered-state.json');
  const result = h.run('transition', '--input', await h.json(transition), '--ledger', nextLedger, '--out', nextState);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const recovered = JSON.parse(result.stdout);
  assert.equal(recovered.session.binding.taskId, recoveryTask.taskId);
  assert.deepEqual(recovered.session.binding.budget, recoveryBudget);
  assert.notEqual(recovered.session.binding.sessionId, current.session.binding.sessionId);
  assert.equal(recovered.state, null);
  assert.equal(recovered.session.pendingOperation, null);
  assert.equal(recovered.session.accountingUncertain, false);
  assert.equal(await readFile(nextLedger, 'utf8').catch(() => null), null, 'recovery must not invent an SDK ledger');
  assert.equal(await readFile(nextState, 'utf8').catch(() => null), null, 'recovery must not invent an SDK state cache');

  const report = h.run('report', '--ledger', nextLedger);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /## 旧セッションのアーカイブ済み復旧履歴/);
  assert.match(report.stdout, /Prior total SDK usage is unknown\./);
  assert.match(report.stdout, /legacy-unassessed-receipt[^\r\n]*received\\_unassessed/);
  const currentPendingSection = report.stdout.split('## 受領済み・未評価')[1]?.split(/\r?\n## /)[0] ?? '';
  assert.match(report.stdout, /## 受領済み・未評価/);
  assert.doesNotMatch(currentPendingSection, /legacy-unassessed-receipt/);
  assert.match(currentPendingSection, /未評価の追補はない/);

  const archived = recovered.session.transitions.at(-1).previous;
  assert.deepEqual({
    sessionId: archived.sessionId,
    workspace: archived.workspace,
    ledger: archived.ledger,
    statePath: archived.statePath,
    taskId: archived.taskId,
    taskHash: archived.taskHash,
    budget: archived.budget,
    startedAt: archived.startedAt,
  }, current.session.binding);
  assert.equal(archived.sdkStateStatus, 'not_created');
  assert.equal(archived.revision, null);
  assert.equal(archived.stateHash, null);
  assert.equal(archived.usage, null);
  assert.deepEqual(archived.pendingUpdates, [archivedReceipt]);
  assert.equal(archived.pendingUpdates[0].status, 'received_unassessed');
  assert.deepEqual(archived.pendingUsage, { toolCalls: 0, costYen: 0, totalTokens: null, executionIds: [], observedElapsedMs: [] }, 'a text-only receipt contributes no observation usage');
  assert.deepEqual(archived.unknowns, [
    'The legacy SDK state was not generated.',
    'Prior total SDK usage is unknown.',
    'The pending receipt remains unassessed and archived.',
  ]);

  const afterRecovery = h.call('status');
  assert.equal(afterRecovery.session.binding.sessionId, recovered.session.binding.sessionId);
  assert.deepEqual(afterRecovery.session.binding.budget, recoveryBudget);
  assert.deepEqual(afterRecovery.session.pendingUpdates, []);
  assert.equal(afterRecovery.session.pendingOperation, null);
  assert.equal(afterRecovery.session.accountingUncertain, false);
  assert.deepEqual(afterRecovery.session.transitions.at(-1).previous.pendingUpdates, [archivedReceipt]);
  assert.equal(afterRecovery.state, null);

  const recoveryInput = await h.json(recoveryTask);
  const prepared = h.call('prepare', '--input', recoveryInput, '--ledger', nextLedger);
  const inspected = h.run('inspect', '--input', recoveryInput, '--ledger', nextLedger, '--out', nextState, '--proposal', await h.envelope('inspect', prepared, initial));
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  const continued = JSON.parse(inspected.stdout);
  assert.equal(continued.state.task.taskId, recoveryTask.taskId);
  assert.deepEqual(continued.state.task.budget, recoveryBudget);
  assert.ok(await readFile(nextLedger, 'utf8'));
  assert.ok(await readFile(nextState, 'utf8'));
  assert.equal(continued.session.binding.taskId, recoveryTask.taskId);
  assert.deepEqual(continued.session.binding.budget, recoveryBudget);
  assert.equal(continued.session.pendingOperation, null);
  assert.equal(continued.session.accountingUncertain, false);
  assert.deepEqual(continued.session.transitions.at(-1).previous.pendingUpdates, [archivedReceipt]);
});

test('legacy capped recovery refuses changes to other budget limits', async t => {
  const capped = packet({ budget: cappedBudget });
  const h = await harness(t, capped, undefined, true);
  const current = h.call('status');
  const sealedBinding = structuredClone(current.session.binding);
  const recoveryBudget = { ...cappedBudget, maxRounds: cappedBudget.maxRounds + 1 };
  delete recoveryBudget.maxCostYen;
  const recoveryTask = packet({ taskId: 'changed-budget-recovery', budget: recoveryBudget });
  const nextLedger = join(h.dir, 'changed-budget-sdk.jsonl'), nextState = join(h.dir, 'changed-budget-state.json');

  const refused = h.run('transition', '--input', await h.json(sameGoalRecovery(current, capped, recoveryTask, 'changed-budget-recovery-change')), '--ledger', nextLedger, '--out', nextState);
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(JSON.parse(refused.stderr).error.code, 'revision_conflict');
  assert.equal(await readFile(nextLedger, 'utf8').catch(() => null), null);
  assert.equal(await readFile(`${nextLedger}.lock`, 'utf8').catch(() => null), null);
  assert.equal(await readFile(nextState, 'utf8').catch(() => null), null);
  assert.equal(await readFile(`${nextState}.lock`, 'utf8').catch(() => null), null);

  const after = h.call('status');
  assert.deepEqual(after.session.binding, sealedBinding);
  assert.equal(after.session.transitions.length, 0);
  assert.equal(after.session.pendingOperation, null);
  assert.equal(after.session.accountingUncertain, false);
  assert.equal(after.state, null);
});

test('legacy capped recovery preserves an unexpired host task clock when transition omits a new clock', async t => {
  const capped = packet({ budget: cappedBudget });
  const clock = {
    startedAt: new Date(Date.now() - 10000).toISOString(),
    deadlineAt: new Date(Date.now() + 3600000).toISOString(),
    basis: 'host_provided',
    sourceRef: 'host:legacy-maxcost-deadline',
  };
  const h = await harness(t, capped, clock, true);
  const current = h.call('status');
  const sealedClock = structuredClone(current.session.taskClock);
  assert.equal(current.session.taskClockStop, null);
  assert.equal(current.taskClockStatus.expired, false);

  const recoveryBudget = { ...cappedBudget };
  delete recoveryBudget.maxCostYen;
  const recoveryTask = packet({ taskId: 'clock-recovered-followup', budget: recoveryBudget });
  const nextLedger = join(h.dir, 'clock-recovered-sdk.jsonl'), nextState = join(h.dir, 'clock-recovered-state.json');
  const result = h.run('transition', '--input', await h.json(sameGoalRecovery(current, capped, recoveryTask, 'clock-recovery-change')), '--ledger', nextLedger, '--out', nextState);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const recovered = JSON.parse(result.stdout);
  const archived = recovered.session.transitions.at(-1).previous;
  assert.deepEqual(archived.taskClock, sealedClock);
  assert.equal(archived.taskClock.deadlineAt, clock.deadlineAt);
  assert.equal(archived.taskClockStop, null);
  assert.deepEqual(recovered.session.taskClock, sealedClock, 'transition without a new --task-clock preserves the sealed clock');
  assert.equal(recovered.session.taskClockStop, null);
  assert.equal(recovered.taskClockStatus.deadlineAt, clock.deadlineAt);
  assert.equal(recovered.taskClockStatus.expired, false);
  assert.equal(recovered.session.binding.taskId, recoveryTask.taskId);
  assert.deepEqual(recovered.session.binding.budget, recoveryBudget);
});

test('expired legacy capped recovery remains refused without new SDK artifacts or a transition', async t => {
  const capped = packet({ budget: cappedBudget });
  const clock = {
    startedAt: null,
    deadlineAt: new Date(Date.now() - 1000).toISOString(),
    basis: 'host_provided',
    sourceRef: 'host:expired-legacy-maxcost-deadline',
  };
  const h = await harness(t, capped, clock, true);
  const current = h.call('status');
  assert.equal(current.session.taskClockStop.reason, 'task_deadline_exceeded');
  assert.equal(current.session.taskClock.deadlineAt, clock.deadlineAt);

  const recoveryBudget = { ...cappedBudget };
  delete recoveryBudget.maxCostYen;
  const recoveryTask = packet({ taskId: 'expired-clock-recovery', budget: recoveryBudget });
  const nextLedger = join(h.dir, 'expired-recovery-sdk.jsonl'), nextState = join(h.dir, 'expired-recovery-state.json');
  const refused = h.run('transition', '--input', await h.json(sameGoalRecovery(current, capped, recoveryTask, 'expired-clock-recovery-change')), '--ledger', nextLedger, '--out', nextState);
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(JSON.parse(refused.stderr).error.code, 'revision_conflict');
  assert.equal(await readFile(nextLedger, 'utf8').catch(() => null), null);
  assert.equal(await readFile(`${nextLedger}.lock`, 'utf8').catch(() => null), null);
  assert.equal(await readFile(nextState, 'utf8').catch(() => null), null);
  assert.equal(await readFile(`${nextState}.lock`, 'utf8').catch(() => null), null);

  const after = h.call('status');
  assert.equal(after.session.binding.sessionId, current.session.binding.sessionId);
  assert.equal(after.session.transitions.length, 0);
  assert.equal(after.session.taskClock.deadlineAt, clock.deadlineAt);
  assert.equal(after.session.taskClockStop.reason, 'task_deadline_exceeded');
  assert.equal(after.session.accountingUncertain, false);
});

test('same-goal recovery stays refused when the capped legacy session already has SDK state', async t => {
  const source = evidence('legacy-stateful-source', 'Minimum is 24.');
  const capped = packet({ evidence: [source], budget: cappedBudget });
  const h = await harness(t, capped, undefined, sealedInspect(capped));
  const current = h.call('status');
  assert.ok(current.state);

  const recoveryBudget = { ...cappedBudget };
  delete recoveryBudget.maxCostYen;
  const recoveryTask = packet({ taskId: 'stateful-recovery-refused', evidence: [source], budget: recoveryBudget });
  const nextLedger = join(h.dir, 'stateful-recovery-sdk.jsonl'), nextState = join(h.dir, 'stateful-recovery-state.json');
  const refused = h.run('transition', '--input', await h.json(sameGoalRecovery(current, capped, recoveryTask, 'stateful-recovery-change')), '--ledger', nextLedger, '--out', nextState);

  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(JSON.parse(refused.stderr).error.code, 'revision_conflict');
  assert.equal(await readFile(nextLedger, 'utf8').catch(() => null), null);
  assert.equal(await readFile(`${nextLedger}.lock`, 'utf8').catch(() => null), null);
  assert.equal(await readFile(nextState, 'utf8').catch(() => null), null);
  assert.equal(await readFile(`${nextState}.lock`, 'utf8').catch(() => null), null);

  const after = h.call('status');
  assert.deepEqual(after.session.binding, current.session.binding);
  assert.equal(after.state.revision, current.state.revision);
  assert.deepEqual(after.state.usage, current.state.usage);
  assert.equal(after.session.transitions.length, current.session.transitions.length);
  assert.equal(after.session.pendingOperation, null);
  assert.equal(after.session.accountingUncertain, false);
});

test('same-goal recovery stays refused for a state-less capped session with clock-regression uncertainty', async t => {
  const capped = packet({ budget: cappedBudget });
  const h = await harness(t, capped, undefined, async store => {
    const observedAt = store.snapshot.lastObservedAt;
    const now = Date.now;
    Date.now = () => observedAt - 1;
    try { await store.observe(); }
    finally { Date.now = now; }
  });
  const current = h.call('status');
  assert.equal(current.state, null);
  assert.equal(current.session.pendingOperation, null);
  assert.equal(current.session.accountingUncertain, true);
  assert.ok(current.session.clockRegression.observedAt < current.session.clockRegression.previousObservedAt);

  const recoveryBudget = { ...cappedBudget };
  delete recoveryBudget.maxCostYen;
  const recoveryTask = packet({ taskId: 'uncertain-recovery-refused', budget: recoveryBudget });
  const nextLedger = join(h.dir, 'uncertain-recovery-sdk.jsonl'), nextState = join(h.dir, 'uncertain-recovery-state.json');
  const refused = h.run('transition', '--input', await h.json(sameGoalRecovery(current, capped, recoveryTask, 'uncertain-recovery-change')), '--ledger', nextLedger, '--out', nextState);

  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(JSON.parse(refused.stderr).error.code, 'revision_conflict');
  assert.equal(await readFile(nextLedger, 'utf8').catch(() => null), null);
  assert.equal(await readFile(`${nextLedger}.lock`, 'utf8').catch(() => null), null);
  assert.equal(await readFile(nextState, 'utf8').catch(() => null), null);
  assert.equal(await readFile(`${nextState}.lock`, 'utf8').catch(() => null), null);

  const after = h.call('status');
  assert.deepEqual(after.session.binding, current.session.binding);
  assert.equal(after.session.pendingOperation, null);
  assert.equal(after.session.accountingUncertain, true);
  assert.deepEqual(after.session.clockRegression, current.session.clockRegression);
  assert.equal(after.session.transitions.length, 0);
  assert.equal(after.state, null);
});

test('legacy capped session with an interrupted operation keeps its uncertainty while reads and receipts remain available', async t => {
  const capped = packet({ budget: cappedBudget });
  const h = await harness(t, capped, undefined, store => store.begin('inspect'));
  const interrupted = h.activation.session.pendingOperation;
  assert.equal(interrupted?.operation, 'inspect');
  assert.equal(h.activation.session.accountingUncertain, true, 'the pre-existing interrupted operation is already uncertain');
  const preserved = result => {
    assert.equal(result.session.binding.sessionId, h.activation.session.binding.sessionId);
    assert.deepEqual(result.session.binding.budget, cappedBudget);
    assert.deepEqual(result.session.pendingOperation, interrupted, 'the interrupted operation is never cleared automatically');
    assert.equal(result.session.accountingUncertain, true, 'uncertain accounting is never cleared automatically');
    assert.equal(result.effectiveDecision, 'blocked');
  };
  await t.test('activate replay preserves the interrupted operation', () => preserved(h.call('activate', '--input', h.input, '--ledger', h.ledger, '--out', h.state)));
  await t.test('status preserves the interrupted operation', () => preserved(h.call('status')));
  await t.test('report states that explicit recovery is required', () => {
    const report = h.run('report', '--ledger', h.ledger);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /明示的な復旧が必要/);
  });
  await t.test('receive remains available', async () => {
    const received = h.call('receive', '--input', await h.json(receipt('interrupted-followup', 'A follow-up during recovery.')));
    preserved(received);
    assert.equal(received.session.pendingUpdates.length, 1);
  });
  for (const [name, args] of [
    ['prepare', async () => ['prepare', '--input', h.input, '--ledger', h.ledger]],
    ['inspect', async () => ['inspect', '--input', h.input, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.json({})]],
    ['transition', async () => ['transition', '--input', await h.json(goalChange(h.call('status'), capped, nextGoal('interrupted-next'))), '--ledger', join(h.dir, 'next-sdk.jsonl'), '--out', join(h.dir, 'next-state.json')]],
  ]) await t.test(`${name} is refused without clearing the interrupted operation`, async () => {
    const result = h.run(...await args());
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stderr).error.code, 'revision_conflict');
    preserved(h.call('status'));
  });
});

test('transition to a new unsupported monetary cap rejects before checkpoint and the corrected cap-free goal transitions', async t => {
  const h = await harness(t);
  await h.apply('inspect', initial);
  const current = h.call('status');
  const next = nextGoal('capped-next'), ledger = join(h.dir, 'next-sdk.jsonl'), state = join(h.dir, 'next-state.json');
  await rejectedWithout(h, ['transition', '--input', await h.json(goalChange(current, h.task, { ...next, budget: cappedBudget })), '--ledger', ledger, '--out', state], 'budget_accounting_unavailable');
  const kept = h.call('status');
  assert.equal(kept.session.binding.sessionId, current.session.binding.sessionId);
  assert.equal(kept.state.revision, current.state.revision);
  assert.equal(kept.session.transitions.length, 0);
  certain(kept);
  const moved = h.call('transition', '--input', await h.json(goalChange(kept, h.task, next)), '--ledger', ledger, '--out', state);
  assert.equal(moved.session.binding.taskId, next.taskId);
  assert.deepEqual(moved.session.binding.budget, budget);
  certain(moved);
});

test('in-budget prepare/apply do not invalidate their own binding and receipts are applied exactly once', async t => {
  const h = await harness(t);
  const first = await h.apply('inspect', initial);
  const ev = evidence('config', 'Minimum is 24.');
  const obs = observation('read-1', ev);
  const received = receipt('new-config', 'The configuration was read.', [obs]);
  const r = h.call('receive', '--input', await h.json(received));
  assert.equal(r.session.pendingUpdates.length, 1);
  assert.equal(r.session.pendingUsage.toolCalls, 1);
  assert.equal(r.session.pendingUsage.costYen, null);
  assert.equal(r.state.revision, first.state.revision);
  const { args, value } = await h.prepared('update', [obs]);
  assert.equal(value.request.state.revision, first.state.revision);
  assert.equal(value.binding.expectedRevision, first.state.revision);
  const updated = h.call('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('update', value, { assessments: [assessment(ev.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [ev.id], explanation: 'Checked.' }] }));
  assert.equal(updated.state.claims[0].status, 'supported');
  assert.equal(updated.session.pendingUpdates.length, 0);
  assert.equal(updated.session.pendingUsage.toolCalls, 0);
  assert.equal(updated.session.updates[0].appliedRevision, updated.state.revision);
  assert.equal(updated.state.usage.toolCalls, 1);
  const ready = await h.apply('reflect', {});
  assert.equal(ready.effectiveDecision, 'ready_for_requested_step');
  const again = h.call('receive', '--input', await h.json(received));
  assert.equal(again.session.updates.length, 1);
  assert.equal(again.session.pendingUpdates.length, 0);
  const duplicate = await h.apply('update', {}, [obs]);
  assert.deepEqual(duplicate.state, ready.state);
  const conflict = h.run('receive', '--input', await h.json({ ...received, text: 'Changed payload.' }));
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(conflict.stderr).error.code, 'invalid_input');
  const idCollision = h.run('receive', '--input', await h.json(receipt('another-receipt', 'More data.', [{ ...obs, toolCalls: 2 }])));
  assert.equal(idCollision.status, 1);
  assert.equal(h.call('status').state.usage.toolCalls, 1);
});

test('actual deadline between prepare and apply saves a non-generating SDK stop and retains unassessed follow-up', async t => {
  const h = await harness(t, packet({ budget: { ...budget, maxElapsedMs: 5000 } }));
  const first = await h.apply('inspect', initial);
  const ev = evidence('late-source', 'A counterexample says minimum is 22.');
  const obs = observation('already-observed', ev);
  const { args, value } = await h.prepared('update', [obs]);
  const plan = await h.envelope('update', value, { assessments: [assessment(ev.id, 'refutes')] });
  await delay(Math.max(1, Date.parse(first.state.startedAt) + h.task.budget.maxElapsedMs - Date.now() + 40));
  const actualReceiveStart = Date.now();
  const expired = h.call('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', plan);
  assert.equal(expired.state.stopReason, 'budget_exhausted');
  assert.equal(expired.state.decision, 'blocked');
  assert.equal(expired.state.usage.modelCalls, first.state.usage.modelCalls);
  assert.equal(expired.state.usage.rounds, first.state.usage.rounds);
  assert.deepEqual(expired.state.claims, first.state.claims);
  assert.deepEqual(expired.state.evidence, first.state.evidence);
  assert.deepEqual(expired.state.task.budget, first.state.task.budget);
  assert.equal(expired.state.startedAt, first.state.startedAt);
  assert.equal(expired.session.pendingUsage.toolCalls, 1, 'Already incurred observations are retained outside the unevaluated SDK snapshot');
  const retained = expired.session.pendingUpdates.find(item => item.id.startsWith('unassessed-apply-'));
  assert.ok(Date.parse(retained.source.receivedAt) >= actualReceiveStart && Date.parse(retained.source.receivedAt) <= Date.now(), 'The internal receipt records actual first reception, not SDK startedAt');
  assert.ok(Date.parse(retained.helperReceivedAt) >= actualReceiveStart && Date.parse(retained.helperReceivedAt) <= Date.now(), 'Internal observations also have a measured helper acceptance time');
  assert.equal(retained.observations[0].evidence[0].retrievedAt, ev.retrievedAt);
  const redelivered = h.call('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', plan);
  assert.equal(redelivered.session.pendingUpdates.filter(item => item.id === retained.id).length, 1);
  assert.equal(redelivered.session.pendingUpdates.find(item => item.id === retained.id).source.receivedAt, retained.source.receivedAt);
  assert.equal(redelivered.session.pendingUpdates.find(item => item.id === retained.id).helperReceivedAt, retained.helperReceivedAt);
  expectUnderstanding(expired, { requiredGapIds: ['gap'], reflectionStatus: 'missing', canReportCompletion: false });
  const incoming = receipt('counterexample', 'A new source needs reconsideration.', [obs]);
  const receive = h.call('receive', '--input', await h.json(incoming));
  assert.equal(receive.session.pendingUsage.toolCalls, 1, 'Same execution is not charged twice across receipts');
  const unbound = receipt('no-probe-yet', 'An unassessed follow-up without a probe.');
  h.call('receive', '--input', await h.json(unbound));
  const status = h.call('status');
  assert.equal(status.effectiveDecision, 'blocked');
  assert.equal(status.state.taskId, first.state.taskId);
  assert.equal(status.session.binding.sessionId, h.activation.session.binding.sessionId);
  assert.equal(status.state.startedAt, first.state.startedAt);
  assert.ok(status.state.usage.elapsedMs >= expired.state.usage.elapsedMs);
  assert.ok(status.session.pendingUpdates.some(item => item.id === unbound.id));
  const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /旧理解のスナップショット/);
  assert.match(report.stdout, /受領済み・未評価/);
  assert.match(report.stdout, /budget\\_exhausted/);
  const newInput = await h.json(packet({ taskId: 'new-budget', budget: { ...budget, maxElapsedMs: 600000 } }));
  assert.equal(h.run('activate', '--input', newInput, '--ledger', join(h.dir, 'another.jsonl'), '--out', join(h.dir, 'another.json')).status, 1);
  assert.equal(h.run('inspect', '--input', newInput, '--proposal', await h.json({})).status, 1);
  await rm(join(h.dir, '.session', 'tombo-session.json'));
  await rm(h.state);
  const resumed = h.call('status');
  assert.equal(resumed.state.usage.modelCalls, first.state.usage.modelCalls);
  assert.equal(resumed.session.pendingUsage.toolCalls, 1);
  assert.deepEqual(resumed.state.claims, first.state.claims);
  assert.equal(resumed.state.stopReason, 'budget_exhausted');
});

test('new information after ready is unassessed until counterexample update and fresh reflection', async t => {
  const h = await harness(t);
  await h.apply('inspect', initial);
  const ev = evidence('support', 'Minimum is 24.');
  await h.apply('update', { assessments: [assessment(ev.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [ev.id], explanation: 'Supported.' }] }, [observation('first-check', ev)]);
  const ready = await h.apply('reflect', {});
  assert.equal(ready.effectiveDecision, 'ready_for_requested_step');
  const contrary = evidence('contrary', 'Minimum is actually 22.');
  const obs = observation('counter-check', contrary);
  const received = h.call('receive', '--input', await h.json(receipt('contrary-report', 'A counterexample arrived.', [obs])));
  assert.equal(received.state.decision, 'ready_for_requested_step');
  assert.equal(received.effectiveDecision, 'needs_check');
  const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
  assert.match(report.stdout, /最新追補の評価完了を表さない/);
  const disputed = await h.apply('update', { assessments: [assessment(contrary.id, 'refutes')] }, [obs]);
  assert.equal(disputed.state.claims[0].status, 'disputed');
  assert.equal(disputed.state.gaps[0].status, 'open');
  assert.equal(disputed.session.pendingUpdates.length, 0);
  assert.notEqual(sdk.understandingHash(disputed.state), ready.state.reflection.binding.understandingHash);
});

test('human answer and saved restart use the same session rather than a new task or budget', async t => {
  const h = await harness(t, packet({ goal: 'Choose the work scope.', proposedAnswer: 'Use option A.', successCriteria: ['Respect the user choice.'] }));
  const human = structuredClone(initial);
  human.claims[0].text = 'The user selects option A.';
  human.gaps[0] = { ...human.gaps[0], kind: 'ambiguous_intent', humanRole: 'priority', question: 'Which option do you choose?', triggerRefs: ['task:goal'] };
  human.probes[0].requiredCapability = 'receive_user_answer';
  const asked = await h.apply('inspect', human);
  assert.equal(asked.state.decision, 'needs_user_input');
  const answer = evidence('answer', 'Use option A.', { kind: 'user_statement', locator: 'conversation:answer' });
  const obs = observation('human-answer', answer, { toolCalls: 0 });
  h.call('receive', '--input', await h.json(receipt('actual-answer', 'The user answered.', [obs])));
  const updated = await h.apply('update', { assessments: [assessment(answer.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [answer.id], explanation: 'The user explicitly chose the declared option.' }] }, [obs]);
  await rm(join(h.dir, '.session', 'tombo-session.json'));
  const status = h.call('status');
  assert.equal(status.session.binding.sessionId, h.activation.session.binding.sessionId);
  assert.equal(status.state.startedAt, asked.state.startedAt);
  assert.deepEqual(status.state.usage, updated.state.usage);
  const ready = await h.apply('reflect', {});
  assert.equal(ready.effectiveDecision, 'ready_for_requested_step');
  assert.deepEqual(ready.userQuestions, []);
});

test('pending real observation usage exhausts the existing budget without fake SDK accounting', async t => {
  const h = await harness(t, packet({ budget: { ...budget, maxToolCalls: 1 } }));
  const first = await h.apply('inspect', initial);
  const ev = evidence('too-expensive', 'The actual check required two tool calls.');
  const obs = observation('two-actual-calls', ev, { toolCalls: 2 });
  const received = h.call('receive', '--input', await h.json(receipt('actual-cost', 'An already incurred check.', [obs])));
  assert.equal(received.budgetCheckpoint.exhausted, true);
  assert.equal(received.state.decision, 'blocked');
  assert.equal(received.state.stopReason, 'budget_exhausted');
  assert.equal(received.state.usage.toolCalls, first.state.usage.toolCalls);
  assert.equal(received.state.usage.modelCalls, first.state.usage.modelCalls);
  assert.equal(received.session.pendingUsage.toolCalls, 2);
  assert.equal(received.session.pendingUsage.costYen, null);
});

test('failed assessment keeps receipts unassessed and exact batch retry does not repeat real tool usage', async t => {
  const h = await harness(t);
  await h.apply('inspect', initial);
  const ev = evidence('checked-once', 'Minimum is 24.');
  const obs = observation('single-execution', ev);
  h.call('receive', '--input', await h.json(receipt('actual-execution', 'The source was read.', [obs])));
  const { args, value } = await h.prepared('update', [obs]);
  const failed = h.run('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('update', value, { assessments: [assessment('unknown-evidence')] }));
  assert.equal(failed.status, 1, failed.stderr);
  const stopped = JSON.parse(failed.stdout);
  assert.equal(stopped.state.stopReason, 'invalid_model_output');
  assert.deepEqual(stopped.state.pendingAssessmentExecutionIds, [obs.executionId]);
  assert.equal(stopped.state.usage.toolCalls, 1);
  assert.equal(stopped.session.pendingUsage.toolCalls, 0);
  assert.equal(stopped.session.pendingUpdates.length, 1);
  const fixed = await h.apply('update', { assessments: [assessment(ev.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [ev.id], explanation: 'The exact observed batch was assessed.' }] }, [obs]);
  assert.equal(fixed.state.usage.toolCalls, 1);
  assert.equal(fixed.state.usage.modelCalls, stopped.state.usage.modelCalls + 1);
  assert.equal(fixed.session.pendingUpdates.length, 0);
});

test('reference-only receive is linked to a matching real observation rather than silently promoted', async t => {
  const h = await harness(t);
  await h.apply('inspect', initial);
  const source = evidence('reference-source', 'Minimum is 24.');
  const ref = { id: 'source-reference', source: { kind: 'document', locator: 'conversation:reference', receivedAt: new Date().toISOString() }, references: [source.locator] };
  const received = h.call('receive', '--input', await h.json(ref));
  assert.equal(received.session.pendingUpdates.length, 1);
  assert.equal(received.state.evidence.length, 0);
  const wrong = observation('wrong-source', evidence('wrong-document', 'Another source.'));
  const wrongBatch = await h.json([wrong]);
  assert.equal(h.run('prepare', '--state', h.state, '--observations', wrongBatch, '--receipt', ref.id, '--ledger', h.ledger).status, 1);
  const result = await h.apply('update', { assessments: [assessment(source.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [source.id], explanation: 'The referenced source was read and assessed.' }] }, [observation('read-reference', source)], ['--receipt', ref.id]);
  assert.equal(result.session.pendingUpdates.length, 0);
  assert.equal(result.session.updates[0].appliedRevision, result.state.revision);
});

test('transition requires a user change reference and carries old usage, stop, pending and unknowns', async t => {
  const h = await harness(t);
  const first = await h.apply('inspect', initial);
  h.call('receive', '--input', await h.json(receipt('unresolved-followup', 'Unassessed new information.')));
  const old = h.call('status');
  const newTask = packet({ taskId: 'different-goal', goal: 'Explain the packaging licence instead.', successCriteria: ['Read the licence terms.'] });
  const ledger = join(h.dir, 'new-sdk.jsonl'), state = join(h.dir, 'new-state.json');
  const aiOnly = await h.json({ task: newTask, reason: 'I rephrased the goal.' });
  assert.equal(h.run('transition', '--input', aiOnly, '--ledger', ledger, '--out', state).status, 1);
  const changeText = 'Change the task: explain the packaging licence instead of runtime requirements.';
  const change = { task: newTask, reason: 'The user changed the requested subject.', userChange: { id: 'user-change-1', kind: 'user_statement', locator: 'conversation:change-1', receivedAt: new Date().toISOString(), passage: changeText, contentHash: sdk.hashPassage(changeText), previousGoal: h.task.goal, newGoal: newTask.goal, previousSuccessCriteria: h.task.successCriteria, newSuccessCriteria: newTask.successCriteria }, previousSessionId: old.session.binding.sessionId, hand_over_summary: { unresolvedGapIds: ['gap'], unknowns: ['The runtime claim remains unresolved.'] } };
  const sameGoal = await h.json({ ...change, task: packet({ taskId: 'same-goal-renamed' }) });
  assert.equal(h.run('transition', '--input', sameGoal, '--ledger', ledger, '--out', state).status, 1);
  const next = h.call('transition', '--input', await h.json(change), '--ledger', ledger, '--out', state);
  assert.notEqual(next.session.binding.sessionId, old.session.binding.sessionId);
  const previous = next.session.transitions.at(-1).previous;
  assert.equal(previous.taskId, first.state.taskId);
  assert.deepEqual(previous.usage, first.state.usage);
  assert.equal(previous.stopReason, first.state.stopReason);
  assert.equal(previous.pendingUpdates.length, 1);
  assert.deepEqual(previous.unknowns, change.hand_over_summary.unknowns);
  assert.equal(next.session.binding.taskId, newTask.taskId);
  assert.equal(next.session.binding.startedAt, null);
  assert.equal(next.session.transitions.at(-1).userChange.locator, 'conversation:change-1');
});

async function readyForInvalidation(h) {
  await h.apply('inspect', initial);
  const source = evidence('old-config', 'Minimum is 24.');
  await h.apply('update', { assessments: [assessment(source.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [source.id], explanation: 'The original configuration supports it.' }] }, [observation('read-old-config', source)]);
  return { source, ready: await h.apply('reflect', {}) };
}

test('managed invalidate reopens a ready claim and continues the same task with new evidence and reflection', async t => {
  const h = await harness(t), { source, ready } = await readyForInvalidation(h);
  const request = await h.json({ evidenceIds: [source.id], reason: 'The configuration was replaced.' });
  const withdrawn = h.call('invalidate', '--state', h.state, '--input', request, '--ledger', h.ledger, '--out', h.state);
  assert.equal(withdrawn.state.evidence[0].validity, 'withdrawn');
  assert.equal(withdrawn.state.claims[0].status, 'unverified');
  assert.equal(withdrawn.state.gaps[0].status, 'open');
  assert.equal(withdrawn.state.decision, 'needs_check');
  assert.equal(withdrawn.effectiveDecision, withdrawn.state.decision);
  assert.deepEqual(withdrawn.state.usage, ready.state.usage);
  assert.equal(withdrawn.state.startedAt, ready.state.startedAt);
  assert.deepEqual(withdrawn.state.task, ready.state.task);
  assert.equal(withdrawn.session.binding.sessionId, ready.session.binding.sessionId);
  assert.notEqual(sdk.understandingHash(withdrawn.state), ready.state.reflection.binding.understandingHash);
  const again = h.call('invalidate', '--state', h.state, '--input', request, '--ledger', h.ledger);
  assert.deepEqual(again.state, withdrawn.state);
  const current = evidence('new-config', 'Minimum is now 22.');
  const updated = await h.apply('update', { assessments: [assessment(current.id, 'refutes')], resolutions: [{ gapId: 'gap', reason: 'refuted', evidenceIds: [current.id], explanation: 'The replacement configuration refutes the old minimum.' }] }, [observation('read-new-config', current)]);
  assert.equal(updated.state.claims[0].status, 'contradicted');
  assert.equal(updated.state.decision, 'needs_reflection');
  const reviewed = await h.apply('reflect', {});
  assert.equal(reviewed.effectiveDecision, 'ready_for_requested_step');
  assert.equal(reviewed.state.usage.toolCalls, ready.state.usage.toolCalls + 1);
  assert.equal(reviewed.state.usage.modelCalls, ready.state.usage.modelCalls + 2);
  assert.equal(reviewed.session.binding.sessionId, ready.session.binding.sessionId);
});

test('managed invalidate works from a redacted authoritative cache recovery without revalidating passages', async t => {
  const h = await harness(t), { source, ready } = await readyForInvalidation(h);
  await rm(h.state);
  await rm(join(h.dir, '.session', 'tombo-session.json'));
  const restored = h.call('status');
  assert.equal(restored.state.evidence[0].passageUnavailable, true);
  const result = h.call('invalidate', '--state', h.state, '--input', await h.json({ evidenceIds: [source.id], reason: 'The referenced version was withdrawn.' }), '--ledger', h.ledger);
  assert.equal(result.state.evidence[0].validity, 'withdrawn');
  assert.equal(result.state.evidence[0].passageUnavailable, true);
  assert.equal(result.state.claims[0].status, 'unverified');
  assert.deepEqual(result.state.usage, ready.state.usage);
  assert.equal(result.state.startedAt, ready.state.startedAt);
});

test('managed invalidate rejects malformed inputs and mismatched bindings without opening a transaction', async t => {
  const h = await harness(t), { source, ready } = await readyForInvalidation(h);
  const valid = await h.json({ evidenceIds: [source.id], reason: 'A real source withdrawal.' });
  for (const input of [{ evidenceIds: [], reason: 'Empty IDs.' }, { evidenceIds: ['unknown'], reason: 'Unknown source.' }, { evidenceIds: [source.id, source.id], reason: 'Duplicate IDs.' }, { evidenceIds: [source.id], reason: '' }, { evidenceIds: [source.id], reason: 'No extra fields.', verified: true }]) {
    const result = h.run('invalidate', '--state', h.state, '--input', await h.json(input), '--ledger', h.ledger);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'invalid_input');
  }
  for (const args of [[], ['--ledger', join(h.dir, 'other.jsonl')], ['--ledger', h.ledger, '--out', join(h.dir, 'other.json')]]) {
    const result = h.run('invalidate', '--state', h.state, '--input', valid, ...args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'revision_conflict');
  }
  const edited = await h.json({ ...ready.state, usage: { ...ready.state.usage, modelCalls: 0 } });
  assert.equal(h.run('invalidate', '--state', edited, '--input', valid, '--ledger', h.ledger).status, 1);
  const intact = h.call('status');
  assert.equal(intact.state.revision, ready.state.revision);
  assert.equal(intact.session.pendingOperation, null);
  const dir = await mkdtemp(join(tmpdir(), 'tombo-invalidate-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = spawnSync(process.execPath, [helper, 'invalidate', '--state', h.state, '--input', valid, '--ledger', h.ledger], { cwd: dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  assert.equal(legacy.status, 1);
  assert.match(JSON.parse(legacy.stderr).error.message, /requires an activated session/);
});

test('managed invalidate preserves an existing stop and archives discarded pending assessment as unassessed', async t => {
  const h = await harness(t);
  await h.apply('inspect', initial);
  const source = evidence('pending-source', 'A source awaiting assessment.');
  const obs = observation('pending-read', source);
  const pendingReceipt = receipt('pending-receipt', 'An observed source not yet assessed.', [obs]);
  h.call('receive', '--input', await h.json(pendingReceipt));
  const { args, value } = await h.prepared('update', [obs]);
  const failed = h.run('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('update', value, { assessments: [assessment('missing')] }));
  assert.equal(failed.status, 1);
  const stopped = JSON.parse(failed.stdout);
  assert.equal(stopped.state.stopReason, 'invalid_model_output');
  assert.deepEqual(stopped.state.pendingAssessmentExecutionIds, [obs.executionId]);
  const replacement = evidence('replacement', 'Minimum is 24.');
  const freshObservation = observation('fresh-read', replacement);
  const mixedReceipt = receipt('mixed-receipt', 'The old pending read and a separate fresh observation.', [obs, freshObservation]);
  const mixed = h.call('receive', '--input', await h.json(mixedReceipt));
  assert.equal(mixed.effectiveDecision, 'blocked', 'An existing stop cannot be raised to needs_check by a new receipt');
  const withdrawn = h.call('invalidate', '--state', h.state, '--input', await h.json({ evidenceIds: [source.id], reason: 'The unassessed source was withdrawn.' }), '--ledger', h.ledger);
  assert.equal(withdrawn.state.stopReason, stopped.state.stopReason);
  assert.equal(withdrawn.state.decision, 'blocked');
  assert.equal(withdrawn.effectiveDecision, 'blocked');
  assert.equal(withdrawn.state.pendingAssessmentExecutionIds, undefined);
  assert.deepEqual(withdrawn.state.usage, stopped.state.usage);
  assert.equal(withdrawn.session.pendingUpdates.length, 1);
  assert.equal(withdrawn.session.pendingUpdates[0].id, 'mixed-receipt');
  assert.equal(withdrawn.session.pendingUsage.toolCalls, freshObservation.toolCalls);
  const archived = withdrawn.session.discardedUpdates.find(item => item.id === 'pending-receipt');
  assert.equal(archived.status, 'discarded_unassessed');
  assert.equal(archived.appliedRevision, null);
  assert.deepEqual(archived.discardedAssessment.executionIds, [obs.executionId]);
  assert.equal(archived.discardedAssessment.atRevision, withdrawn.state.revision);
  assert.equal(h.call('status').session.updates[0].status, 'discarded_unassessed');
  const replayedReceipt = h.call('receive', '--input', await h.json(pendingReceipt));
  assert.equal(replayedReceipt.session.updates[0].appliedRevision, null);
  assert.equal(replayedReceipt.session.pendingUsage.toolCalls, freshObservation.toolCalls);
  const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
  assert.match(report.stdout, /評価せず破棄した観測/);
  const repeated = await h.prepared('update', [obs]);
  const redelivered = h.run('update', ...repeated.args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('update', repeated.value, {}));
  assert.equal(redelivered.status, 1, 'The pre-existing invalid_model_output stop remains in force');
  assert.equal(redelivered.stderr, '', 'An identical discarded execution is not a payload collision');
  assert.deepEqual(JSON.parse(redelivered.stdout).state.usage, stopped.state.usage);
  const freshReceipt = receipt('fresh-only-receipt', 'A separate fresh check of the replacement source.', [freshObservation]);
  const freshReceived = h.call('receive', '--input', await h.json(freshReceipt));
  assert.equal(freshReceived.session.pendingUsage.toolCalls, freshObservation.toolCalls, 'Mixed and fresh-only receipts share one actual execution');
  await h.apply('update', { assessments: [assessment(replacement.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [replacement.id], explanation: 'A fresh source was actually assessed.' }] }, [freshObservation]);
  const ready = await h.apply('reflect', {});
  assert.equal(ready.effectiveDecision, 'ready_for_requested_step');
  assert.equal(ready.session.discardedUpdates[0].appliedRevision, null);
  assert.equal(ready.session.pendingUpdates.length, 0);
  assert.equal(ready.session.updates.find(item => item.id === 'mixed-receipt').status, 'discarded_unassessed');
  assert.equal(ready.session.updates.find(item => item.id === freshReceipt.id).status, 'applied');
  assert.notEqual(ready.session.updates.find(item => item.id === freshReceipt.id).appliedRevision, null);
  assert.equal(ready.session.pendingUsage.toolCalls, 0);
  const nextTask = packet({ taskId: 'licence', goal: 'Explain the licence.', successCriteria: ['Use the current licence text.'] });
  const passage = 'Please change the task to explaining the licence.';
  const transition = { task: nextTask, reason: 'The user requested another subject.', previousSessionId: ready.session.binding.sessionId, userChange: { id: 'scope-change', kind: 'user_statement', locator: 'conversation:scope-change', receivedAt: new Date().toISOString(), passage, contentHash: sdk.hashPassage(passage), previousGoal: h.task.goal, newGoal: nextTask.goal, previousSuccessCriteria: h.task.successCriteria, newSuccessCriteria: nextTask.successCriteria }, hand_over_summary: { unresolvedGapIds: [], unknowns: ['The withdrawn observation was never evaluated.'] } };
  const changed = h.call('transition', '--input', await h.json(transition), '--ledger', join(h.dir, 'licence.jsonl'), '--out', join(h.dir, 'licence.json'));
  assert.equal(changed.session.transitions.at(-1).previous.discardedUpdates.length, 2);
  assert.equal(changed.session.transitions.at(-1).previous.discardedUpdates[0].appliedRevision, null);
  assert.deepEqual(changed.session.transitions.at(-1).previous.usage, ready.state.usage);
});

for (const facet of ['preserves prior stop', 'keeps discarded receipt unassessed']) test(`managed invalidation transaction ${facet}`, async t => {
  const h = await harness(t);
  await h.apply('inspect', initial);
  const source = evidence('pending-source', 'A source awaiting assessment.'), obs = observation('pending-read', source);
  h.call('receive', '--input', await h.json(receipt('pending', 'An actual read without a successful assessment.', [obs])));
  const { args, value } = await h.prepared('update', [obs]);
  const failed = h.run('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('update', value, { assessments: [assessment('missing')] }));
  assert.equal(failed.status, 1);
  const before = JSON.parse(failed.stdout).state;
  const invalidation = { evidenceIds: [source.id], reason: 'The pending source was withdrawn.' };
  const raw = sdk.createTombo({ adapter: { async generate() { throw new Error('No generation.'); } } }).invalidate(before, invalidation);
  const { SessionStore } = await import(pathToFileURL(resolve('skills/tombo-view/scripts/session-store.mjs')).href);
  const store = new SessionStore(h.dir, sdk);
  await store.withLock(async () => {
    await store.load(); await store.reconcile();
    await store.begin('invalidate', { invalidation, previousStopReason: before.stopReason, discardedExecutionIds: before.pendingAssessmentExecutionIds });
    await store.commit(raw.state);
  });
  const actual = h.call('status');
  if (facet === 'preserves prior stop') {
    assert.equal(actual.state.stopReason, before.stopReason, 'A non-generating withdrawal must not erase an existing stop');
    assert.equal(actual.effectiveDecision, 'blocked');
  } else {
    assert.equal(actual.session.updates[0].status, 'discarded_unassessed', 'Discarding pending assessment is not actual evaluation');
    assert.equal(actual.session.updates[0].appliedRevision, null);
  }
  assert.deepEqual(actual.state.usage, before.usage);
});

test('expired managed invalidate retains an unassessed request with real immutable receipt time', async t => {
  const h = await harness(t, packet({ budget: { ...budget, maxElapsedMs: 5000 } }));
  const { source, ready } = await readyForInvalidation(h);
  const invalidation = { evidenceIds: [source.id], reason: 'The source was withdrawn after the deadline.' };
  const input = await h.json(invalidation);
  await delay(Math.max(1, Date.parse(ready.state.startedAt) + h.task.budget.maxElapsedMs - Date.now() + 40));
  const receiveStart = Date.now();
  const result = h.call('invalidate', '--state', h.state, '--input', input, '--ledger', h.ledger);
  assert.equal(result.state.stopReason, 'budget_exhausted');
  assert.equal(result.effectiveDecision, 'blocked');
  assert.equal(result.state.evidence[0].validity, 'current', 'The old snapshot is not silently changed after budget exhaustion');
  assert.deepEqual(result.state.claims, ready.state.claims);
  assert.equal(result.state.usage.modelCalls, ready.state.usage.modelCalls);
  assert.equal(result.state.usage.toolCalls, ready.state.usage.toolCalls);
  const pending = result.session.pendingUpdates.find(item => item.id.startsWith('unassessed-invalidate-'));
  assert.ok(pending);
  assert.deepEqual(pending.invalidation, invalidation);
  assert.ok(Date.parse(pending.source.receivedAt) >= receiveStart && Date.parse(pending.source.receivedAt) <= Date.now());
  assert.ok(Date.parse(pending.helperReceivedAt) >= receiveStart && Date.parse(pending.helperReceivedAt) <= Date.now(), 'Internal invalidation records actual helper acceptance independently');
  const again = h.call('invalidate', '--state', h.state, '--input', input, '--ledger', h.ledger);
  assert.equal(again.session.pendingUpdates.filter(item => item.id === pending.id).length, 1);
  assert.equal(again.session.pendingUpdates.find(item => item.id === pending.id).source.receivedAt, pending.source.receivedAt);
  assert.equal(again.session.pendingUpdates.find(item => item.id === pending.id).helperReceivedAt, pending.helperReceivedAt);
  assert.equal(again.session.binding.sessionId, ready.session.binding.sessionId);
  assert.ok(result.state.revision > ready.state.revision);
  assert.equal(sdk.understandingHash(result.state), ready.state.reflection.binding.understandingHash);
  expectUnderstanding(result, { requiredGapIds: [], reflectionStatus: 'completed', canReportCompletion: false });
  const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
  assert.match(report.stdout, /撤回申告は未適用/);
});

test('managed invalidation transactions recover staged commits and reject external SDK commits', async t => {
  const { SessionStore } = await import(pathToFileURL(resolve('skills/tombo-view/scripts/session-store.mjs')).href);
  const api = sdk.createTombo({ adapter: { async generate() { throw new Error('No generation during invalidate.'); } } });
  for (const phase of ['before-sdk-commit', 'after-sdk-commit']) {
    const h = await harness(t), { source, ready } = await readyForInvalidation(h);
    const invalidation = { evidenceIds: [source.id], reason: `A real withdrawal (${phase}).` };
    const store = new SessionStore(h.dir, sdk);
    const withdrawn = api.invalidate(ready.state, invalidation);
    await store.withLock(async () => {
      await store.load(); await store.reconcile();
      await store.begin('invalidate', { invalidation, previousStopReason: ready.state.stopReason, discardedExecutionIds: [] });
      await store.stage(withdrawn.state);
      if (phase === 'after-sdk-commit') await new sdk.FileJournal(h.ledger).commit(ready.state.revision, withdrawn.state);
    });
    const recovered = h.call('status');
    assert.equal(recovered.state.evidence[0].validity, 'withdrawn');
    assert.equal(recovered.state.revision, withdrawn.state.revision);
    assert.deepEqual(recovered.state.usage, ready.state.usage);
    assert.equal(recovered.session.pendingOperation, null);
    const direct = await sdk.createTombo({ adapter: { async generate() { throw new Error('unused'); } } }).reflect(recovered.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: ['claim'], completion: 'completed', limitations: [], proposal: {}, usage: { totalTokens: null, outputTokens: 0, costYen: null } }; } });
    await new sdk.FileJournal(h.ledger).commit(recovered.state.revision, direct.state);
    assert.equal(h.run('status').status, 1);
  }
});

test('receipt invalidation metadata stays pending through linked or later observations until its managed invalidate commits', async t => {
  const h = await harness(t), { source } = await readyForInvalidation(h);
  const invalidation = { evidenceIds: [source.id], reason: 'The configuration was replaced.' };
  const later = evidence('later-config', 'The replacement still says minimum is 24.', { locator: source.locator }), obs = observation('read-later-config', later);
  const linked = { id: 'withdrawal-notice', source: { kind: 'document', locator: 'conversation:withdrawal-notice' }, text: 'The configuration was replaced.', references: [source.locator], invalidation };
  const observed = { ...receipt('withdrawal-with-observation', 'The replacement was read.', [obs]), invalidation };
  for (const input of [linked, observed]) h.call('receive', '--input', await h.json(input));
  await h.apply('update', { assessments: [assessment(later.id)] }, [obs], ['--receipt', linked.id]);
  const reviewed = await h.apply('reflect', {});
  const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
  assert.equal(report.status, 0, report.stderr);
  assert.equal(reviewed.state.evidence.find(item => item.id === source.id).validity, 'current');
  for (const id of [linked.id, observed.id]) {
    const update = reviewed.session.updates.find(item => item.id === id);
    assert.equal(update.status, 'received_unassessed', `${id}: linked or later observations must not apply an uncommitted withdrawal`);
    assert.equal(update.appliedRevision, null);
    assert.ok(report.stdout.includes(`- ${id}: `), `${id} must stay in the unassessed report section`);
  }
  assert.deepEqual(reviewed.session.pendingUpdates.map(item => item.id), [linked.id, observed.id]);
  assert.equal(reviewed.understandingStatus.canReportCompletion, false);
  const other = h.call('invalidate', '--state', h.state, '--input', await h.json({ evidenceIds: [later.id], reason: 'A different withdrawal.' }), '--ledger', h.ledger);
  assert.equal(other.session.pendingUpdates.length, 2, 'A different committed withdrawal does not apply this request');
  const withdrawn = h.call('invalidate', '--state', h.state, '--input', await h.json(invalidation), '--ledger', h.ledger);
  assert.equal(withdrawn.state.evidence.find(item => item.id === source.id).validity, 'withdrawn');
  for (const id of [linked.id, observed.id]) {
    const update = withdrawn.session.updates.find(item => item.id === id);
    assert.equal(update.status, 'applied');
    assert.equal(update.appliedRevision, withdrawn.state.revision);
  }
  assert.equal(withdrawn.session.pendingUpdates.length, 0);
});

function expectUnderstanding(result, expected) {
  assert.ok(result.understandingStatus, 'Managed output must expose non-mutating understandingStatus');
  assert.deepEqual(result.understandingStatus, expected);
}
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const checksum = value => sdk.hashPassage(JSON.stringify(sorted(value)));
function humanProposal() {
  const proposal = structuredClone(initial);
  proposal.claims[0].text = 'The user selects option A.';
  proposal.gaps[0] = { ...proposal.gaps[0], kind: 'ambiguous_intent', humanRole: 'priority', question: 'Which scope do you prefer?', triggerRefs: ['task:goal'] };
  proposal.probes[0].requiredCapability = 'receive_user_answer';
  return proposal;
}
const humanTask = () => packet({ goal: 'Choose the scope of work.', proposedAnswer: 'Use option A.', successCriteria: ['Respect the user choice.'] });

for (const callerTime of ['2020-01-01T21:00:00+09:00', '2000-01-01T12:00:00.000Z']) test(`post-F helper receipt time is measured independently of caller provenance ${callerTime}`, async t => {
  const h = await harness(t);
  const first = await h.apply('inspect', initial);
  const source = evidence('dated-source', 'A source with its own retrieval time.', { retrievedAt: '2012-02-03T04:05:06.000Z' });
  const obs = observation('dated-observation', source);
  const input = receipt('dated-receipt', 'A caller-dated update.', [obs]);
  input.source.receivedAt = callerTime;
  const start = Date.now();
  const received = h.call('receive', '--input', await h.json(input));
  const end = Date.now(), item = received.session.updates[0];
  assert.equal(typeof item.helperReceivedAt, 'string', 'The helper must persist its own first accepted-at time');
  assert.match(item.helperReceivedAt, /Z$/);
  assert.ok(Date.parse(item.helperReceivedAt) >= start && Date.parse(item.helperReceivedAt) <= end);
  assert.equal(item.source.receivedAt, callerTime);
  assert.equal(item.observations[0].evidence[0].retrievedAt, source.retrievedAt);
  assert.deepEqual(received.state, first.state);
  assert.equal(item.payloadHash, checksum({ ...input, references: [] }));
  const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /helper実受領時刻/);
  assert.match(report.stdout, /caller申告時刻/);
  assert.match(report.stdout, /Evidence\.retrievedAt/);
  assert.ok(report.stdout.includes(item.helperReceivedAt));
  assert.ok(report.stdout.includes(callerTime));
  assert.ok(report.stdout.includes(source.retrievedAt));
});

test('post-F helper timestamp is output-only, hash-excluded and stable through redelivery/cache/replay', async t => {
  const h = await harness(t);
  const first = await h.apply('inspect', initial);
  const input = receipt('stable-time', 'A receipt with stable provenance.');
  input.source.receivedAt = '2020-01-01T00:00:00.000Z';
  const output = h.call('receive', '--input', await h.json(input));
  const item = output.session.updates[0];
  assert.equal(typeof item.helperReceivedAt, 'string', 'Receipt acceptance must record helperReceivedAt');
  assert.equal(item.payloadHash, checksum({ ...input, references: [], observations: [] }));
  const authority = join(h.dir, '.session', 'tombo-session.jsonl');
  const beforeReject = await readFile(authority, 'utf8');
  for (const changed of [{ ...input, helperReceivedAt: '1999-01-01T00:00:00Z' }, { ...input, source: { ...input.source, receivedAt: '2020-01-02T00:00:00.000Z' } }]) {
    const rejected = h.run('receive', '--input', await h.json(changed));
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_input');
    assert.equal(await readFile(authority, 'utf8'), beforeReject);
  }
  const duplicate = h.call('receive', '--input', await h.json(input));
  assert.equal(duplicate.session.updates.length, 1);
  assert.equal(duplicate.session.updates[0].helperReceivedAt, item.helperReceivedAt);
  assert.equal(duplicate.session.updates[0].payloadHash, item.payloadHash);
  await rm(join(h.dir, '.session', 'tombo-session.json'));
  await rm(h.state);
  const resumed = h.call('status');
  assert.equal(resumed.session.updates[0].helperReceivedAt, item.helperReceivedAt);
  assert.deepEqual(resumed.state.usage, first.state.usage);
  const event = JSON.parse((await readFile(authority, 'utf8')).trim().split('\n').at(-1));
  assert.equal(event.snapshot.updates[0].helperReceivedAt, item.helperReceivedAt);
  assert.equal((await sdk.replayJournal(h.ledger)).usage.modelCalls, first.state.usage.modelCalls);
});

test('post-F valid legacy receipt journal has unknown helper time and is never backfilled', async t => {
  const h = await harness(t);
  await h.apply('inspect', initial);
  const input = receipt('legacy-receipt', 'A valid old receipt without helper reception metadata.');
  const received = h.call('receive', '--input', await h.json(input));
  const authority = join(h.dir, '.session', 'tombo-session.jsonl');
  const events = (await readFile(authority, 'utf8')).trim().split('\n').map(JSON.parse);
  let previous = null;
  for (const event of events) {
    for (const item of event.snapshot.updates) delete item.helperReceivedAt;
    event.previousHash = previous ? checksum(previous) : null;
    event.snapshotHash = checksum(event.snapshot);
    previous = event;
  }
  await writeFile(authority, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  await rm(join(h.dir, '.session', 'tombo-session.json'));
  await rm(h.state);
  const resumed = h.call('status');
  assert.equal(resumed.session.updates[0].helperReceivedAt, undefined);
  const replayed = h.call('receive', '--input', await h.json(input));
  assert.equal(replayed.session.updates[0].helperReceivedAt, undefined);
  assert.equal(replayed.session.updates[0].payloadHash, received.session.updates[0].payloadHash);
  const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /helper実受領時刻: unknown/);
  assert.ok(report.stdout.includes(input.source.receivedAt));
});

test('post-F applied human receipt is distinct from a resolved gap and current completed reflection', async t => {
  const h = await harness(t, humanTask());
  expectUnderstanding(h.activation, { requiredGapIds: [], reflectionStatus: 'unavailable', canReportCompletion: false });
  const asked = await h.apply('inspect', humanProposal());
  assert.equal(asked.state.decision, 'needs_user_input');
  expectUnderstanding(asked, { requiredGapIds: ['gap'], reflectionStatus: 'missing', canReportCompletion: false });
  const answer = evidence('choice-A', 'I select option A.', { kind: 'user_statement' });
  const obs = observation('answer-A', answer, { toolCalls: 0 });
  h.call('receive', '--input', await h.json(receipt('answer-receipt', 'The user selected A.', [obs])));
  const applied = await h.apply('update', { assessments: [assessment(answer.id)] }, [obs]);
  assert.equal(applied.session.updates[0].status, 'applied');
  assert.equal(applied.state.claims[0].status, 'supported');
  assert.equal(applied.state.gaps[0].status, 'open');
  expectUnderstanding(applied, { requiredGapIds: ['gap'], reflectionStatus: 'missing', canReportCompletion: false });
  const confirmation = evidence('confirmation-A', 'I confirm option A is my priority.', { kind: 'user_statement' });
  const resolved = await h.apply('update', { assessments: [assessment(confirmation.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [confirmation.id], explanation: 'The explicit answer determines this declared choice.' }] }, [observation('confirm-A', confirmation, { toolCalls: 0 })]);
  assert.equal(resolved.state.decision, 'needs_reflection');
  expectUnderstanding(resolved, { requiredGapIds: [], reflectionStatus: 'missing', canReportCompletion: false });
  const current = await h.apply('reflect', {});
  expectUnderstanding(current, { requiredGapIds: [], reflectionStatus: 'completed', canReportCompletion: true });
});

test('post-F ambiguous human answer keeps the required gap while current reflection may complete', async t => {
  const h = await harness(t, humanTask());
  await h.apply('inspect', humanProposal());
  const answer = evidence('incomplete-choice', 'I care about both options and have not chosen a priority.', { kind: 'user_statement' });
  const updated = await h.apply('update', { assessments: [{ ...assessment(answer.id), verdict: 'inconclusive', reason: 'The user has not selected the declared option.' }] }, [observation('ambiguous-answer', answer, { toolCalls: 0 })]);
  assert.equal(updated.state.gaps[0].status, 'open');
  assert.equal(updated.state.decision, 'needs_user_input');
  expectUnderstanding(updated, { requiredGapIds: ['gap'], reflectionStatus: 'missing', canReportCompletion: false });
  const reflected = await h.apply('reflect', {});
  assert.equal(reflected.state.decision, 'needs_user_input');
  expectUnderstanding(reflected, { requiredGapIds: ['gap'], reflectionStatus: 'completed', canReportCompletion: false });
});

test('post-F optional gaps do not universally block current-step completion with or without required reflection', async t => {
  for (const reflectionRequired of [true, undefined]) {
    const h = await harness(t, packet({ reflectionRequired }));
    const optional = structuredClone(initial);
    optional.gaps[0].importance = 'optional';
    const first = await h.apply('inspect', optional);
    if (reflectionRequired) {
      expectUnderstanding(first, { requiredGapIds: [], reflectionStatus: 'missing', canReportCompletion: false });
      const ready = await h.apply('reflect', {});
      assert.equal(ready.state.gaps[0].status, 'open');
      expectUnderstanding(ready, { requiredGapIds: [], reflectionStatus: 'completed', canReportCompletion: true });
    } else {
      expectUnderstanding(first, { requiredGapIds: [], reflectionStatus: 'not_required', canReportCompletion: true });
    }
  }
});

test('post-F actual completed legacy reflection remains current without optional reflectionEffects metadata', async t => {
  const h = await harness(t);
  const first = await h.apply('inspect', { claims: initial.claims });
  const completed = await sdk.createTombo({ adapter: { async generate() { throw new Error('unused'); } } }).reflect(first.state, { async reflect(input) { return { binding: input.binding, reviewedClaimIds: ['claim'], completion: 'completed', limitations: ['Deterministic compatibility fixture.'], proposal: {}, usage: { totalTokens: null, outputTokens: 0, costYen: null } }; } });
  const { reflectionEffects, ...legacyState } = completed.state;
  assert.ok(reflectionEffects);
  assert.equal(sdk.understandingHash(legacyState), sdk.understandingHash(completed.state));
  sdk.validateState(legacyState);
  const { SessionStore } = await import(pathToFileURL(resolve('skills/tombo-view/scripts/session-store.mjs')).href);
  const store = new SessionStore(h.dir, sdk);
  await store.withLock(async () => { await store.load(); await store.reconcile(); await store.begin('reflect'); await store.commit(legacyState); });
  const current = h.call('status');
  assert.equal(current.state.reflectionEffects, undefined);
  assert.ok(current.state.reflection.binding.basedRevision < current.state.revision);
  expectUnderstanding(current, { requiredGapIds: [], reflectionStatus: 'completed', canReportCompletion: true });
});

test('post-F derived status and prepare reminder do not mutate SDK state, hash, binding or accounting', async t => {
  const h = await harness(t);
  expectUnderstanding(h.activation, { requiredGapIds: [], reflectionStatus: 'unavailable', canReportCompletion: false });
  const prep = await h.prepared('inspect');
  assert.ok(prep.value.instructions.startsWith(sdk.proposalGuidance));
  assert.ok(prep.value.instructions.length > sdk.proposalGuidance.length, 'Managed prepare retains original guidance and appends the bounded host reminder');
  const { ready } = await readyForInvalidation(h);
  const other = evidence('additional-current-source', 'The same runtime requirement is independently confirmed.');
  const changed = await h.apply('update', { assessments: [assessment(other.id)] }, [observation('new-material-check', other)]);
  assert.equal(changed.state.decision, 'needs_reflection');
  expectUnderstanding(changed, { requiredGapIds: [], reflectionStatus: 'stale', canReportCompletion: false });
  const before = structuredClone(changed.state), hash = sdk.understandingHash(before), ledger = await readFile(h.ledger, 'utf8');
  const first = await h.prepared('reflect');
  const second = await h.prepared('reflect');
  assert.deepEqual(first.value.binding, second.value.binding);
  assert.deepEqual(first.value.request, second.value.request);
  assert.ok(first.value.instructions.startsWith(sdk.reflectionGuidance));
  assert.ok(first.value.instructions.length > sdk.reflectionGuidance.length);
  assert.equal(Object.hasOwn(first.value.request, 'understandingStatus'), false);
  assert.equal(Object.hasOwn(first.value.binding, 'understandingStatus'), false);
  assert.equal(Object.hasOwn(first.value.state, 'understandingStatus'), false);
  const status = h.call('status');
  const report = h.run('report', '--state', h.state, '--ledger', h.ledger);
  assert.equal(report.status, 0, report.stderr);
  assert.deepEqual(status.state, before);
  assert.equal(sdk.understandingHash(status.state), hash);
  assert.equal(await readFile(h.ledger, 'utf8'), ledger);
  assert.match(report.stdout, /未解決の必須確認: なし/);
  assert.match(report.stdout, /現在の理解への再考: stale/);
  assert.match(report.stdout, /SDKの今回の段階の完了を報告可能: いいえ/);
  assert.notEqual(hash, ready.state.reflection.binding.understandingHash);
});

for (const reviewedClaimIds of [['claim'], []]) test(`post-F inconclusive reflection uses actual task/hash/claim coverage ${reviewedClaimIds.length}`, async t => {
  const h = await harness(t);
  await h.apply('inspect', initial);
  const { args, value } = await h.prepared('reflect');
  const input = await h.json({ binding: value.binding, reflection: { binding: value.request.binding, reviewedClaimIds, completion: 'inconclusive', limitations: ['The review could not be completed.'], proposal: {} } });
  const result = h.call('reflect', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', input);
  assert.equal(result.state.stopReason, 'reflection_inconclusive');
  assert.equal(result.state.reflectionEffects, undefined);
  expectUnderstanding(result, { requiredGapIds: ['gap'], reflectionStatus: reviewedClaimIds.length ? 'inconclusive' : 'stale', canReportCompletion: false });
});

test('post-F pending assessment and interrupted accounting remain incomplete without fabricated usage', async t => {
  const h = await harness(t);
  const first = await h.apply('inspect', initial);
  const source = evidence('pending', 'A real observation awaiting assessment.'), obs = observation('pending-execution', source);
  const { args, value } = await h.prepared('update', [obs]);
  const invalid = h.run('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('update', value, { assessments: [assessment('missing')] }));
  assert.equal(invalid.status, 1);
  const pending = JSON.parse(invalid.stdout);
  assert.deepEqual(pending.state.pendingAssessmentExecutionIds, [obs.executionId]);
  expectUnderstanding(pending, { requiredGapIds: ['gap'], reflectionStatus: 'missing', canReportCompletion: false });
  const another = await harness(t);
  const inspected = await another.apply('inspect', initial);
  const { SessionStore } = await import(pathToFileURL(resolve('skills/tombo-view/scripts/session-store.mjs')).href);
  const store = new SessionStore(another.dir, sdk);
  await store.withLock(async () => { await store.load(); await store.reconcile(); await store.begin('reflect'); });
  const uncertain = another.call('status');
  assert.equal(uncertain.session.accountingUncertain, true);
  assert.equal(uncertain.effectiveDecision, 'blocked');
  assert.deepEqual(uncertain.state.usage, inspected.state.usage);
  expectUnderstanding(uncertain, { requiredGapIds: ['gap'], reflectionStatus: 'missing', canReportCompletion: false });
  assert.equal(first.state.usage.modelCalls, 1);
});

const clockDescriptor = (duration = 10000, extra = {}) => ({ startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + duration).toISOString(), basis: 'first_observed', sourceRef: 'local:actual-test-clock-observation', ...extra });
async function waitUntilDeadline(clock) { await delay(Math.max(0, Date.parse(clock.deadlineAt) - Date.now()) + 80); }
async function openStore(h, operation) {
  const { SessionStore } = await import(pathToFileURL(resolve('skills/tombo-view/scripts/session-store.mjs')).href);
  const store = new SessionStore(h.dir, sdk);
  return store.withLock(async () => { await store.load(); await store.reconcile(); return operation(store); });
}
function assertTaskStop(result, previousState) {
  assert.equal(result.sessionStopReason?.reason, 'task_deadline_exceeded', 'The whole-task deadline must stop the helper independently of SDK budget');
  assert.equal(result.taskClockStatus.expired, true);
  assert.equal(result.effectiveDecision, 'blocked');
  assert.equal(result.understandingStatus.canReportCompletion, false);
  assert.equal(Object.hasOwn(result, 'request'), false);
  assert.equal(Object.hasOwn(result, 'binding'), false);
  if (previousState) {
    assert.equal(result.state.startedAt, previousState.startedAt);
    assert.deepEqual(result.state.task.budget, previousState.task.budget);
    assert.equal(result.state.stopReason, previousState.stopReason);
    assert.deepEqual(result.state.usage, previousState.usage);
    assert.equal(sdk.understandingHash(result.state), sdk.understandingHash(previousState));
  }
}

test('post-G undated receipts persist unknown provenance without invented dates and retain hash/collision semantics', async t => {
  const h = await harness(t);
  const input = receipt('undated', 'The source does not supply a reception date.');
  delete input.source.receivedAt;
  const start = Date.now();
  const result = h.call('receive', '--input', await h.json(input));
  const saved = result.session.updates[0];
  assert.equal(Object.hasOwn(saved.source, 'receivedAt'), false);
  assert.ok(Date.parse(saved.helperReceivedAt) >= start && Date.parse(saved.helperReceivedAt) <= Date.now());
  assert.equal(saved.payloadHash, checksum({ ...input, references: [] }));
  const replay = h.call('receive', '--input', await h.json(input));
  assert.deepEqual(replay.session.updates[0], saved);
  const addedDate = h.run('receive', '--input', await h.json({ ...input, source: { ...input.source, receivedAt: new Date().toISOString() } }));
  assert.equal(addedDate.status, 1);
  assert.equal(JSON.parse(addedDate.stderr).error.code, 'invalid_input');
  const report = h.run('report', '--ledger', h.ledger);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /caller申告時刻: unknown/);
});

test('post-G new future and zoneless dates reject before append or ID reservation and permit omission retry', async t => {
  const h = await harness(t);
  const authority = join(h.dir, '.session', 'tombo-session.jsonl');
  for (const [index, value] of [new Date(Date.now() + 3600000).toISOString(), '2020-01-01T12:00:00', 'not-a-date', null, '2025-02-30T12:00:00Z'].entries()) {
    const input = receipt(`invalid-date-${index}`, 'Undated material can still be received.');
    input.source.receivedAt = value;
    const before = await readFile(authority, 'utf8');
    const rejected = h.run('receive', '--input', await h.json(input));
    assert.equal(rejected.status, 1, `New invalid date must reject: ${value}`);
    assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_input');
    assert.equal(await readFile(authority, 'utf8'), before);
    delete input.source.receivedAt;
    const retried = h.call('receive', '--input', await h.json(input));
    assert.equal(retried.session.updates.filter(item => item.id === input.id).length, 1);
  }
  const tolerated = receipt('clock-skew', 'Provenance still unverified.');
  tolerated.source.receivedAt = new Date(Date.now() + 3000).toISOString();
  const saved = h.call('receive', '--input', await h.json(tolerated)).session.updates.at(-1);
  assert.equal(saved.source.receivedAt, tolerated.source.receivedAt);
});

test('post-G expired clock blocks before first inspect and null state reports without fabricated SDK usage', async t => {
  const clock = clockDescriptor(-500, { startedAt: new Date(Date.now() - 1000).toISOString() });
  const h = await harness(t, packet({}), clock);
  const prepared = h.call('prepare', '--input', h.input, '--ledger', h.ledger);
  assertTaskStop(prepared);
  assert.equal(prepared.state, null);
  assert.equal(prepared.session.binding.startedAt, null);
  assert.deepEqual(prepared.session.binding.budget, budget);
  const inspected = h.call('inspect', '--input', h.input, '--ledger', h.ledger, '--out', h.state);
  assertTaskStop(inspected);
  assert.equal(inspected.state, null);
  await assert.rejects(readFile(h.ledger), { code: 'ENOENT' });
  const report = h.run('report', '--ledger', h.ledger);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /SDK理解スナップショットは未生成/);
  assert.match(report.stdout.replaceAll('\\_', '_'), /task_deadline_exceeded/);
  assert.match(report.stdout.replaceAll('\\_', '_'), /first_observed/);
});

test('post-G actual task deadline between prepare and apply retains SDK budget and actual observations', async t => {
  const clock = clockDescriptor(2500);
  const h = await harness(t, packet({}), clock);
  const first = await h.apply('inspect', initial);
  const obs = observation('outside-whole-window', evidence('late-whole-source', 'Minimum differs.'));
  const { args, value } = await h.prepared('update', [obs]);
  const envelope = await h.envelope('update', value, { assessments: [assessment('late-whole-source')] });
  await waitUntilDeadline(clock);
  const late = h.call('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', envelope);
  assertTaskStop(late, first.state);
  assert.equal(late.state.stopReason, null);
  assert.equal(late.session.pendingUsage.toolCalls, 1);
  assert.equal(late.session.pendingUpdates[0].status, 'received_unassessed');
  const originalStop = late.sessionStopReason;
  const repeated = h.call('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', envelope);
  assert.deepEqual(repeated.sessionStopReason, originalStop);
  assert.equal(repeated.session.pendingUsage.toolCalls, 1);
  assert.equal(repeated.session.pendingUpdates[0].helperReceivedAt, late.session.pendingUpdates[0].helperReceivedAt);
});

test('post-G clock is sealed while in-budget operations and human answers can complete normally', async t => {
  const clock = clockDescriptor(15000);
  const h = await harness(t, humanTask(), clock);
  assert.equal(h.activation.taskClockStatus?.coverage, 'first_observed', 'The original observation must be represented, not SDK startedAt');
  const first = await h.apply('inspect', humanProposal());
  await delay(30);
  const answer = evidence('clock-human-answer', 'I select option A.', { kind: 'user_statement' });
  const obs = observation('clock-human-reply', answer, { toolCalls: 0 });
  const input = receipt('human-without-date', 'A real user answer.', [obs]); delete input.source.receivedAt;
  h.call('receive', '--input', await h.json(input));
  await rm(join(h.dir, '.session', 'tombo-session.json'));
  await rm(h.state);
  const resumed = h.call('status');
  assert.deepEqual(resumed.session.taskClock, h.activation.session.taskClock);
  assert.equal(resumed.session.binding.sessionId, first.session.binding.sessionId);
  await h.apply('update', { assessments: [assessment(answer.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [answer.id], explanation: 'The explicit user choice resolves the intended question.' }] }, [obs]);
  const ready = await h.apply('reflect', {});
  assert.equal(ready.understandingStatus.canReportCompletion, true);
  assert.equal(ready.sessionStopReason, null);
  assert.equal(ready.state.usage.toolCalls, 0);
  assert.ok(Date.parse(ready.state.startedAt) >= Date.parse(clock.startedAt));
  const omitted = h.call('activate', '--input', h.input, '--ledger', h.ledger, '--out', h.state);
  assert.deepEqual(omitted.session.taskClock, ready.session.taskClock);
  const clockFile = await h.json(clock);
  const redelivered = h.call('activate', '--input', h.input, '--ledger', h.ledger, '--out', h.state, '--task-clock', clockFile);
  assert.deepEqual(redelivered.session.taskClock, ready.session.taskClock);
  assert.equal(h.run('status', '--task-clock', clockFile).status, 1);
  assert.equal(h.run('prepare', '--state', h.state, '--ledger', h.ledger, '--task-clock', clockFile).status, 1);
});

test('post-G clock input validation and immutability do not retrofit a clockless legacy session', async t => {
  const clock = clockDescriptor();
  const h = await harness(t);
  const bad = [ { ...clock, basis: 'first_observed', startedAt: null }, { ...clock, startedAt: new Date(Date.now() + 60000).toISOString() }, { ...clock, deadlineAt: new Date(Date.parse(clock.startedAt) - 1).toISOString() }, { ...clock, deadlineAt: '2026-12-01T00:00:00' }, { ...clock, recordedAt: new Date().toISOString() } ];
  for (const descriptor of bad) await assert.rejects(openStore(h, store => store.activate(h.task, h.ledger, h.state, descriptor)), error => error.code === 'invalid_input' || error.code === 'revision_conflict');
  const original = h.call('status');
  assert.equal(original.taskClockStatus?.coverage, 'unavailable');
  assert.equal(original.taskClockStatus.startedAt, null);
  assert.equal(original.taskClockStatus.expired, null);
  await assert.rejects(openStore(h, store => store.activate(h.task, h.ledger, h.state, clock)), error => error.code === 'revision_conflict');
  const managed = await harness(t, packet({}), clock);
  await assert.rejects(openStore(managed, store => store.activate(managed.task, managed.ledger, managed.state, { ...clock, deadlineAt: new Date(Date.now() + 60000).toISOString() })), error => error.code === 'revision_conflict');
  await openStore(managed, store => store.activate(managed.task, managed.ledger, managed.state, clock));
  const before = await readFile(join(managed.dir, '.session', 'tombo-session.jsonl'), 'utf8');
  await assert.rejects(openStore(managed, async store => { store.snapshot.taskClock.deadlineAt = new Date(Date.now() + 60000).toISOString(); await store.append(); }), error => error.code === 'invalid_ledger' || error.code === 'revision_conflict');
  assert.equal(await readFile(join(managed.dir, '.session', 'tombo-session.jsonl'), 'utf8'), before);
});

test('post-G expired human wait permits undated receipt and pending withdrawal without changing old snapshot or stop', async t => {
  const clock = clockDescriptor(6000);
  const h = await harness(t, packet({}), clock);
  const { source, ready } = await readyForInvalidation(h);
  await waitUntilDeadline(clock);
  const input = receipt('after-wait', 'The user answered after waiting.'); delete input.source.receivedAt;
  const received = h.call('receive', '--input', await h.json(input));
  assertTaskStop(received, ready.state);
  const pending = h.call('invalidate', '--state', h.state, '--ledger', h.ledger, '--input', await h.json({ evidenceIds: [source.id], reason: 'The source was corrected after the whole-task deadline.' }));
  assertTaskStop(pending, ready.state);
  assert.equal(pending.state.evidence[0].validity, 'current');
  assert.equal(pending.session.pendingUpdates.length, 2);
  const report = h.run('report', '--ledger', h.ledger);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /撤回申告は未適用/);
  assert.equal(h.call('prepare', '--state', h.state, '--operation', 'reflect', '--ledger', h.ledger).request, undefined);
});

test('post-G recovery finishes an actually staged SDK commit then blocks new work at the same sealed deadline', async t => {
  for (const afterCommit of [false, true]) {
    const clock = clockDescriptor(3000);
    const h = await harness(t, packet({}), clock);
    const first = await h.apply('inspect', initial);
    const result = await sdk.createTombo({ adapter: { async generate() { return { proposal: {}, usage: { totalTokens: null, outputTokens: 0, costYen: null } }; } } }).update(first.state, []);
    await openStore(h, async store => { await store.begin('update'); await store.stage(result.state); if (afterCommit) await new sdk.FileJournal(h.ledger).commit(first.state.revision, result.state); });
    await waitUntilDeadline(clock);
    const recovered = h.call('status');
    assertTaskStop(recovered, result.state);
    assert.equal(recovered.state.revision, result.state.revision);
    assert.equal(recovered.session.pendingOperation, null);
    assert.deepEqual(recovered.session.taskClock, h.activation.session.taskClock);
  }
});

test('post-G a genuine transition archives the expired clock and usage while host unknown start stays unknown', async t => {
  const clock = clockDescriptor(2500);
  const h = await harness(t, packet({}), clock);
  const first = await h.apply('inspect', initial);
  await waitUntilDeadline(clock);
  const stopped = h.call('status');
  assert.equal(stopped.sessionStopReason?.reason, 'task_deadline_exceeded');
  const newTask = packet({ taskId: 'new-declared-goal', goal: 'Explain packaging terms.', successCriteria: ['Use the packaging licence.'] });
  const passage = 'Change to explaining packaging terms.';
  const change = { task: newTask, previousSessionId: stopped.session.binding.sessionId, reason: 'A real user changes the requested subject.', userChange: { id: 'clock-change', kind: 'user_statement', locator: 'conversation:clock-change', receivedAt: new Date().toISOString(), passage, contentHash: sdk.hashPassage(passage), previousGoal: h.task.goal, newGoal: newTask.goal, previousSuccessCriteria: h.task.successCriteria, newSuccessCriteria: newTask.successCriteria }, hand_over_summary: { unresolvedGapIds: ['gap'], unknowns: ['Old runtime requirement unresolved.'] } };
  const nextClock = clockDescriptor(10000, { startedAt: null, basis: 'host_provided', sourceRef: 'user:absolute-deadline' });
  const next = h.call('transition', '--input', await h.json(change), '--ledger', join(h.dir, 'next.jsonl'), '--out', join(h.dir, 'next.json'), '--task-clock', await h.json(nextClock));
  assert.deepEqual(next.session.transitions.at(-1).previous.taskClock, stopped.session.taskClock);
  assert.deepEqual(next.session.transitions.at(-1).previous.taskClockStop, stopped.session.taskClockStop);
  assert.deepEqual(next.session.transitions.at(-1).previous.usage, first.state.usage);
  assert.equal(next.taskClockStatus.startedAt, null);
  assert.equal(next.taskClockStatus.coverage, 'host_provided');
  assert.equal(next.sessionStopReason, null);
  assert.equal(next.state, null);
});

test('post-G exact legacy future and local dates replay unchanged with immutable-time diagnostics', async t => {
  for (const legacyDate of ['2040-01-01T12:00:00.000Z', '2000-01-01T12:00:00']) {
    const h = await harness(t);
    await h.apply('inspect', initial);
    const input = receipt('old-format', 'An immutable receipt accepted by the former contract.');
    const accepted = h.call('receive', '--input', await h.json(input)).session.updates[0];
    // Isolated compatibility fixture: project only old caller metadata; SDK state and helper witness stay unchanged.
    input.source.receivedAt = legacyDate;
    const authority = join(h.dir, '.session', 'tombo-session.jsonl');
    const events = (await readFile(authority, 'utf8')).trim().split('\n').map(JSON.parse);
    let previous = null;
    for (const event of events) {
      delete event.snapshot.taskClock;
      delete event.snapshot.taskClockStop;
      for (const update of event.snapshot.updates) {
        update.source.receivedAt = legacyDate;
        update.payloadHash = checksum({ ...input, references: [] });
      }
      event.previousHash = previous ? checksum(previous) : null;
      event.snapshotHash = checksum(event.snapshot);
      previous = event;
    }
    await writeFile(authority, events.map(item => JSON.stringify(item)).join('\n') + '\n');
    await rm(join(h.dir, '.session', 'tombo-session.json'));
    const replayed = h.call('receive', '--input', await h.json(input));
    assert.equal(replayed.taskClockStatus.coverage, 'unavailable');
    assert.equal(replayed.taskClockStatus.expired, null);
    const saved = replayed.session.updates[0];
    assert.equal(saved.helperReceivedAt, accepted.helperReceivedAt);
    assert.equal(saved.source.receivedAt, legacyDate);
    assert.equal(saved.payloadHash, checksum({ ...input, references: [] }));
    const changed = { ...input, source: { ...input.source } }; delete changed.source.receivedAt;
    assert.equal(h.run('receive', '--input', await h.json(changed)).status, 1);
    const report = h.run('report', '--ledger', h.ledger);
    assert.equal(report.status, 0, report.stderr);
    if (legacyDate.startsWith('2040')) assert.match(report.stdout, /保存済みhelper実受領時刻との不整合/);
    else assert.match(report.stdout, /caller申告時刻は未検証/);
  }
});

test('post-G real CLI activation seals an already closed host window with unknown original start', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-clock-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const taskPath = join(dir, 'task.json'), clockPath = join(dir, 'clock.json');
  const clock = clockDescriptor(-500, { basis: 'host_provided', startedAt: null, sourceRef: 'user:declared-absolute-deadline' });
  await writeFile(taskPath, JSON.stringify(packet({})));
  await writeFile(clockPath, JSON.stringify(clock));
  const start = Date.now();
  const output = spawnSync(process.execPath, [helper, 'activate', '--input', taskPath, '--ledger', join(dir, 'sdk.jsonl'), '--out', join(dir, 'state.json'), '--task-clock', clockPath], { cwd: dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assertTaskStop(result);
  assert.equal(result.taskClockStatus.coverage, 'host_provided');
  assert.equal(result.taskClockStatus.startedAt, null);
  assert.ok(Date.parse(result.session.taskClock.recordedAt) >= start && Date.parse(result.session.taskClock.recordedAt) <= Date.now());
  assert.equal(result.state, null);
  await assert.rejects(readFile(join(dir, 'sdk.jsonl')), { code: 'ENOENT' });
});

function f1ManagedRecord(state, operation, kind, target) {
  assert.ok(state.lastProposalRejection, 'F1 managed real semantic rejection must persist lastProposalRejection');
  assert.deepEqual(state.lastProposalRejection, { operation, taskId: state.taskId, atRevision: state.revision, understandingHash: sdk.understandingHash(state), code: 'invalid_model_output', kind, ...(target ? { target } : {}), rejectedAttempt: 1, maxAttempts: 1 });
  return state.lastProposalRejection;
}
async function f1ManagedFailure(h, { scope = 'project', inspect = true } = {}) {
  const first = inspect ? await h.apply('inspect', initial) : h.call('status');
  const ev = evidence('f1-source', 'F1_PRIVATE_PASSAGE_SENTINEL', { scope });
  const obs = observation('f1-execution', ev, { costYen: 3 });
  const input = receipt('f1-receipt', 'F1_PRIVATE_RECEIPT_SENTINEL', [obs]);
  delete input.source.receivedAt;
  h.call('receive', '--input', await h.json(input));
  const prepared = await h.prepared('update', [obs]);
  const bad = { resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [ev.id], explanation: 'F1_PRIVATE_EXPLANATION_SENTINEL' }] };
  const output = h.run('update', ...prepared.args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('update', prepared.value, bad));
  assert.equal(output.status, 1, output.stderr);
  const failed = JSON.parse(output.stdout);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  assert.equal(failed.state.usage.modelCalls, first.state.usage.modelCalls + 1);
  assert.equal(failed.state.usage.toolCalls, 1);
  assert.equal(failed.state.gaps[0].status, 'open');
  assert.equal(failed.state.gaps[0].resolution, undefined);
  assert.deepEqual(failed.state.pendingAssessmentExecutionIds, [obs.executionId]);
  assert.equal(failed.session.pendingUpdates[0].status, 'received_unassessed');
  return { first, failed, obs, ev, input };
}

test('F1 managed scope rejection survives SDK/session journals, cache deletion and new-process prepare without leaks', async t => {
  const h = await harness(t);
  const { failed, obs, ev } = await f1ManagedFailure(h, { scope: 'different-project' });
  const record = f1ManagedRecord(failed.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' });
  assert.equal(failed.state.evidence[0].scope, 'different-project');
  const replayed = await sdk.replayJournal(h.ledger);
  assert.deepEqual(replayed.lastProposalRejection, record);
  const event = JSON.parse((await readFile(join(h.dir, '.session', 'tombo-session.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.equal(event.snapshot.head.revision, failed.state.revision);
  await rm(join(h.dir, '.session', 'tombo-session.json')); await rm(h.state);
  const restored = h.call('status');
  assert.deepEqual(restored.state.lastProposalRejection, record);
  const prepared = await h.prepared('update', [obs]);
  assert.ok(prepared.value.request.validationFeedback, 'F1 fresh process must derive active rejection feedback');
  assert.equal(prepared.value.request.validationFeedback.code, 'invalid_model_output');
  assert.equal(prepared.value.request.validationFeedback.rejectedAttempt, 1);
  assert.equal(prepared.value.request.validationFeedback.maxAttempts, 1);
  assert.ok(prepared.value.request.validationFeedback.message.includes('gap'));
  assert.doesNotMatch(JSON.stringify(record) + prepared.value.request.validationFeedback.message, /F1_PRIVATE_|Zod|Resolution lacks/);
  const second = await h.prepared('update', [obs]);
  assert.deepEqual(second.value.binding, prepared.value.binding);
  assert.deepEqual(second.value.request.validationFeedback, prepared.value.request.validationFeedback);
  const fixed = h.call('update', ...prepared.args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('update', prepared.value, { assessments: [{ ...assessment(ev.id), verdict: 'inconclusive', scopeMatched: false, reason: 'The evidence scope does not establish this project requirement.' }] }));
  assert.equal(fixed.state.pendingAssessmentExecutionIds, undefined);
  assert.equal(fixed.state.lastProposalRejection, undefined);
  assert.equal(fixed.state.gaps[0].status, 'open');
  assert.equal(fixed.state.evidence[0].scope, 'different-project');
  assert.equal(fixed.state.usage.toolCalls, failed.state.usage.toolCalls);
  assert.equal(fixed.state.usage.modelCalls, failed.state.usage.modelCalls + 1);
});

test('F1 managed active feedback binds the exact retry and does not weaken partial/new/changed execution rejection', async t => {
  const h = await harness(t);
  const { failed, obs, ev } = await f1ManagedFailure(h);
  for (const changed of [[], [{ ...obs, toolCalls: 2 }], [{ ...obs, evidence: [{ ...ev, scope: 'other-scope' }] }], [obs, { ...obs, executionId: 'f1-unexecuted-addition' }]]) {
    const output = h.run('prepare', '--state', h.state, '--observations', await h.json(changed), '--ledger', h.ledger);
    assert.equal(output.status, 1);
  }
  const prepared = await h.prepared('update', [obs]);
  assert.ok(prepared.value.request.validationFeedback, 'F1 exact pending retry must provide real rejection feedback');
  const fixed = h.call('update', ...prepared.args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('update', prepared.value, { assessments: [assessment(ev.id)], resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [ev.id], explanation: 'The actual matching source supports the declared claim.' }] }));
  assert.equal(fixed.state.gaps[0].status, 'resolved');
  assert.equal(fixed.state.usage.toolCalls, failed.state.usage.toolCalls);
  assert.equal(fixed.state.usage.rounds, failed.state.usage.rounds + 1);
  assert.equal(fixed.state.usage.modelCalls, failed.state.usage.modelCalls + 1);
  assert.equal(fixed.state.lastProposalRejection, undefined);
  assert.equal(fixed.session.pendingUpdates.length, 0);
});

test('F1 managed completed reflection claim-coverage rejection gives current feedback and recovers within the same budget', async t => {
  const h = await harness(t);
  const first = await h.apply('inspect', { claims: initial.claims });
  const prepared = await h.prepared('reflect');
  const envelope = { binding: prepared.value.binding, reflection: { binding: prepared.value.request.binding, reviewedClaimIds: [], completion: 'completed', limitations: ['F1_PRIVATE_LIMITATION'], proposal: {} } };
  const output = h.run('reflect', ...prepared.args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.json(envelope));
  assert.equal(output.status, 1, output.stderr);
  const failed = JSON.parse(output.stdout);
  assert.equal(failed.state.usage.modelCalls, first.state.usage.modelCalls + 1);
  f1ManagedRecord(failed.state, 'reflect', 'reflection_claim_coverage_mismatch', { kind: 'claim', id: 'claim' });
  const retry = await h.prepared('reflect');
  assert.ok(retry.value.request.validationFeedback);
  assert.doesNotMatch(retry.value.request.validationFeedback.message, /F1_PRIVATE_/);
  const fixed = h.call('reflect', ...retry.args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.envelope('reflect', retry.value, {}));
  assert.equal(fixed.state.decision, 'ready_for_requested_step');
  assert.equal(fixed.state.usage.modelCalls, failed.state.usage.modelCalls + 1);
  assert.equal(fixed.state.lastProposalRejection, undefined);
});

test('F1 helper outer and inner reflection binding mismatches still reject before generation without a diagnostic', async t => {
  const h = await harness(t);
  const first = await h.apply('inspect', { claims: initial.claims });
  const prepared = await h.prepared('reflect'), before = await readFile(h.ledger, 'utf8');
  const valid = { binding: prepared.value.binding, reflection: { binding: prepared.value.request.binding, reviewedClaimIds: ['claim'], completion: 'completed', limitations: [], proposal: {} } };
  for (const bad of [{ ...valid, binding: { ...valid.binding, requestHash: '0'.repeat(64) } }, { ...valid, reflection: { ...valid.reflection, binding: { ...valid.reflection.binding, taskId: 'wrong-task' } } }]) {
    const output = h.run('reflect', ...prepared.args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.json(bad));
    assert.equal(output.status, 1);
    assert.equal(JSON.parse(output.stderr).error.code, 'revision_conflict');
    assert.equal(await readFile(h.ledger, 'utf8'), before);
  }
  const after = h.call('status');
  assert.equal(after.state.usage.modelCalls, first.state.usage.modelCalls);
  assert.equal(after.state.lastProposalRejection, undefined);
});

async function f1LegacyPrepare(t, state, operation, observations = []) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-f1-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'), obsPath = join(dir, 'obs.json');
  await writeFile(path, JSON.stringify(state)); await writeFile(obsPath, JSON.stringify(observations));
  const args = operation === 'reflect' ? ['--operation', 'reflect'] : ['--observations', obsPath];
  const output = spawnSync(process.execPath, [helper, 'prepare', '--state', path, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  assert.equal(output.status, 0, output.stderr);
  return JSON.parse(output.stdout);
}

test('F1 active newest metadata suppresses older repair fallback across operation, stale revision and stale hash', async t => {
  const h = await harness(t), { failed, obs } = await f1ManagedFailure(h);
  const record = f1ManagedRecord(failed.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' });
  const corruptCurrent = structuredClone(failed.state);
  corruptCurrent.lastProposalRejection.understandingHash = '0'.repeat(64);
  assert.throws(() => sdk.validateState(corruptCurrent), error => error.code === 'invalid_input');
  let calls = 0;
  const guarded = sdk.createTombo({ adapter: { async generate() { calls++; throw new Error('Corrupt current metadata must be rejected before generation.'); } } });
  await assert.rejects(guarded.update(corruptCurrent, [obs]), error => error.code === 'invalid_input');
  assert.equal(calls, 0);
  for (const mode of ['different-operation', 'past-revision', 'stale-hash']) {
    // Only diagnostic metadata is projected over a real failed state; no success, evidence, usage or authority is fabricated.
    const state = structuredClone(failed.state);
    state.modelRepairDiagnostics = [{ operation: mode === 'different-operation' ? 'reflect' : 'update', code: 'invalid_model_output', message: 'OLDER_REPAIR_SHOULD_NOT_REACTIVATE', rejectedAttempt: 1, maxAttempts: 2 }];
    if (mode === 'past-revision') state.lastProposalRejection.atRevision = state.revision - 1;
    if (mode === 'stale-hash') {
      state.lastProposalRejection.atRevision = state.revision - 1;
      state.lastProposalRejection.understandingHash = '0'.repeat(64);
    }
    sdk.validateState(state);
    const result = await f1LegacyPrepare(t, state, mode === 'different-operation' ? 'reflect' : 'update', [obs]);
    assert.equal(result.request.validationFeedback, undefined, `Inactive new record must suppress older fallback: ${mode}`);
  }
  const active = await h.prepared('update', [obs]);
  assert.equal(active.value.request.validationFeedback.code, record.code);
  assert.doesNotMatch(active.value.request.validationFeedback.message, /OLDER_REPAIR/);
});

test('F1 r2 retained inactive history suppresses older positive-repair feedback after managed invalidation', async t => {
  const h = await harness(t), first = await h.apply('inspect', initial);
  const ev = evidence('f1-old-repair-source', 'An actual source awaiting justified assessment.'), obs = observation('f1-old-repair-execution', ev, { costYen: 0 });
  let calls = 0;
  const api = sdk.createTombo({ maxModelRepairAttempts: 1, captureProposalRejection: true, adapter: { async generate() { calls++; return { proposal: { resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: [ev.id], explanation: 'The assessment is missing.' }] }, usage: { totalTokens: 2, outputTokens: 1, costYen: 0 } }; } } });
  const failed = await api.update(first.state, [obs]);
  assert.equal(calls, 2);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  assert.equal(failed.state.modelRepairDiagnostics.length, 2);
  assert.ok(failed.state.lastProposalRejection, 'F1 r2 coexistence requires the genuine opted-in terminal record before direct SessionStore setup');
  const record = structuredClone(failed.state.lastProposalRejection);
  assert.deepEqual(record, { operation: 'update', taskId: failed.state.taskId, atRevision: failed.state.revision, understandingHash: sdk.understandingHash(failed.state), code: 'invalid_model_output', kind: 'resolution_not_justified', target: { kind: 'gap', id: 'gap' }, rejectedAttempt: 2, maxAttempts: 2 });
  await openStore(h, async store => { await store.begin('update'); await store.commit(failed.state); await store.writeCache(h.state, { state: failed.state }); });
  const changed = h.call('invalidate', '--state', h.state, '--ledger', h.ledger, '--input', await h.json({ evidenceIds: [ev.id], reason: 'Withdraw the actual pending source.' }));
  assert.ok(changed.state.revision > failed.state.revision);
  assert.equal(changed.state.stopReason, 'invalid_model_output');
  assert.deepEqual(changed.state.lastProposalRejection, record);
  assert.ok(changed.state.lastProposalRejection.atRevision < changed.state.revision);
  assert.deepEqual(changed.state.usage, failed.state.usage);
  assert.equal(changed.state.modelRepairDiagnostics.length, 2);
  const prepared = await h.prepared('update', []);
  assert.equal(prepared.value.request.validationFeedback, undefined, 'Retained historical record is inactive and must suppress older repair-array fallback');
});

test('F1 expired whole-task gate retains history and prevents proposal retry without consuming model calls', async t => {
  const clock = clockDescriptor(3500), h = await harness(t, packet({}), clock);
  const { failed, obs } = await f1ManagedFailure(h);
  f1ManagedRecord(failed.state, 'update', 'resolution_not_justified', { kind: 'gap', id: 'gap' });
  await waitUntilDeadline(clock);
  const stopped = h.call('prepare', '--state', h.state, '--observations', await h.json([obs]), '--ledger', h.ledger);
  assert.equal(stopped.request, undefined);
  assert.equal(stopped.binding, undefined);
  assert.equal(stopped.sessionStopReason.reason, 'task_deadline_exceeded');
  assert.equal(stopped.state.usage.modelCalls, failed.state.usage.modelCalls);
  assert.deepEqual(stopped.state.lastProposalRejection, failed.state.lastProposalRejection);
  assert.equal(stopped.session.pendingUpdates[0].status, 'received_unassessed');
});
