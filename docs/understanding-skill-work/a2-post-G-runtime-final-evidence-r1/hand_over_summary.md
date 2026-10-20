# Post-G runtime handover

所有範囲のTDD・実装・検証を完了し、source/testを2026-10-21 03:13:32.988 JSTにfreezeした。同runtime writerで継続、新PM/writer/reviewer/子taskなし。binding `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9` を実確認。T3の古いbranch labelは使っていない。

独立Google PASSはdesign readinessのみ。全D/E/F/G失敗・旧724/705/712実績・歴史的untrackedを過去記録として保持し、今回のA2/fullreview/意味的実効性PASSへ流用しない。全npmはPM工程で未実行。費用/token unknown。

## 読取・所有範囲

指定6文書を全文確認: locked-charter、parent-authorized-scope-amendment-r1、a2-post-G-source-diagnosis-r1、a2-post-G-repair-design-r1、a2-post-G-independent-design-review-r1、a2-post-G-design-conditions-accepted-r1。reviewのdisputedはclaim statusとassessment verdictを混同するため採用せず既存enumを維持。K4 pre-code baselineの37 filesはPMのbaseline-recheck記録を確認し、snapshotがHEADのcommit blobではなく作業treeであることも確認した。K4比較case、未来raw、observer証拠本文は読んでいない。

製品/試験の変更は次の3ファイルのみ。その他の既存tracked/untracked編集を戻していない。core/types/report/binding試験はbefore.jsonと最終hashが一致。新依存、外部API、secret、global hook/installed skill、commit/push/PRなし。

- `skills/tombo-view/scripts/session-store.mjs:31`: strict ISO日時検査。163からdescriptor検証/履歴不変/実時計検査、202 activate、233 reconcile、317 checkpoint、346 receive、419 transition。
- `skills/tombo-view/scripts/session.mjs:34`: clock入力。100/138付近のprepare/apply gate、183 top-level出力、195 report/null state、224 CLI option。126の短reminderは既存guidance全文を残して差し替えた。
- `test/session-followup.test.mjs:20`: 既存harnessに任意clockをpublic SessionStoreでactivateする経路を追加。745以降に新規11件。既存post-F provenanceループの未来日時1値だけを過去の明示offset日時へ変更した。

## TDDの実記録

製品変更前hash/mtimeはbefore.json。red-r2実行後にもstore/helperが開始前hashのままであることを確認し、PMへREDを通知してから製品変更した。製品初回writeの専用時刻は別計測していないため創作せず、製品編集はlegacy-red終了後〜green-r1開始前というtool順序で記録する。最終mtimeはsource-freeze.json。

|記録|command識別|JST開始→終了|exit|tests/pass/fail/skip|
|---|---|---|---|---|
|red.json/log|post-G filter|03:02:28.812→03:02:42.806|1|9/0/9/0|
|red-r2.json/log|post-G filter|03:03:32.251→03:03:51.300|1|10/0/10/0|
|legacy-red.json/log|post-G exact legacy filter|03:04:34.515→03:04:36.302|1|1/0/1/0|
|green-r1.json/log|post-G filter|各jsonにexact時刻|1|10/9/1/0|
|green-r2.json/log|post-G filter|各jsonにexact時刻|0|10/10/0/0|
|green-final.json/log|post-G filter|03:08:44.370→03:09:15.855|0|11/11/0/0|
|focused.json/log|3 session files|03:10:29.862→03:12:25.104|0|57/57/0/0|
|regression.json/log|16関連files|03:10:39.686→03:11:02.107|0|284/284/0/0|
|build-final.log|npm run build|03:12:31.115→03:12:31.964|0|該当なし|
|typecheck-final.log|npm run typecheck|03:12:31.964→03:12:32.696|0|該当なし|

すべてcancelled 0。正確なcommand全文/exit/実件数/全時刻/log SHA256/失敗assertionはverification-summary.json。旧attemptを上書きしていない。

```powershell
node --test --test-name-pattern='post-G' test/session-followup.test.mjs
node --test --test-name-pattern='post-G exact legacy' test/session-followup.test.mjs
node --test test/session-budget-checkpoint.test.mjs test/session-binding.test.mjs test/session-followup.test.mjs
npm run build
npm run typecheck
```

RED根拠は、undated receiptを拒否する旧動作、新future日時を受け入れる旧動作、既存SessionStore.activate第4引数を無視して期限後もprepare/request/SDK実行へ進む旧動作、clock/status metadataと不変gateの欠落、保存済みhelper時刻との診断欠落。clock gate試験は実public APIと実subprocess/OS待機で作り、fake clock CLIや成功SDK stateの改ざんを使っていない。

