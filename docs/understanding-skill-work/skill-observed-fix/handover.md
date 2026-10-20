# hand_over_summary — observed skill correction

2026-10-20 JST。binding `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`。観測に基づく限定修正は完了。効果の再評価は未実施。

## 根拠を読取り確認

`docs/understanding-skill-work/forward-wave-a-observations.md`、`forward-A02-s2-result.json` と、`forward-evidence/r1-A01`〜`r1-A04` の実task/state/proposalを確認した。特にA02のtask内の取得資料・初回proposal・reflection-2.json・reflected.json・reflected-2.jsonを照合。src/core.tsのelapsed関数は読取りのみで、開始時刻からの実経過を確認した。

- 全AのtaskはmaxElapsedMs=60000。A01 updated.jsonはelapsedMs=143562、A03 reflected.jsonは82074、A04 next.jsonは63825で、いずれもblocked/budget_exhausted。
- A02 reflected.jsonは59666msでready_for_requested_step。資料は原稿執筆用途・歩行制限なし等を示すが、本人が静かさを距離より優先するとは述べていない。初回proposalはその推定をsupportsとして推薦claimをsupportedにした。構造的readyを意味的成功とは数えない。
- A02後続reflection-2.jsonは優先順位gap/probe候補を記載しているが、reflected-2.jsonには新user_statementがなく、262016msでblocked/budget_exhausted。結果summaryの「追加発言を取り込んだ状態」という説明をSDK取込み完了の証拠とは扱わない。

上記は個別観測であり、最終評価countsや全体成功率は確定・記載していない。過去の失敗/部分成果資料は編集していない。

## 今回の差分

- `skills/tombo-view/SKILL.md`: 初期時間予算へホストの提案生成・質問回答待ち・検査・再考・追補の実経過を見積もる条件を追加。重要な未指定優先順位で選択が逆転するときだけ人判断gapと短い質問を用い、用途や制約不存在で好みを作らない。明示済み/比較判断の明示委任で十分なら再質問しない。実回答をuser_statement観測としてprepare→updateし、reflectへの文章記載とSDK状態への取込みを区別。ready/自己評価は意味の正しさの証拠にしない。
- `skills/tombo-view/references/host-session.md`: maxElapsedMsがinspectのstartedAtからの実経過で、helper操作間の生成・質問回答待ちも含む点を明示。現実的な有限予算を初回に見積もり、便宜的短時間・機械的デフォルト・共通巨大予算で代用しない。既に切れた予算/時刻/使用量はリセットしない。本人の重要な優先順位と観測事実/AIの提案・仮定を区別し、回答用probe→観測→prepare/update→返却state確認を具体化。reflectのlimitations/候補への記載、exit 0、会話上の説明だけでSDK取込み完了と主張しない。
- `README.md`: 日英の「forward未実施」を、限定的合成タスクの独立試行で未達が見つかり修正・再評価中という現状へ変更。一般性能・live efficacy未実証を保持。配布例の予算を会話内タスクの固定デフォルトにしない旨を補足。
- `skills/tombo-view/agents/openai.yaml`: 今回は変更なし。観測はdiscovery/UI設定の不具合を示していないため保持。

理解への持続的関心、5行動、SDK利用、反例・訂正・人回答で理解更新する循環、保存・再開、scope診断、権限・証拠境界は維持した。Hidden-Side/CrossRAG本文も保持。

## 実行した確認

1. `PYTHONUTF8=1 python C:/Users/ryoko/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/tombo-view` → exit 0、`Skill is valid!`。最終実行の時刻と結果はvalidation.json / quick-validate.log。
2. `git diff --check -- skills/tombo-view/SKILL.md skills/tombo-view/references/host-session.md skills/tombo-view/agents/openai.yaml README.md` → exit 0。CRLF→LF予告のみ。diff-check.jsonに記録。
3. 今回開始時snapshotと比較し、SKILLのHidden-Side本文、README日英Hidden-Side節、UI設定は不変。開始時点の所有外tracked差分もSHA-256一致。preservation-check.jsonは全項目true。
4. before.jsonから今回差分だけをobserved-fix.patchへ保存。change-summary.jsonに変更3ファイルと未変更UIを記録。

全文/regexだけを検証する製品テストは追加していない。指定保持範囲の比較は保存条件の確認であり、skill効果の試験ではない。src/helper/testsとdocs記録には書き込んでいない。他担当変更は保持。commit/push/PR、新API、依存追加、secret/global設定操作なし。費用・総tokenはunknown。

## 残る確認

製品コードは今回無変更のため、全npm testを繰り返していない。報告された全678GREEN/静的fullreview r1 PASSを、この修正の行動効果や新しいreview PASSへ読み替えない。

PMが新しい未提示rawケースで独立forward-testとfresh fullreviewを行う。初回予算が実往復に適するか、重要な未指定優先順位だけを質問し既知条件では進めるか、本人回答が実観測/updateでstateへ反映されるか、停止したSDKと会話上の成果を区別できるかは未再評価。observerへ本handoverの期待行動や以前の所見を渡さない。
