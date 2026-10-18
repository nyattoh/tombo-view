# TOMBO Ask-Policy 正式設計仕様書 (docs/ask-policy.md)

- **初版策定日**: 2026-10-18
- **改定日**: 2026-10-18（PM最終点検 7点厳格整合・Formal R2準備版）
- **対象ブランチ**: `feat/ask-policy-20261018`
- **対象ベースコミット**: `f2ecc2e4ccbfe109596d9e156095fff7af76ea6a`
- **準拠規約**: `docs/ask-policy-work/locked-charter.md`（確定チャーター）、`D:/develop/control/policy/core-v2.0.md`
- **設計作者**: main/design（Google / antigravity / gemini-3.8-flash-medium）
- **状態**: 正式設計（実装可能・独立レビュー委任準備完了。本設計書自身による独立pass宣言は行わない）

---

## 1. 概要と確定目標 (Locked Goal)

### 1.1 背景と課題
TOMBO（トンボ）は、AIエージェントが自己の理解状態（`UnderstandingState`）を点検し、証拠（`Evidence`）と未確認事項（`Gap`）を構造的に管理しながら次の行動を決定論的（deterministic）に選択するシステムである。

現行実装（コミット `f2ecc2e` 時点の `src/core.ts` における `result()` 関数）では、利用者への問い合わせを表す判定（`needs_user_input`）は、以下の極めて狭い条件でのみ返却されていた：
1. 実行可能な外部プローブ（`probe`）が一切残存していない（`next.length === 0`）。
2. かつ、残存するすべての必須未確認事項（`gap where gap.importance === 'required' && gap.status !== 'resolved'`）の種類が `ambiguous_intent` である（`needed.every(gap => gap.kind === 'ambiguous_intent')`）。

この旧実装は、人間への問いかけ（`ask`）を「外部調査の手段が尽きた際の最後の手段（last resort）」として扱っており、以下の構造的課題を有していた：
- **目的・前提の曖昧さの放置**: 利用者の目的や優先順位そのものが曖昧である場合でも、無関係な外部プローブを先に実行して予算と時間を浪費する。
- **解決不能な証拠矛盾の放置**: 自動プローブでは原理的に解消できない重大な主張の衝突（例: 異なる正本仕様書間での矛盾対立）が発生しても、プローブを再試行し続け、最終的に `blocked`（`no_progress` または `capability_limit`）に倒れる。
- **人間専任事項の隠蔽**: 必須ギャップに `ambiguous_intent`（人間の意図確認）と枯渇済み `missing_fact` が混在する場合、`needed.every(...)` 条件が偽となり、人間が答えれば進むはずの事案が不当に `blocked` となる。
- **不要な問いの増加リスク**: 一方で、プローブで客観的に調べれば即座に判明する事実を安易に人間に尋ねると、人間の注意資源（attention）を毀損する。

### 1.2 確定目標 (Locked Goal)
TOMBOは各ラウンドにおいて、モデルの主観的申告（self-report: 「自信がある」「迷っている」等の自然言語）ではなく、理解状態における**観察可能な構造的シグナル（structural observable-state signals）**に基づき、次の5つの選択肢から自律的かつ決定論的に判断を行う：
$$\{ \text{proceed}, \text{check}, \text{ask}, \text{reframe}, \text{blocked} \}$$

ここで **`ask` は最後の手段ではなく、構造的条件が満たされた際に能動的に選ばれる第一級の能動的選択肢（first-class active choice）**として位置付けられる。

### 1.3 利用者の原意：自己の理解への主体的関心と判断分解
利用者は主体的に人に確認を取る行動を「AIが自己の理解に関心を持つ振る舞い」と捉えている。これはAIに主観的意識や好奇心を認めることではなく、工学的に「今何が分かっていて何が分かっていないか」「人の判断を仰ぐべき論点か」「見落としている前提や視点（レンズ）がないか」を構造的に識別し、目的達成に向けた判断を狭い単位に分解（typed decision decomposition）して行動する設計思想を指す。盲点の完全自動解消や万能の理解は求めず、根拠ある理解・未確定事項・矛盾・視点候補を構造状態として保持し、人間判断が必要な事項については無関係な外部プローブを無駄に尽くす前に速やかに `ask` を発火させる。

### 1.4 既存524件回帰テストに関する位置付け
本設計は既存SDK・型定義・レポート・ランナーの公開インターフェースおよび内部ワイヤ値を非破壊的に維持することを意図している。ただし、**「既存524テスト全pass」は本設計段階においては未実証の受入目標（unverified target）**である。設計作者自身がテスト通過を断定することはせず、独立設計レビュー通過後、実装担当者がTDD（RED $\to$ GREEN $\to$ 全件回帰）を通じて実証する。

---

## 2. 五選択肢の概念定義とSDK/ワイヤ値 1:1 写像契約

### 2.1 五選択肢の概念定義

| 選択肢 (Policy Choice) | 和名 | 概念的定義 | 主な構造トリガー |
| :--- | :--- | :--- | :--- |
| **`proceed`** | 進む | 目的達成に必要な必須要件がすべて検証・解決され、次の実行または回答へ安全に進む | 残存必須ギャップなし、未再考なし、保留アセスメントなし |
| **`check`** | 調べる | 環境（コード、文書、テスト、ログ等）から客観的に検証可能な要件に対し、実行可能なプローブを実行する | 検証可能必須ギャップあり、実行可能プローブあり |
| **`ask`** | 人に聞く | 人間しか知り得ない目的・優先度・価値判断・権限の欠落、または自動検査で解決不能な重大主張矛盾について人間に確認する | 人間専任ギャップ（目的・優先度・権限）、解決不能な主張対立（`disputed`） |
| **`reframe`** | 問い直す | 証拠の追加・反証や再考要求に基づき、前提レンズや目的解釈の再評価（再考）をクリティックに求める | 再考未完了（`!reflectionFresh`）、前提枠組み・レンズの更新要求 |
| **`blocked`** | 停止 | 予算超過、必要なプローブ能力の欠落、進行不能の反復などにより、自律的にも人間への問いでも前進不能 | 予算枯渇、能力限界、進行停止反復、候補除外上限 |

### 2.2 SDK型システム（`Decision`）との1:1ワイヤ写像およびランナー再考ループ整合

`src/types.ts` に定義された現行のワイヤ列挙型 `decisionSchema` は変更せず、完全な後方互換性を保持する：
```ts
export const decisionSchema = z.enum([
  'ready_for_requested_step',
  'needs_reflection',
  'needs_check',
  'needs_user_input',
  'blocked'
]);
export type Decision = z.infer<typeof decisionSchema>;
```

五選択肢は、既存の `Decision` ワイヤ値へ以下のように厳格に1対1写像される（本表は比較検証ツール `scripts/ask-policy-compare.mjs` における唯一の正規化正本である）：

| ポリシー選択肢 (Policy Choice) | SDKワイヤ値 (`state.decision`) | ランナー挙動 (`runner.ts:68-75`) |
| :--- | :--- | :--- |
| `proceed` | `'ready_for_requested_step'` | `status: 'completed'` で正常終了 |
| `check` | `'needs_check'` | `current.nextProbeIds` のプローブを実行し次回サイクルへ継続 |
| `ask` | `'needs_user_input'` | `status: 'stopped'`, `reason: 'needs_user_input'` で人間に制御返却・停止 |
| `reframe` | `'needs_reflection'` | `tombo.reflect()` を呼び出し再考サイクルを継続 |
| `blocked` | `'blocked'` | `status: 'stopped'`, `reason: stopReason` で安全停止 |

---

## 3. 観察可能な構造的シグナルの形式定義 (Structural Observable Signals)

### 3.1 シグナル1: 人間専任ギャップ（Human-Only Gaps）

