# Storage scope 最小修正 handover

2026-10-21 00:42 JST。binding `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`。同じruntime writerを継続し、新writerは起動していない。**担当実装/対象検証/記録は完了。コード・テストはPM指示でfreezeした。受入2/goal全体の完了は未宣言。**

## 変更範囲

- `skills/tombo-view/scripts/session-store.mjs` の保存先検査だけを変更。`.session/` 一律排除を具体的artifact衝突検査へ置換。
- `test/session-binding.test.mjs` のharnessに保存先prefixを追加し、意味のある7試験を追加。旧6試験は期待値を緩めず維持。
- 本storage領域に契約・ログ・検証要約を保存。既存 `runtime/api-contract.md` は保存先契約の追記のみ。
- helper/core/types/report/cli/旧試験/skilldocs/PM docsを変更していない。`test/session-followup.test.mjs` も無変更。
- main checkoutはGit metadataを除き直接参照していない。他担当/過去編集・untracked/失敗/監査/charter/旧ログは保持。新依存/API/secrets/OS設定/commit/push/PRなし。費用/tokenはunknown。

## 実装とsource行

- `session-store.mjs:128`: `paths`。workspace内の `.session/sdk.jsonl` / `.session/state.json`、nested配置を許可し、具体的な予約ファイルとの同一・親子・temp namespace衝突を拒否。
- `:134`: ledger/state/SDK ledger lock相互の衝突検査。既存の `state + '.lock' === ledger` 拒否も維持。
- `:139`: session正本/cache/lockとcurrent/transition履歴のSDK記録を保護。旧cache欠落時もそのpathと実temp namespaceを再利用させない。
- `:145`: 保存されたcanonical bindingを再検証。`:109` session追記前、`:165` guard、`:174` reconcileで共用。
- `:158`, `:366`: 初回activate/transition先の残存SDK lockを拒否し、削除・奪取しない。
- `:380`, `:384`: パス要素による親子判定と、実cache writerの `<cache>.<UUID>.tmp` 名前領域の判定。無関係なprefixを一律予約しない。

二authority/ancestor探索/canonical cwd/未確定会計/stop/budget/receipt/invalidate/recovery/transitionの意味、command/flags/JSON schemaは変更していない。保存先の正確な契約と例は `api-contract.md`。

## RED → 最小修正 → GREEN

**実helperの製品変更前RED**:

```text
node --test --test-name-pattern='session-only storage runs' test/session-binding.test.mjs
```

2026-10-21T00:35:04.0132875–00:35:04.3852115+09:00。exit **1**、1 fail / skip 0。`red-activation.json/log`。内部の実コマンドは固定root cwdで:

```text
activate --input .session/task.json --ledger .session/sdk.jsonl --out .session/state.json
```

実stderrは `revision_conflict` / `Ledger and state cache must be inside the fixed workspace and outside session authority.`。assertは期待status0に対して実status1。E01/E02の記録をこの実失敗の証拠へ読み替えていない。

**binding全体の製品変更前RED**:

```text
node --test test/session-binding.test.mjs
```

00:35:58.0702729–00:36:09.9408376、exit **1**。13 tests / pass 7 / fail 6 / skip 0。`red-binding.json/log`。

**最小store変更後GREEN**:

上記bindingコマンドで00:36:39.4959476–00:37:01.9997332、exit **0**。13/13 pass / fail 0 / skip 0。`green-binding-r1.json/log`。

**全focused**:

```text
node --test test/session-budget-checkpoint.test.mjs test/session-binding.test.mjs test/session-followup.test.mjs
```

00:39:58.8687480–00:40:39.6485162、exit **0**。34/34 pass / fail 0 / skip 0。`focused.json/log`。旧27件を現sourceで再確認し、新規7件を追加した実件数。

**関連回帰**:

```text
node --test test/core.test.mjs test/reflection.test.mjs test/model-repair.test.mjs test/assessment-correction.test.mjs test/assessment-correction-surfaces.test.mjs test/assessment-correction-journal.test.mjs test/assessment-scope-diagnostics.test.mjs test/assessment-scope-report.test.mjs test/ask-policy.test.mjs test/session.test.mjs test/session-repair-feedback.test.mjs test/host-session-framing.test.mjs test/recovery-journal.test.mjs test/cli-reflection.test.mjs test/cli-model-repair.test.mjs test/understanding-session.test.mjs
```

