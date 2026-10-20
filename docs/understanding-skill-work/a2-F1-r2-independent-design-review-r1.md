# Cross-Vendor Design Amendment Review: F1 Lifecycle Design r2

**Target Document**: [`docs/understanding-skill-work/a2-F1-lifecycle-design-r2.md`](a2-F1-lifecycle-design-r2.md)  
**Worktree / Branch / Base**: `D:/develop/works/tombo-view-ask-policy` | `devin/20261020-1705-understanding-skill` | HEAD `dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9`  
**Reviewer Role**: Independent Google Design Sub-Agent (Read-Only)

---

## 1. Formal Verdict

### **PASS for LIFECYCLE DESIGN READINESS ONLY** (subject to strict accepted conditions below)

> [!IMPORTANT]
> **Explicit Review Boundary & Non-Claims**:
> - This verdict applies **strictly to the lifecycle design amendment r2** (`a2-F1-lifecycle-design-r2.md`).
> - This is **NOT** a code implementation PASS, **NOT** an A2 milestone acceptance, **NOT** a full-review PASS, **NOT** a task gate pass, and **NOT** an authorization for publication, branch merge, or unreviewed production release.
> - Parent audit continuation status remains `not_accepted_needs_review` (`A2=false`, `publication=false`). AGENTS deviation remains unwaived, separated real-user runs remain segregated, and A3 stage 1 questions remain unanswered.
> - The reviewer executed **no test runs, no mutation commands, and no helper/model API calls** (marked **`NOT_RUN`**). PM log SHA `d07b726154c8ae24273df227f120956a5073828764bc67bb6a7b3ff40ada3281` and 29 selected tests (2 pass, 27 fail) are recorded as PM/owner evidence, not independently computed execution.

---

## 2. Actual Inspected Files & Verified Metrics

The following actual files and current line lengths were directly inspected in the workspace (no estimated line limits or invented hashes):