#### 分類契約と厳格なスキーマ整合
`src/core.ts` の `checkState` における `triggerRefs` 検証（lines 125–153）では、有効な参照集合 `triggers` は以下のように厳格に定義されている：
$$\text{triggers} = \text{claims} \cup \text{evidences} \cup \text{conditionIds(state.task)}$$
ここで `conditionIds`（`src/core.ts:80-82`）は `{'task:goal', 'task:mode', ...task.successCriteria.map((_, i) => 'task:criterion:' + i)}` である。
**レンズID（`lensId`）は `triggerRefs` に含めることができず、含めると `checkState` で `invalid_input` 例外が発生する。**

また、単に `triggerRefs` に `user_statement` 種別の証拠が含まれていることや、`missing_fact` が `task:goal` を参照していることのみをもって「人間専任」と判定してはならない。コードや環境から確認可能な事実に関する利用者の発話は客観的プローブで確認すべきであり、安易に `ask` と判定すると不要な問い（unnecessary ask）を誘発する。

したがって、人間専任ギャップは以下の厳密な述語論理契約により判定される：

1. **基本契約と補助スキーマ**:
   人間専任要件は、ギャップ種別 **`g.kind === 'ambiguous_intent'`** を必須前提とする。
   補助スキーマとして後方互換オプショナルフィールド `humanRole` を導入する：
   ```ts
   export const humanRoleSchema = z.enum(['goal', 'priority', 'value', 'permission']).optional();
   ```
   **整合性規則**: `g.humanRole !== undefined` である場合、`g.kind === 'ambiguous_intent'` でなければならない（客観的事実ギャップに `humanRole` を付与することは不可）。
2. **早期人間確認述語 ($H_{early}$)**:
   未解決必須ギャップ $g \in G_{req}$ において、以下の条件をすべて満たすものを早期人間確認対象（$g \in H_{early}$）とする：
   $$g.\text{kind} === \text{'ambiguous_intent'} \land (g.\text{triggerRefs.includes}('task:goal') \lor g.\text{humanRole} \in \{\text{'goal'}, \text{'priority'}, \text{'value'}, \text{'permission'}\})$$
   これにより、目的そのもの、トレードオフ優先順位、価値判断、権限要求がプローブ先行に遮蔽されず `ask` に到達する。未関連の客観事実ギャップ（`missing_fact`）が単に `task:goal` を参照しているだけでは $H_{early}$ には決して合致しない。
3. **客観的能力限界との区別**:
   実行環境の機能欠落（bash不在、外部ネットワーク遮断等）は `kind: 'capability_limit'` とし、人間への問いではなく `blocked` の根拠とする。
4. **妥当な参照制約**:
   $g.\text{triggerRefs}$ の各要素 $r$ は、必ず以下を満たさなければならない：
   $$r \in \{ \text{'task:goal'}, \text{'task:mode'} \} \cup \{ \text{'task:criterion:'} + i \} \cup \text{state.evidence.map}(e \Rightarrow e.\text{id}) \cup \text{state.claims.map}(c \Rightarrow c.\text{id})$$

---

### 3.2 シグナル2: 自動プローブで解決不能な重大主張の矛盾（Unresolvable Contradictions in Goal-Important Claims）

#### `disputed` と `contradicted` の厳密な区別
`claimStatus()`（`src/core.ts:105-112`）における判定：
- `supports` と `refutes` の双方が同一スコープで存在 $\to$ `'disputed'`（証拠の対立・膠着）
- `refutes` のみが存在 $\to$ `'contradicted'`（単独反証・論駁）

単なる `contradicted` は仮説の論駁が確定した状態であり、矛盾の膠着ではない。したがって無条件に人間に `ask` してはならず、再考（`reframe`）または能力限界（`blocked`）へ導く。

#### ゴール重要主張 ($C_{goal}$) と解決不能矛盾 ($C_{contra}$)
主張 $c \in \text{state.claims}$ において：
1. **ゴール重要主張**: $c.\text{role} === \text{'answer_claim'}$、または未解決必須ギャップ $g \in G_{req}$ から参照されている（$g.\text{claimIds.includes}(c.\text{id})$）。
2. **解決不能矛盾 ($c \in C_{contra}$)**:
   $c$ がゴール重要主張であり、$c.\text{status} === \text{'disputed'}$ であり、かつ $c$ を参照する全必須ギャップに紐づくすべてのプローブ $p$ が非利用可能（`availableProbe(state, p) === false`、すなわち `complete`, `exhausted`, `unavailable`, `error`）であること。

この場合、自動プローブによる解決が原理的に尽きているため、独断推測を排して人間に裁定（arbitration）を仰ぐ `ask`（`needs_user_input`）を発火する。

---

### 3.3 シグナル3: ポリシー進捗履歴と反復進行停止（Policy Progress History & Repeated No-Progress）

#### 具体スキーマ定義 (`src/types.ts`)
```ts
export const policyOutcomeSchema = z.enum([
  'progress',
  'no_result',
  'unavailable',
  'error',
  'deferred',
  'invalid_output'
]);

export const policyHistorySchema = z.strictObject({
  consecutiveNoProgressRounds: count,
  lastUnderstandingHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recentOutcomes: z.array(policyOutcomeSchema).max(10),
  lastProgressAtRevision: count,
});
export type PolicyHistory = z.infer<typeof policyHistorySchema>;
```
`stateSchema`（`src/types.ts`）に `policyHistory: policyHistorySchema.optional()` を加法的（non-breaking）に追加する。旧ステートでは `undefined` であり、旧コードとの後方互換性を保持する。また `understandingHash` の計算式には含めないため、既存のハッシュ計算値への影響はない。モデルプロポーザルやクリティックによる直接書き込みはスキーマ上禁止され、コア関数のみが導出・更新する。

#### コア関数による更新ライフサイクル
1. **前進判定 ($P$)**:
   前進判定は `src/core.ts:609-613` の既存前進条件を基礎とし、操作種別に応じて以下のように定義される：
   $$P = \begin{cases}
   \text{hasNewEvidence} \lor \text{hasCorrection} \lor (\text{changesBetween}(\text{original}, \text{state}, \dots).\text{length} > 0) \lor \text{hasNewProbe} & (\text{operation} === \text{'update'}) \\
   (\text{operation} === \text{'reflect'}) \land (\text{changesBetween}(\text{original}, \text{candidate}, \dots).\text{length} > 0 \lor (\text{receipt.completion} === \text{'completed'} \land \text{fresh})) & (\text{operation} === \text{'reflect'}) \\
   \text{changesBetween}(\text{original}, \text{state}, \dots).\text{length} > 0 & (\text{operation} === \text{'invalidate'}) \\
   \text{true} & (\text{operation} === \text{'inspect'})
   \end{cases}$$
   ※単に既存ステートに前回の `fresh completed receipt` が残っているだけでは、無変化の `update` において $P=\text{true}$ とはならない。今回実行された操作によって新しく状態が進んだ場合のみ $P=\text{true}$ となる。
   ※また、観測に静的スナップショット重複（`repeated.size > 0`）が含まれる場合であっても、同一バッチ内で有効な新規候補（`changes.length > 0`）、アセスメント修正（`hasCorrection`）、他プローブの追加（`hasNewProbe`）、新規証拠（`hasNewEvidence`）が存在する場合は、既存コード通り前進（$P=\text{true}$）を優先し、静的重複のみをもって無条件に非前進（$P=\text{false}$）とは判定しない。
