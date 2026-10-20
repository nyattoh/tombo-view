# Post-G runtime API contract

2026-10-21 JST。実RED後、対象11/11、最終全focused57/57、関連回帰284/284、build/typecheck各exit0、fail/skip0。commands/clock/outputは実helper subprocessとpublic SDKで確認。決定論的invariant試験でありsemantic efficacy・A2・full reviewのPASSではない。source/testはsource-freeze.jsonでfreeze。旧post-F等の契約・失敗記録は過去実績として保持し、この追記が新規receipt日時とtask clockの現契約となる。

## Receipt日時

新規 `receive --input receipt.json` の `source.receivedAt` は省略可。省略はunknown、fieldを補わずpayloadHashにも注入しない。nullは省略ではない。指定時はtimezone付きISO date-time（秒、任意fraction、Zまたは±HH:mm/±HHmm）、実在する日付・時刻で、同じhelper受理観測時刻+5000ms以内。5000msは許容幅であり時刻の認証ではない。過去日時を真正と認定しない。

base shape/本文hash/実execution payloadを従来どおり検証。既存ID/同normalized payloadは新規専用の形式・未来検査より前に元receiptを返す。旧future/zone-less日時を修正・移行しない。日付の有無・値の変更はcollision。拒否はappend/ID確保前で、同IDの日時省略retryが可能。root helperReceivedAt入力は引き続き拒否。

`helperReceivedAt` は排他lock中の全検証後の初回OS受理時刻、output-only、元payloadHashから除外。exact再配送/cache/replayで保持、旧欠落はunknown/backfillなし。内部期限後観測/撤回receiptのsource.receivedAtと再配送、Evidence.retrievedAt・実usageは保持する。

reportはhelper実受領時刻とcaller申告時刻unknownを分離し、callerは未検証と明記。旧caller日時が保存済みhelper時刻+5000msより未来なら保存値同士の不整合を表示し、後日の時刻で消さない。helper witness欠落や旧timezone不明は比較unknown。本文の真偽判定ではない。

## Task clock入力と保存

```text
node <helper> activate --input task.json --ledger sdk.jsonl --out state.json --task-clock clock.json
node <helper> transition --input change.json --ledger next.jsonl --out next.json --task-clock clock.json
```

`--task-clock` はactivateまたは従来条件を満たす正当なtransitionのみ。その他commandではinvalid_input。入力JSONのexact4 fields:

```json
{"startedAt":null,"deadlineAt":"2026-10-21T12:00:00Z","basis":"host_provided","sourceRef":"user:absolute-deadline"}
```

日付はreceipt同様のtimezone-qualified ISO。known startedAtは未来不可、deadlineAt以前。`first_observed` は実ローカルtool観測に基づく非null startedAtが必要。`host_provided` は不明原開始をnullのまま表せる。原開始をSDK.startedAtから復元しない。既に過去のdeadlineでもclosed windowとして受理する。descriptorのrecordedAt入力は拒否。

既存export `SessionStore.activate(task, ledger, statePath, clockInput?)` / `transition(change, ledger, statePath, clockInput?)` の任意第4引数へ対応。従来3引数も維持。新clockは `session.taskClock: { ...descriptor, recordedAt: ISO string }` として既存session正本に一度封印する（clockなしはnull、legacy field欠落も有効）。同session再activateで省略なら維持、同descriptorは再配送、変更やclockless legacyへの後付けはrevision_conflict。新task/ledger/outによるsame-goal回避は従来どおり拒否。

同session event間でclockと初回stopを変更できないことをload/reconcile/append時に確認。正当transitionは `session.transitions[].previous.taskClock` / `taskClockStop` に旧clock/stopを保存し、旧SDK usage/stop/pending/unknownも保持する。保存済みcommitの復旧を完了してから新規作業をgateし、期限を理由にcommitを巻き戻さない。session正本を追加したりSDK authorityを変更したりしない。

## Outputと停止

managed JSONへ加算:

```json
{
  "taskClockStatus": {
    "coverage":"unavailable",
    "startedAt":null,
    "deadlineAt":null,
    "observedAt":"2026-10-21T00:00:00.000Z",
    "expired":null
  },
  "sessionStopReason":null
}
```

coverageはunavailable/host_provided/first_observed。clockなしの日時とexpiredはnull。observedAtは当該呼出しの実OS検査時刻で、生成時計やcaller申告値ではない。期限後の初回実観測を `session.taskClockStop: {reason:'task_deadline_exceeded',observedAt}` に保存し、top-level sessionStopReasonにも同じobjectを示す。再配送・再開で初回stop不変。

prepareとinspect/update/reflect/invalidate適用直前（初回inspectを含む）にgate。期限後はrequest/bindingも新規生成・評価・再考・撤回適用もなく、effectiveDecision blocked / canReportCompletion false。初回前ならstate:null、SDK ledger/startedAt/usageを捏造せず、reportもnullをSDK renderへ渡さない。

status/receive/reportと既に発生したobservations/撤回意図の未評価保存は可能。SDKに実予算が残ればSDK stopReasonは元のまま、task_deadline_exceededをbudget_exhaustedへ偽装しない。従来の非生成SDK checkpointが実elapsed/予算停止を保存することは維持し、旧理解・実usage・本来のstopとsession期限を区別する。

helper呼出し境界のgateであり、host自由処理を即時中断する常駐hook/OS期限保証ではない。host_providedは未認証申告、first_observedは観測前の原開始範囲を保証しない。現在helperにsame-goal予算/期限延長機能はない。

## Prepare reminderと試験境界

managed prepareは既存SDK guidance全文を維持し、共通短reminderを差し替えた。実回答→既存gap/claim対応・根拠ある解決・残る確認を保ち、結論に必要な追加仮定、引用が全て真でも結論が偽となる条件を検討する。過去の過剰なsupportsはlimitationsのみで済ませず既存assessmentCorrections/inconclusive/gap/条件付き説明へ根拠に応じて反映する。claim status disputedをassessment verdictとして追加しない。自然文分類器・domain blacklist・semantic oracle・新schemaはない。

REDは既存SessionStore第4引数が無視される現動作と実subprocessを使い、未知CLI flagだけの失敗にしない。legacy互換fixtureは一時試験journalのcaller metadata/hashとnull clock field省略のみを射影し、正しいhash chainを保つ。時計gate/成功stateを偽journalで作らず、実OS待機・public SDKで作った状態を使用。モデル意味効果、fresh raw比較、全npm、独立full review、親監査はPM工程。費用/token unknown。
