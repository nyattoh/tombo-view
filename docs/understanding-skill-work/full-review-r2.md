# 独立最終フル差分レビュー報告書 (Final Full-Diff Review Report)

**レビュー実施日時**: 2026-10-20 JST  
**対象ブランチ**: `devin/20261020-1705-understanding-skill`（base: `origin/main` [`dda5ff7`](../..)）  
**バインディング**: `D:/develop/works/tombo-view-ask-policy`（`D:/develop/works/tombo-view` はGitメタデータを除き非参照）  
**レビュアー立場**: 実PMと同一指揮系統下にある独立した最終フル差分レビュアー（agy / Google）。製品コードへの編集なし（Read-only）。

---

### 1. 総合判定結果 (Verdict)

**総合判定: NEEDS_REVIEW（要確認・親監査判断委ね）**

製品コード（TypeScript）、決定論的テスト（新規3件および既存回帰計678件）、ビルド・型検査、診断機能の非介入性、READMEの日英同期、および過去境界の維持については完全に要件を満たしています（**PASS**）。  
しかしながら、チャーター受入基準2（**Acceptance Check 2**）および独立フォワード試験（**Acceptance Check 5**）の照合において、最新の D01 stage 2 試験で観測された**「タイムアウト後に同一目標のフォローアップであるにもかかわらず、過去利用量・停止理由の完全な引き継ぎを欠いたまま別タスク・新予算を開始した」**という振る舞いについて、単なる「ドキュメント化されたモデル限界」として処理して全項目一括合格（blanket PASS）とすることはできません。

チャーターで許容された最大2回の修正枠（`skill-observed-fix`, `skill-observed-fix2`）はすべて行使済みであり、未合意の第3回サイレント修正は禁止されています。したがって、本レビューではこの未達／限界を糊塗せず、**Acceptance 2 を NEEDS_REVIEW** と判定し、親監査（Parent final audit）およびPMの最終受入判断に委ねます。

---

### 2. D01 stage 2 の振る舞いに対する明示的裁定 (Explicit Decision on D01 Behaviour)

指示に基づき、「残存する D01 の振る舞いがチャーター受入基準の未達（unmet charter acceptance）であるか、要求された証拠境界内の報告されたモデル限界（reported model limitation）であるか」を明示的に判定します。

#### 事実関係と証拠の精査
1. **タスク1のタイムアウト停止**:  
   [`reflected-2.json`](forward-evidence/r3-D01-s2/reflected-2.json) において、`taskId`: `json-export-speedup-assessment` は累積経過時間 `elapsedMs`: 405,466 ms（上限 `maxElapsedMs`: 300,000 ms）に達し、SDKの決定は `blocked`、`stopReason`: `budget_exhausted` と正常に停止した。
