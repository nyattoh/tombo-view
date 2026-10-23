import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as sdk from '../dist/index.js';

const helper = resolve(process.env.PR8_SESSION_HELPER_MODULE ?? 'skills/tombo-view/scripts/session.mjs');
const defaultStoreModule = resolve('skills/tombo-view/scripts/session-store.mjs');
const storePath = join('.session', 'tombo-session.jsonl');
const budget = { maxRounds: 8, maxModelCalls: 12, maxToolCalls: 8, maxElapsedMs: 60000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 };
const evidence = (id, passage, extra = {}) => ({ id, kind: 'document', locator: `local:${id}`, sourceGroup: 'source', retrievedAt: '2026-10-23T12:00:00.000Z', version: '1', scope: 'project', passage, contentHash: sdk.hashPassage(passage), validity: 'current', ...extra });
const packet = (extra = {}) => ({ schemaVersion: '0.1', taskId: 'r3-task', goal: 'Check the project runtime requirement.', mode: 'explain', successCriteria: ['Use the actual source.'], reflectionRequired: true, proposedAnswer: 'Node 24 is required.', evidence: [], capabilities: ['read', 'receive_user_answer'], budget, ...extra });
const initial = { claims: [{ id: 'claim', role: 'answer_claim', text: 'Node 24 is required.', scope: 'project' }], lenses: [{ id: 'lens', label: 'Runtime', rationale: 'Check the source.', origin: 'initial', status: 'active' }], gaps: [{ id: 'gap', lensId: 'lens', kind: 'unsupported_claim', question: 'What is required?', triggerRefs: ['claim'], whyItMatters: 'The answer depends on it.', importance: 'required', claimIds: ['claim'], probeIds: ['probe'] }], probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Read the source.', requiredCapability: 'read', sourceGroups: ['source'], successCondition: 'The minimum is 24.', refutationCondition: 'The minimum differs.', inconclusiveCondition: 'Unavailable.' }] };

async function harness(t, task = packet()) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-r3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = join(dir, 'sdk.jsonl'), state = join(dir, 'state.json'), input = join(dir, 'task.json');
  let sequence = 0;
  await writeFile(input, JSON.stringify(task));
  const json = async value => { const path = join(dir, `input-${sequence++}.json`); await writeFile(path, JSON.stringify(value)); return path; };
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  const call = (...args) => { const result = run(...args); assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); };
  const activate = () => call('activate', '--input', input, '--ledger', ledger, '--out', state);
  async function prepare(operation, observations) {
    const args = operation === 'inspect' ? ['--input', input] : ['--state', state];
    if (observations !== undefined) args.push('--observations', await json(observations));
    return { args, prepared: call('prepare', ...args, '--ledger', ledger) };
  }
  async function applyInspect(proposal = initial) {
    const { args, prepared } = await prepare('inspect');
    const output = call('inspect', ...args, '--ledger', ledger, '--out', state, '--proposal', await json({ binding: prepared.binding, proposal }));
    return output;
  }
  async function applyUpdate(observations, receiptIds = [], proposal = {}) {
    const { args, prepared } = await prepare('update', observations);
    const output = call('update', ...args, '--ledger', ledger, '--out', state, '--proposal', await json({ binding: prepared.binding, proposal }), ...receiptIds.flatMap(id => ['--receipt', id]));
    return output;
  }
  const receive = async value => run('receive', '--input', await json(value));
  return { dir, ledger, state, input, task, json, run, call, activate, prepare, applyInspect, applyUpdate, receive };
}

const receipt = (id, extra = {}) => ({ id, source: { kind: 'document', locator: `conversation:${id}`, receivedAt: new Date().toISOString() }, ...extra });
const observation = (executionId, probeId, ev) => ({ executionId, probeId, outcome: 'completed', evidence: [ev], toolCalls: 1, elapsedMs: 1, costYen: null });
const latestSessionEvent = async h => JSON.parse((await readFile(join(h.dir, storePath), 'utf8')).trim().split('\n').at(-1));

