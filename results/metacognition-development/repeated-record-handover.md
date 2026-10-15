# 同じレコードの再取得修正 hand_over_summary

2026-10-14 08:01:55 +09:00 に確認した。対象は `D:/develop/works/tombo-view/.audit/assessment-correction-worktree`、ブランチは `devin/20261014-assessment-correction`、開始時HEADは `502cb26e103af9449427a13ae471d98eb5d2a1f4`。コミットは親エージェントが行う。

## 原因と再現

host driver の executor は `response.id` を Evidence ID、locator、sourceGroup の全てへ使っていた。実際に同じレコードを再読取りすると、同じ Evidence ID に新しい retrievedAt が入る。runner の既存証拠照合が本文以外の取得メタデータ差も拒否し、`invalid_probe_output` の error 観測を作る。SDK はその観測を評価せず保存するため、表面の stopReason は `assessment_pending` になる。診断されたのは提供者やモデル提案の失敗ではない。

実 driver の REQUEST/DONE コマンド入出力を使う NoTools fixture を追加した。二つの必須gapに、それぞれ別のclaimとprobeを宣言し、両probeが `replay-report` を物理取得する。モデル相当のfixtureは受け取った observations の実際の証拠IDから型に合う assessments と resolutions を作る。注釈は読み込まない。取得間の5ms待ちは取得日時差を再現するためだけに置く。

最終版のfixtureから Evidence ID 一行だけを旧実装へ一時的に戻し、REDを取り直した。元の修正内容は finally で戻した。結果の全文は [repeated-record-red.log](repeated-record-red.log) にある。

```text
AssertionError [ERR_ASSERTION]: {"reason":"invalid_probe_output","stopReason":"assessment_pending","pending":["04478357-d16e-4d5e-abea-42956b75f731"],"calls":4,"physicalChecks":2}
actual: [ 'inspect', 'update' ]
expected: [ 'inspect', 'update', 'update', 'reflect' ]
tests 2
pass 0
fail 2
```

## 修正

- `scripts/metacognition-host-trial.mjs` は各実行の Evidence ID を `${response.id}:${input.executionId}` とする。locator と sourceGroup は宣言済みレコードIDを維持する。生成への指示は入力observationsまたはstate.evidenceの実際の証拠IDを使うよう明記し、モデルにIDやハッシュの計算を求めない。
- `renderUnderstanding` は元から sourceGroup へ写像していたため変更不要。最終回答の sourceRefs が `['replay-report']` となり、実行UUIDを出さないことをfixtureで確認した。
- 既存 `test/host-trial.test.mjs` と `test/host-trial-repair.test.mjs` は証拠ID参照だけを実入力へ移した。意味のassertionは変えていない。
- `test/host-trial-repeated-source.test.mjs` は二度の取得、固有Evidence ID、両updateの評価、必須gap解決、全claim再考、最終回答、宣言済みsourceRefs、未知の費用とトークン数を確認する。追加のrepair例では保存済み観測の全body一致、物理取得の二重計上防止、共有6回上限によるreflection未完了停止を確認する。
- `skills/tombo-view/references/host-session.md` は実再読取りに新しいexecutionIdとEvidence IDを使い、レコードIDはsourceGroupとlocatorへ保持するよう明記する。同じ配送の再試行には、保存済みの同じ本文、取得日時、利用量を含む同じbodyを使う。

SDKのID照合、runner、型、journal、report、helper、availableSources、dataset、プロトコル、上限、会計、ホストbindingは変更していない。ROOT、ROOTビルド、配置済みスキルは変更していない。epoch2の既存結果を救済したり、同じ比較を再実行したりしていない。この修正は次の固定比較版の候補である。

## 実施した検証

全コマンドは対象worktreeから `require_escalated` で実行した。外部APIと参加者モデルは呼んでいない。

```text
npm run build
node --test test/host-trial-repeated-source.test.mjs
node --test test/host-trial.test.mjs test/host-trial-repair.test.mjs test/host-trial-repeated-source.test.mjs
npm test
git diff --check
```

- 新fixtureは2件PASS。正常例は4生成と2物理取得を合計6回として計上し、2ラウンドのupdateとreflectionを終えた。実型stateはready、answer claimはcontradicted、回答はrefuted。
- repair例は追加生成を元の6回上限へ計上した。取得済み観測を再利用し、物理取得は2回のまま。reflectionへ必要な生成枠が残らず、unknownのまま停止した。
- focusedは11件PASS。全文は [repeated-record-focused.log](repeated-record-focused.log) にある。
- npm testはbuildを含み、291件PASS、fail 0、cancelled 0、skipped 0。全文は [repeated-record-suite.log](repeated-record-suite.log) にある。
- git diff --checkは終了コード0。

REDのPython表示時には端末のcp932がテスト記号を表示できずUnicodeEncodeErrorになった。RED実行とUTF-8ログ保存は完了しており、finallyで固定版を復元した。直後のfocusedと全suiteが固定版でPASSした。

## 判断と未検証範囲

Fix Root Causes に従い実driverで停止原因を再現した。Model the Domain に従いレコードの識別と取得観測の識別を分離した。Test Behavior, Not Implementation と Prove It Works に従い、実コマンド入出力、SDK更新、最終回答を確認した。

独立commentsチェックと最終コードレビューは親へ依頼済み。実参加者モデルによる有効性、費用、速度向上は未検証。synthetic fixtureの成功を比較評価の改善と扱わない。既存epoch2結果は変更しない。