2. **完全再配信・保留・再開の厳密な区別 (Free Replay vs Pending Re-evaluation)**:
   - **完全再配信（Free Replay）**:
     `pendingAssessmentExecutionIds` が存在しない（または `deferAssessment === true`）条件下において、観測バッチの全要素が既存の適用済み実行と完全に一致する場合：
     $$\text{observations.length} > 0 \land \text{observations.every}(o \Rightarrow \text{original.appliedExecutions.some}(e \Rightarrow e.\text{executionId} === o.\text{executionId} \land e.\text{payloadHash} === \text{hashPassage}(\text{canonical}(o))))$$
     この場合は `src/core.ts:542` 通り元ステートをそのまま返却し、コスト・使用量を計上せず、`consecutiveNoProgressRounds` も増加させない（完全維持）。
   - **保留アセスメントの評価再開**:
     `src/core.ts:539-546` の仕様に準拠し、保留アセスメントが存在する場合（`pending.length > 0`）、元ペイロードはステート内に保持されないため空観測からの復元はできず、空観測は `invalid_input` となる。利用者が同ID・同ペイロードの完全保留バッチを再送し、`deferAssessment !== true` で実行した場合に、そのバッチが `assessmentObservations` として一度だけ評価再開される。この再送では新規ツール時間・呼出はゼロだが、モデル呼出・ラウンド等の再評価費用は実計上され、`policyHistory` は受理されたアセスメント結果に基づき一度だけ更新される。
   - **新規executionIdの静的重複スナップショット**:
     新規 `executionId` による静的重複（`repeated.size > 0`）であり他に前進がない場合は、実コスト・使用量が計上され、$P=\text{false}$ であるため `consecutiveNoProgressRounds` を 1 インクリメントする。
   - **保留アセスメント保存（`deferAssessment: true`）**:
     アセスメント評価待ちとして保留される場合、`consecutiveNoProgressRounds` はホールド（維持）する。ただし新証拠の登録により `understandingHash` が変化するため、`lastUnderstandingHash = understandingHash(state)` は更新する。`recentOutcomes` には `'deferred'` を追加する。
3. **終端ハッシュ更新と状態遷移表**:
   `inspect`, `update`, `reflect`, `invalidate` のいずれにおいても、内部プロポーザル試行中ではなく、**プロポーザルが受理され終端 revision および state が確定した時点**で、コアがメタデータを導出し終端 `lastUnderstandingHash = understandingHash(state)` を記録する。内部候補生成中は古いハッシュとの整合性検査をスキップし、既存の構造検証を保持する。モデルプロポーザルやクリティックによるメタデータ直接書き込みはスキーマ上禁止される。

   レガシー状態（`policyHistory` が存在しない旧ステート）を初めて通常操作で採用する場合、カウンター $c=0$, $L=\text{original.revision}$ から開始する。完全再送時はレガシー状態をそのまま返却しメタデータは生成しない。

| operation / event | counter ($c$) | lastProgressAtRevision ($L$) | lastUnderstandingHash ($H$) | recentOutcomes (最大10件FIFO) |
|---|:---:|:---:|:---:|---|
| **inspect 受理終端** | 0 | $rev$ | $H$ | `['progress']` |
| **受理 update assessment 又は completed reflect で $P=\text{true}$** | 0 | $rev$ | $H$ | append progress |
| **受理 update assessment 又は completed reflect で $P=\text{false}$** | $c + 1$ | $L$ | $H$ | append one normalized nonprogress (error > unavailable > no_result) |
| **deferAssessment 保存** | $c$ | $L$ | $H$ | append deferred |
| **同ID・同payload完全再送、pending評価再開ではない** | 変更なし | 変更なし | 変更なし | 変更なし（元state返却） |
| **invalid / rejected proposal / 致命停止 / reflect inconclusive** | $c$ | $L$ | 返却stateの $H$ へrefresh | 保持（修復後 accepted なら上の accepted 規則一回だけ） |
| **invalidate により意味 $H$ が変化** | 0 | $rev$ | $H$ | append progress、no-op invalidate は元state維持 |

4. **非前進 outcome の正規化と公開バリデーション規則**:
   - 非前進更新時（$P=\text{false}$）に `recentOutcomes` へ追加する値は、バッチ内に `'error'` があれば `'error'`、次いで `'unavailable'` があれば `'unavailable'`、それ以外は `'no_result'` とする固定優先度で決定論的に1件のみ追加する。配列長が10を超える場合は先頭（最古）を切り捨てる（FIFO）。
   - 公開バリデーション規則:
     - `history` 存在時、`lastUnderstandingHash !== null` かつ `lastUnderstandingHash === understandingHash(state)`
     - $0 \le L \le rev$（$L = \text{lastProgressAtRevision}$, $rev = \text{state.revision}$）
     - $0 \le c \le rev - L$（$c = \text{consecutiveNoProgressRounds}$）
     - `recentOutcomes.length <= 10`
   - `understandingHash` 計算式には本メタデータ（`policyHistory`, `reflectionEffects`）を含めず、既存のハッシュ不変性を保証する。
5. **反復進行停止フラグ ($NoProg$)**:
   $$NoProg = (\text{state.policyHistory} \ne \text{undefined} \land \text{state.policyHistory.consecutiveNoProgressRounds} \ge 2)$$
   **注意**: `state.stopReason === 'no_progress'` であること単体をもって $NoProg$ とみなしてはならない。

---

### 3.4 シグナル4: 目的解釈を変更する再考（Reflection Changing Goal Interpretation）

#### 具体スキーマ定義 (`src/types.ts`)
```ts
export const reflectionEffectsSchema = z.strictObject({
  binding: reflectionBindingSchema,
  appliedRevision: count,
  addedGoalGapIds: ids,
  addedLensIds: ids,
});
export type ReflectionEffects = z.infer<typeof reflectionEffectsSchema>;
```
`stateSchema` に `reflectionEffects: reflectionEffectsSchema.optional()` を追加する。本スキーマはモデルプロポーザルやクリティック出力（`reflectionProposalSchema` は `lenses`, `gaps`, `probes` のみ）に含めることはできず、コアの `reflect()` 実行成功時のみ導出・記録される。

#### 参照整合性バリデーション規則
`checkState` において、`state.reflectionEffects` が存在する場合、以下を厳格に検証する：
1. `state.reflection`（レシート）が必ず存在すること。
2. `effects.binding.taskId === state.reflection.binding.taskId`
3. `effects.binding.basedRevision === state.reflection.binding.basedRevision`
4. `effects.binding.understandingHash === state.reflection.binding.understandingHash`
5. `effects.appliedRevision === state.reflection.binding.basedRevision + 1` かつ `effects.appliedRevision <= state.revision`
6. `effects.addedGoalGapIds` の全要素はユニークであり、かつ現行の必須タスクゴールギャップ（$g \in \text{state.gaps}$ where $g.\text{importance} === \text{'required'} \land g.\text{triggerRefs.includes}('task:goal')$）として存在すること。
7. `effects.addedLensIds` の全要素はユニークであり、かつ現行の能動レンズ（$l \in \text{state.lenses}$ where $l.\text{origin} === \text{'proposed'}$）として存在すること。
※新設ギャップによりレシート自身が stale 化するため、`reflectionFresh(state) === true` はバリデーション条件としない。

#### 保持・失効の単一規則 (Single Lifecycle Rule)
- **置換 (Replace)**: 新たな `reflect()` が成功した場合、新しい `reflectionEffects` で完全に上書き置換される。
- **失効 (Clear)**:
  - 受理された NON-DEFER `update()` または `invalidate()` において、今回の操作の **before $H$ と after $H$ が異なる場合**、直ちに `delete state.reflectionEffects` を実行して消去する（`effects.binding.understandingHash` は reflect 前の $H$ であり新ギャップ新設直後から古いため、binding $H$ との直接比較ではなく、今回の操作前後での $H$ 変化により判別する）。
  - または参照先のギャップ・レンズが解決・削除・失効して参照整合性を失った場合も消去する。
  - `reflect` が `inconclusive` または致命的エラーで失敗した場合、新規 effects は生成せず、もしレシートの binding が変化して既存 effects と不一致になった場合は既存 effects を消去する。
