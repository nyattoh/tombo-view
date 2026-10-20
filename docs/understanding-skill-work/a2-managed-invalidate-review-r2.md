# 独立限定設計レビュー報告書 r2（Independent Design Review r2: Acceptance 2 Managed Invalidate 反例解消・最小修正案）

- **レビュー種別**: fresh 独立限定 design review r2（同一 goal PM 配下、実装者 Codex と独立の Google / Gemini レビュアー視点）
- **対象作業ツリー**: [`D:/develop/works/tombo-view-ask-policy`](../..)
- **対象ブランチ**: `devin/20261020-1705-understanding-skill`
- **対象設計案**: [`results/understanding-acceptance2/runtime/managed-invalidate-proposal.md`](linked-evidence/understanding-acceptance2/runtime/managed-invalidate-proposal.md) および実装者提示の追加反例・最小修正案
- **参照文書・コード**:
  - [`docs/understanding-skill-work/locked-charter.md`](locked-charter.md)
  - [`docs/understanding-skill-work/parent-authorized-scope-amendment-r1.md`](parent-authorized-scope-amendment-r1.md)
  - [`docs/understanding-skill-work/a2-design-r1.md`](a2-design-r1.md)
  - [`docs/understanding-skill-work/a2-managed-invalidate-review-r1.md`](a2-managed-invalidate-review-r1.md)
  - [`results/understanding-acceptance2/runtime/api-contract.md`](linked-evidence/understanding-acceptance2/runtime/api-contract.md)
  - `managed-invalidate-addendum.md`（未作成を確認、提示課題とソースコードから直接検証）
  - [`src/core.ts`](../../src/core.ts)（`invalidate` 周辺 L760–L820）
  - [`skills/tombo-view/scripts/session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs)（`markApplied`, `receive`, `view`, `transition` 周辺）
  - [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs)（`managed`, `receipt`, `report` 周辺）
- **費用・トークン**: **unknown**（計測対象外）
- **制約遵守**: 完全 Read-only（ファイル書込・実装・commit・push・PR 作成・新規外部依存追加・直接有料 API 呼出なし、全歴史資料保持、`D:/develop/works/tombo-view` は Git メタデータ以外非参照）

---

## 1. 総合判定結果（Verdict）

**判定: 明示 PASS（合格・反例に対する最小修正案の TDD RED 先行着手を承認）**

> [!IMPORTANT]
> **本判定は「反例に対する設計修正案への限定 PASS」であり、「受入 2（Acceptance 2）達成または goal 全体の完了 PASS」ではありません。**
> 過去の D01 実失敗、親監査記録、r1 報告は不変の歴史として保持されます。本 round は親権限修正（`parent-authorized-scope-amendment-r1.md`）に基づく受入基準 2 の継続確認に厳格に限定されます。

---

## 2. 実装者が発見した未解決反例の構造的検証

既存 SDK [`src/core.ts`](../../src/core.ts#L765-L777) の `invalidate()` は変更時（`changed = true`）に以下を実行します。

```ts
state.decision = 'blocked';
state.stopReason = null;
...
delete state.pendingAssessmentExecutionIds;
for (const probe of state.probes) if (pendingProbes.has(probe.id) && ...) probe.status = 'pending';
```

この仕様に対し、単純なラッパーを被せた場合に生じる 2 つの致命的欠陥を実コードから確認しました。

1. **既停止理由の消失（Disappearing StopReason）**:
   - `core.ts` は `changed` 時に無条件で `state.stopReason = null` を設定します。
   - すでに `invalid_model_output`、`capability_limit`、あるいは予算境界等で停止していた state に対し `invalidate` を呼ぶと、以前の停止理由が `null` に消去され、モデル修復フィードバックや障害診断の文脈が消失します。
2. **未評価 receipt の誤昇格・False Ready リスク（False Promotion to Applied）**:
   - [`skills/tombo-view/scripts/session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs#L274-L285) の `markApplied` は次のように判定しています。
     ```js
     const pending = new Set(state.pendingAssessmentExecutionIds ?? []);
     const executions = new Map(state.appliedExecutions.filter(item => !pending.has(item.executionId)).map(item => [item.executionId, item.payloadHash]));
     for (const update of this.snapshot.updates) {
       if (update.observations.length ? update.observations.every(item => executions.get(item.executionId) === digest(item)) : ...) {
         update.status = 'applied'; update.appliedRevision = state.revision;
       }
     }
     ```
   - 撤回によって `delete state.pendingAssessmentExecutionIds` が行われると、`pending` 集合が空になります。
   - 評価待ちだった観測はすでに `state.appliedExecutions` に存在しているため、`!pending.has(item.executionId)` が全て真となり、**「評価が破棄されて probe が pending に戻ったはずの未評価観測」が `executions`（評価済マップ）に入ってしまいます**。
   - その結果、`update.status = 'applied'` かつ `update.appliedRevision = state.revision` へと誤昇格し、`view().pendingUpdates` から除外され、外部には「評価完了」と虚偽表示されうる重大な false ready バグが発生します。

---

## 3. 最小修正案の妥当性評価

実装者が提示した以下の最小修正案は、スコープ内で最も誠実かつ安全な閉塞であると評価します。

1. **`src/core.ts` の無変更（Core Unchanged）**:
   - SDK 本体の `invalidate` の振る舞いを弄らず、SDK 契約・既存テストを完全に保全します。
2. **通常撤回と既停止時の分岐（Preserve Stopped Reason）**:
   - 通常撤回は SDK 実 decision（`blocked`、`stopReason: null`）に忠実に従います（r1 での「常に blocked 固定」という過剰制約を PM 指摘に基づき補正）。
   - 一方で、直前状態（`before`）が既に停止中（`before.stopReason !== null`）であった場合に限り、その停止理由と `blocked` を保持します。
3. **未評価破棄歴の隔離と利用量の保持（Separation of Discarded History）**:
   - 撤回によって評価待ちが破棄された receipt は `appliedRevision: null` のまま「未評価の歴史」として識別します。
   - 次回の実評価待ちキュー（`pendingUpdates`）から安全に分離しつつ、実際に発生した過去の実行消費量（`state.usage` / `observedElapsedMs`）は正しく保全します。
4. **期限後の整合性維持（Post-deadline Invariance）**:
   - 期限超過・予算枯渇時は SDK `invalidate` に突入させず、`received_unassessed` な内部 receipt として保存し、旧理解スナップショットを維持します。

---

## 4. 実装フェーズへの必須条件（Mandatory Conditions）

実装者（Codex）および PM は、製品コード編集にあたり以下の必須条件を厳格に満たす必要があります。

### A. 未評価歴と pending 会計の二重計上・False Ready 防止条件
- **誤昇格の完全遮断**: `invalidate` トランザクション完了時に `markApplied` を呼ぶ際、撤回によって評価対象から外れた（または probe が pending に戻った）execution を持つ receipt を絶対に `status: 'applied'` にしてはならない（`appliedRevision: null` を維持すること）。
- **会計の二重計上防止**: 評価待ちが破棄された観測の実行（toolCalls, elapsedMs 等）は既に SDK の `state.usage` に計上されているため、`view().pendingUsage` で重複合算してはならない。一方で、SDK に未計上のセッション側観測がある場合は、それを脱落させずに `pendingUsage` に保持すること。
- **False Ready の防止**: 未評価のまま破棄された履歴が存在する場合、それが「最新理解に反映済み」と誤認されないよう、`report` および `status` において境界を明示すること。

### B. 既停止理由と期限境界の保持条件
- **既停止の保護**: `before.stopReason` が存在する場合（例: `invalid_model_output`、`capability_limit` 等）、`invalidate` 後も `result.state.stopReason` を上書き消去せず、直前の停止理由および `effectiveDecision: 'blocked'` を維持すること。
- **期限後境界の遵守**: 予算枯渇後（`budgetCheckpoint.exhausted` または `accountingUnavailable`）に届いた撤回要求は、SDK 状態を変更せず、`unassessed-invalidate-*` の形式で内部 receipt に受領・未評価保存すること。

### C. 新 receipt / 旧 state 互換性および再配送・冪等性条件
- **再配送の冪等性**: 同一の撤回要求（同一 evidenceIds, reason）が再配送された場合、既に `withdrawn` であれば `changed = false`（revision 不変）となり、同一の state / receipt を返すこと。
- **同一 execution の再配送**: 評価待ち破棄後に同一の execution ID が再送された場合、ペイロード一致を検証し、不正な上書きや衝突（collision）として誤検知させないこと。
- **後続の実評価との互換性**: 破棄された probe に対して将来新しい実観測・実評価が届いた場合、新しい execution ID によって正当に gap が解決され、その新しい receipt のみが `applied` へ昇格すること（過去の破棄レシートが連れ立って誤昇格しないこと）。

### D. トランザクション・クラッシュリカバリ・transition・report 条件
- **トランザクション整合性**: `session-store.mjs` の `begin('invalidate')` $\rightarrow$ `stage` $\rightarrow$ `commit` $\rightarrow$ `reconcile` の各ステップで中断が発生しても、SDK ledger と session journal の間で不整合（`revision_conflict`）を起こさず復旧できること。
- **目標遷移（transition）への引き継ぎ**: 目的変更時には、破棄された未評価履歴も `previous.pendingUpdates` / `previous.stopReceipts` に正確に保全され、新 goal へ隠蔽・消去して持ち越されないこと。
- **レポート明瞭性**: `session.mjs report` は、「有効な証拠に基づく理解」「未評価のまま破棄された撤回・観測履歴」「実停止理由と実消費量」を混同せずに分離出力すること。

### E. TDD 先行記録の必須条件
- **製品編集前の RED 記録**: 実装者は製品コード（`session.mjs` / `session-store.mjs`）を編集する前に、上記 2 つの反例（既停止理由消失、未評価 receipt の誤 applied 化）を再現するテストケースを [`test/session-followup.test.mjs`](../../test/session-followup.test.mjs) 等に追加し、**明確な RED（失敗コマンド・exit code・失敗 assertion）を記録すること**。
- **回帰テストの実測**: 全回帰件数は r1 記載の旧 678 件に囚われず、PM が最新の実測件数をもって検証すること。

---

## 5. ハンドオーバー（Handover）

- **設計判定**: **明示 PASS**
- **後続アクション**:
  1. 同一 goal PM は本 r2 レビュー合格を記録し、Codex 実装担当者に反例の先行 RED テスト作成および最小修正の実装を着手させてください。
  2. 実装完了後は、RED / GREEN ログ、全関連テスト、`npm run typecheck`、実測回帰テスト、fresh raw-only 行動試験を経て、最終 full-diff review を実施してください。
- **レビュアー状態**: 完全 Read-only レビュー完了。作業ツリーへのファイル書き込み、実装、commit、push、PR 作成は一切行っておりません。
