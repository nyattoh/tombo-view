import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { understandingHash } from '../dist/core.js';
import { replayJournal } from '../dist/journal.js';

const cli = resolve('dist/cli.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-cli-reflection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state.json'), out = join(dir, 'next.json'), ledger = join(dir, 'events.jsonl');
  const task = { schemaVersion: '0.1', taskId: 'cli-reflection-contract', goal: 'Review the supplied contract claim.', mode: 'explain', successCriteria: ['Review the explicit claim.'], reflectionRequired: true, proposedAnswer: 'The operation is available.', evidence: [], capabilities: [], budget: { maxRounds: 4, maxModelCalls: 6, maxToolCalls: 2, maxElapsedMs: 60000, maxInputChars: 100000, maxOutputTokensPerCall: 1000 } };
  const input = join(dir, 'task.json'), adapter = join(dir, 'generation.mjs');
  await writeFile(input, JSON.stringify(task));
  await writeFile(adapter, `export default { async generate(input) { if (input.operation !== 'inspect' || input.task.taskId !== 'cli-reflection-contract') throw new Error('Unsupported test task'); return { proposal: { claims: [{ id: 'answer', role: 'answer_claim', text: 'The operation is available.', scope: 'contract-v1' }] }, usage: { totalTokens: 10, outputTokens: 5, costYen: 0 } }; } };`);
  const inspected = run('inspect', '--input', input, '--adapter', `file:${adapter}`, '--out', state, '--ledger', ledger);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).decision, 'needs_reflection');
  return { dir, state, out, ledger };
}
async function criticFile(dir, { completion = 'completed', binding = 'input.binding', exported = 'default' } = {}) {
  const file = join(dir, `critic-${exported}.mjs`);
  const value = `{ async reflect(input) { if (input.task.taskId !== 'cli-reflection-contract') throw new Error('Unsupported test task'); return { binding: ${binding}, reviewedClaimIds: ['answer'], completion: '${completion}', limitations: ['Synthetic contract test; no semantic correctness claim.'], proposal: {}, usage: { totalTokens: 10, outputTokens: 5, costYen: 0 } }; } }`;
  await writeFile(file, exported === 'default' ? `export default ${value};` : `export const critic = ${value};`);
  return `file:${file}`;
}

test('CLI reflect uses explicit default and named critics, persists fresh receipt and revision', async t => {
  const ctx = await setup(t);
  const result = run('reflect', '--state', ctx.state, '--critic', await criticFile(ctx.dir), '--out', ctx.out, '--ledger', ctx.ledger);
  assert.equal(result.status, 0, result.stderr);
  const next = JSON.parse(await readFile(ctx.out, 'utf8'));
  assert.equal(next.decision, 'ready_for_requested_step');
  assert.equal(next.revision, 2);
  assert.equal(next.usage.modelCalls, 2);
  assert.deepEqual(next.reflection.reviewedClaimIds, ['answer']);
  assert.equal(next.reflection.binding.understandingHash, understandingHash(next));
  assert.equal((await replayJournal(ctx.ledger)).revision, 2);
  const named = run('reflect', '--state', ctx.out, '--critic', await criticFile(ctx.dir, { exported: 'critic' }));
  assert.equal(named.status, 0, named.stderr);
  assert.equal(JSON.parse(named.stdout).revision, 3);
});

test('CLI reflect rejects stale and forked state before critic module side effects', async t => {
  const ctx = await setup(t);
  const marker = join(ctx.dir, 'side-effect.txt'), module = join(ctx.dir, 'side-effect.mjs');
  await writeFile(module, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default { reflect() { throw new Error('Unexpected'); } };`);
  const good = run('reflect', '--state', ctx.state, '--critic', await criticFile(ctx.dir), '--out', ctx.out, '--ledger', ctx.ledger);
  assert.equal(good.status, 0, good.stderr);
  const stale = run('reflect', '--state', ctx.state, '--critic', `file:${module}`, '--ledger', ctx.ledger);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stderr).error.code, 'revision_conflict');
  const fork = JSON.parse(await readFile(ctx.out, 'utf8'));
  fork.startedAt = '2026-10-14T01:00:00.000Z';
  await writeFile(ctx.out, JSON.stringify(fork));
  const forked = run('reflect', '--state', ctx.out, '--critic', `file:${module}`, '--ledger', ctx.ledger);
  assert.equal(forked.status, 1);
  assert.equal(JSON.parse(forked.stderr).error.code, 'revision_conflict');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal((await replayJournal(ctx.ledger)).revision, 2);
});

test('CLI reflect rejects missing, malformed and mismatched critics', async t => {
  const ctx = await setup(t);
  const missing = run('reflect', '--state', ctx.state);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'invalid_input');
  const module = join(ctx.dir, 'malformed.mjs');
  await writeFile(module, 'export default { generate() {} };');
  const malformed = run('reflect', '--state', ctx.state, '--critic', `file:${module}`);
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stderr).error.code, 'invalid_input');
  const mismatch = run('reflect', '--state', ctx.state, '--critic', await criticFile(ctx.dir, { binding: "{ ...input.binding, taskId: 'other' }" }));
  assert.equal(mismatch.status, 1);
  assert.equal(JSON.parse(mismatch.stdout).stopReason, 'invalid_model_output');
});

test('CLI inconclusive reflection is a meaningful stop with exit zero', async t => {
  const ctx = await setup(t);
  const result = run('reflect', '--state', ctx.state, '--critic', await criticFile(ctx.dir, { completion: 'inconclusive' }));
  assert.equal(result.status, 0, result.stderr);
  const next = JSON.parse(result.stdout);
  assert.equal(next.decision, 'blocked');
  assert.equal(next.stopReason, 'reflection_inconclusive');
});

test('CLI validates state and cache aliases before importing the critic', async t => {
  const ctx = await setup(t);
  const module = join(ctx.dir, 'guarded.mjs'), marker = join(ctx.dir, 'imported.txt');
  await writeFile(module, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default {};`);
  const badState = join(ctx.dir, 'invalid.json');
  await writeFile(badState, JSON.stringify({ schemaVersion: '0.1', taskId: 'cli-reflection-contract' }));
  const invalid = run('reflect', '--state', badState, '--critic', `file:${module}`);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'invalid_input');
  const originalLedger = await readFile(ctx.ledger, 'utf8');
  for (const out of [ctx.ledger, `${ctx.ledger}.lock`]) {
    const aliased = run('reflect', '--state', ctx.state, '--critic', `file:${module}`, '--out', out, '--ledger', ctx.ledger);
    assert.equal(aliased.status, 1);
    assert.equal(JSON.parse(aliased.stderr).error.code, 'invalid_input');
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(await readFile(ctx.ledger, 'utf8'), originalLedger);
});

test('CLI help exposes reflection and keeps inspect and version branding', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /TOMBO v0\.1/);
  assert.match(result.stdout, /tombo inspect/);
  assert.match(result.stdout, /tombo reflect .*--critic file:/);
});
