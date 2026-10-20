# Acceptance 2 API readback (in progress)

2026-10-20 JST。`runtime/api-contract.md` 全文、`src/core.ts` checkpointBudget/generation条件、`scripts/session.mjs` 全文、`scripts/session-store.mjs` 全文を読取り照合。新規focused-r2.json / logで16/16、fail 0/skip 0、build exit 0を実確認。関連回帰/typecheck/境界試験はruntime担当が継続中というPM通知を保持し、全検証PASSとはしていない。

- task専用固定cwdから絶対helperを呼ぶ。statusがno-sessionを明示した場合だけactivate。親cwdにsessionがある子directoryでの再activateも拒否。
- activate --input/--ledger/--out。outはSDK cache binding、activate出力保存先ではない。ledger/cacheはcwd内・session authority外。既存unmanagedファイルのadoptionなし。
- managed prepare/reportはstdoutでout禁止。inspect/update/reflectのoutはbound stateのみ。ledger省略/交換を拒否。
- receiptはid/source(kind,locator,receivedAt)とtext/references/observationsの一つ以上。text/reference受領後のprepare/updateは同receipt IDを--receipt指定して実証拠へ関連付け。observations付きはSDK適用executionへ自動対応。受領だけでは評価済みにならない。
- checkpointBudgetは生成せず実elapsed/元budgetを検査。予算内ではSDK stateを変更しない。停止時は実state/元stopReasonを保持し、追加条件をbudgetCheckpointへ返す。prepare後/適用直前の期限切れはbinding/requestなしの停止JSON。exit 0はコマンド処理成功であり検証完了ではない。
- managedのstate.decisionは旧SDK snapshot、effectiveDecisionはpendingUpdates/予算/会計未確定を反映する。expired receiveは未評価保存。旧readyを新追補評価済みとしない。
- session authorityはcwd/.session/tombo-session.jsonl、SDK authorityはbound ledger。cache欠落は復元可能。中断で確定済み結果は同結果のみcommit復旧、結果不明はaccountingUncertainで停止。lockは自動奪取しない。
- transitionは実goal/successCriteria変更に限りuserChange本文/hash/実新旧条件とhand_over_summaryを要する。capabilityだけで通るとは書かない。旧未知/実stop/usage/未評価・未計上消費を保持する。
- host sandboxではない。別workspace/外部記録削除/SDK直接利用等までは統制しない。

## PM待合せ

実managed helperには現時点でinvalidateコマンドがない。旧CLI replay/invalidateをbound SDK ledgerへ直接commitするとsession正本と不一致になる。PMへ連絡済み。PMは前B04の資料更新→旧証拠撤回→同task再評価を失わない最小対応についてruntime/設計へ照会している。この部分のコマンドだけ確定通知を待つ。未実装managed invalidateを文書へ書いていない。

通常入口とREADMEは現確定APIで改訂中。validator/diff-check/保持確認は残る境界確定後に実行する。agents/openai.yamlは未変更。src/helper/test/docs記録には書込まない。費用/総token unknown。

## 更新契約の再読合わせ

PM通知後、更新api-contract.mdを全文再読しverification-summary.jsonとsession.mjsのretainExpiredObservationsを照合した。新規focused 19/19・fail 0/skip 0、関連回帰284/284、build/typecheck exit 0はruntime保存記録の確認であり、本担当の実行や受入2全PASSではない。

内部receiptのsource.receivedAtは同batchの初回実受領時刻を生成し、再配送では保存済み日時を再利用する。元のEvidence.retrievedAtは保持される。host-sessionのreceive節に反映した。managed invalidate未実装/限定design待ちという契約上の未達も明記されており、この欠落を境界だけで完了扱いしない。

## 最終契約確認とfreeze（2026-10-21）

Managed invalidate実GREEN通知後、api-contract.md全文と現helper/store/coreへ照合し、資料更新→managed撤回→同task update/fresh reflect、旧停止優先、discarded_unassessed/discardedAssessment、混在subset/未計上消費、transition破棄履歴、report別節、期限後未適用receipt/初回受領日時保持を製品docsへ反映した。機構待合せは解消。

さらにPM通知後の最終api-contract.md全文、managed-invalidate-handover.md、verification-summary-invalidate.jsonを読んだ。最終契約更新はfocused27/27・関連284/284・build/typecheck exit0とfreezeの追記で、文書化したAPIの変更はなかった。製品docsは再変更せず、final-readback.jsonの契約hashとreadback時刻のみ更新した。所有3docs・core/helper/storeは最終validator/readback時から不変、既存UIも不変、runtimeのfreeze source hashesも一致。7source freeze hashを保存した。

最終quick_validate/diff-checkはexit0で、以後製品docs変更がないため反復していない。PMは全npm test 705/705 pass・exit0/skip0を実行確認したと通知。本担当による実行とはしない。新raw forward・一般性能・受入2全体PASSは未主張。skill/docsはfreeze、以後追加変更はPMの具体的な指示まで行わない。
