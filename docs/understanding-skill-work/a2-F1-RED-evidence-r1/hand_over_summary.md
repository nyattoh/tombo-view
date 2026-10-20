# F1 RED-only handover

同runtime owner、今回のRED限定作業を終了。製品source/GREEN/build/typecheck/全npmは開始していない。fresh Googleはdesign readiness PASS with C1–C5だけであり、A2/fullreview/gate/親監査/公開PASSではない。費用/token unknown。

## Binding・範囲・baseline

2026-10-21 05:02:54 JSTにcwd `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9` を再確認。新worker/PM/reviewer/model/API/依存/secret/global hook/commit/push/PRなし。今回はmain checkoutにも親rootの広域探索にもアクセスしていない。過去の探索逸脱を解消済みとは扱わない。

指定RED brief、locked-charter/amendment、F1設計、独立review全文/結果metadata、C1–C5条件、post-H source diagnosis、post-H全16 freeze、npm-r5 json/log末尾を読んだ。result.summaryはreview MD全文とtrim後一致を実確認し、同じ本文とmetadataを照合した。reviewの不正確なoffset/read limitを現source全量読取の証拠として使わない。実際のcore guards、types、helper binding/feedback/managed opt-in予定箇所、store stage、journal hashを確認。

PM npm-r5の735/735・exit0は変更前の歴史として確認しただけで、今回の成功実績にはしない。変更前全16ファイルのhashはPM freezeと16/16一致、new7を明記したbefore.jsonを保存。protected14のmtimeはlive bigint ns文字列で保存。PM JSONに大きいns値がnumberで記録されているため、最初のstring比較で6件の丸め差が出た初期beforeも別名で保持し、numeric公表精度で一致を確認した。これはsource変更の発見ではない。

## 変更ファイル

- `test/cli-model-repair.test.mjs:230`以降: SDKのF1将来契約/既存互換22ケース。実adapter/criticはすべて決定論的ローカルstubで外部APIなし。
- `test/session-followup.test.mjs:987`以降: managed subprocessとlegacy fallbackを含む7ケース。
- own `results/understanding-acceptance2/runtime/F1/**`: before/after、原2testコピー、exact差分、RED、設計所見、将来契約、検証記録。

既存2testは原bytes全体がそのままprefixとして残るappend-only。原試験の変更・弱化・skip追加なし。原コピーhashはbefore.jsonと一致。`.patch` は原コピーと現testのno-index diffで、diff exit1は差分ありの正常結果。改行変換warningはgitの読取時通知で、protected bytesの変更ではない。

## 実RED

```powershell
node --test --test-name-pattern='F1' test/cli-model-repair.test.mjs test/session-followup.test.mjs
```

開始 `2026-10-21T05:09:13.4187995+09:00`、終了 `2026-10-21T05:09:23.1031929+09:00`。exit **1**、selected **29 tests / 2 pass / 27 fail / skip0 / cancelled0**。27件すべてAssertionError。未知CLI flag、実行不能、test adapter/schema組立エラーをREDとして数えていない。spec reporterが出したselected countsであり、filter外の旧試験はNOT_RUN。

stdout/stderr等はPowerShell `*>` によりred-r1.logへ完全結合保存。別々のstream帰属は測定していない。SHA256:

```text
d07b726154c8ae24273df227f120956a5073828764bc67bb6a7b3ff40ada3281
```

red-r1.json/logとverification-summary.jsonにexact command/time/exit/count/全failed assertionを保存。通過した2件は、既定opt-out/inspect0 throw/positive repair成功/legacy no-backfillの互換ケースと、helper outer/inner binding mismatchの生成前拒否ケース。GREEN工程や新F1機構の成功ではない。

実失敗assertion:

- 実SDK update/reflectのterminal invalid_model_outputにlastProposalRejectionがない。modelCalls/rounds/tool/known cost、validated observation/pending、bad resolution未適用を先に確認したケースを含む。
- 実helperの正しいpending batch次prepareにvalidationFeedbackがない。
- createTomboの提案中captureProposalRejection optionが現行では無視され、boolean検査がない。
- actual legacy positive-repair後のmanaged invalidate→prepareで古いfeedbackが再び出る。

claimless gap supported/refutedの拒否・required/open維持、SDK内部reflection binding/coverage拒否、raw schema/adapter lookalike等もpublic SDKで実際に起こした。ただしsafe新objectの存在assertionで止まったため、その後の分類/非漏出/target内容が正しいと確認したわけではない。

## C1/C4未決契約

詳細はdesign-counterexample.md。現行実測は、実helper inspect→public SDK positive-repair結果→SessionStore直接begin/commit/cache setup→実helper invalidate/prepareという経路。通常helperだけでpositive repairsを作ったとは言わない。direct setupには実SDK結果を使い、手書き成功stateや診断arrayは使っていない。

現行は新object未実装。実測されたのはlegacy arrayと旧stop保持による再feedbackである。C1で将来objectを新revisionごとに削除すると、C4の「object不在なら従来fallback」に再び入るという部分はsource/設計からの推論。objectがinactiveのまま存在する時のfallback抑制だけでは、削除後のケースを覆えない。

新revision削除・legacy互換・古い拒否非再活性化の併存方法をPM/fresh design補正で確定する必要がある。こちらでは配列消去、旧stop抹消、marker追加、schema/authority変更等を勝手に選んでいない。矛盾を隠すassertion弱化やsource実装もない。

## 将来契約と未到達範囲

proposed-api-test-contract.mdは実装済みAPIの確定契約ではない。将来objectのshape、safe target、actual returned binding、private provenance、feedback優先/抑制、one-object、metadata hash分離、再開と回復を試験として記述した。

record存在を先にpositive assertするため、多くはそこから先に進んでいない。新objectのpersist/replay/cache復旧・privacy negative・same-batch成功回復・成功/新revision削除・state validation・stale metadata優先抑制・期限後の新record保持を、今回確認済みとはしない。stale-case metadata射影の分岐もmissing-recordで未到達。期限テストも実待機前にmissing-recordでRED。古い期限試験のPASSを流用しない。

F2 payload/ID/scope/partial batch不変と、F3の既に存在するclaimless required gapを救済しない契約は維持。semantic efficacyやモデル改善の因果効果は試していない。

## 最終保全・terminal

after.jsonでprotected14の**byte/hashとexact mtimeが14/14不変**、core/types/helperのsource3も不変。before/after全16、原2コピー、差分、log hashを保存。staged0、ask-policy歴史untracked192を再確認。歴史409は今回再hashしていないが、それらを変更/削除する操作はしていない。

変更後test SHA256:

```text
test/cli-model-repair.test.mjs
3f3be921c9fe8c520fedeb83a6bf1133781258297218278369c800d618679866
test/session-followup.test.mjs
5eef341502f2f69742b34b867b91e1bbe4d0924e972c6e0f40bc0c1210d99c4b
```

全selected process終了。製品未releaseのためここでterminal。次工程はPMによる未決契約の具体化/fresh design補正と、明示された次回source release。GREEN/fullnpm/実装/受入2には進んでいない。
