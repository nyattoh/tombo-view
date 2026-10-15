# CLI・会話スキル修復接続 handover

2026-10-14 JST。対象は `D:/develop/works/tombo-view`、branchは `devin/20261014-metacognition-engine`。開始HEADは `81c23997161e2c59f51035555988c9a636e8623f`。core統合済みの公開契約だけを接続した。

## 成果と所有範囲

- `src/cli.ts` はinspect・update・reflectに `--model-repair-attempts 0|1|2` を公開する。既定値0で、値と対象commandをadapter/critic importより前に検証する。parseArgsの引数エラーはinvalid_inputへ分類する。既存のFileJournal.assertCurrentとロック付きcommit順序を保持した。
- `src/report.ts` は診断がある場合だけ日本語の運用記録を追加する。拒否試行番号・操作・検証メッセージを表示し、証拠やgapの解決とは分ける。既存のMarkdownエスケープを使用する。診断がないレポートには追加しない。
- `skills/tombo-view/scripts/session.mjs` は現在のinvalid_model_output停止と最後の診断operationが一致すると、requestにtyped validationFeedbackを入れる。requestHashは状態・観測・feedbackを含む。評価待ちバッチはprepare時からIDとpayloadHashを照合する。過去のinspect診断が後の失敗updateの回復を妨げない条件を検証した。
- helperはmaxModelRepairAttemptsを設定せず、一つのcached host proposalを一度だけ適用する。追加API呼出し0件、host token/cost null、local applicationとしてのmodelCalls、reflectionのbinding/coverage制約を維持する。
- `skills/tombo-view/SKILL.md` と `references/host-session.md` に、SDK/CLIの自動訂正と会話AIによる新しい提案作成の違い、追加専用ID、未知をgap解決へ変換しない規則、失敗updateの証拠と利用量の保存、初回inspect再開不可を記載した。ケース固有回答は追加していない。
- 新規テストは `test/cli-model-repair.test.mjs` と `test/session-repair-feedback.test.mjs`。core/types/prompts/index/runner、README、評価資料、親audit DB、installed global skillは編集していない。

## 検証

すべて親root workdirを明示して実行した。新しい依存関係を入れず、providerや有料APIを呼んでいない。

- CLI契約の変更前REDは19件中18失敗、既存transport retryの1件成功だった。フラグ未対応、診断report未対応を実際のCLI subprocessで確認した。
- session fixtureの必須versionを修正した後の変更前REDは6件中4失敗、既存の単回適用・binding拘束の2件成功だった。feedback未公開、prepareのpending照合不足、inspect再開制限の説明不足を確認した。
- 追加した過去inspect診断の回復反例は修正前に7件中1失敗した。guardを未適用のinspect状態へ絞って解消した。
- CLIの21件とhelperの8件は成功した。実際の拒否後成功adapter/critic、0・1・2の試行上限、不正フラグのimport副作用なし、非対象command拒否、update観測の単回登録、旧transport retry、journal診断保存、escaped reportを含む。
- helperはtyped feedback、exact pending batchの不足・変更・混入拒否、bindingの診断変更検出、単回拒否と証拠保存、同一clock/累積利用量、成功後の診断report-only、reflection feedbackと偽のhost usage上書きを検証した。
- 最終 `npm test` はbuildを含め212件成功、失敗0。親が追加したfresh evaluation 6件を含む。途中の210/211実行は上記guard反例の修正前に開始したもので、最終結果に置き換わる。
- `git diff --check` は成功。`python -X utf8 C:/Users/ryoko/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/tombo-view` は `Skill is valid!`。
- stdout記録はローカル `results/metacognition-development/cli-skill-repair-test-output.txt`。Windows既定cp932のvalidatorは読取りエラーになったため、UTF-8指定で再実行した。

## 判断と未確認事項

