# assessment correction core hand_over_summary

2026-10-14 07:07 JST のローカル検証を記録する。対象は `D:/develop/works/tombo-view/.audit/assessment-correction-worktree`、ブランチは `devin/20261014-assessment-correction`。開始時の base は `b2aeaefd0cb07500923eef7c22428bd227356c59`。通常ルートの製品、ビルド成果物、固定比較は変更していない。

## 成果と公開 API

元の Assessment スキーマと配列を保持し、明示した誤解釈を訂正履歴として追加する。訂正された target だけを有効評価から外す。無関係な評価、証拠本文、scope、validity は訂正によって変更しない。

- `assessmentDigest(input: unknown): string` は assessmentSchema で入力を検証し、キーを昇順に並べた canonical JSON の UTF-8 SHA-256 を返す。配列順序は保持する。
- `assessmentReferences(state): AssessmentReference[]` は全 assessment の `{claimId, assessmentIndex, digest}` を返す。index はその主張の assessments 配列内の位置。update の GenerationInput と ReflectionInput に同じ表を渡す。本文は重複しない。
- proposal の任意 `assessmentCorrections` は `AssessmentCorrectionProposal[]`。各項目は `{claimId, targetDigest, replacement: Assessment, groundingEvidenceIds, reason}`。`assessmentCorrectionProposalSchema` が検証する。targetDigest は参照表から選ぶ。置換内容は inline で与え、モデルに SHA-256 の計算を要求しない。
- state の任意 `assessmentCorrections` は `AssessmentCorrection[]`。各項目は `{claimId, targetDigest, replacementDigest, groundingEvidenceIds, reason}`。`assessmentCorrectionSchema` が検証する。SDK が置換 assessment を追記または重複排除し、digest を保存する。
- `src/index.ts` は既存の wildcard exports で新規関数・型・スキーマを公開するため、変更不要。

初期案の proposal replacementDigest 参照は、ツールを使わない生成モデルでは同一提案の新規置換内容を参照できなかった。親の追加指示で入力を inline replacement に変更した。保存形式は digest のまま。未公開の途中案への互換入力は保持していない。

## 振る舞いと制約

訂正は update 提案だけで受理する。inspect と reflect は拒否する。対象と置換先は同一主張の履歴に存在し、相異なり、適用順序上で未訂正でなければならない。未知参照、別主張、自己参照、二重訂正、循環を拒否する。後続の置換評価をさらに訂正する連鎖は許可する。

新規適用時の groundingEvidenceIds は、current で本文取得済みの証拠を指し、replacement.evidenceIds に含まれなければならない。保存済み履歴の検証は参照の構造を確認する。本文を伏せた journal と後日 withdrawn になった証拠を理由に、履歴を破棄したり target を復活させたりしない。

claimStatus と resolutionValid は同じ有効評価の判定を使用する。古い resolution が無効なら gap を再開する。訂正履歴を understandingHash に含めるため古い reflection は失効する。status が変わらない訂正も進展として扱う。訂正のない旧 state はフィールドを補完せず、旧 hash と journal の形式を保持する。

本文を伏せた状態の保存済み status の扱いは旧仕様を保持する。訂正ありの redacted resolution は訂正済み target だけを根拠にしていないことを確認する。新規更新・再考には従来どおり current 証拠本文の再取得が必要。入力 state に対する完全な由来証明や改ざん耐性を追加したという意味ではない。

失敗した提案の新規評価・訂正・解決は候補ごと破棄する。取得済み観測と実消費は既存の pending assessment と usage に残す。同じ executionId の再配送は完了済みなら無変更、未完了ならモデル評価だけを再試行する。新しい配送で同じ訂正を再発行することは二重訂正として拒否する。

## 検証

すべて隔離 worktree で実施した。通常 executor が helper 初期化エラーだったため、環境の承認手続きで `sandbox_permissions: require_escalated` を指定した。外部 API、参加モデル、課金処理は呼び出していない。

| 検証 | 実結果 | 記録 |
| --- | --- | --- |
| baseline SDK 契約の RED | 25 tests、17 pass、8 fail | assessment-correction-red.log |
| inline replacement と参照表の RED | 26 tests、25 pass、1 fail | assessment-correction-inline-red.log |
| redacted journal の別主張を含む invalidate 回帰の RED | 12 tests、11 pass、1 fail | assessment-correction-redacted-invalidation-red.log |
| 最終 core と journal | 48 tests、48 pass | assessment-correction-green.log |
| 最終リポジトリ全体 | 283 tests、283 pass | assessment-correction-suite.log |
| 差分検査 | git diff --check 成功 | 作業時の出力 |
| 独立コメント監査 | 指摘0、変更0 | correction_final_comments agent |

再実行コマンドは次のとおり。

```powershell
npm run build
node --test --test-reporter=tap test/assessment-correction*.test.mjs
npm test
git diff --check
```

受入確認は、同本文の誤 supports を inconclusive/scopeMatched false へ訂正したときの unverified・gap open・ready 拒否、cold refutes による contradicted・refuted 解決、実際に全条件を測った二資料の対立維持、別主張の訂正による非干渉、参照・循環・二重訂正・未取得・撤回・superseded 証拠の拒否、原子的な候補破棄、再考鮮度、旧 hash、redacted journal/replay/rehydrate、事後撤回、再配送と model/round/elapsed/cost 上限を含む。

## 所有ファイルとコミット

製品変更は `src/types.ts`、`src/core.ts`、`src/prompts.ts`。新規契約テストは `test/assessment-correction.test.mjs` と `test/assessment-correction-journal.test.mjs`。記録はこの文書と同ディレクトリの assessment-correction ログ。

- RED テストを先に保存したコミットは `b87f7df`、`test: reproduce explicit assessment correction contract`。
- 機能と最終テストのコミットは `af2372167373266773bdbca0ab7f8be2c309bfd7`、`feat: record evidence-grounded assessment corrections`。

Model the Domain により訂正を証拠の撤回と別の履歴型にした。Test Behavior, Not Implementation により公開 SDK から literal な状態を確認した。Prove It Works と Sequence work into verifiable units により RED の後に実装と GREEN を記録した。コメント専用の独立監査で新規コメント、型回避、不要と断定できる防御分岐の指摘はなかった。

## 親に残る作業と検証境界

親が所有する CLI、helper.prepare、レポート、スキル、評価接続と独立 GLM レビューは、この core 完了報告の対象外。helper.prepare は公開 `assessmentReferences(state)` を呼び、独自の digest 計算を追加する必要はない。

ローカル fixture と公開 SDK の機構検証だけを実施した。実モデルの訂正生成率、訂正の意味的正しさ、品質改善、現在進行中の epoch2 比較に対する効果は検証していない。訂正理由はモデルの解釈であり、構造検証や新しい reflection receipt はその意味を保証しない。
