# F1 r2 API readback — actual targeted GREEN

2026-10-21 JST。同runtime owner。既存r2 RED（29/2pass/27assertfail、exit1）後にcore/types/helperだけを変更し、最初の実F1実行29/29・exit0・skip/cancel0。exact log/timeはf1-green-r1.json/log。これは実装の決定論的契約試験であり、A2/F3救済/semantic efficacy/fullreview/parent PASSではない。関連回帰と最終freezeは同領域の最終verificationを参照。費用/token unknown。

## SDK opt-inと形状

既存 `createTombo({ adapter, now?, maxModelRepairAttempts?, captureProposalRejection? })` へboolean任意optionを加算。default false、undefined以外の非booleanはinvalid_input。managed helperは明示true、legacy direct helper/CLI/既定SDKは生成captureをopt-inしない。maxModelRepairAttempts既定0/許可0..2、inspect0例外、positive repairの配列/attempts/消費は維持。追加model試行はない。

`UnderstandingState.lastProposalRejection?: LastProposalRejection`、`lastProposalRejectionSchema`、`proposalRejectionTargetSchema` を既存types export経由で追加。schemaVersionは0.1。

```text
{
 operation: 'update'|'reflect',
 taskId: existing task ID,
 atRevision: nonnegative integer,
 understandingHash: lowercase SHA256,
 code: 'invalid_model_output',
 kind: 'resolution_not_justified'|'reflection_binding_mismatch'|
       'reflection_claim_coverage_mismatch'|'proposal_validation_failed',
 target?: {kind:'gap'|'claim'|'probe'|'lens',id:string},
 rejectedAttempt: integer1..3,
 maxAttempts: integer1..3 (rejectedAttempt <= maxAttempts)
}
```

一つのstrict objectだけ。target IDは1..200、reserved task: prefix/whitespace/control禁止。一般entity ID schemaは変更せず、実在する既存IDが不適切ならtargetだけ省略。unknown/new candidate/evidence IDをechoしない。target候補が返却stateに存在しなければgeneric/no target。known existing IDでも不安全なsyntaxはtargetを省略し、SDK guardのstatic kindは保持する。

## Captureの根拠と会計

update/reflectで実adapter callがmodelCallsへ計上され、terminal invalid_model_outputとなった時だけcapture。SDK guard detailはmodule-private WeakMapで結び、adapter返却後の検証/適用phaseと区別する。raw schema error/adapter lookalike等はgeneric/no target。message/Zod/issues/claim本文/証拠passage/assessment理由/任意adapter例外を新objectへ複写しない。

既存gapの不当resolution・duplicate・unknown resolution evidence・unsuccessful probe resolutionはresolution_not_justified。SDK内reflection binding不一致はbinding kind/no target、completed coverage不足は最初のmissing existing claim、unknown reviewed claimを含む場合はcoverage kind/no target。その他はgeneric。

返却失敗stateを既存stopped経路で作った後に、その実task/revision/understandingHash（retained validated observationsを含む）へbindingする。model/round/tool/token/costの変更は実際のSDK会計だけ。pre-generation input/budget/accounting/passage/clock/envelope停止から新拒否を製造しない。transport retryやautomatic repair回数を増やさない。

## r2 lifecycleと検証

- genuine captured terminal failureは一件を置換。
- validに適用されたupdate/reflectは以前のrecordを削除。最終decisionがreadyでなくても同じ。completed/inconclusive reflectとも同じ。
- changed invalidate/checkpoint/non-proposal/pre-generation stopのnew revisionは元recordをunchangedで保持。atRevision/hashをrestampしない。no-op/same-revision stateはそのまま。
- capture false/default SDKが既にrecordのあるstateを扱っても、creationだけがopt-out。non-proposal履歴を消さず、valid successではclear。
- same-task/nonfuture revisionとstrict shapeを常時検証。current revisionではinvalid_model_output/current semantic hash/current known targetが必須。current破損はinvalid_input。older recordでは旧hash/stop/targetが現在と異なってよい（履歴はinactive）。
- 新taskへの正当transitionは旧SDK ledger/historyを保持し、新SDK stateへrecordを移植しない。store実装は変更していない。

internal proposal candidateは適用を試す前に旧recordを除き、検証途中の一時hash変化をcurrent record破損と誤認しない。失敗時には元working/validated stateから歴史を保持し、新captureがある時だけ返却stateへ置換する。公開validateState/SDK entry/final captured stateの検証を緩めない。

## Helper feedback

新CLI command/flag/envelope schemaなし。既存managed/direct prepareとapply-envelope再計算が同じ `proposalFeedback` を使う。record presentならstop/task/operation/current revision/semantic hash/target membershipが全一致した時だけ既存request.validationFeedbackへ安全な静的message＋任意safe targetと実attempt countsを出す。inactive recordはfeedbackなし、旧modelRepairDiagnostics fallbackも抑制。record absentだけ従来fallbackをそのまま保持。

feedback shapeは既存 `{code:'invalid_model_output',message,rejectedAttempt,maxAttempts}`。messageはkind別静的文と検証済みtargetだけ、512字上限内。prepare/applyのrequestHash一致を実helperで確認。既存pending exact batch/authority/budget/session期限/accounting gatesの先へ診断だけで進めない。outer/inner malformed bindingはSDK前に拒否し、recordや実callを生成しない。

## Persistence・限界

semantic understandingHashはdiagnostic metadataを含めない。FileJournalの通常JSON whole-state hashとSessionStoreのredacted canonical stateDigestは、それぞれ独自の既存アルゴリズムで任意fieldを含む。二つを同一hashと扱わない。schema/cache/replayはactual recordを保持し、legacy field欠落をbackfill/migrateしない。src/report.ts/store/journal/CLI/index/prompts/SKILL/docsは変更していない。

実F1 GREENは29ケースで、r2 RED時点の未到達後半assertionまで通過した。SDK/criticは決定論的ローカルadapter、helperは実subprocess。positive-repair→managed invalidate併存fixtureはpublic SDK結果をSessionStore直接transactionでsetupする経路で、通常helperだけのpositive repairを主張しない。stale/current metadata fixtureは実失敗stateの診断metadataのみを射影する明示的検証fixture。privacyは新record/派生feedbackの境界であり、従来legacy arrayのraw message互換や証拠本文全体の不存在を主張しない。

F2 scope/payload/execution/usage不変、F3 claimless required gapのsupported/refuted拒否、固定予算/期限、同goal延長なしを維持。自由文意味判断の正しさをSDK診断が保証するわけではない。全npm/fresh raw/独立fullreview/parent auditはPM工程。

最終実測: affected4ファイル全体119/119、related15ファイル254/254、final build/typecheck各exit0、fail/skip/cancel0。affectedには追加3 SDK invariantを含む全32 F1 casesが含まれる。最初のF1-only commandは29/29として保持し、32件のF1-only再実行を行ったとはしない。追加3件はopt-out履歴保持/inconclusive clear、guard別safe classification、生成前budget/input-size停止のno captureを確認。最終freeze時にprotected11のうちREADME/host-sessionの2文書が変化し、残る9（store含む）は不変だった。私の文書書込みはなく、freeze-drift-r1.jsonにexact差分を保存してPMへ並行docs更新の照合を依頼した。protected11すべてが不変だったとの先の記載は撤回し、最終source-freeze/handoverの分離記録に従う。旧pre-F1とamended REDの全prefixは保持する。