test('r3 contract 1 rejects altered activated inspect passage before begin and permits valid continuation', async t => {
  const sealedEvidence = evidence('sealed', 'The sealed source requires Node 24.');
  const h = await harness(t, packet({ evidence: [sealedEvidence] }));
  h.activate();
  const journalBeforeInvalidInputs = await readFile(join(h.dir, storePath), 'utf8');
  const altered = structuredClone(h.task);
  altered.evidence[0].passage = 'A changed passage with the old content hash.';
  await writeFile(h.input, JSON.stringify(altered));
  const staleHash = h.run('prepare', '--input', h.input, '--ledger', h.ledger);
  if (staleHash.status === 0) {
    const prepared = JSON.parse(staleHash.stdout);
    const inspected = h.run('inspect', '--input', h.input, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.json({ binding: prepared.binding, proposal: initial }));
    try { assert.equal(inspected.status, 1); } catch (error) { rejections.push(error.message); }
  }
  altered.evidence[0].contentHash = sdk.hashPassage(altered.evidence[0].passage);
  await writeFile(h.input, JSON.stringify(altered));
  const changedSealedPacket = h.run('prepare', '--input', h.input, '--ledger', h.ledger);
  const eventAfterReject = await latestSessionEvent(h);
  const rejections = [];
  try { assert.equal(staleHash.status, 1); } catch (error) { rejections.push(error.message); }
  try { assert.equal(JSON.parse(staleHash.stderr).error.code, 'invalid_input'); } catch (error) { rejections.push(error.message); }
  try { assert.equal(changedSealedPacket.status, 1); } catch (error) { rejections.push(error.message); }
  try { assert.equal(JSON.parse(changedSealedPacket.stderr).error.code, 'revision_conflict'); } catch (error) { rejections.push(error.message); }
  try { assert.equal(await readFile(join(h.dir, storePath), 'utf8'), journalBeforeInvalidInputs, 'invalid inspect inputs must not append'); } catch (error) { rejections.push(error.message); }
  try { assert.equal(eventAfterReject.snapshot.pendingOperation, null, 'tampered inspect must not open a pending operation'); } catch (error) { rejections.push(error.message); }
  try { assert.equal(eventAfterReject.snapshot.accountingUncertain, false); } catch (error) { rejections.push(error.message); }
  await writeFile(h.input, JSON.stringify(h.task));
  let continued;
  try {
    const { args: validArgs, prepared: validPrepared } = await h.prepare('inspect');
    continued = h.run('inspect', ...validArgs, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.json({ binding: validPrepared.binding, proposal: initial }));
  } catch (error) { rejections.push(error.message); }
  continued ??= { status: 1, stderr: '' };
  try { assert.equal(continued.status, 0, continued.stderr || continued.stdout); } catch (error) { rejections.push(error.message); }
  if (continued.status === 0) {
    const result = JSON.parse(continued.stdout);
    try { assert.equal(result.state.usage.modelCalls, 1); } catch (error) { rejections.push(error.message); }
    try { assert.equal(result.session.accountingUncertain, false); } catch (error) { rejections.push(error.message); }
  }
  assert.deepEqual(rejections, [], `R3 inspect preflight violated: ${rejections.join('; ')}`);
});

test('r3 contract 2 rejects an unknown observation probe before receipt append', async t => {
  const h = await harness(t);
  h.activate();
  await h.applyInspect();
  const before = await readFile(join(h.dir, storePath), 'utf8');
  const ev = evidence('unknown-probe-evidence', 'A real, hash-matched passage.');
  const rejected = await h.receive(receipt('unknown-probe', { observations: [observation('exec-unknown-probe', 'absent-probe', ev)] }));
  const after = await readFile(join(h.dir, storePath), 'utf8');
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_input');
  assert.equal(after, before, 'invalid observations must not append any session receipt or checkpoint');
});

