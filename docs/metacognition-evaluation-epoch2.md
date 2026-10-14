# 第2回の実モデル比較

2026年10月14日、事前に固定した6合成ケースについて、通常再点検とTOMBOを各3回、計36試行比較した。受入判定は `FAIL`、優位性の判定は `INCONCLUSIVE` だった。失敗した試行を除外していない。

## 条件と結果

参加モデルは両方式とも `codex / gpt-6.1-sol / medium`。生成要求と資料取得を合わせて6回、各出力4000文字、全体300秒、形式修復2回という同じ上限を使った。評価注釈を参加モデルへ渡さず、GLM 5.3 が方式名を伏せた出力を独立に採点した。採点36件の引用・資料ID・出力ハッシュ検証に不正はなかった。

| 項目 | 通常再点検 | TOMBO |
| --- | ---: | ---: |
| 正常終了 | 18/18 | 13/18 |
| 正答率（失敗を含む） | 100% | 72.2% |
| 必須論点の再現率（失敗を含む） | 100% | 55.6% |
| 完全情報の対照で実際に行った資料取得 | 9/9 | 1/9 |

単位換算、cold/warm性能、依存関係インベントリの3課題族を使った。反証・未知保持のケースと、既に十分な資料がある対照を組み合わせた。繰返し18組を18個の独立ケースとは扱わない。独立ケース数は6であり、記述的比較である。

TOMBOの5エラーは2件の時間切れと3件の `assessment_pending` だった。時間切れ2件は固定時間上限を超え、実行記録検証でも不適合となった。後から得たモデル出力で置き換えていない。再取得時に同じ証拠IDへ異なる取得時刻を付けたことが、状態更新失敗の再現可能な原因だった。

評価器は失敗を正答・再現率0、falseClosure等を1として保守的に減点する。この減点は、誤った結論を実際に確定した件数や、実際に資料取得した件数とは異なる。対照の不要取得率は、実取得1件に時間切れの減点1件を加えて22.2%となり、上限10%を超えた。減点を除外しても実取得1/9は11.1%である。

## 記録と修正の境界

比較中の製品は `b2aeaefd0cb07500923eef7c22428bd227356c59` に固定した。[プロトコル](../evaluation/metacognition-fresh-protocol.json)とデータのハッシュを実行時・採点時に照合した。36試行の生成要求78回と、資料取得の会計は一致した。生の会話や内部の思考過程は公開記録へ含めない。

比較完了後、証拠の観測ID分離と、根拠に基づく評価解釈の明示訂正を統合した。統合版の回帰試験291件は成功した。コア、CLI・スキル、再取得修正はGLMの静的独立レビューに合格した。これらの修正後の意味的効果は、この比較で実証されていない。

ホストの生成費用・トークンと非公開の上流要求数は不明であり、金額上限の保証はできない。追加の有料生成APIとJevは呼んでいない。全ての未知の発見、幻覚防止、一般的な優位性を示す結果ではない。

## English

The second frozen comparison used six public synthetic cases in three paired families, with three repetitions per method. Both methods used `codex / gpt-6.1-sol / medium` with identical limits. All 36 trials and independent blinded GLM judgements were retained. Readiness was `FAIL` and superiority was `INCONCLUSIVE`.

The baseline completed 18/18 trials correctly. TOMBO completed 13/18; its failure-inclusive correctness was 72.2% and required-finding recall was 55.6%. Two TOMBO trials timed out and three stopped with pending assessments. Error penalties in the scorer are not observed semantic false closures. The controls contained one actual unnecessary TOMBO record read in nine trials, compared with nine baseline reads.

The product stayed at the frozen commit throughout the comparison. Observation identity and explicit evidence-grounded assessment correction were integrated afterwards, with 291 passing regression tests and independent static reviews. Their semantic effect still requires a new frozen comparison. Host costs, tokens and hidden upstream requests remain unknown. No additional paid generation API or Jev call was made.
