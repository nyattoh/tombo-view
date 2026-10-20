# Managed invalidate 最終 handover / freeze

2026-10-21 00:05 JST。binding `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`。同runtime writerの継続。**コード・テストはPM指示によりfreeze済み。担当範囲の実装/対象検証/記録は完了。goal/受入2全体のPASSはPM/親の統合判断に残す。**

## 変更と契約

今回の製品/試験変更は `skills/tombo-view/scripts/session.mjs`、`session-store.mjs`、`test/session-followup.test.mjs` の3ファイルのみ。結果は本runtime領域のみ。core/types/report/cli、旧テスト、skilldocs、PM docsへ書き込んでいない。他担当/過去tracked変更・untracked/旧監査・失敗を保持。commit/push/PR、新依存、直接有料API、secret/globalhook/禁止checkout参照なし。費用/tokenはunknown。

確定commands/flags/JSON shapeは `api-contract.md` のManaged invalidate節。PM経由でsame docs writerへ実GREENとともに連携済み。

```text
node <helper> invalidate --state state.json --input invalidation.json --ledger fixed-sdk.jsonl [--out fixed-state.json]
```

- strict inputは `{evidenceIds,reason}`。managed-only、固定binding/SDK正本照合を必須とする。
- 予算内は非生成SDK撤回を同session transactionへ通し、withdraw→gap/probe再開→同taskの新観測update/fresh reflectionを復元。
- 通常撤回は実SDKのneeds_check等に従い一律blockedにしない。既stopReasonがあれば理由とblockedを保持。budget/accounting/実停止のblockedをqueueでneeds_checkへ格上げしない。
- 破棄したpending batchは未評価履歴。receiptは `discarded_unassessed` / `appliedRevision:null` と `discardedAssessment{atRevision,executionIds,invalidatedEvidenceIds,reason}` を持つ。混在receiptの破棄subsetだけを記録し、未破棄/未評価executionをqueueと未計上消費から落とさない。
- 同execution/同payload再配送は衝突と扱わず実利用量を増やさない。新executionによる実評価は新しい単独receiptだけをappliedにでき、旧破棄receiptを誤昇格させない。
- transitionは `previous.discardedUpdates/discardedAssessments` に旧未評価破棄履歴を保持。reportに `評価せず破棄した観測` を別表示。
- 期限後/会計不足/未確定の撤回は旧SDK snapshotを変更せず、`unassessed-invalidate-*` receiptへ保存。初回実受領時刻と再配送日時不変性を守る。reportは「撤回申告は未適用」。

## Source行

- `session.mjs:57`: managed invalidate入口、2回の予算検査、同transaction commit。
- `session.mjs:173`: 未適用撤回のreceipt保存。
- `session.mjs:184`: budget/会計/既停止を優先するeffectiveDecision。
- `session.mjs:193`: 未評価破棄report節。`:213`: 未activation invalidateの拒否。
- `session-store.mjs:173`: reconcileで破棄batchの履歴を確定。
- `session-store.mjs:197`: before stop/pendingに基づくtransaction context検証。
- `session-store.mjs:205`: stageで既停止を保護し検証した結果を保存。`:221`: その正確なprepared stateをSDKへcommit。
- `session-store.mjs:263`: strict invalidation input、`:310`: 破棄subsetを評価済みへ誤昇格させないmarkApplied、`:329`: discarded view、`:350`: transition継承。
- `test/session-followup.test.mjs:262`: 通常循環、`:289`: redacted/cache復元、`:303`: 不正入力/binding/冪等/legacy拒否、`:328`: 既停止・混在会計・再配送・新execution/新単独receipt・transition/report。
- 同試験`:392`: stop/pendingのpublic transaction反例2件、`:421`: 実期限後receipt/日時、`:447`: SDK commit前/後復旧と外部commit拒否。

## TDDの実結果（以前のログを上書きしていない）

**製品変更前の入口RED**:

```text
node --test --test-name-pattern='managed invalidate|managed invalidation' test/session-followup.test.mjs
```

2026-10-20T23:53:58.1878899–23:54:13.2087543+09:00、exit 1。6 tests / pass 1 / fail 5 / skip 0。未実装command拒否のassert、既存transaction復旧1件成功。`invalidate-red.json/log`。

