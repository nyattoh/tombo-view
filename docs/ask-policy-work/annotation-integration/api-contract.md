# Annotation integration API contract

状態: 正式60件と実3ベンダー各60返却を受領し、formal=trueで生成・readback・再導出・比較器の正式入力schema検証を完了。3/3全員一致42件、不一致18件。goal全体の最終全体試験・比較・独立レビューは別工程。ここには架空のラベル・provenance例を置かない。

`scripts/ask-policy-annotations.mjs` は3関数をexportする。CLI、モデル呼出し、ファイルI/O、比較reportの生成は実装しない。

- `integrateAnnotations(bundle, { formal = true } = {})` は全検証後に `{ annotations, disagreements, rawLabels, provenance }` を返す。既定は正式60件。`formal: false` は小規模なsynthetic単体試験専用で、正式出力へ利用しない。
- `verifyIntegratedAnnotations(bundle, result, options)` は元artifactから再導出し、全結果を深層比較する。schemaの追加項目、合意・作者差分・不一致・provenanceの改変を拒否する。
- `serialiseAnnotations(value)` は2スペースindentと末尾改行で安定したJSONを返す。

## bundleの契約

トップレベルの必須項目は `fixtures`, `authorIntent`, `rubric`, `freeze`, `authors`, `runs`。任意の `sourceEvidence` 以外の追加項目は認めない。`sourceEvidence` は元coordination JSON・実行監査・凍結記録など実在artifactの配列で、全byte hashを照合し、参照/path/hash/byteLengthだけをprovenanceに保存する。

`fixtures`, `authorIntent`, `rubric` はそれぞれ `{ path, sha256, bytes }`。`bytes` は元UTF-8文字列又はBuffer、`sha256` は小文字64桁の実バイトハッシュ、`path` はworktree相対artifact参照（絶対パス・親参照不可）。この関数自身はpathを開かない。PMが保存した実ファイルを同じwriterが読み、正しい元バイト列を渡す。fixtures/intentは設計第6節のJSON配列、rubricは固定された本文の元バイト列。

`freeze` は `{ status: 'frozen', fixturesHash, authorIntentHash, rubricHash }`。注釈前にPMが確定した実ハッシュを渡す。統合時に取得した各ファイルのバイト列がすべて一致しなければ失敗する。結果を見てfreezeを作り直すことは許可されない。

`authors` はケースごとの `{ caseId, taskId, runId, threadId, providerInstanceId, model, options, status }` の配列。全入力caseIdと1:1対応し、作者の実dispatch値を使う。`options` はhostの実設定 `{ id, value }` 配列、valueは文字列又は真偽値、明示設定なしなら空配列。`status` は実行完了を確認した `'completed'` のみ。handle/modelを推測や置換で埋めない。末端workerは実dispatchを新たに行わない。

`runs` はvendorごとのシャード記録の配列。各項目は `{ vendor, caseIds, fixturesHash, rubricHash, attempts }`。vendorは `openai`, `google`, `nvidia` のみ。caseIdsは当該実dispatchで提示した集合。disjointな複数シャードを許容するが、同vendor内の重複票・欠落を許容しない。

`attempts` は1又は2件。各項目は作者と同じ実metadata（caseIdを除く）に加え、`sourceOnly: true`, `repoExploration: false`, `prompt`, `output` を持つ。prompt/outputは上記artifact型。実modelにClaude/Grokが含まれる場合は拒否する。モデルベンダーの正しい帰属とhostの実optionsはPMが実catalogue/dispatch記録で照合する。

## 固定payloadと元返却

`prompt.bytes` は実際に渡した固定JSON envelope `{ rubric, cases }` のバイト列。rubricは凍結本文と完全一致する文字列、casesは `{ caseId, input }` だけの配列で、当該シャードと全件1:1一致させる。inputは凍結fixtureのinputと深層同値でなければならない。domain、作者意図、期待値、他の注釈、リポジトリ文脈を追加しない。JSON envelope内のrubricを指示、casesをデータとして扱うよう固定rubricで指定する。PMが別形式のpayloadで既に実dispatch済みの場合、履歴をenvelopeで偽装せず、同じwriterを再開して元形式を検証できるadapterをTDDで追加する。

元outputは、厳格な `{ caseId, action, reasonPath }` 配列、又はPMの固定rubricにある `{ annotations: [...] }` を受け付ける。追加キーやモデル自己申告vendor/modelを拒否する。元JSONバイト列を書き換えず、正式vendorファイル用のコピーにだけ実dispatchのvendor/modelを付与する。reasonPathは入力内の具体entity ID（id/taskId/executionId）、`state`/`packet`からのdot/index path、state内の相対path、`input`/`$` prefix付きpath、又はJSON pointerを解決できる必要がある。文章一般や存在しない参照は受け付けない。実在する値一般をentity IDとして扱わず、既知のIDフィールドと具体pathだけを解決する。

2回目は1回目が非空のJSON構文不正だった場合だけ許可し、両方の元output/prompt参照と実metadataを保持する。同じrunIdの使い回しを拒否する。空出力、missing result、schema不正、coverage違反、parse可能なJSONに対する修正はsyntax retryではない。最終返却の `invalid_output` markerは有効ラベルではなく、正式統合はfail closedとする。未完了の元結果はPM coordination記録に残す。

## 検証と正式保存

fixture入力とintent、作者metadata、各vendorの全60uniqueケース、3domain/作者意図配分/対照群、packet/state.task一致、inputラベル漏洩、reason参照、artifact byte hash、実handle必須項目を検証する。各ケースの作者と全annotator、vendor間annotatorのthread独立性も確認する。SDK state schemaの新旧検証はfixture担当が別工程で行う。metadataの真偽・repo探索なし・独立性はPMがhostの実dispatch/status/timelineでも確認し、この関数の構造検証だけで実証済みとしない。

PM準備通知後、同じwriterが凍結時点・実結果・host証拠を確認し、正式modeで統合と再検証を行う。通知前には以下を生成しない。

- `rawLabels[vendor]` → `evaluation/ask-policy-blind/vendor-{openai,google,nvidia}.json`。設計第7節の5項目だけ、caseId順。
- `annotations` → `evaluation/ask-policy-annotations.json`。3/3全員一致時だけ期待値を設定。
- `disagreements` → `evaluation/ask-policy-disagreements.json`。全不一致の票と各入力根拠を列挙し、正答を裁定しない。
- `provenance` → `evaluation/ask-policy-blind/provenance.json`。元artifact参照/hash/byteLength、凍結hash、実metadata、作者handle、正式派生ファイルhashを保存する。元JSONを重複保存・改変しない。

全書込み後に元ファイルと派生ファイルを読み戻してhash・再導出を確認する。比較reportの生成は比較担当の所有。全npm testと独立レビュー、task gate、goal最終受入はPMのbarrier後に行う。

実データ受領後は `run-formal-integration.mjs` を使い、dispatch/status/元summary/prompt、実作者metadata、live-payload-auditを照合してから上記純粋関数を実行した。再利用threadの `latestTerminal*` は後続batchを示し得るため、task固有の `childRunId` と `summary` を実threadの該当runへ照合する。保存outputと元summaryとの差は末尾改行だけであることを確認する。

`verify-formal-readback.mjs` は正式出力と全sourceEvidenceの実hashを検証し、比較担当の純粋な `validateDataset(data, { formal: true })` だけを呼ぶ。比較report・新旧policy実行・build入口は呼ばない。元prompt/返却を変更して適合させる処理はない。

Decision source: framework_only_local。Jev API call: not made。費用・token数unknown。
