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

## Ask-policy 評価の境界と注釈の分離

Ask-policyは既存48件とは別の、60件の架空の状態・packetを使う評価である。凍結した60件について3ベンダー各60件、計180件の実注釈を統合し、実ファイルのreadback・再導出と比較器の正式入力schema検証を確認した。3/3全員一致42件、不一致18件であり、不一致の期待値はnullとする。旧新比較、最終全体試験と独立full-diff reviewは別工程で、goal全体の完了を意味しない。単体試験内のmockを正式ラベルや実行provenanceとして保存しない。

- `ask-policy-cases.json` は観察可能入力のみとし、入力とrubricを注釈開始前に凍結する。`ask-policy-author-intent.json` の作者意図・対照フラグと、`ask-policy-annotations.json` の期待値をモデルへ渡さない。
- OpenAI・Google・NVIDIAの3モデルベンダーが、それぞれ固定されたinput-only payloadを独立に注釈する。リポジトリ探索を認めず、他の注釈を共有しない。各ケースの作者と注釈者は別threadにする。providerの違いだけで3ベンダーとは数えない。
- モデル注釈は暫定ラベル（provisional model annotations）であり、客観的正解（ground truth）ではない。作者意図も正解として使わない。全員一致時だけ `expectedAction = consensusAction` とし、作者意図との差を別途記録する。
- 主指標の分母は3/3全員一致ケースだけとする。2:1を含む全不一致は期待値をnullとして、`ask-policy-disagreements.json` に各ベンダーの票と根拠の違いを逐一記録し、別集計する。missing/invalidを実票として補完せず、全60件に3ベンダーの有効ラベルがそろうまでは正式統合を完了としない。
- JSON構文不正だけに最大1回のretryを認める。結果欠落、空出力、意味的なschema違反をsyntax retryへ置き換えない。元の出力バイト列・artifact/hashと実dispatchのtask/run/thread/provider/model/options/statusを保存し、モデルにvendor/modelを自己申告させない。
- 比較で測るのは、架空の状態から次行動への決定論的規則（synthetic / deterministic state-to-action policy）である。AIの主観的関心・意識、未知の盲点の全発見、ライブモデルによる自発的な質問・状態生成の改善効果は未検証である。

`scripts/ask-policy-annotations.mjs` は外部呼出しもファイル書込みも行わない純粋な統合・検証関数である。凍結ハッシュ、全件coverage、schema、参照可能なreasonPath、3/3合意とprovenanceを検証する。SDKによるfixtureの妥当性検証と実hostの実行記録確認は、それぞれfixture担当とPMの受入工程で行う。実行記録の自己申告フラグだけを盲検の証明とは扱わない。[統合API契約と再開条件](../docs/ask-policy-work/annotation-integration/api-contract.md)を参照する。

Decision source: `framework_only_local`。Jev API call: not made。外部model API呼出し・新依存の追加なし。費用・token数はunknown。
