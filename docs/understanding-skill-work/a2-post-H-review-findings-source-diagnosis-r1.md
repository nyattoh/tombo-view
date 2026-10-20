**◤◢◤◢◤◢◤◢ STATUS ◤◢◤◢◤◢◤◢**

F1の診断欠落は確認できました。F2は保護すべき不変条件、F3は実在する契約上の制約です。最小の修正候補は、**自動再試行を増やさず、実際の拒否診断を保存して次のprepareへ渡す仕組み**です。実装・受入の承認ではありません。

**📝 SUMMARY**

- 指定brief、review本文・result、信頼性readback、前回診断、charter・amendmentを読み、現ソースとA3/A4の実記録を照合しました。
- 現16ファイルはfreezeと **16/16一致**。patch hashも指定値と一致しました。reviewのhash表は0/16一致であり、そのsubset PASSを採用する根拠にはできません。
- 書込み・試験・helper実行・モデル/API・子task作成は行っていません。費用・tokenはunknownです。

**💻 DETAILS**

**F1：診断欠落は確認。ただし因果説明と修正方法に訂正が必要**

現SDKの`maxModelRepairAttempts`既定値は0です。`propose`は0の場合、診断追加前に例外を再送出します。update／reflectは停止状態を返しますが、その経路で拒否messageが保存されません。helperのprepareは既存`modelRepairDiagnostics`を条件付きで渡すだけなので、失われた理由を復元できません。[既定値](../../src/core.ts#L477)、[拒否処理](../../src/core.ts#L547)、[prepare](../../skills/tombo-view/scripts/session.mjs#L110)

reviewには次の誤記があります。

- 正のrepair設定では、**最後の拒否も記録してから停止**します。「最終attemptだから記録されない」という説明は不正確です。
- 既定0のinspectは、update／reflectと同じ停止結果返却ではなく例外を投げます。既存試験もこの違いを要求しています。[試験](../../test/cli-model-repair.test.mjs#L43)
- 現ソースにreview記載の`prepareRequest`はありません。

A4の実記録では、stage3拒否はrev7/calls6、再送rev8/calls7、登録終了rev10/calls9。r4では拒否rev11/calls10、再送rev12/calls11、reflection rev13/calls12、report後head rev14です。repair contextに新しい`validationFeedback`はありません。position52の実コード参照、position53の旧二resolution除去も確認できます。[実trace](a2-H01-A4-actual-user-r4-full-thread-trace-r1.json#L932)

ただし、**診断欠落がその選択を引き起こした／診断があれば成功した**とは証明できません。またstage3で除去された`preparation-gap`の`not_applicable`も、新証拠と対象claimのscopeが異なり、「有効だったresolution」とは扱えません。

現在の実エラー文字列から直接伝えられるのは、例えば**最初に拒否されたgap ID**です。全不成立箇所や意味的理由が得られるわけではありません。そのgapのclaim対応・scope・pending証拠は保存状態から確認できます。拒否されたassessmentは適用されないため、既存のstate由来scope診断だけで候補全体を診断したとは言えません。

**F2：観測・使用量保持は意図された契約。discard案は採用不可**

現SDKは、実観測と会計を保持した状態を用意してからproposalを検証し、失敗時もその観測・使用量を返します。helperは返却後にcommitします。reviewにある`observations_recorded`という先行journalイベント、`mergeObservations`／`mergeEvidence`という現関数はありません。[観測保持と失敗返却](../../src/core.ts#L680)、[helper commit](../../skills/tombo-view/scripts/session.mjs#L143)

保護すべき条件は以下です。

- pending batchは同じexecution ID・内容で再送する。
- 記録済みEvidenceのscopeを変更しない。
- 再評価のmodelCalls／roundsを数え、実施済み外部検査を二重計上しない。
- 保存前へ戻して実消費を消さない。

この回復契約は既存helper試験にもあります。[試験](../../test/session-followup.test.mjs#L200)、[現参照](../../skills/tombo-view/references/host-session.md#L267)

**`--discard-execution`は存在しません。** 実在するinvalidateは証拠の撤回です。scopeの誤設定を直すための汎用discardではなく、使用量を払い戻しません。[実flag定義](../../skills/tombo-view/scripts/session.mjs#L220)、[invalidate](../../src/core.ts#L760)

回復は、まず同一pending batchへ成立する評価だけを適用する方法です。その後、別の証拠処理が本当に必要で、実際に行われたなら、正確な出典・処理内容・適用範囲を持つ別観測にできます。**scopeを合わせるだけのコピー、新executionによる再配送偽装、新たに取得したとの虚偽記録は認めません。**

**F3：対象claimなしgapの制約は確認。A3/A4を混同しない**

実schemaは`Gap`、`importance: required|optional`、`triggerRefs`です。reviewの`InformationGap`、`blocking`、`conditionRefs`は現契約ではありません。[schema](../../src/types.ts#L64)

それでも指摘の核は実在します。

- `claimIds: []`は許可される。
- supported/refuted resolutionには非空の対象claimが必要。
- `not_applicable`も、current・本文取得済み証拠と厳格な対象対応を要求する。
- 既存gapの対象claimを後付け変更できない。[resolution条件](../../src/core.ts#L119)

実IDは別です。

- **A4**：`current-preparation-note-gap`。stage3でsupported resolutionを拒否、再送で除去。
- **A3**：`corrected-prep-gap`。同様の拒否と除去。さらに`pass-value-gap`も対象claimなしです。A4の回答やIDを流用できません。

A3-r4の実回答は「パスして聞くだけでもよい」。実receiptは`pass-answer-after-deadline`、helper受領は **19:15:43.351Z**、最終rev13です。K4の`sessionClock`とsession停止はnullで、SDKの`budget_exhausted`を保持しています。reviewの別receipt・別時刻・封印時計停止・rev据置き説明は不正確です。旧stage1質問は未回答のままです。[A3 readback](a2-forward-H01-A3-user-r4-managed-readback-r1.json#L37)

現post-H参照には、scope一致と対象claimなしgapの制約が既に追記されています。[現参照](../../skills/tombo-view/references/host-session.md#L103)

**文書と診断は、既存claimへ結べる通常循環を支援できます。しかし、既に作られた対象claimなしrequired gapを、それだけで修復できません。** F1修正をF3解決と称してはいけません。

**fresh designへ渡す最小案〔未承認〕**

F1に限定した、次の加算案を推奨候補とします。

1. **SDK既定互換を維持する。** 既定の自動repair数0、既存repair動作、初回inspectの失敗動作は変更しない。
2. **既存stateを持つupdate／reflectだけ、helperが明示opt-inするterminal診断保存を追加する。** 固定proposalは一度だけ適用し、自動再試行しない。
3. **最新拒否を一件だけ保存する。** 仮称`lastProposalRejection`。operation、対象revision、理解へのbinding、分類・安全な対象IDを保持する。旧診断arrayを無制限に増やす方法は避ける。
4. **安全な診断範囲を限定する。** 最初の実検証失敗とgap／claim等の参照を示す。本文・claim文・reason・adapterの生例外を複写しない。汎用例外は安全な一般診断に留める。
5. **次prepareは現在の拒否と結び付く診断だけをfeedbackへ渡す。** 成功後、別操作後、別理解、期限・予算停止を最新の拒否と誤認しない。旧stateへ診断を推測補完しない。
6. 診断だけでclaim・gap・validity・decision・`understandingHash`を変えない。会計と二authorityを維持する。新revisionの状態全体digestは通常どおり計算し、旧hashは書き換えない。

既存`modelRepairDiagnostics`の再利用は差分を減らせますが、最新拒否との結付けと履歴上限を別途解決する必要があります。一件の任意fieldは、その意味を分離できる代案です。field名・binding方式はfresh designで確定すべき未決事項です。

**helper-only案との比較：** 現SDKのupdateはmessageを返さないため、helperのcatch追加だけではF1を直せません。helperでSDK検証を再実装すると判定が分岐します。既存stateの説明だけを充実させる案は現契約のまま可能ですが、実際の拒否理由保存とは同等ではありません。

F2のrollback・discard・scope alias、F3の自動解決・降格・retargetは提案しません。対象claimなしgapが通常の新条件発見を妨げる問題は残るため、F1と現文書で十分かは行動証拠で再確認が必要です。

**RED・owner・独立証拠**

既存ownerの一意write案です。新workerは不要です。

- **既存runtime owner**：`src/core.ts`、`src/types.ts`、`skills/tombo-view/scripts/session.mjs`、既存`test/cli-model-repair.test.mjs`／`test/session-followup.test.mjs`、runtime API契約記録。
- **既存docs owner**：必要な契約説明だけを`references/host-session.md`、結果確定後のREADMEへ反映。一般規則やreflection宣言は追加しない。
- **PM**：設計・証拠・freeze・gateのみ。

製品変更前の意味あるREDは次です。

- scope不一致resolutionを一度だけ拒否し、対象診断が新プロセスのprepareまで残る。
- 対象claimなしgapへのsupportedを拒否し、診断が得られてもgapは開いたまま。
- 同一pending batchの正しい再送で、model／roundだけを追加計上し、実tool使用量を二重計上しない。
- scope・execution変更、部分batch、新観測混入を引き続き拒否する。
- 成功後・別操作・期限後に旧診断を現在の訂正指示として使わない。期限後は評価しない。
- 既定SDK、既存正のrepair設定、legacy journal、本文を含む不正入力、診断件数上限の互換・非漏出を確認する。

新しいblind rawでは、**十分な実回答で元gapを閉じられる場合／本当に条件が残る場合／訂正で新条件が生じる場合／期限後回答**を分離します。事前固定予算を拡大せず、実proposal・拒否・再送・reflection・最終文を確認します。既存Hの未完了を成功へ読み替えず、quota停止も部分結果として保持します。

**➡️ NEXT STEPS**

PMがこのF1限定案、または変更なしで必要な独立反証を得る案を具体化し、**fresh cross-vendor design判断へ渡す段階**です。診断の改善はA2達成の証明ではなく、F3の到達不能状態も救済しません。

reviewの誤記訂正だけで`needs_review`をPASSへ変えず、旧失敗・20実observer runの区別・手続逸脱を保持してください。A2、fullreview、gate、親監査は未完了です。
