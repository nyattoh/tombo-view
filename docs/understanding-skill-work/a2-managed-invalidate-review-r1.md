# 独立限定設計レビュー報告書（Independent Design Review: Acceptance 2 Managed Invalidate 最小案）

- **レビュー種別**: fresh 独立限定 design review（同一 goal PM 配下、実装者 Codex と独立の Google 視点）
- **対象作業ツリー**: [`D:/develop/works/tombo-view-ask-policy`](../..)
- **対象ブランチ**: `devin/20261020-1705-understanding-skill`
- **対象設計案**: [`results/understanding-acceptance2/runtime/managed-invalidate-proposal.md`](linked-evidence/understanding-acceptance2/runtime/managed-invalidate-proposal.md)
- **関連診断記録**: [`results/understanding-acceptance2/runtime/managed-invalidate-diagnosis.json`](linked-evidence/understanding-acceptance2/runtime/managed-invalidate-diagnosis.json)
- **対象スコープ**: [`docs/understanding-skill-work/parent-authorized-scope-amendment-r1.md`](parent-authorized-scope-amendment-r1.md) および [`docs/understanding-skill-work/locked-charter.md`](locked-charter.md) の受入基準 2（Acceptance 2）達成
- **費用・トークン**: **unknown**（計測対象外）
- **制約遵守**: 完全 Read-only（ファイル書込・実装・commit・push・PR 作成・新規外部依存追加・直接有料 API 呼出なし、全歴史資料保持、`D:/develop/works/tombo-view` は Git メタデータ以外非参照）

---

## 1. 総合判定結果（Verdict）

**判定: 明示 PASS（合格・本最小案の TDD 実装着手を承認）**

> [!IMPORTANT]
> **本判定は「設計案に対する限定 PASS」であり、「受入 2 または goal 全体の完了 PASS」ではありません。**
> 過去の D01 実失敗、フルレビュー指摘、親監査記録は免除されず不変の歴史として保持されます。製品コード・テスト・スキルの変更着手は、このレビュー完了まで未着手であることが確認されています。

---

## 2. 判定根拠と 6 つの観点別詳細検証

