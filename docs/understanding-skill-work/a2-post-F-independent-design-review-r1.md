# 独立クロスベンダー設計レビュー報告書（Post-F Acceptance 2 Repair r1）

**レビュー実施日時**: 2026-10-21 JST  
**対象ブランチ**: `devin/20261020-1705-understanding-skill`（HEAD: [`dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`](../..) / base: `origin/main`）  
**作業領域**: [`D:/develop/works/tombo-view-ask-policy`](../..)（メインリポジトリは非参照、Git メタデータのみ）  
**レビュアー立場**: 独立クロスベンダー設計レビュアー（Google / Antigravity）。Read-only、ファイル書込みなし、テスト未実行、子タスク呼び出しなし。  
**レビュー範囲**: [`a2-post-F-source-diagnosis-r1.md`](a2-post-F-source-diagnosis-r1.md) および [`a2-post-F-repair-design-r1.md`](a2-post-F-repair-design-r1.md) の設計検証。  
**トークン／費用**: `unknown`（SDK コストフィールドは `null`、会話ホスト消費は計測不能）。

---

## 1. 総合判定 (Verdict)

**判定: PASS（設計着手適格性 / Design Readiness Only）**

> [!IMPORTANT]
> 本判定は **「Post-F 修正設計（r1）が実装着手および TDD RED 工程へ進むための要件を完全に満たしている」ことの承認（Design Readiness PASS）** であり、**受入れ基準 2（Acceptance 2）の達成判定、ゴール完了判定、またはフル差分受入れレビューの PASS ではありません**。
> 過去の D01・E 群・F 群の失敗記録および 192 件の過去未追跡ファイルはすべて不変の歴史として保持され、712 テスト通過実績は固定された過去エビデンスとして扱われます。

---

## 2. 課題別独立検証結果 (Independent Challenge Validation)

### (1) `helperReceivedAt` のロック下生成と出所分離
- **検証結果: 適合 (PASS)**
  - `SessionStore.receive()` において、入力ペイロードの検証および既存実行 ID の衝突検証（`executionMap()`）を完了した後、セッション排他ロック（`withLock`）を保持した状態で、helper が自律的に ISO UTC 文字列を生成して付与する設計となっています。
  - `normalized`（`id`, `source`, `text`, `references`, `observations`, `invalidation`）に新フィールドを含めないため、入力ハッシュ（`payloadHash`）の決定論的一意性と再配送時の冪等性（同一 ID かつ同一ペイロードなら同一 receipt を返却）が厳密に保護されます。
  - caller からの入力フィールドとしては一切受け付けず（存在時はエラー拒絶）、OS クロックをホストメッセージの絶対到達時刻や単調増加バジェット正本として捏造・偽装しません。
  - 過去のレガシー receipt のロード時や再配送時に現在時刻で埋める（backfill）ことを禁止し、欠落時は `unknown` として正直に開示します。
  - 内部合成 receipt（`retainExpiredObservations`, `pendingInvalidation`）も同一の `store.receive()` 経路を通るため、初回生成時刻の保持と非改変性が保証されます。

