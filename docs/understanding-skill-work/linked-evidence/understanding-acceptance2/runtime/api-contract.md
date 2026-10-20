# Acceptance 2 runtime API: implemented contract r1

**現行freeze（2026-10-21）:** managed invalidateを含む全focused27/27、関連回帰284/284、build/typecheckはすべてexit 0、fail/skip 0。最新記録・source hashesは `managed-invalidate-handover.md` と `verification-summary-invalidate.json`。以下の初期19件の記録も保持する。

2026-10-20 JST確認。`npm run build` exit 0、最終新規focused 19/19 pass / fail 0 / skip 0。証拠: `focused-final.json`, `focused-final.log`, `build-r2.log`。関連回帰284/284・typecheckもexit 0（`regression-r1.json/log`, `typecheck.json/log`）。関連回帰の後の製品変更は内部receiptの受領日時修正のみで、最終focusedに実時刻/再配送試験を含めて確認した。以下は既に動作試験した契約。

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
node <helper> invalidate --state state.json --input invalidation.json --ledger sdk.jsonl --out state.json
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
- `session.updates`: 受領履歴。`pendingUpdates` は現評価待ちqueue。`status: 'received_unassessed' | 'applied' | 'discarded_unassessed'`, `appliedRevision: null | number`。未評価破棄をappliedへ変換しない。
- `session.discardedUpdates`: 撤回で評価待ちを破棄したreceipt履歴。`discardedAssessment: { atRevision, executionIds, invalidatedEvidenceIds, reason: 'pending_assessment_discarded_by_invalidation' }` を持つ。混在receiptでは破棄subsetだけを記録し、残りexecutionがまだ未評価なら現pendingUpdatesにも残す。残りが後に評価されてもreceipt全体はdiscarded_unassessedでappliedRevision null。新しい単独receiptはその実評価に対応してappliedにできる。
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

内部receiptの `source.receivedAt` はhelperがその観測batchを初めて受領した実時刻。同じbatchの再配送では既存receiptの日時を保持する。SDK.startedAtを受領日時として使わない。元資料の取得日時は各Observation.evidenceのretrievedAtとしてそのまま保持し、受領日時と混同しない。PMのreadback所見を `receipt-time-red.json/log` で再現してから最小修正した。

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

## Managed invalidate（2026-10-21実装済み）

先に `managed-invalidate-diagnosis.json` で通常経路の欠落を再現し、r1/r2独立Google限定design PASS、入口のRED（5 fail/1 pass）とstop/pendingの専用RED（2 fail）を経て実装した。最初の実GREENは `invalidate-focused-r1.json/log` の8/8、exit 0、skip 0。全focused/関連回帰の最新結果は追加handoverを参照。過去の診断/設計/失敗ログは保持している。

```text
node <helper> invalidate --state state.json --input invalidation.json --ledger sdk.jsonl [--out state.json]
```

inputは既存SDKと同じstrictな `{ evidenceIds: ['実在ID'], reason: '撤回理由' }`。activate済みworkspaceだけで受け付ける。固定ledger明示、out一致、SDK state正本一致を検査する。prepareやmodel proposalは不要。未activation helperのinvalidateはinvalid_inputで拒否する。

予算内は非生成SDK invalidateを同sessionのbegin/stage/commit/sealへ通し、withdrawn→gap/probe再開→same-task update/fresh reflectを維持する。SDKの通常needs_check/needs_reflection等に従い、普遍blockedにしない。旧stopReasonがある場合だけ旧理由とblockedを保持し、active queueがあってもneeds_checkへ格上げしない。start/budget/実usageは保持、model/round/tool/tokenを架空加算しない。同入力の既withdrawnへの再配送はSDK revision不変。

撤回でSDKが破棄したpending batchは `session.discardedAssessments` の履歴と各receiptのdiscardedAssessmentへ記録し、appliedRevision nullのまま隔離する。SDK未計上の別executionは現queue/未計上usageから落とさず、計上済みの破棄executionを二重加算しない。履歴はSDK commit前/後の復旧で同じ意味を保つ。transitionは `previous.discardedUpdates` と `previous.discardedAssessments` に旧破棄履歴を保持し、reportに `評価せず破棄した観測` を別表示する。

期限後/会計不足/会計未確定ではSDK evidence/claimsを変更せず、`unassessed-invalidate-<digest>` の内部receiptへ `invalidation: {evidenceIds,reason}` を保存する。初回の実受領時刻を使い、同input再配送ではその日時を維持する。reportに「撤回申告は未適用」と表示し、旧snapshotを最新の有効性や評価完了と誤認させない。通常受領JSONにも同じstrict shapeの任意invalidation metadataを保存できるが、受領だけでは撤回しない。

