## 1. Executive Verdict (`DESIGN READINESS ONLY`)

- **Design Readiness Verdict**: **`pass` (with mandatory implementation conditions C1–C5 below)**
  - **Scope of Verdict**: Strictly limited to **`DESIGN READINESS ONLY`** for [`a2-F1-terminal-rejection-design-r1.md`](a2-F1-terminal-rejection-design-r1.md).
  - **Explicit Non-Approvals**: This is **NOT** an implementation pass, **NOT** an Acceptance 2 (`A2`) pass, **NOT** a full-diff review pass, **NOT** a `task_gate` pass, **NOT** a parent final audit pass, and **NOT** a publication/commit/push/PR pass.
  - **Audit & Boundary Preservation**:
    - [`parent-final-audit.json`](parent-final-audit.json) continuation snapshot `post-H-parent-independent-audit-r1` remains `not_accepted_needs_review` (`goal_complete: false`, `publication_ready: false`).
    - Historical post-H full review [`a2-post-H-independent-full-review-r1.md`](a2-post-H-independent-full-review-r1.md) remains `needs_review` with inaccurate hash/schema/flag/case/timing/test claims documented in [`a2-post-H-full-review-reliability-readback-r1.json`](a2-post-H-full-review-reliability-readback-r1.json); no subset pass is adopted.
    - Current 16 product files (9 tracked + 7 new untracked) and patch `c57cb1bf754c23d4824769ee5bbf43a24446c437170a11fc3f2363beb0971069` match [`a2-post-H-full-review-product-manifest-r1.json`](a2-post-H-full-review-product-manifest-r1.json) and [`a2-post-H-product-freeze-r1.json`](a2-post-H-product-freeze-r1.json) per PM/parent verification; **independent reviewer SHA-256 / test execution is `NOT_RUN`** (strictly read-only review).
    - **F2** (observation/evidence/execution immutability and no `--discard-execution`) and **F3** (claimless gap `claimIds: []` cannot resolve `supported`/`refuted`, and already-created required claimless gaps are not auto-repaired by F1) remain unrelaxed.
    - All prior failures (`D01`, `E01`–`E03`, `F03`, `G01`, `G03`, Google `H01`/`H02` semantic/quota stops, extra user runs `H01-A4-r4` and `H01-A3-r4`), `H01-A3` unanswered stage-1 question (`pendingRequestCount: 1`), and the runtime owner `AGENTS.md` discovery scan deviation remain preserved and unwaived.

---

## 2. Concrete Comparison of Safe Provenance Capture Alternatives

The design asks the reviewer to challenge the smallest safe way to convey validation provenance without duplicating SDK validation in [`session.mjs`](../../skills/tombo-view/scripts/session.mjs) and without allowing an adapter-thrown lookalike error or untrusted candidate string to impersonate an internal SDK guard.

