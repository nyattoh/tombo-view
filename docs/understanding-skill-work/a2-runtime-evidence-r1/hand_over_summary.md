# Acceptance 2 runtime handover

## 現在地

binding `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`。2026-10-20 JST。

割当範囲のactivated session、未評価追補、非生成checkpoint、transaction復旧を実装・検証した。**受入2全体のPASSは未宣言。managed invalidateの欠落を実再現し、PMのfresh限定design check待ちで実装を保留している。** 既存19 focused / 284関連回帰 / build/typecheckは以下のfresh実結果。

追加承認、locked charter全文、a2-design-r1、a2-design-review-r1の明示PASSを実装前に確認。旧design/監査/失敗記録を置換していない。親AGENTS/skill-creator原則を継続適用した。禁止されたmain checkoutを直接参照していない。新依存・有料API直接呼出し・secret/held-out/Ommatidia・globalhook・Hidden-Side/CrossRAG変更なし。commit/push/PRなし。費用/tokenはunknown。

## 変更ファイル / source行

- `src/core.ts:438`: 既存生成budget条件を共通関数へ抽出。`:443` 独立export `checkpointBudget`。既存types/index/report/schemaは変更していない。
- `skills/tombo-view/scripts/session-store.mjs:13`: canonical path。`:41` SessionStore。`:136` activate、`:148` binding guard、`:156` reconcile、`:188` begin、`:194` stage、`:203` commit、`:221` checkpoint、`:244` receive、`:292` view/pending accounting、`:303` transition。
- `skills/tombo-view/scripts/session.mjs:28`: managed入口。`:148` expired観測の内部receipt。`:155` effectiveDecision、`:161` snapshot/未評価/会計を区別するreport。未activationの既存分岐は維持。
- 新規 `test/session-budget-checkpoint.test.mjs`: 5 tests。
- 新規 `test/session-binding.test.mjs`: 6 tests。
- 新規 `test/session-followup.test.mjs`: 8 tests。
- 結果と診断scriptは本 `results/understanding-acceptance2/runtime/` のみ。旧src/report/types/既存test/skilldocs/PM所有docsには今回書き込んでいない。過去変更とuntracked資料を保持。

確定commands/flags/出力fields/receipt/transition schema/authority境界は `api-contract.md`。

## RED → 最小修正 → GREEN

共通focusedコマンド:

```text
node --test test/session-budget-checkpoint.test.mjs test/session-binding.test.mjs test/session-followup.test.mjs
```

1. **製品変更前RED**: 23:29:09.2798438–23:29:11.4796047 +09:00。exit 1、14件中pass 0 / fail 14 / skip 0。`red.json/log`。checkpointBudget exportがundefined、activateが旧command whitelistで拒否されるassertionを実確認。直前の `npm run build` exit 0は `baseline-build.log` とred.jsonへ記録。
2. **初回実装確認**: `focused-r1.json/log`。exit 1、pass 12 / fail 2。未確定消費のprepare明示拒否とreportのMarkdown escaping検査が残った。前者は製品を修正、後者は既存rendererの実escapeに合わせてassertを正確化。
3. **追加境界RED**: 23:36:09.1515244–23:36:20.4097373。exit 1、16件中pass 12 / fail 4 / skip 0。`pending-usage-red.json/log`。未作成パスのWindows case正規化、pending実消費のbudget検査、未確定prepare拒否。これらの製品修正前に追加試験で再現した。
4. **GREEN**: `focused-r2.json/log` は16/16、exit 0、skip 0。対応buildは `build-r2.log`、exit 0。SDK commit前中断、pending評価失敗の再配送、参照だけのreceipt対応付けを追加した `boundary-r1.json/log` は19/19、exit 0。
5. **PM timestamp所見の専用RED**:

```text
node --test --test-name-pattern='actual deadline' test/session-followup.test.mjs
```

23:41:52.2509729–23:41:58.2843602。exit 1、1 fail、skip 0。`receipt-time-red.json/log`。失敗assertion: `The internal receipt records actual first reception, not SDK startedAt`。初回実受領時刻を記録し、同内部receipt再配送でその時刻を再利用する2行の最小修正を行った。元evidence.retrievedAtは変更しない。

6. **最終focused GREEN**: 23:42:24.3748078–23:42:41.6759536。上記共通コマンドexit 0、19/19 pass / fail 0 / skip 0。`focused-final.json/log`。実5000ms deadlineのprepare→apply超過、初回受領時刻の実clock範囲、再配送日時不変性を含む。テスト用時刻指定CLIは追加していない。