- **保持 (Retain)**: 単なる完全再配信（pure replay）、保留（deferAssessment）、または no-op な失敗試行においては、参照整合性が保たれている限り保持される。

#### 決定表接続述語
- $E_{human} = \exists g \in \text{effects.addedGoalGapIds} \text{ s.t. } g \in G_{req} \land g.\text{kind} === \text{'ambiguous_intent'}$
- $E_{fact} = \exists g \in \text{effects.addedGoalGapIds} \text{ s.t. } g \in G_{req} \land g.\text{kind} \ne \text{'ambiguous_intent'} \land \text{hasAvailableProbe}(g)$
※新設ゴールギャップが人間専任なら `ask`、事実なら `check` へ明示的に分岐し、レンズのみ追加（$addedGoalGapIds === \emptyset$）の場合は自動 `ask` を発火させない。

---

## 4. 問いと調べの順序・コスト評価契約 (Ask vs Check Ordering & Cost)

### 4.1 決定論的優先規則
1. **保留アセスメント・予算・候補上限の最優先停止**:
   保留アセスメント評価待ち、予算枯渇、除外上限は、いかなる `ask` や `check` よりも先に停止する。
2. **反復進行停止時の打開（NoProg Ask）**:
   プローブを反復しても前進せず膠着している場合（$NoProg === \text{true}$）、人間に確認すべき論点（$G_{human} \ne \emptyset$ または $C_{contra} \ne \emptyset$）があれば、無駄な再プローブ（`check`）を遮断して直ちに `ask` を発火する。
3. **再考由来のゴール変更対応**:
   再考によって新設されたゴール必須ギャップが人間専任（$E_{human}$）なら直ちに `ask`、客観的事実（$E_{fact}$）なら `check` を選択する。レンズの新設のみ（$addedGoalGapIds === \emptyset$）では自動 `ask` は発火しない。
4. **環境から調べられることは調べ、人間に聞かない（Check first for verifiable facts）**:
   未解決の必須ギャップに実行可能プローブが存在する場合、客観的事実の調査（`check`）を先行させ、不要な問い（unnecessary ask）を抑止する。
5. **人間にしか決められないことは速やかに聞き、無駄な調査をしない（Ask first for human values/goals）**:
   早期人間確認述語（$H_{early}$）に合致する人間専任ギャップは、外部プローブに先行して直ちに `ask` を選択する。
   - **質問内容と次行動の具体化**: 問い（`ask`）は単なる漠然とした確認ではなく、現行スキーマの `gap.question`（不明点）および `gap.whyItMatters`（重要性・理由）に基づき、利用者の回答によって次に選択すべき実行案や調査プローブがどう具体的に切り替わるかを明確化する（例: 優先順位の未確定に対し「速度優先か費用優先か」を問い、回答に応じて高速アルゴリズムまたは軽量バッチ処理を選択する）。
   - **不要な再問いの抑止**: 既に有効に承認・解決済みの要件（`gap.status === 'resolved'`）や、環境から客観的に調べられる事実（`missing_fact`）について安易に再問合せを行わない。
6. **自動調査の限界で生じた矛盾は、人間に裁定を仰ぐ（Ask when probes fail on contradictions）**:
   プローブを尽くしても解消しない重大な主張矛盾（$C_{contra}$）は、独断推測を排して人間に判断を仰ぐ。

### 4.2 コスト評価と決定論的比較契約
本マイルストーンにおいては、外部モデルAPIへのトークン計測や実行レイテンシ実測は行わない（チャーター明示禁止事項）。
比較検証（`scripts/ask-policy-compare.mjs`）におけるメトリクスは、以下の決定論的指標として定義される：
- **偽陽性（False Positives for Ask, $FP_{\text{ask}}$）**:
  合意アクションが非ask（`check`, `proceed`, `reframe`, `blocked`）である全ケースにおいて、ポリシーが誤って `ask` を出力した件数（$FP_{\text{ask}} = \sum [y_{\text{consensus}} \ne \text{'ask'} \land \hat{y} = \text{'ask'}]$）。
- **不要Ask対照群誤発火数（Control Violations）**:
  客観的プローブで解決可能な対照フィクスチャ群（unnecessary-ask control subset, $\ge 9$件）において誤って `ask` を発火した件数（$FP_{\text{ask}}$ の特定部分集合）。
- **偽陰性（False Negatives for Ask, $FN_{\text{ask}}$）**:
  合意アクションが `ask` であるケースにおいて、ポリシーが `ask` 以外を出力した件数。
- **再現率（Ask Recall）**:
  $$TP_{\text{ask}} / (TP_{\text{ask}} + FN_{\text{ask}})$$
- **適合率（Ask Precision）**:
  $$TP_{\text{ask}} / (TP_{\text{ask}} + FP_{\text{ask}})$$

---

## 5. 完全決定表 (Complete Decision Table)

状態から五選択肢への遷移を決定論的に導出する完全決定表を定める。
上から順に評価され、**最初に合致した規則が排他的に適用**される。

### 記号定義
- $G_{req}$: 未解決の必須ギャップ集合 $\{ g \in \text{state.gaps} \mid g.\text{importance} === \text{'required'} \land g.\text{status} \ne \text{'resolved'} \}$
- $G_{human}$: $G_{req}$ のうち人間専任ギャップ（$g.\text{kind} === \text{'ambiguous_intent'}$）
- $H_{early}$: 早期人間確認述語を満たすギャップ集合（第3.1節参照）
- $P_{avail}$: $G_{req}$ に紐づく利用可能なプローブ集合 $\{ p \in \text{state.probes} \mid \text{availableProbe}(\text{state}, p) \land p.\text{gapIds.some}(id \Rightarrow G_{req}.\text{some}(g \Rightarrow g.\text{id} === id)) \}$
- $C_{contra}$: 解決不能なゴール重要主張の矛盾集合（第3.2節参照）
- $Ref_{fresh}$: クリティック再考鮮度フラグ（`reflectionFresh(state)`）
- $NoProg$: 反復進行停止フラグ（`state.policyHistory?.consecutiveNoProgressRounds >= 2`）
- $PendingAssess$: 保留アセスメント実行ID集合（`state.pendingAssessmentExecutionIds`）
- $FatalStop$: 致命的停止理由（`state.stopReason !== null && state.stopReason !== 'no_progress'`）
- $LegacyStop$: レガシー停止ガード（`state.stopReason === 'no_progress' && (state.policyHistory === undefined || !NoProg)`）
- $E_{human}, E_{fact}$: 再考プロベナンス述語（第3.4節参照）

### 決定表本文

