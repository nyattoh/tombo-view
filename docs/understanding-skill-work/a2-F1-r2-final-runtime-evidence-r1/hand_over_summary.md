# F1 r2 runtime implementation handover

同runtime ownerの明示production release範囲を完了。owned source3+test2を2026-10-21 05:51:57.199 JSTにfreeze。API仕様は最初のF1 29/29 GREEN milestoneから変更していない。以後の追記は実測数字、追加SDK試験3件、並行docs保全記録の訂正。A2/F3救済/意味効力/fullreview/gate/parent/publication PASSは未主張、費用/token unknown。

## Binding・承認・保全

cwd `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`を実確認。cached labelでrebindしない。r1/r2設計・条件・明示source releaseと回収済みamended REDを照合し、全16開始hash/exact mtime/owned5コピーをbefore.jsonへ保存。開始16/16はr2 RED終端と一致。

source編集はcore/types/helperだけ。store/report/journal/index/prompts/CLI/yaml/SKILLや他testsを書いていない。新依存、global hook/installed skill、secret/held-out/Ommatidia/未来raw/observer、main checkout、追加子task/model API、commit/push/PR/mergeなし。歴史失敗・r1/r2 RED・ask192・A3 pending・AGENTS逸脱を免責/成功へ変更していない。過去全409の再hashは今回せず、それらへの変更/削除操作なし。staged0/ask192をfreeze時に確認。

## 実変更とsource行

- `src/types.ts:123`: safe optional target schema。127 strict lastProposalRejectionSchema、140 state optional field、200 LastProposalRejection type。既存indexのtypes exportで利用可能、schemaVersion0.1維持。
- `src/core.ts:23`: SDK-private WeakMap provenanceと内部guard。202付近のcurrent/historical binding検証。497 opt-in boolean validation、503 actual returned stateへの安全なcapture。579のproposeではpost-adapter validation phase/実call/terminal attemptを区別し、valid candidateだけ旧recordを除去。resolution/reflection/unsuccessful-probeの既存guard条件は維持してsafe kindを付与。
- `skills/tombo-view/scripts/session.mjs:28`: 一つのproposalFeedbackをmanaged142/direct296で共有。present inactiveはfeedbackも旧array fallbackもなし、absentだけlegacy互換。managed createTomboだけcaptureを明示true、legacy生成経路は既定のまま。
- `test/cli-model-repair.test.mjs`: 承認済みamended RED全bytesをprefixで維持し、末尾へ追加のSDK不変条件3件だけ。opt-out履歴保持/valid inconclusive clear、追加guard mapping/新候補target非漏出、生成前budget/input-size stopのno captureを確認。追加理由とexact差分はtest__cli-model-repair.test.mjs.patch。
- `test/session-followup.test.mjs`: 今回のproduction taskではbyte/mtimeとも変更なし。pre-SDK guard・no-stale feedback assertionを含む承認済み全試験を維持。

## TDDとexact結果

製品前amended RED（F1/r2-red）:

```powershell
node --test --test-name-pattern='F1' test/cli-model-repair.test.mjs test/session-followup.test.mjs
```

05:35:06.496→05:35:14.809 JST、exit1、29 selected / 2 compatibility pass / 27 assertion failures / skip/cancel0。log SHA `f31f874b8a5a311930d981f209e41ea1a09e584f7eb1f0f97af14aae2af32b46`、元証拠を保持。明示source release後の変更のみ。最初のbuildもexit0、最初のF1実行からGREENであり、隠した製品失敗attemptはない。

|記録|実測|JST開始→終了|
|---|---|---|
|f1-green-r1.json/log|exit0、29/29、fail/skip/cancel0|05:43:35.843→05:43:49.238|
|affected-r1.json/log|exit0、119/119、fail/skip/cancel0|05:46:58.164→05:48:44.395|
|regression-r1.json/log|exit0、254/254、fail/skip/cancel0|05:47:08.376→05:47:22.133|
|build-final.log|npm run build、exit0|05:49:23.573→05:49:24.393|
|typecheck-final.log|npm run typecheck、exit0|05:49:24.393→05:49:25.070|

affected commandは変更test2全体とmanaged binding/storage/budget2ファイル:

```powershell
node --test test/cli-model-repair.test.mjs test/session-followup.test.mjs test/session-binding.test.mjs test/session-budget-checkpoint.test.mjs
```

relatedはSDK core/reflection/repair、assessment correction/scope、ask policy、session/framing、journal/recovery、CLI reflection、理解循環の15ファイル。affectedで実行済みCLI model repairは重複させていない。省略なしexact command、全start/end/exit/count/log SHA256はverification-summary.json。F1-only最初の29件と、affectedに含まれる追加3件（全32 F1）を区別し、32件F1-only再実行や全suite実行を主張しない。

