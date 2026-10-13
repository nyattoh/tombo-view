# Model repair handover

2026-10-14 JST。対象は `D:/develop/works/tombo-view/.audit/repair-worktree`。ブランチは `devin/20261014-bounded-model-repair`、開始点は `f3efdb2`。

## 成果と範囲

SDK 利用者は不正なモデル提案に対し、同じ状態と観測から最大 2 回の訂正生成を明示的に許可できる。既存 entity ID の再追加は、内容が同一でも拒否する。候補の適用は複製状態内で行い、検証を通った候補だけを返す。訂正時に claim、assessment、resolution、gap の一部を引き継がない。

所有変更は `src/core.ts`、`src/types.ts`、`src/prompts.ts`、`test/model-repair.test.mjs` と本書。runner、CLI、helper、評価器、親 worktree と親 dist は変更していない。node_modules は既存 junction を使用し、インストールも有料 API 呼出しもしていない。

## 公開契約

`createTombo({ adapter, maxModelRepairAttempts: 1 })` で有効になる。設定値は整数 0、1、2。値は追加の訂正回数であり、2 の場合は初回を含め最大 3 回。未指定と 0 は旧動作を保つ。null、負数、小数、文字列、NaN、Infinity、3 以上は `invalid_input`。

`GenerationInput.validationFeedback` と `ReflectionInput.validationFeedback` は任意。初回には存在せず、次の訂正生成へ次の shape を渡す。

```typescript
{
  code: 'invalid_model_output',
  message: string,
  rejectedAttempt: number,
  maxAttempts: number
}
```

message は既存の検証エラー文の先頭 512 文字以内。空文字の場合は固定の検証失敗文を使う。rejectedAttempt は直前の拒否試行を 1 から数え、maxAttempts は初回を含む上限。生のモデル応答や会話は追加しない。アダプタが投げる `TomboError('invalid_model_output', message)` には検証内容だけを入れる。アダプタ側で生のモデル応答を message に埋め込まない。

`UnderstandingState.modelRepairDiagnostics` は任意の配列。各要素は上記 feedback と `operation: 'inspect' | 'update' | 'reflect'` を持つ。拒否された全試行を操作順に追加し、成功した訂正後にも停止後にも保持する。操作内の rejectedAttempt は次の操作で 1 に戻る。訂正機能が未指定または 0 の状態、拒否のない状態へ空配列は注入しない。旧状態に既存の診断があれば保持する。

`ModelValidationFeedback`、`ModelRepairDiagnostic` と対応する `modelValidationFeedbackSchema`、`modelRepairDiagnosticSchema` は types の既存 wildcard export から公開される。追加の error code は作っていない。

inspect で訂正機能を有効にした場合、モデル段階の最終失敗は usage と診断付きの blocked InspectionResult を返す。入力検証の失敗は従来どおり例外。訂正機能が未指定または 0 なら、inspect のモデル段階の失敗も従来どおり例外。

## 予算、停止、互換性

すべての試行が最初の startedAt、task、budget、usage を共有する。再試行ごとに modelCalls を増やし、既知の token と cost を加算する。不明値は null のまま保持する。再試行の feedback も maxInputChars に含める。出力の会計と token 上限、残り時間の検査は提案内容の検査より先に行う。

金額上限がある場合は各試行で予約し、残高と実績を照合する。報告された会計が不正、不明、または予約超過の場合は再試行しない。上限なしの場合は outputTokens が既知なら totalTokens と costYen が null でも実行できる。出力長をアダプタが `invalid_model_output` として拒否した場合は、上限なしなら短い提案へ訂正できる。この例外に利用量が付いていないため、その呼出し以後の合計 token と cost は null になる。金額上限があれば停止する。

訂正対象は、その試行で実際に生成を開始した `invalid_model_output` に限る。予約関数が同じコードを投げても再試行しない。会計、予算、時間切れ、typed provider エラーと一般 adapter 例外は訂正対象外。明示的な中断を adapter が例外として返した場合も、invalid_model_output と誤分類しなければ再試行しない。新しい cancellation API は追加していない。

後方互換のため、未指定または 0 では既存の一般 provider 例外に対する transport retry を維持する。これは金額上限がない場合に最大 2 呼出し。1 または 2 を設定すると、この一般例外は最初の失敗で停止する。検証拒否だけに訂正生成を許す。

update の訂正は記録済みの同一観測バッチを再利用する。ツールは再実行せず、同じ操作内で round も追加しない。失敗が続いた場合は実観測と pendingAssessmentExecutionIds を残す。以前の外部 update 再呼出しに関する round 契約は変更していない。deferAssessment からの再開と、成功後の同一 execution 再配送も従来どおり扱う。

診断は理解の内容を表さないため understandingHash に含めない。journal の保存には含む。旧 shape にはデフォルト値を加えず、旧 journal の hash を保つ。reflection の完了には正確な binding と現 claim の coverage が必要。候補追加、証拠撤回、不明な観測、pending assessment は診断の有無によって解決扱いにならない。

## 検証記録

すべて隔離 worktree を明示した workdir で実行した。

- 最初の `npm run build` と `node --test test/model-repair.test.mjs` は変更前実装に対して 34 件中 30 件失敗、旧契約 4 件成功。
- 予約関数由来の invalid_model_output の追加反例は修正前に失敗した。予約 1 回の期待に対し実際は 2 回だった。
- 修正後の `node --test test/model-repair.test.mjs` は 41 件成功、失敗 0。
- 最終 `npm test` は build と既存全回帰を含め 177 件成功、失敗 0。
- `git diff --check` は成功。

テストは inspect、update、reflect の失敗後訂正、重複不変、原子 rollback、実 runner の検査 1 回と round 1 回、既知と不明の会計、各試行の金額予約、出力 token 上限、feedback 入力上限、モデル回数上限、遅延出力、timeout、継続拒否、deferred batch の厳密再配送、非成功観測、critic 権限制限、fresh reflection、journal replay、既定動作を検証する。fixture と制御アダプタによる契約テストである。

テスト commit は `f35a59edec6f58c39315eba8dedf0aa25de9c95a`。実装は本書と同じ後続 commit に入る。親が 2 commit を順に統合する。

## 判断と未実施

Model the Domain に従い、訂正を入力 feedback と任意の operational diagnostics として型にした。Prove It Works と Test Behavior, Not Implementation に従い、SDK と runner の観測可能な結果、journal の再読込みを検証した。Sequence Work into Verifiable Units に従い、失敗する契約テストを先に実行し、テスト commit と実装 commit を分けた。

親側の strict ID と bounded repair の採用判断を基準に実装した。親側の凍結評価とはディレクトリを分離した。コアと会計境界は一人の所有者で変更し、親が独立した統合レビューを担当する。

実モデルでの修復成功率、TOMBO の有効性、API 費用は測定していない。モデルに feedback を届ける helper、CLI と host bridge の opt-in 接続は親側の後続作業。ホスト委任モデルの実費は不明。全体目標の達成を示す成果ではない。

## コメント監査

独立した comment-sicko が基点 f3efdb2 との差分と所有コード 4 ファイルを読取り監査した。コメントと抑制指示は 0 件、指摘 0 件、削除 0 件、ファイル変更なし。親の機能レビューは後続作業。host-adapter の指定に従って deslop は差分を直接確認し、重複した会計失敗処理を削除した。型逃れと抑制指示は追加していない。
