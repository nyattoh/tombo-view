import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createTombo, fixtureAdapter, FileJournal, replayJournal } from '../dist/index.js';

const directory = await mkdtemp(join(tmpdir(), 'tombo-demo-'));
try {
  for (const example of ['account', 'resend']) {
    const task = JSON.parse(await readFile(`examples/${example}/task.json`, 'utf8'));
    const observations = JSON.parse(await readFile(`examples/${example}/observations.json`, 'utf8'));
    const tombo = createTombo({ adapter: fixtureAdapter });
    const first = await tombo.inspect(task);
    assert.equal(first.state.decision, 'needs_check');
    const journal = new FileJournal(join(directory, `${example}.jsonl`));
    await journal.commit(-1, first.state);
    const next = await tombo.update(first.state, observations);
    assert.equal(next.state.gaps[0].status, 'resolved');
    assert.equal(next.state.claims.some(c => c.status === 'contradicted'), true);
    await journal.commit(first.state.revision, next.state);
    const restored = await replayJournal(journal.path);
    assert.equal(restored.revision, next.state.revision);
    assert.equal(restored.claims.some(c => c.status === 'contradicted'), true);
    assert.equal(restored.evidence.every(e => e.passage === '' && e.passageUnavailable === true), true);
    console.log(JSON.stringify({ label: '再生デモ / synthetic replay', case: example, before: first.state.decision, after: next.state.decision, claimStatuses: next.state.claims.map(c => c.status), revision: restored.revision }));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