### (1) スコープ適合（Scope Compliance）: **PASS**
- **検証**:
  - 本提案は受入基準 2（「理解循環の維持」「資料改訂・反例・証拠撤回による更新」「永続化・再開境界の明確化」）の達成に必要な最小機構に限定されています。
  - 変更ファイルは既存所有の [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs)、[`skills/tombo-view/scripts/session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs)、および [`test/session-followup.test.mjs`](../../test/session-followup.test.mjs) に閉じられており、[`src/types.ts`](../../src/types.ts)、[`src/report.ts`](../../src/report.ts)、[`src/cli.ts`](../../src/cli.ts) やグローバルスキルの改変は一切含みません。
  - 新規外部依存や直接有料 API、環境外アクセスを含まない契約です。

### (2) 期限後の古い証拠を現在有効と誤表示しないこと: **PASS**
- **検証**:
  - 期限超過後に撤回要求が届いた場合、SDK 状態の `evidence` をインプレースに直接書き換えて revision を進める例外は作らず、まず既存 `checkpointBudget` で実停止（`effectiveDecision: 'blocked'`, `stopReason: 'budget_exhausted'`）を保存します。
  - 撤回要求（対象 evidence IDs、reason）は `received_unassessed` な内部 receipt として台帳に追記保存されます。
  - レポート出力時、旧理解スナップショットには「最新追補の評価完了を表さない」境界明記が付与され、未適用の撤回申告は「受領済み・未評価」として明示分離されます。
  - 期限切れ後に旧 ready 判定や旧証拠を「現在有効」と偽る抜け穴は塞がれています。

### (3) 非生成操作 budget の意味付け: **PASS**
- **検証**:
  - SDK の `invalidate` は純粋な状態再計算操作（モデル生成呼出 0、ツール呼出 0）ですが、実経過時間は常に単調増加（`max(existingElapsed, now - startedAt)`）します。
  - 予算内実行では、`checkpointBudget` による事前検査を行い、期限内であることを確認した上で SDK `tombo.invalidate()` を実行します。
  - モデル呼出回数や rounds を架空に加算せず、`startedAt`、`budget`、既存 `usage` は厳格に保持されます。
  - 期限超過している場合は状態遷移を実行せず、receipt 保存へと安全に分岐します。

### (4) 既停止 / pending / redacted / idempotence / 衝突 / crash-recovery: **PASS**
- **既停止（Stopped state）**:
  - 予算枯渇による停止状態では `checkpointBudget` により即座にブロックされ、未評価 receipt 保存へと誘導されます。
- **保留中評価（Pending assessment）**:
  - SDK [`src/core.ts`](../../src/core.ts#L773-L776) の既存動作に従い、証拠撤回時は `pendingAssessmentExecutionIds` が削除され、未解決 gap に紐づく probe が pending に戻ります。未評価のまま残る不正な依存関係は生じません。
- **黒塗り・キャッシュ欠落（Redacted / Replay）**:
  - `invalidate` は evidence ID と validity のみを操作し、passage 本文の取得や検証を要求しないため、本文非保持（`passageUnavailable: true`）の replay 状態でも正確に動作します。
- **冪等性（Idempotence）**:
  - 同一 input による再配送時、対象証拠が既に `withdrawn` であれば `core.ts:770` により `changed = false` となり同一 revision を保持します。
  - 期限後 receipt についても同一 payloadHash であれば既存 receipt を返し、日時の捏造や重複加算を防ぎます。
- **衝突検査（Conflict detection）**:
  - 存在しない evidence ID は `invalid_input`、不一致な ledger/out 指定は `revision_conflict` で即座に拒否されます。
  - 診断記録 [`managed-invalidate-diagnosis.json`](linked-evidence/understanding-acceptance2/runtime/managed-invalidate-diagnosis.json) が実証した通り、外部 legacy CLI による未管理コミットはセッション整合性ゲートによって確実に遮断されます。
- **クラッシュリカバリ（Crash recovery）**:
  - `session-store.mjs` のトランザクション機構（`begin('invalidate')` $\rightarrow$ `stage` $\rightarrow$ `commit` $\rightarrow$ `reconcile`）をそのまま再利用するため、コミット前後の中断時も既存の回復パスに従って整合性が維持されます。

### (5) 検査可能性（Inspectability / Testability / TDD）: **PASS**
- **検証**:
  - 提案書に明記された 5 つの RED 対象（通常循環、redacted 動作、不正入力・競合拒否、中断復旧、実期限超過後の挙動）は、[`test/session-followup.test.mjs`](../../test/session-followup.test.mjs) 内で独立かつ決定論的に検証可能です。
  - 実 helper プロセスと SDK コアの双方が CLI / API 双方の観点から自動テスト可能になっています。

### (6) 既存理解循環を狭めないこと: **PASS**
- **検証**:
  - B04 で成立していた「外部資料更新 $\rightarrow$ 古い証拠の撤回（invalidate） $\rightarrow$ 影響を受けた主張が unverified / gap 再開 $\rightarrow$ 同一 task 内での update / reflect による理解の再構築」という中核ループが、managed session の厳格な台帳トランザクション内で完全に復元されます。
  - 理解循環を恣意的なショートカットに置き換えることなく、正当な発達プロセスが担保されます。

---

## 3. 実装フェーズへの必須申し送り事項（Implementation Precautions）

実装担当者（Codex）は以下の 3 点を厳格に順守して最小差分を適用してください。

1. **CLI オプションのパースとルーティング**:
   - [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs) の `main()` における許容コマンド配列に `'invalidate'` を追加し、activated workspace 内では `managed('invalidate', values, workspace)` へディスパッチすること。
   - 非活性ワークスペースでの `helper invalidate` 呼び出しは、不用意に外部コミットを許容せず `invalid_input`（「invalidate requires an activated session」）として安全に拒否すること。
2. **期限後内部 receipt の ID 命名規則と日時保持**:
   - 実期限切れ時の内部 receipt 保存は、`retainExpiredObservations` の実装規約に倣い、`id: 'unassessed-invalidate-' + digest(invalidation)` とし、再配送時には初回受領日時を保持すること。
3. **SDK 反映後の reflectionEffects 破棄の確実な追従**:
   - `core.ts:778` で理解ハッシュ変化時に `reflectionEffects` が破棄される動作と整合させ、helper 側の `status` / `managedResult` が旧 reflection を有効と誤認しない状態（`effectiveDecision: 'blocked'`）を維持すること。

---

## 4. ハンドオーバー（Handover）

- **設計判定**: **PASS**
- **後続アクション**:
  1. 同一 goal PM は本設計レビュー合格を記録し、Codex 実装担当者に `session.mjs` / `session-store.mjs` / `test/session-followup.test.mjs` への最小 TDD 実装を着手させてください。
  2. 実装完了後は、RED / GREEN ログ、全関連テスト（focused 19 件 + 関連 284 件 + 全回帰 678 件）、`npm run typecheck`、および fresh raw-only forward evaluation を経た上で、最終 full-diff review を実施してください。
- **本報告者ステータス**: Read-only レビュー完了。作業ツリーへのファイル書き込み・コミット・PR 作成は行っていません。
