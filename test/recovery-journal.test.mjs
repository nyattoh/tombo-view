import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTombo, FileJournal, hashPassage } from '../dist/index.js';

const timestamp = '2026-10-14T00:00:00.000Z';
const helper = resolve('skills/tombo-view/scripts/session.mjs');
const cli = resolve('dist/cli.js');
const initialProposal = {
  claims: [{ id: 'claim', role: 'answer_claim', text: 'The setting is enabled.', scope: 'config' }],
  lenses: [{ id: 'lens', label: 'Configuration', rationale: 'Check the setting.', origin: 'initial', status: 'active' }],
  gaps: [{ id: 'gap', kind: 'unsupported_claim', lensId: 'lens', question: 'Is the setting enabled?', triggerRefs: ['claim'], whyItMatters: 'The answer depends on it.', importance: 'required', claimIds: ['claim'], probeIds: ['probe'] }],
  probes: [{ id: 'probe', gapIds: ['gap'], method: 'corroboration', question: 'Read the setting.', requiredCapability: 'read_file', sourceGroups: ['config'], successCondition: 'Enabled.', refutationCondition: 'Disabled.', inconclusiveCondition: 'Unavailable.' }],
};
const invalidProposal = { assessments: [{ claimId: 'unknown', evidenceIds: ['observed'], verdict: 'supports', scopeMatched: true, reason: 'Invalid claim reference.' }] };
const repairedProposal = {
  assessments: [{ claimId: 'claim', evidenceIds: ['observed'], verdict: 'supports', scopeMatched: true, reason: 'The setting is enabled in the configuration.' }],
  resolutions: [{ gapId: 'gap', reason: 'supported', evidenceIds: ['observed'], explanation: 'The configuration confirms the setting.' }],
};
function evidence(id = 'observed') {
  const passage = 'enabled=true';
  return { id, kind: 'code', locator: 'config.txt', sourceGroup: 'config', retrievedAt: timestamp, version: '1', scope: 'config', passage, contentHash: hashPassage(passage), validity: 'current' };
}
function packet(budget = {}) {
  return { schemaVersion: '0.1', taskId: 'recovery-config', goal: 'Check the setting.', mode: 'explain', successCriteria: ['Cite the setting.'], evidence: [], capabilities: ['read_file'], budget: { maxRounds: 4, maxModelCalls: 6, maxToolCalls: 2, maxElapsedMs: 120000, maxInputChars: 48000, maxOutputTokensPerCall: 4000, ...budget } };
}
function observation(options = {}) {
  return { executionId: 'read-1', probeId: 'probe', outcome: 'completed', evidence: [evidence()], toolCalls: 1, elapsedMs: 10, costYen: 2, ...options };
}
function engine(proposals) {
  let index = 0;
  return createTombo({ now: () => Date.parse(timestamp), adapter: {
    estimateMaxCostYen: () => 1,
    async generate(input) {
      return { proposal: input.operation === 'inspect' ? initialProposal : proposals[index++], usage: { totalTokens: 4, outputTokens: 2, costYen: 1 } };
    },
  } });
}

