import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const budget = { maxRounds: 2, maxModelCalls: 3, maxToolCalls: 6, maxElapsedMs: 120000, maxInputChars: 48000, maxOutputTokensPerCall: 4000 };
const cases = [
  { folder: 'account', taskId: 'demo-account-close', goal: '架空アカウントの CLOSE 409 の原因を確認し、次の確認を選ぶ。', scope: 'synthetic-account-v1', probeId: 'p-account-contract', kind: 'document', initial: '架空ヘルプ v1: 担当者は管理画面で閉鎖を実行する。', passage: '架空規約 v1: CLOSE 409 は未完了の契約がある場合に返る。契約を完了または解約してから再度閉鎖する。', answer: '同じ閉鎖手順を再度実行すればよい。', capability: 'read_document' },
  { folder: 'resend', taskId: 'demo-event-resend', goal: '架空イベント処理が再送時に重複しないか確認する。', scope: 'synthetic-event-v1', probeId: 'p-event-resend', kind: 'test', initial: '架空実装 v1: 受信した各イベントを処理する。再送を区別する記録はない。', passage: '架空テスト v1: 同じイベント evt-1 を2回送信すると処理が2回行われ、重複処理が発生した。', answer: 'この処理は再送時にも重複しない。', capability: 'run_test' },
];
function evidence(id, passage, scope, kind) {
  return { id, kind, locator: `fixture:${id}`, sourceGroup: id, retrievedAt: '2026-10-14T00:00:00+09:00', version: 'v1', scope, passage, contentHash: createHash('sha256').update(passage).digest('hex'), validity: 'current' };
}
for (const c of cases) {
  const directory = `examples/${c.folder}`;
  await mkdir(directory, { recursive: true });
  const task = { schemaVersion: '0.1', taskId: c.taskId, goal: c.goal, mode: 'explain', successCriteria: ['架空資料またはテストに基づき、回答の前提を確認する。'], evidence: [evidence(c.folder === 'account' ? 'e-procedure' : 'e-code', c.initial, c.scope, c.folder === 'account' ? 'document' : 'code')], proposedAnswer: c.answer, capabilities: [c.capability], budget };
  const observations = [{ executionId: `execution-${c.folder}-1`, probeId: c.probeId, outcome: 'completed', evidence: [evidence(`e-${c.folder}-result`, c.passage, c.scope, c.kind)], toolCalls: 1, elapsedMs: 10, costYen: 0 }];
  await writeFile(`${directory}/task.json`, `${JSON.stringify(task, null, 2)}\n`);
  await writeFile(`${directory}/observations.json`, `${JSON.stringify(observations, null, 2)}\n`);
}
