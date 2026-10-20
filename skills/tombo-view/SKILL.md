---
name: tombo-view
description: 開発や通常の会話で、AI自身の理解を証拠・反例・訂正・人の回答で更新し、進む・調べる・尋ねる・問い直す・止まるを選ぶ。根拠の確認、未確認の前提や矛盾の検討、継続中の理解の見直しに使う。
---

# TOMBO

自分が何を理解し、何を支えられていないかに持続的に関心を向ける。質問を増やすことを目的にせず、実タスクの目的と成功条件に照らして、根拠、不足、反例、見落としを検討する。自信や振り返りの文章を証拠の代わりにしない。

## 起動と継続

明示の `$tombo-view` に加え、根拠や前提の確認が必要な開発・会話タスクで通常のskill選択を受けられる。選択はホストに依存する。一度起動したタスクでは、関連する新証拠、反例、人の回答、訂正や追補を受けたら理解を更新する。変化のない発言ごとに再考や質問を儀式的に繰り返さない。別タスクへの自動継承、常駐hook、全メッセージの傍受は保証しない。

この会話のAIが実際の目的、回答案・操作予定、取得資料から入力と提案を作り、SDKで参照・状態更新を検証する。利用者にJSONやアダプタの手作業を求めない。対象が会話にあればそれを使う。固定fixtureを実タスクの検証へ流用しない。

## 理解から行動を選ぶ

- **proceed**：必要な根拠と現在の理解への再考が揃えば、承認された作業を進める。任意の未知だけで不要な質問を増やさない。
- **check**：環境や資料から調べられる不足には、許可された読取り・検索・試験を行う。実行前に支持・反証・不明となる条件を置く。
- **ask**：目的、優先順位、価値、権限など人だけが決められる条件を尋ね、回答がどの行動条件を変えるかを伝える。希望や許可の回答を外的事実の証明に広げない。未指定の重要な優先順位で選択が逆転するなら、人判断のgapを作り短く質問する。用途の一般論や制約がないことから本人の好みを作らない。優先順位が明示されているか、その比較判断を明示的に委任され、選択に十分なら再質問しない。
- **reframe**：反例や条件不足に応じて問い、説明、実行案を修正する。元の因果説明の不十分さは、別原因や寄与量の確定ではない。支持は観測された条件差に限定し、代替説明は仮説に残す。未知や反例を新たな確信へ置換しない。新資料・言い換え・提案変更だけなら同session/taskを更新する。利用者が目的・成功条件を実際に変えた場合だけ、旧理解・会計を残すtransitionを使う。
- **blocked**：必須確認が実行不能、予算切れ、進展なしの場合は、未解決事項と再開条件を示す。

結論を左右する引用が、どの命題・条件範囲を支え、どの仮定や結果を測っていないかを読む。許可資料の全記載が真でも結論が偽となる条件が残るなら、その範囲を仮説・不足・条件付き説明に残す。一般知識による推論も、資料IDを添えただけでは確認済みにならない。以前の支持が本文を超えていたら、limitationsへ書くだけでなくassessmentCorrectionsで実評価を訂正し、必要なgapと最終説明へ反映する。

これはホスト側の行動である。SDKの `needs_reflection` は現在の理解を再考する要求で、機械的にreframeと同一視しない。現在の全claimと証拠を検討し、候補はlenses・gaps・probesだけとして提案する。批判を証拠や解決へ変換しない。新情報で理解が変われば古い再考は流用しない。再考の完了も盲点の網羅を証明しない。過去の時点・版に対するsupportedを現在の結論へ混ぜない。

## 管理sessionで続ける

