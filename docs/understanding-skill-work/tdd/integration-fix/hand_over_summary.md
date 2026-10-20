# 統合試験で見つかった既存report試験の契約更新

2026-10-20 JST。binding/branchは継続確認済み。今回の書込みは `test/cli-model-repair.test.mjs` と本 `integration-fix/` のみ。製品コード・新規3テスト・他担当文書は変更していない。費用/tokenはunknown。commit/push/PRなし。

## 原因と修正

PMの `docs/understanding-skill-work/integrated-npm-test-r1.log` にある2件の失敗を対象試験で再現。旧テストはreport全体に最新の不適用reasonがないことを要求していた。加算したscope診断欄では、そのreasonを適用不能理由として表示するため衝突した。

`test/cli-model-repair.test.mjs:172` からの変更で、各見出しのsectionを分離して検証する。

- 「証拠評価の理由（不明）」には旧current理由と `old-record` を保持し、不適用reasonと `current-record` を含めない。
- scope不一致の2ケースだけは「適用できなかった証拠評価」に不適用reason、claim `answer`、evidence `current-record`、主張scope `test`、当該証拠scopeをpositive assert。宣言上の不一致/文字列不一致の正しい種別と、旧理由が混入しないことも検査する。
- withdrawn/supersededの2ケースは引き続きreport全体で最新reasonを抑制し、scope診断欄も出さない。

期待値の削除による成功化ではなく、新旧の説明欄の役割を別々に厳密検証する変更。テスト名、ケース数、製品挙動は変更していない。完全な差分は `test.diff`。

## RED → GREEN

同一コマンド:

```text
node --test test/cli-model-repair.test.mjs
```

- RED: 2026-10-20T17:24:25.6653452+09:00開始、17:24:30.9087564完了。exit 1、30件中28 pass / 2 fail / skip 0。`red.json`, `red.log`。失敗assertionは両ケースとも全reportへの `assert.doesNotMatch(..., /The current record does not identify the boundary/)`。
- GREEN: `green.json` の時刻参照。exit 0、30/30 pass / fail 0 / skip 0。`green.log`。
- `git diff --check -- test/cli-model-repair.test.mjs`: exit 0。`diff-check.json`。

全 `npm test` は依頼どおり未実行。PMがこの差分を取り込んだ現在の共有checkoutで統合再実行する。
