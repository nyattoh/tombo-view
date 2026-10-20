# Acceptance 2 runtime API: implemented contract r1

2026-10-20 23:37 JST確認。`npm run build` exit 0、新規focused 16/16 pass / fail 0 / skip 0。証拠: `focused-r2.json`, `focused-r2.log`, `build-r2.log`。関連回帰は別途実行中。以下は既に動作試験した契約。

## SDK

既存 `dist/index.js` から独立export（`Tombo` interface/schemaは不変）:

```ts
checkpointBudget(state, {
  operation?: 'update' | 'reflect', // default update
  now?: Date | number,             // SDK試験用。製品CLIの時刻指定は追加しない
  pendingUsage?: { toolCalls: number; costYen: number | null }
})
```

返却は既存InspectionResultと `budgetCheckpoint: { operation, exhausted, accountingUnavailable, elapsedMs, previousStopReason }` の交差型。

生成/再考を行わず、モデル・round・tool・token・費用を架空加算しない。予算内ではstateをそのまま返しrevision/hash/usageを変えない。`budgetCheckpoint.elapsedMs` は実経過と既存elapsedの大きい方。updateは残round、reflectは残roundを消費しない既存条件を守る。モデル回数、時間、出力上限、tool超過、既知費用上限を検査する。

期限切れなど停止が必要ならelapsedを単調更新したblocked stateを返す。初回停止はrevision+1。旧stopReasonがあれば維持し、budgetCheckpointで予算超過を併記する。redacted/pending stateでも本文取得を要求しない。pendingUsageは既に発生した未計上実消費の上限検査にだけ使い、SDK usageへ移さない。金額上限があるのに消費不明ならaccountingUnavailableとして停止する。

## 通常経路とflags

許可された固定task作業領域をcwdとし、helperを絶対パスで呼ぶ。`TOMBO_ROOT` が必要な配置ではrepositoryを明示する。時刻を偽装するCLI optionはない。

```text
node <helper> activate --input task.json --ledger sdk.jsonl --out state.json
node <helper> status
node <helper> receive --input receipt.json
node <helper> prepare --input task.json --ledger sdk.jsonl
node <helper> inspect --input task.json --proposal proposal.json --ledger sdk.jsonl --out state.json
node <helper> prepare --state state.json --observations observations.json --ledger sdk.jsonl
node <helper> update --state state.json --observations observations.json --proposal proposal.json --ledger sdk.jsonl --out state.json
node <helper> prepare --state state.json --operation reflect --ledger sdk.jsonl
node <helper> reflect --state state.json --proposal reflection.json --ledger sdk.jsonl --out state.json
node <helper> report --state state.json --ledger sdk.jsonl
node <helper> transition --input transition.json --ledger new-sdk.jsonl --out new-state.json
```

activateは未使用SDK ledgerとstate cacheのパスを固定し、sessionだけをstdoutへ返す。activateの `--out` はSDK state cacheのbinding指定でありactivation出力の保存先ではない。同じactivate要求は既存sessionを返す。別TaskPacket、budget、ledger/outでの再activateは拒否。

managed prepare/reportはstdoutへ出す（`--out`を使わず、必要なら別ファイルへshell redirectする）。inspect/update/reflectはbound cacheへ結果を保存しstdoutにも返す。指定する `--out` はactivate時のパスのみ。state入力はSDK正本との完全照合を受ける。既存生成/report操作では固定 `--ledger` を必ず指定する。status/receiveは保存されたbindingからledgerを取得し、明示したoverrideが異なれば拒否する。

activate済みcwdでは旧形式のhelper呼出しにもgateを適用。readyはsession解除ではない。sessionがある親workspaceの子directoryへ移動して再activateする経路も拒否する。未activation workspaceのlegacy helper/SDKは従来互換として残す。

## 出力

managed JSONは `mode: 'activated-session'`, `state: SDK state | null`, `session`, `effectiveDecision`, `budgetCheckpoint`, `assessmentScopeDiagnostics`, `apiCallsMade: 0`, `hostUsage: { totalTokens: null, costYen: null }`。

