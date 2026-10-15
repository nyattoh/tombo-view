# 固定snapshotのホスト接続 handover

2026-10-14。対象は `D:/develop/works/tombo-view/.audit/unknown-stop-worktree`、基準は `be0411b1a06f7d55c8a5f64816b22c7caf533105`。SDK側の契約と検証は [unknown-progress-handover.md](unknown-progress-handover.md) にある。

## 変更

`scripts/metacognition-host-trial.mjs` は新しい `protocol.version: 2` の明示された `staticSnapshotPolicy` だけを採用する。旧プロトコルや省略時は従来の観測を返す。既に凍結したプロトコル、ケース、threshold、error分類は変更していない。

```json
{
  "staticSnapshotPolicy": {
    "version": 1,
    "mode": "immutable_case_records",
    "records": [{
      "caseId": "対象ケースID",
      "sourceId": "対象レコードID",
      "recordDigest": "ケース内sourcesの対象オブジェクト全体をJSON.stringifyしたUTF-8 SHA-256"
    }]
  }
}
```

ドライバーは既存のcases digest照合に加え、厳密な `frozenBeforeResults: true`、新プロトコル版、ポリシーのschema、各case/sourceの一意性、read_record能力、利用可能な非空本文とrecordDigestをREQUEST前に確認する。重複指定、未知参照、不一致、機械検査、空一覧や余分なキーを拒否する。宣言対象のsourceオブジェクトはfreezeする。外部資料の不変性を本文から推定する機構はない。

snapshot IDは `case-record:` に続く `[caseDigest, caseId, sourceId, recordDigest]` のJSON digestである。計算はドライバーのポリシー境界一箇所にある。指定済みポリシーを `trace.methodConfiguration.staticSnapshotPolicy` に保存し、各toolイベントへsnapshot IDを記録する。TOMBO executorが同じIDをObservationへ渡す。baselineとTOMBOは同じ能力とsource内容を取得し、checksのresponseDigestと物理読取り会計は従来どおり残る。

公開スキルとhost-sessionはSDKの利用契約を説明する。利用者へJSON作成を求めない。不変性を保証できるexecutorだけが固定版を指定し、実際の新しい読取りには新しいexecutionIdとEvidence IDを付ける。TTL/current-statusや実機械検査の既定動作を変えない。重複した固定資料の読取りではunknownと未解決gapを保持し、他の必須probeを続け、残る検査がなければno_progressで止める。

## 検証

隔離worktreeから実行した。

| コマンド | 結果 |
| --- | --- |
| `node --test test/host-trial-static-snapshot.test.mjs test/host-trial.test.mjs test/host-trial-profile.test.mjs test/host-trial-repeated-source.test.mjs test/host-trial-repair.test.mjs` | 21件pass、0件fail |
| `npm test` | TypeScript build成功、341件pass、0件fail |

新しいfocused試験6件は無料のfixture originで実ドライバーと実SDKを起動する。記録済みnext-05の提案を、実executorが付ける証拠IDへ束縛して適用する。宣言ありでは5呼出し、3生成、2読取りでno_progressを返し、該当probeはexhausted、元のclaimはunverified、gapはopen、最終判定はunknownである。宣言なしは同じ会計で元のbudget_exhaustedを保持する。別armで同じphysical recordsと能力を確認し、別固定版のsnapshot ID分離と許可一覧外の資料への非適用も確認した。不正ポリシーは18種類をREQUEST前に拒否した。

初回focused実行は保存履歴の試験参照を `executions` としたため1件失敗した。実SDKの `appliedExecutions` に修正後、focusedと全体試験が通った。この試験記述の修正を製品のRED/GREEN証拠には扱わない。

## 境界と親への引き継ぎ

ROOTは編集・ビルドしていない。commit、push、API、Jev、追加有料生成は実施していない。既存の凍結比較を新ポリシーへ変更していない。341件は機構と互換性の証拠であり、実モデルの未知発見能力や全未知の発見を証明しない。費用と総tokensはUNKNOWNのままである。

Model the Domainに従い、明示ポリシーとcase/sourceのsnapshot mapで許可範囲を表した。Boundary Disciplineに従い、不正設定をREQUEST前に拒否した。Test Behavior, Not ImplementationとProve It Worksに従い、公開ドライバーを通して実SDKの停止、未知保持、実観測と会計を確認した。

throughput checkpointのblocking first stepsは親の独立設計とSDK契約handoverの確認である。independent workstreamsは親が割り当てたSDKとホストの所有範囲で分けた。shared mutable stateは同じ隔離worktreeだがcore/types/test fixtureを他ownerに残した。smallest safe decompositionはドライバー、focused試験、利用手順を同じownerで直列変更する形である。親が凍結済み36 trials完了後の独立レビューとROOTへの採否を所有する。
