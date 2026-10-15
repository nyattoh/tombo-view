# 第4回の実モデル比較

2026年10月14日、事前に固定した6合成ケースを、通常再点検とTOMBOで各3回、計36試行比較した。受入判定は `FAIL`、優位性は `INCONCLUSIVE` だった。正常終了26件とエラー10件を全て保持し、再実行や後から得た出力で失敗した試行を置き換えていない。[集計](../evaluation/reports/metacognition-epoch4-report.json)、[全試行](../evaluation/reports/metacognition-epoch4-runs.json)、[独立採点](../evaluation/reports/metacognition-epoch4-judgements.json)を公開している。

## 条件と結果

両方式の参加要求は `codex / gpt-6.1-sol / low`。生成要求と資料取得を合わせて6回、各生成出力4000文字、全体300秒、形式修復2回という同じ上限を使った。拒否された生成と修復生成も上限に数えた。対戦予定の網羅、整数の検算、封印された投票という3課題族で、反証・未知保持と、十分な情報が既にある対照を組み合わせた。[固定プロトコル](../evaluation/metacognition-fourth-protocol.json)と[ケース](../evaluation/metacognition-fourth-cases.json)に条件を保存している。

| 項目 | 通常再点検 | TOMBO |
| --- | ---: | ---: |
| 正常終了 | 17/18 | 9/18 |
| 正答率（失敗を含む） | 94.4% | 44.4% |
| 必須論点の再現率（失敗を含む） | 88.9% | 33.3% |
| falseClosure評価値（反証・未知保持9試行） | 11.1% | 66.7% |
| 不要取得評価値（完全情報の対照9試行） | 55.6% | 33.3% |
| 対照で実際に行った資料取得 | 5/9 | 0/9 |

繰返し18組を18個の独立課題とは扱わない。独立ケースは6、課題族は3であり、統計的な優位性の証明ではない。新しい課題と輸送経路の運用変更を含むため、前回との差を一つの修正の効果へ帰属できない。

方式を伏せた全36出力を、参加者とは別の native `gpt-6-astra` が採点した。採点者は同じOpenAIモデル系統であり、別提供者による採点ではない。採点は保存出力の意味評価であり、独立した上流の実行条件や課金の証明ではない。出力ハッシュ、完全一致の引用、既存資料ID、必須確認の実取得を既存評価器で検証した。不正な採点0件、未採点0件、試行記録の受入違反8件だった。[公開時の検証](../evaluation/reports/metacognition-epoch4-publication-verification.json)に再集計とコピーのハッシュを保存した。

## 失敗と指標の解釈

10エラーはTOMBOの `model_timeout` 8件と `probe_error` 1件、通常再点検の `model_error` 1件だった。8時間切れの終端保存は300000msの上限から7〜20ms後だった。固定した評価器は経過時間の上限を厳密に比較するため、この8件が `invalidTranscripts` となる。上限を延長したり、記録を書き換えたりしていない。[会計監査](../evaluation/reports/metacognition-epoch4-accounting.json)の `failures` に試行別の記録を保存している。

時間切れには旧console輸送のJSON配送失敗、workspace routingの時間切れ、自動承認reviewの期限超過、返信前の停止・取消が含まれる。全ての時間切れを一つの原因にまとめない。`h2w5` のTOMBO3件では同じ保証済みsnapshotを2回取得したが、既存の重複停止判定は次のupdate生成後にある。その生成待ちで時間切れとなり、停止判定へ到達しなかった。未取得の提案に新しい解釈がないことまでは証明できない。

`p6n1/tombo-r2` はモデルが未宣言の取得先 `context` を提案し、executorが実取得の予約前に拒否した。実資料取得は0件、SDKのexecutor試行は1件だった。外側は `probe_error`、保存状態の内側は `assessment_pending` であり、別の情報を表す。通常再点検の1エラーはモデル容量不足の返信で、回答出力を受信していない。

独立採点者の意味上の正答は28/36件で、正常終了した出力に限ると25/26件だった。意味上のfalseClosureは全36件でfalseだった。一方、評価器は実行失敗や受入違反を正答・再現率0、falseClosure等を1として保守的に減点する。従って表の11.1%と66.7%は、反証・未知保持の試行に対する失敗減点を含む値であり、誤った結論を実際に確定した割合ではない。

完全情報の対照ではTOMBOの実取得は0件だったが、3エラーにより不要取得の評価値は33.3%となり、固定した上限10%を超えた。通常再点検は対照9試行で計5回の実取得を行った。取得回数、採点者の意味評価、受入条件の減点を分けて解釈する。

## 固定した製品と運用記録

固定した製品は `e739bc8f6f3d29d8004da7f616e586ee176058a3`。最初の参加要求前にプロトコルとデータを固定した。全36件が終わるまでSDK、host-trial、dispatch、T3 adapter、ケース、注釈を変更していない。終了時の `3d23d75894e691d326d1c52cc27432adaef10e4d` までの対象差分は0だった。最初の `q7m2` repeat1組は旧console輸送を使った。途中でmachine-file host-sessionとexclusive `wx` の監査保存を追加した。これらは運用変更であり、比較条件の限界として保持する。

最後のdriver終端は2026-10-14T07:23:32.401Z、終了チェックポイントは2026-10-14T07:32:58.872Z。全36件の元runとtraceのbyte SHA-256はチェックポイントと一致した。[会計監査](../evaluation/reports/metacognition-epoch4-accounting.json)の `fixedEvidence` と[公開時検証](../evaluation/reports/metacognition-epoch4-publication-verification.json)が固定記録の照合結果を保持する。

