# Participant profile handover

## 変更

`scripts/metacognition-host-trial.mjs` は、protocol の `participantModel` を `RunSchema.shape.model` で検証して使う。未指定の場合は既存の `codex/gpt-6.1-sol/medium` を保持する。明示した `null`、必須項目の欠落、空文字、追加項目は生成要求前に拒否する。

従来の返却応答の profile 検証も、選択した profile と比較する。run と trace に同じ profile を保存する。検証は構造の検証であり、モデルの提供状況を確認する機能ではない。

## 検証

新規 `test/host-trial-profile.test.mjs` は実 CLI 子プロセスと標準入力の fixture bridge を使う。

- low を設定した protocol で low の応答を受理し、run と trace に low を保存する。
- low を設定した protocol で medium の応答を拒否し、`invalid_host_binding` を残す。
- 参加モデルが未指定の protocol で medium の応答を受理する。
- 4 種類の無効設定を、生成要求の出力前に拒否する。

修正前の `node --test test/host-trial-profile.test.mjs` は 4 件中 1 件成功、3 件失敗した。low の応答は error、medium の不一致応答は success、無効設定は終了コード 0 だった。

修正後の `node --test test/host-trial-profile.test.mjs test/host-trial-repeated-source.test.mjs` は 6 件全て成功した。`git diff --check` も成功した。全体試験と独立レビューは親が担当する。

## 検証範囲

fixture の応答を使った境界と永続化の検証である。実モデルへの dispatch、費用測定、速度比較は実施していない。low の速度や費用の優位性は未実証である。

Model the Domain に従い既存の RunSchema の model 構造を使った。Boundary Discipline に従い protocol の読取り時に検証した。Test Behavior, Not Implementation と Prove It Works に従い実 CLI の成功応答、拒否応答、保存値を試験した。

## 作業範囲

変更は driver、新規 profile 試験、この handover のみ。README、評価データ、protocol、他の編集は変更していない。コミットと push は実施していない。

## 親による統合確認

全300試験が成功した。GLM第1回は旧設定の試験が現行protocolに暗黙依存する点を挙げた。fixtureで設定なしを明示構成するよう修正し、4試験成功と第2回静的レビューpassを確認した。次回の凍結先は別ファイルで、旧protocolは保持する。
