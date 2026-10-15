# assessment correction 公開接続 hand_over_summary

2026-10-14 07:20 JST。隔離 worktree `D:/develop/works/tombo-view/.audit/assessment-correction-worktree`、branch `devin/20261014-assessment-correction`、HEAD `04195e68c9e2d8ab8d8eee2d5cb9d213f6c10129` 上の未コミット変更。通常ルート、通常ルートの dist、導入済みスキル、比較用製品は変更していない。

## 成果

会話のAIが prepare の参照表から以前の誤解釈を選び、同じ update の inline replacement で訂正できる。CLI は既存の file adapter と新しい core schema で動作するため、src/cli.ts の変更や新規フラグは不要だった。

- helper は SDK の公開 assessmentReferences(state) を update と reflect の request へ追加する。独自の assessment ハッシュ計算は追加しない。表を含む request 全体が既存の requestHash に入る。表を含まない旧 binding は拒否する。
- helper は保存した提案を一回適用する。API呼出し0、会話側費用と総トークン数 null の上書きを維持する。完了済み executionId の同一配送は訂正を二重適用せず、利用量も増やさない。
- report は訂正前と訂正後の評価、評価理由、訂正理由、参照証拠を表示する。モデルの解釈の履歴であり、意味的な正しさや事実確認を保証しないと明記する。本文と validity は変更しない。Markdown を escape し、ハッシュ羅列は表示しない。監査用 digest は保存状態に残る。
- 保存時に本文を伏せた証拠に基づく訂正は、保存時の履歴であり本文未取得・未再検証と表示する。訂正済みの古い inconclusive 評価は現在の不明理由として表示しない。
- SKILL.md と host-session.md は参照表、同じ update の inline replacement、current かつ取得済みの grounding、履歴保持、二重訂正・循環拒否、訂正後の再考を説明する。AIが入力を準備し、利用者へJSONの手作業を要求しない。本物の反証を都合よく消す用途として使わない。

## 検証

公開 helper と CLI の実コマンドを Node の spawnSync で実行した。生成モデルはローカル fixture で、外部APIを呼んでいない。

| 検証 | 実結果 | 記録 |
| --- | --- | --- |
| 参照表・binding・report の RED | 5 tests、2 pass、3 fail | assessment-correction-surfaces-red.log |
| 訂正済み不明理由の表示回帰 RED | 6 tests、5 pass、1 fail | assessment-correction-surfaces-history-red.log |
| 最終公開接続 | 6 tests、6 pass | assessment-correction-surfaces-green.log |
| 隔離 worktree 全 suite | 289 tests、289 pass | assessment-correction-surfaces-suite.log |
| スキル frontmatter 検査 | Skill is valid | quick_validate.py を UTF-8 モードで実行 |
| 差分検査 | git diff --check 成功 | コマンド出力 |
| 独立コメント監査1回目 | 非null表明3箇所を指摘、コメント0件 | assessment_surfaces_comments |
| 独立コメント監査2回目 | 指摘0、変更0 | assessment_surfaces_comments_r2 |

テストは一回の訂正で unverified・必須 gap open、同じ update の cold 反証で contradicted・refuted 解決・needs_reflection、正本 ledger と redacted journal replay、旧 binding 拒否、hostUsage 自称値の無効化、同一配送の冪等性、escape、保存時ラベル、訂正なし状態の CLI と renderer の一致、訂正済み不明理由の表示除外を確認する。

再実行する。

```powershell
npm run build
node --test --test-reporter=tap test/assessment-correction-surfaces.test.mjs
npm test
python -X utf8 C:/Users/ryoko/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/tombo-view
git diff --check
```

最初の quick_validate.py は Windows の既定 cp932 読取りで UnicodeDecodeError になった。UTF-8 モードで再実行し合格した。製品ファイルをこの環境差のために変更していない。

独立コメント監査が指摘した report の非null表明を、明示的な参照確認と invalid_input の TomboError に置換した。新しい参照表と報告処理に型回避は残っていない。ログの assertion 内容を変えず、末尾空白だけを除去した。

Model the Domain により訂正履歴と公開参照表を既存 core の型で接続した。Test Behavior, Not Implementation により実コマンドの状態・判定・保存結果を確認した。Prove It Works により RED と GREEN と全 suite を保存した。

## 親へ残す作業

所有変更は src/report.ts、skills/tombo-view/SKILL.md、skills/tombo-view/references/host-session.md、skills/tombo-view/scripts/session.mjs、新規 test/assessment-correction-surfaces.test.mjs と本記録・ログ。コミットはしていない。親が core の独立レビュー対応、統合、GLM の公開接続レビュー、通常ルートへの反映、導入済みスキル同期を順に管理する。

実モデルが訂正を生成する能力、訂正理由の意味的な正しさ、実際の盲点発見や品質改善は、この fixture 検証から証明されない。比較中の epoch2 に新機能を適用しておらず、その結果を本修正の効果として扱わない。SDK 自体の受入条件・core の妥当性は本担当の変更対象外。
