# Storage placement contract — implemented

2026-10-21 JST。実helperの製品変更前REDを経て、binding試験13/13、全focused34/34、関連回帰284/284がGREEN、すべてexit 0、fail/skip 0。build/typecheckも各exit 0。証拠は本領域の `green-binding-r1.json/log`, `focused.json/log`, `regression.json/log`, `build-typecheck.json`。正確な時刻・commands・hashは `hand_over_summary.md` と `verification-summary.json`。旧705/27/284結果を今回のPASS根拠へ転用しない。

## 使い方

固定task workspaceをcwdにしたまま、利用者が許可した `.session/` にSDK正本/cacheと入力・提案・receipt・reportを同居できる。

```text
node /absolute/path/to/repository/skills/tombo-view/scripts/session.mjs activate --input .session/task.json --ledger .session/sdk.jsonl --out .session/state.json
node <helper> prepare --input .session/task.json --ledger .session/sdk.jsonl
node <helper> inspect --input .session/task.json --proposal .session/proposal.json --ledger .session/sdk.jsonl --out .session/state.json
node <helper> prepare --state .session/state.json --observations .session/observations.json --ledger .session/sdk.jsonl
node <helper> update --state .session/state.json --observations .session/observations.json --proposal .session/update.json --ledger .session/sdk.jsonl --out .session/state.json
node <helper> prepare --state .session/state.json --operation reflect --ledger .session/sdk.jsonl
node <helper> reflect --state .session/state.json --proposal .session/reflection.json --ledger .session/sdk.jsonl --out .session/state.json
node <helper> report --state .session/state.json --ledger .session/sdk.jsonl
```

prepare/reportのstdoutを保存するなら、非予約の `.session/context.json` / `.session/report.md` 等へcallerがredirectする。管理済みprepare/reportの `--out` 契約は変更しない。root cwdから `.session` へcdする必要はない。

`.session/runs/one/sdk.jsonl` と `.session/runs/one/state.json` のようなnested配置も可能。従来のworkspace直下SDK保存先も互換維持。新command/flag/UI/schemaは追加していない。

## 具体的な予約と衝突

- session正本: `.session/tombo-session.jsonl`
- session cache: `.session/tombo-session.json`
- session lock: `.session/tombo-session.jsonl.lock`
- session cacheの実temp名: `.session/tombo-session.json.<UUID>.tmp`
- 現SDK/transition履歴のSDK ledger、SDK ledgerの `.lock`、SDK state cache、それぞれのstate cacheの `<cache>.<UUID>.tmp` 名前領域。

UUIDは8-4-4-4-12の16進文字列として検査する（大小文字を区別しない）。実cache writerの名前に対応し、そのtemp名をディレクトリとして子にファイルを置く指定も拒否する。無関係なprefixまで一律予約しないため、`.session/tombo-session-notes.jsonl` や `.session/tombo-session.json.notes` は衝突がなければ利用できる。journalは直接追記されるので、journalの架空temp namespaceは新設しない。

ledger/state/ledger lock同士、上記予約ファイル群との同一・ファイル親子の配置を拒否する。既存の逆方向 `state + '.lock' === ledger` 拒否も維持。workspace外とworkspace自体/`.session` directory自体のファイル指定は禁止。

cache temp namespaceとSDK記録の衝突は両方向で検査する。transition履歴の旧cacheを新ledgerとして再利用するなど、役割の付替えも拒否する。旧cacheが物理的に失われていても予約は履歴から維持する。

初回activate/正当transition先のledger/stateは未使用。SDK ledgerの残存 `.lock` も拒否し、奪取・削除しない。既存sessionへの同一activateは同bindingを返し、別task/ledger/outへの初期化逃避を許可しない。

## 保持した境界

resolve/realpath/Windows case正規化を従来どおり使う。安全な内部directory aliasから同bindingへ戻れる。`.session` authority directory自体のsymlink転送禁止、ancestor binding探索、canonical cwd gateは変更しない。

保存パスはactivate/transitionだけでなく、guard/reconcileとsession追記前にも同じ規則で検証する。bindingのcanonical pathが変わった場合は拒否する。

二authorityのtask/start/budget/revision/hash、transaction復旧、未確定会計停止、receipt、managed invalidate、旧停止/破棄履歴/利用量は変更しない。入力/output shapeは従来のactivated-session JSONのまま。

これは指定保存先を自動移動したり利用者の保存許可を拡張したりする機能ではない。hardlink/inode/ADS/dangling symlinkの新対策、OS設定変更、汎用sandbox、exclusive temp wrapper等は実装/試験対象外。協調的なlockと正本保持を前提とする。費用/tokenはunknown。