test('SDK repairs a failed assessment without charging the execution twice, then deduplicates success', async () => {
  const tombo = engine([invalidProposal, repairedProposal]);
  const first = await tombo.inspect(packet({ maxToolCalls: 1, maxCostYen: 10 }));
  const failed = await tombo.update(first.state, [observation()]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  assert.equal(failed.state.claims[0].status, 'unverified');
  assert.deepEqual(failed.state.usage, { rounds: 1, modelCalls: 2, toolCalls: 1, elapsedMs: 10, totalTokens: 8, costYen: 4 });
  const repaired = await tombo.update(failed.state, [observation()]);
  assert.equal(repaired.state.decision, 'ready_for_requested_step');
  assert.equal(repaired.state.claims[0].status, 'supported');
  assert.equal(repaired.state.gaps[0].status, 'resolved');
  assert.deepEqual(repaired.state.usage, { rounds: 2, modelCalls: 3, toolCalls: 1, elapsedMs: 10, totalTokens: 12, costYen: 5 });
  assert.equal(repaired.state.revision, failed.state.revision + 1);
  assert.equal(repaired.state.appliedExecutions.length, 1);
  const duplicate = await tombo.update(repaired.state, [observation()]);
  assert.deepEqual(duplicate.state, repaired.state);
});

test('SDK rejects pending execution IDs that are unknown, duplicated or empty', async () => {
  const tombo = engine([invalidProposal, repairedProposal]);
  const first = await tombo.inspect(packet());
  const failed = await tombo.update(first.state, [observation()]);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  for (const pendingAssessmentExecutionIds of [['unknown'], ['read-1', 'read-1'], []]) {
    await assert.rejects(tombo.update({ ...failed.state, pendingAssessmentExecutionIds }, [observation()]), { code: 'invalid_input' });
  }
  const repaired = await tombo.update(failed.state, [observation()]);
  assert.equal(repaired.state.claims[0].status, 'supported');
  assert.equal(repaired.state.usage.modelCalls, 3);
});

test('SDK rejects a subset of a failed batch and permits a later complete repair', async () => {
  const tombo = engine([invalidProposal, repairedProposal]);
  const first = await tombo.inspect(packet());
  const observations = [observation(), observation({ executionId: 'read-2', evidence: [], outcome: 'no_result', costYen: 3 })];
  const failed = await tombo.update(first.state, observations);
  assert.equal(failed.state.stopReason, 'invalid_model_output');
  const subset = await tombo.update(failed.state, [observations[0]]);
  assert.equal(subset.state.stopReason, 'invalid_input');
  assert.equal(subset.state.usage.modelCalls, 2);
  assert.equal(subset.state.usage.toolCalls, 2);
  const superset = await tombo.update(subset.state, [...observations, observation({ executionId: 'read-3' })]);
  assert.equal(superset.state.stopReason, 'invalid_input');
  assert.equal(superset.state.usage.modelCalls, 2);
  assert.equal(superset.state.usage.toolCalls, 2);
  const collision = await tombo.update(superset.state, [observation({ elapsedMs: 11 }), observations[1]]);
  assert.equal(collision.state.stopReason, 'invalid_input');
  assert.equal(collision.state.usage.toolCalls, 2);
  const repaired = await tombo.update(collision.state, observations);
  assert.equal(repaired.state.decision, 'ready_for_requested_step');
  assert.equal(repaired.state.usage.modelCalls, 3);
  assert.equal(repaired.state.usage.toolCalls, 2);
  assert.equal(repaired.state.usage.costYen, 8);
});

test('SDK never resolves unsuccessful outcomes through an assessment repair', async t => {
  for (const outcome of ['no_result', 'unavailable', 'error']) await t.test(outcome, async () => {
    const resolution = { resolutions: [{ gapId: 'gap', reason: 'not_applicable', evidenceIds: ['original'], explanation: 'No successful observation.' }] };
    const tombo = engine([invalidProposal, resolution]);
    const first = await tombo.inspect({ ...packet(), evidence: [evidence('original')] });
    const obs = observation({ outcome, evidence: [] });
    const failed = await tombo.update(first.state, [obs]);
    assert.equal(failed.state.stopReason, 'invalid_model_output');
    const retried = await tombo.update(failed.state, [obs]);
    assert.equal(retried.state.usage.modelCalls, 3);
    assert.equal(retried.state.stopReason, 'invalid_model_output');
    assert.notEqual(retried.state.gaps[0].status, 'resolved');
    assert.equal(retried.state.usage.toolCalls, 1);
  });
});

test('SDK assessment repairs obey model, round, elapsed and monetary caps', async t => {
  for (const budget of [{ maxModelCalls: 2 }, { maxRounds: 1 }, { maxElapsedMs: 10 }, { maxCostYen: 4 }]) await t.test(JSON.stringify(budget), async () => {
    const tombo = engine([invalidProposal, repairedProposal]);
    const first = await tombo.inspect(packet(budget));
    const failed = await tombo.update(first.state, [observation()]);
    const retried = await tombo.update(failed.state, [observation()]);
    assert.equal(retried.state.stopReason, 'budget_exhausted');
    assert.equal(retried.state.claims[0].status, 'unverified');
    assert.equal(retried.state.usage.modelCalls, failed.state.usage.modelCalls);
    assert.equal(retried.state.usage.toolCalls, 1);
    assert.equal(retried.state.usage.rounds, failed.state.usage.rounds);
  });
});

test('journal commits reject a changed task snapshot under the same task ID', () => temporary(async directory => {
  const first = await engine([]).inspect(packet());
  const journal = new FileJournal(join(directory, 'events.jsonl'));
  await journal.commit(-1, first.state);
  const before = await readFile(journal.path, 'utf8');
  const fork = structuredClone(first.state);
  fork.revision++;
  fork.task.goal = 'A different task snapshot.';
  await assert.rejects(journal.commit(first.state.revision, fork), { code: 'revision_conflict' });
  assert.equal(await readFile(journal.path, 'utf8'), before);
}));

function run(path, ...args) {
  return spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
}
async function session(directory, task = packet()) {
  const paths = { task: join(directory, 'task.json'), state: join(directory, 'state.json'), obs: join(directory, 'obs.json'), plan: join(directory, 'plan.json'), ledger: join(directory, 'events.jsonl') };
  await writeFile(paths.task, JSON.stringify(task));
  const prepared = run(helper, 'prepare', '--input', paths.task);
  assert.equal(prepared.status, 0, prepared.stderr);
  await writeFile(paths.plan, JSON.stringify({ binding: JSON.parse(prepared.stdout).binding, proposal: initialProposal }));
  const inspected = run(helper, 'inspect', '--input', paths.task, '--proposal', paths.plan, '--out', paths.state, '--ledger', paths.ledger);
  assert.equal(inspected.status, 0, inspected.stderr);
  await writeFile(paths.obs, JSON.stringify([observation()]));
  return paths;
}
async function propose(paths, proposal = repairedProposal) {
  const prepared = run(helper, 'prepare', '--state', paths.state, '--observations', paths.obs);
  assert.equal(prepared.status, 0, prepared.stderr);
  await writeFile(paths.plan, JSON.stringify({ binding: JSON.parse(prepared.stdout).binding, proposal }));
}
async function temporary(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-recovery-'));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('session accepts exact journal input and rejects valid same-revision forks without appending', async t => {
  for (const field of ['goal', 'capabilities', 'budget', 'claim', 'usage', 'execution']) await t.test(field, () => temporary(async directory => {
    const paths = await session(directory);
    const before = await readFile(paths.ledger, 'utf8');
    const saved = JSON.parse(await readFile(paths.state, 'utf8'));
    if (field === 'goal') saved.state.task.goal = 'A different goal.';
    if (field === 'capabilities') saved.state.task.capabilities.push('network');
    if (field === 'budget') saved.state.task.budget.maxModelCalls++;
    if (field === 'claim') saved.state.claims[0].text = 'Another claim.';
    if (field === 'usage') saved.state.usage.modelCalls++;
    if (field === 'execution') saved.state.appliedExecutions.push({ executionId: 'invented', probeId: 'probe', outcome: 'completed', payloadHash: '0'.repeat(64) });
    await writeFile(paths.state, JSON.stringify(saved));
    await propose(paths);
    const rejected = run(helper, 'update', '--state', paths.state, '--observations', paths.obs, '--proposal', paths.plan, '--ledger', paths.ledger);
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stderr).error.code, 'revision_conflict');
    assert.equal(await readFile(paths.ledger, 'utf8'), before);
  }));
  await t.test('exact state', () => temporary(async directory => {
    const paths = await session(directory);
    const saved = JSON.parse(await readFile(paths.state, 'utf8'));
    saved.state.task = Object.fromEntries(Object.entries(saved.state.task).reverse());
    await writeFile(paths.state, JSON.stringify(saved));
    await propose(paths);
    const updated = run(helper, 'update', '--state', paths.state, '--observations', paths.obs, '--proposal', paths.plan, '--ledger', paths.ledger);
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(JSON.parse(updated.stdout).state.decision, 'ready_for_requested_step');
    assert.equal((await new FileJournal(paths.ledger).load()).revision, 2);
  }));
});

