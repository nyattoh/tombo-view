## 概要

TOMBOのリポジトリ内skillを、開発や通常会話の実タスクで使える理解更新サイクルへ拡張します。質問を増やすこと自体を目的にせず、証拠・不足・反例・人の回答に応じて `proceed` / `check` / `ask` / `reframe` / `blocked` を選び、同じタスク内で状態を更新・保存・再開します。

## 主な変更

- **skill** (`skills/tombo-view/SKILL.md`, `references/host-session.md`): 起動後の追補、実回答、訂正、期限、保存・再開を説明。AIが入力や提案を準備し、SDK helperを通じて実タスクを確認する経路と限界を明記。Hidden-Sideの説明を配置先に同梱し、コピー後に切れていた相対リンクを修正。
- **SDK** (`src/core.ts`, `src/types.ts`, `src/report.ts`): 適用対象外のassessment scope診断、予算checkpoint、実際に拒否されたproposalの安全な限定記録を追加。非proposal revision後の古い記録はinactiveとして保持し、古いfeedbackの再利用を抑止。証拠scope・execution・利用量・既存resolution条件は緩和しません。
- **session-store.mjs** (`skills/tombo-view/scripts/session-store.mjs`, `session.mjs`): `.session` 内のjournal/cacheを正本としてbinding、時計、会計、lock、保存・再開、未評価追補を管理。互換性の境界とmanaged pathの適用範囲をskill/READMEに記載。
- **検証・運用**: 回帰用テストと、マージ後に4つの配置先へコピーしてSHA-256を照合する `scripts/sync-tombo-view-skills.ps1` を追加。スクリプトは通常dry-runで、`-Apply -MergedCommit <sha>` がなければコピーしません。配置先の `references/runtime.json` と `.session` は保護し、余分な配置先ファイルは削除しません。

## 検証

- `npm test`: 767/767 pass、fail 0、skip 0、cancelled 0、exit 0。
- `npm run build`: exit 0。
- 同期スクリプトのPowerShell parseとdry-run: exit 0。4配置先を表示しただけで、いずれにも書き込んでいません。
- credential-shaped secret scan: staged予定のソース・評価証跡に認証情報値は見つかりませんでした。`gitleaks`は環境にありません。build出力 `dist/` はignoredのままコミットしません。

## 未完了の受入と監査

このPRは受入2・親監査の完了を意味しません。限定的な合成forward試行には同一タスクでの人回答更新や保存再開の成功例がある一方、意味過剰、期限・caller時刻の誤認、予算切れなどの失敗・partialも残ります。特にD01では、同じ目的の期限切れ追補を新しいtask/budgetへ移し、完全な旧利用量handoverを欠く失敗が残っています。旧H/F/Gの失敗、A3の未回答stage1質問、手続逸脱の未免責記録も保持しています。ライブモデルの一般的な有効性は主張しません。

既存のpost-H full-diff reviewは `NEEDS_REVIEW` で、F1 r2変更を含むfresh full-diff reviewは未実施です。最後に記録された `task_gate.py` はexit 3（G2/G12/G14未達）で、今回のfreeze後の再実行はしていません。親の監査判定は `not_accepted_needs_review`、A2=falseです。現状を合格へ読み替えず、この未完了をレビュー対象に残します。

understanding-skillの設計・実装・評価・試験・監査証跡を同梱しています。ignored `results/` のうち文書から参照される40ファイルは `linked-evidence/` に複製し、PR内リンクを解決しています。重複する中間 `.patch` / `.diff` 25ファイルは作業ツリーに保持したままPRから除外しました。別作業の歴史的 `docs/ask-policy-work/` 192ファイルとignored `dist/` build出力も保持して除外しています。

## マージ後の配置同期

Kotaがマージした後にだけ、`D:\develop\works\tombo-view-main` を `origin/main` へfast-forwardし、`npm run build` を実行してください。その後、merged commit SHAを指定して次を実行すると、`.claude`、`.agents`、`.codex`、`%LOCALAPPDATA%\hermes` の `skills/tombo-view` へコピーし、全コピー対象ファイルのSHA-256を照合します。

```powershell
pwsh -File scripts/sync-tombo-view-skills.ps1 -Apply -MergedCommit <merged-commit-sha>
```

スクリプトは `origin/main` と現在のcheckoutの両方にmerged commitが含まれることを確認します。マージ前に4配置先を上書きしていません。`D:\develop\works\tombo-view` には触れていません。
