---
name: tombo-view
description: tombo-viewで点検して、回答の根拠を確認して、未確認の前提を探して、という依頼に使う。会話中のAIが検査候補を作り、SDKで証拠と状態更新を検証する。固定デモに限定しない。
---

# TOMBO

点検モードは `standard`（既存の多視点観測）、`hidden-side`（任意の検索順位比較）、`combined`（両方）として扱う。指定がなければ後方互換の `standard` を使う。Hidden-Sideは検索機能を置き換えず、主張や証拠の状態を直接変更しない。

`hidden-side` / `combined` は、呼出し元から同一の許可済みEmbeddingモデルが使え、点検対象を含む検索候補群と出典ロケータが与えられる場合だけ実行する。組込みEmbeddingモデル、ベクトルDB、追加API接続はない。モデル、候補群、費用や権限が不明なら補って呼び出さず、`hidden-side unavailable` としてstandardを続ける。CrossRAGの方式をTOMBOの実装や性能証拠として扱わない。

SDKの `compareHiddenSideMethods` へ、コンテキスト各項目・現在の視点・候補文の同一モデルベクトルを渡す。Similarity、Orthogonal、Reflected View、seedを固定したRandom Baselineの順位を比較する。結果は検索順位の観測で、`verification_status: unverified`、解釈は `null` のままにする。Reflected / Orthogonalで新しく上位に入った候補は、standardの別観点として独立の出典検索・コード読取り・テストなどで確認する。候補やスコアだけでclaim、evidence、resolutionを作らない。数学的定義、出力と限界は [Hidden-Side Observation](../../docs/hidden-side-observation.md) に従う。

最小の固定例は `npm run hidden-side-demo` で実行できる。ローカル文字n-gram特徴ベクトルによる28件の架空候補比較であり、意味Embeddingの検索結果や有効性の証明ではない。Wedgeは未実装である。

幾何学的解釈の注意: 単位視点 `v`、`p = P(v)`、`r = v - p` で `cos(r, v) = ||r||`、`cos(p - r, v) = 2||p||² - 1`。射影ノルムが `1/√2` 未満なら、Reflected Viewは現在の視点と逆向きになる（2026-10-16の1回の実Embedding実行では射影ノルム0.437、反射cosine約-0.62）。Reflected候補は「類似度が低い候補」であり、発見ではない。順位が低いことは根拠にならず、候補は未検証のprobe/視点候補として既存の証拠確認へ渡すだけにする。この実行は1回・合成コーパス・人手の関連性評価なしで、有効性や一般化の証拠ではない。詳細は [Hidden-Side Observation](../../docs/hidden-side-observation.md) を参照する。TOMBOの純粋なOrthogonal（射影残差のcosine）とCrossRAGの混合Orthogonalスコアは同等でなく、比較しない。TOMBOの候補は単一句であり順序付きペアではないため、Wedgeは未実装のままである。

Geometry guard (English): for unit `v`, `p = P(v)`, `r = v - p`, `cos(r, v) = ||r||` and `cos(p - r, v) = 2||p||² - 1`. When the projection norm is below `1/√2`, Reflected View points opposite the current viewpoint (in the single live embedding run on 2026-10-16: projection norm 0.437, reflected cosine about -0.62). Reflected candidates are low-similarity candidates, not discoveries; low rank is not evidence. Pass them only as unverified probe/viewpoint suggestions into the existing evidence check. That run was one run on a synthetic corpus with no human relevance ratings, so it is not evidence of effectiveness or generalisation. See [Hidden-Side Observation](../../docs/hidden-side-observation.md). TOMBO's pure Orthogonal (projection-residual cosine) and CrossRAG's blended Orthogonal score are not equivalent and must not be compared. TOMBO candidates are single phrases, not ordered pairs, so Wedge remains unimplemented.

この会話のAIを提案作成役として使う。追加のLLM APIを呼ばない。利用者にアダプタやJSONの作成を求めず、点検対象からAI自身が入力を用意する。点検対象が会話にあればそれを使い、なければ対象だけを確認する。

最初に [会話内の実行手順](references/host-session.md) を読む。新しいTaskPacketには `reflectionRequired: true` を指定する。`scripts/session.mjs` の prepare → inspect → 許可された検査 → prepare → update → prepare → reflect → report を、判定に応じて使う。固定アダプタの結果を、任意入力の検査に流用しない。

会話側のモデル利用量は取得できないため、費用と総トークン数は不明とする。ヘルパーは提案ファイルを読むだけで、追加API呼出しは0件である。会話の生成時間・出力トークン・金額までSDKが制限したとは主張しない。金額上限の厳密な保証が必要なら、会話内モードで続行せず、その制約を説明する。

