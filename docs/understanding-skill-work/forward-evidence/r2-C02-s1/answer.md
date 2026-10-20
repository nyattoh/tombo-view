# 索引読み込み方針の検討結果と確認事項

ご提示いただいた資料（[`design/constraints.txt`](../../linked-evidence/understanding-forward/observers/C02/design/constraints.txt) および [`design/loading-options.json`](../../linked-evidence/understanding-forward/observers/C02/design/loading-options.json)）に基づき、tombo-view スキルを用いて方針の点検を行いました。

## 1. 資料・証拠により確認できたこと
- **必須条件の適合性**:
  - 必須要件（起動2秒以内、初回検索2秒以内、最大メモリ120MB以内）に対し、両案とも以下の通り全条件をクリアしています。
    - **eager案（起動時読み込み）**: 起動 1.6秒（<=2.0秒）、初回検索 0.05秒（<=2.0秒）、ピークメモリ 90MB（<=120MB）
    - **lazy案（初回検索時読み込み）**: 起動 0.3秒（<=2.0秒）、初回検索 1.4秒（<=2.0秒）、ピークメモリ 90MB（<=120MB）
  - 実装・保守の手間は同等であり、追加ライブラリも不要です。

## 2. 方針選定を分ける未確定事項（利用者の優先順位）
- `design/constraints.txt` に記載の通り、「起動の待ち時間」と「初回検索の待ち時間」のどちらを重視するかは未定となっています。
- どちらを優先するかによって最適な選定が逆転します：
  - **アプリの立ち上がりの速さを重視する場合**: **lazy案**（起動0.3秒・初回検索1.4秒）
  - **最初の検索時の即応性を重視する場合**: **eager案**（起動1.6秒・初回検索0.05秒）

## 3. 次の確認事項（ご質問）
方針を確定するために、以下の点についてどちらを重視されるかお聞かせください：
- **アプリ起動の待ち時間短縮（lazy案）** と **初回検索の即応性（eager案）** のどちらを優先しますか？

---
### 作業セッション成果物
- 検査レポート: [`report.md`](../../linked-evidence/understanding-forward/observers/C02/.session/report.md)
- 状態スナップショット: [`inspection.json`](../../linked-evidence/understanding-forward/observers/C02/.session/inspection.json)
- 台帳（正本）: [`events.jsonl`](../../linked-evidence/understanding-forward/observers/C02/.session/events.jsonl)
- 入力タスク: [`task.json`](../../linked-evidence/understanding-forward/observers/C02/.session/task.json)
- 初期提案エンベロープ: [`proposal.json`](../../linked-evidence/understanding-forward/observers/C02/.session/proposal.json)
- 観測記録: [`observations.json`](../../linked-evidence/understanding-forward/observers/C02/.session/observations.json)
- コマンド実行記録: [`command-exit-evidence.json`](../../linked-evidence/understanding-forward/observers/C02/.session/command-exit-evidence.json)