全npmは未実行。旧735等を現在件数へ流用せず、PMがdocs合成freeze後に統合実測する。

## API・会計・privacyの実確認

api-contract.mdへ確定shapeと操作を保存し、29/29実GREEN時にPM通知、own runtime/api-contract.mdへ加算した。createTombo.captureProposalRejection defaultfalse、managedのみcreation opt-in。新CLI flag/commandなし。

新recordはactual generation/terminal invalid_model_output後のupdate/reflectだけ。module-private guard detailとpost-adapter phaseを両方使い、schema/adapter lookalikeはgeneric/no target。returned failed stateの実revision/hash/taskへbindし、raw body/reason/Zod/例外を新recordへ複写しない。safe targetは返却stateの既存protocol entityだけ、不安全な既存IDならtargetのみ省略しglobal IDsは緩めも締めもしていない。

r2履歴はnon-proposal/checkpoint/invalidate/pre-generation new revisionで元object unchanged、no-op same-revisionはstateそのまま、valid applied update/reflectでclear、新captured failureでreplace。default/opt-outはcreationを止めるだけで既存historyを任意削除しない。current破損はinvalid_input、older historyはinactiveで旧hash/stop/targetと現在の差を許す。

以前未到達だったprivacy positive/negative、SDK内部binding/coverage、helper生成前binding拒否、exact pending batch、成功回復/実usage不変、claimless required gap拒否、one-record置換、current corruption、historical suppression、SDK/session/cache/replay、実期限後gateまでGREENで実行した。補足3件もaffected中に通過。

model/round/tool/known costの実消費を保持し、無駄な追加試行・回払戻し・scope alias・execution変更・F3自動解決・予算/期限延長なし。understandingHashはmetadataを除外、FileJournal whole-state JSON hashと別アルゴリズムのSessionStore canonical stateDigestは通常field加算。legacy backfill/migration/旧hash書換えなし。store digest logicに変更は不要だった。

privacyは新recordと安全な派生feedbackの境界。旧legacy arrayのraw message互換、既存stateの証拠本文、modelによる意味的判断の正しさ全体を保証するものではない。

## Fixtureと実効性の境界

SDK/criticは決定論的local adapter、helperは実subprocess。positive-repair→managed invalidation併存はpublic SDK結果を明示SessionStore transactionでsetupする経路で、通常helperだけでpositive repairsが出来たとは主張しない。stale/current破損は実failed stateのmetadataだけの明示projection。r1のlegacy実測とr2 GREENで初めて通過したnew-object経路を区別し、過去の未到達を成功に読み替えない。

F3既存claimless required gapの到達不能制約は残る。診断が自由文の正しさやモデル改善の因果効果を証明するものではない。fresh raw/semantic/fullreview/parentはPM工程。

## 並行docs・保全script失敗の記録

05:49時点のprotected11確認後、05:50の最終保全scriptは`Protected11 drift`でexit1停止した。試験失敗ではない。README/host-sessionだけが05:50:04/22に変化し、protected9/storeは不変。freeze-attempt-r1.md/freeze-drift-r1.jsonに保存し、先行したown API記述の「protected11全不変」は直ちに訂正した。元beforeや試験logを改ざん/削除していない。

PMはAPI GREEN後に明示releaseしたsame docs owner ordinal11のactual untruncated write events255/256/257とmtime/SHAを独立照合し、正当な並行編集と確認した（parallel-docs-readback.md）。runtimeによる所有外書込み/巻戻しはない。owned source3+test2とprotected9、並行docs2を分離する。source-freeze.jsonのdocs hashはpoint-in-time観測で、全体の合成freezeではない。両owner終端後の合成freeze/全npmはPMが担当する。

## 最終hash・terminal

source-freeze.jsonに全16 before/current hash/exact ns mtime、owned freeze時刻、protected9不変、docs2並行変更、旧pre-F1およびamended RED全prefix不変、staged0/ask192を保存。

```text
src/core.ts
5f482373f1d7054c9db6005319380a4fec9a664001dac6202a6caeb25d40fde7
src/types.ts
9b16cf222f9d56248fb65cb7be6c6a677cdb8fc0ead5c19efea5bf65423f5eeb
skills/tombo-view/scripts/session.mjs
d7dec89c35183a0cc5f8499a280b752410fae36d94b93b7f690b4d4b19ca6b35
test/cli-model-repair.test.mjs
b2e93a05e6634047d30e1209231596cef208e3b18a92bad508e743f61883a3b3
test/session-followup.test.mjs (今回不変)
4f0f34ee149f8bad1bd16bfd837d90248987f1a6107343b454f98f850524b568
```

全検証processは完了。既知owned未完了なし、API仕様変更なし、source/testの追編集予定なし。次はPMのdocs合成freeze・全npm・独立fresh証拠/review/gate/parent audit。費用/token unknown。
