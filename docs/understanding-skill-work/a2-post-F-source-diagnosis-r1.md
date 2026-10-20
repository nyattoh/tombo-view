◤◢◤◢◤◢◤◢ STATUS ◤◢◤◢◤◢◤◢

受入2には、receiptの実受領時刻をhelper側で記録する修正と、更新・gap解決・再考・最終回答を接続する修正が必要です。SDKがreadyを強制する変更は根拠がありません。

📝 SUMMARY

- 指定文書・4 trace・現在ソースを確認し、manifest全16ファイル（新規7を含む）のhash一致を確認しました。
- F01は継続会計を保持しましたが、caller時刻を実受領時刻として保存する欠陥が残っています。
- F03は永続化成功と、未完の再考・意味的過剰断定が併存しています。
- 以下はsource designerの診断・提案です。独立review/PASSではなく、書込み・試験・モデル呼出し・子task作成はしていません。

💻 DETAILS

**1. F01：時刻の責務が実装と文書で混在しています〔観測〕**

現行 `receive()` は `source.receivedAt` の日時としての解析可能性だけを検査し、caller値をそのままpayloadと履歴へ保存します。helperによる受領時刻の生成・照合はありません。一方、手順は同フィールドを「初回の実受領時刻」と説明しています。[session-store.mjs:286](../../skills/tombo-view/scripts/session-store.mjs#L286)、[host-session.md:77](../../skills/tombo-view/references/host-session.md#L77)

F01 trace position 52では、モデルが `2026-10-21T00:58:34.000Z` を文字列で設定し、position 53でreceiveしました。公開時刻は `2026-10-21T00:58:30+09:00`、すなわちUTCではOct20 15:58台です。9時間ずれた値が保存されています。[receipt-clock-finding.json:5](a2-forward-F01-s2-receipt-clock-finding.json#L5)

したがって現状は、**実装上はcaller申告のprovenance、文書上は実受領時刻であり、両者を区別できていません。** この時刻はbudgetの正本ではないため、継続会計の保持とは別の欠陥です。

**最小の互換修正〔提案〕**

- 保存receiptへ、helperが初回受理時に生成する `helperReceivedAt` を加える。
- `source.receivedAt` は変更せず、「caller申告時刻」と明記する。helper実受領・資料公開・Evidence.retrievedAtと同一視しない。
- 新フィールドはcaller入力として受け付けない。payload検証・衝突検査後、session lock内で生成し、既存appendで保存する。
- これはhelperが受理した時刻であり、hostへのメッセージ到着時刻や資料公開時刻を保証しない。

既存入力とpayloadHash算定は維持します。helper時刻をpayloadHashへ混ぜません。

再配送・移行契約は次のとおりです。

- 同ID・同payload：最初のreceiptを返し、helper時刻を更新しない。
- 同ID・異payload：従来どおり衝突。caller時刻だけの変更も異payload。
- replay/cache復元：保存されたhelper時刻を保持。
- 旧receipt：新フィールド欠落を許容し、helper実受領時刻はunknownと表示。loadや再配送時の現在時刻で埋めない。
- 旧F記録・過去hash・停止・usageは変更しない。
- 内部receiptの既存修正は維持する。`retainExpiredObservations`／`pendingInvalidation` が初回の実時刻を保持し、再配送で再生成しない性質を壊さない。[session.mjs:166](../../skills/tombo-view/scripts/session.mjs#L166)

未来時刻だけの拒否や9時間補正では、もっともらしい誤時刻を防げません。provenanceを保存し、helper計測を別に持つ案を推奨します。

**2. F03：四つの問題を分ける必要があります〔観測〕**

**(a) SDK lifecycleと操作順序**

stage2はhelperでrevision 2をcommit済みです。stage3もmanaged invalidate→receive→updateでrevision 4へ進み、session/head/cacheが一致しています。途中の直接SDK・in-memory計算だけを終端結果として扱うのは誤りです。[s2-managed-readback.json:20](a2-forward-F03-s2-managed-readback.json#L20)、[s3-authority-readback.json:24](a2-forward-F03-s3-authority-readback.json#L24)

しかし、stage2・3の実proposalはともに `resolutions: []`。元gapの対象claim `claim-direction-depends-on-user-priority` に評価を追加せず、別claimだけを支持しています。対応するhelper updateの後はreport/statusへ進み、helper reflectはありません。[F03 trace position 85](a2-forward-F-final-trace-F03-stages1-3.json#L1497)、[position 107](a2-forward-F-final-trace-F03-stages1-3.json#L1872)

SDKは別claimの支持からgap解決を推定しません。required gapが残ればneeds_user_inputを返し、gapがなくなった場合に現在のreflectionを要求します。これ自体は妥当です。[core.ts:119](../../src/core.ts#L119)、[core.ts:293](../../src/core.ts#L293)

`reflectionEffects`欠落だけでは一般に未再考と断定できません。今回の根拠は、実traceにhelper reflectがなく、現在の再考receiptも成立していないことです。鮮度はtask・hash・claim coverageで判断します。[core.ts:72](../../src/core.ts#L72)

**(b) Hostによるgap解決・再考の選択**

初期gapは、人の回答で判定する具体命題ではなく「選択は優先順位による」という一般的な方針claimへ結び付いています。後続回答を別scopeの新claimへ記録しても、そのgapは解決されません。

またstage2の回答は「出費を抑えたいが長く使えるかも気になる」であり、優先順位を一つに確定していません。gapを残し、残るtrade-offを尋ねることは妥当です。自動解決やready強制は不適切です。

観測された未完の経路は、**追加claimの保存で作業を終え、元gapとの関係と再考を処理しなかったこと**です。モデル内部でそうした理由まではtraceから確定できません。

**(c) 誤った意味評価**

stage3は、新見積もりだけを根拠に「唯一の実現可能な方針」というanswer_claimをsupportsにしています。stage2にも、ユーザーの「長く使えそう」を「長期使用（保証）」へ読み替えた評価があります。

見積もりは価格・日数・保証期間を示しますが、故障しにくさ、保証の救済内容、確実な到着、他の手段の不存在までは示しません。[laptop-quotes.md:5](../../results/understanding-acceptance2/observers/F03/scratch/laptop-quotes.md#L5)、[correction.md:3](../../results/understanding-acceptance2/observers/F03/scratch/laptop-quote-correction.md#L3)

SDKはassessmentの参照・validity・scope等を検査しますが、文章の意味的含意を証明しません。[core.ts:103](../../src/core.ts#L103)

**(d) 最終回答と保存状態の不一致**

stage3最終文は「一択」「確実に届く」「故障リスクを最小限」と述べます。一方、保存stateはrequired gap open、needs_user_input、stopReason nullです。[F03 trace position 112](a2-forward-F-final-trace-F03-stages1-3.json#L1957)

現行文書には更新後のfresh reflect指示があります。しかし手順が分散し、receipt applied、claim supported、gap resolved、再考済み、task完了の違いを、実行結果から次の行動へ結び付ける説明が不足しています。指示の存在だけでは今回の行動を誘導できませんでした。[host-session.md:95](../../skills/tombo-view/references/host-session.md#L95)

**3. F03への最小設計〔提案〕**

SDK policy/schema、証拠validity、解決条件は変更しません。新しいfinalize workflowも不要です。

helperの既存JSON/reportへ、stateから再導出する小さな `understandingStatus` を加えます。

- 未解決required gapのID
- reflectionが不要／欠落／失効／完了／不明のどれか
- 現在のeffectiveDecision・pending状態から、SDK上の完了を報告できるか

診断をbinding/requestHashや理解stateへ混ぜず、gapを閉じたり操作を禁止したりしません。**機械的に保証できるのは診断と保存状態の整合であり、hostの自由文を真実にすることではありません。**

skillとhelper prepareの近接したinstructionsは、次の判断へ短く接続します。

- 回答を受けたら、新claimの追加だけでなく、関連する既存claim/gapが何を待っていたか確認する。
- 十分な根拠がある場合だけ、対応するassessmentとresolutionを提案する。
- 回答が不足なら、既回答を繰り返し尋ねず、残る条件だけを確認する。
- 重要な理解変更後に結論を出す前は、予算と評価待ちを確認し、現在の理解を再考する。needs_reflection表示が出るまで待つだけにしない。
- 未解決状態でも条件付き提案は可能。ただし確定・再考完了・SDK完了と称さない。
- 資料記載、本人の希望、AIの推論・仮定を分け、推論が必要とする追加条件を確認する。

特定商品・保証・納期の語を検出する規則は加えません。既存F03の不適切なgapを自動付替えするAPIも追加しません。

**4. 変更所有範囲・RED・独立評価〔提案〕**

既存担当の所有権で、以下に限定します。

- runtime担当：`session-store.mjs`のhelper受領時刻、`session.mjs`の導出診断・表示・近接instructions
- a2試験担当：`test/session-followup.test.mjs`
- skill/docs担当：`SKILL.md`、`references/host-session.md`
- READMEの結果・限界同期：fresh結果確定後に既存文書ownerが実施
- PM：設計・証拠・gate記録のみ

`src/core.ts`・`src/types.ts`の変更は現時点では不要です。

コード前の意味あるREDは以下です。

- callerの未来・過去時刻とは独立にhelper時刻が実受理区間内となる。
- 再配送、衝突、cache欠落、replay、旧receiptで時刻を捏造・更新しない。
- 既存内部receiptの初回時刻・Evidence.retrievedAt・usage非重複が維持される。
- 「receipt appliedだがrequired gap open」「gap解決後だがreflection失効」「fresh reflect後ready」を異なる診断として返す。
- optional gapだけで完了を禁止しない。診断追加でdecision・hash・usage・停止を変えない。
- 正当な人回答→解決→fresh reflectと、曖昧回答→gap維持・追加確認の双方を扱う。

意味的過剰断定を防げたかは、台本どおりの決定的試験で実証しません。fresh独立modelには改訂skillと未見の生資料だけを渡し、次を交差させます。

- 明確な選好／複数の希望が残る回答
- 記載上の約束／結果の保証／未測定の性能
- 訂正後もtrade-offが残る場合／根拠付きで解決できる場合
- 予算内の再考／期限切れ未評価保存／fresh会話再開
- 最終説明とactual state・gap・reflectionの整合

期待回答、F03の失敗、作者の推奨手順はobserverへ追加しません。

**残る設計選択**

`understandingStatus`を追加せず既存reportと文書だけで直す方が差分は小さいものの、今回もreportを読んで状態と異なる断定を出しているため、状態を短く再提示する案を推奨します。それでも意味判断と自由文の一致はhost依存です。新APIや全面的な出力拘束が必要という証拠は、現時点ではありません。

➡️ NEXT STEPS

既存PMが本診断を保存し、fresh cross-vendor design PASS後に、RED→最小実装→GREEN・回帰→未見raw再試行→fresh独立full review→gate→親監査へ進む段階です。

現在gateは未達です。F群の失敗・旧監査は保持し、費用・総tokenはunknownとします。
