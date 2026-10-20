# 実装 handover

## 完了範囲

2026-10-20 JST、binding `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、base `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`。

割当範囲の実装と対象検証を完了。費用/tokenはunknown。commit/push/PRは行っていない。禁止されたmain checkoutの直接参照、依存追加、secretアクセス、外部モデルAPI呼出し、global設定、Hidden-Side/CrossRAG変更を行っていない。PM所有docsへ書き込んでいない。

## 変更ファイルとsource行

- `src/types.ts:42`: `AssessmentScopeDiagnostic` 型を追加。
- `src/core.ts:45`: 純粋な `assessmentScopeDiagnostics` を追加。既存の訂正digestとcurrent evidenceを用い、宣言上の不一致と文字列の差を区別。
- `src/report.ts:54`: stateから診断を再導出し、claim/evidence/index/digest/scopes/理由と次の行動を表示。モデルの解釈と保存時の未再検証境界を表示。
- `skills/tombo-view/scripts/session.mjs:83`: prepareトップレベルに同名配列を追加。`:101` はinspect/update/reflect結果。request/bindingとstate形状には追加しない。
- `test/assessment-scope-diagnostics.test.mjs:18`: 現動作のbaseline、純粋性、複数参照、支持との併存、訂正/撤回/旧版の除外、redacted replay。
- `test/assessment-scope-report.test.mjs:8`: actionable report、escaping、redacted境界。
- `test/understanding-session.test.mjs:54`: 実helperプロセスのdiagnosticsとreportの再導出。`:74` 理解循環/反例/ready後の追補/訂正/replay/本文再取得。`:124` human-only ask→人の回答。`:139` reflectによる新gap/probe。`:152` 台帳/再配送。`:170` 実時刻経過/検証不能。
- `src/index.ts` は既存の `export *` で公開できるため無変更。`src/prompts.ts` も既存契約で足りるため無変更。distは既存buildによるignored生成のみ。
- APIとhelper surfacesの確定仕様は `api-contract.md`。他担当の4文書変更と過去untracked資料を保持。

## TDDと正確な検証

初回準備build: `npm run build`、exit 0、`baseline-build.log`。

製品変更前の採用RED（2026-10-20T17:18:33.5838434+09:00開始、17:18:42.0944068完了）:

```text
node --test test/assessment-scope-diagnostics.test.mjs test/assessment-scope-report.test.mjs test/understanding-session.test.mjs
```

exit 1、11 tests / pass 5 / fail 6 / skip 0。`red-final.json`, `red-final.log`。実際の失敗assertionは、exportがundefinedでfunctionでない、prepareの配列がundefinedで[]でない、reportに適用不能理由/保存時診断がないこと。既存動作baseline、人の回答、gap/probe追加、台帳/再配送、予算経過はこの時点で通過。

それ以前の `red.log` と `red-validated.log` にはテストadapterのusage不足も含まれる。後者の修正試行はSet-Content引数エラーで未適用だったため、採用REDにはしない。usageを修正してから `red-final` を実行し、その後に初めて製品ファイルを変更した。テストの失敗/操作エラーも削除していない。

最小修正後（17:19:19.9525281開始、17:19:31.0196365完了）:

```text
npm run build
node --test test/assessment-scope-diagnostics.test.mjs test/assessment-scope-report.test.mjs test/understanding-session.test.mjs
```

各exit 0。新規11/11 pass、fail/skip 0。`green-build.log`, `green-r1.json`, `green-r1.log`。

関連回帰（17:20:00.5374315開始、17:20:09.8045606完了）:

```text
npm run typecheck
node --test test/core.test.mjs test/reflection.test.mjs test/assessment-correction.test.mjs test/assessment-correction-surfaces.test.mjs test/assessment-correction-journal.test.mjs test/ask-policy.test.mjs test/session.test.mjs test/session-repair-feedback.test.mjs test/host-session-framing.test.mjs test/recovery-journal.test.mjs test/cli-reflection.test.mjs
```

各exit 0。関連既存202/202 pass、fail/skip 0。`typecheck.log`, `regression.json`, `regression.log`。既存試験は編集していない。`git diff --check` はexit 0（他担当文書のCRLF正規化警告のみ）。全 `npm test` は指示に従いPMの統合試験へ残した。

## 実確認した操作と限界

すべて公開SDKで状態を作り、helperを実子プロセスとしてspawnした。成功状態を作るための直接状態改ざんはしていない。report配列の偽装を無視する試験では、state外の説明配列だけを意図的に差し替えた。

1. prepare→inspect→実観測update→reflect→report。反例で旧回答をcontradictedへ変え、別claimで限定した新回答を支持した。再考後はreadyで質問なし。
2. ready後の新証拠でdisputedとなり解決gapが再開。stale bindingはrevision_conflict。明示訂正は誤読したsupportだけを置換し、独立したrefutationと証拠validityを維持。
3. human-only priority gapと回答probeは初期に双方向参照。実回答はuser_statementとしてupdateし、再考後にready。人の選択を外界の証明にはしていない。
4. reflectで新gap/probeの組を追加し、そのprobeへ観測を戻して更新。既存entityを上書きしない。
5. CLI replayで本文を伏せたstateを復元し、hash/startedAt/usage維持を確認。未取得本文でのreflectはpassage_unavailable。その後、同一metadata/hashの本文を新観測で再取得してupdate→reflectで再開。
6. ledgerと異なる旧stateはprepare時に拒否。同じexecution/payloadの再配送はstate/usage不変。payload衝突はinvalid_inputでtool/model利用量を重複加算しない。
7. 取得不能の観測はcapability_limit。公開SDKのclock指定で作った古いstateを実helperプロセスで再開し、elapsed予算超過をbudget_exhaustedとして停止。startedAt/modelCallsをリセットしない。
8. scope diagnosticsを呼ぶ前後でstate/hash/policy/usageをdeep comparison。mismatchだけでblockedにせず、current evidenceのvalidityを保持。

台本による決定的な機能確認であり、モデルの自発的理解能力、通常会話の暗黙discovery、一般的な実用効果は検証していない。診断は未訂正のcurrent証拠への不適用理由であり、証拠本文の意味を独立に真偽判定する機構ではない。SDK result schema/state/journal/hash/policy/解決条件は変更していない。

## PMへ残す作業

改訂文書とAPI契約の最終照合、全npm test、独立blind forward-test、独立full-diff review、親監査、承認済み手順によるcommit/push/Draft PR。本担当の未解決実装事項はない。API契約とGREEN証拠はPMへ通知済み。