- prepare成功は従来 `binding/request/instructions/proposalSchema` も返す。bindingに `sessionId` を追加する。session sequenceや予算内elapsedはrequestHashへ混入させないため、正常prepare→applyが自分のcheckpointで無効化されない。
- 期限切れprepare/applyはbinding/requestを出さず、停止した実stateとsessionを返す（exit 0はコマンド処理成功でありreadyではない）。消費未確定の中断後はprepare/applyをrevision_conflictで拒否（exit 1）。
- SDK `state.decision` は旧評価snapshot。未評価追補があれば `effectiveDecision` はneeds_check、予算/会計不足・未確定ならblocked。旧readyを最新追補まで評価済みとは表示しない。
- `session.binding`: `sessionId, workspace, ledger, statePath, taskId, taskHash, budget, startedAt`。startedAtは初回SDK commitでsealし不変。
- `session.head`: `revision, stateHash`。SDK ledgerのredacted stateに結び付く。
- `session.updates`: 受領履歴。`pendingUpdates` は未評価のもの。`status: 'received_unassessed' | 'applied'`, `appliedRevision: null | number`。
- `session.pendingUsage`: `toolCalls, costYen, totalTokens: null, executionIds, observedElapsedMs: [{executionId,elapsedMs}]`。実時間の区間を単純合算しない。SDK計上済みexecutionを除外し、複数receiptで同一実行を重複計上しない。
- `pendingOperation`, `accountingUncertain`, `stopReceipts`, `transitions` は中断・停止・正当な目的変更の追跡記録。

reportは旧理解snapshot、受領済み・未評価、実停止・未計上消費を区別して表示する。生成側のraw JSON/私的推論を利用者向け説明へそのまま流すための機能ではない。

## receive

```json
{
  "id": "followup-1",
  "source": { "kind": "document", "locator": "local:counterexample", "receivedAt": "2026-10-20T14:00:00Z" },
  "text": "必要最小限の追補",
  "references": ["local:counterexample"],
  "observations": []
}
```

source.kindはdocument/user_statement/tool。text、references、observationsの少なくとも一つが必要。参照だけの受領やprobe未定でも保存可。期限後に新しい検査を実行する機能ではない。actual observationsは既存Observation schema、証拠本文とhashを照合する。受領だけでSDK evidence/claimsへ昇格しない。

同receipt IDの同payloadは再配送、異payloadは拒否。同execution ID/payloadはreceipt間・SDK間で重複課金しない。衝突は拒否。

observations付きreceiptは対応するexecutionがSDKに適用され、pendingAssessmentがなくなったrevisionへ自動対応付け。text/referenceだけのreceiptは `prepare/update --receipt <id>`（複数指定可）で実観測との一致を検証して関連付ける。textなら同じ本文/locator、referenceなら取得資料のlocatorが対応する必要がある。

期限切れのprepare/updateに既に発生済みobservationsを渡した場合は、生成せず内部receiptに受領して実消費を保持する。追加のreceiveで同executionを渡しても二重計上しない。

## transition

別目的へ利用者が実際に変更した場合だけ使用する。新資料/反例/人回答/説明の言い換えやsame-goal期限切れには使用しない。inputは `task`（新TaskPacket）、`reason`、`previousSessionId`、`hand_over_summary: { unresolvedGapIds, unknowns }` と次の `userChange` を要する。

```text
id, kind:'user_statement', locator, receivedAt, passage, contentHash,
previousGoal, newGoal, previousSuccessCriteria, newSuccessCriteria
```

旧sessionと実際の新旧条件、本文hashを照合。旧未解決gapをhandoverに含める。新ledger/outは未使用かつ旧と異なるパス。旧session/task/ledger/start/budget/revision/hash/usage/stopReason/未評価追補/未計上消費/unknownsをtransitionsへ残す。新task予算は旧taskの残予算と表示しない。

## authorityと限界

session正本は固定workspaceの `.session/tombo-session.jsonl`、cacheは同`.json`。SDK理解/usage/stopの正本はbound SDK ledger。パスはrealpathを解決しWindowsではcaseも正規化する。schema/sequence/hash/前event参照と排他lockを検査する。

SDK操作前にintent、生成後commit前にredacted結果をsessionへsyncする。SDK commit済みなら照合してsessionを追記復旧、SDK commit前なら保存された同じ結果だけをcommitできる。結果確定前の中断はaccountingUncertainとして止め、再生成/新予算に逃がさない。lockが残った実プロセス強制終了は、自動でlockを奪わず明示的な復旧を要する。

cache欠落は正本から復元する。redacted本文は再検証済みではない。復元後の生成には既存SDKの本文再取得条件を守る。

これはhost sandboxではない。別の作業領域、session正本の外部削除/両正本の同時改ざん、SDK/CLI直呼び、虚偽のuserChange参照を強制的に封じる保証はない。host由来の改ざん不能な発話IDは提供されていない。原会話全文やsecretをreceiptへ保存しない。費用/tokenはunknown。自発的な通常経路使用はPM所有のfresh raw-only行動試験で確認する。
