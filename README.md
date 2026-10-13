# TOMBO

AIが自分の理解を確かめる複眼ツール。回答案や操作予定を、主張、証拠、未確認事項、検査へ分け、追加証拠に応じて状態を更新します。

**v0.1 は探索的な試作品です。** 固定の架空デモ、TypeScript SDK、CLI、エージェント用スキル、比較実験の準備データを提供します。実モデルによる効果比較は未実施です。未知をすべて発見する能力、完全な理解、幻覚の防止を保証しません。

[English](#english) · [仕様書](TOMBO_spec_v0.1_ja.md) · [比較実験の準備](evaluation/README.md)

## 固定デモを動かす

Node.js 22以上とnpmを使います。npmへのパッケージ公開はまだ行っていません。

```sh
git clone https://github.com/nyattoh/tombo-view.git
cd tombo-view
npm ci
npm test
npm run demo
```

デモは、CLOSE 409の架空規約とイベント再送の架空テストを再生します。出力に `再生デモ / synthetic replay` を表示します。モデルは呼ばれず、検出能力の評価には使えません。

## CLIで状態を更新する

```sh
npm run build
node dist/cli.js inspect --input examples/account/task.json --adapter fixture --out results/state.json --ledger results/events.jsonl
node dist/cli.js update --state results/state.json --observations examples/account/observations.json --adapter fixture --out results/next.json --ledger results/events.jsonl
node dist/cli.js report --state results/next.json --format markdown --out results/report.md
node dist/cli.js replay --ledger results/events.jsonl --out results/restored.json
```

最初に検査候補を生成し、呼出し元が実行した観測を `update` へ渡します。SDKやCLIは検索、シェル、通知、外部操作を暗黙に実行しません。`ready_for_requested_step` は指定範囲の必須確認が解決した判定であり、外部操作の許可ではありません。

`fixture` は二つの配布例だけに対応します。任意の入力を調べるには、次の生成アダプタを用意してください。正常な意味上の判定は終了コード0、入力・モデル形式・実行基盤のエラーは1です。

## SDKを組み込む

```ts
import { createTombo, fixtureAdapter } from './dist/index.js';

const tombo = createTombo({ adapter: fixtureAdapter });
const first = await tombo.inspect(packet);
const observations = await host.runProbes(first.nextProbeIds);
const next = await tombo.update(first.state, observations);
const reopened = tombo.invalidate(next.state, {
	evidenceIds: ['e-account-result'],
	reason: '参照資料の版が更新された',
});
```

`packet` は `examples/account/task.json` の形式です。`host.runProbes` は呼出し元が実装する関数です。スキーマと公開型はSDKからexportされます。証拠本文のUTF-8 SHA-256は `hashPassage` で作成できます。

`createTombo({ adapter })` に渡す生成アダプタは `generate(input)` を提供します。入力には `operation`、`task`、更新時の `state` と `observations`、出力トークン上限を含みます。応答は `proposal` と `usage` です。`proposal` は主張、観点、未確認事項、検査、証拠評価、解決の提案を含み、状態全体の上書きは受け付けません。

CLIは `--adapter file:/absolute/path/adapter.mjs` でESMモジュールのdefault exportまたは `adapter` exportを読みます。アダプタは信頼できるコードとして実行されます。提供者、鍵、料金、送信内容、通信の中断は呼出し元が管理します。組込みの有料モデル接続はありません。公開型の `GenerationAdapter` と `GenerationOutput` を契約として使用してください。

`examples/http-adapter.mjs` は、上記の入出力契約に対応するHTTP生成サービスへ接続する例です。`.env.example` を `.env` へコピーし、許可した送信先と任意のBearer鍵を設定します。URLは特定プロバイダーのAPIではなく、TOMBOの提案JSONを返すサービスです。鍵をGitへ追加しないでください。

```sh
node --env-file=.env dist/cli.js inspect --input your-task.json --adapter file:examples/http-adapter.mjs --out results/state.json
```

接続例はHTTPSまたはローカルHTTPを受け付け、リダイレクトを拒否します。ローカルHTTPによる契約テストはありますが、実プロバイダーへの接続は未検証です。

金額上限を使う場合は、アダプタの `estimateMaxCostYen` で事前上限を示し、利用量を報告します。実際の生成とツール呼出しの中断・上限予約もホストが保証します。未知の費用を0円として扱いません。

## 保存と再実行

- 各実行に一意の `executionId` を付けます。同じ実行結果の配送を再試行するときは同じIDを使います。別の実行は同じ結果でも別のIDです。
- `FileJournal.commit(expectedRevision, state)` が排他的に版を照合し、JSONLへ確定状態を追記します。JSONLを正本とし、状態JSONは再生成できるキャッシュです。
- 履歴は証拠本文を除去し、参照、ハッシュ、`passageUnavailable` を残します。再生はモデルを呼びません。再検証に必要な本文は呼出し元が元の許可された資料から再取得します。
- 不完全な末尾や不一致のハッシュを持つ履歴は拒否します。中断後の `.lock` を自動削除しません。書込み中のプロセスがないことを確認し、原本を保全してから明示的に復旧します。
- 状態JSONには資料本文が含まれ得ます。資料、回答案、目的自体に秘密や個人情報を含めないでください。`results/` と `.env` はGitの対象外です。

## 確認できる動作と限界

テストは、証拠IDとハッシュ、適用範囲、支持と反証、結果なし、証拠撤回、配送の重複、利用量、予算、版競合、履歴再生、CLIの入出力を確認します。構造検証だけでは証拠の意味が正しいとは保証できません。

候補は最大8件、各回の検査は最大3件です。初期予算は追加探索2回、モデル呼出し3回、ツール呼出し6回、120秒です。上限は設計値で、性能の実測値ではありません。ホストの実行時間と利用量も予算に含めます。

比較用の48件は自作の架空ケースです。評価用の注釈をモデルへ渡さず、通常のエージェント、一般的な再点検、固定チェックリスト、TOMBOを同予算で比較してください。比較実験、実プロバイダー接続、効果の統計評価はまだ行っていません。

## エージェント用スキル

`skills/tombo/SKILL.md` を利用するエージェントのスキル配置先へコピーします。スキルを読むだけで検査成功を保証しません。SDKと明示的な生成アダプタ、呼出し元の検査ツールを合わせて使います。

## 開発

```sh
npm run typecheck
npm test
npm run demo
```

CIはLinuxとWindowsでNode.js 22と24を対象にします。MITライセンスです。第三者のPDFや非公開会話は配布物に含めません。学術的な新規性は未確認です。

## English

TOMBO is an experimental tool for checking an AI agent's understanding. It separates draft answers and planned actions into claims, evidence, open questions, and probes. New evidence updates the external state of understanding.

Version 0.1 provides a TypeScript SDK, a CLI, an agent skill, two synthetic replay examples, and 48 synthetic scenarios for preparing comparisons. Real-model effectiveness has not been evaluated. TOMBO does not guarantee complete understanding, discovery of every unknown, or prevention of hallucinations.

### Run the replay examples

Use Node.js 22 or later. Clone this repository, run `npm ci`, `npm test`, and `npm run demo`. The npm package has not been published. The examples use fixed fictional account rules and an event-redelivery test. They do not call a model or measure detection ability.

The CLI commands above inspect a task, apply observations, produce a Markdown report, and replay a journal. Select `fixture` explicitly for the bundled examples. For other tasks, supply `--adapter file:/absolute/path/adapter.mjs`.

### Integrate the SDK

Use `createTombo({ adapter })`, then `inspect(packet)`, `update(state, observations)`, and `invalidate(state, input)`. The host selects and runs tools. TOMBO does not select providers, search services, shells, or external actions implicitly. A ready decision is not permission to execute an external action.

An adapter supplies `generate(input)` and returns a proposal plus usage. It proposes claims, lenses, gaps, probes, assessments, and resolutions rather than replacing the state. The public `GenerationAdapter` and `GenerationOutput` types define the contract. Explicit adapter modules run as trusted code. The host manages credentials, charges, data disclosure, cancellation, and tool execution.

`examples/http-adapter.mjs` connects to an authorised service that implements this proposal contract. It accepts HTTPS or local HTTP, refuses redirects, and reads its optional bearer credential from the environment. Copy `.env.example` to `.env`, configure the endpoint, and use the `--env-file` command above. Local HTTP contract tests exist; live-provider connectivity remains unverified.

### Preserve evidence and usage

Give every real execution a unique `executionId`. Reuse it for delivery retries, but use a new ID for another execution even when the result is identical. No search result is not evidence of absence. Withdrawn evidence reopens dependent gaps. Unknown costs remain unknown.

`FileJournal` owns atomic revision checks and append-only state events. The journal is authoritative; a JSON cache is replaceable. Journal events omit evidence passages and retain their references and hashes. Replay needs no model. The host must retrieve missing passages from authorised sources before rechecking them. Incomplete journals and stale locks require explicit recovery. State JSON may contain source passages, so keep sensitive material outside public files.

### Verification and limitations

Tests cover state invariants, usage, budgets, replay, concurrency conflicts, and actual CLI calls. Structural validation does not prove semantic correctness. Compare TOMBO with a general recheck using the same model, evidence, tools, and budgets. Keep evaluation annotations away from model inputs and use independent human assessment. Real-provider integration, comparative experiments, and statistical effectiveness claims remain unverified.

The agent skill is in `skills/tombo/SKILL.md`. Development checks are `npm run typecheck`, `npm test`, and `npm run demo`. CI targets Linux and Windows with Node.js 22 and 24. The project uses the MIT licence. No third-party PDF or private conversation is distributed. Academic novelty has not been established.
