# TOMBO ask-policy locked goal charter
Locked at 2026-10-18 07:27:12 +09:00 (initial verification timestamp).
User instruction is authoritative. Only the prior unavailable Claude PM model is replaced. No relaxation of goals, acceptance, authority or stop gates.

## Workspace and authority
- Write only existing worktree D:/develop/works/tombo-view-ask-policy (branch feat/ask-policy-20261018, base f2ecc2e4ccbfe109596d9e156095fff7af76ea6a) and D:/inbox/tombo-ask-policy-20261018/.
- Never inspect, edit or operate on D:/develop/works/tombo-view main checkout; user has uncommitted work there. The worktree's Git metadata is managed by Git; do not manually modify main checkout.
- No push, PR or merge. Feature branch commits permitted, Conventional Commits.
- No held-out data, Ommatidia data, secrets, external paid API calls or new dependencies. Delegated model tasks through the authorised T3 host are the requested orchestration; do not call model APIs in product/evaluation/scripts.
- Do not modify Hidden-Side, Ommatidia or CrossRAG. No vector embeddings in core.
- Keep model evaluation inputs separate from expected labels; annotators receive input fixtures only and never author's intent or other annotations.
- Claude models are excluded across every provider, including Cursor aliases.
- Live T3 maxBatchThreads=20. Keep all nested active work at or below 20 per dependency wave; use fewer when appropriate. Approximately 40–50 work items may be split into meaningful DAG steps. Report only real task dispatches and starts, never planned counts as executed.
- Parent thread is intake/coordinator. A real delegated goal PM plans, delegates, integrates and verifies; PM does not implement production code. One writer per file/set, preserve other edits. No separate worktree isolation because writes are confined to existing authorised worktree.
- Japanese communication. Use hand over / handover and hand_over identifiers for transfer; preserve official API names.
- Applicable rules already read: user AGENTS instructions, D:/develop/AGENTS.md, D:/develop/works/AGENTS.md, D:/develop/control/policy/core-v2.0.md. No worktree root AGENTS.md found; inspect nested rules as applicable.
- Permission escalation uses provided approval workflow; do not bypass any billing/account/approval restriction. Previous Claude exclusion is explicitly authorised by user; otherwise skill fallback rules apply.
- No memory writes or writes to benchmark ledger outside authorised roots. Keep local evidence instead.

## Locked goal
TOMBO chooses {proceed, check, ask, reframe, blocked} each round based on structural signals in its understanding state. ask is a first-class active choice, not a last resort. Reasons rely on observable state, not self-report. Evaluation tests appropriate asks, suppression of unnecessary asks, and preservation of unrelated existing behaviour. Claim only measurable ask behaviour; never claim AI has interest.

## Initial facts and revalidation
src/core.ts result() currently returns needs_user_input only if no probe remains and all remaining mandatory gaps are ambiguous_intent (reported around line 229). Existing evaluation/cases.json has 48 cases and evaluation/metacognition-*-cases.json 30 cases, with almost no correct human-query cases. Specification TOMBO_spec_v0.1_ja.md; decision table approximately 165 lines. Reverify all facts from current worktree.
Earlier 524/524 npm test exit0 is prior-thread evidence only; new PM must rerun and verify.
Parent verified branch/HEAD and clean status before creating orchestration artefacts; small write probe succeeded, readback matched, removed and clean status verified.
T3 binding: attached=true, worktreePath=D:\\develop\\works\\tombo-view-ask-policy, branch=feat/ask-policy-20261018. projectWorkspaceRoot points to main checkout but attached worktree is effective binding. Every write-capable child must verify actual binding/cwd before editing.

## Acceptance (all mandatory)
1. docs/ask-policy.md defines five choices; structural signals (human-only goal/priority/value/permission gaps, contradictions in goal-important claims that probes cannot resolve, repeated no_progress, reflections changing goal interpretation); ask vs check ordering/cost; backward compatibility retaining needs_user_input naming and existing 524 tests or justified recorded exceptions; explicit non-claims. Before implementation, obtain pass from an independent design reviewer of a different vendor from implementer.
2. TDD implementation centred on src/core.ts and src/types.ts. Add focused tests first, capture actual RED, minimal code fix, GREEN, all npm test regression. Change report/cli only when necessary. Record exact commands and exit codes. Each implementation task follows RED -> GREEN -> regression.
3. evaluation/ask-policy-cases.json is input only; evaluation/ask-policy-annotations.json stores separate expected actions and is never passed to models. At least40 cases; balanced ask/check/proceed/reframe; at least3 domains; unnecessary-ask controls. Every case is an inspectable TOMBO state/packet fixture. Expected behaviour separated from author's intent, with three independent annotators from three model vendors labelling every case. List disagreements in evaluation/ask-policy-disagreements.json. evaluation/README.md explicitly states model annotation labels are provisional, not ground truth.
4. scripts/ask-policy-compare.mjs deterministically compares the old rule exactly at f2ecc2e against the new rule on every case; writes evaluation/reports/ask-policy-compare.json with ask precision/recall, unnecessary asks, missed asks, changed cases. Main metrics include only consensus cases; disagreements separately reported.
5. Full diff independent review by a different vendor from implementer, with test evidence and pass. Maximum two fix/review rounds. Each review round is a fresh delegate_task with original charter, previous findings/responses and unresolved issues, distinct stable clientRequestId. Never start new review by sending to childThreadId.
6. D:/inbox/tombo-ask-policy-20261018/handover.md records work, test counts, comparison values, unknowns and actual provider/model/effort/task handles.

## Non-claims and stop gates
Success only covers deterministic comparison, not live model behavioural effectiveness.
Stop and report if worktree not writable, npm test cannot run, or design reviewer fails twice. Do not weaken gates to continue.
Respect max two fix/review rounds; unresolved findings stay unresolved.
Do not report complete on PM/worker assertions: inspect actual task states/artifacts and run task_gate.py with execution_contract=pm_tdd_review and required layer/goal/parent/role/dispatch/TDD/review evidence.

## Routing and execution
Read C:/Users/ryoko/.agents/skills/bench-ledger-router/SKILL.md in full plus references/t3-code.md and routing-policy.md. Catalogue files docs/ask-policy-work/live-catalogue.json and eligible-catalogue.json; ranked candidates.json.
Decision source framework_only_local; Jev API call not made. No paid API/new dependencies.
Parent ran classify_task.py on PM text; layer=goal_pm strong_planner. PM selection uses user-example codex/gpt-6.1-sol shortlist: assign_slot.py pm-candidates.json --layer goal_pm --role goal_pm returned exact codex/gpt-6.1-sol, rank5, ledger best_score100 measured, cost.output10.0, high effort available. These are historical ledger observations, not this task results or measured costs.
PM owns docs/ask-policy-work/task-state.json and coordination evidence. Record real returned task handles, DAG, ownership, wave ready/review gates, routing decisions and exact commands. Test/integration role and design reviewer must differ in model vendor from implementation. Three annotation vendors are mandatory even if host providers differ: vendor is model family/vendor, not transport.
PM should delegate one task lead per meaningful workstream and main design/implementation/test-integration roles as needed, small disjoint/read-only workers beneath those only when useful. Do not create work merely to reach a count.
Before final acceptance PM inspects every criterion, final integrated npm test and task gate. Parent independently checks final scope, actual child states and gate evidence.