test('r3 contract 2 rejects evidence ID collisions before receipt append', async t => {
  const registered = evidence('registered', 'Original registered passage.');
  const h = await harness(t, packet({ evidence: [registered] }));
  h.activate();
  await h.applyInspect();
  const before = await readFile(join(h.dir, storePath), 'utf8');
  const collision = evidence('registered', 'Different passage under an existing evidence ID.');
  const rejected = await h.receive(receipt('evidence-collision', { observations: [observation('exec-collision', 'probe', collision)] }));
  const after = await readFile(join(h.dir, storePath), 'utf8');
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_input');
  assert.equal(after, before, 'invalid observations must not append any session receipt or checkpoint');
});

test('r3 contract 3 keeps a linked text/reference receipt pending across actual managed invalid_input and applies on valid retry', async t => {
  const source = evidence('existing-source', 'An already recorded source passage.');
  const h = await harness(t, packet({ evidence: [source] }));
  h.activate();
  const inspected = await h.applyInspect();
  const received = await h.receive(receipt('unevaluated-reference', { references: [source.locator] }));
  assert.equal(received.status, 0, received.stderr);
  const invalidObservation = observation('unknown-probe-for-receipt', 'absent-probe', { ...source, id: 'unregistered-yet', passage: 'A hash matched new passage for the linked source.', contentHash: sdk.hashPassage('A hash matched new passage for the linked source.') });
  invalidObservation.evidence[0].locator = source.locator;
  const { args, prepared } = await h.prepare('update', [invalidObservation]);
  const invalidOutput = h.run('update', ...args, '--ledger', h.ledger, '--out', h.state, '--proposal', await h.json({ binding: prepared.binding, proposal: {} }), '--receipt', 'unevaluated-reference');
  assert.equal(invalidOutput.status, 1);
  const result = JSON.parse(invalidOutput.stdout);
  assert.equal(result.state.stopReason, 'invalid_input');
  assert.equal(result.state.usage.modelCalls, inspected.state.usage.modelCalls, 'invalid SDK input must not consume a model call');
  const saved = result.session.updates.find(item => item.id === 'unevaluated-reference');
  assert.equal(saved.status, 'received_unassessed');
  assert.equal(saved.appliedRevision, null);
  assert.equal(result.session.pendingUpdates.some(item => item.id === saved.id), true);
  const reloaded = h.call('status');
  const afterReload = reloaded.session.updates.find(item => item.id === saved.id);
  assert.equal(afterReload.status, 'received_unassessed');
  assert.equal(afterReload.appliedRevision, null);
  const evaluated = await h.applyUpdate([observation('evaluated-reference', 'probe', source)], ['unevaluated-reference']);
  const applied = evaluated.session.updates.find(item => item.id === 'unevaluated-reference');
  assert.equal(applied.status, 'applied');
  assert.equal(applied.appliedRevision, evaluated.state.revision);
  assert.equal(evaluated.session.pendingUpdates.some(item => item.id === applied.id), false);
});

test('r3 contract 2 accepts compatible scope-inapplicable evidence for actual assessment', async t => {
  const h = await harness(t);
  h.activate();
  await h.applyInspect();
  const ev = evidence('out-of-scope', 'This passage is outside the requested project.', { scope: 'another-project' });
  const obs = observation('out-of-scope-execution', 'probe', ev);
  const received = await h.receive(receipt('out-of-scope-receipt', { observations: [obs] }));
  assert.equal(received.status, 0, received.stderr);
  const result = await h.applyUpdate([obs], ['out-of-scope-receipt'], { assessments: [{ claimId: 'claim', evidenceIds: [ev.id], verdict: 'supports', scopeMatched: false, reason: 'The actual source is outside the requested project.' }] });
  assert.notEqual(result.state.stopReason, 'invalid_input');
  assert.equal(result.state.claims[0].assessments.some(item => item.evidenceIds.includes(ev.id) && !item.scopeMatched), true);
  assert.equal(result.session.updates.find(item => item.id === 'out-of-scope-receipt').status, 'applied');
});