初回・追補・再開には [会話内の実行手順](references/host-session.md) を読む。深いAPI探索や準備より先に、利用者の作業全体の期限と開始根拠を扱う。hostから原開始・期限を得られなければ実toolの初回時計観測を記録し、それ以前の範囲は不明とする。SDKの遅い開始で準備時間を計上したことにしない。許可されたtaskの固定作業領域をcwdとし、読んでいるskillの `scripts/session.mjs` を絶対パスで呼ぶ。skill配置先を作業領域にしない。保存許可に従い、入力・提案・receipt・reportとSDK ledger/cacheは固定cwdの `.session/` 内へ同居できる。保存のためにcdでcwdを変えたり、許可外へ書いたり、旧SDK経路へ迂回したりしない。まずstatusで既存sessionを確認し、初回だけactivateし、利用可能なtask clockを同時に固定する。以後は同じsession/task/ledgerを使い、readyでもbindingを解除しない。runtime不足は説明し、勝手なインストールや新API接続で補わない。

AIが実タスクから `reflectionRequired: true` の入力と提案を作る。初回のprepare → inspect、同sessionへのreceiveと実観測を用いたprepare → update、現在の理解へのprepare → reflectを判定に応じて使い、reportで確かめる。prepareのinstructionsと実型定義に従い、bindingをそのまま使う。利用者へJSONやアダプタ作成を求めない。

same-goalの追補・人回答・反例はreceiveで必要最小限を保存し、適切なprobeの実観測をupdateする。受領済み・receipt applied・新claim supportedだけでは既存gapの解決にならない。何を待っていたclaim/gapかを読み、十分な根拠があるassessmentとresolutionを対応させる。人判断のgapは実回答で判定できる命題と回答用probeへ結び付ける。回答が曖昧ならgapを残し、既回答を繰り返さず残る条件だけ確認する。意味のある理解変更後は、許可・予算・評価待ちが許す範囲でneeds_user_inputでも現在の理解を再考してから結論を述べる。未完でも条件付きで役立つ提案はできるが、確定やSDK完了と称さない。

新probeが必要ならreflectで新gap/probeの組を先に用意し、既存gapへのprobeだけの後付けや既存IDの上書きをしない。本人の希望、引用した資料の語句、AIの推論・仮定、未測定の結果を区別する。実回答はuser_statement観測として扱い、reflectの文章へ書くだけで取込み済みとしない。誤読はassessmentCorrections、実際の資料更新・撤回はmanaged invalidateを使い、本物の反証と旧履歴を保持する。破棄した未評価観測や期限後の未適用撤回を評価済みへ昇格させない。

SDKの初期有限予算は検査・提案生成・人回答待ち・再考・追補に見合う値を選ぶ。ただしmaxElapsedMsは初回inspectからの区間であり、準備を含む作業全体の期限とは別である。全体の時計ではfollow-up・人待ち・取消・再開を除外しない。同じgoalでtask/ledger/budget/startedAt/usageや封印したtask clock、停止・証拠・理解を作り直さない。同goalの予算・期限を延長するAPIはなく、利用者の追加指示だけで評価再開できると案内しない。期限後は実停止を保持し、receiveへ未評価の追補を残す。新TaskPacket、新ledger、新予算で結果を成立させない。古いreadyは旧理解のsnapshotであり、新追補まで検証済みではない。state.decisionだけでなくeffectiveDecision、pendingUpdates、budgetCheckpoint、taskClockStatus/sessionStopReason、understandingStatusを読む。全体期限による停止をSDKのbudget_exhaustedへ偽装しない。初回検査前の期限切れならstateはnullのままである。understandingStatus.canReportCompletionはSDKの今回の段階を完了と記述できるかであり、意味の正しさ・操作許可・利用者のgoal全体の完了とは分ける。

SDK ledgerが理解・usage・停止の正本、sessionイベントがidentity・未評価追補・遷移の正本である。再開も同じ作業領域からstatusを使い、cache欠落やredacted replayを新規開始・再検証成功に読み替えない。正当なtransitionでも旧未知と実会計を残し、新task予算を旧taskの継続や上限回避として扱わない。

保証は保持されたbindingを使うhelperの通常経路と呼出し境界に限る。期限到来時のhost処理の即時中断は保証しない。別workspace、記録削除、SDK/CLI直利用まで統制するOS sandboxではない。低levelの未管理操作は互換用であり、管理session継続の代替にしない。常駐hookや全メッセージ傍受も保証しない。

