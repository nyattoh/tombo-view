import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '../dist/index.js';

test('report explains inapplicable assessments with actionable, escaped references and replay limits', async () => {
  const passage = 'B only';
  const result = await sdk.createTombo({ adapter: { async generate() { return { usage: { totalTokens: null, outputTokens: 0, costYen: null }, proposal: { claims: [{ id: 'claim', role: 'answer_claim', text: 'A is covered.', scope: 'A' }], assessments: [{ claimId: 'claim', evidenceIds: ['source'], verdict: 'supports', scopeMatched: false, reason: '<script>Coverage is B only.</script>' }] } }; } } }).inspect({ schemaVersion: '0.1', taskId: 'scope-report', goal: 'Check A.', mode: 'explain', successCriteria: ['A coverage'], capabilities: [], evidence: [{ id: 'source', kind: 'document', locator: 'local:source', sourceGroup: 'document', retrievedAt: '2026-10-20T08:00:00.000Z', version: '1', scope: 'B', passage, contentHash: sdk.hashPassage(passage), validity: 'current' }], budget: { maxRounds: 2, maxModelCalls: 3, maxToolCalls: 2, maxElapsedMs: 120000, maxInputChars: 48000, maxOutputTokensPerCall: 4000 } });
  const text = sdk.renderMarkdownReport(result);
  assert.match(text, /適用できなかった証拠評価/, 'Report must expose why assessments were inapplicable');
  assert.match(text, /claim/);
  assert.match(text, /source/);
  assert.match(text, /モデルの解釈/);
  assert.match(text, /scope文字列の不一致/);
  assert.match(text, /適合する資料/);
  assert.match(text, /明示的な訂正/);
  assert.match(text, /再構成/);
  assert.doesNotMatch(text, /<script>/);
  const directory = await mkdtemp(join(tmpdir(), 'tombo-scope-report-'));
  try {
    const journal = new sdk.FileJournal(join(directory, 'events.jsonl'));
    await journal.commit(-1, result.state);
    const saved = sdk.renderMarkdownReport(await sdk.replayJournal(journal.path));
    assert.match(saved, /保存時の診断。本文未取得・未再検証/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