test('r3 contract 2 accepts exact redelivery and rehydrates a legitimately redacted passage', async t => {
  const source = evidence('rehydratable-source', 'A passage temporarily redacted from the bound SDK state.');
  const h = await harness(t, packet({ evidence: [source] }));
  h.activate();
  await h.applyInspect();
  const { SessionStore } = await import(pathToFileURL(defaultStoreModule).href);
  const store = new SessionStore(h.dir, sdk);
  await store.withLock(async () => {
    await store.load();
    await store.reconcile();
    const redacted = structuredClone(store.state);
    for (const item of [redacted.evidence[0], redacted.task.evidence[0]]) {
      item.passage = '';
      item.passageUnavailable = true;
    }
    redacted.revision++;
    await store.begin('update');
    await store.commit(redacted);
  });
  const obs = observation('rehydrate-execution', 'probe', source);
  const receivedReceipt = receipt('rehydrate-receipt', { observations: [obs] });
  const firstReceive = await h.receive(receivedReceipt);
  assert.equal(firstReceive.status, 0, firstReceive.stderr);
  const item = firstReceive.stdout ? JSON.parse(firstReceive.stdout).session.updates[0] : h.call('status').session.updates[0];
  const replay = await h.receive(receivedReceipt);
  assert.equal(replay.status, 0, replay.stderr);
  const replayedItem = JSON.parse(replay.stdout).session.updates[0];
  assert.equal(replayedItem.payloadHash, item.payloadHash);
  assert.equal(replayedItem.helperReceivedAt, item.helperReceivedAt);
  assert.equal(JSON.parse(replay.stdout).session.updates.length, 1);
  const updated = await h.applyUpdate([obs], ['rehydrate-receipt']);
  assert.equal(updated.state.evidence[0].passage, source.passage);
  assert.equal(updated.state.evidence[0].passageUnavailable, undefined);
  assert.equal(updated.state.task.evidence[0].passage, source.passage);
  assert.equal(updated.state.task.evidence[0].passageUnavailable, undefined);
});

test('r3 contract 2 exact receipt replay survives a later evidence invalidation without rewriting history', async t => {
  const source = evidence('invalidated-source', 'A source that is later explicitly withdrawn.');
  const h = await harness(t, packet({ evidence: [source] }));
  h.activate();
  await h.applyInspect();
  const receivedPayload = receipt('replay-after-invalidation', { observations: [observation('replay-execution', 'probe', source)] });
  const original = JSON.parse((await h.receive(receivedPayload)).stdout).session.updates[0];
  const invalidation = await h.json({ evidenceIds: [source.id], reason: 'The source has been withdrawn.' });
  const invalidated = h.call('invalidate', '--state', h.state, '--input', invalidation, '--ledger', h.ledger);
  assert.equal(invalidated.state.evidence[0].validity, 'withdrawn');
  const replayedResult = await h.receive(receivedPayload);
  assert.equal(replayedResult.status, 0, replayedResult.stderr);
  const replayed = JSON.parse(replayedResult.stdout).session.updates[0];
  assert.equal(replayed.payloadHash, original.payloadHash);
  assert.equal(replayed.helperReceivedAt, original.helperReceivedAt);
  assert.equal(replayed.status, original.status);
  assert.equal(JSON.parse(replayedResult.stdout).session.updates.length, 1);
  const changedReplay = await h.receive({ ...receivedPayload, text: 'Different replay payload.' });
  assert.equal(changedReplay.status, 1);
  assert.equal(JSON.parse(changedReplay.stderr).error.code, 'invalid_input');
  const afterCollision = h.call('status').session.updates[0];
  assert.equal(afterCollision.payloadHash, original.payloadHash);
  assert.equal(afterCollision.helperReceivedAt, original.helperReceivedAt);
});