利用者には確認事項、理解の変更、重要な未知、次の行動を簡潔に伝える。実検査不能・検索結果なし・自己採点でgapを閉じず、反証された元の説明を再利用しない。過去のsupportedを現在の結論へ混ぜない。適用範囲の診断は確認や訂正に使い、証拠validityや停止判定へ直結させない。SDKのreadyや構造検証は意味の正しさを保証しない。会話側の費用・総tokenはunknown。helperは追加LLM APIを呼ばず、SDKのモデル回数はローカル提案適用を数える。会話全体の時間・生成量・金額を制御したとは主張しない。

## 任意のHidden-Side

点検モードは `standard`（既存の多視点観測）、`hidden-side`（任意の検索順位比較）、`combined`（両方）として扱う。指定がなければ後方互換の `standard` を使う。Hidden-Sideは検索機能を置き換えず、主張や証拠の状態を直接変更しない。

`hidden-side` / `combined` は、呼出し元から同一の許可済みEmbeddingモデルが使え、点検対象を含む検索候補群と出典ロケータが与えられる場合だけ実行する。組込みEmbeddingモデル、ベクトルDB、追加API接続はない。モデル、候補群、費用や権限が不明なら補って呼び出さず、`hidden-side unavailable` としてstandardを続ける。CrossRAGの方式をTOMBOの実装や性能証拠として扱わない。

SDKの `compareHiddenSideMethods` へ、コンテキスト各項目・現在の視点・候補文の同一モデルベクトルを渡す。Similarity、Orthogonal、Reflected View、seedを固定したRandom Baselineの順位を比較する。結果は検索順位の観測で、`verification_status: unverified`、解釈は `null` のままにする。Reflected / Orthogonalで新しく上位に入った候補は、standardの別観点として独立の出典検索・コード読取り・テストなどで確認する。候補やスコアだけでclaim、evidence、resolutionを作らない。数学的定義、出力と限界は [Hidden-Side Observation](references/hidden-side-observation.md) に従う。

最小の固定例は `npm run hidden-side-demo` で実行できる。ローカル文字n-gram特徴ベクトルによる28件の架空候補比較であり、意味Embeddingの検索結果や有効性の証明ではない。Wedgeは未実装である。

幾何学的解釈の注意: 単位視点 `v`、`p = P(v)`、`r = v - p` で `cos(r, v) = ||r||`、`cos(p - r, v) = 2||p||² - 1`。射影ノルムが `1/√2` 未満なら、Reflected Viewは現在の視点と逆向きになる（2026-10-16の1回の実Embedding実行では射影ノルム0.437、反射cosine約-0.62）。Reflected候補は「類似度が低い候補」であり、発見ではない。順位が低いことは根拠にならず、候補は未検証のprobe/視点候補として既存の証拠確認へ渡すだけにする。この実行は1回・合成コーパス・人手の関連性評価なしで、有効性や一般化の証拠ではない。詳細は [Hidden-Side Observation](references/hidden-side-observation.md) を参照する。TOMBOの純粋なOrthogonal（射影残差のcosine）とCrossRAGの混合Orthogonalスコアは同等でなく、比較しない。TOMBOの候補は単一句であり順序付きペアではないため、Wedgeは未実装のままである。

Geometry guard (English): for unit `v`, `p = P(v)`, `r = v - p`, `cos(r, v) = ||r||` and `cos(p - r, v) = 2||p||² - 1`. When the projection norm is below `1/√2`, Reflected View points opposite the current viewpoint (in the single live embedding run on 2026-10-16: projection norm 0.437, reflected cosine about -0.62). Reflected candidates are low-similarity candidates, not discoveries; low rank is not evidence. Pass them only as unverified probe/viewpoint suggestions into the existing evidence check. That run was one run on a synthetic corpus with no human relevance ratings, so it is not evidence of effectiveness or generalisation. See [Hidden-Side Observation](references/hidden-side-observation.md). TOMBO's pure Orthogonal (projection-residual cosine) and CrossRAG's blended Orthogonal score are not equivalent and must not be compared. TOMBO candidates are single phrases, not ordered pairs, so Wedge remains unimplemented.
