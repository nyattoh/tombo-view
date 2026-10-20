# F1 proposed API test contract — RED only

実装済みAPIの確定契約ではない。fresh design C1–C5とRED試験が要求する将来契約。製品sourceは未変更、GREEN未実施。

## 提案形状

既存createTomboへ提案中の任意captureProposalRejection:boolean（default false）。現行はこの未実装optionを無視する。新CLI flag/API名は作っていない。helper managedのみ将来opt-inする設計。

提案中state.lastProposalRejectionは一件のobject:

```text
operation: update|reflect
taskId: actual returned state.taskId
atRevision: actual returned failed revision
understandingHash: actual returned semantic understandingHash
code: invalid_model_output
kind: resolution_not_justified|reflection_binding_mismatch|reflection_claim_coverage_mismatch|proposal_validation_failed
target?: {kind:gap|claim|probe|lens,id:bounded safe existing ID}
rejectedAttempt / maxAttempts: actual automatic attempt counts
```

初回inspect0 throw、既定opt-out、既存positive repair/usage/claimless gap/F2 immutabilityを維持。内部SDK guardのprivate provenanceでspecific kindを作り、adapter lookalike・schema body・new候補/evidence IDはgeneric/no target。whitespace/control付きの既存IDをglobalに禁止せずoptional targetだけ省略。本文/理由/生Zod/例外文字列を保存しない。

managed prepareとenvelope再計算が同じ安全な決定論的feedbackを導出し、stop/task/operation/revision/hash/target/pending/budget/clock条件が有効な場合だけrequest.validationFeedbackへ出す。C1/C4の旧array併存問題はdesign-counterexample.md参照、未決のまま。

## 今回実測した範囲

- public SDKの実拒否: updateの既存gap不当resolution、claimless supported/refuted、SDK内部reflection binding/coverage、raw schema/新候補/adapter lookalike。実call/観測/消費/未適用resolutionをmissing-object assertionより前で確認した。
- 実helperのvalid envelopeによるupdate/reflect semantic拒否、current feedback欠落、pending batchのpartial/新execution/payload/scope変更拒否。
- helper outer/inner binding mismatchはSDK呼出し前にrevision_conflictで止まり、SDK ledger/modelCalls不変。
- 現行既定opt-out、inspect0 throw、positive repair成功、legacy replay no-backfillはselected F1 compatibility caseで通過。
- 現行legacy stale feedbackは通常helper inspect + public SDK positive-repair + SessionStore直接setup + 実helper invalidate/prepareで実測。

## 未到達の将来assertion

新objectが存在しないため、多くの試験は最初のpositive assertで止まる。以後のsafe field shape/非漏出/一件上限/metadata hash除外/ledger replay/cache restore/正しい同batch回復/成功後削除/新revision削除/invalid state拒否/期限後record保持/旧配列との優先判定は、将来実装後の契約テストとして記述したが今回の成功証拠ではない。

stale revision/hash/operationの試験用stateは実failed stateに診断metadataだけを射影する予定で、SDK成功やusage/証拠/authorityを捏造しない。ただし今回その射影分岐にはmissing-record assertionで到達していない。privacy negative checksも必ずreal record存在のpositive assertより後に置き、欠落だけを安全PASSと数えない。

scope mismatch caseのrecoveryはscopeを合わせ直さず、同pending batchでinconclusiveかつscopeMatched:falseとして適用しgapを残す。別のmatching-scope caseだけが根拠あるresolutionを要求する。この後半回復分岐も今回は未到達。

実時間whole-task expiry後の新record保持テストもrecord欠落で先にRED。既存期限gate実績を今回のF1新record契約の成功へ流用しない。F3の救済・意味効力・A2/fullreview PASSは未主張。
