# セッション引き継ぎ・再開記録 (Handover & Resume Guide)

## 検討状態の概要
- **タスクID**: `nightly-jobs-deadline-check`
- **最終リビジョン**: `3`
- **判定 (decision)**: `ready_for_requested_step`
- **停止理由 (stopReason)**: `null`
- **目標 (goal)**: `jobs/plan.json と jobs/durations.txt を読み取り、夜間処理（collect, summarise, archive）が01:00までに完了するか確認する`
- **適用範囲 (scope)**: `local-nightly-jobs-v1`

## 検証済み事項
- **主張 (claim)**: `c-plan-completion` (`status: supported`)
  - 「現在の予定と計測値に基づき、夜間処理の3つの処理（collect, summarise, archive）は01:00までに順次完了する」
- **解決済み不足 (gap)**: `g-job-durations` (`status: resolved`, `reason: supported`)
  - plan.json（00:00開始、01:00デッドライン、直列実行、追加待機0分）と durations.txt（計測値合計45分: 18分+12分+15分）に基づき解決。
- **再考 (reflection)**: `completed`
  - 留意事項（限界点）: 45分は直近5回の模擬実行計測値であり、次回実行の上限値ではないため、実稼働時の予期せぬ遅延リスクは残る。

## 保存ファイル一覧
- **台帳正本 (Ledger)**: `events.jsonl`（全3イベント記録済み）
- **最新状態キャッシュ (State Snapshot)**: `reflected.json`（revision 3 の完全な状態）
- **台帳再生状態 (Replayed State)**: `restored-state.json`（`dist/cli.js replay` で検証済み）
- **直前更新状態**: `next.json`（revision 2）
- **初期点検状態**: `inspection.json`（revision 1）
- **タスク定義**: `task.json`
- **提案エンベロープ**: `proposal.json`, `proposal-next.json`, `reflection.json`
- **観測証拠**: `observations.json`
- **検査レポート**: `report.md`
- **実行記録**: `commands.log`
- **回答テキスト**: `answer.txt`

## 別会話での再開手順
1. **状態の復元・照合**:
   `events.jsonl` を正本として使用します。
   ```sh
   node <TOMBO_ROOT>/dist/cli.js replay --ledger .session/events.jsonl --out .session/restored-state.json
   ```
2. **新規観測や追補を行う場合**:
   `reflected.json`（または復元stateに本文を再付与したstate）を `--state` に渡し、同一の `--ledger .session/events.jsonl` を指定して `session.mjs prepare` を実行してください。
   ```sh
   node <SKILL_ROOT>/scripts/session.mjs prepare --state .session/reflected.json --observations <NEW_OBSERVATIONS> --out .session/context-next.json --ledger .session/events.jsonl
   ```
3. **留意事項**:
   - 予算・経過時間上限（`maxElapsedMs: 1800000`）および開始日時（`startedAt`）はリセットせずそのまま引き継ぐ必要があります。