生成予約Mは79、物理的資料取得Sは24で、共有callsは103だった。実handleの和集合78、保存受理イベント77、配送イベント69、driver返信71を区別する。返信は回答出力70件と非出力エラー1件だった。Mは課金生成数ではなく、handleは保存された実dispatchの識別子である。

2件のdispatch時系列は最終snapshotだけを復旧した。先行イベントを補完していない。さらに `q7m2/tombo-r1` sequence2には生成予約があるが保存dispatchとhandleがない。34通常ファイルの存在も完全な時系列の証明とはしない。配送callbackの失敗とdriverの未受信は同義ではなく、配送69と受信71の差を維持する。

全71返信のprofile echoは要求した `codex / gpt-6.1-sol / low` と一致した。実際の上流推論設定、費用、トークン、非公開要求・再試行、上流ツール動作、取消後の停止保証は不明である。経過時間は輸送、承認review、poll、配送と終端保存を含み、モデル内部の生成速度ではない。完全なlatency監査として公開できる検証済み資料は今回追加していない。

## 比較終了後の修正と証拠の境界

取得先の契約説明と生成境界の照合を扱う `5e25d9f`、completed-resultの重複観測を減らす `64a2c00` は、全試行と終了チェックポイントの後に統合した変更である。これらの効果を本報告の固定試行から主張しない。同じsnapshotに対する生成前停止は別の設計課題として残る。

公開ファイルの4コピーは元の集計、試行、採点、会計JSONとbyte単位で一致した。既存 `scoreRuns` の再集計は保存したreportと全項目一致した。公開時の作業はローカル照合のみであり、実モデルの再試行、生成API、Jev、製品試験は実行していない。private conversation、COT、秘密情報、子エージェントの内部要約を公開成果物へ追加していない。すべての未知の発見、幻覚防止、一般的な優位性を示す結果ではない。

## English

The fourth frozen comparison used six public synthetic cases in three paired families, with three repetitions per method. All 36 trials were retained, including 26 normal completions and 10 errors. Readiness was `FAIL`; superiority was `INCONCLUSIVE`. The baseline completed 17/18 trials, compared with 9/18 for TOMBO. Failure-inclusive accuracy was 94.4% versus 44.4%, and required-finding recall was 88.9% versus 33.3%.

Both methods requested `codex / gpt-6.1-sol / low` under the same six-call shared limit, 4000-character generation limit, 300-second trial limit, and two-repair allowance. Cases covered schedule coverage, integer verification, and sealed votes. Six independent cases and three families do not establish statistical superiority. New cases and operational transport changes prevent attribution to one fix.

A separate native `gpt-6-astra` assessor rated all 36 blinded outputs. The assessor belongs to the same OpenAI model family, so this is not cross-vendor assessment. Existing schema, output-digest, exact-excerpt, source-reference, and performed-check validation found no invalid or missing judgements. Eight timeout transcripts failed the strict elapsed-time acceptance check. Their terminal records exceeded the fixed deadline by 7 to 20 milliseconds. No deadline or saved trial was changed.

Raw semantic correctness was 28/36, or 25/26 among normal completions. The assessor marked semantic false closure as false in all 36 outputs. Conservative failure penalties produced falseClosure values of 11.1% for the baseline and 66.7% for TOMBO in the nine mandatory trials. These values are not observed rates of confidently false conclusions. In nine complete-information controls, the baseline made five physical source checks and TOMBO made none. Three TOMBO errors still produced a control penalty of 33.3%, above the fixed 10% limit.

TOMBO had eight model timeouts and one probe error. The baseline had one model-capacity error. Recorded timeout conditions include console delivery failures, routing or approval-review deadlines, and outstanding replies at termination. The sealed-vote repetitions awaited another update generation after retrieving the same immutable snapshot twice. The existing duplicate-stop decision runs after that generation. The probe error used undeclared source `context` and was rejected before physical retrieval. Its one SDK executor attempt therefore differs from its zero physical checks.

The product remained frozen at `e739bc8f6f3d29d8004da7f616e586ee176058a3` throughout all trials. The initial pair used legacy console transport. Later operational amendments added machine-file transport and exclusive audit persistence. All 36 run and trace byte hashes match the completion checkpoint. The later source-contract repair and completed-result polling change were integrated after completion. Their effectiveness requires new evidence and is not demonstrated by these trials.

Accounting records 79 model reservations, 24 physical checks, and 103 shared calls. Actual handle union, saved acceptance events, delivery events, and driver replies are distinct counts of 78, 77, 69, and 71. Two dispatch histories were recovered only as final snapshots, and one reservation lacks saved dispatch evidence. Requested profile echoes do not prove upstream effort. Fees, tokens, hidden calls or retries, upstream tool activity, and guaranteed stopping after cancellation remain unknown. Trial wall-clock time includes transport and review, rather than isolated model generation.

The four public JSON copies are byte-identical to their saved sources. Existing scorer recomputation exactly matches the saved report. Publication checks used local data only, without trial reruns, model APIs, Jev, or product tests. Public data contains synthetic trial outputs and accounting evidence, without private conversations, chain-of-thought, secrets, or internal child-agent summaries. General completeness, hallucination prevention, and general superiority remain unproven.
