# 最初の比較結果 / Initial comparison results

最初の比較は受入条件を満たさなかった。通常の再点検に対する TOMBO の優位性は確認できていない。

## 実施した比較

- 公開された架空の評価課題６件。３課題族に属し、各方式で３回ずつ実行した。合計36試行。
- 両方式の参加モデルは Codex の `gpt-6.1-sol`、reasoning effort は `medium`。
- 生成要求と資料検査を合わせて６回、出力4,000文字、経過時間300秒の上限を事前に固定した。
- 独立採点は GLM 5.3 が担当した。方式名、実行ID、参加モデルを隠した採点入力を使用した。文章の特徴から方式を推測できる可能性は残る。
- 26試行が成功し、10試行がエラーになった。失敗した試行を除外せず採点した。

| 指標 | 通常の再点検 | TOMBO |
| --- | ---: | ---: |
| 正答率 | 16/18 | 10/18 |
| 必須の発見事項の再現率 | 88.9% | 44.4% |
| エラーになった試行 | 2/18 | 8/18 |

受入判定は `FAIL`、優位性の比較判定は `INCONCLUSIVE` だった。ケース単位で反復を平均した。18反復を18個の独立した課題として扱っていない。

## 結果の範囲

エラーには提案の形式拒否、出力上限、実行調整の時間切れが含まれる。集計器は無効な試行へ保守的な失敗点を与える。このため、集計の `falseClosure` は、実際に誤った断言をした頻度と同じではない。対照課題の不要検査率にも失敗点が含まれる。

各実行の記録、独立判定、集計はローカルの `results/metacognition-development/epoch1-runs.json`、`epoch1-judgements.json`、`epoch1-report.json` に保存した。参加モデルの生成タスク74件の実行先をホストの状態から確認した。ホスト内の非公開の再試行、トークン数、費用は不明である。費用上限を満たした証明にはならない。

この比較後に、提案を検証で拒否した際の訂正生成を実装した。訂正は最大２回で、元の予算を共有する。まだ修正版の意味的な効果を示す比較結果はない。次の比較は新しい３課題族を使用し、参加者の実行前に条件を固定する。

## English

The initial comparison failed the acceptance criteria. TOMBO has not demonstrated an advantage over ordinary rechecking.

Six public synthetic cases across three families were run three times per method, giving 36 trials. Both methods used Codex `gpt-6.1-sol` with medium reasoning effort. Each trial shared a limit of six generation requests and source checks, 4,000 output characters and 300 seconds. GLM 5.3 independently assessed outputs with method labels, run identifiers and participant model identities removed. Output style could still reveal the method.

There were 26 successful trials and ten errors. Errors remained in the results. Ordinary rechecking achieved 16/18 correctness and TOMBO achieved 10/18. Required-finding recall was 88.9% and 44.4%, respectively. Readiness was `FAIL`; the superiority comparison was `INCONCLUSIVE`.

Failure penalties in false closure and unnecessary probing are conservative scoring rules, not measured frequencies of semantic mistakes or physical probes. Repeats were averaged within each case. They are not additional independent cases. Host costs, tokens and hidden retries are unknown.

Bounded proposal repair was implemented after this comparison. Its semantic benefit remains untested. The next comparison will use new families and freeze its conditions before participant execution.
