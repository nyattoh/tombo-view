# C1/C4 coexistence readback — source unchanged

2026-10-21 JST。同runtime owner、RED限定。製品変更案を決める資料ではなく、PMが追加設計判断へ渡す未決事項。

## 実測した現行legacy経路

`test/session-followup.test.mjs` の `F1 C1/C4 counterexample...`（1127行開始）は、実helper inspectで元stateを作り、そのstateへpublic SDK `update`（maxModelRepairAttempts:1）を実行した。schema-validな既存gapの不当resolutionを2回拒否し、実modelCalls2件・modelRepairDiagnostics2件・pending観測を持つ結果を得た。

このpositive-repair結果をmanaged sessionへ入れる部分は通常helper経路ではない。export済みSessionStoreのwithLock/load/reconcile/begin/commit/writeCacheによる直接setupである。SDK state/診断配列/usageはpublic SDKの実結果であり、手書きの成功stateや診断arrayは作っていない。

その後は実helper subprocess `invalidate` → `prepare --observations []`。撤回によりrevisionが進み、pending batchが除去され、managed stageが旧invalid_model_outputを保持。旧modelRepairDiagnosticsは2件残る。次prepareが返した実feedback:

```json
{"code":"invalid_model_output","message":"Resolution lacks current matching evidence gap","rejectedAttempt":2,"maxAttempts":2}
```

red-r1.logで期待undefinedとのassertion差として保存。未知CLI flagやschema/test-adapter実行失敗ではない。元gapは既存のまま、観測・消費の巻戻しなし。

## 新設計からの推論（未実装・未実証）

現行にはcaptureProposalRejection/lastProposalRejectionの実装がなく、object生成・削除・新feedback優先判定を通した試験はまだ出来ない。

受理済みC1は新しいinvalidate revisionでlastProposalRejectionを削除する。C4はobjectが存在しない場合にstopReason invalid_model_output＋同operationの旧repair-array fallbackを従来どおり許す。managed invalidateは実stop保持契約を持ち、legacy配列も残るため、単純なC1+C4実装では上記の古いfeedbackが再び有効になると推論できる。これは「objectが存在するがinactiveならfallbackを抑制」だけでは覆えない。

core stopped/invalidate、SessionStore stageの旧stop保持、helper managed request.validationFeedback分岐を現ソースで照合した。レビューの不正確な数値offsetや想像上の関数には依存しない。

## PMへ返す未決点

「新revisionでobjectを必ず削除」「object不在のlegacy fallback互換」「invalidate後の古いfeedback非再活性化」をどう共存させるかを具体的に決める必要がある。履歴の破壊・配列の無断消去・旧stop抹消・新authority・global schema変更をこのREDで提案採用しない。

テストは意図された非再活性化をassertしてREDのまま保持する。source実装は未release。必要なfresh design補正と互換条件の確定はPM工程。テスト弱化や自己判断のsource修正はしていない。
