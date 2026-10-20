# Post-F runtime API contract

2026-10-21 JST。実GREEN: `green-r1.json` / `green-r1.log`、対象14/14、exit 0、fail/skip 0。設計PASSや決定論的試験を受入2/モデル意味評価のPASSへ昇格しない。commands/flags/input schemaの追加なし。

## A: receipt acceptance time

新しいvalid receiptは `session.updates[]` のoutput-only `helperReceivedAt: string`（ISO UTC）を持つ。session排他lock内、入力と全execution衝突検査後、初回append前のローカルOS受理時刻。callerの `source.receivedAt` と `Observation.evidence[].retrievedAt` はそのまま保持する。hostへの配達時刻や単調な予算時計の正本ではない。

`helperReceivedAt` は元normalized payloadHashに含めない。caller指定はinvalid_input。同ID/同payloadは保存時刻/hashを再利用し、caller申告日時を変えるとcollision。cache欠落/正本replayで保持。legacy receiptはfield absent/unknownのまま、再配送でもbackfillしない。期限後の内部観測/撤回receiptも共通receiveで付与し、既存source.receivedAtと再配送動作を維持する。SDK evidence/usageの変更なし。

managed reportは全receiptについて `helper実受領時刻`、`caller申告時刻`、各証拠の `Evidence.retrievedAt` を別表示。legacy helper時刻はunknown。

## B: managed derived status

すべてのmanaged JSON出力（activate/status/receive/transition/prepare/inspect/update/reflect/invalidate）に、state/request/binding外のtop-levelを加算:

```json
{"understandingStatus":{"requiredGapIds":[],"reflectionStatus":"unavailable","canReportCompletion":false}}
```

`requiredGapIds`: requiredかつstatusがresolved以外のgap ID。stateなしは[]。

`reflectionStatus`: stateなしunavailable、reflectionRequiredなしnot_required、requiredかつreceiptなしmissing。receiptのtaskId/understandingHash/現在の全claim coverage（長さと全ID）が不一致ならstale。一致する場合はreceipt.completionのinconclusive/completed。basedRevision一致やreflectionEffects存在を条件にしない。

`canReportCompletion`: stateあり、effectiveDecision ready_for_requested_step、未解決required gap/評価待ちexecution/未評価receipt/会計不確定なし、reflectionStatus completedまたはnot_requiredのときだけtrue。SDK今回の段階の完了を記述可能という意味であり、自由文の正しさ・外部操作許可・利用者の目的全体の完了は保証しない。

毎出力で導出し、SDK state/hash/requestHash/binding/usage/stop/decisionを変更しない。optional gapや破棄済み履歴だけで一律blockしない。managed reportも同じ3事実を表示。

managed prepare.instructionsは既存proposalGuidance/reflectionGuidance全文を保持し、短い共通reminderを末尾へ加算する。実回答/新情報を既存gap・対象claimへ結び付け、正当なassessment/resolutionのみ、不十分な回答では残る確認事項を保持する。重要な変更後は許可・予算・評価待ちが許す範囲でneeds_user_inputでも現在の理解を再考する。条件付き応答、意味の確実性、SDK段階完了を分ける。legacy helper guidanceは変更しない。

## 試験境界

実helper subprocess/public SDKと決定論的adapterの契約試験。モデルの意味的解決能力の実証ではない。legacy fixtureは一時試験領域でvalid journalの任意timestamp欠落を構成し、別試験では実SDK reflection結果から任意reflectionEffectsのみ省略する互換projectionを使用する。過去F記録や実データを変更しない。全npm/fresh行動試験/独立full review/親監査はPM工程。費用/token unknown。