test('r3 contract 3 does not promote a reference receipt after a committed direct no-progress with no evaluation', async t => {
  const source = evidence('direct-existing-source', 'An already recorded source passage.');
  const h = await harness(t, packet({ evidence: [source] }));
  h.activate();
  await h.applyInspect();
  const received = await h.receive(receipt('direct-unevaluated-reference', { references: [source.locator] }));
  assert.equal(received.status, 0, received.stderr);
  const { SessionStore } = await import(pathToFileURL(process.env.PR8_SESSION_STORE_MODULE ?? defaultStoreModule).href);
  const store = new SessionStore(h.dir, sdk);
  let modelCalls = 0;
  await store.withLock(async () => {
    await store.load();
    await store.reconcile();
    await store.begin('update', null, ['direct-unevaluated-reference']);
    const result = await sdk.createTombo({ adapter: { async generate() { modelCalls++; throw new Error('unexpected generation'); } } }).update(store.state, []);
    assert.equal(result.state.stopReason, 'no_progress');
    await store.commit(result.state);
  });
  assert.equal(modelCalls, 0);
  const reloaded = h.call('status');
  const saved = reloaded.session.updates.find(item => item.id === 'direct-unevaluated-reference');
  assert.equal(saved.status, 'received_unassessed');
  assert.equal(saved.appliedRevision, null);
});

for (const selectedId of ['__proto__', 'constructor', 'toString']) test(`r3 review receipt ID ${selectedId} preserves selected and unselected application status after staged commit recovery`, async t => {
  const source = evidence(`opaque-id-source-${selectedId}`, 'An actual source linked to both text receipts.');
  const h = await harness(t, packet({ evidence: [source] }));
  h.activate();
  await h.applyInspect();
  const selected = receipt(selectedId, { references: [source.locator] });
  const unselectedId = `unselected-${selectedId}`;
  const unselected = receipt(unselectedId, { references: [source.locator] });
  const selectedReceive = await h.receive(selected);
  assert.equal(selectedReceive.status, 0, selectedReceive.stderr || selectedReceive.stdout);
  const unselectedReceive = await h.receive(unselected);
  assert.equal(unselectedReceive.status, 0, unselectedReceive.stderr || unselectedReceive.stdout);

  const { SessionStore } = await import(pathToFileURL(defaultStoreModule).href);
  const store = new SessionStore(h.dir, sdk);
  const obs = observation(`execution-${selectedId}`, 'probe', source);
  let sdkResult;
  await store.withLock(async () => {
    await store.load();
    await store.reconcile();
    const receiptExecutionIds = store.validateReceipts([selectedId], [obs]);
    await store.begin('update', { receiptExecutionIds }, [selectedId]);
    sdkResult = await sdk.createTombo({ adapter: { async generate() { return { proposal: {}, usage: { totalTokens: null, outputTokens: 0, costYen: null }, model: 'post-review-fixture' }; } } }).update(store.state, [obs]);
    assert.ok(sdkResult.state.appliedExecutions.some(item => item.executionId === obs.executionId), 'the real SDK result must contain the evaluated execution');
    assert.equal(sdkResult.state.pendingAssessmentExecutionIds, undefined);
    await store.stage(sdkResult.state);
    await new sdk.FileJournal(h.ledger).commit(store.state.revision, sdkResult.state);
  });

  const recovered = new SessionStore(h.dir, sdk);
  await recovered.withLock(async () => {
    await recovered.load();
    await recovered.reconcile();
  });
  const selectedReceipt = recovered.snapshot.updates.find(item => item.id === selectedId);
  const unselectedReceipt = recovered.snapshot.updates.find(item => item.id === unselectedId);
  assert.equal(selectedReceipt.status, 'applied', `selected ${selectedId} receipt must recover its committed application proof`);
  assert.equal(selectedReceipt.appliedRevision, sdkResult.state.revision);
  assert.equal(unselectedReceipt.status, 'received_unassessed', 'unselected receipt must not inherit another receipt ID proof');
  assert.equal(unselectedReceipt.appliedRevision, null);

  const reloaded = h.call('status');
  assert.equal(reloaded.session.updates.find(item => item.id === selectedId).status, 'applied');
  assert.equal(reloaded.session.updates.find(item => item.id === unselectedId).status, 'received_unassessed');
});