| 優先度 | 条件論理式 | ポリシー選択 (Policy) | SDK `decision` | `stopReason` | `nextProbeIds` | `userQuestions` | 仕様説明・旧実装互換根拠 |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **1** | `excludedCandidates?.some(item => item.importance === 'required')` | `blocked` | `'blocked'` | `'candidate_limit'` | `[]` | `[]` | 必須候補の除外上限到達（旧 `core.ts:213` 完全一致） |
| **2** | `state.task.reflectionRequired && (FatalStop \|\| LegacyStop)` | `blocked` | `'blocked'` | 既存の `stopReason` | `[]` | `[]` | 再考必須タスクでの致命的停止またはレガシー停止保持（旧 `core.ts:214` 整合。$NoProg === \text{true}$ 時のみ新打開askを許可） |
| **3** | $PendingAssess \ne \text{undefined} \land PendingAssess.\text{length} > 0$ | `blocked` | `'blocked'` | 既存の `stopReason`（nullならnull） | `[]` | `[]` | **【保留アセスメント保護ガード】** 全 `ask/check/ready` に先行して停止。`stopReason` を汚染せず保持し、次期 `update` でアセスメント適用時に `pending` 削除により復帰可能とする |
| **4** | $G_{req} === \emptyset$ かつ $PendingAssess === \text{undefined}$ かつ $C_{contra} === \emptyset$ | （下記4a〜4cへ分岐） | - | - | - | - | **【全必須ギャップ解決完了時（解決不能矛盾なし）】** 旧 `core.ts:215-225` の特例・予算規則を完全に保持（$NoProg$ の影響を受けない）。解決不能矛盾 $C_{contra}$ がある場合は本特例を適用せず、一般停止・予算枯渇を経て後続の矛盾裁定Askへ導出する（チャーター新意図との整合） |
| 4a | `reflectionRequired === true` かつ `proposedAnswer` あり かつ `claims.length === 0` | `blocked` | `'blocked'` | `'no_progress'` | `[]` | `[]` | 主張のない回答案の停止特例（旧 `core.ts:216` 完全一致） |
| 4b | `reflectionRequired === true` かつ $Ref_{fresh} === \text{false}$ | **`reframe`** | `'needs_reflection'` または `'blocked'` | 下記参照 | `[]` | `[]` | **【旧再考予算特例】** `modelCalls >= maxModelCalls`、`toolCalls > maxToolCalls`（厳密大なり）、`elapsedMs >= maxElapsedMs`、`maxOutputTokensPerCall === 0`、または費用上限到達時は `'blocked'` (`'budget_exhausted'`)。予算残存時は `'needs_reflection'`（旧 `core.ts:217-224` 完全保持。round上限は再考特例として免除） |
| 4c | 上記以外（再考完了または再考不要） | **`proceed`** | `'ready_for_requested_step'` | `null` | `[]` | `[]` | 次ステップ進行承認（旧 `core.ts:225` 完全一致） |
| **5** | $FatalStop \lor LegacyStop$ | `blocked` | `'blocked'` | 既存の `stopReason` | `[]` | `[]` | 致命的停止またはレガシー停止理由の保持（旧 `core.ts:226` 完全一致） |
| **6** | `exhausted(state, true)`（一般予算枯渇） | `blocked` | `'blocked'` | `'budget_exhausted'` | `[]` | `[]` | 一般予算（ラウンド、モデル、ツール、時間、費用）枯渇（旧 `core.ts:227` 完全一致） |
| **7** | $NoProg === \text{true}$（反復進行停止） | （下記7a〜7bへ分岐） | - | - | - | - | **【反復進行停止の打開（最優先到達）】** 一般ask/checkに先行して膠着を判定 |
| 7a | 人間確認論点（$G_{human} \ne \emptyset$ または $C_{contra} \ne \emptyset$）あり | **`ask`** | `'needs_user_input'` | `null` | `[]` | 該当する質問文 | **【能動的打開Ask】** 2ラウンド連続非前進時、プローブを再試行せず直ちに人間に打開を仰ぐ |
| 7b | 人間に確認すべき論点なし | `blocked` | `'blocked'` | `'no_progress'` | `[]` | `[]` | 安全停止 |
| **8** | $E_{human} === \text{true}$ | **`ask`** | `'needs_user_input'` | `null` | `[]` | 該当ゴールギャップ質問文 | **【再考由来の人間ゴールAsk】** クリティック再考で新設された人間専任ゴールギャップへの直ちの問い合わせ |
| **9** | $H_{early} \ne \emptyset$ | **`ask`** | `'needs_user_input'` | `null` | `[]` | 当該人間専任ギャップ質問文 | **【早期能動Ask】** 目的・優先度・価値・権限の欠落は、プローブに先行して直ちに人間に確認する |
| **10** | $E_{fact} === \text{true}$ | **`check`** | `'needs_check'` | `null` | 上位最大3件のプローブID | `[]` | **【再考由来の事実Check】** クリティック再考で新設された事実ギャップの調査先行 |
| **11** | $P_{avail} \ne \emptyset$（利用可能プローブあり） | **`check`** | `'needs_check'` | `null` | 上位最大3件のプローブID（優先ソート済） | `[]` | **【調べの優先】** 客観的事実は環境プローブで調査し、不要な問いを厳格に抑止（旧 `core.ts:228` 完全一致） |
| **12** | $C_{contra} \ne \emptyset$（プローブ解決不能な重大矛盾あり） | **`ask`** | `'needs_user_input'` | `null` | `[]` | 矛盾主張の調停質問文 | **【矛盾の裁定Ask】** プローブが尽きた証拠対立は独断推測せず人間に判断を仰ぐ |
| **13** | $G_{human} \ne \emptyset$（残存する人間専任ギャップあり） | **`ask`** | `'needs_user_input'` | `null` | `[]` | 当該人間専任ギャップ質問文 | プローブ完了後に残存した意図・選好の確認 |
| **14** | $G_{req} \ne \emptyset$ かつ $P_{avail} === \emptyset$ かつ $G_{human} === \emptyset$ | `blocked` | `'blocked'` | 下記参照 | `[]` | `[]` | 調査も質問も不能な行き詰まり（旧 `core.ts:230` 完全一致） |
| 14a | 該当ギャップのプローブが `exhausted` を含む | `blocked` | `'blocked'` | `'no_progress'` | `[]` | `[]` | 初回プローブ試行回数上限枯渇 |
| 14b | 上記以外（プローブ未定義または能力不足） | `blocked` | `'blocked'` | `'capability_limit'` | `[]` | `[]` | 実行環境の能力不足 |

---

## 6. 評価データセットと入出力完全分離契約

### 6.1 フィクスチャ契約 (`evaluation/ask-policy-cases.json`)
モデル評価および決定論的比較スクリプトに渡されるフィクスチャは、**純粋な観察可能入力（inspectable state / packet fixture）のみ**で構成される。

#### 漏洩防止契約 (Anti-Leakage Contract)
- `expectedAction`, `expectedDecision`, `authorIntent`, `authorIntentAction`, `groundTruth`, `targetAction`, `label`, `isControl` 等の**正解・期待判断・作者意図・対照群フラグを示すフィールドは一切含めてはならない**。
- `family` 名や `caseId` に正解アクション（`ask`, `check`, `proceed`, `reframe`, `blocked`）を連想させる文字列を含めてはならない（中立ID命名: `dev-sync-01`, `auto-pipeline-02` 等）。
- ケース作成者（case authors）本人はブラインド注釈者には参加させない。
- 期待アクション（`expectedAction = consensusAction`）は、モデルから隔離された別ファイル `evaluation/ask-policy-annotations.json` にのみ格納する。
- 作者意図・対照フラグは、作者意図専用ファイル `evaluation/ask-policy-author-intent.json` に完全に分離して保管する。

#### フィクスチャ整合性・バリデーション契約
各ケースフィクスチャは、以下の検証テストをすべて通過しなければならない：
1. `canonical(input.packet) === canonical(input.state.task)`（深層同値性）
2. `input.packet.taskId === input.state.taskId`
3. 新SDKによる検証: `validateState(input.state)` が例外なく成功すること。
4. 旧SDK射影による検証: `validateState(projectToOldSchema(input.state))` が旧 `f2ecc2e:src/core.ts` の `validateState` を例外なく成功すること。

