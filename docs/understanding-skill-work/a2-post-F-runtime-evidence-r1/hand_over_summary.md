# Post-F runtime handover

同runtime TDD writerの所有範囲の実装・検証を完了。新worker/PMなし。binding `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9` を再確認。全npm/新行動試験/独立full review/親監査はPM工程であり、この結果は受入2やモデル意味的実効性のPASSではない。費用/token unknown。

## 変更とsource

- `skills/tombo-view/scripts/session-store.mjs:306`: lock確認後、全入力/execution検証を通った初回receiptだけhelperReceivedAtを保存。normalized payloadHash、caller時刻、legacy再配送を維持。
- `skills/tombo-view/scripts/session.mjs:126`: managed prepareの既存guidance全文に短い共通reminderを追記。
- `skills/tombo-view/scripts/session.mjs:183`: state/request/binding外にunderstandingStatusを都度導出。core.ts:72のtask/hash/全claim coverage条件を使用し、basedRevision/reflectionEffects存在は条件にしない。
- `skills/tombo-view/scripts/session.mjs:194`: managed reportへ同じ3事実とhelper/caller/証拠の日時区別を加算。
- `test/session-followup.test.mjs:80,424,480`: 既存の実期限2件へassertion追加、新規12件（実helper/public SDK/決定論的adapter）。過去試験を弱めない。

core/types/report/cli/index/prompts/他tests/skilldocs/PMdocsは編集していない。core/types/report/binding試験はbefore.jsonとhash一致。旧失敗、705/712等のログ、歴史的untrackedは削除・巻戻ししていない。main checkout直接読取、raw case/observer読取、新依存/外部API、commit/push/PRなし。

## TDDと検証

|記録|実行結果|時刻 JST|
|---|---|---|
|red.json/log|exit1、14 tests / 0 pass / 14 assertion fail / skip0|01:46:46.699–01:47:06.703|
|green-r1.json/log|exit0、14/14、fail/skip0|01:49:24.478–01:49:52.501|
|build.log|npm run build、exit0|01:50:37.701–01:50:38.564|
|typecheck.log|npm run typecheck、exit0|01:50:38.564–01:50:39.199|
|focused.json/log|exit0、46/46、fail/skip0|01:51:03.806–01:51:59.213|
|regression.json/log|exit0、284/284、fail/skip0|01:51:14.036–01:51:26.319|

製品編集前REDはhelperReceivedAt未保存、legacy unknownのreport未表示、understandingStatus未公開の実assertion。schema/adapterエラーではない。red.logの全assertionをverification-summary.jsonへ収録。before.jsonのsnapshot後にテストを書きREDを実行し、製品の最初のmtimeはstore 01:49:21.588/helper 01:49:23.673 JSTでRED終了後。

```powershell
node --test --test-name-pattern='post-F|actual deadline|expired managed invalidate' test/session-followup.test.mjs
node --test test/session-budget-checkpoint.test.mjs test/session-binding.test.mjs test/session-followup.test.mjs
npm run build
npm run typecheck
```

関連回帰の省略なしexact command、各exit/開始終了時刻/実件数、ログhashはverification-summary.json。全npmは実行していない。全検証processは完了済み。

## 実確認と限界

future/past caller時刻を変換せずhelper時刻が実process区間内であること、output-only/元hash/時刻collision/再配送不変/cache削除/replay/legacy unknownを確認。内部deadline/撤回receiptも実時刻を保持し、開始時刻やEvidence.retrievedAtで代用しない。実deadline後のusage/旧snapshot/stopも保持。

human receiptがappliedでもrequired gapが残る場合は完了不可。実assessment+resolution後もreflectionがmissingなら不可、fresh reflection後のみready/completed。曖昧回答ではgap/needs_user_inputを残しつつ現在の再考completedを記録できる。optional gap、material updateでstale、unchanged hashのrevision進行、inconclusive/fullclaim欠落、pending assessment/会計不確定も確認。SDK state/hash/request/binding/ledger/usageを派生診断のために変更していない。

legacy互換試験は一時領域のvalid journalから任意helper timestampだけ省略したfixtureと、実public SDK reflectionの結果から任意reflectionEffectsだけを省略したprojectionを使う。semantic claims/receipt completion/hashを捏造した合格状態ではない。これらは決定論的invariant試験であり、モデルが自然な会話で適切に解決・再考する効力を保証しない。

## FreezeとAPI連携

source-freeze.jsonに所有3ファイルの開始前/最終SHA256・mtime・freeze時刻、保護4ファイルの不変hashを保存。所有3ファイルの最終hash:

```text
session-store.mjs 3221357fba1123a3f91a670da9a6af14eb53d53a1e04a0029cd9c35ca29eafa5
session.mjs       cb6c5e6b4fe528a44482aa20c068f2a2a60a681f1714ee8fb620ecfe44220269
session-followup.test.mjs 8c29a95a538c6ea027035a7425a1e4d98fcd6cba32d5e344c70f4f587deb3221
```

確定shape/commands/report/guidance契約はapi-contract.md、既存runtime/api-contract.mdへ追記。14/14の実GREEN時点でPMへ通知済み。source/testはfreeze、既知の所有範囲未完了なし。次工程はPMの統合全npm・同docs writer連携・fresh行動評価・独立full review・親監査。
