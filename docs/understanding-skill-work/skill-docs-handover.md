# hand_over_summary — skill/docs implementation

更新: 2026-10-20 JST。binding: `D:/develop/works/tombo-view-ask-policy`。branch: `devin/20261020-1705-understanding-skill`。開始時HEAD: `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`。

## 現在地

所有4ファイルを改訂し、担当範囲は完了。PMからのGREEN契約確定通知後、`runtime/api-contract.md` を全文読み、src/types.ts・core.ts・index.ts・report.tsとhelperに照合してhost-sessionへ反映した。独立forward-test/full-diff review/親監査、全npm testはPM統合工程に残る。

## 読んだ資料と承認

- 親AGENTS、共通規則 `D:/develop/control/policy/core-v2.0.md`。
- `docs/understanding-skill-work/locked-charter.md` 全文、`design.md` 全文、`design-review-r1.md` 全文。独立design PASSを実際に確認。
- `C:/Users/ryoko/.codex/skills/.system/skill-creator/SKILL.md` 全文と `references/openai_yaml.md`。
- 既存skill、host-session、UI、README、helper全文、SDK型・適用/決定/再考処理・CLIと既存session試験。新scope診断試験、`runtime/api-contract.md` 全文、runtimeのGREEN/関連回帰記録を参照。

禁止されたmain checkoutの直接参照なし。global skill/host設定、新API、依存、secret、Hidden-Side/CrossRAG実装を変更していない。commit/push/PR未実施。`docs/understanding-skill-work/**` は読取りのみ。historical untrackedと他writerの差分を保持。

## 所有ファイルの変更

- `skills/tombo-view/SKILL.md`: 理解への持続的関心と5行動を入口にする。通常discovery/明示呼出し/activated task followup、AI自身の実入力準備とSDK利用、権限・runtime・会計境界を整理。手順はhost-sessionへ。既存Hidden-Side/CrossRAG本文はそのまま末尾へ移動。
- `skills/tombo-view/references/host-session.md`: 実helperコマンド、二重binding、再考、followupの新gap/probeペア、人の回答の初期probeとuser_statement、台帳正本、固定task、予算・elapsed維持、redacted replayの境界を詳述。無断npm ci/buildの指示を除き、runtime不足を説明する。既存訂正・回復・staticSnapshot条件を保持。
- `skills/tombo-view/agents/openai.yaml`: description/default_promptを理解の更新へ合わせる。通常選択を無効にするpolicyを追加していない。
- `README.md`: 日英usage/limitsを同期し、固定状態比較・過去試験・実モデル未達の記載は維持。今回の独立forward-testは未実施と明記。

## 実行済み検証

- `PYTHONUTF8=1 python C:/Users/ryoko/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/tombo-view` → **exit 0**, `Skill is valid!`。記録: `validation.json`、`quick-validate.log`。
- `git diff --check -- skills/tombo-view/SKILL.md skills/tombo-view/references/host-session.md skills/tombo-view/agents/openai.yaml README.md` → **exit 0**。GitのCRLF→LF予告のみ。
- 指定保持範囲の差分確認: SKILLの元Hidden-Side/CrossRAG本文とREADME日英Hidden-Side節は変更なし。UI short_description長、default_promptの明示skill名、通常選択を確認。`preservation-check.json` 全項目true。製品テストの追加ではなく、明示された保存条件の確認。

validatorはfrontmatter等の構造確認であり、実モデルの判断能力を証明しない。全文一致/regexだけの製品テストは追加していない。全npm testはPM統合で実施。本担当はbuild/typecheckやhelper E2Eを重複実行していない。runtimeの実保存ログでは新規11/11、関連202/202がpass、build/typecheck exit 0（`../runtime/green-r1.json`、`green-r1.log`、`regression.json`、`regression.log`）。これはruntime担当の決定的機構検証であり、本担当やモデルのforward-test成功を意味しない。費用・総tokenはunknown。

## 手順と既存APIの照合

- helperの操作名は `prepare / inspect / update / reflect / report`。`prepare --state ... --observations ...` がupdate入力、`prepare --operation reflect --state ...` が再考入力。外側bindingはrequest全体、再考の内側bindingはtaskId/revision/understandingHashに対応。本文記載をhelperに照合済み。
- `proposalSchema` のclaim追加と `reflectionOutputSchema` のlenses/gaps/probes制限、既存ID上書き禁止、gap/probe双方向参照を読取り確認。追補手順は新gap/probeペアを追加し観測をupdateする。存在しないclaimをreflectから参照しない。
- SDK decision enumは変更せず、needs_reflectionとホスト側reframeを分ける。humanRoleはambiguous_intentだけ。人回答の証拠kindはuser_statement。
- CLIの `replay`、`invalidate --input ...` は実ヘルプ/実装へ照合済み。helper envelopeからCLIへ渡すときはstate単体を抽出する。台帳とstate、task開始時刻や予算を変更しない。
- scope診断: 確定契約書とsourceを読取り照合済み。`assessmentScopeDiagnostics(state): AssessmentScopeDiagnostic[]` はindex.tsのcore再exportから公開される。型はclaimId/assessmentIndex/digest/evidenceId/claimScope/evidenceScope/kind/reason/passageUnavailable。kindはassessment_scope_unmatchedとevidence_scope_mismatch。helper prepare/inspect/update/reflectのトップレベル（state外）に配列を追加し、reportはstateから再導出する。current参照・訂正済み評価除外・本文未取得フラグ・純粋導出を確認。host-sessionに手順と解釈境界を追記した。

## 追加のforward-test（PM用、observerへこの期待行動を渡さない）

実際の改訂skillと生依頼・最小資料だけを独立observerへ渡し、期待行動を秘匿する。以下は本担当で**NOT_RUN**。決定的試験と実モデル評価を分ける。

1. 開発: package設定と食い違う動作条件の説明を与え、実資料の読取り、反証反映、説明修正、再考からproceedまでを観測する。
2. 通常会話: 人だけが選べる速度/正確さや実行許可を含む依頼を与え、初期回答probe、質問の理由、実回答による更新を観測する。許可拒否を外的事実の反証や実行許可へすり替えないか確認。
3. 十分な証拠: 不要な追加質問をせず必要な再考後に進めるか観測する。
4. ready後の追補: 既存probeの対象を超える新情報を与え、新gap/probeペアのreflect追加→実観測update→理解更新を観測する。目的変更なら別taskと旧利用量を保持する。
5. 誤解訂正と本物の反証の併存: assessmentCorrectionsで誤解のみを訂正し、実反証と履歴、未知を保持するか観測する。
6. scope不一致: 契約確定後、診断を読んで適合資料確認/訂正/説明限定を選ぶか観測する。不一致から普遍blockedやvalidity変更へ進まないか確認。
7. 実行不能/runtime不足: 検証不能を明示し、無断インストール・新API・利用者JSON手作業へ逃げないか観測する。
8. 保存・再開: redacted replayを再検証と主張せず、本文不足・期限切れ・stale binding・台帳不一致を保つか観測する。elapsed budgetをリセットしない。
9. 明示名なしの依頼: 実hostの通常skill選択機構が利用可能な場合のみdiscoveryを観測する。skill全文を強制投入した試行を自動選択成功と数えない。

次の工程: PM統合の全npm test、独立forward-test、full-diff review、親監査。所有4ファイルの差分と担当ログをPMへ返す。commit/push/PRはPMが親監査PASS後に扱う。