Model the Domainに従い、訂正をSDK既存のtyped feedbackとCLI整数設定へ接続した。Boundary Disciplineに従い、外部CLI引数とpending観測を生成前に検証した。Prove It WorksとTest Behavior, Not Implementationに従い、CLI/helper subprocessと保存状態の実際の結果を検証した。

親の独立レビューを残す。parentがglobal installed skillの同期を所有し、この担当は同期しない。実モデルでの訂正成功率、意味的な品質、会話側の費用・token・生成時間は測定していない。

初回inspectを失敗状態から再開する公開操作はない。新しいinspectへresetして同一budget継続と主張しない。helperはSDK自動訂正を無効のまま使うため、helper自身の新しい拒否は詳細診断を追加しない。既存SDK診断だけを取り出し、新しい拒否の詳細を得たとは扱わない。この制限をガイドに明記した。

## 差分監査

所有コードのdiffを直接確認した。新しいコメント、型逃れ、lint抑制はない。`rg`によるコメント・抑制検索も0件だった。親が独立レビューを担当するため、この担当は追加agentを起動していない。所有外の評価資料とテストは保持した。PR・push・公開・global skill更新は行っていない。

## 追加修正 round 2 の handover

2026-10-14 JST。独立GLM round 1は静的レビューでPASSだった。`cli-skill-review-glm-r1.md` のP3注記と、親が実測した不明理由の表示不足を受け、所有範囲のreport/helperと両テストだけを追加修正した。

`src/report.ts` はanswer_claimの最後のassessmentがinconclusiveの場合、scopeMatched=true、参照証拠IDが現在状態に存在、全証拠のvalidity=current、全証拠のscope=claim.scopeを確認して「証拠評価の理由（不明）」へreason・参照ID・範囲を表示する。最新評価が失効・範囲不一致・supports/refutesなら、古いinconclusive理由へ戻らない。古いno-record-yetの説明を最新根拠として表示しない。本文cacheが未取得の場合は「保存時の評価。本文未取得・未再検証。」を併記する。reasonを支持・反証や検証済み事実に変換せず、状態を変更しない。対象理由がない既存レポートは同じ出力を維持する。

指定された反例を実行したところ、空proposalで正当に成功したinspect後のSDK default0 update([])は、生成を開始せずno_progressで停止した。stopReasonがinvalid_model_outputではないので、現guardの誤認には当たらなかった。この短絡は変更していない。

真正の反例は、拒否1回後に空proposalでinspect成功、default0 update([])のno_progress後、default0 reflectが不正bindingで拒否される経路だった。revision3、invalid_model_output、claims/probes/pendingが空、最後の診断operation=inspectの正当な保存状態で、prepare updateが初回inspect失敗と誤認した。変更前のREDを確認した。guardへrevision===1だけを追加し、初回inspect失敗の拒否を保持した。修正後のhelper update([])はno_progressへ戻り、modelCalls=3、rounds=0、toolCalls=0、totalTokens=12、costYen=0、元startedAtとbudgetを保持した。新inspectへの予算resetは行っていない。

同一executionIdの完全同一重複配送はSDKのdedupe契約のため、新たに禁止していない。entityの追加専用ID規則とexecution配送を混同していない。

追加修正前のfocused実行は38件中34成功・4失敗で、reason表示3件と真正guard反例1件がREDだった。実装後は38件成功、複数参照証拠の一部失効を追加して最終focused39件成功・失敗0。`npm run build` と `git diff --check` も成功した。

この時点の全体 `npm test` は227件中222成功・5失敗。失敗はすべて親が並行追加した `test/host-trial-repair.test.mjs` で、baseline syntax repair、oversized output repair、persistent malformed bound、TOMBO update physical source replay、failed inspection draft labelの5件。担当focused39件と既存回帰は成功した。親がbridge実装後の統合全GREENを確認する。記録はローカル `cli-skill-repair-followup-test-output.txt`。

所有外のbridge、core、評価資料、global skillは変更していない。実モデルの効果は測定していない。親によるGLM round 2を残す。
