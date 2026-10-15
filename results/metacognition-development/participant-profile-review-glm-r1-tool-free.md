## 判定

**PASS（P1：該当なし、P2：1件 needs_review）**

供給資料のみで点検。ツール・shell・ファイル操作は不使用（指示どおり）。初回レビューのため過去指摘との照合項目はなし。

## 点検結果

### P1（重大な整合欠陥）：該当なし

### P2-1：test 3 と live protocol の結合 — **needs_review**

`test/host-trial-profile.test.mjs` の「legacy protocol retains medium」試験は、`profileTrial(undefined, 'medium')` で **live の `evaluation/metacognition-protocol.json` を無改変でコピー** している。すなわち「live protocol に `participantModel` が存在しない」ことを暗黙の前提としている。

一方 `next-protocol-draft.json` は `participantModel: low` を含み、凍結後に live protocol へ置き換える計画（`freezeStatus: DRAFT ... participant trials not started`）である。凍結時点で test 3 は次の理由で失敗する見込み：

- コピーした protocol が `participantModel: low` を含むため driver は low を選択
- `replyEffort: 'medium'` の応答は `invalid_host_binding` で拒否され `run.status: 'error'`
- `run.model` の期待値 `{ ..., effort: 'medium' }` と不整合

現時点の実行には影響しないが、表明された次段階（DRAFTの凍結）で確定的に壊れる。凍結作業の際に test 3 を固定した legacy protocol fixture に差し替えるか、期待値を更新する必要がある。これは計画された将来変更との統合上の実在する結合であり、現状欠陥ではないため needs_review とした。

## 個別主張の検証

| 項目 | 判定 | 根拠 |
|---|---|---|
| `participantModel` 境界検証（undefined→legacy medium、invalid→生成前 reject） | pass | `RunSchema.shape.model.parse` は frozen check より前、request 保存・trace 書込みより前に実行。`null`・effort 欠落・空文字 provider・`extra` key の4種はいずれも strict・非空 string 制約で ZodError、REQUEST 出力なし・終了コード 1・run null という test 4 の期待と経路整合 |
| 返答 profile 照合 | pass | `safeParse(reply.model)` + `digest(metadata.data) !== digest(model)`。不一致は `invalid_host_binding`（`invalid_input`）で、baseline 修復ループの `error.code !== 'invalid_model_output'` 分岐で再送出 → 外部 catch → status error。test 2 の `modelCalls: 1`（`reserve()`・`modelCalls++` は検証前に実行済み）・`uncertainties: ['invalid_host_binding']` と整合。修復予算を消費しない設計は bridge 誤結合をモデル構文誤りと区別する意図と整合 |
| trace / run / profile 同一 | pass | 単一の `model` 参照が trace 初期化と `RunSchema.parse({... model ...})` の双方に使用。両側とも同一 schema で parse されるため鍵順は shape 順に正規化され、protocol 側と reply 側で JSON 項目順が異なっても digest 比較が偽拒否しない |
| fixture bridge の4試験 | pass | test 1（low 受付・run/trace へ low 永続化・`requests.length: 1`：baseline が1回の finish で完了）、test 2（medium 不一致拒否）、test 3（undefined→medium 受付）、test 4（4無効設定の事前拒否）の全期待値が供給 driver コードの制御フローと整合。`origin: 'fixture'` で taskId が `fixture` 先頭でも real-model 検査にかからない点も整合 |
| RED 1pass/3fail → GREEN 4pass、関連2tests pass | 記述整合、実行は未検証 | 修正前（medium 固定）なら test 1 は low 応答不一致で error、test 2 は medium 応答が受理され success、test 4 は participantModel を無視して終了コード 0 — handover の RED 記述と整合。実行結果自体は親の報告を信頼するのみ |
| DRAFT protocol 整合 | pass | 未固定の DRAFT は `frozenBeforeResults: false` のため driver の frozen check で実行拒否（未固定・未実行の表明と整合）。thresholds・repeats・caps・repair2・両方式 low 指定は draft の `boundary` 文と整合 |
| effort 単独効果の非主張・費用 UNKNOWN | pass | draft boundary 文が「Different cases and profile prevent attributing differences to effort alone」「speed, cost and effectiveness unproven」を明記。driver の `observed` は inputTokens/outputTokens/cost とも `'UNKNOWN'`。静的レビュー（profile 境界と永続化）と実モデル効果の区別は handover「検証範囲」で明示 |

## 検証限界（欠陥ではない）

- ツール禁止のため、試験実行・`RunSchema` の実定義・live protocol の現行内容（`participantModel` 不在・frozen true）は供給文書・handover・test 期待値からの推定であり、直接は確認していない。
- 以上の限界内で、実在整合欠陥は P2-1 のみ。
