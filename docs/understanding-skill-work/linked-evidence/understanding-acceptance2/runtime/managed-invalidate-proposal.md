# Managed invalidate: PM限定design check用の診断・最小案

状態: **提案のみ。製品変更は未実施。** 2026-10-20 JST。今回の追加実装可否はPMのfresh限定design checkを待つ。

## 現在の問題

既存SDK `invalidate` は同taskで証拠をwithdrawnにし、支持/反証を再計算して必要gap/probeを再開する非生成操作。現在のhelperはmanaged transaction外のSDK変更を正しく拒否する一方、managed invalidate入口がない。したがってlegacy CLIで撤回した後はsession reconcileに失敗し、資料更新→旧証拠撤回→同task更新の通常経路を失う。これは反例・訂正・再開の範囲を狭める実装上の欠落で、文書の境界説明だけでは代替しない。

実再現は `managed-invalidate-diagnosis.mjs` と `.json`。public API/実helperのactivated ready stateからlegacy CLI invalidateはexit 0でSDK revisionを進める。その後managed statusはrevision_conflict/exit 1となる。gateを弱めて任意の外部commitを取り込む案は推奨しない。

## 所有範囲内の最小機構案

`session.mjs` にmanaged-only `invalidate --state state.json --input invalidation.json --ledger fixed-sdk.jsonl [--out fixed-state.json]` を追加する。入力shapeは既存SDKの `{evidenceIds,reason}`。`session-store.mjs` の既存begin→stage→SDK commit→seal transactionを再利用する。`src/types.ts`, `src/report.ts`, `src/cli.ts` は変更不要。未activated legacy helperに新機能を広げる必要もない。

**予算内:** binding・SDK正本・state一致と生成無しcheckpointを確認。`createTombo(...).invalidate(state,input)` を呼び、同session/task/ledger/start/budget/実usageを保持してcommit。証拠の撤回とgap再開はSDK既存ルールのまま。modelCalls/rounds/toolCallsを増やさず、古いreflectionは既存SDKに従い失効する。同じ入力の再配送で既にwithdrawnなら同revisionを維持する。

**期限後の推奨案:** まず既存checkpointで実停止を保存。その後、撤回依頼のevidence IDs/reasonと現資料参照を、専用内部receiptとして受領済み・未評価に保存する。旧理解snapshot/旧証拠は変更せず、effectiveDecisionはblocked。新予算・新task・新しい検査を開始しない。receiptの初回実受領日時とID/payloadの再配送/衝突規則を守る。旧証拠が現時点でも有効だという主張を避け、reportには撤回申告が未適用であることを明示する。

**限定reviewで判断が必要な点:** 非生成の撤回を期限後にも即時適用する案も可能だが、それはSDKのclaims/evidence/理解を変更するため、今回設計の「期限後追補を未評価保存し旧理解snapshotを保持」と整合させる明示判断が要る。撤回は新しい支持評価とは異なるが、勝手に停止境界の例外へしない。現提案は上記の保守的な未評価保存を推奨する。

## RED対象

1. managed ready→実撤回→同task更新→新しいreflectionの実helper循環。旧sourceはwithdrawn、支持claimはunverified/openへ戻り、新sourceだけを使って再評価する。session/task/start/budgetが同一、実usage増加は実際のupdate/reflectのみ。
2. cache欠落/replay後のredacted stateでも非生成撤回自体は可能で、本文取得を偽装しない。
3. malformed IDs/理由、他task/state/ledger/out、省略ledger、二重配送は既存整合性ルールで拒否または冪等。任意のlegacy CLI commitは引続き拒否する。
4. SDK commit前/後の中断は既存transaction復旧に従う。撤回時にpendingAssessmentを破棄する既存SDK意味を保持し、未評価receiptを勝手にappliedへ変換しない。
5. 実期限超過後のinvalidate要求はblocked/旧理解/実usageを維持し、撤回申告を未評価保存する。再配送は新受領時刻を捏造せず、sessionIdや予算を変えない。

上記の追加source ownershipは不要（現在割当helper/store/新規followup試験/結果領域で足りる）。ただし現在は提案と診断ログのみで、まだcommand/schema/通常経路へ昇格しない。費用/tokenはunknown。
