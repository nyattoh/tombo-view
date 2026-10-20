◤◢◤◢◤◢◤◢ STATUS ◤◢◤◢◤◢◤◢

保存scope不整合を確認しました。`.session/` 全体の禁止を、session正本・SDK記録・lock・一時ファイルの具体的な衝突検査へ置き換える案を推奨します。実装・書込み・試験実行はしていません。

📝 SUMMARY

- 固定cwdと`.session/`限定の保存許可を維持したまま、独立したSDK ledger/cacheを配置可能にします。
- 二つのauthority、binding、予算、停止、invalidate metadataは変更しません。
- 製品変更は原則 `session-store.mjs` 内に限定し、既存a2試験と実行手順を更新します。
- E01/E02はactivation未成立です。期限超過後の継続試験が成立したとは扱いません。

💻 DETAILS

**1. 確認した事実**

2026-10-21 00:20:10 JSTまでに、指定branch・HEADを確認しました。指定文書全文、現在の `session-store.mjs`・`session.mjs`・`host-session.md`、関連試験、E01/E02のexecution-recordを読みました。既存編集を変更せず、main checkoutは直接参照していません。

原因は次の一行です。

`paths()` はworkspace内であることに加え、ledger/cacheが `.session/` 自体にも、その全子孫にも属さないことを要求しています。これは保護対象の具体的ファイルより広い制限です。[session-store.mjs:127](../../skills/tombo-view/scripts/session-store.mjs#L127)

E02の実依頼は、固定作業領域の `.session/` 内にだけスキル状態保存を許可しています。手順も `.session/` 外への配置を要求するため、利用者の許可を守るとactivateできません。[request.md:1](../../results/understanding-acceptance2/observers/E02/request.md#L1)、[host-session.md:27](../../skills/tombo-view/references/host-session.md#L27)

E01/E02のexecution-recordは、保存scope不整合による未activation・blockedを記録しています。SDKのtask identity、startedAt、理解stateがないため、これは「理解循環を実行して予算切れになった」結果ではありません。記録には個々のactivateコマンドの生stderrまでは残っておらず、その部分は未確認です。ソース上の拒否条件との一致は確認しました。[E01 execution-record.json:4](a2-forward-evidence/E01-s1/execution-record.json#L4)、[E02 execution-record.json:16](a2-forward-evidence/E02-s1/execution-record.json#L16)

PM記録の705/705、fail/skip 0は今回読みましたが、再実行していません。既存binding試験は主にworkspace直下のSDK記録を使い、`.session/`限定配置の成功を検査していません。[a2-integrated-npm-test-r1.json:4](a2-integrated-npm-test-r1.json#L4)、[session-binding.test.mjs:18](../../test/session-binding.test.mjs#L18)

**2. 最小変更の仕様〔提案〕**

`.session/` は保存用ディレクトリであり、全体をsession authority専用にはしません。例えば次の同居を許可します。

```text
.session/tombo-session.jsonl       session正本
.session/tombo-session.json        session cache
.session/tombo-session.jsonl.lock  session lock
.session/sdk.jsonl                 独立したSDK正本
.session/state.json                独立したSDK cache
```

保存先を自動移動せず、指定された安全なパスを検証してbindingへ固定します。入力・提案・context・reportも利用者の許可範囲へ保存します。

以下は維持します。

- workspace外へのSDK記録は禁止。
- 初回activateのledger/cacheは未使用。
- 同じactivate要求の再配送は既存bindingへ戻る。
- 既存bindingのpath・task・budget・startedAtを変更しない。
- sessionの正本位置、schema、二authority間transactionは変更しない。
- 旧workspace直下の安全な配置も継続利用できる。

単に行131から `.session/` 判定を削除するだけでは不十分です。具体的な保護対象との衝突を代わりに検査します。

**3. 衝突判定〔提案〕**

同じ検査をactivateとtransitionに共用し、既存bindingを使う際にも再確認します。

**保護対象**

- session journal、session cache、session lockの実パス。
- session cacheの書換えに使う `<cache>.<UUID>.tmp` の名前領域。
- SDK ledger、SDK cache、SDK ledgerの `.lock`。
- SDK cacheの書換え用一時ファイル領域。
- transition履歴に残る旧SDK ledger/cacheと、そのlock・一時ファイル領域。

現在の書込み方法は、journalへの追記、排他lock、cacheの一時ファイルからのrenameです。この実際の書込み先を基準にします。[session-store.mjs:107](../../skills/tombo-view/scripts/session-store.mjs#L107)、[journal.ts:93](../../src/journal.ts#L93)

**拒否条件**

- SDK記録またはそのlockがsession保護対象と同一。
- ledgerとstateが同一。
- `ledger + '.lock' === state`。
- `state + '.lock' === ledger`。実装済みの逆方向チェックも維持する。
- ファイル予定地同士が親子関係になる配置。例えばsession cache名をディレクトリとして、その下へledgerを作る指定。
- 一時ファイルの予約名との衝突。
- transition先が旧SDK記録の別名・別役割として再利用される配置。
- 新規activate/transition先に未管理ファイルや残存SDK lockがある場合。

比較はパス要素の境界で行います。単なる文字列prefix禁止にはせず、無関係な `.session/tombo-session-notes.json` 等まで予約しません。

**alias・実体の確認**

- `resolve`、既存部分の`realpath`、現在のWindows case正規化を使う。相対表記・大文字小文字・安全な内部directory aliasから同じ既存bindingへ戻れる性質は維持する。[session-store.mjs:13](../../skills/tombo-view/scripts/session-store.mjs#L13)
- `lstat`でdangling symlinkを区別する。`existsSync === false`や`realpath`のENOENTだけで未使用の通常ファイルと判断しない。
- `.session` authority directoryのsymlinkによる転送禁止は維持する。[session-store.mjs:56](../../skills/tombo-view/scripts/session-store.mjs#L56)
- SDKのdirectory aliasは、実体が許可範囲内で、保護対象と衝突しない場合だけ許可する。`.session/` 内として指定した配置が、リンク解決後にその外へ出る経路は許可しない。
- 既存ファイルはdevice/file identityも照合する。最小で確実な方針として、書込み対象のauthority/ledger/cacheに複数hardlinkがある場合は拒否する。これにより、別名から正本やscope外のファイルを書き換える経路を避ける。
- WindowsのADS、末尾dot/space等、未作成時のcanonical化だけで同一性を判断できない出力名は拒否する。通常の保存名を成立させるために特殊名対応を追加しない。

初回だけの検査では、bind後のsymlink/hardlink差替えを検知できません。`load/guard/reconcile` と書込み直前に、役割に応じた同じ検査を使います。authority自身による正当な追記・cache更新まで拒否する汎用禁止にはしません。新しいcache一時ファイルは排他的作成にして、既存ファイルを上書きしません。

**4. Binding・再開・ancestor・互換性〔提案〕**

変更対象は保存場所の適合判定です。以下の意味は変えません。

- `guard`による固定ledger/out検査。
- SDK stateとsealed revision/hashの一致確認。
- staged commitの復旧、未確定会計での停止。
- truthfulなbudget checkpoint、未評価receipt、stopReceipts。
- managed invalidateの未適用申告・破棄履歴・pending usage。

既存binding再開では新パスを選び直さず、保存されたパスを検証して使います。transitionでも、正当なuserChangeと旧会計・停止・未知の引継ぎ条件を維持します。[session-store.mjs:148](../../skills/tombo-view/scripts/session-store.mjs#L148)、[session-store.mjs:338](../../skills/tombo-view/scripts/session-store.mjs#L338)

ancestor binding検出は弱めません。

- 子directoryからのactivate、旧形式prepare/inspectによる再初期化は引き続き拒否。
- canonical cwdの祖先も確認し、directory aliasで親bindingの探索を外さない。
- danglingなauthority markerも「sessionなし」と判定しない。
- marker不整合をlegacy経路へfallbackさせない。

この確認が必要なら、同じ `session-store.mjs` 内の `findSessionWorkspace` を同期APIのまま補強します。`session.mjs`のdispatch変更は不要な案です。現在の親探索と固定cwd gateは保持します。[session-store.mjs:31](../../skills/tombo-view/scripts/session-store.mjs#L31)、[session.mjs:28](../../skills/tombo-view/scripts/session.mjs#L28)

未activation領域のlegacy SDK/helper互換は維持します。managed正本への直接commitを採用する緩和は行いません。

**5. より小さい代案の評価〔提案〕**

- **文書だけ変更する案**：`.session/`限定許可と両立しないため不採用。
- **SDK保存先を外へ自動移動する案**：保存許可を越えるため不採用。
- **authorityを新しい専用directoryへ移す案**：既存binding探索・移行・復元へ変更が広がるため、今回は不要。
- **具体的な衝突検査へ置換する案**：authority位置と既存契約を保てるため推奨。

**6. 必須のRED→GREEN→回帰〔提案・未実行〕**

既存a2試験へ、少なくとも次を追加します。

1. 固定cwdの`.session/`だけを保存先として、activate→inspect→実観測update→reflect→reportが成立する。書込みが許可領域内で、二authorityが別ファイルであることも確認する。
2. `.session/sdk.jsonl`、`.session/state.json`と、独立したnested配置が成功する。
3. session正本/cache/lockへの直接指定、case・相対・symlink別名、ledger/state同一、両方向lock衝突、予約一時名、ファイル親子衝突を拒否する。
4. fresh配置とbind後差替えの双方で、dangling symlink、scope外リンク、hardlinkを拒否する。既存の安全なdirectory alias試験は維持する。
5. 拒否操作で正本内容・binding・usageを変更せず、残存lockを奪わない。
6. 同binding再activate、cache欠落復元、同goalの別ledger拒否、正当なtransitionと旧記録保護を確認する。
7. canonical/alias経由の子directoryからもancestor bindingを迂回できない。
8. `.session/`内配置で実期限切れ後に追補を保存し、元identity/start/budget/usage/stop/evidence/理解状態と未評価境界を維持する。
9. 既存managed invalidate試験を再確認し、metadata・破棄履歴・会計が変わらない。

REDは少なくとも現在の`.session/`内activate拒否を実プロセスで示します。危険なaliasを現在受け入れるかは、未実証のまま断定せず、対応する反例試験で確認します。

その後、最小修正、focused GREEN、関連回帰、build/typecheck、`npm test`を記録します。skipや既存期待値の緩和で通しません。プラットフォーム上実行不能なリンク試験はNOT_RUNとして残し、合格扱いにしません。

**7. Fresh raw観測とownership〔提案〕**

fresh試行では、最初に割り当てたcwdと`.session/`限定許可を全stageで固定します。observerへ保存先の逃げ道、以前の失敗、期待行動は追加しません。

まずactual managed activationとSDK stateが成立したことを確認し、その元期限が実際に過ぎた後で同goalの追補を渡します。未成立ならstage2の継続試験とは数えません。予算内follow-up・人回答・反例reframe・保存再開も維持確認します。

E01/E02の失敗は保持します。E03の未確定結果は本案へ推測で取り込まず、現在のfreezeに対する独立評価を続けます。修正後の試行とはfreeze/hashを分けます。

依存順序は以下です。

`本設計の保存 → fresh cross-vendor design PASS → 既存試験担当のRED → 既存runtime担当の最小修正 → GREEN・回帰 → fresh raw試行 → 独立review・親監査`

write ownershipは既存担当のままです。

- runtime担当：`skills/tombo-view/scripts/session-store.mjs`
- a2試験担当：既存 `test/session-binding.test.mjs`、必要な `test/session-followup.test.mjs`
- 文書の既存owner：`host-session.md`と既存API契約の保存条件・例だけを同期
- PM：設計・証拠・freeze・評価記録を保存。製品実装は担当しない

**未確認境界**

Windows上のfile identity・特殊alias・リンク権限の実挙動と、修正後のモデルによる通常経路使用は未検証です。また、この検査は協調的なlockと正本保持を前提とし、外部プロセスによる任意の同時差替えを防ぐOS sandboxではありません。費用・総tokenは **unknown** です。

➡️ NEXT STEPS

既存PMが本案をfresh cross-vendor design reviewへ渡す段階です。PASS前の製品変更は行いません。本回答は受入2達成やgoal完了の判定ではありません。