test('session restores exact source passages from a redacted journal and rejects changed passages', () => temporary(async directory => {
  const paths = await session(directory, { ...packet(), evidence: [evidence('original')] });
  await propose(paths);
  const updated = run(helper, 'update', '--state', paths.state, '--observations', paths.obs, '--proposal', paths.plan, '--ledger', paths.ledger);
  assert.equal(updated.status, 0, updated.stderr);
  const journal = new FileJournal(paths.ledger);
  const restored = await journal.load();
  for (const item of [...restored.evidence, ...restored.task.evidence]) {
    item.passage = 'enabled=true';
    delete item.passageUnavailable;
  }
  await writeFile(paths.state, JSON.stringify(restored));
  await propose(paths, {});
  const repeated = run(helper, 'update', '--state', paths.state, '--observations', paths.obs, '--proposal', paths.plan, '--ledger', paths.ledger);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).state.claims[0].status, 'supported');
  const before = await readFile(paths.ledger, 'utf8');
  const changed = restored.evidence.find(item => item.id === 'observed');
  changed.passage = 'enabled=false';
  changed.contentHash = hashPassage('enabled=false');
  await writeFile(paths.state, JSON.stringify(restored));
  await propose(paths, {});
  const fork = run(helper, 'update', '--state', paths.state, '--observations', paths.obs, '--proposal', paths.plan, '--ledger', paths.ledger);
  assert.equal(fork.status, 1);
  assert.equal(JSON.parse(fork.stderr).error.code, 'revision_conflict');
  assert.equal(await readFile(paths.ledger, 'utf8'), before);
}));

