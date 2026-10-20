# Managed invalidate: 限定design r2用addendum

状態: **製品編集は保留中。RED試験の追加・実行のみ。** r1レビュー本文とPMの追加制約を確認。core/types/report/cliと既存テストは変更しない。費用/tokenはunknown。

## r1で不足した2点の実装前診断

既存SDKのchanged invalidateは `stopReason = null` とし、`pendingAssessmentExecutionIds` を削除する。これをsessionへそのままcommitすると、既停止理由が失われ、sessionの通常 `markApplied` が「pending IDが消えた」ことを実評価完了と取り違える。SDK本体を変更せず、以下のsession調整に限定する。

### 1. 既停止の保持

通常（旧stopReasonがnull）の撤回はSDKの実result.decision/nextProbeIds等に従う。needs_check/needs_reflectionを一律blockedにしない。

旧stopReasonがある場合、その文字列とblockedを同sessionに保持する。transaction contextへ `previousStopReason` を保存し、SDKからの純粋な撤回結果に旧stopReason/blockedを戻してvalidateStateする。claim/evidence/gapの再計算とpending破棄はSDKが実際に返した内容を保つ。復旧もこの検証済みstateだけをcommitする。旧停止はSDK journal/transaction contextにも残る。

helperのeffectiveDecisionはbudget/accountingUncertain/実停止のblockedを未評価queueより優先し、別の未評価追補があるだけで既停止をneeds_checkへ格上げしない。新しい実観測updateとfresh reflectionが後で成立すれば、既存SDKの正当な回復を妨げない。

### 2. pending破棄を実評価完了と扱わない

SDKが撤回で実際に削除する旧pending batchのexecution IDsを、transaction contextへ次のように記録する。

```json
{
  "invalidation": { "evidenceIds": ["source"], "reason": "実際の撤回理由" },
  "previousStopReason": "invalid_model_output",
  "discardedExecutionIds": ["pending-execution"]
}
```

contextのdiscardedExecutionIdsは撤回前SDK stateのpendingAssessmentExecutionIdsに由来し、changed結果でそれらが消えた場合だけ有効にする。既にwithdrawnの冪等noopではpending/receiptを変更しない。

## receipt履歴のexact shape案

既存receiptのimmutable payload/source/payloadHash/observationsを保持し、実評価せず破棄された部分にだけ以下のderived履歴を追加する。

```json
{
  "status": "discarded_unassessed",
  "appliedRevision": null,
  "discardedAssessment": {
    "atRevision": 4,
    "executionIds": ["pending-execution"],
    "invalidatedEvidenceIds": ["source"],
    "reason": "pending_assessment_discarded_by_invalidation"
  }
}
```

statusの候補は既存 `received_unassessed` / `applied` に `discarded_unassessed` を加える。`appliedRevision` は明示的にnullを維持し、破棄をappliedへ変換しない。

SDKが破棄したbatchにreceipt内全観測が含まれる通常ケースは上記statusへ移し、`session.pendingUpdates` の現queueから除外して `session.discardedUpdates` へ表示する。SDK ledgerに既に記録された実tool/round/model/costは保持し、pendingUsageへ二重加算しない。

**混在receipt**: 破棄batch以外の未評価executionも一つのreceiptに含まれる場合、その観測まで捨てない。`discardedAssessment.executionIds` は破棄されたsubsetだけ。まだ評価待ちの別executionがあればstatusはreceived_unassessedのまま現queueに残し、discardedUpdatesにも破棄subsetを表示する。破棄されていない全executionの評価が後に済んでも、receipt全体をappliedとはせずdiscarded_unassessedにする（appliedRevision null）。これによりreceipt全体を評価済みと誤認しない。

markAppliedはdiscarded subsetを実評価完了の条件から除外し、receipt全体のapplied化を禁止する。破棄済みexecutionの同ID再配送は新しい検査ではなく、同payloadを保持した履歴の再配送。新たな検査は新execution IDを使う。

## 再配送・遷移・復旧・report

- immutable payloadHashは元の受領payloadに基づく。derivedのstatus/discardedAssessmentは含めない。同ID/同payload再配送は既存の未評価破棄履歴を返し、日時やappliedRevisionを変更しない。異payloadは従来通り拒否。
- transitionは旧pendingUpdates/pendingUsage/usage/stop/unknownsに加え、`previous.discardedUpdates` を保持する。新taskの予算・評価完了とは区別する。sessionイベントには元receipt履歴も残る。
- begin→stage→SDK commit→sealのcontextと結果はsyncされる。reconcile時、invalidate transactionなら破棄metadataを適用してから通常markAppliedを呼ぶ。SDK commit前/後どちらから回復しても同じ未評価履歴になり、二重適用しない。結果未確定intentだけの中断は既存failclosedを維持し、自動の再生成/予算resetを追加しない。
- reportは現 `受領済み・未評価` と別に `評価せず破棄した観測` を表示し、receipt ID、execution IDs、破棄revision、未評価のままであることを記す。別の新証拠で現在の理解がreadyになっても、過去の破棄観測を評価済みと表示しない。

## 期限後/会計未確定の撤回依頼

固定bindingと入力の存在/shapeを検査し、既存非生成checkpointで実停止を保存。SDK evidence/claimを変更せず、内部receiptに次の形で受領する。

```json
{
  "id": "unassessed-invalidate-<digest of normalised invalidation>",
  "source": { "kind": "tool", "locator": "helper:invalidate", "receivedAt": "初回の実受領時刻" },
  "text": "撤回申告は未適用: 理由と対象ID",
  "references": ["対象の資料locator"],
  "observations": [],
  "invalidation": { "evidenceIds": ["source"], "reason": "実際の撤回理由" },
  "status": "received_unassessed",
  "appliedRevision": null
}
```

receive側の加算的な任意invalidation metadataは上記strict shapeに限定する。同じ正規化inputの再配送は同ID/初回receivedAtを再利用し、理由/対象が異なれば別receipt（同ID偽装はpayload衝突）。元SDK.startedAtを受領時刻へ流用しない。存在しないevidence ID/不正reasonは、期限後でもinvalid_inputで拒否する。invalidityや支持を自動変更しない。

## REDと保留条件

新規6試験を `test/session-followup.test.mjs` へ追加し、実helperで未実装commandのREDを実行中。通常same-task循環、redacted復元、不正入力/binding/legacy拒否、既停止+pending破棄、実期限後receipt日時、SDK commit前後のtransactionを検査する。既存19focusedの成功を新しい機構のPASSへ転用しない。

PMのfresh Google限定design r2が明示PASSになるまで、製品helper/storeを変更しない。