| Alternative | Mechanism | Safety / Provenance Integrity | Duplication / Complexity | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **A. Parse `TomboError.message` in `propose` or `session.mjs`** | Match regexes against `error.message` (e.g., `/^Resolution lacks current matching evidence (.+)$/`). | **Unsafe / Fragile.** In [`generate`](../../src/core.ts#L502-L533), `adapter.generate` or `critic.reflect` runs inside `try` where any thrown `TomboError` (`error instanceof TomboError && error.code !== 'model_timeout'`) is rethrown verbatim at [`src/core.ts:523-525`](../../src/core.ts#L523-L525). A buggy or untrusted adapter throwing `new TomboError('invalid_model_output', 'Resolution lacks current matching evidence ...')` would forge an internal guard and target. Also couples diagnostic schema to English message formatting. | Low code diff, high coupling. | **Reject** |
| **B. Re-check proposal against state in `session.mjs`** | Catch `invalid_model_output` in helper and inspect `proposal` against `state`. | **Violates single-authority invariant.** Duplicates [`effectiveAssessment`](../../src/core.ts#L103-L109), [`resolutionValid`](../../src/core.ts#L119-L134), and [`applyProposal`](../../src/core.ts#L363-L414) outside [`src/core.ts`](../../src/core.ts), risking drift between SDK and helper. | High duplication. | **Reject** |
| **C. Reuse `state.modelRepairDiagnostics` array for `maxRepairs === 0`** | Push raw `ModelRepairDiagnostic` into `modelRepairDiagnostics` even when `maxRepairs === 0`. | **Breaks backward compatibility and leaks raw messages.** Existing tests (e.g., [`test/cli-model-repair.test.mjs:115-123`](../../test/cli-model-repair.test.mjs#L115-L123)) and default SDK consumers expect `modelRepairDiagnostics` to remain `undefined` when `maxModelRepairAttempts === 0`, and `ModelRepairDiagnostic.message` stores `error.message.slice(0, 512)` (which can include raw Zod path/issue text or candidate IDs). Furthermore, `modelRepairDiagnostics` is an accumulating array that persists across subsequent successful operations and renders in [`src/report.ts:75-80`](../../src/report.ts#L75-L80). | Low diff, high regression & privacy risk. | **Reject** |
| **D. Unexported internal provenance symbol/detail on `TomboError` + phase-gated capture in `propose` (Recommended)** | Attach an unexported module-private symbol or internal helper `invalidProposal(message, detail?: { kind, target? })` in [`src/core.ts`](../../src/core.ts), and **only** classify as specific `kind` after `adapter.generate` has returned and output is being validated/applied against `returnedState`. Any error thrown *inside* `adapter.generate()` (even if it is a `TomboError('invalid_model_output')`) lacks the unexported symbol/phase provenance and falls back to generic `kind: 'proposal_validation_failed'` with **no `target`**. | **Exact & Forgery-Proof.** External adapters cannot forge the unexported symbol or post-generation phase; raw `error.message` and Zod issues are never copied into `lastProposalRejection`; target existence is verified against `returnedState` (not `candidate`). | Minimal (`~25–35` lines in `src/core.ts`). Zero duplication in `session.mjs`. | **Approve (Required)** |

---

## 3. Severity-Ranked Design Findings & Required Conditions

### Finding D1 (High — State Invariant & Stale-Retention Gap): `checkState` and non-generating transitions (`invalidate`, `checkpointBudget`) must enforce or clear `lastProposalRejection`
- **Code Basis**:
  - [`checkState`](../../src/core.ts#L136-L210) validates `state.reflection`, `state.policyHistory`, and `state.reflectionEffects` against `state.taskId`, `state.revision`, and `understandingHash(state)`.
  - [`stopped`](../../src/core.ts#L345-L355) begins with `const state = structuredClone(original);`.
  - [`invalidate`](../../src/core.ts#L698-L719) clones `original`, increments `state.revision++`, sets `state.stopReason = null`, and recomputes policy. And in [`session-store.mjs:354-357`](../../skills/tombo-view/scripts/session-store.mjs#L354-L357), `stage(state)` restores `candidate.stopReason = pending.context.previousStopReason` (`'invalid_model_output'`) when `invalidate` runs on a stopped state!
  - [`checkpointBudget`](../../src/core.ts#L454-L473) calls `stopped(original, measured.usage, stoppedCode)`, incrementing `state.revision++` and changing `stopReason` to `'budget_exhausted'` or `'budget_accounting_unavailable'`.
- **Design Risk**:
  1. If `stopped()` clones `original`, a subsequent non-proposal stop (e.g., `budget_exhausted`, `budget_accounting_unavailable`, `passage_unavailable`, `model_error`, `model_timeout`, `assessment_pending`, or `checkpointBudget`) would inherit `original.lastProposalRejection` with `atRevision < state.revision`.
  2. Conversely, if `checkState` required `lastProposalRejection.atRevision === state.revision`, then `invalidate` or `checkpointBudget` cloning `original` without deleting `lastProposalRejection` would fail `validateState`!
  3. Worse, if `checkState` does *not* validate `lastProposalRejection` invariants, a tampered or corrupted state file could carry a forged `lastProposalRejection` whose `taskId` differs from `state.taskId`, `atRevision > state.revision`, or `target` references a non-existent entity.
- **Required Condition (C1)**:
  1. **Clear on new revisions unless freshly created**: In [`src/core.ts`](../../src/core.ts), any operation that produces a new state revision (`inspect`, successful `update`, successful/inconclusive `reflect`, `invalidate`, and `stopped()` when called for any reason other than a newly captured terminal `invalid_model_output` proposal rejection) **must `delete state.lastProposalRejection`** on the newly produced state (while leaving prior immutable journal snapshots untouched).
  2. **Enforce structural & referential invariants in `checkState`**: When `state.lastProposalRejection` is present on a state:
     - `lastProposalRejection.taskId === state.taskId`
     - `lastProposalRejection.atRevision <= state.revision` (and when freshly emitted on a terminal `invalid_model_output` stop, `atRevision === state.revision`, `understandingHash === understandingHash(state)`, and `state.stopReason === 'invalid_model_output'`)
     - If `lastProposalRejection.target` is present, its `{ kind, id }` must exist in the corresponding collection of `state` (`state.gaps`, `state.claims`, `state.probes`, or `state.lenses`).

---

### Finding D2 (Medium — `update` Pre-Generation vs. Post-Generation Boundary & `validatedObservations` Binding): Capture must only occur after `modelCalls` increments and must bind to `validatedObservations`
- **Code Basis**:
  - In [`update`](../../src/core.ts#L627-L696), lines `635–667` validate `observations`, merge new `evidence` into `state.evidence`, record `state.appliedExecutions`, set `state.pendingAssessmentExecutionIds`, increment `state.usage.rounds++` and `state.usage.toolCalls += newTools`, and save `validatedObservations = structuredClone(state)` at [`src/core.ts:667`](../../src/core.ts#L667).
  - Lines `673–680` check `budget_exhausted`, `budget_accounting_unavailable`, and `passage_unavailable` *before* calling `propose()`.
  - Inside [`propose`](../../src/core.ts#L537-L553), `generate()` checks `input_too_large` ([`line 489`](../../src/core.ts#L489)) and `budget_exhausted` ([`line 492`](../../src/core.ts#L492)) *before* incrementing `state.usage.modelCalls++` ([`line 508`](../../src/core.ts#L508)).
  - In `update`'s `catch (error)` ([`line 694`](../../src/core.ts#L694)), `stopped(validatedObservations ?? original, state.usage, error.code, ...)` is returned.
- **Design Risk**:
  - In `update`, `understandingHash(validatedObservations)` differs from `understandingHash(original)` whenever new `evidence` or probe/gap status changes were merged into `validatedObservations` before `propose()` failed!
  - If `lastProposalRejection.understandingHash` or `atRevision` were computed from `original` (or `state` before `revision++`), it would **not** match the actually returned stopped state (`stoppedState.revision === original.revision + 1` and `understandingHash(stoppedState) === understandingHash(validatedObservations)`), causing the very next `session.mjs prepare` to suppress feedback due to hash/revision mismatch!
- **Required Condition (C2)**:
  1. `lastProposalRejection` must be constructed **on or from the final returned stopped state** (after `stopped()` increments `state.revision = (validatedObservations ?? original).revision + 1` and includes `validatedObservations` evidence/probe/gap updates), so that:
     - `lastProposalRejection.atRevision === returnedState.revision`
     - `lastProposalRejection.understandingHash === understandingHash(returnedState)`
     - `lastProposalRejection.taskId === returnedState.taskId`
     - `target` existence is checked against `returnedState` (not `candidate` and not `original` alone).
  2. Capture occurs **only** when `captureProposalRejection === true`, `operation` is `'update'` or `'reflect'`, `state.usage.modelCalls > callsBeforeAttempt` (an actual adapter generation attempt occurred), and the terminal error is `TomboError` with `error.code === 'invalid_model_output'`. If a repair loop subsequently stops due to `budget_exhausted` or `budget_accounting_unavailable` ([`src/core.ts:550-551`](../../src/core.ts#L550-L551)), the terminal `stopReason` is `budget_exhausted` / `budget_accounting_unavailable`, so `lastProposalRejection` must **not** be attached.

---

### Finding D3 (Medium — Exhaustive Guard-to-Kind/Target Mapping & Safe Target ID Validation): Specify exact mapping for all `invalid_model_output` sites in `src/core.ts`
- **Code Basis**:
  Every `invalid_model_output` throw in [`src/core.ts`](../../src/core.ts) occurs in one of five places:
  1. [`generate()` line 511](../../src/core.ts#L511) & [`line 519`](../../src/core.ts#L519): `parse(z.object({ usage: ... }), raw, ...)` and `parse(schema, raw, 'invalid_model_output')` (Zod schema failure on raw output).
  2. [`reflect()` line 592](../../src/core.ts#L592): `canonical(output.binding) === canonical(binding)` (`'Reflection binding does not match current understanding'`).
  3. [`reflect()` lines 593–595](../../src/core.ts#L593-L595): `output.reviewedClaimIds` check (`'Reflection claim coverage does not match current claims'`).
  4. [`update()` lines 683–687](../../src/core.ts#L683-L687): `observationsForGap` check (`'Unsuccessful probe outcome cannot resolve a gap'`).
  5. [`applyProposal()` lines 363–414](../../src/core.ts#L363-L414) & [`checkState()` lines 136–210](../../src/core.ts#L136-L210):
     - [`line 364`](../../src/core.ts#L364): `'Assessment corrections require update'`
     - [`line 368`](../../src/core.ts#L368): `` `Existing entity cannot be overwritten ${entity.id}` ``
     - [`line 376`](../../src/core.ts#L376): `` `Unknown claim ${assessment.claimId}` ``
     - [`line 377`](../../src/core.ts#L377): `'Unknown evidence assessment'`
     - [`line 384`](../../src/core.ts#L384): `'Correction requires current evidence with an available passage'`
     - [`line 389`](../../src/core.ts#L389): `checkState(state, 'invalid_model_output', false, false)` (correction history, unknown gap/probe refs, etc.)
     - [`line 393`](../../src/core.ts#L393): `'Duplicate gap resolution'`
     - [`line 396`](../../src/core.ts#L396): `` `Unknown resolution gap ${resolution.gapId}` ``
     - [`line 397`](../../src/core.ts#L397): `'Unknown resolution evidence'`
     - [`line 400`](../../src/core.ts#L400): `` `Resolution lacks current matching evidence ${gap.id}` ``
     - [`line 413`](../../src/core.ts#L413): `checkState(state, 'invalid_model_output', true, false)`
- **Required Condition (C3)**:
  Lock the exact deterministic guard-to-`(kind, target?)` mapping so there is zero ambiguity during TDD:
  1. **`kind: 'resolution_not_justified'`**:
     - [`applyProposal` line 400](../../src/core.ts#L400) (`!resolutionValid(state, gap)`): `target: { kind: 'gap', id: gap.id }` (where `gap.id` exists in `returnedState.gaps`).
     - [`update` line 686](../../src/core.ts#L686) (`Unsuccessful probe outcome cannot resolve a gap`): `target: { kind: 'gap', id: gap.id }` if `gap` exists in `returnedState.gaps` (otherwise omit `target`).
     - [`applyProposal` line 393](../../src/core.ts#L393) (`Duplicate gap resolution`) or [`line 397`](../../src/core.ts#L397) (`Unknown resolution evidence` on an existing gap): if `gap` exists in `returnedState.gaps`, `target: { kind: 'gap', id: gap.id }`; if `resolution.gapId` is unknown ([`line 396`](../../src/core.ts#L396)), map to `kind: 'proposal_validation_failed'` (or `'resolution_not_justified'`) **without `target`** because `resolution.gapId` is not in `returnedState.gaps`.
  2. **`kind: 'reflection_binding_mismatch'`**:
     - [`reflect` line 592](../../src/core.ts#L592): `target: undefined`.
  3. **`kind: 'reflection_claim_coverage_mismatch'`**:
     - [`reflect` lines 593–595](../../src/core.ts#L593-L595): `target: { kind: 'claim', id: missingExistingClaim.id }` if a specific existing claim in `returnedState.claims` was omitted when `completion === 'completed'` (first missing claim in `returnedState.claims` order); if the failure was caused by an unknown claim ID in `output.reviewedClaimIds`, `target: undefined` (never echo the unknown ID).
  4. **`kind: 'proposal_validation_failed'`**:
     - All other internal `invalid_model_output` guards (schema parse, `Existing entity cannot be overwritten`, `Unknown claim`, `Unknown evidence assessment`, `checkState`, or adapter-thrown `invalid_model_output`).
     - If an internal guard failed on an entity that **already exists in `returnedState`** (e.g., `Existing entity cannot be overwritten ${entity.id}` where `entity.id` is in `returnedState.claims | lenses | gaps | probes`, or a `checkState` / correction guard on an existing `claim` / `gap` / `probe` / `lens` in `returnedState`), `target` may reference `{ kind, id }` of that existing entity in `returnedState`.
     - If the failing entity is a **new candidate** proposed only in the rejected proposal (not in `returnedState`), or is an `evidence` ID (since `target.kind` is strictly `'gap' | 'claim' | 'probe' | 'lens'`), or comes from schema parsing or an adapter-thrown error, **`target` MUST be omitted**.
  5. **Safe Target Identifier Schema**:
     - In [`src/types.ts`](../../src/types.ts), tighten `target.id` in `lastProposalRejectionSchema` (in addition to `id` `min(1).max(200)` and `!startsWith('task:')`) to reject control characters and whitespace (e.g., `/^[^\s\x00-\x1f\x7f]+$/`), and verify runtime membership in `returnedState` before attaching `target`.

---

### Finding D4 (Medium — Deterministic `validationFeedback.message` Synthesis & Precedence in `session.mjs`): Exact equivalence between `prepare` and `update`/`reflect` envelope check
- **Code Basis**:
  - In [`skills/tombo-view/scripts/session.mjs:96-119`](../../skills/tombo-view/scripts/session.mjs#L96-L119) (managed) and [`261-285`](../../skills/tombo-view/scripts/session.mjs#L261-L285) (unmanaged/legacy):
    - `session.mjs` constructs `request` and computes `binding.requestHash = digest(request)`.
    - During `prepare`, `binding` is returned to the caller.
    - During `update`/`reflect`, `session.mjs` recomputes `request` and `binding` from the current state/observations and checks `canonical(envelope.binding) === canonical(binding)`.
- **Design Risk**:
  - If `prepare` and `update`/`reflect` ever diverge on whether `request.validationFeedback` is populated (or how `message` is formatted), `requestHash` will mismatch and throw `revision_conflict`.
  - Furthermore, what if a state has **both** `modelRepairDiagnostics` (e.g., from an earlier turn or positive-repair CLI run) **and** `lastProposalRejection`?
  - Also, how does the failed-inspect guard at [`session.mjs:97`](../../skills/tombo-view/scripts/session.mjs#L97) interact with `lastProposalRejection`?
- **Required Condition (C4)**:
  1. **Single shared helper function in `session.mjs`** (or exported from `src/core.ts`) used by both `prepare` and `update`/`reflect` envelope verification to derive `request.validationFeedback`:
     - First check if `state?.lastProposalRejection` is **active** for `(state, operation)`:
       - `state.stopReason === 'invalid_model_output'`
       - `state.lastProposalRejection.code === 'invalid_model_output'`
       - `state.lastProposalRejection.operation === operation`
       - `state.lastProposalRejection.taskId === state.taskId`
       - `state.lastProposalRejection.atRevision === state.revision`
       - `state.lastProposalRejection.understandingHash === understandingHash(state)`
       - If `target` is present, the entity `{ kind, id }` still exists in `state`.
     - If active, populate `request.validationFeedback = { code: 'invalid_model_output', message: formatRejectionMessage(state.lastProposalRejection), rejectedAttempt: state.lastProposalRejection.rejectedAttempt, maxAttempts: state.lastProposalRejection.maxAttempts }`, where `formatRejectionMessage` is a pure, deterministic template function over `{ operation, kind, target }` (<= 512 chars, static text + validated `target.kind`/`target.id` only).
     - Else if `!state?.lastProposalRejection` and `state?.stopReason === 'invalid_model_output' && lastDiagnostic?.operation === operation`: fall back to legacy `lastDiagnostic` (`state.modelRepairDiagnostics?.at(-1)`) for backward compatibility with positive-repair states that lack `lastProposalRejection`. (Important: if `lastProposalRejection` is present on `state`—for example, `lastProposalRejection.operation === 'update'` while the user now runs `prepare --operation reflect`—do **not** fall back to an older `modelRepairDiagnostics` entry from a previous revision!)
  2. **Managed vs. Unmanaged `createTombo` Opt-In**:
     - Managed `session.mjs` ([`line 133`](../../skills/tombo-view/scripts/session.mjs#L133)) passes `captureProposalRejection: true` to `createTombo(...)`.
     - Unmanaged/legacy `session.mjs` ([`line 291`](../../skills/tombo-view/scripts/session.mjs#L291)), [`src/cli.ts`](../../src/cli.ts#L68), and default `createTombo({ adapter })` omit `captureProposalRejection` (default `false`).
     - Wait: if an unmanaged caller loads a state that already has an active `lastProposalRejection` (or if managed `session.mjs` prepares from it), the shared applicability check works identically.
  3. **`maxModelRepairAttempts` + `captureProposalRejection` interaction in `createTombo`**:
     - Validate `options.captureProposalRejection === undefined || typeof options.captureProposalRejection === 'boolean'` with `requireCondition(..., 'invalid_input', 'captureProposalRejection must be a boolean')`.
     - For `inspect`: `captureProposalRejection` has **no effect** (zero-repair `inspect` still throws `TomboError('invalid_model_output')`; positive-repair `inspect` still records `modelRepairDiagnostics` and returns `stopped` without `lastProposalRejection`).
     - For `update` and `reflect` when `captureProposalRejection === true`:
       - If `maxRepairs === 0`: `propose` makes 1 attempt (`rejectedAttempt: 1, maxAttempts: 1`), does **not** populate `state.modelRepairDiagnostics`, and on terminal `invalid_model_output` after generation, records `state.lastProposalRejection`.
       - If `maxRepairs > 0` (`1` or `2`): existing repair loop runs unchanged (`modelRepairDiagnostics` populated on each failed attempt); if and only if the final attempt (`attempt === maxRepairs + 1`) also fails with `invalid_model_output` (and not `budget_exhausted` / `budget_accounting_unavailable`), `state.lastProposalRejection` is also recorded on the terminal stopped state with `rejectedAttempt: maxRepairs + 1, maxAttempts: maxRepairs + 1`.

---

### Finding D5 (Low — Hash, Journal, Redaction & `understandingStatus` Non-Interference): Confirm exact digest boundaries
- **Code Basis**:
  - [`understandingHash`](../../src/core.ts#L64-L70) hashes only `{ task, evidence, assessmentCorrections, claims, lenses, gaps, probes, excludedCandidates }`.
  - [`FileJournal.commit`](../../src/journal.ts#L81-L97) and [`session-store.mjs:stateDigest`](../../skills/tombo-view/scripts/session-store.mjs#L27) hash the redacted whole `state` object.
  - [`src/report.ts`](../../src/report.ts) renders markdown reports from `state`.
- **Required Condition (C5)**:
  - `understandingHash(state)` must **not** include `lastProposalRejection` (already satisfied if [`understandingHash`](../../src/core.ts#L64-L70) is left unchanged).
  - Whole-state hashes (`FileJournal` `stateHash` and `SessionStore` `stateDigest`) **naturally include** `lastProposalRejection` when present on a new revision, and omit it when `undefined` on legacy or cleared revisions—preserving 100% of existing journal and session hashes without migration or backfill.
  - [`src/report.ts`](../../src/report.ts) remains completely untouched (per non-goals and frozen file ownership).

---

## 4. Exact Files Inspected (and Read Limits)

All inspections were performed strictly read-only via `client_view_file` inside `D:/develop/works/tombo-view-ask-policy` (main checkout `D:/develop/works/tombo-view` was never accessed; no commands, tests, helpers, or child tasks were executed):

1. [`docs/understanding-skill-work/a2-F1-terminal-rejection-design-r1.md`](a2-F1-terminal-rejection-design-r1.md#L1-L58) — read in full (lines 1–58).
2. [`docs/understanding-skill-work/locked-charter.md`](locked-charter.md#L1-L32) — read in full (lines 1–32).
3. [`docs/understanding-skill-work/parent-authorized-scope-amendment-r1.md`](parent-authorized-scope-amendment-r1.md#L1-L11) — read in full (lines 1–11).
4. [`docs/understanding-skill-work/parent-final-audit.json`](parent-final-audit.json#L1-L448) — read in full (lines 1–448, including `parent_continuation_snapshots[0]` `post-H-parent-independent-audit-r1`).
5. [`docs/understanding-skill-work/a2-post-H-review-findings-source-diagnosis-r1.md`](a2-post-H-review-findings-source-diagnosis-r1.md#L1-L97) — read in full (lines 1–97).
6. [`docs/understanding-skill-work/a2-post-H-review-findings-source-result-r1.json`](a2-post-H-review-findings-source-result-r1.json#L1-L26) — read in full (lines 1–26).
7. [`docs/understanding-skill-work/a2-post-H-independent-full-review-r1.md`](a2-post-H-independent-full-review-r1.md#L1-L143) — read in full (lines 1–143).
8. [`docs/understanding-skill-work/a2-post-H-full-review-reliability-readback-r1.json`](a2-post-H-full-review-reliability-readback-r1.json#L1-L139) — read in full (lines 1–139).
9. [`docs/understanding-skill-work/a2-post-H-full-review-product-manifest-r1.json`](a2-post-H-full-review-product-manifest-r1.json#L1-L133) — read in full (lines 1–133).
10. [`docs/understanding-skill-work/a2-post-H-product-freeze-r1.json`](a2-post-H-product-freeze-r1.json#L1-L122) — read in full (lines 1–122).
11. [`src/types.ts`](../../src/types.ts#L1-L215) — read in full (lines 1–215).
12. [`src/core.ts`](../../src/core.ts#L1-L721) — read in full across two calls (lines 1–600 and 550–721).
13. [`src/journal.ts`](../../src/journal.ts#L1-L111) — read in full (lines 1–111).
14. [`src/report.ts`](../../src/report.ts#L1-L86) — read in full (lines 1–86).
15. [`src/index.ts`](../../src/index.ts#L1-L8) — read in full (lines 1–8).
16. [`src/cli.ts`](../../src/cli.ts#L1-L97) — read in full (lines 1–97).
17. [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs#L1-L315) — read in full (lines 1–315; covers both `managed` and legacy/unmanaged `main` branches; note `D:/develop/works/tombo-view-ask-policy/scripts/session.mjs` does not exist as a separate path).
18. [`skills/tombo-view/scripts/session-store.mjs`](../../skills/tombo-view/scripts/session-store.mjs#L1-L453) — read in full (lines 1–453).
19. [`skills/tombo-view/references/host-session.md`](../../skills/tombo-view/references/host-session.md#L1-L215) — read in full across two calls (lines 1–160 and 150–215).
20. [`test/cli-model-repair.test.mjs`](../../test/cli-model-repair.test.mjs#L1-L195) — read in full (lines 1–195).
21. [`test/session-followup.test.mjs`](../../test/session-followup.test.mjs#L1-L815) — read in full across two calls (lines 1–460 and 450–815).
22. [`test/understanding-session.test.mjs`](../../test/understanding-session.test.mjs#L1-L185) — read in full (lines 1–185).

---

## 5. Required Pre-Product RED, Compatibility & Behavioural Checks

Before any edit to [`src/types.ts`](../../src/types.ts), [`src/core.ts`](../../src/core.ts), or [`skills/tombo-view/scripts/session.mjs`](../../skills/tombo-view/scripts/session.mjs), the runtime owner must record failing tests (RED exit `1` on behavioural assertions, not unknown CLI flags) in [`test/cli-model-repair.test.mjs`](../../test/cli-model-repair.test.mjs) and [`test/session-followup.test.mjs`](../../test/session-followup.test.mjs) covering:

1. **Managed `update` Scope-Mismatch / Unjustified Resolution Rejection & Cross-Process Prepare Feedback**:
   - Subprocess `session.mjs update` with a valid envelope whose resolution references evidence with a mismatched `scope` (or unsupported claim):
     - Exits `1` with `state.stopReason === 'invalid_model_output'`, `state.usage.modelCalls` incremented by `1`, `state.usage.toolCalls` and `state.pendingAssessmentExecutionIds` retained, rejected resolution absent.
     - Persists `state.lastProposalRejection` with `{ operation: 'update', taskId, atRevision: state.revision, understandingHash: understandingHash(state), code: 'invalid_model_output', kind: 'resolution_not_justified', target: { kind: 'gap', id: gapId }, rejectedAttempt: 1, maxAttempts: 1 }` across `.session/sdk.jsonl`, `.session/tombo-session.jsonl`, cache deletion + `status` restore, and `replayJournal`.
     - Next subprocess `session.mjs prepare --state ... --observations ...` (with the exact pending batch) populates `request.validationFeedback` deterministically from `lastProposalRejection` and binds `requestHash`.
     - Submitting a corrected `update` with the same pending batch increments `modelCalls` and `rounds` by `1` without double-counting `toolCalls` or `costYen`, resolves the gap, and **clears `state.lastProposalRejection` (`undefined`)**.
2. **F3 Claimless Required Gap Boundary Preserved**:
   - When `reflect` adds a `required` gap with `claimIds: []` and `triggerRefs: ['task:goal']`, and the next `update` attempts to resolve that gap as `supported`:
     - `update` rejects with `kind: 'resolution_not_justified'` and `target: { kind: 'gap', id: claimlessGapId }`.
     - The gap remains `open` (`importance: 'required'`), no auto-downgrade or auto-resolution occurs, and `canReportCompletion` remains `false`.
3. **Managed `reflect` Binding / Claim-Coverage Rejection & Recovery**:
   - `session.mjs reflect` with missing claim coverage in `reviewedClaimIds` (when `completion === 'completed'`) rejects with `kind: 'reflection_claim_coverage_mismatch'` and `target: { kind: 'claim', id: missingClaimId }` (or `kind: 'reflection_binding_mismatch'` without `target` when `reflection.binding` mismatches inside SDK `reflect`).
   - Subsequent `session.mjs prepare --operation reflect` includes the deterministic `validationFeedback`; corrected full-claim reflection succeeds within budget and clears `lastProposalRejection`.
4. **No Leakage / Forgery Resistance**:
   - Sentinel strings placed in `evidence.passage`, `claim.text`, `assessment.reason`, `resolution.explanation`, new candidate IDs (not in returned `state`), malformed candidate strings, and adapter-thrown lookalike `new TomboError('invalid_model_output', 'Resolution lacks current matching evidence gap')` **never** appear in `state.lastProposalRejection` or `request.validationFeedback.message`.
   - Adapter-thrown `invalid_model_output` degrades to `kind: 'proposal_validation_failed'` with `target: undefined`.
5. **Stale / Cross-Operation / Non-Generating / Expired Suppression**:
   - After a rejected `update`, running `prepare --operation reflect` (or after `invalidate`, `checkpointBudget`, `budget_exhausted`, or `task_deadline_exceeded`) **never** attaches `validationFeedback` from the inactive/mismatched `lastProposalRejection`.
   - After `task_deadline_exceeded` or `budget_exhausted`, `status` may display the historical state, but `prepare` and `update`/`reflect` remain blocked by the clock/budget gate without generating or treating `lastProposalRejection` as retry permission.
6. **Default SDK, Unmanaged Helper, `inspect` & Positive Repair Compatibility**:
   - `createTombo({ adapter })` (default `captureProposalRejection: false`) and unmanaged `session.mjs` do not emit `lastProposalRejection`.
   - `createTombo({ adapter, captureProposalRejection: 'yes' })` throws `TomboError('invalid_input')`.
   - `inspect` with `maxModelRepairAttempts: 0` still throws `TomboError('invalid_model_output')` even when `captureProposalRejection: true`.
   - Positive `maxModelRepairAttempts` (`1` or `2`) preserves existing `modelRepairDiagnostics` behaviour and attempt counts.
   - Legacy journals/states without `lastProposalRejection` load and replay with zero hash changes and no backfill.
7. **Post-GREEN Blinded Raw Behavioural Protocol**:
   - Predefine unseen raw scenarios and fixed budgets/deadlines before observer launch; withhold author rationale, old findings, and expected actions.
   - Distinguish: (a) sufficient human answer closing an existing-claim gap, (b) genuinely still-missing condition keeping a gap open, (c) correction/counterexample introducing a new trade-off, and (d) actual deadline expiry + fresh-thread resume.
   - Evaluate actual proposals, rejection diagnostics (if naturally triggered), retries, ledger state, reflection, and final user-facing alignment—never infer F3 resolved by F1 or relabel quota/incomplete runs as passes.
