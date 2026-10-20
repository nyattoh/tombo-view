# 運用メモの確認結果および差し替え文

## 1. 調査・確認結果

[notes/retry-note.txt](../../linked-evidence/understanding-forward/observers/A01/notes/retry-note.txt) の記述を [src/retry.ts](../../linked-evidence/understanding-forward/observers/A01/src/retry.ts) および [config/job.json](../../linked-evidence/understanding-forward/observers/A01/config/job.json) と照合した結果、以下の2点の相違が確認されました。

1. **再試行対象ステータスコードの不一致 (HTTP 408)**
   - **運用メモの記述**: 「HTTP 408、429、500以上の失敗は自動で再試行する。」
   - **実装コード (src/retry.ts)**: `(status === 429 || status >= 500)`
   - **確認結果**: 現在の実装では HTTP 408 は再試行対象に含まれておらず、429 または 500 以上のエラーのみが再試行されます。

2. **設定値 maxAttempts の定義・解釈の不一致**
   - **運用メモの記述**: 「設定値 maxAttempts は、初回を除いた再試行回数を表す。」
   - **実装コード (src/retry.ts) & 設定 (config/job.json)**:
     - `config/job.json` では `"maxAttempts": 3` と設定されています。
     - `src/retry.ts` では `attempt < maxAttempts` かつコメントに `// attempt starts at 1 for the first request.` と明記されています。
     - 判定の流れ:
       - 初回リクエスト失敗時: attempt = 1 (1 < 3 は真) -> 1回目の再試行
       - 再試行1回目失敗時: attempt = 2 (2 < 3 は真) -> 2回目の再試行
       - 再試行2回目失敗時: attempt = 3 (3 < 3 は偽) -> 終了
     - 合計試行回数は最大3回（初回1回＋再試行2回）です。
   - **確認結果**: `maxAttempts` は「初回を含む最大試行回数（総試行回数）」であり、「初回を除いた再試行回数」ではありません。

3. **その他の記述**
   - 「再試行の対象にならない失敗は、その場で終了する。」という記述は、上記条件を満たさない場合に `shouldRetry` が `false` を返す挙動と一致しています。

---

## 2. 運用メモの差し替え文案

現状の実装仕様に合わせた差し替え文案は以下の通りです。

```text
取込バッチの再試行
HTTP 429、500以上の失敗は自動で再試行する。
設定値 maxAttempts は、初回を含む最大試行回数を表す。
再試行の対象にならない失敗は、その場で終了する。
```

---

## 3. TOMBOセッション・実行結果

TOMBOスキルおよびヘルパー（session.mjs）を用いた点検状態の記録結果は以下の通りです。

- **作業ディレクトリ**: `D:/develop/works/tombo-view-ask-policy/results/understanding-forward/observers/A01/.session/`
- **台帳 (events.jsonl)**: リビジョン0からリビジョン2までの更新を記録。
- **実行状態**:
  - `inspect` 実行により初期命題・検証ギャップ・プローブを登録し、決定は `needs_check` となりました。
  - 実観測データ（src/retry.ts および config/job.json の読取内容・ハッシュ）を作成し、`prepare update` および `update` を実行しました。
  - `update` 処理において実観測データは台帳に適用・記録されましたが、初期タスク予算で設定した経過時間上限（`maxElapsedMs: 60000`）に対し、実経過時間（`143562ms`）が超過したため、台帳上のステータスは `decision: "blocked"`、`stopReason: "budget_exhausted"` として停止記録されました。
  - スキル規約に基づき、予算超過による停止状態を改ざん・リセットせず、正式なレポートとして生成・保持しています。

### アーティファクト一覧
- タスク入力: [.session/task.json](../../linked-evidence/understanding-forward/observers/A01/.session/task.json)
- 初期点検コンテキスト: [.session/context-inspect.json](../../linked-evidence/understanding-forward/observers/A01/.session/context-inspect.json)
- 初期点検提案: [.session/proposal-inspect.json](../../linked-evidence/understanding-forward/observers/A01/.session/proposal-inspect.json)
- 点検状態: [.session/inspection.json](../../linked-evidence/understanding-forward/observers/A01/.session/inspection.json)
- 実観測データ: [.session/observations.json](../../linked-evidence/understanding-forward/observers/A01/.session/observations.json)
- 更新コンテキスト: [.session/context-update.json](../../linked-evidence/understanding-forward/observers/A01/.session/context-update.json)
- 更新提案: [.session/proposal-update.json](../../linked-evidence/understanding-forward/observers/A01/.session/proposal-update.json)
- 更新後状態: [.session/updated.json](../../linked-evidence/understanding-forward/observers/A01/.session/updated.json)
- 台帳正本: [.session/events.jsonl](../../linked-evidence/understanding-forward/observers/A01/.session/events.jsonl)
- 点検レポート: [.session/report.md](../../linked-evidence/understanding-forward/observers/A01/.session/report.md)
- コマンド実行ログ: [.session/commands.log](../../linked-evidence/understanding-forward/observers/A01/.session/commands.log)
