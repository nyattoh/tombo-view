## 変更内容

TOMBO repository skill・managed session・SDK診断のDraft PRです。今回の修正ではWindows canonical pathの表記を整合し、transition日時をtimezone必須ISO/未来5秒までへ制限しました。同期scriptはApply時にmain・exact merged SHA=HEAD・clean（untracked含む）・origin/main包含とcommit treeのコピー対象一致を確認します。4 deployed copiesは同期していません。

## PRの縮小と証跡

[短いreview summary](https://github.com/nyattoh/tombo-view/blob/devin/20261020-1705-understanding-skill/docs/understanding-skill-work/pr8-review-summary.md) と [path/SHA-256/size manifest](https://github.com/nyattoh/tombo-view/blob/devin/20261020-1705-understanding-skill/docs/understanding-skill-work/evidence-manifest.jsonl) を残し、linked-evidence 38件を含む1821件の詳細証跡を現在のPR indexから除外しました。実ファイルはローカルにそのまま保持し、過去commit履歴も書き換えていません。README内の旧証跡リンクはshort summaryへ張り替えました。manifestは実データの代替でも受入PASSの証明でもありません。

## 検証と境界

A/BのRED→GREEN・関連回帰と、ignored sourceがclean statusを通る実反証を保存しています。最終統合 `npm test` / `npm run build` の実counts/exitと、新headのWindows/Ubuntu Node22/24 CIは実行後にこのPR本文/チェックへ追記します。LinuxローカルはNOT_RUNで、Windows成功から推測しません。CI green後に今回のbugbot runと@codex reviewを各1回依頼して停止します。

## 未達の受入・監査

**元チャーターの受入2は未達、親監査はnot_accepted_needs_reviewのままです。** 旧post-H full reviewはNEEDS_REVIEW、gate exit3（G2/G12/G14）を合格へ変更していません。D/E/F/G/Hの失敗・partial、A3旧pending、未免除AGENTS逸脱を保持します。F1診断はclaimless gap救済やモデル意味効力の証明ではありません。今回の修正・通常pushの明示承認を、元goalの完了と混同しません。

マージ/main push/force push/4コピー同期は行いません。