### (2) 派生 `understandingStatus` とコア SDK セマンティクスの整合
- **検証結果: 適合 (PASS)**
  - `managedResult(store)` に追加される `understandingStatus` は、SDK 正本ステートおよびセッションから都度再導出される非介入・非破壊フィールドであり、`UnderstandingState`、`understandingHash`、`requestHash`、セッションジャーナル構造を一切改変しません。
  - **`requiredGapIds`**: コアの `needed`（`importance === 'required' && status !== 'resolved'`）と完全一致（[`core.ts:245-247`](../../src/core.ts#L245-L247)）。
  - **`reflectionStatus`**: コアの `reflectionFresh(state)`（[`core.ts:72-77`](../../src/core.ts#L72-L77)）の判定基準（`taskId`, `understandingHash`, `reviewedClaimIds.length === claims.length` かつ全クレーム含有）に厳密に準拠。
    - バジェットチェックポイントによる revision 進行（`basedRevision`）でステートハッシュ不変の reflection を誤って `stale` 扱いしない境界が正しく明記されています。
    - `reflectionEffects`（提案によって追加された gap）の不在だけをもって「未再考」と誤認しない制約が遵守されています。
    - `inconclusive`、`missing`、`stale`、`not_required`、`unavailable` の状態が明確に区別されています。
  - **`canReportCompletion`**: `effectiveDecision === 'ready_for_requested_step'` かつ未解決 required gap なし、未完了 execution なし、未評価更新なし、会計不確定なし、バジェット枯渇なし、reflection 完了/不要のときのみ `true`。
    - これは「現ステップの SDK 完了を記述可能」であることを示すのみであり、自由文の真実性・意味的妥当性、外部操作の実行許可、あるいはユーザーゴール全体の完了を意味しないことが明記されています。

### (3) 儀礼的チェックリストを排した簡潔なループ誘導
- **検証結果: 適合 (PASS)**
  - 特定の単語（「PC」「見積もり」「保証」「納期」等）を検知するアドホックな正規表現ルールや、全メッセージで強制される儀礼的チェックリストを一切新設していません。
  - `prepare` の出力および [`host-session.md`](../../skills/tombo-view/references/host-session.md) に追加される誘導は、「receipt 反映と新クレーム追加は gap 解決や再考そのものではないこと」「関連する未解決 gap の条件を確認し、十分な根拠がある場合のみ resolution を提案すること」「曖昧・未確定な回答には条件付き提案に留め、不当な確定断定を行わないこと」という理解サイクルの一般規律に限定されています。

### (4) 実装前の有意味な RED 検証と盲検フォワード試験計画
- **検証結果: 適合 (PASS)**
  - 決定論的テスト（[`test/session-followup.test.mjs`](../../test/session-followup.test.mjs)）において、実サブプロセスを用いた 7 つの明確な RED ケース（未来・過去時刻入力時の挙動、冪等再配送、レガシージャーナルの unknown 扱い、未解決 gap 時の `canReportCompletion === false`、曖昧回答時の `needs_user_input` 保持、非破壊性の確認等）が定義されており、単語マッチングではなく契約セマンティクスを直接検証する構成となっています。
  - 実モデルによるフォワード評価では、オブザーバーに対して修正スキルと新規 raw シナリオのみを渡し、設計書・過去の F 失敗事例・期待される具体的アクションを秘匿する盲検性が確保されています。
  - 過去の E 群（activation 前の拒絶）・F 群（実コミット後の gap 未解決および意味的過剰断定）の失敗分類を混同せず、維持することが確認されています。

### (5) ファイル所有権の排他性とスコープ境界
- **検証結果: 適合 (PASS)**
  - **Runtime 担当**: [`skills/tombo-view/scripts/session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs), [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs), [`test/session-followup.test.mjs`](../../test/session-followup.test.mjs)
  - **Docs 担当**: [`skills/tombo-view/SKILL.md`](../../skills/tombo-view/SKILL.md), [`skills/tombo-view/references/host-session.md`](../../skills/tombo-view/references/host-session.md), [`README.md`](../../README.md)（raw 結果確定後に同期）
  - **Core SDK**: [`src/core.ts`](../../src/core.ts), [`src/types.ts`](../../src/types.ts) は **変更不要（非変更維持）**
  - **PM 担当**: 進行管理・エビデンス集約・ゲート記録のみ（製品コード実装は行わない）
  - 重複書込みのない排他的所有権が維持されており、外部依存・有償 API・OS サンドボックスへの拡張はありません。
  - 前回マニフェストの全 16 ファイル（新規 7 ファイル含む）は最終フルレビューの対象として保持されます。

---

## 3. 契約詳細の確認 (Contract Evaluation Summary)

| 契約 | 設計概要 | 互換性・最小性 | 判定 |
| :--- | :--- | :--- | :--- |
| **Contract A**<br>`helperReceivedAt` | `receive()` の排他的ロック下で生成、caller 出所時刻 `source.receivedAt` を保持、`payloadHash` 除外、過去 receipt の backfill なし | SDK 型・コア・ジャーナルスキーマを変更せず、実受領時刻と caller provenance を分離 | **PASS** |
| **Contract B**<br>`understandingStatus` | `managedResult` に `requiredGapIds`, `reflectionStatus`, `canReportCompletion` を追加。ステート・リクエストハッシュ非破壊 | コア `reflectionFresh` と 100% 整合。不当な自動解決や universal blocked を回避 | **PASS** |
| **Contract C**<br>スキル・ドキュメント誘導 | `prepare` およびマニュアルにおける次アクション（gap 確認、根拠ある解決、条件付き提示）の簡潔な接続 | 特定ドメインの文言縛りを排除し、理解サイクルの普遍的ループを指示 | **PASS** |

---

## 4. 次工程への申し送り事項 (Next Steps & Handover)

1. **本設計の確定と TDD RED の実施**:
   - Runtime 担当は製品コード着手前に、[`test/session-followup.test.mjs`](../../test/session-followup.test.mjs) において設計書に規定された 7 つの契約失敗ケースを実装し、コマンド・終了コード 1・失敗ログを記録すること。
2. **最小実装と回帰検証**:
   - RED 記録後、[`session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs) および [`session.mjs`](../../skills/tombo-view/scripts/session.mjs) の最小修正を実施し、GREEN、関連回帰、および全体回帰（`npm test` 712+ 件パス、skip 0）を確認すること。
3. **新規ブラインド Raw シナリオ評価**:
   - 修正後のスキルを用い、設計内容・F 失敗事例を伏せた独立オブザーバーによる新規シナリオ評価を実施すること。
4. **独立フル差分レビューと親監査**:
   - 全 16 ファイル（新規ファイル含む）の差分、テストエビデンス、および raw 評価結果を揃えた上で、独立フル差分レビュー（Full-Diff Review）および親エージェントによる受入れ監査（`parent-final-audit.json`）を受けること。親の承認完了まで commit / push / Draft PR 作成は行わないこと。
