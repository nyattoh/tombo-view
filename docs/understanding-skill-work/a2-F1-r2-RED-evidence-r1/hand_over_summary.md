# F1 r2 test-amendment / RED-only handover

同runtime ownerの今回releaseを完了。製品source未変更、GREEN/build/typecheck/npm未実施。r2独立reviewはLIFECYCLE DESIGN READINESSのみで、A2/fullreview/gate/parent/publicationは未PASS。費用/token unknown。

## 読取とbinding

2026-10-21 05:33:28 JSTにcwd `D:/develop/works/tombo-view-ask-policy`、branch `devin/20261020-1705-understanding-skill`、HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`を確認。cached labelでrebindしていない。main checkout/広域祖先探索/未来raw/新worker/モデルAPI/secret/依存/commit/push/PRなし。既存AGENTS逸脱は未免責のまま。

r2-runtime-RED brief、lifecycle-design-r2、独立review全文、accepted条件全文、review result metadata、r1 handover/verification/design-counterexample/proposed-api-test-contractを読み、review result.summaryとMD全文のtrim後一致を確認した。前turnで全文確認したcharter/amendmentに継続し、parent auditのcontinuation goal_complete/publication_readyは両snapshot falseを確認。reviewの誤った1095行指定とstore所有範囲提案は採用せず、今回の明示所有範囲に従った。

## 変更範囲と保全

全16 before hash/exact mtimeとr1状態の2testコピーはbefore.jsonと*.r1-before.mjs。16/16がr1終端hash/mtimeと一致した後に補正。変更はF1 suffixの次の3ブロックだけ。

1. CLIの非proposal revision試験（現365行開始）: invalidate/checkpoint/conflictでoriginal record全体のdeep equalityとolder atRevisionを要求。同revision no-opのstate equality、元のusage/stop/call assertionsは維持。
2. helper stale-fixture試験（現1109行開始）: current hash破損をvalidateState/public SDK updateがinvalid_inputで拒否しadapter calls0となる別assertionを追加。stale-hash inactivity fixtureだけatRevisionも過去へ設定。no-feedback assertionは維持。証拠/理解/usageは変更せずmetadata-only fixtureという境界を維持。
3. helper併存試験（現1137行開始）: direct SessionStore setupより前に、実opt-in terminal resultのrecord存在とexact shape/binding/2-of-2 countsを要求。invalidate後はrecord全体保持・older revision・usage不変。`assert.equal(prepared.value.request.validationFeedback, undefined, ...)`は保持し、obsolete説明だけr2へ合わせた。

original pre-F1 prefixes 17716/73913 bytesはbit-for-bit不変。pre-SDK binding rejection試験（元1095行のrecord undefinedを含む）は**ブロック全文不変**。valid update/reflect成功時clear、default opt-out、inspect0、legacy replay、privacy、scope/expiry等の他ブロックは差分にない。r1証拠13ファイルのhashも全一致。既存編集を戻していない。

before/after全16でprotected14（core/types/helper source3とstoreを含む）のbytes/hashおよびexact mtimeが14/14不変。staged0、ask-policy untracked192。歴史409の再hashは今回していないが、それらへ書込み/削除操作なし。exact差分は*.r2.patchに保存。git no-index diff exit1は差分ありを示す正常結果で、改行warningはsource mutationではない。

## 実RED

```powershell
node --test --test-name-pattern='F1' test/cli-model-repair.test.mjs test/session-followup.test.mjs
```

開始 `2026-10-21T05:35:06.4961335+09:00`、終了 `2026-10-21T05:35:14.8087681+09:00`。exit **1**、selected **29 tests / 2 pass / 27 fail / skip0 / cancelled0**。27件すべてAssertionError。未知flag/import/test-adapter組立エラーではない。filter外はNOT_RUNで、全suiteの結果へ拡張しない。

stdout/stderr等はPowerShell `*>` により完全結合したred-r2.log。log SHA256:

```text
f31f874b8a5a311930d981f209e41ea1a09e584f7eb1f0f97af14aae2af32b46
```

通過2件は既存default/inspect0/positive repair/legacy互換ケースと、変更禁止のhelper outer/inner binding生成前拒否ケース。新F1機構のGREENではない。正確なcommands/exits/counts/time/全失敗assertionはred-r2.json/log・verification-summary.json。

実失敗は、実際のSDK/helper semantic拒否後に新recordがない、正しいpending batchのprepareにfeedbackがない、提案中boolean optionの検査がない、という欠落assertion。実SDKの拒否・使用量・pending・不当resolution未適用を前段で確認する既存F1試験は保持した。

## 実測と未到達の区別

新lastProposalRejectionはまだ未実装。非proposal後の保持・current metadata破損拒否・historical inactivity・privacy/persist/replay/cache/回復/expiry等の後半assertionは、多くがpositive existence assertionで停止して未到達。今回成功したと主張しない。privacy negativeだけをrecord不在でPASSにはしていない。

併存試験も、新設のpositive record assertionで**SessionStore直接setupより前**にREDとなった。したがってr2 new-objectのinvalidate→prepare経路は未実行である。r1で実測したのはpublic SDK positive repair＋明示SessionStore直接setup＋実helperによるlegacy stale feedbackであり、その旧証拠を不変保持して区別する。通常helperだけでpositive repairを生成したとの主張なし。

今回新たな設計矛盾は見つかっていない。r2 retentionでC1/C4を解消する設計の実装・効果は、別途source release後の作業であり未確認。

## 最終test hashes・terminal

```text
test/cli-model-repair.test.mjs
93813bd5cf44d4bcb7d1349e6db4dacfa0edc0c662ddbbb7c3eb77eb01d28d5a
test/session-followup.test.mjs
4f0f34ee149f8bad1bd16bfd837d90248987f1a6107343b454f98f850524b568
```

全selected process終了。productionは未releaseのためここでterminal。次回の実装へは進んでいない。別途の明示releaseとPMの判断を待つ。決定論的REDはモデル意味効力・A2達成ではない。