| File | Type | Current Verified Line Count | Inspection Focus |
| :--- | :--- | :--- | :--- |
| [`src/core.ts`](../../src/core.ts) | Production Core | 784 lines | `checkState` (L138), `checkpointBudget` (L443), `reflect` (L594), `update` (L641), `invalidate` (L760) |
| [`src/types.ts`](../../src/types.ts) | Production Types | 219 lines | `stateSchema`, `modelRepairDiagnosticSchema`, `modelValidationFeedbackSchema` |
| [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs) | Managed Helper | 313 lines | Managed `prepare`/`apply` (L110–125), Direct `prepare` (L261–280) |
| [`skills/tombo-view/scripts/session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs) | Session Store | 453 lines | `reconcile` (L249–254), `invalidate` staging (L274–286), `stateDigest` |
| [`skills/tombo-view/references/host-session.md`](../../skills/tombo-view/references/host-session.md) | Contract Reference | 293 lines | Host session framing, contract constraints |
| [`docs/.../a2-F1-lifecycle-design-r2.md`](a2-F1-lifecycle-design-r2.md) | Proposed Amendment | 84 lines | Proposed C1 replacement lifecycle table & validation rules |
| [`docs/.../a2-F1-RED-evidence-r1/design-counterexample.md`](a2-F1-RED-evidence-r1/design-counterexample.md) | Evidence | 37 lines | C1/C4 counterexample reproduction analysis |
| [`docs/.../a2-F1-RED-evidence-r1/proposed-api-test-contract.md`](a2-F1-RED-evidence-r1/proposed-api-test-contract.md) | Test Contract | 53 lines | Proposed RED/GREEN API test invariants |
| [`docs/.../a2-F1-RED-actual-readback-r1.json`](a2-F1-RED-actual-readback-r1.json) | PM Proof | 119 lines | Baseline verification of protected 14 files and 27 RED failures |
| [`test/cli-model-repair.test.mjs`](../../test/cli-model-repair.test.mjs) | Test Suite | 420 lines | SDK-level F1 tests (L250–420) |
| [`test/session-followup.test.mjs`](../../test/session-followup.test.mjs) | Test Suite | 1165 lines | Managed session F1 tests & counterexample (L980–1165) |

---

## 3. Evaluation of r2 Lifecycle Mechanism (C1/C4 Coexistence)

### 3.1 The Concrete Problem Solved
Under the original r1 design:
- **C1** unconditionally deleted `state.lastProposalRejection` on any new revision.
- **C4** allowed fallback to legacy `state.modelRepairDiagnostics` whenever `state.lastProposalRejection` was absent, provided `state.stopReason === 'invalid_model_output'` and operation matched.
- In `session-store.mjs` (lines 285–286), when a managed `invalidate` is reconciled, `candidate.stopReason` restores `pending.context.previousStopReason`. If the prior run stopped with `invalid_model_output`, the post-invalidation state retained `stopReason: 'invalid_model_output'`.
- Consequently, executing `invalidate` created a new revision, C1 stripped `lastProposalRejection`, and the subsequent `prepare` saw an absent object with an `invalid_model_output` stop reason, thus falling back to `modelRepairDiagnostics`. This resurrected stale feedback for an operation whose evidence scope and revision had changed.

### 3.2 Sufficiency and Minimality of the r2 Solution
The r2 amendment replaces C1's unconditional deletion with **retention of one bounded historical record across non-proposal revisions**:
1. **Minimality**:
   - Adds **no new schema fields, options, or flags** beyond `captureProposalRejection?: boolean` and optional `lastProposalRejection`.
   - Introduces **no new epoch counters, tombstones, watermarks, or event types**.
   - Requires **no deletion or truncation** of `modelRepairDiagnostics`.
   - Leaves `session-store.mjs` stop-restoration logic intact, preserving journal and state digest fidelity.
2. **Sufficiency**:
   - Because `lastProposalRejection` is retained with its original `atRevision` and `understandingHash`, `state.lastProposalRejection` is **present** in the state following an invalidation.
   - The shared helper derivation rule specifies:
     $$\text{presence of } \texttt{lastProposalRejection} \implies \text{legacy fallback suppressed}$$
   - Since `state.revision > record.atRevision`, the active checks fail. The inactive record produces **no feedback** (`request.validationFeedback = undefined`) and simultaneously **blocks legacy fallback**.
   - This cleanly resolves the C1/C4 contradiction without introducing secondary state mechanisms.

---

## 4. Invariant and Boundary Review

| Area / Boundary | Evaluation & Verified Semantics | Status |
| :--- | :--- | :--- |
| **Corrupt vs Current vs Historical Validation** | `checkState` must enforce: (a) If `atRevision === state.revision`, require `state.stopReason === 'invalid_model_output'`, `record.understandingHash === understandingHash(state)`, target membership in current state, and safe kind. Mismatches are rejected as `invalid_input`. (b) If `atRevision < state.revision`, validate structure, task matching (`record.taskId === state.taskId`), and bounds (`atRevision <= state.revision`), but do **not** require current understanding hash, current stop reason, or target presence to match the historical record. (c) `atRevision > state.revision` is rejected as `invalid_input`. This prevents valid subsequent non-proposal transitions from triggering false corruption errors. | **ACCEPTABLE** |
| **Opt-Out Calls on Opt-In-Derived State** | `captureProposalRejection` controls *creation*, not deletion of history. When an SDK instance without the flag operates on a state bearing a historical `lastProposalRejection`: valid success clears it; a terminal rejection does not manufacture a new record, leaving the historical record inactive (suppressing legacy fallback without generating feedback). Legacy states lacking the object remain completely unaffected. | **ACCEPTABLE** |
| **Legacy No-Object Contract** | States without `lastProposalRejection` (legacy journal replays, default CLI, unmanaged sessions) preserve exact historical fallback to `modelRepairDiagnostics` when `stopReason === 'invalid_model_output'`. No backfill, no mode inference, no schema version bump (`0.1` preserved). | **ACCEPTABLE** |
| **Same-Revision No-Op** | When an operation returns without a revision change (e.g., `invalidate` where no evidence was withdrawn), the state and `lastProposalRejection` remain identical. If it was active, it remains active. | **ACCEPTABLE** |
| **Whole-Task Gate & Expiry** | When `taskClockStop` or budget deadline occurs, session store checkpointing stops the execution before envelope generation or model calls. SDK state remains at its current revision, and `lastProposalRejection` is preserved as immutable metadata without granting retry permission. | **ACCEPTABLE** |
| **Redacted Replay & Privacy** | Diagnostics are restricted to bounded static kinds (`resolution_not_justified`, `reflection_binding_mismatch`, `reflection_claim_coverage_mismatch`, `proposal_validation_failed`) and protocol entity IDs. No error message strings, Zod issues, candidate proposals, or evidence passages are persisted. Redacted replays pass schema and hash checks without leaking source text. | **ACCEPTABLE** |
| **Successful-but-Not-Ready Updates** | When an update applies validly but results in `needs_user_input`, `needs_check`, or `blocked`, `lastProposalRejection` is **cleared** (`delete state.lastProposalRejection`). The proposal was valid and applied; recovery from a rejected proposal has concluded. | **ACCEPTABLE** |
| **Positive Repairs** | Automatic repair loops (`maxModelRepairAttempts > 0`) continue using `modelRepairDiagnostics` for intermediate attempts. `lastProposalRejection` records only the terminal failure if all attempts fail under opt-in. A successful repair clears any prior rejection record. | **ACCEPTABLE** |
| **Task Transition** | On a genuine task transition, `lastProposalRejection` is never copied or transplanted into the new task packet or initial state. New tasks initialize at revision 0 with empty diagnostic metadata. | **ACCEPTABLE** |
| **Digest Integrity (C5)** | `understandingHash(state)` strictly excludes diagnostic metadata (`lastProposalRejection` and `modelRepairDiagnostics`). Whole-state journal digest and `SessionStore.stateDigest` include `lastProposalRejection` normally. No modification to `src/report.ts`. | **ACCEPTABLE** |

---

## 5. Scope of Required Test Amendments

The runtime owner must amend **only** the test expectations in the append-only test additions that asserted the obsolete r1 C1 behavior (clearing metadata on new revisions):

1. **[`test/cli-model-repair.test.mjs`](../../test/cli-model-repair.test.mjs)**:
   - Lines 373, 376, 380: In `'F1 every new non-proposal revision clears rejection...'`, replace:
     ```javascript
     assert.equal(invalidated.state.lastProposalRejection, undefined);
     assert.equal(checkpoint.state.lastProposalRejection, undefined);
     assert.equal(conflict.state.lastProposalRejection, undefined);
     ```
     with assertions verifying that `lastProposalRejection` is **retained**, that `atRevision < state.revision` (historical/inactive), and that active checks fail.
2. **[`test/session-followup.test.mjs`](../../test/session-followup.test.mjs)**:
   - Line 1095 and Line 1140: Replace `assert.equal(changed.state.lastProposalRejection, undefined)` with equality to the historical record and verification of `atRevision < state.revision`.
   - Line 1148: **Strictly preserve** `assert.equal(prepared.value.request.validationFeedback, undefined)` (the observable guarantee that stale feedback is NOT revived).
3. **Preservation Requirements**:
   - All original pre-F1 test prefixes must remain bit-for-bit unchanged.
   - Compatibility cases (opt-out, default inspect throw, legacy positive repair, legacy replay) must not be weakened.

---

## 6. Actionable Design Conditions for Runtime Owner & PM

1. **Test Amendments Prior to Source Edits**:
   - The runtime owner must update the test assertions to reflect r2 retention before editing production code.
   - Run the focused F1 test suite to produce a clean, updated RED log confirming the new failure points (where source does not yet implement r2 retention/inactivity derivation).
2. **Implementation Scope Lock**:
   - Code edits must remain strictly confined to the authorized runtime files: [`src/core.ts`](../../src/core.ts), [`src/types.ts`](../../src/types.ts), [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs), and [`skills/tombo-view/scripts/session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs).
   - No modifications to `src/report.ts`, CLI entry points, `SKILL.md`, or frozen product files.
3. **Subsequent Workflow**:
   - Minimal source fix $\to$ Focused GREEN $\to$ Regression/typecheck/build $\to$ Docs API readback $\to$ Fresh full `npm test` $\to$ Blinded raw evaluations $\to$ Independent full-diff review $\to$ Task gate $\to$ Parent audit. No branch merge or push to protected branches until full parent PASS.
