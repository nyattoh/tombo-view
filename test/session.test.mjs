import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashPassage } from '../dist/index.js';

const helper = resolve('skills/tombo/scripts/session.mjs');
const budget = { maxRounds: 2, maxModelCalls: 3, maxToolCalls: 6, maxElapsedMs: 120000, maxInputChars: 48000, maxOutputTokensPerCall: 4000 };
const initialProposal = {
  claims: [{ id: 'c-requirement', role: 'answer_claim', text: 'このプロジェクトはNode.js 24以上が必要。', scope: 'project-config' }],
  lenses: [{ id: 'l-config', label: '動作条件', rationale: '設定を読んで回答案を確かめる。', origin: 'initial', status: 'active' }],
  gaps: [{ id: 'g-runtime', kind: 'unsupported_claim', lensId: 'l-config', question: '実際の最小Node.js版は何か。', triggerRefs: ['c-requirement'], whyItMatters: '利用者が使える環境を左右する。', importance: 'required', claimIds: ['c-requirement'], probeIds: ['p-config'] }],
  probes: [{ id: 'p-config', gapIds: ['g-runtime'], method: 'corroboration', question: 'package.jsonのenginesを確認する。', requiredCapability: 'read_file', sourceGroups: ['project-package'], successCondition: '>=24を指定している。', refutationCondition: '24以外の最小版を指定している。', inconclusiveCondition: '設定が取得できない。' }],
};
function run(...args) { return spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' }); }

test('host-authored proposals check an arbitrary task without fixture or extra API calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tombo-session-'));
  try {
    const task = join(directory, 'task.json'), plan = join(directory, 'proposal.json');
    const first = join(directory, 'first.json'), observations = join(directory, 'observations.json');
    const next = join(directory, 'next.json'), ledger = join(directory, 'events.jsonl');
    const packet = { schemaVersion: '0.1', taskId: 'arbitrary-user-config', goal: '回答案の動作条件を確認する。', mode: 'explain', successCriteria: ['設定の根拠を示す'], evidence: [], capabilities: ['read_file'], budget };
    await writeFile(task, JSON.stringify(packet));
    const context = run('prepare', '--input', task);
    assert.equal(context.status, 0, context.stderr);
    const binding = JSON.parse(context.stdout).binding;
    await writeFile(plan, JSON.stringify({ binding, proposal: initialProposal }));
    const inspected = run('inspect', '--input', task, '--proposal', plan, '--out', first, '--ledger', ledger);
    assert.equal(inspected.status, 0, inspected.stderr);
    const firstResult = JSON.parse(await readFile(first, 'utf8'));
    assert.equal(firstResult.state.decision, 'needs_check');
    assert.equal(firstResult.apiCallsMade, 0);
    assert.equal(firstResult.state.usage.totalTokens, null);
    assert.equal(firstResult.state.usage.costYen, null);
    const passage = '{"engines":{"node":">=22"}}';
    await writeFile(observations, JSON.stringify([{ executionId: 'read-config-1', probeId: 'p-config', outcome: 'completed', evidence: [{ id: 'e-config', kind: 'code', locator: 'package.json', sourceGroup: 'project-package', retrievedAt: '2026-10-14T00:00:00.000Z', version: 'working-tree', scope: 'project-config', passage, contentHash: hashPassage(passage), validity: 'current' }], toolCalls: 1, elapsedMs: 1, costYen: null }]));
    const updateContext = run('prepare', '--state', first, '--observations', observations);
    assert.equal(updateContext.status, 0, updateContext.stderr);
    const updateBinding = JSON.parse(updateContext.stdout).binding;
    const proposal = { assessments: [{ claimId: 'c-requirement', evidenceIds: ['e-config'], verdict: 'refutes', scopeMatched: true, reason: '設定の最小版は22である。' }], resolutions: [{ gapId: 'g-runtime', reason: 'refuted', evidenceIds: ['e-config'], explanation: '設定により回答案の条件を反証した。' }] };
    await writeFile(plan, JSON.stringify({ binding: updateBinding, proposal }));
    const updated = run('update', '--state', first, '--observations', observations, '--proposal', plan, '--out', next, '--ledger', ledger);
    assert.equal(updated.status, 0, updated.stderr);
    const result = JSON.parse(await readFile(next, 'utf8'));
    assert.equal(result.state.claims[0].status, 'contradicted');
    assert.equal(result.state.gaps[0].status, 'resolved');
    assert.equal(result.changes.some(c => c.after === 'contradicted'), true);
    const report = run('report', '--state', next);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /追加API呼出しは0件/);
    assert.match(report.stdout, /反証/);
    const replayedWrong = run('update', '--state', next, '--observations', observations, '--proposal', plan);
    assert.equal(replayedWrong.status, 1);
    assert.equal(JSON.parse(replayedWrong.stderr).error.code, 'revision_conflict');
    packet.proposedAnswer = 'Changed after proposal preparation';
    await writeFile(task, JSON.stringify(packet));
    await writeFile(plan, JSON.stringify({ binding, proposal: initialProposal }));
    const wrongInput = run('inspect', '--input', task, '--proposal', plan);
    assert.equal(wrongInput.status, 1);
    assert.equal(JSON.parse(wrongInput.stderr).error.code, 'revision_conflict');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
