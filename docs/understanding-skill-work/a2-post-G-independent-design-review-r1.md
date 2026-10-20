# Independent Cross-Vendor Design Review: Post-G Acceptance2 Minimal Repair r1

**Reviewer Model**: gemini-3.8-flash-high (Antigravity harness)  
**Execution Mode**: Read-only design review. No file writes, code/test modifications, API executions, child subagents, commits, pushes, or PR actions performed.  
**Target Workspace**: `D:/develop/works/tombo-view-ask-policy`  
**Verified Git Head**: `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9` (`devin/20261020-1705-understanding-skill`)  
**Resource Consumption**: Token count / execution cost unknown (measured host data unavailable).

---

## Verdict: PASS (DESIGN READINESS ONLY)

The repair architecture proposed in [`a2-post-G-repair-design-r1.md`](a2-post-G-repair-design-r1.md) and [`a2-post-G-source-diagnosis-r1.md`](a2-post-G-source-diagnosis-r1.md) is sound, proportional, and directly addresses the behavioural breakdowns observed in G (future timestamp fabrication, unsupported biological claims promoted to certainty despite reflection, misleading budget extension guidance, and SDK vs wall-clock start delays). 

**This is not an Acceptance 2 pass, full-diff pass, or goal completion.** Product code and test edits have not been executed. Implementation must strictly satisfy the 5 pre-implementation conditions detailed below.

---

## Independent Challenge of Design Choices

### Decision A: Optional Caller Timestamp + Strict Rejection vs. Diagnostic on New Receipts

1. **Rejection vs. Diagnostic Judgement**:
   - The source author recommended accepting future timestamps with diagnostic annotations to avoid blocking intake. The PM preferred strict rejection on new receipts with immediate omission retry.
   - **Review Finding**: **PM's strict rejection on new receipts is strictly superior.** In G01, accepting an invented future timestamp (`2026-10-21T02:14:00Z` when actual UTC was `17:15:33Z`) permanently contaminated the immutable append-only journal (`updates[]`), leaving downstream stages with persistent temporal contradictions that could not be repaired without rewriting history.
   - Because `source.receivedAt` becomes explicitly optional, rejecting an invalid/future date does not block the caller: the caller can immediately omit the field and retry.
