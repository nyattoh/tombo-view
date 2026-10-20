# 独立限定設計レビュー報告書（Independent Design Review: Acceptance 2 Storage Scope 最小修正案）

- **レビュー種別**: fresh 独立限定 cross-vendor design review（同一 goal PM 配下、実装担当 Codex に対する独立 Google レビュアー視点）
- **対象作業ツリー**: [`D:/develop/works/tombo-view-ask-policy`](../..)
- **対象ブランチ**: `devin/20261020-1705-understanding-skill`
- **対象 HEAD**: `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`
- **対象設計案**: [`docs/understanding-skill-work/a2-storage-design-r1.md`](a2-storage-design-r1.md)（および [`a2-storage-source-design-result-r1.json`](a2-storage-source-design-result-r1.json)）
- **参照文書・コード（全読取り確認済み）**:
  - [`docs/understanding-skill-work/locked-charter.md`](locked-charter.md)
  - [`docs/understanding-skill-work/parent-authorized-scope-amendment-r1.md`](parent-authorized-scope-amendment-r1.md)
  - [`docs/understanding-skill-work/a2-raw-E-observations-r1.md`](a2-raw-E-observations-r1.md)
  - [`docs/understanding-skill-work/a2-design-r1.md`](a2-design-r1.md)
  - [`docs/understanding-skill-work/a2-managed-invalidate-review-r1.md`](a2-managed-invalidate-review-r1.md) / [`r2.md`](a2-managed-invalidate-review-r2.md)
  - [`results/understanding-acceptance2/runtime/api-contract.md`](linked-evidence/understanding-acceptance2/runtime/api-contract.md)
  - 現行 [`skills/tombo-view/scripts/session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs)
  - 現行 [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs)
  - 現行 [`src/journal.ts`](../../src/journal.ts)
  - 現行 [`skills/tombo-view/references/host-session.md`](../../skills/tombo-view/references/host-session.md)
  - 関連試験 [`test/session-binding.test.mjs`](../../test/session-binding.test.mjs)、[`test/session-followup.test.mjs`](../../test/session-followup.test.mjs) 等
- **費用・トークン**: **unknown**（計測対象外）
- **制約遵守**: 完全 Read-only（コード修正・ファイル書込・commit・push・PR・新依存・新API・secrets・グローバル変更なし、既存192 untracked保持、`D:/develop/works/tombo-view` は Git metadata 以外非参照）

---

## 1. 総合判定結果（Verdict）

**判定: 明示 PASS（合格・確定修正条件付き採用を承認）**

> [!IMPORTANT]
> **本判定は「Codex実装前の storage scope 最小修正案に対する限定設計 PASS」であり、「最終受入2達成・フルレビュー完了・親監査完了」の代替ではありません。**
> 過去の D01 失敗、E01/E02/E03 の失敗・不成立記録、managed invalidate 導入履歴、過去の親監査記録は免除されず不変の歴史として保持されます。
> また、PM の未解決懸念に基づき、source 案に含まれる過剰な OS サンドボックス化／汎用ファイルシステム防御（ハードリンク検出、デバイスID照合、Windows ADS 検査等）は**対象外（NOT_RUN / 不採用）**とし、実際の正本書き込み衝突を回避する**真の最小修正範囲へスコープを限定確定**した上で PASS とします。

---

## 2. PMの未解決スコープ懸念に対する独立判断

### (1) 汎用 filesystem hardening / OS sandbox の切り分け（NOT_RUN 境界）
- **判断**: **source 案が提案した「複数ハードリンク拒否（`st_nlink > 1`）」「デバイス/inode identity 照合」「Windows ADS（`:stream`）拒否」「末尾ドット/スペース特殊名防御」「dangling symlink の `lstat` 判定」「atomic exclusive file ラッパー」は、今回の受入2完了条件に追加する必要はなく、本修正スコープから明確に除外（NOT_RUN）とします。**
- **理由**:
  1. 今回の観察された実失敗（E01/E02）の本質は、ユーザー指示「`.session/` のみ保存許可」に対し、[`session-store.mjs:131`](../../skills/tombo-view/scripts/session-store.mjs#L131) の `withinSession(this.directory, path)` が `.session/` 全域を一律拒否していたため、通常の健全な activation が成立しなかったことにあります。
  2. 現行のアーキテクチャおよび契約文書（[`locked-charter.md`](locked-charter.md)、[`host-session.md:280`](../../skills/tombo-view/references/host-session.md#L280)、[`api-contract.md:140`](linked-evidence/understanding-acceptance2/runtime/api-contract.md#L140)）において、本機構は「協調的な排他ロックと二重正本の突合を前提とする helper 機構」であり、「悪意ある外部プロセスによる任意のファイル差し替えやカーネルレベルの攻撃を防ぐ OS sandbox ではない」ことが一貫して明示されています。
  3. 攻撃耐性のための汎用ファイルシステム堅牢化を混入させることは目的のすり替え（scope creep）であり、Node.js / OS 差異やパーミッション問題による不要な脆弱性・非互換リスクを生みます。

### (2) 新しい `.session/` 許可による正本衝突リスクの検証（反例の有無）
- **検証結果**: **「具体的な予約正本ファイル群・ロック・一時ファイル・親子関係の衝突検査」を適用すれば、`.session/` 直下への SDK 記録同居において正本破壊や状態不整合（false ready、競合）が生じる具体的反例（明確な穴）は生じません。**
  - **セッション権能正本**:
    - `this.path`: `<workspace>/.session/tombo-session.jsonl`
    - `this.cache`: `<workspace>/.session/tombo-session.json`
    - `this.lock`: `<workspace>/.session/tombo-session.jsonl.lock`
    - セッション一時ファイル: `<workspace>/.session/tombo-session.json.<UUID>.tmp`
  - **SDK 記録（例: `--ledger .session/sdk.jsonl --out .session/state.json`）**:
    - SDK ledger: `<workspace>/.session/sdk.jsonl`
    - SDK ledger lock: `<workspace>/.session/sdk.jsonl.lock`
    - SDK state cache: `<workspace>/.session/state.json`
    - SDK 一時ファイル: `<workspace>/.session/state.json.<UUID>.tmp`（[`journal.ts:123`](../../src/journal.ts#L123)）
  - **分離性の確認**:
    - ファイル名プレフィックスが明確に分離されており、相互の書き込み・ロック・atomic rename 一時ファイルが衝突しません。
    - ユーザーの非予約資材（`task.json`, `proposal.json`, `receipt.json`, `invalidation.json`, `report.md` 等）も予約正本名と重複しない限り同一 `.session/` 内に安全に共存可能です。
    - 大文字小文字（Windows の case normalization）や相対パスは、現行の [`canonicalPath()`](../../skills/tombo-view/scripts/session-store.mjs#L13)（`resolve` + `realpath` + lowercase化）で既に正規化されるため、別名によるすり抜けも遮断されます。

---

## 3. 採用すべき最小設計（確定修正条件）

変更対象ファイルは原則として **[`skills/tombo-view/scripts/session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs)** および実通常手順文書 **[`skills/tombo-view/references/host-session.md`](../../skills/tombo-view/references/host-session.md)** に限定します。

