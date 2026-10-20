# hand_over_summary — acceptance 2 skill/docs final freeze

2026-10-21 JST。binding `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`。**担当3ファイルの改訂・実API照合・最終検証を完了し、skill/docsをfreezeした。受入2/goal全体のPASSではない。**

## 成果と変更範囲

- `skills/tombo-view/SKILL.md`: 理解への持続的関心と5行動を維持し、固定task cwdから絶対helper pathでstatus→初回だけactivate→同sessionのreceive/prepare/update/reflect/reportを通常入口にした。same-goal追補のtask/ledger/budget/start/usage/停止/証拠/理解を継続。資料撤回もmanaged invalidateから同task再評価へ戻す。
- `skills/tombo-view/references/host-session.md`: 実flags/JSONとauthority・初回起動・受領/評価・再考・期限切れ未評価保存・正当transition・復旧/host境界を段階開示した。通常利用者へ手書JSON/adapterや新APIを求めない。managed prepare/reportはstdout、適用outは固定state cache。新task/ledger/予算で同goal継続を成立させない。
- `README.md`: 日英usage/limitsを同期。旧A/B/C/Dの成功・失敗・partial、D01の会計継続失敗と一般効果未実証を保持し、追加session機構の存在をnew forward成功としない。結果はPMのbehavioural-evaluation.mdへリンク。

`agents/openai.yaml`は未変更。Hidden-Side/CrossRAG本文、README日英Hidden-Side節、既存fixed-state比較を保持。src/helper/store/tests/PM docs/歴史資料は読取りのみ。他writer変更を戻していない。global skill/host設定、新API/依存/secret操作、禁止main checkoutの直接参照なし。commit/push/PR未実施。費用・総token unknown。

## 承認・API実読合わせ

parent-authorized-scope-amendment-r1.md、locked-charter全文、a2-design-r1.md全文、a2-design-review-r1.md全文、skill-creator全文を読んだ。実cross-vendor design PASSを確認。runtime/api-contract.md全文と更新版、Managed invalidate追記と最終freeze版を読み、src/core.ts checkpointBudget、session.mjs/session-store.mjsへ照合した。読み合わせの過程はapi-readback.md。現文書に未実装APIや仮flagsは載せていない。

当初判明したmanaged invalidate欠落はPMへ返し、fresh限定design→runtime RED/GREEN→契約確定milestoneを待ってから文書化した。文書境界だけで欠落を完了扱いしていない。

## Managed invalidateで確定した意味

`node <helper> invalidate --state state.json --input invalidation.json --ledger sdk.jsonl --out state.json`。入力はstrictな既存 `{evidenceIds,reason}`、managed-only/非生成で、prepare/proposalは不要。旧CLIを使って管理ledgerを外部更新する経路は案内しない。

- 予算内の正常撤回はSDKの実needs_check等に従い、同taskの実観測update/fresh reflectへ進む。普遍blockedにはしない。既存stopReasonがある場合はその停止とblockedを優先する。
- 評価待ちbatchの破棄は評価成功ではない。discarded_unassessed/appliedRevision nullとdiscardedAssessment（atRevision/executionIds/invalidatedEvidenceIds/reason）を区別する。
- 混在receiptでは破棄subsetだけを履歴化し、残りの未評価executionはqueue/pendingUsageへ残す。残りが後に評価されても元receipt全体をappliedへしない。新しい単独receiptの実評価と区別し、同executionを二重計上しない。
- transitionはprevious.discardedUpdates/discardedAssessmentsを引き継ぐ。reportに「評価せず破棄した観測」を別表示。
- 期限後/会計不足/未確定ならevidence/claimsを撤回変更せず、未適用のinvalidation receiptを保存する。初回実受領時刻と再配送日時不変性、元retrievedAtを保持。旧snapshotの現在有効性・最新情報評価済みを主張しない。

正当transitionは実goal/successCriteria変更のuserChange証拠と旧会計/未知の保持を要する。capabilityだけで通るとは書かない。authority/cache/lock/消費未確定を説明し、管理通常経路をOS sandboxや全message interceptionと扱わない。

## 本担当が実行した最終検証

1. `PYTHONUTF8=1 python C:/Users/ryoko/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/tombo-view` → **exit 0**, `Skill is valid!`。実時刻は `validation.json`、出力は `quick-validate.log`。
2. `git diff --check -- skills/tombo-view/SKILL.md skills/tombo-view/references/host-session.md README.md` → **exit 0**。GitのCRLF→LF予告のみ。`diff-check.json`。
3. `preservation-check.json`：Hidden-Side本文、README日英Hidden-Side、fixed-state比較、UI保持の全項目true。製品テストの追加ではなく指定保持条件の確認。
4. 最終API追記後も製品docs/sourceの不変とruntime freeze hashesの一致を確認。`final-readback.json` に契約hash更新・7source freeze hashを記録。製品docsを変更していないのでpassed validatorを反復していない。

今回全体の担当差分は `acceptance2.patch`、開始snapshotは `before.json`。中間記録も上書きせず保持。terminal要約は `completion.json`。

## 他担当検証と未検証の境界

runtime保存記録で最終focused27/27、関連284/284、build/typecheck exit0を読取り確認（runtime/managed-invalidate-handover.md、verification-summary-invalidate.json、invalidate-focused-final.json/log、invalidate-regression.json/log）。最初の撤回GREEN8/8と専用RED2failも履歴のまま保持。これらはruntime担当が実行した決定的機構試験であり、本担当による実行や自発的モデル判断の成功ではない。

PMから全npm test 705/705 pass・exit0/skip0（2026-10-21 00:04:29–00:05:13 JST）の実行確認通知を受領。本担当は全npm testを実行していない。

新機構のfresh raw forwardは未実施/未主張。一般的なライブ性能・理解網羅・任意hostの自動discoveryを保証しない。実OS kill/時計逆行や追加の未実施組合せはruntimeの限界記録に従い、実証済みへ拡大しない。最終受入PASS、fresh full review、親監査、公開判断は同goal PM/親に残る。

## PMへ返す次工程

コード/skill/docs freezeを維持して、新raw-only独立評価とfresh full-diff reviewへ進む。draft-notes.mdの観測項目はPM用であり、observerへ期待行動や作者意図を渡さない。実期限後の同goal受領と旧会計保持、fresh process再開、人回答、反例、資料更新→managed撤回→same-task評価を実skillで観測する。本担当はPMの具体的な追加指示まで製品ファイルを編集しない。