初回red.logのtransitionは未知CLI flagへ到達したため、その1件をclock動作REDとは数えない。red-r2では実session stopのassertionをCLI呼出しより前へ移して製品未変更のまま失敗を再確認。legacy専用試験は当初別のnull-state report未対応へ到達したため、実inspectを先行するlegacy-redで意図した診断assertionまで再現した。green-r1唯一の失敗はMarkdownのunderscore escapingを試験が素で比較したためで、rendered identifierのescapeを除いて比較するよう訂正した。これらの旧ログをすべて保持する。

旧post-Fでnew 2040日時を受理する1値は今回承認されたnew-only未来拒否と直接矛盾するため、過去のtimezone明示offset日時へ置換した。2件のprovenanceループ数と独立helper時刻/原時刻/hash/assertionsを維持し、未来新規拒否とlegacy未来完全一致replayを別途追加。旧post-F GREENはその時点の正当な歴史として保持する。

## 確定APIと実確認

詳細はapi-contract.md。新規receipt日時は省略unknown、指定はtimezone ISO/実在日時/helper受理+5000ms以内。拒否はappend/ID予約前、同ID省略retry可。旧exact replayはnew-only検査より先、日時有無/値変更はcollision、helperReceivedAtはoutput-only/元hash除外/実lock受理時刻。内部観測/撤回receipt・Evidence.retrievedAt・会計を保持する。

--task-clockはactivate/正当transitionだけ。exact {startedAt,deadlineAt,basis,sourceRef}を既存session正本へrecordedAt付きで一度封印。first_observedは非null実観測開始、host_providedは原開始nullを表現。期限済みwindowも受理して初回inspect前から止める。clockなしlegacyのcoverageはunknown、後付け/延長/同goal新task回避を認めない。

taskClockStatus {coverage,startedAt,deadlineAt,observedAt,expired}とsessionStopReasonをmanaged top-levelに加算。observedAtはその呼出しで実検査したローカル時刻で、出力組立中に別の未保存expiry観測を作らない。初回session.taskClockStopは再配送/再開で不変。期限後prepare/applyはrequest/binding/生成/評価なし。SDK stateがnullでもreportでき、存在しないSDK理解/usage/startedAtを作らない。

SDK予算内の実prepare→apply間の期限超過、期限内の実human answer→元gap解決→fresh reflect→ready、待機後の未評価receipt/撤回意図、cache削除/再開、未commit/commit済み両方の実stage復旧、正当新目的transitionと旧clock/usage/stop保存を確認した。SDK start/budget/実usage/旧理解/本来のstopは保持し、session期限をSDK budget_exhaustedへ置換しない。既存のpending/accounting/invalidate/authority/legacy/assessment correction/TOMBOreflection/scope診断回帰も通過。

legacy互換は一時試験journalで旧caller metadata/hashと新規null clock field欠落を正しいchainのまま射影したfixture。SDK state/usage/完了receiptを捏造していない。clock gateの証拠はこのfixtureに依存しない。既存reflectionEffects省略projectionも元の実SDK結果由来という境界を保つ。

## Freeze・未達・手続上の注意

03:13:32.988 JST source/test freeze後にhashを再確認。最終SHA256:

```text
skills/tombo-view/scripts/session-store.mjs
2bafafeaa30beb6067367ce75af9d46e2bf1abe58d4d80a1ca31729fe92b6219
skills/tombo-view/scripts/session.mjs
f545b21fa172b3fa975a09125ff981f6aa47b36e5446c3d76ec6ead66429688b
test/session-followup.test.mjs
588b274e13355a31b544cc77d9a9dd52d3b16dc7dba536c65538a945a2b88e08
```

親AGENTS探索で一度 `rg --files` の探索rootをD:/developまで広げたのは過広範だった。返却は先頭12パスの一覧で、main checkoutのsource本文は開いていないが、mainディレクトリの列挙が一切なかったとは証明しない。その後は親AGENTSを明示絶対pathで読み、探索を繰り返していない。これは適正だったと扱わずPMへ伝える。比較raw/observer本文読取や他所有ファイルの書込みはない。

既知の所有範囲未完了項目なし、検証processは全完了。API GREEN/freezeをPMへ通知済み、同docs writerへ契約連携可能。費用/token unknown。全npm/未見raw比較/semantic efficacy/独立full review/親監査は未実施のPM工程。helperは呼出し境界だけでhostの自由処理を即時停止するOS機構ではなく、原開始やcaller申告を認証しない。同goal延長APIはない。source/test追加編集予定なし。
