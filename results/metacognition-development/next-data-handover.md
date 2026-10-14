# 次回評価データの handover

隔離 worktree の未使用データを準備した。参加モデルの実行、protocol の作成、既存コードの変更、コミット、公開は実施していない。

## 成果物

- `evaluation/metacognition-next-cases.json` は合成の 6 ケースを持つ。構成の継承、UTF-8 バイト制限、有向グラフの到達可能性を各 2 ケース扱う。
- `evaluation/metacognition-next-annotations.json` は 2 つの反証、1 つの必須 unknown、3 つの完全情報対照例を定義する。対照例にも採点基準を付け、範囲の拡張と不要な情報取得を区別する。
- `test/metacognition-next-data.test.mjs` は公開済みの packet builder、dataset validator、record executor を実行し、データと情報取得境界を検査する。

Kimi の提案 `D:\develop\works\tombo-view\results\metacognition-development\next-evaluation-design-kimi.json` を整形した。family 内の tool description を統一し、完全情報かどうか、override の値、計算結果、グラフの被覆範囲が metadata だけで分からない形にした。source の本文と annotation は参加者の初期 packet に含まれない。

## 確認した結論

- 本番 override は defaults より優先する。反例の defaults=true と production=false をマージすると false になる。対照例は両方 true なので true になる。
- `Buffer.byteLength` の UTF-8 計算で `あいうab` は 11 バイトだった。5 コードポイントでも 8 バイト制限を超える。対照例 `abcde` は 5 バイトで制限内となる。対象 policy は overhead がないと明記する。
- 部分グラフの既知行は `A->[B]`、`B->[C]` である。未公開の C 行を `[D]` にすると D に到達し、空にすると到達しない。両方の補完が既知行と一致するため D の到達可能性は未確定となる。完全対照例の既知行からは B、C、D への到達を確認した。
- 既存 original/fresh データとは id と family が重複しない。初期 packet は task、context、draft、capabilities、tools のみを返す。tool は id、capability、description のみを返す。record executor は宣言外の source を拒否する。

## 再現コマンド

作業ディレクトリは `D:\develop\works\tombo-view\.audit\assessment-correction-worktree`。

```powershell
node --test test/metacognition-next-data.test.mjs
git diff --check
```

試験は 5 件成功、0 件失敗。diff の空白検査も成功した。全体の build/test はこのデータ作業では再実行していない。

## 未確認の境界

ケースの意味と構造の局所検証を実施した。独立レビュー、評価 protocol の固定、参加モデルによる全比較、採点は未実施である。これらのデータ試験は TOMBO の実モデル効果の証拠ではない。

候補の `codex/gpt-6.1-sol/low` は次回実験案である。速度、費用、精度は未実証である。新データと effort の同時変更による結果を、effort の単独効果として扱わない。

Model the Domain に従い、既存の case/annotation と同じ形を保持した。Prove It Works と Test Behavior, Not Implementation に従い、実際の packet/record 関数と値の計算を試験した。
