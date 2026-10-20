◤◢◤◢◤◢◤◢ STATUS ◤◢◤◢◤◢◤◢

受入2の未達を「goalに結び付いた永続bindingの欠如」と診断し、session binding・未評価追補の保存・生成不要の予算確認を組み合わせる設計を提案します。実装・書込み・試験実行はしていません。

📝 SUMMARY

- 同じgoalでは、task・ledger・予算・開始時刻を機構で固定します。
- 期限切れ後も旧理解と利用量を保持し、新情報は「受領済み・未評価」として保存します。
- 正当な目的変更は明示的な遷移として記録し、旧停止状態・未知・利用量への参照を必須にします。
- 本案は設計提案です。PMによる保存とfresh cross-vendor design PASS後に実装へ進みます。

💻 DETAILS

**1. 現在地と根拠〔観測〕**

2026-10-20 23:12:54 JST時点で、指定binding、branch、HEAD `dda5ff7` を確認しました。他担当による9ファイルのtracked変更を保持しています。禁止されたmain checkoutは直接参照していません。

scope amendment・locked charter全文、親監査、full-review-r2、行動評価、D01のcommands・TaskPacket・観測・停止state・新task state・reportと、現在のSDK/helper/skill/journal/関連テストを読みました。

現在の追加承認は受入2に限定され、旧2回capをその範囲で上書きしています。旧監査・失敗記録は履歴として保持し、完了・公開判定へ読み替えません。[parent-authorized-scope-amendment-r1.md:5](parent-authorized-scope-amendment-r1.md#L5)

D01の実経路は次のとおりです。

- 旧taskは `json-export-speedup-assessment`、開始は `2026-10-20T09:14:39.439Z`、上限300000ms。
- revision 4で、rounds 1、modelCalls 3、toolCalls 2、elapsedMs 405466、費用・token null、`blocked / budget_exhausted`。
- その後、別TaskPacket・別ledgerでinspectを実行。新taskの開始時刻・利用量は初期化され、最終reportは新taskの62279msだけを表示しました。

旧状態が物理的に消えたわけではありません。**同じgoalの後続処理から旧理解・停止・会計への必須の結び付きが失われました。** 新taskへの証拠コピーは、旧claims・assessments・stopReason・usageの継承を代替しません。[reflected-2.json:215](forward-evidence/r3-D01-s2/reflected-2.json#L215)、[commands.json:53](forward-evidence/r3-D01-s2/commands.json#L53)、[report-confounded.md:32](forward-evidence/r3-D01-s2/report-confounded.md#L32)

現行helperは呼出しごとにinput/state/ledgerを受け取り、別ledgerの空状態に対する初回inspectを受け入れます。`FileJournal` は同一ledger内のtask固定・revision・state一致を検査しますが、別ledgerとのgoal同一性は管理しません。[session.mjs:43](../../skills/tombo-view/scripts/session.mjs#L43)、[journal.ts:85](../../src/journal.ts#L85)

既存試験は同じledgerでの更新・人回答・復元・期限切れを検査しています。期限切れ後に別task/ledgerへ逃げる経路は検査対象になっていません。[understanding-session.test.mjs:124](../../test/understanding-session.test.mjs#L124)、[understanding-session.test.mjs:170](../../test/understanding-session.test.mjs#L170)

**2. 推奨する責務分担〔提案〕**

既存SDKの理解モデルを置き換えず、通常使うrepository helperに小さなsession管理層を加えます。

- **会話AI**：実タスク入力、確認候補、証拠評価、説明・案の修正を担当する。新情報だけを理由にgoal identityを作り直さない。
- **session管理層**：activated goalとtask/ledgerの結合、追補受領、予算確認、継続・遷移の記録を担当する。
- **既存SDK**：claims・evidence・gaps・reflection・policyの検証と更新を担当する。
- **既存FileJournal**：SDK状態の正本を保持する。
- **host**：許可された操作・保存領域・実際のメッセージ配送を担当する。helperはhost外の全操作を統制しない。

質問の必要性に限定せず、予算内では既存のproceed/check/ask/reframe/blockedの循環を維持します。

**3. Session bindingとauthority〔提案〕**

同梱helperに `activate`、`status`、`receive`、`transition` を追加します。既存prepare/inspect/update/reflect/reportは、activated sessionがある場合、そのbindingを必ず検査します。

保存先は、**許可された固定の作業領域**の `.session/` 配下です。例として、sessionイベントの正本を `.session/tombo-session.jsonl`、交換可能なcacheを `.session/tombo-session.json` とします。

現行手順の「skillフォルダーで実行」は変更し、taskの固定作業領域からhelperの絶対パスを呼びます。skill配置先に全利用者・全taskのsessionを混在させません。[host-session.md:5](../../skills/tombo-view/references/host-session.md#L5)

bindingには最低限、以下を保持します。

- helperが生成する不変の `sessionId`
- canonicalな作業領域・SDK ledger path
- `taskId` と固定TaskPacketのdigest
- SDKの `startedAt` と元budget
- 最新SDK revision/digestへの参照
- sessionイベントのsequence、追補ID、必要な遷移元参照

**authorityは分けます。** SDKの理解・usage・stopReasonの正本はSDK ledger、session identity・未評価追補・目的変更履歴の正本はsessionイベントです。cacheやモデル作成の要約を正本にしません。

同じbindingで次を拒否します。

- taskId、goalの言い換え、新しいout/ledger指定による再inspect
- budget・startedAt・usageを編集したstate
- ledger省略による正本照合の回避
- 既存sessionへの再activateによる初期化

同じactivate要求の再配送は既存sessionを返します。別TaskPacketへの変更は拒否します。readyもsession終了・binding解除とは扱いません。

sessionなしの既存helper操作とSDK APIは従来互換として残します。ただし改訂skillの通常経路はactivateから開始し、未管理操作の出力をmanaged continuationと表示しません。既存sessionが見つかった作業領域では、旧形式のhelper呼出しにもbinding検査を適用します。

イベント追記には排他・sequence・整合性検査を持たせます。SDK commit後にsession側記録が中断した場合はledgerから照合・復旧し、古いcacheへ戻しません。生成開始後の中断で消費を確定できなければ、未確定として停止し、再初期化で隠しません。

**4. 期限・usage・stopReasonと追補保存〔提案〕**

推奨するSDK追加は、生成を行わない独立exportの `checkpointBudget` です。`Tombo` interfaceへ必須methodを追加せず、既存の実装者・TaskPacket・state/journal schemaを維持します。

この関数は既存stateを検証し、既存と同じ時刻規則・操作別予算条件で、次の適用を実行できるか確認します。期限超過なら、claims/evidence/assessmentsを変えず、実elapsedと停止を持つInspectionResultを返します。

- budgetとstartedAtは不変。
- elapsedは少なくとも `max(既存elapsed, 現在時刻 − startedAt)`。待機時間を除外せず、減少させない。
- rounds/modelCalls/toolCallsを架空に増やさない。
- 旧stop receiptは台帳に残す。既存の別の停止理由も失わせず、予算不足を併記できる返却情報にする。
- 再考済みという記録や理解の進展を生成しない。
- 本文未取得の履歴でも、本文再取得やcritic実行を要求せず予算確認できる。

現在のelapsed算定と生成前予算検査を共通利用し、別の緩い規則を作りません。[core.ts:434](../../src/core.ts#L434)、[core.ts:458](../../src/core.ts#L458)

prepare前と適用直前に確認します。prepare時に余裕があっても、モデルが提案を作る間に期限切れなら、その提案を適用せず停止を保存します。時刻の逆行や正本不整合を検知した場合も、残時間が回復したとは扱いません。

`receive` は予算内外を問わず追補をsessionへ受領できます。保存内容は、追補ID、出典・日時、必要最小限の本文または資料参照、内容digest、実観測があればその実行ID・実利用量です。原会話全文やsecretは保存しません。

- **予算内**：適切なprobeとupdate/reflectを使ってSDKへ取り込み、実際に適用されたrevisionに対応付ける。
- **期限切れ**：追補を未評価のまま保存し、`blocked` を維持する。新しいprobeがなくても受領できる。新予算・新taskを作らない。
- **参照だけ届いた場合**：本文取得済み証拠と区別する。期限後の新しい外部検査を保存処理に紛れ込ませない。
- **再配送**：同じID・同じ内容は重複適用しない。内容衝突は拒否する。

受領記録をSDKのevidenceや支持・反証へ自動昇格させません。期限後のreportは「旧理解のsnapshot」「受領した未評価追補」「実停止」「未実施の評価」を区別します。過去のreadyを最新追補まで検証済みとして表示しません。

既に発生した実観測のusageも捨てません。SDKへ未適用ならsession側の未適用消費として保持し、SDKに計上済みのexecutionと重複加算しません。elapsedは区間を単純合算せず、実経過と既存SDK会計に整合させます。費用・tokenのunknownを0にしません。

既存 `update(..., {deferAssessment: true})` は参考になりますが、それだけでは未知probeを受け取れず、停止理由も `assessment_pending` になります。期限後追補全体の保存機構には不十分です。[core.ts:626](../../src/core.ts#L626)、[core.ts:673](../../src/core.ts#L673)

**5. 正当な目的変更・保存再開・互換性〔提案〕**

新資料、反例、本人回答、説明文修正は通常同じgoalです。既存probeで観測を受けるか、新gap/probeの組を追加し、同じtaskを更新します。人の回答・反例reframe・訂正の既存経路を維持します。

`transition` は、利用者が実際に別の目的・成功条件へ変更した場合の専用操作です。最低限、変更依頼の参照、変更理由、新旧条件、旧session/task/ledger、実停止、usage、未解決事項への参照を記録します。TaskPacketの文字列変更やAIの「目的が変わった」という宣言だけでは、正当性の証明としません。

新taskの予算は旧goalの残予算ではありません。旧usageを消さず、遷移系列の消費と新task単独の消費を分けて示します。利用者の横断的な上限も維持します。**今回のsame-goal期限切れにはtransitionを使いません。**

再開は同じsession正本とSDK ledgerから行い、cacheがなくてもbinding・停止・未評価追補を復元します。redacted evidenceを再検証済みとしません。保存不能・本文取得不能なら、その境界を明示します。[journal.ts:27](../../src/journal.ts#L27)、[journal.ts:67](../../src/journal.ts#L67)

既存SDKのscope診断、証拠validity、assessmentCorrections、reflection鮮度、gap解決条件は変更しません。session固有情報をUnderstandingStateへ混入させません。

**6. 代案と実hostの限界〔提案・未確認〕**

- **helperだけのsession overlay**：SDKを変更せず、実elapsedとsession側budget stopを記録する案。変更は小さい一方、SDK stateのstopReasonとsession停止が二層になり、誤表示の余地が増えます。SDK変更を避ける場合の代案です。
- **既存updateのdeferAssessment拡張だけ**：既知probeへの観測には有効ですが、別ledger開始の防止とprobe未定の追補保存を解決しません。単独案としては推奨しません。
- **文章の再強化だけ**：現在も禁止事項が明記され、D01で逸脱したため、今回の主修正にはしません。[SKILL.md:30](../../skills/tombo-view/SKILL.md#L30)

推奨案も、任意のshell実行、別作業領域、session記録削除、SDK/CLI直接利用、架空の目的変更理由まで封じるsandboxではありません。host由来の改ざん不能なthread/message IDが使えるかは未確認です。

保証する範囲は、**保持されたbindingを使うrepository helperの通常経路**です。fresh modelがその経路を使うか、迂回するかは行動試験で確認します。迂回が観測された場合は受入2未達として残し、機構の存在だけで合格にしません。global hookや全message interceptionは追加しません。

**7. TDDとfresh raw-only受入〔提案・未実行〕**

REDには以下を含めます。

- expired sessionでtaskId/ledger/outを変えても新inspect・新予算を開始できない。
- activate再配送、stale cache、ledger省略、同revisionのbudget/usage改変を検査する。
- prepare後から適用までの実時間経過で、提案適用を停止する。
- expired follow-upを、probe未定でも保存・replayできる。
- task identity、元budget/start、実elapsed、usage、stop receipt、旧evidence/claims/assessmentsを保持する。
- 未評価追補がsupported/readyへ自動反映されず、reportに未評価境界が出る。
- 二重配送、実消費の二重計上、途中中断・cache欠落・競合で履歴を失わない。
- 予算内follow-up、人回答、反例reframe、保存再開と旧SDK API互換を維持する。

SDK単体の時刻注入試験と、helper実プロセスで有限期限を実際に越える試験を分けます。製品helperに期限を偽装するCLI optionは追加しません。REDのcommand/exit/失敗assertion、最小修正、GREEN、影響回帰、`npm run typecheck`、`npm test` を記録します。既存678試験の記録は今回の合格証拠へ転用しません。

行動受入はfresh独立modelへ改訂skillと生シナリオだけを渡します。期待行動、D01、修正意図、作者の説明を渡しません。

第一段階の保存stateから**元の有限期限が実際に過ぎた後**、同じ目的への自然な追補を渡します。別途fresh processでも同じ保存領域から再開します。PM/親は実ファイルとcommandsから次を確認します。

- sessionId/taskId/ledger/budget/startedAtが保持された。
- elapsedが減らず、旧usageと実停止が残った。
- 新追補を保存し、未評価と明示した。
- 新task、新budget、時間上限拡大・無効化・リセットがなかった。
- 会話上の説明とSDK評価完了を混同しなかった。

予算内追補・人回答・反例reframe・保存再開も別シナリオで確認します。成功したモデル実行はそのケースの観測結果に限定し、一般的なライブ性能改善へ広げません。

**8. 依存DAGと一意write ownership〔提案〕**

依存順序は次のとおりです。

`本設計 → fresh cross-vendor design PASS → 契約固定・RED → SDK予算確認／session保存層 → helper統合 → GREEN・回帰 → fresh行動試験 → fresh full-diff review → 親監査`

一意の所有権は以下を推奨します。PMが実task handleへ割り当て、所有権変更を先に記録します。

- **SDK担当**：`src/core.ts`。独立exportの予算確認を追加。既存必須API/schemaは変更しない。
- **session担当**：新規 `skills/tombo-view/scripts/session-store.mjs`。binding・sessionイベント・未評価追補・復旧を担当。
- **helper担当**：`skills/tombo-view/scripts/session.mjs`。操作入口、binding gate、予算確認、session-aware reportを担当。
- **SDK試験担当**：新規 `test/session-budget-checkpoint.test.mjs`
- **session/helper試験担当**：新規 `test/session-binding.test.mjs`、`test/session-followup.test.mjs`
- **skill/docs担当**：`skills/tombo-view/SKILL.md`、`references/host-session.md`、`README.md`。確定した通常経路と限界のみ反映。
- **既存PM**：設計保存、契約・所有権、実task状態、検証・評価・handoverの記録。製品実装はしない。
- **独立reviewer／親**：read-only評価・監査。旧charter、監査、D01失敗を上書きしない。

新依存、有料API直接呼出し、secret、global設定・hook、Hidden-Side/CrossRAG変更は不要です。費用・総tokenは **unknown** です。

➡️ NEXT STEPS

既存PMが本設計を保存し、代案を含めたfresh cross-vendor design reviewへ渡す段階です。実装開始条件はそのPASSであり、本回答は実装方式の確定・受入2達成・goal完了を意味しません。
