# Scope diagnostics: implemented contract

確認: 2026-10-20 17:20 JST。新規11試験GREEN（exit 0）、関連既存202試験PASS（exit 0）、build/typecheck exit 0。証拠は同ディレクトリの `green-r1.log`, `green-r1.json`, `regression.log`, `regression.json`, `typecheck.log`。

## Public SDK

`assessmentScopeDiagnostics(state: UnderstandingState): AssessmentScopeDiagnostic[]` を `dist/index.js` からexport。型は `AssessmentReference` を継承する。

```ts
interface AssessmentScopeDiagnostic extends AssessmentReference {
  claimId: string;
  assessmentIndex: number;
  digest: string;
  evidenceId: string;
  claimScope: string;
  evidenceScope: string;
  kind: 'assessment_scope_unmatched' | 'evidence_scope_mismatch';
  reason: string;
  passageUnavailable: boolean;
}
```

`assessmentIndex` はclaimのassessment履歴の0始まりindex、`digest` は既存 `assessmentDigest(assessment)`。`reason` は元のassessment.reason。claim→assessment→evidenceIds順に導出する。両種別が成立する場合は同じclaim/evidenceについて2件返す。

- `assessment_scope_unmatched`: assessment.scopeMatched がfalse。モデルの適用範囲解釈であり、検証済みの事実ではない。
- `evidence_scope_mismatch`: evidence.scope と claim.scope の文字列が異なる。
- 訂正のtargetDigestに一致する評価を除外。各参照証拠のvalidityがcurrentの場合だけ診断。withdrawn/supersededの参照に診断は出さない。
- 評価が参照する本文のいずれかが未取得なら `passageUnavailable: true`。保存時の診断であり、現在の再検証ではない。
- 純粋導出。state、journal、understandingHash、claim/gap status、decision、validity、usageへ書き込まない。SDK `InspectionResult` の必須形状は変更しない。

## Helper surfaces

`session.mjs prepare` のトップレベル `assessmentScopeDiagnostics`。初回inspect入力なら `[]`、state入力なら導出配列。`request` と既存binding/requestHashは変更しない。

`inspect / update / reflect` のJSON結果のトップレベルにも同名配列を付ける。`state` の外にある運用説明であり、policyへの入力ではない。

`report` は保存JSONの配列を信用せずstateから再導出し、「適用できなかった証拠評価」にclaim/evidence/index/digest/scopes/理由と行動案を表示。本文未取得時は「保存時の診断。本文未取得・未再検証。」。適合資料の確認、証拠に基づく明示的訂正、説明の限定、問い/実行案の再構成を案内する。mismatchだけで普遍blockedにはしない。

## Existing continuation contract verified in real helper processes

- 初回からclaim、gap、probeを双方向に結ぶ。human-only gapは `ambiguous_intent` と適切な `humanRole`、回答受領用probeを初期登録する。
- 人の回答は `user_statement` を当該probeの新executionIdでupdate。希望の表明を外的事実へ拡張しない。
- 既存entityの上書きはせず、reflectで新gap/probeの組を追加できる。新claimはupdateで追加できる。
- ready後も同一probeの新観測をupdate可能。反証は支持をdisputedへ変え、解決済みgapを再開し、古いreflectionを失効させる。
- 誤読は `assessmentCorrections` の明示targetだけを置換し、独立した反証とcurrent evidenceを保持する。
- CLI `replay --ledger` はraw stateを返す。helper結果はenvelopeなので、CLIに渡す場合は `.state` を抽出する。replayは証拠本文を含まず、startedAt/利用量は維持する。
- 本文未取得のreflectは `passage_unavailable` で停止。同じmetadata/hashの本文を既存probeの新観測で再取得し、update→reflectで再開する。usage/時刻をリセットしない。
- ledger正本と異なるstate、stale proposal binding、同executionIdの異なるpayloadは拒否。同一execution/payload再配送は状態/利用量を重複加算しない。
- elapsed上限を超えた公開SDK生成stateをhelperの別プロセスで再開するとbudget_exhausted。現在時刻を無視した成功は作らない。

本試験は決定的な提案台本によるSDK/helperの機能確認。自発的なモデル判断・discovery・実用上の効果はPM所有の独立forward-testで確認する。費用/tokenはunknown。
