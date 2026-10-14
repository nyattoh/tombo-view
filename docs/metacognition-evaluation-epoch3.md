# 第3回の実モデル比較

2026年10月14日、事前に固定した6合成ケースを、通常再点検とTOMBOで各3回、計36試行比較した。受入判定は `FAIL`、優位性は `INCONCLUSIVE` だった。正常終了29件・エラー7件を全て保持し、失敗した試行を再実行で置き換えていない。

## 条件と結果

両方式の参加モデルは `codex / gpt-6.1-sol / low`。生成要求と資料取得を合わせて6回、各出力4000文字、全体300秒、形式修復2回という同じ上限を使った。設定継承、UTF-8のバイト上限、有向グラフの記録範囲という3課題族で、反証・未知保持と、十分な情報が既にある対照を組み合わせた。

| 項目 | 通常再点検 | TOMBO |
| --- | ---: | ---: |
| 正常終了 | 18/18 | 11/18 |
| 正答率（失敗を含む） | 100% | 61.1% |
| 必須論点の再現率（失敗を含む） | 100% | 44.4% |
| 完全情報の対照で実際に行った資料取得 | 3/9 | 0/9 |

繰返し18組を18個の独立課題とは扱わない。独立ケースは6であり、記述的比較である。前の比較から課題と推論設定を変更したため、設定変更による速度・費用・精度の改善を示す比較ではない。

評価注釈は参加モデルへ渡していない。GLM 5.3が方式を伏せた36出力を独立採点した。回答ハッシュ、完全一致の引用、既存資料ID、必須確認の実取得を検証し、不正な採点は0件だった。文字数の2件で採点者が空の参照配列を返したため、元出力を保存して参照だけを訂正した。評点、引用、順序を変えていない。途中の訂正委任がコマンド承認待ちへ進んだため停止し、短い会話内の訂正として回復した。未実行のコマンドを確認済みとして数えていない。[集計](../evaluation/reports/metacognition-epoch3-report.json)、[全試行](../evaluation/reports/metacognition-epoch3-runs.json)、[独立採点](../evaluation/reports/metacognition-epoch3-judgements.json)を公開している。

## 失敗と指標の解釈

TOMBOの7エラーは `model_timeout` 5件と `budget_exhausted` 2件だった。最初の2時間切れには、合成データの状態送信が自動承認レビューで拒否された影響がある。対象が公開予定の合成資料だけであることを確認して後続の委任情報へ明記したが、拒否された要求を実生成や成功には数えていない。

残る時間切れ3件の子実行は、元の試験終了後に完了した。文字数の2件は、試験要求からT3が委任を記録するまで350.092秒と313.976秒を要し、その後の提供者実行は20.604秒と19.903秒だった。グラフの1件は、その生成要求時の試験残時間172.709秒に対して、提供者実行が276.466秒続いた。後から得た出力を元の時間切れへ代入していない。これらの日時差は記録された時計を比較したもので、時計の独立同期や提供者内部の計算時間を測定したものではない。[時刻監査](../evaluation/reports/metacognition-epoch3-latency.json)を参照する。

評価器は実行失敗を正答・再現率0、falseClosure等を1として保守的に減点する。独立採点者の意味上のfalseClosure判定は全36件でfalseだった。一方、反証・未知保持の9試行中5件が失敗したため、評価器のfalseClosure値は55.6%となった。この値を、誤った結論を実際に確定した割合とは解釈しない。

完全情報の対照ではTOMBOの実取得は0件だったが、2件の時間切れにより不要取得の評価値は22.2%となり、固定した上限10%を超えた。実際に取得した件数と、受入条件を満たさない実行への減点を分けて示す。

## 固定した製品と比較後の修正

比較中の製品は `be0411b1a06f7d55c8a5f64816b22c7caf533105`。最初の参加要求の前に[プロトコル](../evaluation/metacognition-next-protocol.json)をコミットし、実行時・採点時にデータと条件のハッシュを照合した。全36件が終了するまで製品コードを変更・再ビルドしていない。

[会計監査](../evaluation/reports/metacognition-epoch3-accounting.json)では、予約した生成要求84回と資料取得23回の計107回を確認した。受理された実委任は82回で、拒否された2要求は実委任に含めない。試験終了前に受信した返信は79回だった。[実行経路監査](../evaluation/reports/metacognition-epoch3-runtime.json)は実handle82件の完了、提供者とモデル、ツール禁止の先頭指示を確認した。全82件の可視記録にツール実行はなかった。実際の推論設定、非公開の上流動作、請求額は確認できない。

グラフの記録不足では、取得し直した同じ内容を新しい証拠IDだけで進捗と数え、未解決の検査を再び実行待ちへ戻す問題を再現した。比較後の `673f005` で、executorが不変だと保証した固定snapshotだけを対象に、情報が増えない検査を休止する修正を統合した。他の必要な検査は続け、残る検査がなければ `no_progress` で停止する。未知の主張と未解決項目は保持する。

保存した合成モデル提案の再生、宣言なしの互換性、時点依存の状態確認、配送の再試行、証拠撤回、履歴、再考の失効を含む341試験が親の環境で成功した。Kimiの独立設計比較とGLMの静的レビューも行った。これらは機構と互換性の証拠であり、修正後の実モデル比較の成功ではない。

ホストの費用、トークン数、非公開の上流要求や再試行は不明である。追加の有料生成APIとJevは呼んでいない。全ての未知の発見、幻覚防止、一般的な優位性を示す結果ではない。

## English

The third frozen comparison used six public synthetic cases in three paired families, with three repetitions per method. Both methods used `codex / gpt-6.1-sol / low` under identical limits. All 36 trials and independent blinded judgements were retained. Readiness was `FAIL`; superiority was `INCONCLUSIVE`.

The baseline completed 18/18 trials, compared with 11/18 for TOMBO. Failure-inclusive accuracy was 100% versus 61.1%, and required-finding recall was 100% versus 44.4%. In nine complete-information controls, the baseline made three physical source checks and TOMBO made none. Conservative failure penalties still gave TOMBO a control score of 22.2%, exceeding the fixed 10% limit.

The independent assessor marked semantic false closure as false in all 36 outputs. The scorer's 55.6% value is a failure penalty across the mandatory suite, not an observed rate of confidently false conclusions. Two empty citation arrays were corrected independently without changing ratings or excerpts. A tool-free correction task that attempted a command was cancelled without approving it.

The product remained frozen throughout the comparison. A later fix detects repeated executor-guaranteed immutable snapshots, stops unproductive checks, continues other probes and preserves unknowns. All 341 regression tests and an independent static review passed. Its effect still requires a new comparison. Host costs, tokens and hidden upstream requests remain unknown; no additional paid generation API or Jev call was made.