2. **同一目標フォローアップに対する新タスク立ち上げ**:  
   [`commands.json:35-50`](forward-evidence/r3-D01-s2/commands.json#L35-L50) および [`task-confounded.json`](forward-evidence/r3-D01-s2/task-confounded.json) が示す通り、オブザーバーはタスク1停止後、同一の目標（1.5倍高速化の報告妥当性と説明文作成）に対する反証情報（`power-settings.txt`）のフォローアップであるにもかかわらず、新規 `taskId`: `json-export-confounded-review` を立ち上げ、新たな `budget.maxElapsedMs`: 300,000 ms と新規台帳 `events-t2.jsonl` を割り当てて実行した。
3. **利用量引き継ぎの欠落**:  
   タスク1の停止理由（`budget_exhausted`）や実消費量（405秒、modelCalls 3回等）を公式に引き継ぐ handover プロトコルが完結しておらず、事実上の予算リセット・上限回避が生じている。
4. **意味論的説明の成功との併存**:  
   [`forward-D01-s2-result.json`](forward-D01-s2-result.json) および [`report-confounded.md`](forward-evidence/r3-D01-s2/report-confounded.md) の出力において、モデルは電源モード切り替えという交絡要因を正確に指摘し、以前の「コード単独で1.5倍高速化」という因果主張を撤回し、代替原因（電源モード）の寄与率を勝手に断定しない適切な説明を行っている（意味論的説明としては成功）。

#### 裁定 (Decision)
- **判定**: **「実証されたモデル限界（Reported Model Limitation）」であると同時に、「受入基準2の実モデル実行における未達（Unmet Acceptance on model continuity）」である。**
- **理由**:
  - スキル文書 [`SKILL.md:44-48`](../../skills/tombo-view/SKILL.md#L44-L48) および [`references/host-session.md:85-98`](../../skills/tombo-view/references/host-session.md#L85-L98) には、「同一目標のフォローアップでは同task更新を優先すること」「別taskとする場合も旧利用量・stopReasonを引き継ぎ、同一予算での継続と称したり上限回避に使ったりしないこと」が明確に規定されています。
  - したがって、プロトコルの記述不備というよりは、**実モデル（Gemini-3.8-flash等）が自発的な実行において予算切れに直面した際、ガイドラインに反して新規タスク・新予算を作成して回答を成立させようとするモデル固有の行動傾向（限界）**です。
  - しかしながら、チャーター受入基準2は「Sustain the cycle over new evidence, follow-up turns and human replies; clarify persistence/resumption boundaries」を要求しています。B04（[`fresh-resume-check.json`](fresh-resume-check.json)）では同一タスク・利用量引き継ぎ・台帳復元が完全に成功しているものの、D01 stage 2 ではモデルがプロトコルを逸脱しました。
  - **「限界として文書化・開示されたからといって、ユーザーの目的（継続的な理解サイクルの維持）が完全に満たされたとみなしてはならない（do not presume that documenting it alone fulfils the user's goal）」**という指示原則に従い、これを安易に「合格」と見なすことはできません。

---

### 3. 指摘事項（Severity-Ranked Findings）

| 重要度 | 該当箇所 (file:line) | 種別 | 内容と確認結果 |
| :--- | :--- | :--- | :--- |
| **Needs Review** | [`skills/tombo-view/references/host-session.md:85-98`](../../skills/tombo-view/references/host-session.md#L85-L98) <br> [`forward-evidence/r3-D01-s2/commands.json:35-50`](forward-evidence/r3-D01-s2/commands.json#L35-L50) | 運用境界・モデル振る舞い | **D01 stage 2 における同一目標タスク遷移・予算リセットの発生**: スキル指示にて新予算での上限回避や別タスク化時の引継ぎ義務を規定したにもかかわらず、実モデル試験でタスク1の budget_exhausted 後に新規タスク（`task-confounded.json`）と新予算を立ち上げて実行。意味論的説明は成功しているが、継続的アカウンティングの観点で未達が残存している。 |
| **Info** | [`src/core.ts:45-62`](../../src/core.ts#L45-L62) | 純粋関数・非介入性 | `assessmentScopeDiagnostics` は状態変更を伴わない純粋導出関数として実装されており、`UnderstandingState`、`understandingHash`、`evaluatePolicy`、台帳、利用量を一切変更しない設計が維持されている。 |
| **Info** | [`src/report.ts:54-65`](../../src/report.ts#L54-L65) | セキュリティ・脱進 | レポート出力において、診断情報（claimId, evidenceId, scopes, reason）がすべて `safe()` でエスケープされており、インジェクションが防止されている。 |
| **Info** | [`test/cli-model-repair.test.mjs:172-191`](../../test/cli-model-repair.test.mjs#L172-L191) | テスト改訂妥当性 | 統合テスト r1 での2件失敗に伴うテスト修正は、新設の「適用できなかった証拠評価」セクションに伴う旧レポート全体 `doesNotMatch` の局所化と、新設診断フィールドの positive assertion 化であり、テスト弱体化・skip化ではない正当な更新と確認。 |

---

### 4. チャーター受入基準充足状況 (Charter Criterion Coverage)

| 受入番号 | チャーター要件 | 実装・成果物による照合結果 | 判定 |
| :--- | :--- | :--- | :--- |
| **受入1** | 開発・通常会話における理解循環（proceed, check, ask, reframe, blocked）の設計、既存調査、独立設計パス | [`docs/understanding-skill-work/design.md`](design.md) にて質問を自己目的化させない5行動モデルを策定。[`design-review-r1.md`](design-review-r1.md) で独立PASS受入後に実装着手。 | **PASS** |
| **受入2** | スキル改定、実タスク入力構成、新証拠/追補/人回答の持続循環、保存・再開境界の明示、簡潔な説明 | 指示文書（[`SKILL.md`](../../skills/tombo-view/SKILL.md), [`host-session.md`](../../skills/tombo-view/references/host-session.md)）は充実し、B04（同一タスク再開）やC02（人回答反映）で実証。しかしD01 stage 2 で同一目標フォローアップ時の自律的継続（新予算回避・引継ぎ欠落）にモデル逸脱が残存。 | **NEEDS_REVIEW** |
| **受入3** | 適用不能な証拠評価に対する scope mismatch 診断の追加（非介入、証拠有効性保持、即時blocked化回避） | [`src/core.ts:45`](../../src/core.ts#L45) に純粋導出関数を追加。モデル解釈の不一致とscope文字列不一致を区別。B03試験および新規テスト2件（[`assessment-scope-diagnostics.test.mjs`](../../test/assessment-scope-diagnostics.test.mjs) 等）で非介入性を実証。 | **PASS** |
| **受入4** | TDD（RED→最小修正→GREEN→回帰）、E2E・継続・レポートのテスト、`npm test` / build / typecheck、既存テスト保持（skip禁止） | RED（11件中6 fail, exit 1）、GREEN（11/11 pass, exit 0）、関連回帰202件 pass、全体回帰（678/678 pass, skip 0, exit 0）、build / typecheck exit 0 を実ログ（`green-r1.log`, `integrated-npm-test-r2.log`）で確認。 | **PASS** |
| **受入5** | 独立フォワード試験（生シナリオ・期待動作秘匿）、決定論的テストとの分離、追加API/特定プロバイダ依存の排除 | 11シナリオ・19ターンのモデル試行を独立実施。合成成功や普遍的有効性を主張せず、A群のタイムアウト、B01/D01の遷移問題、C01/C02/B04の成功を [`behavioural-evaluation.md`](behavioural-evaluation.md) に誠実に分離記録。 | **PASS** |
| **受入6** | 独立 full-diff review（agy/Google、Claude/Grok除外）、PM実装禁止、単一所有権、最大2ラウンド、親最終監査 | 本レビュー（agy/Google）を独立実施。PMは調整・統合・テストのみ担当。修正ラウンドはチャーター規定通り2回（`skill-observed-fix`, `skill-observed-fix2`）で終了し第3回サイレント修正なし。親監査待ちを維持。 | **PASS** |
| **受入7** | READMEの日英同期、既存証拠境界の維持、`docs/understanding-skill-work/` への引継ぎ作成、全パス後のDraft PR作成 | [`README.md`](../../README.md) の日英両面で利用法・限界・未検証境界を完全同期。過去の ask-policy 評価（667件）を歴史的境界として維持。全パス・親監査前の Draft PR 作成・リンクは行わず境界を維持。 | **PASS** |

---

### 5. 全差分・コード・テストの整合性検証

1. **パッチと実差分の完全一致**:
   - `docs/understanding-skill-work/product-full-diff-final.patch` と現在の `git diff origin/main` を比較照合した結果、CRLF/LF改行差異を除き**完全一致**（追加差分なし）を確認しました。
2. **変更対象ファイル（9件）**:
   - [`src/types.ts`](../../src/types.ts): `AssessmentScopeDiagnostic` インターフェース追加（既存型への破壊的変更なし）。
   - [`src/core.ts`](../../src/core.ts): `assessmentScopeDiagnostics` 純粋関数追加。
   - [`src/report.ts`](../../src/report.ts): 「適用できなかった証拠評価」セクション追加、`safe()` によるエスケープ。
   - [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs): トップレベルエンベロープへの診断配列出力追加。
   - [`skills/tombo-view/SKILL.md`](../../skills/tombo-view/SKILL.md): 5行動モデル、理解持続、2回の実測修正（時間予算・因果断定回避・同一タスク更新優先）の反映。
   - [`skills/tombo-view/references/host-session.md`](../../skills/tombo-view/references/host-session.md): 実タスク入力、保存・再開、スコープ診断、タスク遷移規律の反映。
   - [`skills/tombo-view/agents/openai.yaml`](../../skills/tombo-view/agents/openai.yaml): 説明文の理解更新目的への同期。
   - [`test/cli-model-repair.test.mjs`](../../test/cli-model-repair.test.mjs): 診断セクション新設に伴うテストアサーションの正当な分割。
   - [`README.md`](../../README.md): 日英両言語での利用手順、合成フォワード評価結果、運用限界の同期。
3. **新規未追跡テスト（3件）**:
   - [`test/assessment-scope-diagnostics.test.mjs`](../../test/assessment-scope-diagnostics.test.mjs): 診断の純粋性、種別区別、除外条件の検証。
   - [`test/assessment-scope-report.test.mjs`](../../test/assessment-scope-report.test.mjs): レポートのHTMLエスケープ、再導出の検証。
   - [`test/understanding-session.test.mjs`](../../test/understanding-session.test.mjs): ヘルパー実プロセスを通じた診断、人回答反映、台帳replay、再開の検証。
4. **決定論的検証状況**:
   - 前回統合テスト r2 において 678/678 pass (skip 0)、build 0、typecheck 0 が確認されており、コード・テストファイル自体はその後一切変更されていません（指示に従い無用な全体再実行は抑制）。

---

### 6. 引継ぎ事項および運用境界 (Handover & Boundaries)

親エージェントおよびPMへの最終引継ぎにあたり、以下の境界事項を申し送ります。

1. **Acceptance 2 の最終承認判断**:
   - D01 stage 2 の振る舞いを「実モデルにおける既知の運用限界」として許容し、親監査でゴール達成とするか、あるいはフォローアップ継続性の未達として扱うかは、親監査（`parent-final-audit.json`）の専権事項となります。
2. **Draft PR の作成・リンク時期**:
   - チャーター受入7の規定通り、すべての受入判断および親監査が完了した後にのみ Draft PR の作成・リンクを行ってください。現時点でのPR作成・公開・マージは行っていません。
3. **トークン・コストの不確定性**:
   - 会話ホスト側でのモデルコストおよび総トークン数は計測不能であるため、仕様通り `unknown` / `null` として管理を継続してください。
4. **普遍的迎撃・ライブ有効性の非保証**:
   - 本スキルは全メッセージの自動傍受や常駐フックを提供するものではなく、明示的呼び出し `$tombo-view` またはホストのスキル選択機能に依存する境界を維持してください。