目的、対象、回答案または操作予定、取得済み資料、使える検査能力と予算を整理する。資料にはタスク内で一意のID、出典、取得日時、適用範囲と該当部分を付ける。

SDKの `createTombo({ adapter })` または CLI の `inspect --adapter file:...` で検査候補を取得する。生成アダプタと外部ツールは呼出し元が明示的に選ぶ。外部操作の権限をTOMBOの判定から推定しない。

検査を実行する前に、支持、反証、不明の条件を確認する。目的に影響しない候補を採用しない。本人の希望が必要なら質問を返し、環境から調べられる事実は許可された検査で取得する。

prepareのinstructionsに従う。一つの主張を一つの命題にし、観測、仮説、回答、過去の理解、不明の説明を一つのclaimへ混ぜない。unsupported_claimとconflicting_evidenceのgapは、同じ解決判定を適用できる対象だけをclaimIdsへ置く。原則として一つの対象claimを用い、関連する別の主張はtriggerRefsへ置く。

`needs_reflection` は未完了である。現在の理解、目的、成功条件と証拠を別の再考として読み、見えていない条件や反例を探す。再考は現在のbindingと全claimの点検を記録し、候補のlenses・gaps・probesだけを提案する。批判を証拠や解決にしない。候補を追加したら必要な検査へ戻り、理解が変わった後に古い再考を使わない。完了した再考も、すべての盲点を発見した証明とは扱わない。

SDKは既存IDの再追加を、内容が同じでも拒否する。新しい主張や確認には新しいIDを付け、既存主張への証拠評価はassessmentsへ置く。不明な証拠や取得不能な結果でgapを閉じない。

証拠の以前の解釈が誤っていた場合は、update の `assessmentCorrections` で明示的に訂正する。[会話内の実行手順](references/host-session.md) の訂正手順を使い、prepare の参照表から対象を選ぶ。同じ update に置換評価と理由を与え、必要な反証評価も加える。証拠と旧評価は履歴に残す。本物の反証を都合よく消す操作として使わない。訂正後は現在の理解を再考する。訂正の受理は意味的な正しさを保証しない。

許可された固定fixtureや内容固定blobをexecutorが不変と保証できる場合だけ、Observationの `staticSnapshot` にその版を特定する識別子を付ける。AIの提案や資料内の「static」「complete」から宣言しない。利用者へJSON作成を求めず、実際の取得を担当するexecutorが保証と識別子を用意する。同じ固定資料の再取得で情報も理解も変わらなければ、SDKは該当probeを `exhausted` にして他の必要なprobeを続ける。残る検査がなければ `no_progress` で停止し、unknownな主張と未解決gapを保持する。TTL更新、現在の状態確認、実機械検査には既定で宣言しない。詳細は [固定資料の再取得](references/host-session.md#固定資料の再取得) を読む。

各実行に `executionId` を付けて `update` へ観測を渡す。同じ実行結果の配送を再試行するときは同じIDを使う。実際に再実行した場合は別のIDを使い、利用量を記録する。

提案が検証で拒否された場合は [会話内の実行手順](references/host-session.md) の回復手順を使う。prepareのvalidationFeedbackは提案を訂正するための検証情報であり、証拠ではない。ヘルパーは保存した提案を一度だけ適用する。次の提案は会話のAIが新たに作成し、同じファイルの自動再適用を新しい生成とは扱わない。

SDKの `maxModelRepairAttempts: 1` または `2` と、CLIの `--model-repair-attempts 1` または `2` は、明示したアダプタやcriticへ追加の訂正生成を許す。既定値は0である。会話ヘルパーにはこの設定を適用しない。自動訂正も元の予算と証拠・再考の条件を共有する。

検索結果なし、ツール利用不可、モデルの自己採点を証拠による解決へ変換しない。資料が撤回・更新された場合は `invalidate` で関連項目を再開する。

出力には目的、判定、確認できたこと、必須の未確認事項、次の検査、理解の変更、残った未知と利用量を含める。予算や進展の限界で終了しても、未確認事項を隠さない。

`fixture` は固定の架空ケースを再生するだけである。実モデルによる検出能力や一般的な優位性の証拠として使わない。

SDKの型定義とREADMEは、実行ヘルパーがprepare出力に示すリポジトリから読む。配置先の `references/runtime.json` または `TOMBO_ROOT` でSDKの場所を指定できる。