test('session persists an invalid assessment and repairs it against the same journal with one tool charge', () => temporary(async directory => {
  const paths = await session(directory);
  await propose(paths, invalidProposal);
  const failed = run(helper, 'update', '--state', paths.state, '--observations', paths.obs, '--proposal', paths.plan, '--ledger', paths.ledger);
  assert.equal(failed.status, 1);
  const saved = JSON.parse(failed.stdout);
  assert.equal(saved.state.stopReason, 'invalid_model_output');
  await writeFile(paths.state, JSON.stringify(saved));
  await propose(paths);
  const repaired = run(helper, 'update', '--state', paths.state, '--observations', paths.obs, '--proposal', paths.plan, '--ledger', paths.ledger);
  assert.equal(repaired.status, 0, repaired.stderr);
  const result = JSON.parse(repaired.stdout);
  assert.equal(result.state.decision, 'ready_for_requested_step');
  assert.equal(result.state.usage.toolCalls, 1);
  assert.equal(result.state.usage.modelCalls, 3);
  assert.equal((await new FileJournal(paths.ledger).load()).revision, 3);
}));

test('CLI rejects a same-revision cache fork before generation and keeps the ledger intact', () => temporary(async directory => {
  const paths = await session(directory);
  const before = await readFile(paths.ledger, 'utf8');
  const saved = JSON.parse(await readFile(paths.state, 'utf8')).state;
  saved.task.goal = 'A fork from the cache.';
  await writeFile(paths.state, JSON.stringify(saved));
  const adapter = join(directory, 'adapter.mjs');
  await writeFile(adapter, 'export default { generate() { throw new Error("Generation must not run for a fork."); } };');
  const rejected = run(cli, 'update', '--state', paths.state, '--observations', paths.obs, '--adapter', `file:${adapter}`, '--ledger', paths.ledger);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stderr ? JSON.parse(rejected.stderr).error.code : JSON.parse(rejected.stdout).stopReason, 'revision_conflict');
  assert.equal(await readFile(paths.ledger, 'utf8'), before);
}));
