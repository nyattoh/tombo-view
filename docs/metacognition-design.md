# 再考と検査実行の設計

データの正本はUnderstandingStateとする。再考はモデルの内的な認知へのアクセスではなく、既存の理解・資料・成功条件を別の呼出しで問い直す操作である。

## 選択

コア拡張案を採用する。コアが再考の鮮度と利用量、終了条件を所有し、実行ループが明示された検査能力を使う。合成生成アダプタ内にproposerとcriticを隠す案は、コアのmodelCallsと実際の呼出し数を二重管理するため採用しない。

外側の案から、criticの権限を不足・観点・検査の追加へ限定する規則を取り込む。批判は証拠ではない。批判文だけで主張を支持・反証したり、gapを解決したりしない。既存のupdateが、実観測の証拠に基づく評価を適用する。

## 人へ確認する判断

再考は、モデルの隠れた思考を読むのではなく、表明された理解を目的・成功条件・証拠と照らして見直す。AIが理解に関心を持つ価値は、未確認事項を分類し、次の検査・本人への質問・未知の保持を選ぶ観測可能な行動として定義する。盲点を全て見つける保証は設けない。

- 許可された検査能力で確認できる事実は、executorを通じて取得する。
- 本人の意図・希望・優先順位・許可で結論や行動が変わるときだけ、既存のambiguous_intent gapとuserQuestionsで尋ねる。質問には理由を添え、回答まで依存する作業を止める。
- どちらでも解けない未知は未確認のまま残す。沈黙、検査能力の不足、批判だけ、または候補が見つからないことを解決にしない。

この振り分けは既存のgapとneeds_user_input契約を使い、新しい状態や証拠の種類を追加しない。完了したreflectionは再考が実行された記録であり、網羅性や正しさの証明ではない。

## 契約

- TaskPacketにoptionalなreflectionRequiredを追加する。新しいrunUnderstandingCheckと会話内スキルはこの条件を有効にする。従来の明示的なinspect/updateは旧契約として読取り・実行互換を保ち、再考済みと読み替えない。
- 新しいdecision needs_reflectionは、既知の必須確認が解決しても現在の理解への再考が完了していない状態を示す。
- CriticAdapterは独立したreflect(input)を持つ。旧GenerationAdapterへ新operationを渡さない。入力はtask、state、taskId・basedRevision・understandingHashのbinding、出力上限。出力はbinding、reviewedClaimIds、completion、limitations、候補用proposalとusageである。
- 候補proposalに許すのはlenses・gaps・probes。assessments・resolutions・証拠の追加や既存状態の上書きを拒否する。既存gapを再開したい批判は、新しい必須gapとprobeで問い直せる。
- 再考の完了記録は、変更後の状態についてのハッシュ、点検したclaim IDs、限界を持つ。候補を追加した再考をその変更後の理解の完了記録と同時に扱わない。
- understandingHashはtask、証拠のhashとmetadata・validity、claims・lenses・gaps・probes・除外候補を対象とし、usage・revision・判定・receipt自身と本文のキャッシュ状態を除く。利用量の変更や正しい本文の再取得だけで失効させない。
- 新観測・証拠撤回・候補追加が理解を変えれば、以前の完了記録は失効する。同じ実行の再配送だけでは理解や会計を変えない。
- proposedAnswerがあるのに検査対象の主張がない場合は、空の再考結果だけでreadyとしない。網羅性一般の保証ではなく、無処理の完了を防ぐ。
- 再考にも生成回数・時間・入力・出力・金額の既存会計規則を適用する。失敗を無償の呼出しとせず、不明の金額を0へ変換しない。

## 互換性と実行

追加フィールドはparse時に既定値を挿入しない。旧journalの保存shapeとhashを保つ。新しいコア操作が新revisionを返し、FileJournalの入力正本照合とcommitを使う。

runUnderstandingCheckはinspect、必要なreflection、nextProbeIdsに対応する明示executor、updateを予算内で実行する。実行IDは実際の検査ごとに生成し、外部ツールの結果だけをObservationにする。利用不可や検査なしを成功した証拠にしない。中断と例外、再実行と再配送を区別する。

実行ループの返却は `{status:'completed', result:InspectionResult}` と `{status:'stopped', reason:string, result:InspectionResult|null}` のunionとする。開始前の中断は状態を捏造せずnullを返す。ループの停止条件と理解状態を分け、停止したループが状態を書き換えて完了を装わない。実行完了はcompletedとコアのreadyが両方成立した場合だけである。

外部検査を実行した後の中断や例外は、測った経過時間と実際の呼出しを `update(state, observations, {deferAssessment:true})` で記録する。この経路はモデル評価を実行せずassessment_pendingとして観測バッチを保持する。生成を止めるための架空の経過時間や証拠を作らない。

比較の共通呼出し上限はモデルと検査を合わせて6回とする。初期候補・再考・検査・更新・最終再考の5回を許し、両条件へ同じ上限を与える。これは実モデル結果を見る前の設計に基づく設定である。

型、公開操作、実行ループとホスト用reflection envelopeの結び付きを、製品コードより先に受入テストへ表す。回答の訂正は現在の主張への反証と必要な新しい主張・未確認事項として表し、証拠なしの言い換えを正しい回答へ昇格させない。
