# 比較実験の準備データ

48件の架空ケースを収録する。開発、業務自動化、調査が各16件で、各領域の開発用8件と評価用8件を分ける。追加確認が不要な対照ケースは各領域4件で、両側へ2件ずつ配分する。

`cases.json` は入力で、`annotations.json` は評価者用の基準案である。評価用の注釈をモデルへ渡さない。ケースの独立性と注釈の妥当性は人が確認する。公開された小規模な架空データなので、未知一般への性能推定や汚染のない秘密テストとは扱わない。

同じモデル、初期資料、ツール、呼出し上限、トークン上限、探索上限で次を比較する。

- A は通常のエージェント。
- B は一般的な再点検。
- C は固定チェックリスト。
- D はTOMBO。

主要比較はDとBとする。同一ケースを最低3回実行し、反復を独立ケースとして数えない。結果の成功、指摘の適合、不要確認、誤った解決、費用と遅延を記録する。条件名を隠した出力を、独立した人の評価で確認する。条件、注釈、数値による判定基準を評価結果を見る前に固定する。

比較実験は未実施である。固定アダプタはこの評価データに対応せず、能力比較に使えない。実モデルと検査ツールのランナーは呼出し元が用意する。

## English

This directory contains 48 synthetic scenarios. Each of the three domains has eight development cases and eight evaluation cases. Each split has two controls per domain.

Keep `annotations.json` away from model inputs. Human reviewers must check case independence and annotation quality. This small, public dataset is not a secret test set or evidence of general performance.

Compare an ordinary agent, a general recheck, a fixed checklist, and TOMBO under the same model, inputs, tools, call limits, token limits, and exploration limits. The primary comparison is TOMBO against the general recheck. Run each case at least three times and compare at case level. Record success, relevant findings, unnecessary checks, false resolution, cost, and latency. Use independent human assessment with condition names concealed.

The experiment has not been run. The fixture adapter cannot evaluate these cases. Provide your own real-model and tool runner. Freeze the protocol and acceptance thresholds before inspecting evaluation results.