### (1) `session-store.mjs` の `paths(ledger, statePath)` 修正仕様
現行の `withinSession(this.directory, path)` による `.session/` 全域排除（L131）を、以下の**具体的予約パス照合・相互衝突検査**へと置き換える。

1. **基本境界条件の維持**:
   - `within(boundLedger)` かつ `within(boundState)` であること（workspace 内かつ workspace ルートと一致しないこと）。
   - `boundLedger !== this.directory` かつ `boundState !== this.directory` であること（`.session` ディレクトリ自体をファイルとして指定不可）。
2. **予約セッション正本・管理ファイルとの衝突拒否**:
   - 定義される予約対象:
     - `this.path`（`tombo-session.jsonl`）
     - `this.cache`（`tombo-session.json`）
     - `this.lock`（`tombo-session.jsonl.lock`）
     - セッション一時ファイル領域: `path.startsWith(this.cache + '.')` または `path.startsWith(this.path + '.')`
   - `boundLedger`、`boundState`、およびそれぞれのロックファイル（`${boundLedger}.lock`、`${boundState}.lock`）が、上記予約対象のいずれとも一致してはならない。
3. **SDK 内部の相互衝突拒否（既存維持・補強）**:
   - `boundLedger !== boundState`
   - `${boundLedger}.lock !== boundState`
   - `${boundState}.lock !== boundLedger`
4. **親子パス衝突の拒否**:
   - ファイル予定地が予約ファイルまたは相互の親ディレクトリにならないこと（例: `path.startsWith(this.cache + '/')` や `boundState.startsWith(boundLedger + '/')` 等のパス区切り境界での親子関係禁止）。
5. **後方互換性**:
   - 従来の「workspace 直下の `sdk.jsonl` / `state.json`」も上記拒否条件に引っかからないため、既存の全挙動・全テストがそのまま成立する。