管理外legacy CLI/SDK commitを無条件に採用するgate緩和はしていない。受入2全体の判定はPM/親のfresh行動試験・独立レビュー・統合試験による。

## 保存先契約追記（2026-10-21 storage修正）

`.session/` 全体をSDK保存先から排除する旧制約を、実際の正本/cache/lock/temp namespaceとファイル親子の具体的な衝突検査へ変更した。固定root cwdを維持したまま `activate --input .session/task.json --ledger .session/sdk.jsonl --out .session/state.json` と通常cycleが利用できる。nested配置と従来のworkspace直下配置も維持する。

session管理予約は `.session/tombo-session.jsonl`、`.session/tombo-session.json`、`.session/tombo-session.jsonl.lock`、cacheの `<cache>.<UUID>.tmp`。現在/transition履歴のSDK ledger/cache/ledger lock/実cache temp namespaceも再利用・衝突禁止。単なるprefix類似のnotes等は一律禁止しない。初回/transition先の残存SDK lockを拒否し、guard/reconcile/追記前にもbindingを検証する。二authority/stop/budget/receipt/invalidate/legacy/schemaやcommand/flagは変更していない。

正確な保存先例・予約名・境界・実GREENは `storage/api-contract.md` と同領域のhandoverを参照。利用者の保存許可を拡張する機構やOS sandboxではない。

storage修正の最終実測はbinding13/13、全focused34/34、関連回帰284/284、build/typecheck各exit 0、fail/skip 0。旧freezeの705/27/284は履歴として保持し、全npmの現在件数はPMが別途実測する。source/testはstore/bindingだけを変更してfreezeし、helper/core/followupはhash一致を確認した。

## Post-F契約追記（2026-10-21）

実RED14 fail/exit1後、対象14/14 GREEN・exit0・skip0でContract A/Bを実装した。詳細・最新の回帰結果は `post-F/api-contract.md` と同領域のhandover/verification-summaryを参照。

新valid receiptへoutput-only `helperReceivedAt`（初回validated受理のローカルISO UTC）を保存する。元payloadHashから除外、caller入力拒否、同ID/payload再配送時刻保持、legacy欠落はunknown/backfillなし。元source.receivedAtとEvidence.retrievedAtは改変しない。reportはhelper実受領時刻/caller申告時刻/証拠取得日時を区別する。

managed JSON top-level `understandingStatus: { requiredGapIds, reflectionStatus, canReportCompletion }` を都度導出。reflectionStatusはunavailable/not_required/missing/stale/inconclusive/completed。coreと同じtask/hash/全claim coverageで鮮度を判断し、basedRevisionやreflectionEffects有無で誤判定しない。required gap/評価待ち/未評価receipt/会計不確定/実停止を保持し、optional gapや破棄履歴だけで普遍blockしない。state/request/binding/SDK mutationなし。reportも同じ3事実を表示。prepareは既存guidance全文を保ち、実回答と既存gap・対象claimの対応、根拠ある解決/残る確認、重要変更時の許可内再考、条件付き応答とSDK段階完了の区別を短く追記する。

これは決定論的invariant試験のGREENであり受入2/意味的実効性/full review PASSではない。全npmはPM統合。旧実績・失敗記録は保持。

Post-F最終実測は全focused46/46、関連回帰284/284、build/typecheck各exit0、fail/skip0。対象14/14は新規12件と実期限境界の既存2件への追加assertion。owned3ファイルをfreezeし、保護対象core/types/report/binding試験の開始前hash一致を確認。正確なcommand/time/exit/source hashesはpost-F/verification-summary.jsonとpost-F/source-freeze.json。

## Post-G現契約追記（2026-10-21）

製品前の実RED→最小実装後、対象11/11、最終全focused57/57、関連回帰284/284、build/typecheck各exit0、fail/skip0を実測。旧実績/失敗は保持し、日時の新規入力について以下が現在の契約になる。詳細exact shape/commands/時刻/限界はpost-G/api-contract.md、最終hashはpost-G/source-freeze.json。