**製品変更前のstop/pending専用RED**:

```text
node --test --test-name-pattern='transaction preserves prior stop|transaction keeps discarded' test/session-followup.test.mjs
```

23:58:20.9607102–23:58:23.5541308、exit 1、2/2 fail、skip 0。実失敗は `null !== 'invalid_model_output'` と `'applied' !== 'discarded_unassessed'`。`invalidate-semantics-red.json/log`。core公開APIとsession公開transactionを使い、合格状態を直接改ざんしていない。

**最小製品変更後GREEN**:

入口REDと同じコマンド。2026-10-21T00:00:16.4580877–00:00:38.1842851、exit 0、8/8 pass / fail 0 / skip 0。`invalidate-focused-r1.json/log`。

**全focused**:

```text
node --test test/session-budget-checkpoint.test.mjs test/session-binding.test.mjs test/session-followup.test.mjs
```

00:02:58.4632961–00:03:41.5786644、exit 0、27/27 pass / fail 0 / skip 0。`invalidate-focused-final.json/log`。旧19件と撤回8件を現在の製品で再実行。混在subset/未計上実消費、同execution直接再配送、新単独receiptのapplied、新execution再評価、transition破棄履歴のassertを含む。

**関連回帰**:

```text
node --test test/core.test.mjs test/reflection.test.mjs test/model-repair.test.mjs test/assessment-correction.test.mjs test/assessment-correction-surfaces.test.mjs test/assessment-correction-journal.test.mjs test/assessment-scope-diagnostics.test.mjs test/assessment-scope-report.test.mjs test/ask-policy.test.mjs test/session.test.mjs test/session-repair-feedback.test.mjs test/host-session-framing.test.mjs test/recovery-journal.test.mjs test/cli-reflection.test.mjs test/cli-model-repair.test.mjs test/understanding-session.test.mjs
```

00:02:58.4625506–00:03:11.5010774、exit 0、284/284 pass / fail 0 / skip 0。`invalidate-regression.json/log`。旧`regression-r1`の284結果は保持し、別ログで再確認した。

**build/typecheck**:

```text
npm run build
npm run typecheck
```

00:02:44.3441824–00:02:45.8459045、各exit 0。`invalidate-build-typecheck.json`, `invalidate-build.log`, `invalidate-typecheck.log`。所有tracked helperの `git diff --check` exit 0。全 `npm test` は本担当では未実行、PMの `a2-integrated-npm-test-r1` に残す。

## Source hashes / freeze

完全なhash/mtime/command結果は `verification-summary-invalidate.json`。各sourceのmtimeは最終focused/回帰の開始以前。freeze後にコード・テストを編集していない。

```text
session.mjs      7ddc53b94e8c1159bc16adc68fe12f9290a2280aa5f3fa4cb347bf1e9ee45a0b
session-store.mjs 9d975899c84fa0500446c577f5b369848ff8c57104b37754bebcd6877c4f75b7
session-followup.test.mjs 480b3d776615641827a48eaf9cad14224943f1315f357550b09d7ec161322f06
core.ts         6642d469b4a005b124da7bdc215b7a0720461488f386ec6c70afc7939e52e260
```

coreのhashはmanaged invalidate追加前の `verification-summary.json` と一致する。

## 境界と残る統合工程

保証は保持された同workspaceのmanaged helper通常経路。host sandbox、虚偽userChangeの発話者認証、別workspace/SDK直呼び/外部の両正本改ざんを防ぐ保証ではない。redacted履歴は再検証ではない。未確定intentだけの中断やstale lockは自動で奪取/再生成せずfail closed。実OS kill/時計逆行の環境試験はしていない。

commit前/後復旧試験と、既停止/pendingのstage/commit試験は通過。freeze直前に予定したそれらの追加組合せ試験や会計未確定中の撤回専用試験は、PMのfreeze指示で追加していない。既存の会計未確定gate/receipt境界は全focusedに含むが、この未実施の組合せを個別実証済みとは扱わない。

実用上の自発的な通常経路使用は決定的試験だけでは実証していない。fresh raw-only行動評価、独立full-diff review、全npm統合、親監査、公開判断はPM/親担当。本担当の追加製品編集はfreeze解除と具体的な指示まで行わない。
