## 変更内容

TOMBO repository skill・managed session・SDK診断のDraft PRです。今回の修正ではWindows 8.3別名とphysical rootを同一directory identityで照合し、原caller表記を残してroot/ancestor/.sessionのjunctionを拒否します。新bindingはcanonical rootを使い、両方向の再開で旧event・bindingを保持します。transition日時はtimezone必須ISO/未来5秒までへ制限しました。同期scriptはApply時にmain・exact merged SHA=HEAD・clean（untracked含む）・origin/main包含とcommit treeのコピー対象一致を確認します。4 deployed copiesは同期していません。

## 前修正 ef009567 — 2026-10-23 Codex P1/P2

- P1: parsed TaskPacketのevidence重複・passage availability/hash・inspect入力上限をactivation/transitionのsession記録前に検査します。helperは変更していません。直接Storeは旧bytes不変、CLI activationはauthority未作成を検査。CLI invalid transitionは拒否し、既存checkpoint由来のevent+1とsession journal/cache更新だけを許容し、SDK bytes・task/binding/head/history/revision/pending/uncertaintyを保持します。checkpoint-only対照に基づく親の契約精密化です。
- P2: statusで隠れるassume-unchanged/skip-worktree変更も、source raw bytesとresolved commit blobのOID照合でcopy前に拒否します。両index flagのfixtureをfinallyで解除し、Copy-Item/New-Itemとも実行しません。
- 実証: P1旧RED12/12・中間1failを保存。改訂baselineは21件16pass/5fail（baseline direct activationのみ）、current focused21/21・関連82/82・build/typecheck0。P2 RED14件11pass/3fail→GREEN14/14。skip0。新PM全npm/buildの実counts/log hashと新head CIはライブPR本文の実行記録を参照してください。旧787/787は過去freezeです。

## R3追加修正（base ef009567）

- activated inspectの入力passage/hashをtransaction開始前に検査し、sealed task/budget照合を保持します。
- receiveは新規observationのprobe/evidence適用可能性をappend前に検査。完全一致receipt replayは先に判定し、初回helper時刻/statusとinvalidate後の互換性を保持します。
- 実評価が終わったlinked execution proofだけでreceiptをappliedにし、未評価のmanaged invalid_inputやdirect SDK/store no_progressではpendingを保持します。既存receiptリンクguardとmixed receiptの未評価fresh保持を維持。既存tests/fixturesは変更していません。
- 正式baseline REDは7件2pass/5fail、final focused8/8、関連82/82、build/typecheck exit0・skip0。初期契約3のfixture/link失敗は意味あるREDに数えず、途中のguard緩和は不採用として戻しました。再送回帰と81/82の中間失敗も保存しています。PM全npm/build、内部別vendor review、新head CIは実結果だけをrun recordへ記載します。
- R3ではGitHubレビュー依頼コメント、merge/main/force push、4コピー同期は禁止。A2・親監査の未達を維持します。

### R3内部review指摘への対応

初回Google内部reviewは元freezeにPASS＋Low指摘1件。任意receipt IDの__proto__/constructorで実RED（11件9pass/2fail）を再現し、safe own-property map/lookupへ最小修正しました。IDは変更せず、stage・SDK commit・reconcile/reloadで選択receiptだけ適用され未選択はpendingを保持。最終focused11/11・関連82/82、skip0です。最終freezeへの新しいGoogle round2と、その後のPM全npm/buildは実結果のみをrun recordへ記載します。PRレビューコメントは禁止です。

## PRの縮小と証跡

[短いreview summary](https://github.com/nyattoh/tombo-view/blob/devin/20261020-1705-understanding-skill/docs/understanding-skill-work/pr8-review-summary.md) と [path/SHA-256/size manifest](https://github.com/nyattoh/tombo-view/blob/devin/20261020-1705-understanding-skill/docs/understanding-skill-work/evidence-manifest.jsonl) を残し、linked-evidence 38件を含む1821件の詳細証跡を現在のPR indexから除外しました。実ファイルはローカルに保持し、過去commit履歴は書き換えていません。mutableなPM task-stateの継続更新1件は新snapshot/hashへ更新し、旧manifest entryも証跡に残します。README内の旧証跡リンクはshort summaryへ張り替えました。manifestは実データの代替でも受入PASSの証明でもありません。

## 検証と境界

A/BのRED→GREENとignored sourceの実反証を保存しています。Windows追加修正では実CLI/新bindingのRED（8件中2失敗）→focused 8/8、関連74/74、build/typecheck exit0を確認しました。POSIX対照はskipなしですがLinuxローカル実行はNOT_RUNです。旧head eb6e9c6のPM全npmは781/781、fail/skip/cancelled0・exit0、build exit0でしたが、同headのCI run 39511489382/39511495885はWindows failure/他cancelledを含みgreenではありません。変更後のPM全npm/buildの正確な値と現head CIの全8 job conclusionは、ライブPR本文の実行記録を正本とします。新head全8 job success後に限り、この修正roundのbugbot runと@codex reviewを各1回追加して直後停止します。

## 未達の受入・監査

**元チャーターの受入2は未達、親監査はnot_accepted_needs_reviewのままです。** 旧post-H full reviewはNEEDS_REVIEW、gate exit3（G2/G12/G14）を合格へ変更していません。D/E/F/G/Hの失敗・partial、A3旧pending、未免除AGENTS逸脱を保持します。F1診断はclaimless gap救済やモデル意味効力の証明ではありません。今回の修正・通常pushの明示承認を、元goalの完了と混同しません。

マージ/main push/force push/4コピー同期は行いません。