2. **Replay vs. Validation Ordering**:
   - As observed in [`session-store.mjs#L286`](../../skills/tombo-view/scripts/session-store.mjs#L286), validation currently executes before checking `existing = this.snapshot.updates.find(item => item.id === input.id)`.
   - **Requirement**: Base shape checking (`input` is an object, `input.id` is a non-empty string) must execute first, followed immediately by identical replay check (`existing.payloadHash === payloadHash`). If an exact legacy replay matches, it must be returned immediately. The stricter new date validations (timezone syntax and non-future check) must execute **only on new receipt IDs** (`!existing`).
3. **Timezone Syntax and Clock Skew**:
   - In JavaScript, `Date.parse("2026-10-21T02:14:00")` parses in host-local time. Stricter validation must require an explicit syntactic timezone qualifier (`Z` or `[+-]\d{2}:?\d{2}`).
   - To guard against millisecond-level scheduling latency between subprocess invocation and helper OS lock acquisition, future rejection must compare `Date.parse(source.receivedAt) > helperNow + 5000ms` (5s clock-skew tolerance). No 9-hour offset guessing or automatic repair heuristics.
4. **Collision and State Integrity**:
   - Changing `receivedAt` on redelivery of an existing ID must continue to throw `invalid_input` (receipt payload collision).
   - Rejected receipts must throw before mutating `this.snapshot.updates`, ensuring the ID is not reserved and no orphaned state is appended.

---

### Decision B: Sealed `--task-clock` Descriptor in Existing Session Authority

1. **Authority and Boundary**:
   - The `--task-clock <path>` option is restricted to `activate` (and legitimate `transition`). It avoids daemon threads, global OS hooks, or host monkey-patching.
   - It is stored once in `this.snapshot.taskClock` and sealed under the existing file journal lock. It is immutable across re-activation, status, cache, replay, and crash recovery.
2. **Independence from SDK Clock**:
   - SDK `startedAt`, local SDK elapsed time, and SDK stop reasons remain strictly owned by [`src/core.ts`](../../src/core.ts).
   - If the task deadline passes while SDK budget remains, the session stop reason is recorded as `sessionStopReason: { reason: 'task_deadline_exceeded', observedAt }`. The helper must **not** fabricate an SDK `stopReason: 'budget_exhausted'`. Both reasons must remain distinct.
3. **Pre-First-Inspect Gating & Null State Handling**:
   - In G01, G02, and G03, initial setup delays ranged from 276s to 404s before the first SDK inspect call was made ([`a2-G-clock-timezones-r1.json`](a2-G-clock-timezones-r1.json)).
   - Checking the task clock before the first SDK inspect is essential. However, if expired before inspect, `store.state` is `null`.
   - **Critical Vulnerability Identified**: In [`session.mjs#L206`](../../skills/tombo-view/scripts/session.mjs#L206), [`managedReport()`](../../skills/tombo-view/scripts/session.mjs#L204-L220) executes `renderMarkdownReport(result.state)`. In [`src/report.ts#L10`](../../src/report.ts#L10), `renderMarkdownReport(null)` immediately crashes with `TypeError: Cannot use 'in' operator to search for 'state' in null`.
   - Since `src/report.ts` is outside runtime write scope, [`session.mjs`](../../skills/tombo-view/scripts/session.mjs) **must** guard against `result.state === null` before calling `renderMarkdownReport`.
4. **Transition & Recovery**:
   - An expired task clock produces `effectiveDecision: 'blocked'` and `canReportCompletion: false`.
   - A legitimate goal transition (`transition`) may initialize a new task clock while archiving `previous.taskClock` in the transition record. Same-goal reset attempts remain blocked by existing goal/criteria checks.

---

### Decision C: Grounded Semantic Reconsideration & Honest Capability Guidance

1. **Eliminating Ceremonial Reflection**:
   - In G03, the observer performed a complete reflection across all claims, but relegated unverified doubts to `limitations` while leaving the claim status as `supported` and asserting certainty in the final reply.
   - The revised [`skills/tombo-view/SKILL.md`](../../skills/tombo-view/SKILL.md) and prepare reminder must mandate:
     - The **counterexample test**: "Could the conclusion be false even if every permitted fact in the source is true?"
     - When doubt or extrapolation is identified, the agent must update the claim/assessment (using `assessmentCorrections` to change verdict to `inconclusive` or `disputed`), rather than treating `limitations` as a disclaimer sink.
2. **Preserving G02 Successes**:
   - G02 demonstrated genuine progress: resolving an open preference gap from a human response, and correctly reopening a trade-off gap upon discovering conflicting runtime figures (94 min vs 116 min).
   - The design avoids crude keyword blacklists, mandatory full-stop rules, or automated NL classifiers that would destroy G02's calibrated proceed/reframe behavior.
3. **Truthful Capability on Follow-ups**:
   - The G01 fresh resume turn falsely advised the user that providing an extension instruction would resume evaluation.
   - The skill and reference documentation must explicitly state that the saved session's SDK budget and sealed task deadline are fixed, the current helper has no same-goal extension API, and follow-up turns cannot fabricate continuation.

---

### Decision D: Meaningful RED Invariants Prior to Implementation

1. **Beyond CLI Argument Parsing**:
   - Tests must not simply verify that an unrecognized flag causes an exit code 1.
   - Pre-product RED tests in [`test/session-followup.test.mjs`](../../test/session-followup.test.mjs) must use real helper subprocesses (`spawnSync`) and [`SessionStore`](../../skills/tombo-view/scripts/session-store.mjs) exports to assert:
     - Omission of `source.receivedAt` creates an update with `helperReceivedAt` recorded and provenance marked unknown.
     - Supplying a future `receivedAt` (e.g. +1 hour) throws `invalid_input` without appending an update or reserving the receipt ID.
     - An expired `--task-clock` gates `prepare` and `inspect` before any SDK execution, leaving `state: null` and yielding `effectiveDecision: 'blocked'` without crashing `report`.
     - SDK stop reasons (`budget_exhausted`) and session stop reasons (`task_deadline_exceeded`) remain cleanly separated.
2. **Preserving Historical Baseline**:
   - Existing baseline tests (724 passing tests) must be preserved. Only assertions directly tied to the old contract of mandatory caller dates may be updated to reflect the new optional/rejection contract.

---

### Decision E: Blinded Comparative Evaluation Matrix

1. **Size and Discrimination**:
   - The PM proposed a 2x2 comparison (current vs. revised bundle across Google observer family and a distinct live model) plus 2 clock/provenance cases on the revised bundle, capped at 6 initial observers.
   - **Review Finding**: A 6-observer configuration is bounded, fits well within the 20 active thread ceiling, and is sufficiently discriminating.
   - Comparing current vs. revised on the same model isolates the product diff from model capability variance. Testing both models on the revised bundle verifies cross-model conformance without over-generalizing.
2. **Observer Isolation Rules**:
   - Observers must receive opaque bundle identifiers (e.g. Bundle A vs. Bundle B), fresh conversation context, and identical tool access.
   - Observers must receive **raw scenarios only**, with zero expected actions, author rationale, or G failure post-mortems disclosed.
   - Scenarios must be genuinely unseen, distinct from G01/G02/G03 scenarios.
   - Baseline artifacts for the current bundle (`dda5ff7`) must be frozen before writing product code.

---

## Required Pre-Implementation Conditions

Before runtime and documentation edits begin, the implementer must adhere to the following contract rules:

1. **Null-State Guard in [`session.mjs`](../../skills/tombo-view/scripts/session.mjs)**:
   In `managedReport()`, wrap `renderMarkdownReport(result.state)` with a check: if `result.state` is null, output an honest markdown placeholder (e.g., `SDK理解スナップショットは未生成（初回検査前に停止）`) instead of invoking `renderMarkdownReport(null)`.
2. **Receipt Ingestion Pipeline Order**:
   In `SessionStore.receive()`:
   - Step 1: Validate fundamental input object structure.
   - Step 2: Check for existing receipt ID. If identical payload hash matches, return existing receipt immediately (legacy replay preserved).
   - Step 3: If new receipt, enforce:
     - `source.receivedAt` is optional.
     - If provided, validate ISO timezone syntax (`Z` or `[+-]HH:mm`).
     - Reject if `Date.parse(source.receivedAt) > Date.now() + 5000`.
     - Reject without appending to `this.snapshot.updates`.
3. **Task Clock Descriptor & Gating**:
   Validate `--task-clock` on `activate`/`transition`:
   - Schema: `{ startedAt: string | null, deadlineAt: string, basis: 'host_provided' | 'first_observed', sourceRef: string }`.
   - If `basis === 'first_observed'`, `startedAt` must not be null.
   - If deadline is already in the past when received, seal the session as expired immediately without throwing.
   - Gate both `prepare` and execution steps (`inspect`, `update`, `reflect`, `invalidate`).
4. **Frozen Pre-Code Baseline Snapshot**:
   Create a frozen snapshot of the current 16 product files / 7 new files at commit `dda5ff7` prior to creating RED tests or modifying code.
5. **Concrete RED Verification**:
   Execute and record the failing RED test run in `test/session-followup.test.mjs` asserting both receipt rejection/acceptance and clock gating before implementing fixes.

---

## Conclusion

The repair design is approved for the **TDD / RED preparation stage**. File ownership remains strictly partitioned, scope constraints are respected, and no extraneous dependencies, models, or global hooks are introduced. Implementation may proceed directly following the pre-implementation conditions above.
