## 変更内容

TOMBO repository skill・managed session・SDK診断のDraft PRです。今回の修正ではWindows 8.3別名とphysical rootを同一directory identityで照合し、原caller表記を残してroot/ancestor/.sessionのjunctionを拒否します。新bindingはcanonical rootを使い、両方向の再開で旧event・bindingを保持します。transition日時はtimezone必須ISO/未来5秒までへ制限しました。同期scriptはApply時にmain・exact merged SHA=HEAD・clean（untracked含む）・origin/main包含とcommit treeのコピー対象一致を確認します。4 deployed copiesは同期していません。

## PRの縮小と証跡

[短いreview summary](https://github.com/nyattoh/tombo-view/blob/devin/20261020-1705-understanding-skill/docs/understanding-skill-work/pr8-review-summary.md) と [path/SHA-256/size manifest](https://github.com/nyattoh/tombo-view/blob/devin/20261020-1705-understanding-skill/docs/understanding-skill-work/evidence-manifest.jsonl) を残し、linked-evidence 38件を含む1821件の詳細証跡を現在のPR indexから除外しました。実ファイルはローカルに保持し、過去commit履歴は書き換えていません。mutableなPM task-stateの継続更新1件は新snapshot/hashへ更新し、旧manifest entryも証跡に残します。README内の旧証跡リンクはshort summaryへ張り替えました。manifestは実データの代替でも受入PASSの証明でもありません。

## 検証と境界

A/BのRED→GREENとignored sourceの実反証を保存しています。Windows追加修正では実CLI/新bindingのRED（8件中2失敗）→focused 8/8、関連74/74、build/typecheck exit0を確認しました。POSIX対照はskipなしですがLinuxローカル実行はNOT_RUNです。旧head eb6e9c6のPM全npmは781/781、fail/skip/cancelled0・exit0、build exit0でしたが、同headのCI run 39511489382/39511495885はWindows failure/他cancelledを含みgreenではありません。変更後のPM全npm/buildの正確な値と現head CIの全8 job conclusionは、ライブPR本文の実行記録を正本とします。新head全8 job success後に限り、この修正roundのbugbot runと@codex reviewを各1回追加して直後停止します。

## 未達の受入・監査

**元チャーターの受入2は未達、親監査はnot_accepted_needs_reviewのままです。** 旧post-H full reviewはNEEDS_REVIEW、gate exit3（G2/G12/G14）を合格へ変更していません。D/E/F/G/Hの失敗・partial、A3旧pending、未免除AGENTS逸脱を保持します。F1診断はclaimless gap救済やモデル意味効力の証明ではありません。今回の修正・通常pushの明示承認を、元goalの完了と混同しません。

マージ/main push/force push/4コピー同期は行いません。