#### フィクスチャのスキーマ定義
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AskPolicyCaseFixture",
  "type": "object",
  "required": ["caseId", "domain", "input"],
  "properties": {
    "caseId": { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "domain": { "type": "string", "enum": ["development", "automation", "research"] },
    "input": {
      "type": "object",
      "required": ["packet", "state"],
      "properties": {
        "packet": { "$ref": "#/definitions/TaskPacket" },
        "state": { "$ref": "#/definitions/UnderstandingState" }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

#### 作者意図専用ファイルスキーマ (`evaluation/ask-policy-author-intent.json`)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AskPolicyAuthorIntent",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["caseId", "authorIntentAction", "isControl"],
    "properties": {
      "caseId": { "type": "string" },
      "authorIntentAction": { "type": "string", "enum": ["proceed", "check", "ask", "reframe", "blocked"] },
      "isControl": { "type": "boolean" },
      "rationale": { "type": "string" }
    },
    "additionalProperties": false
  }
}
```

### 6.2 ケース分布要件（合計60件）
- **主要4アクション均等配分**:
  - `proceed`: 12件（各ドメイン4件）
  - `check`: 12件（各ドメイン4件）
  - `ask`: 12件（各ドメイン4件）
  - `reframe`: 12件（各ドメイン4件）
- **対照群（Stop-Gate Control）**:
  - `blocked`: 12件（各ドメイン4件。予算枯渇、能力限界、除外上限、進行停止）
- **3ドメイン**:
  - `development`（ソフトウェア変更・コード修正）: 20件
  - `automation`（業務自動化・CI/CD・データ連携）: 20件
  - `research`（調査・ドキュメント精査・RAG）: 20件
- **不要Ask対照群 (Unnecessary-Ask Controls)**:
  `check/proceed/reframe` の各ケース中に、客観的事実がプローブで判明するケース（計9件以上）を必ず含め、不要な `ask` の抑止能力を検証する。

---

## 7. 3ベンダー独立ブラインド注釈と合意形成契約

### 7.1 注釈隔離プロトコル
- 3注釈者は**異なる3つのモデルベンダー**から選定される（Google, OpenAI, NVIDIA 等。Claude系は完全除外）。
- 各注釈者へは、固定された中立プロンプト（Neutral Blind Rubric）と `input` フィクスチャのみを渡す。リポジトリ探索や他ファイルの閲覧は禁止し、単一の固定ペイロードとしてタスクに渡す。
- プロバイダ、モデル名、推論effort、タスクハンドル、プロンプトハッシュ等の実行メタデータは、ケース入力から分離された **PM sidecar provenance**（`evaluation/ask-policy-blind/provenance.json`）に記録する。
- NVIDIAは小シャードに分割して実ラベル出力を必須とし、2ベンダーのみの合意を3ベンダーと偽ってはならない。
- 生注釈結果はベンダー別ファイルに隔離保存する：
  - `evaluation/ask-policy-blind/vendor-google.json`
  - `evaluation/ask-policy-blind/vendor-openai.json`
  - `evaluation/ask-policy-blind/vendor-nvidia.json`

#### 生注釈スキーマ (`vendor-*.json`)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "VendorRawAnnotation",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["caseId", "action", "reasonPath", "vendor", "model"],
    "properties": {
      "caseId": { "type": "string" },
      "action": { "type": "string", "enum": ["proceed", "check", "ask", "reframe", "blocked"] },
      "reasonPath": { "type": "string" },
      "vendor": { "type": "string" },
      "model": { "type": "string" }
    },
    "additionalProperties": false
  }
}
```

### 7.2 中立アノテーションルーブリック (Neutral Blind Rubric)
注釈モデルへ提示する固定プロンプト本文：
```text
You are evaluating an autonomous AI agent's understanding state on a single task.
Given the task packet and understanding state, determine which of the following 5 actions the agent should take next:
- 'proceed': All required items are verified; safe to advance to the requested execution/answer.
- 'check': Objective verifiable facts remain unverified and executable probes exist; run probes first.
- 'ask': Missing human-only requirements (intent, priorities, values, permissions) or unresolvable contradictions between evidence; ask the human user.
- 'reframe': Understanding needs critique or reconsideration before proceeding.
- 'blocked': Execution budget exhausted, missing capabilities, or repeated lack of progress; safely stop.

Respond strictly in valid JSON format:
{
  "action": "proceed" | "check" | "ask" | "reframe" | "blocked",
  "reasonPath": "<concise path or entity id in the input state justifying the choice>"
}
```

### 7.3 全員一致合意 (Unanimous Consensus) と注釈統合契約
- **主要ターゲット**:
  3ベンダーすべての判定が**全員一致（3/3 unanimous）したケースのみ**を主要メトリクス母集団（$N_{\text{consensus}}$）とし、`expectedAction = consensusAction` とする。合意に至らなかったケースは `expectedAction: null` とする。
- **作者意図との分離**:
  作者意図（`authorIntentAction`）と3/3全員一致合意が食い違う場合、**全員一致合意（`consensusAction`）を優先**してメトリクスを算出し、作者意図との差分は `authorIntentDiffers: true` として記録する。
- **多数決の排除**:
  2対1の多数決によって不一致ケースを合意とみなすことは厳禁とする。
- **再試行条件**:
  JSON構文不正時のみ最大1回再試行を認める。再試行後も無効な場合は `invalid_output` として合意除外とする。
- **不一致の記録**:
  合意に至らなかった全ケースは `evaluation/ask-policy-disagreements.json` に隔離記録する。

#### 不一致記録ファイル例 (`evaluation/ask-policy-disagreements.json`)
```json
[
  {
    "caseId": "dev-conflict-04",
    "votes": {
      "google": "ask",
      "openai": "check",
      "nvidia": "ask"
    },
    "reason": "disagreement between check and ask on probe exhaustion boundary"
  }
]
```

#### アノテーション統合スキーマ (`evaluation/ask-policy-annotations.json`)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AskPolicyAnnotations",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["caseId", "expectedAction", "consensusAction", "authorIntentAction", "unanimous", "authorIntentDiffers"],
    "properties": {
      "caseId": { "type": "string" },
      "expectedAction": { "type": ["string", "null"], "enum": ["proceed", "check", "ask", "reframe", "blocked", null] },
      "consensusAction": { "type": ["string", "null"], "enum": ["proceed", "check", "ask", "reframe", "blocked", null] },
      "authorIntentAction": { "type": "string", "enum": ["proceed", "check", "ask", "reframe", "blocked"] },
      "unanimous": { "type": "boolean" },
      "authorIntentDiffers": { "type": "boolean" }
    },
    "additionalProperties": false
  }
}
```

---

## 8. 旧ベースライン exact snapshot 実行と決定論的比較契約

### 8.1 スナップショットの配置と依存解決
ベースライン `f2ecc2e` の判定ロジックをバイト完全（byte-exact）に保存・実行するため、以下の構成をとる：
- **保存先**: `evaluation/ask-policy-baseline/f2ecc2e/src/`
  - `core.ts`: `git show f2ecc2e4ccbfe109596d9e156095fff7af76ea6a:src/core.ts` のバイト完全コピー
  - `types.ts`: `git show f2ecc2e4ccbfe109596d9e156095fff7af76ea6a:src/types.ts` のバイト完全コピー
  （`core.ts` 内の内部依存は `./types.js` のみであり、同ディレクトリに揃えることで完全解決）
- **検証記録**:
  スナップショットの Git Blob Object ID および展開後 SHA-256 ハッシュを比較レポートに必ず記録する。

### 8.2 ブリッジモジュール生成とビルド境界
旧 `core.ts` において `result` はエクスポートされていない内部関数である。これを解決するため、以下の手順を固定する：
1. **生成ブリッジモジュール**:
   比較実行時、`evaluation/ask-policy-baseline/f2ecc2e/.generated/` ディレクトリに、`src/core.ts` の末尾に一行のみ `export { result as evaluateBaselinePolicy };` を付加した `core-bridge.ts` を出力する。
2. **依存ファイル群の同ディレクトリトランスパイル**:
   `src/types.ts` も同時に `.generated/types.ts` へコピーし、既存の `typescript` パッケージの `transpileModule` API（`target: ES2022, module: NodeNext`）を用いて、`.generated/core-bridge.js` および `.generated/types.js` を生成する。これにより相対インポート `./types.js` の解決失敗（`ERR_MODULE_NOT_FOUND`）を完全に排除する。
3. **Git管理境界**:
   `src/` 配下のスナップショットファイルはGit管理し、`.generated/` 配下の自動生成成果物はGit管理外（`.gitignore`）とする。

### 8.3 公開ポリシー判定入口 (`evaluatePolicy`) と旧射影
新コード（`src/core.ts`）に公開入口を定義する：
```ts
export function evaluatePolicy(inputState: UnderstandingState): InspectionResult {
  const state = structuredClone(inputState);
  const validated = validateState(state);
  return result(validated, []);
}
```
旧ベースライン判定実行時には、新設オプショナルフィールドを除去する明示的射影関数 `projectToOldSchema(state)` を適用した上で、クローンと旧 `validateState` を通して旧 `result` を実行する（モデル生成ラベルや作者意図から旧判定結果を逆生成することは厳禁とする）：
```ts
function projectToOldSchema(state: UnderstandingState): any {
  const copy = structuredClone(state);
  delete (copy as any).policyHistory;
  delete (copy as any).reflectionEffects;
  for (const gap of copy.gaps) delete (gap as any).humanRole;
  return copy;
}
```

### 8.4 決定論ゲート (Determinism Gate)
同一の入力フィクスチャ群に対して `scripts/ask-policy-compare.mjs` を2回連続で実行した際、出力される `evaluation/reports/ask-policy-compare.json` の**ファイルバイト列およびSHA-256ハッシュが完全に一致しなければならない**。
- 実行時刻、ホスト名、実行ミリ秒等の環境変動値はレポート本体（JSON）から除外し、決定論性を厳格に保証する。
- レポート内の `cases` 配列は `caseId` の昇順でソートしてシリアライズする。

### 8.5 比較レポート仕様 (`evaluation/reports/ask-policy-compare.json`)

#### 分母0の扱い
適合率・再現率等の算出において、**分母が0の場合は必ず `null` を出力**する（0 や NaN は禁止）。

#### レポートJSONスキーマ
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AskPolicyComparisonReport",
  "type": "object",
  "required": [
    "casesHash", "annotationsHash", "blindHashes", "baselineBlobSha",
    "baselineBridgeSha", "newVersionSha", "totalCases", "consensusCount",
    "disagreementCount", "metrics", "cases", "changedCases", "disagreements"
  ],
  "properties": {
    "casesHash": { "type": "string" },
    "annotationsHash": { "type": "string" },
    "blindHashes": { "type": "object" },
    "baselineBlobSha": { "type": "string" },
    "baselineBridgeSha": { "type": "string" },
    "newVersionSha": { "type": "string" },
    "totalCases": { "type": "integer" },
    "consensusCount": { "type": "integer" },
    "disagreementCount": { "type": "integer" },
    "metrics": {
      "type": "object",
      "required": ["old", "new"],
      "properties": {
        "old": { "$ref": "#/definitions/PolicyMetrics" },
        "new": { "$ref": "#/definitions/PolicyMetrics" }
      }
    },
    "cases": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["caseId", "domain", "oldWireDecision", "oldPolicyChoice", "newWireDecision", "newPolicyChoice", "consensusAction", "authorIntentAction", "unanimous"],
        "properties": {
          "caseId": { "type": "string" },
          "domain": { "type": "string" },
          "oldWireDecision": { "type": "string" },
          "oldPolicyChoice": { "type": "string" },
          "newWireDecision": { "type": "string" },
          "newPolicyChoice": { "type": "string" },
          "consensusAction": { "type": ["string", "null"] },
          "authorIntentAction": { "type": "string" },
          "unanimous": { "type": "boolean" }
        }
      }
    },
    "changedCases": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["caseId", "oldPolicyChoice", "newPolicyChoice", "consensusAction", "authorIntentAction"],
        "properties": {
          "caseId": { "type": "string" },
          "oldPolicyChoice": { "type": "string" },
          "newPolicyChoice": { "type": "string" },
          "consensusAction": { "type": ["string", "null"] },
          "authorIntentAction": { "type": "string" }
        }
      }
    },
    "disagreements": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["caseId", "votes", "reason"],
        "properties": {
          "caseId": { "type": "string" },
          "votes": { "type": "object" },
          "reason": { "type": "string" }
        }
      }
    }
  },
  "definitions": {
    "PolicyMetrics": {
      "type": "object",
      "required": ["tp", "fp", "fn", "precision", "recall", "unnecessaryAsks", "controlViolations"],
      "properties": {
        "tp": { "type": "integer" },
        "fp": { "type": "integer" },
        "fn": { "type": "integer" },
        "precision": { "type": ["number", "null"] },
        "recall": { "type": ["number", "null"] },
        "unnecessaryAsks": { "type": "integer" },
        "controlViolations": { "type": "integer" }
      }
    }
  }
}
```
※`unnecessaryAsks` は全 consensus ケースにおける $FP_{\text{ask}}$（非ask合意に対するask判定件数）であり、`controlViolations` は対照群ケース（unnecessary-ask control subset）における誤発火件数である。`changedCases` は `cases` のうち `oldPolicyChoice !== newPolicyChoice` である厳密な部分集合である。

