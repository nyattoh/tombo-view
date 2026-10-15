# Static snapshot進捗判定のhandover

2026-10-14。隔離worktreeは `.audit/unknown-stop-worktree`。基準は `be0411b1a06f7d55c8a5f64816b22c7caf533105`。製品変更は `src/core.ts` と `src/types.ts`。ROOTの編集、ビルド、commit、push、追加モデル生成、API、Jevは実施していない。

## 利用者に見える動作

executorが同じ固定snapshotだと明示した資料を再取得し、新しい情報も理解の変更もない場合、SDKは該当probeを `exhausted` にする。他の必須probeがあれば続ける。なければ `blocked / no_progress` で止める。主張はunverified、gapはopenのまま保持する。到達不能を支持する証拠やreadyへの昇格は作らない。

元のnext-05の3提案を無改変で公開fixtureから再生すると、宣言ありでは最大2ラウンドでも `no_progress` で停止する。元の宣言なしでは従来と同じ `budget_exhausted`。採点分類、予算、モデル提案は変更しない。親の評価ホストが採用する際は、固定fixtureのexecutorから宣言を供給する必要がある。

## 契約とデータの形

公開 `Observation` に `staticSnapshot?: string` を追加した。これはexecutorが管理する、不変なsnapshotの識別子である。completedで非空evidenceを返す場合だけ指定できる。モデルのProposalには追加していない。

```ts
const observation = {
  executionId,
  probeId,
  outcome: 'completed',
  evidence,
  toolCalls: 1,
  elapsedMs,
  costYen: null,
  staticSnapshot: 'graph-export:exp-2025-02-14:fixed-fixture',
};
const next = await tombo.update(state, [observation]);
```

信頼できるexecutorが固定版のローカルfixture、内容固定の成果物、版を固定した取得先を検査し、その保証に基づいて指定する。資料本文の「static」「complete」などから推定しない。汎用URLや時点依存の状態記録では、本文が同じでも指定しない。TTL更新、current-status確認、実mechanical検査は宣言なしの既定動作を維持する。SDKはsnapshotが不変だという外部の主張自体を証明しない。誤ったexecutor宣言は誤停止を起こし得る。

適用済み実行には `staticSnapshot: { id, evidenceIds }` を保存する。同じ宣言を持つ以前の実行で、kind、locator、sourceGroup、version、scope、contentHash、validityの全項目が一致し、本文が利用可能な証拠を参照している場合だけ再読と判定する。取得時刻の除外はこの明示された固定snapshot内に限る。証拠自体のid、retrievedAt、本文、版、評価履歴は削除しない。宣言が異なる場合は進捗として扱う。

休止状態は既存 `Probe.status` に `exhausted` を一つ追加して表す。休止理由を別mapやrunner内cacheに複写しない。意味のある新情報、新claim/gap/lens/probe、状態変化、明示assessmentCorrection、証拠撤回で再開する。静的重複とno_resultが同じバッチに入った場合も、そのバッチで進捗のない実行済みprobeだけを休止し、未実行probeを残す。宣言なしだけのバッチは従来の停止規則を維持する。

## 不変条件

- `understandingHash` の計算は変更していない。旧状態のhash、証拠の不変ID、評価履歴、receipt freshnessを保持する。新しい証拠IDや評価が入れば以前のreceiptは失効する。
- 宣言はobservation全体のpayloadHashに含まれる。deferAssessment後の配送は、宣言を除去または変更すると拒否される。実行履歴の宣言はjournalの完全なstate hashで保護される。understandingHashが実行履歴を含まない既存仕様を、配送や台帳の整合性に転用していない。
- redactedな以前の証拠を利用可能な本文と同等とは見なさない。正確な本文rehydrationを受理し、その後の重複判定で利用する。withdrawnとcurrentは別の情報として扱う。
- 最後の許可されたupdateで重複が確定した場合はno_progressが予算停止より先になる。update前の生成・実検査予算ゲートは変更していない。実行済みtool、model、roundと未知費用の計上も保持する。
- runnerとjournalは変更していない。runnerはSDKから得たpending/running probeだけを実行する。判定者はSDKだけである。

## 再現と検証

公開可能なfixtureは `test/fixtures/unknown-progress/recorded.json`。synthetic caseのtask、3個のモデルproposal、2個の観測、元proposal文字列のdigestを保持する。生の個人会話や推論過程は含まない。`test/helpers/unknown-progress.mjs` と `test/unknown-progress.test.mjs` はROOTやignored resultsに依存しない。

隔離worktreeで実行した記録は次の通り。

| 段階 | コマンド | 結果 |
| --- | --- | --- |
| 元問題のreplay | 調査用SDK replay | 無宣言・元予算でbudget_exhausted。診断用3ラウンドではneeds_checkのまま |
| portable RED | `node --test test/unknown-progress.test.mjs` | 契約未実装で7件fail |
| 最初のGREEN | 同上 | 32件pass |
| 混在バッチの追加RED | 同上 | 34件pass、1件fail。未実行probeを残せなかった |
| 最終GREEN | 同上 | 35件pass、0件fail |
| 全体確認 | `npm test` | TypeScript build成功、335件pass、0件fail |

追加試験は元モデル提案の無改変replay、宣言なしの互換性、重要な証拠tupleの変更、別snapshot、機械検査と状態更新の既定動作、同じclaim statusでの明示訂正、別probeへの継続、旧receipt失効、deferred配送の改変拒否、不正宣言、モデルによる宣言注入の拒否、事前予算ゲート、台帳redactionとrehydration、withdraw後の再開を確認する。既存の旧hash互換試験も全体確認に含まれる。

## 判断と未確認事項

Model the Domainに従い、観測IDと固定資料の情報差を別々に扱った。Fix Root Causesに従い、hostのerror分類を変えずSDKの進捗とprobeの再開を変更した。Test Behavior, Not ImplementationとProve It Worksに従い、公開SDKとrunnerを呼んで未知保持、配送拒否、次に実行するprobe、台帳再生を検証した。Build the Leverに従い、再生可能なportable fixtureを残した。

throughput checkpointのblocking stepsは親の独立設計比較とportable RED。独立workstreamはない。型、更新処理、試験が同じ契約を変更するため一人のownerで直列に実装した。共有状態は隔離worktreeで分離した。親が独立レビューとROOTへの採否を所有する。

未確認なのは実モデルを再度呼んだ比較評価である。今回の335件は機構と互換性の証拠であり、未知発見能力の効果実証ではない。実モデル費用とtokensはUNKNOWN。追加有料APIとJev呼出しは0。

hand_over_summaryとして、親は差分を独立レビューし、executorが不変性を保証できるfixtureだけにstaticSnapshotを設定する。新状態にはexhaustedと宣言履歴があるため、旧バイナリへ保存済み新状態を戻せるとは保証しない。既存状態の読込みとhashは互換を維持する。