新receiptのsource.receivedAtは省略可（unknown、backfillなし）。指定時はtimezone-qualified ISO実在日時でhelper初回実受理観測+5000ms以内。拒否はappend/ID予約前、日時省略retry可。旧完全一致payloadは新規専用検査より前に返し、旧future/zone-less/hash/helper時刻を保持。日時有無/値変更はcollision。helperReceivedAt output-only/元hash除外、内部receipt/Evidence.retrievedAt/usageは維持。reportはunknown/未検証/保存helper時刻との旧不整合を区別。

activate/正当transitionだけに任意 --task-clock <JSON>。descriptorはexact {startedAt:string|null,deadlineAt:string,basis:'host_provided'|'first_observed',sourceRef:string}。first_observedは実観測の非null開始、known startは非未来かつdeadline以前。過去deadlineはclosed windowとして受理。session.taskClockにoutput-only recordedAtと封印し、same-session変更/後付け拒否、省略再activateは維持。正当新目的transitionはprevious.taskClock/taskClockStopと旧会計等を保持。

managed top-level taskClockStatus {coverage,startedAt,deadlineAt,observedAt,expired} と sessionStopReason null|{reason:'task_deadline_exceeded',observedAt} を加算。初回期限観測はsession.taskClockStopに保存し不変。prepare/初回含むinspect/update/reflect/invalidateをgate、期限後はrequest/binding/生成/評価なし・effective blocked/completionfalse。receive/status/report/実観測や撤回意図の未評価保存は継続でき、SDK開始/予算/実usage/stopを偽造しない。state:null reportにも対応。helper境界のみでhost即時中断や原開始の認証を保証しない。同goal延長機能なし。

prepareの短い共通reminderは、実回答と既存gap/claimの対応を保ち、引用が確立する範囲と仮定、事実が真でも結論が偽となる条件、既存assessmentCorrections/inconclusive/gapへの実反映を促す。semantic oracle/新verdict/新schemaなし。決定論的GREENはモデル意味効力/A2/fullreview PASSではなく、全npm/盲検行動比較/親監査はPM工程。

## F1 r2 actual API GREEN追記（2026-10-21）

実amended RED29/2pass/27assertfail後、core/types/helper限定実装の最初のF1実行29/29 GREEN、exit0、skip/cancel0。詳細shape・lifecycle・privacy・persistence・最新回帰とfreezeはF1/r2-green/api-contract.mdと同領域verification/handover参照。旧r1/r2 RED証拠は不変保持。

createTombo任意boolean captureProposalRejection（defaultfalse）を追加。managed helperのみ明示true。actual terminal update/reflect invalid_model_output後、返却失敗stateへboundされた一件のlastProposalRejectionを保存。SDK private provenance＋post-adapter validation phaseでstatic kind/安全な既存targetを分類し、raw例外/本文/新候補IDを新objectへ複写しない。inspect0/default/positive repair/実usageとschemaVersion0.1は維持。

r2はnon-proposal new revisionで元recordをunchangedの歴史として保持し、valid update/reflect適用でclear、新genuine failureでreplace。current binding破損はinvalid_input、older recordは同task/nonfuture/safe形状のinactive履歴。present inactiveはfeedbackと旧array fallbackを両方抑制。absentの場合だけlegacy fallback互換。shared helper derivationがmanaged/direct prepare/applyで同じrequest.validationFeedbackとrequestHashを作る。新flag/commandなし。

semantic understandingHashはmetadata除外、既存whole-state/session digestsには通常加算、legacy backfill/hash移行なし。store/report/journal/CLI/index/prompts/skilldocs未変更。F2/F3/予算/期限を緩めず、F3救済・意味効力・A2/fullreview/parent PASSは未主張。全npmはPM統合。

F1 r2最終実測はaffected4files119/119、related15files254/254、final build/typecheck各exit0、fail/skip/cancel0。最初のF1-only29/29を保持し、追加SDK invariant3件はaffected内で確認（全32 F1 cases）。最終freeze検査ではprotected11中README/host-sessionの2文書に並行変更を検出し、残る9/storeは不変。私の文書書込み・巻戻しはなく、protected11全不変とは記録しない。exact差分はF1/r2-green/freeze-drift-r1.json、最終source/test/prefix hashとcommands/time/exit/loghashは同source-freeze.json/verification-summary.jsonへ分離する。

PMはこのdocs2変更を、API GREEN後の同docs owner ordinal11への明示releaseによる正当な並行編集とwrite events/mtime/SHAで確認した。API仕様は29/29 milestoneから変更なしで、以後は実測数字と保全記録の訂正だけ。owned source3+test2をfreezeし、protected9不変と並行docs2を分ける。合成freezeと全npmは両owner終端後PMが行う。