00:39:58.8687515–00:40:10.7316700、exit **0**。284/284 pass / fail 0 / skip 0。`regression.json/log`。以前の284結果とは別ログのfresh実行。

**build/typecheck**:

```text
npm run build
npm run typecheck
```

00:39:08.4836220–00:39:09.7476079、各exit **0**。`build-typecheck.json`, `build.log`, `typecheck.log`。対象 `git diff --check` もexit 0。

全 `npm test` は本担当では未実行。PMの `a2-integrated-npm-test-r2` へ残す。705固定やreviewerの未実測件数を採用していない。再現失敗/試験不備を隠すログ上書きはなく、製品変更前REDを保持している。

## 新規試験が実確認したこと

- `session-binding.test.mjs:162`: 固定root cwdでactivate→inspect→実ファイルread→update→reflect→report。TaskPacket/提案/観測/SDK ledger/cache/session ledger/cache/reportがすべて `.session/` に入り、root直下は `.session` だけ。SDK toolCalls 1、readyを確認。
- `:186`: nested保存先、case/相対alias、非予約の類似prefix名が成功。
- `:200`: 正本/cache/lock、同一path、両方向lock衝突、ファイル親子、session/SDK cacheの実UUID temp名との20組の衝突を実helperで拒否（Windows case例を含む）。入力ファイルを破壊せずactivationが成立しないことを確認。
- `:223`: 残存SDK lock保持、既bindingの別ledger/out拒否、cache欠落復元、元start/usage保持。
- `:245`: 正当transitionは可能で、現/過去のcache・SDK lock・cache temp名を新ledgerとして再利用する要求を拒否。旧cacheが物理的に失われても履歴予約を維持。SDK正本bytes/旧usageを保持。
- `:277`: 安全な内部directory aliasと同binding再activate、子directoryからのactivate/legacy prepareによるancestor迂回拒否。
- `:293`: `.session/` 配置で元の実5000ms期限を越えた同goal追補をreceiveし、元session/task/start/budget/理解/実消費とbudget_exhaustedを保持。新task/新budgetへ逃げない。

現在の全focusedには既存のmanaged invalidateの通常循環/旧stop/pending破棄/混在会計/再配送/transition/recovery/期限後receiptも含む。

## Hashと変更前後時刻

`before.json` は00:35:03.9008461 JSTに製品編集前のstore/helper/core hashとmtimeを記録。storeの旧mtimeは00:00:14.3339919 JST、新mtimeは00:36:38.7172630 JSTで、RED終了00:36:09以後。試験sourceの新mtimeは00:35:03.0500502 JSTでREDより前。最終focused/回帰の開始より後にsource/testを変更していない。

現在の完全な比較は `verification-summary.json`。binding試験の旧hashは以前のfreeze `runtime/verification-summary.json` 由来で、今回test編集前の新しいmtime採取とは扱わない。

```text
session-store.mjs
before 9d975899c84fa0500446c577f5b369848ff8c57104b37754bebcd6877c4f75b7
after  81c6563997a46aa740124d9c10eef19e851d3dafc09a01356634ef10be8b41e2

session-binding.test.mjs
prior recorded bdce3af663ee4eef0026e781acbc886ef05890f9fd43c72013952609795a8761
after          c07d8c636eb766ebc2ca12517491b46a7fef912df4b628663a913963de3a2acd
```

helper/core/followupのhashは変更前記録と一致。

## 観測境界と未実施

PM提供の観測境界を維持: E01/E02は保存scopeを読んだ起動辞退であり、過去に実activate失敗を観測したとは扱わない。本REDは別の実helper再現。E03のdirectSDK askをmanaged/token300受入へ格上げしない。E01/E02の期限stageをreleaseしていない。F raw内容/評価は読んでいない。

汎用hardlink/inode/ADS/dangling symlink/OS sandbox/OS設定/exclusive temp wrapper等は、明示scopeに従い実装・試験していない。既存のresolve/realpath/caseと協調的lock境界を保持する機構で、外部同時改ざんへの保証は追加しない。入力/reportの保存はcallerが許可領域を選ぶ契約であり、全shell書込みを規制する機能ではない。

同docs ownerへの契約同期、全npm統合の実件数、fresh raw行動評価、独立レビュー/親監査と公開判断はPM/親担当。追加source/test編集はfreeze解除と具体的な実不備指示まで行わない。