## 関連回帰 / 型検査

23:39:58–23:40:09 JST、次のfresh実行はexit 0、284/284 pass / fail 0 / skip 0。

```text
node --test test/core.test.mjs test/reflection.test.mjs test/model-repair.test.mjs test/assessment-correction.test.mjs test/assessment-correction-surfaces.test.mjs test/assessment-correction-journal.test.mjs test/assessment-scope-diagnostics.test.mjs test/assessment-scope-report.test.mjs test/ask-policy.test.mjs test/session.test.mjs test/session-repair-feedback.test.mjs test/host-session-framing.test.mjs test/recovery-journal.test.mjs test/cli-reflection.test.mjs test/cli-model-repair.test.mjs test/understanding-session.test.mjs
```

`regression-r1.json/log`。`npm run typecheck` は23:39:58 JST、exit 0、`typecheck.json/log`。この回帰以降の製品変更は内部receiptのsource.receivedAtのみで、当該managed経路は最終focusedで検証済み。既存試験は変更していない。

全 `npm test` は依頼どおり未実行でPM統合担当。過去678件のPASSを今回の証拠へ流用していない。所有trackedファイルの `git diff --check` はexit 0。

## 実確認した動作

public SDKと実helper subprocessで状態を作成し、合格用の直接state改ざんはしていない。改ざん試験では意図的に不正state/rollbackを作って拒否を検査し、成功状態には採用していない。

- canonical workspace/ledger/out/taskHashを固定。新TaskPacket/ledger/out/ledger省略/再inspectでの新予算逃避を拒否。初回startedAtをsealしready後も同session。
- 予算内prepareはSDK state/revision/hashを変えず、自分のcheckpointで正常applyのbindingを破壊しない。
- 実時間で期限を越えたapplyは生成せず停止をSDK journalへ保存し、旧理解/evidence/start/budget/実利用量を維持。期限後追補はprobe未定でもreceiveし未評価のまま保存・再開。
- 既に発生した観測の未計上tool/costをsessionへ保持。同executionの複数receiptとSDK登録を二重計上せず、ID/payload衝突を拒否。pending実消費が上限を超えた場合もSDK usageへ偽加算せず生成停止。
- ready後の新反例でeffectiveDecisionをneeds_checkへ戻し、実updateでdisputed/openへ再評価。人回答はuser_statementとして同sessionで更新し、fresh reflection後ready。
- receiveだけではSDK evidenceへ昇格しない。参照だけのreceiptは実観測locatorの一致を検査して適用revisionへ対応。失敗したassessmentのreceiptは未評価のまま、同batch再配送で実tool回数を増やさず回復。
- SDK commit前/後のsession中断をtransaction記録から回復し、管理外SDK commitやrollbackを黙って採用しない。結果未確定の生成中断はaccountingUncertain、effective blocked、prepare/apply拒否。
- cache欠落は正本から復元。redacted状態のcheckpointは本文取得/モデル生成を要求しない。赤塗りを再検証済みとは表示しない。
- 正当なtransitionはuserChange参照と新旧条件/hash、旧unknowns/未解決gap/利用量/stop/未評価追補への参照を必須にし、同goalのrenameだけでは許可しない。

## 未達・未確認とPMへの次の条件

1. **managed invalidate欠落**: `managed-invalidate-diagnosis.mjs` を実行（script exit 0）。legacy CLI撤回exit 0でwithdrawn/unverifiedとなるが、session statusはrevision_conflict/exit 1。`managed-invalidate-diagnosis.json`。最小案/予算内・期限後/意味あるRED対象は `managed-invalidate-proposal.md`。PMがfresh Google `understanding-a2-invalidate-design-r1` を実startedし、PASS前実装保留を明示。保留を守る。
2. host sandboxではない。別作業領域、SDK/CLI直呼び、session正本の削除、両正本の同時改ざん、虚偽userChangeの発話者認証を強制的に防ぐ機構ではない。
3. 強制終了で残ったsession/SDK lockは自動奪取しない。journal/staged resultの復旧は試験したが、実OS killによるstale lock処理は明示的な復旧が必要。hostの改ざん不能message IDは未提供。clock逆行はfail closedの実装があるが、OS時計を実際に戻す試験はしていない。
4. 費用/tokenはunknown。決定的な台本検証であり、自発的な通常経路使用や一般的な効果は未実証。fresh raw-only行動試験、独立full-diff review、全npm test、親監査はPM担当。