### (2) 既存トランザクション・整合性機構の完全保全
以下の機構には一切の緩和・変更を加えないこと。
- `findSessionWorkspace(cwd)` による祖先 binding 検出・探索ロジック（L31-39）。
- `managed()` 起動時の canonical cwd チェックおよび `withLock`（L56）。
- `reconcile()` による SDK ledger（`FileJournal`）とセッション journal の二重正本突合・staged commit 復元。
- `checkpointBudget` による非生成操作を含む期限切れ・会計不足停止（`effectiveDecision: 'blocked'`, `stopReason: 'budget_exhausted'`）。
- `receive` / `invalidate` における未評価 receipt（`unassessed-invalidate-*`）の隔離保存と False Ready 防止。
- `transition` における厳格な `userChange` 検証、旧セッションの未解決 gaps / unknowns / 停止理由 / 利用量の引き継ぎ、および新 ledger/statePath の未使用・重複禁止検証。

### (3) 文書（`host-session.md` 等）の同期
- 「`sdk.jsonl` と `state.json` は固定 cwd 内かつ `.session/` の外の未使用パスにする」という旧記述（L27）を改訂。
- 「`.session/` 内（例: `.session/sdk.jsonl`, `.session/state.json`）または固定作業領域内の安全な未使用パスに配置できる。ただし `tombo-session.jsonl`, `tombo-session.json`, `.lock` 等のセッション管理予約ファイルと同一名・親子の配置は拒否される」旨を明記。
- ユーザーから `.session/` のみ書き込みが許可された制約環境でも、TaskPacket、提案、receipt、SDK 記録、レポートの全資材が通常手順通り `.session/` 内に一貫して保存可能であることを整合させる。

---

## 4. 実行必須条件（TDD / 回帰 / Fresh Raw）

Codex 実装担当者は以下の順序と基準を厳守すること。

### A. TDD RED 先行記録（必須）
- **製品コード修正前に、実プロセスでの RED を記録すること。**
- 現在の `session-store.mjs` に対し、`activate --ledger .session/sdk.jsonl --out .session/state.json` を実行した際に、`withinSession` によって `revision_conflict` で拒否されるテストケースを [`test/session-binding.test.mjs`](../../test/session-binding.test.mjs) に追加。
- 失敗コマンド、終了コード（exit 1）、失敗 assertion（`Ledger and state cache must be inside the fixed workspace and outside session authority.`）を記録し、本不整合が実際のプロセスで再現することを確認する。

### B. 最小修正と focused GREEN
- `session-store.mjs` の `paths()` を上記第3節の最小仕様で修正。
- 以下のケースがすべて pass（GREEN）することを確認する:
  1. `.session/` 内への `sdk.jsonl` / `state.json` 配置での正常 activate $\rightarrow$ inspect $\rightarrow$ reflect $\rightarrow$ report サイクル。
  2. セッション正本（`tombo-session.jsonl`）、キャッシュ（`tombo-session.json`）、ロック（`.lock`）への直接指定・大文字小文字 alias 指定の拒否。
  3. ledger / state の同一指定、相互ロック名指定、親子ディレクトリ衝突指定の拒否。
  4. 従来の workspace 直下配置（互換性）の維持。

### C. 関連回帰および全テストスイートの検証
- focused テスト（session-binding 24件+、session-followup 22件+ 等）。
- `npm run typecheck`（exit 0）。
- 全回帰テスト `npm test`（現行 705 件すべて pass、fail 0、skip 0 を維持）。

### D. Fresh Raw（Wave F）行動評価の受入条件
- 修正完了後、同一生シナリオ作成者による未提示の fresh raw F シナリオを投入。
- **条件**:
  1. 初期割り当ての固定 cwd と「`.session/` のみ保存許可」を全ステージで維持。
  2. observer に逃げ道や期待回答を与えず、スキル通常手順（`host-session.md`）に従って自律動作させる。
  3. 実際の managed activation が成立し、`.session/` 内に TaskPacket、SDK ledger、state、session journal が正規に生成されること（E01/E02 のような source-based 辞退や、E03 のような managed 迂回直呼びを行わないこと）。
  4. 実期限超過後に same-goal の追補が渡された場合、新タスク・新予算に逃げず、`unassessed` として受領・隔離し、元の task identity・開始時刻・停止理由・利用量が維持されること。
  5. 過去の E01/E02/E03 の失敗・部分保存記録は改竄・削除せずそのまま保持すること。

---

## 5. ハンドオーバー（Handover）

- **設計判定**: **明示 PASS（合格）**
- **後続アクション**:
  1. 同一 goal PM は本限定設計 PASS を記録し、Codex 実装担当者に `test/session-binding.test.mjs` への先行 RED テスト作成を指示してください。
  2. RED 記録確認後、`session-store.mjs` の `paths()` 最小修正および `host-session.md` の記述同期を行わせてください。
  3. GREEN、回帰（705 pass / skip 0）、typecheck を確認した上で、fresh raw F 評価へと進めてください。
- **レビュアー状態**: 完全 Read-only 評価完了。作業ツリーへの変更・commit・push・PR 作成等は一切行っておりません。