---

## 9. ファイル所有権と責務境界 (Read/Write Ownership)

| パス / 成果物 | 排他的書き込み所有者 (Exclusive Writer) | 読み取り者 | 前提・受入条件 |
| :--- | :--- | :--- | :--- |
| `docs/ask-policy.md` | **設計作者 (main/design: Google)** | 全員 | 本設計書。設計修正フェーズにおける唯一の書き込み対象 |
| `docs/ask-policy-work/task-state.json` | **PM (goal_pm)** | 全員 | 設計者は編集禁止。タスク状態・ルーティング記録 |
| `docs/ask-policy-work/pm-progress.md` | **PM (goal_pm)** | 全員 | 設計者は編集禁止。進捗記録 |
| `evaluation/ask-policy-cases.json` | **フィクスチャ作成者 (fixture owner)** | 全員 | 設計pass後。60件完全入力フィクスチャ |
| `evaluation/ask-policy-author-intent.json` | **フィクスチャ作成者 (fixture owner)** | PM、全員 | 作者意図・対照フラグ。注釈者から完全隔離 |
| `evaluation/ask-policy-annotations.json` | **アノテーション統合者 (annotation integrator)** | 比較スクリプト | 期待アクション格納。注釈者入力から完全隔離 |
| `evaluation/ask-policy-blind/vendor-*.json` | **各ベンダー注釈者 (3 vendor annotators)** | アノテーション統合者 | 各自の生出力のみ書き込み（固定payload入力、repo探索禁止） |
| `evaluation/ask-policy-blind/provenance.json`| **アノテーション統合者 (annotation integrator)** | PM、全員 | 注釈モデル・実行provenanceサイドカー |
| `evaluation/ask-policy-disagreements.json` | **アノテーション統合者 (annotation integrator)** | PM、全員 | 全員一致しなかった不一致全件 |
| `evaluation/README.md` | **アノテーション統合者 (annotation integrator)** | 全員 | 暫定性・非正解性の注記 |
| `evaluation/ask-policy-baseline/f2ecc2e/` | **比較担当者 (comparison owner)** | 比較スクリプト | `git show` からバイト完全コピー |
| `src/core.ts`, `src/types.ts` | **TDD実装担当者 (implementer)** | 全員 | 設計pass後。RED/GREEN/回帰サイクル |
| `scripts/ask-policy-compare.mjs` | **比較担当者 (comparison owner)** | 全員 | 設計pass後。旧新決定論的比較 |
| `evaluation/reports/ask-policy-compare.json`| **スクリプト自動生成（比較担当者管理）** | PM、全員 | 比較スクリプトの出力成果物 |

