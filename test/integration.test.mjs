import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTombo, fixtureAdapter, FileJournal, replayJournal } from '../dist/index.js';

const task = JSON.parse(await readFile('examples/account/task.json', 'utf8'));
const observations = JSON.parse(await readFile('examples/account/observations.json', 'utf8'));
const cli = resolve('dist/cli.js');
function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('journal replays validated states, redacts source passages, and rejects stale writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-journal-'));
  try {
    const tombo = createTombo({ adapter: fixtureAdapter });
    const first = await tombo.inspect(task);
    const next = await tombo.update(first.state, observations);
    const journal = new FileJournal(join(directory, 'events.jsonl'), join(directory, 'cache.json'));
    assert.equal((await journal.commit(-1, first.state)).cacheWritten, true);
    await journal.commit(first.state.revision, next.state);
    await assert.rejects(journal.commit(first.state.revision, next.state), { code: 'revision_conflict' });
    const restored = await replayJournal(journal.path);
    assert.equal(restored.revision, next.state.revision);
    assert.deepEqual(restored.usage, next.state.usage);
    assert.deepEqual(restored.claims, next.state.claims);
    const journalText = await readFile(journal.path, 'utf8');
    for (const e of [...task.evidence, ...observations[0].evidence]) assert.equal(journalText.includes(e.passage), false);
    assert.equal(restored.evidence.every(e => e.passageUnavailable && e.passage === ''), true);
    const cached = JSON.parse(await readFile(journal.cachePath, 'utf8'));
    assert.equal(cached.evidence.at(-1).passage, observations[0].evidence[0].passage);
    const events = journalText.trimEnd().split('\n');
    const tampered = JSON.parse(events[1]);
    tampered.state.usage.toolCalls += 10;
    events[1] = JSON.stringify(tampered);
    await writeFile(journal.path, `${events.join('\n')}\n`);
    await assert.rejects(replayJournal(journal.path), { code: 'invalid_ledger' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('competing commits have one winner; incomplete tails and stale locks never silently overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-conflict-'));
  try {
    const state = (await createTombo({ adapter: fixtureAdapter }).inspect(task)).state;
    const journal = new FileJournal(join(directory, 'events.jsonl'));
    const results = await Promise.allSettled([journal.commit(-1, state), journal.commit(-1, state)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'revision_conflict').length, 1);
    const valid = await readFile(journal.path, 'utf8');
    await writeFile(journal.path, `${valid}{"incomplete":`);
    await assert.rejects(replayJournal(journal.path), { code: 'invalid_ledger' });
    await writeFile(journal.path, valid);
    await writeFile(`${journal.path}.lock`, 'preserve');
    await assert.rejects(journal.commit(state.revision, { ...state, revision: state.revision + 1 }), { code: 'revision_conflict' });
    assert.equal(await readFile(`${journal.path}.lock`, 'utf8'), 'preserve');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a committed journal survives cache-write failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-cache-'));
  try {
    const state = (await createTombo({ adapter: fixtureAdapter }).inspect(task)).state;
    const blocker = join(directory, 'not-a-directory');
    await writeFile(blocker, 'file');
    const journal = new FileJournal(join(directory, 'events.jsonl'), join(blocker, 'cache.json'));
    assert.equal((await journal.commit(-1, state)).cacheWritten, false);
    assert.equal((await replayJournal(journal.path)).revision, state.revision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('journal cache aliases cannot overwrite the authoritative journal or lock', () => {
  const path = resolve('results/alias-journal.jsonl');
  assert.throws(() => new FileJournal(path, path), { code: 'invalid_input' });
  assert.throws(() => new FileJournal(path, `${path}.lock`), { code: 'invalid_input' });
  if (process.platform === 'win32') assert.throws(() => new FileJournal(path, path.toUpperCase()), { code: 'invalid_input' });
});

test('journal and CLI report reject fabricated evidence-linked state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-boundary-'));
  try {
    const state = (await createTombo({ adapter: fixtureAdapter }).inspect(task)).state;
    state.claims[0].status = 'supported';
    const journal = new FileJournal(join(directory, 'events.jsonl'));
    await assert.rejects(journal.commit(-1, state), { code: 'invalid_input' });
    const path = join(directory, 'fabricated.json');
    await writeFile(path, JSON.stringify(state));
    const report = run('report', '--state', path, '--format', 'markdown');
    assert.equal(report.status, 1);
    assert.equal(JSON.parse(report.stderr).error.code, 'invalid_input');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('real CLI inspect/update/report/replay and error exit codes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-cli-'));
  try {
    const state = join(directory, 'state.json'), next = join(directory, 'next.json');
    const ledger = join(directory, 'events.jsonl'), report = join(directory, 'report.md'), restored = join(directory, 'restored.json');
    const firstRun = run('inspect', '--input', 'examples/account/task.json', '--adapter', 'fixture', '--out', state, '--ledger', ledger);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    assert.equal(JSON.parse(await readFile(state, 'utf8')).decision, 'needs_check');
    const update = run('update', '--state', state, '--observations', 'examples/account/observations.json', '--adapter', 'fixture', '--out', next, '--ledger', ledger);
    assert.equal(update.status, 0, update.stderr);
    const updated = JSON.parse(await readFile(next, 'utf8'));
    assert.equal(updated.gaps[0].status, 'resolved');
    assert.equal(updated.claims.some(c => c.status === 'contradicted'), true);
    assert.equal(run('report', '--state', next, '--format', 'markdown', '--out', report).status, 0);
    assert.match(await readFile(report, 'utf8'), /CLOSE 409/);
    assert.equal(run('replay', '--ledger', ledger, '--out', restored).status, 0);
    assert.equal(JSON.parse(await readFile(restored, 'utf8')).revision, updated.revision);
    const stale = run('update', '--state', state, '--observations', 'examples/account/observations.json', '--adapter', 'fixture', '--ledger', ledger);
    assert.equal(stale.status, 1);
    assert.equal(JSON.parse(stale.stderr).error.code, 'revision_conflict');
    const bad = run('inspect', '--input', 'examples/account/task.json');
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stderr).error.code, 'invalid_input');
    assert.equal(run('replay', '--ledger', ledger, '--out', ledger).status, 1);
    assert.equal((await replayJournal(ledger)).revision, updated.revision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('evaluation data splits families and balances controls without leaking annotations into inputs', async () => {
  const cases = JSON.parse(await readFile('evaluation/cases.json', 'utf8'));
  const annotations = JSON.parse(await readFile('evaluation/annotations.json', 'utf8'));
  assert.equal(cases.length, 48);
  assert.equal(new Set(cases.map(c => c.family)).size, 48);
  assert.equal(cases.some(c => 'requiredGap' in c), false);
  for (const domain of ['development', 'automation', 'research']) {
    for (const split of ['development', 'evaluation']) {
      const subset = cases.filter(c => c.domain === domain && c.split === split);
      assert.equal(subset.length, 8);
      const ids = new Set(subset.map(c => c.id));
      assert.equal(annotations.filter(a => ids.has(a.id) && a.control).length, 2);
    }
  }
});