---

## 10. PM最終点検 7項目への完全応答マトリクス

| 項目番号 | PM指摘論点 | 採否 | 具体契約・改訂箇所（docs/ask-policy.md） |
|:---:|---|:---:|---|
| **1** | `repeated.size === obs.length` の完全再配信誤判定の修正と静的重複・空観測再開の厳密化 | **採用** | **第3.3節 (L190–L210)**。`obs.every(o => appliedExecutions.some(e => e.executionId === o.executionId && e.payloadHash === hash(canonical(o))))` と同等の完全再配信判定を規定。新規ID静的重複は実コスト計上+非進捗インクリメント、空観測+pendingはinvalid_input。完全pendingバッチを同ID・同payloadで再送しdeferAssessment=falseなら一度評価しカウント。FreeReplayはpendingなし又は再defer時のみ。 |
| **2** | 前進判定 $P$ の過去レシート誤判定排除、終端ハッシュ確定タイミング、`recentOutcomes` 決定論化 | **採用** | **第3.3節 (L175–L188, L212–L228)**。$P$ における再考前進を `operation === 'reflect'` かつ今回新しく受理された candidate/receipt に限定。`lastUnderstandingHash` は終端状態確定時に更新。非前進時は常に `'no_result'` 等を1件追加し、最大10件をFIFO切り捨て。 |
| **3** | 「task:goal 等」の曖昧性排除と早期人間確認述語 $H_{early}$ の固定 | **採用** | **第3.1節 (L110–L128)**、**第5節 優先度9**。$H_{early} = (g.\text{kind} === \text{'ambiguous_intent'}) \land (g.\text{triggerRefs.includes}('task:goal') \lor g.\text{humanRole} \in \{\text{'goal'}, \text{'priority'}, \text{'value'}, \text{'permission'}\})$ と厳密固定。客観的事実ギャップは除外。 |
| **4** | `reflectionEffects` 参照整合性バリデーション完全化と決定表接続（$E_{human}, E_{fact}$） | **採用** | **第3.4節 (L250–L290)**、**第5節 優先度8, 10**。`binding` 全フィールド一致、`appliedRevision = basedRevision + 1`、ユニーク性・存在性を規定。保持・置換・失効の単一規則を固定。決定表に行として $E_{human} \to \text{ask}$, $E_{fact} \to \text{check}$ を接続。 |
| **5** | `FatalStop` によるレガシー停止の誤復活防止（$LegacyStop$ ガード導入） | **採用** | **第5節 (L300–L325)**。$LegacyStop = (stopReason === \text{'no_progress'} \land (policyHistory === \text{undefined} \lor !NoProg))$ を定義。旧ステートの停止を保護しつつ、$NoProg === \text{true}$ のみ打開askへ通過させる境界を固定。全必須ギャップ解決完了特例（優先度4）は $NoProg$ の影響を受けない。 |
| **6** | フィクスチャ整合性・旧新バリデーション契約、作者意図専用ファイルスキーマ追加、Provenanceサイドカー分離 | **採用** | **第6.1節 (L345–L395)**、**第7.1節–第7.3節**。`canonical(packet) === canonical(state.task)`、新旧 `validateState` 検証を明記。作者意図専用ファイル `ask-policy-author-intent.json` スキーマを追加。実行メタデータは `provenance.json` サイドカーへ分離。 |
| **7** | 決定論ゲート（2回連続バイト一致）、全60件結果配列、メトリクス・不一致スキーマ完全化 | **採用** | **第4.2節**、**第8.4節–第8.5節 (L460–L535)**。レポート出力の同一バイト一致ゲートを明記。`cases` に全60ケース一覧、`unnecessaryAsks`（全体FP）と `controlViolations`（対照群違反）を分離。`disagreements` に reason を追加。第2節表を唯一の正規化正本と明記。 |

---

## 11. 実装契約と変更境界 (Implementation Boundaries)

### 11.1 変更許可スコープ
本設計に基づく実装フェーズ（後続タスク）で変更が許可されるファイルは以下に限定される：
- `src/types.ts`: `policyHistorySchema`, `reflectionEffectsSchema`, `humanRoleSchema` 等のオプショナル型定義
- `src/core.ts`: `result()` 関数の決定表準拠ロジック修正、`evaluatePolicy` のエクスポート、コア関数での `policyHistory` / `reflectionEffects` 導出更新
- `src/report.ts` / `src/cli.ts`: 人間可読レポートにおける理由表示の軽微な加法的整合（必要な場合のみ）

### 11.2 厳格な変更禁止境界 (Strict Prohibitions)
- `src/hidden-side.ts`, `scripts/hidden-side-experiment.mjs`, および Ommatidia 関連モジュールには一切変更を加えない。
- コアエンジンにベクトル埋め込みを導入しない。
- 外部の有料API呼び出し、新規依存関係（npm package）の追加を行わない。
- Claudeモデル系列の利用・指定を行わない。
- 承認されたワークツリー `D:/develop/works/tombo-view-ask-policy` 外への書き込みを行わない。

---

## 12. 明示的非主張と境界宣言 (Explicit Non-Claims & Boundaries)

1. **AIの関心・好奇心の否定**:
   TOMBOが `ask` を選択する挙動は、データ構造上のギャップ・矛盾・プローブ枯渇に基づく決定論的アルゴリズムの結果であり、AIが主観的な関心、好奇心、自律的意識を持っていることを意味しないし、そのように主張してはならない。利用者の言う「理解への関心」は、状態遷移の行動的・機能的アナロジー（比喩）である。
2. **実モデル有効性・自律盲点発見の非保証**:
   本仕様の比較検証（`scripts/ask-policy-compare.mjs`）は、決定論的な状態から行動への遷移規則（state-to-action policy）の適合性を証明するものであり、実運用におけるモデルの自発的な質問生成能力、状態候補の自動生成品質、あるいは未知の盲点を全自動で網羅的に発見・解消できることを保証するものではない。
3. **外部判定エンジン（Jev等）の非利用と依存性ゼロ**:
   「typed decision decomposition（狭い型付き判断への分解）」の説明においてJev等の判断フレームワークとの類比を用いることがあるが、これはローカルな構造分解の比喩概念に過ぎない。本システムはローカル完結型（framework_only_local）であり、Jev API呼出や外部課金API接続は一切行わない（Jev API call: not made）。新規npm依存性や外部サービス接続はゼロである。
3. **アノテーションの暫定性**:
   `evaluation/ask-policy-annotations.json` に記録される3ベンダーの独立アノテーションは合意形成のための暫定ラベルであり、絶対的な客観的正解（ground truth）ではない。
4. **既存524件テスト全維持の未実証性**:
   本設計における「既存524件テスト全pass」は非破壊的設計を意図した受入目標であり、設計作者自身がテスト通過を証明・宣言したものではない。後続の実装TDDフェーズにおいて実際のコマンド実行により実証される。
5. **将来スコープの境界固定**:
   以下の事項は本マイルストーンのスコープ外（境界外）として固定する：
   - マルチターン対話における過去質問・回答履歴の動的コンテキスト圧縮アルゴリズム
   - プローブ実行中のリアルタイム動的権限昇格プロトコル
   - 実モデルAPIを呼び出したトークン消費量・レイテンシ実測ベンチマーク
