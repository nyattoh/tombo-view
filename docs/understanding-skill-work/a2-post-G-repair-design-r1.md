# Post-G acceptance2 minimal repair proposal r1

Proposal only; no implementation or independent PASS. Same PM and existing source/runtime/docs owners. Authority: immutable locked-charter and parent-authorized-scope-amendment-r1. Old two-round cap superseded ONLY for A2 by explicit completion instruction; all original D/E/F/G failures, cancellation and audits remain. G demonstrated bounded SDK continuity/human-answer/reframe success but not A2 acceptance. Current16-file/new7 freeze/npm724 unchanged. Diagnosis terminal: a2-post-G-source-diagnosis-r1.md / result-r1.json.

## Decisions requiring fresh cross-vendor design judgement

A. Remove mandatory invented receipt time, reject invalid new assertions while preserving immutable history.
B. Add optional sealed whole-task deadline to existing managed session; keep SDK interval/accounting distinct.
C. Replace repeated self-declarations with concise source-grounded reconsideration behaviour and truthful current restart capability. No SDK semantic oracle/word blacklist/new model API.
These are substantive helper/skill changes, so fresh independent design PASS is required BEFORE product edits.

## A: caller timestamp unknown is representable

source.receivedAt becomes optional for NEW receipts. Undated raw normally omits it; report displays unknown. Never substitute helper time, file mtime or model-guessed clock for source provenance. helperReceivedAt stays output-only measured acceptance under lock after validation, excluded from original payloadHash.

Preferred policy over the source author's optional+diagnostic alternative: for NEW IDs, if a caller time IS supplied require an unambiguous timezone-qualified ISO date-time and reject invalid or future values relative to this helper OS acceptance observation. Unknown metadata can be omitted and the receipt retried immediately; the rejected payload is not appended and does not reserve the ID. No9h repair/normalisation, no silent deletion of an asserted value. This catches demonstrated future-time assertion mechanically; it does not authenticate past caller times or remote clocks. Counterargument for review: rejecting metadata may delay receipt acceptance; optional omission provides a non-fabricating path. If reviewer finds optional+diagnostic strictly preferable, return the exact required bounded contract correction before implementation.

Compatibility: canonical input shape/hash stays the same when a date is present; absent date remains absent, not null/injected. SameID/samepayload returns the ORIGINAL record before NEW-only stricter date checks, including legacy accepted formats/future values. Changed date/presence remains collision. Do base input/schema/execution collision checks without weakening them; exact old replay must not be broken by stricter new validation. No legacy timestamp/hash/backfill migrations. Internal expiry/invalidation receipt clocks/replay and Evidence.retrievedAt unchanged. Report marks caller metadata unverified, unknown omitted, and a stored date later than its immutable helperReceivedAt as inconsistent; do not recompute away the finding when wall time advances. Legacy receipt without helper time has unknown comparison, no fabricated witness. New rejection does not change SDK evidence/usage; a normal existing checkpoint may still honestly update elapsed/stop.

## B: optional absolute task clock, session authority only

One new helper option, --task-clock <JSON file>, allowed only with activate and legitimate transition. No new global hook, external service, SDK core/types API, or general budget-extension command.

Strict input descriptor:
{startedAt: timezone-qualified ISO string OR null, deadlineAt: timezone-qualified ISO string, basis: 'host_provided' OR 'first_observed', sourceRef: nonempty locator}
- Host-provided means declared source metadata/user absolute deadline, not cryptographically authenticated origin. If original start unknown it is null. No retrospective reconstruction from a late SDK.startedAt.
- first_observed requires a real local tool observation before deep preparation, non-null startedAt. Guide uses an actual OS-clock calculation to create the descriptor; no hand-authored date literal/Z conversion. Claim only coverage from that observation, not unobserved earlier host thought/message time.
- Validate dates/ordering, non-future known start, finite deadline; already-expired deadline is accepted as a closed window, never extended. Save helper recordedAt separately/output-only.
- Descriptor stored in session journal snapshot, unchanged for same session through reactivation/status/cache/replay/crash recovery. Guard load against changed clock across same-session events. Do not add a second/third clock authority or rely on editable cache/input after activation.
- Existing activate redelivery retains clock when option omitted; supplied descriptor must equal the sealed descriptor. Clockless legacy session stays coverage unknown; no later attachment/backfill/reset. Only already-authorised genuine goal/successCriteria transition may start a different task clock, retaining previous.taskClock and all old accounting/unknowns/stops. Same-goal time expiry is not transition.
- No SDK.startedAt/budget/usage manipulation. SDK clock remains its true first-inspect interval. This field is the user's separately declared whole-task boundary.

At prepare and immediately before inspect/update/reflect/invalidate application, check sealed task deadline using real observed time, INCLUDING before the first SDK inspect. Expired session does not return a generation binding/request or perform new evaluation/reconsideration/invalidation. Retain new actual observations or invalidation intent unassessed using existing receipt mechanisms. receive/status/report remain available. Before-first-inspect expiry may have state:null/noSDK ledger, which must be reportable honestly without creating fake understanding/usage.
- Derive top-level taskClockStatus: {coverage:'unavailable'|'host_provided'|'first_observed', startedAt:string|null, deadlineAt:string|null, observedAt:string, expired:boolean|null}. Show declared provenance/coverage in report. No original-whole-window pass from unavailable/first_observed coverage.
- Persist session taskClockStop {reason:'task_deadline_exceeded',observedAt:string} at first observed expiry; replay keeps actual first stop, no future same-goal extension.
- effectiveDecision blocked / canReportCompletion false when session clock stop applies. Expose sessionStopReason outside SDK. If SDK still has local budget, DO NOT invent SDK stopReason budget_exhausted. If real SDK budget/old stop also applies preserve it; show both distinct reasons.
- Existing non-generating SDK checkpoint may record real elapsed/local stop; understanding, counts and incurred usage retained. Recovery completes already recorded transactions with their real accounting, then gates new work; no rollback/erasure to hide cancellation/expiry.
- This gates helper operation boundaries, not instant interruption of host/free-form inference between calls. No claim of all-host interception/hard CPU deadline. Test and document that limit instead of promising it.

## C: source-grounded loop and actual restart capability

Existing SKILL/host-session and short managed prepare reminder are rewritten concisely, not appended into a universal checklist. For decision-relevant conclusions distinguish what cited passage establishes from assumptions/inferences/outcomes it doesn't measure. Ask whether the conclusion could be false even with all supplied facts true. General background knowledge is not verified by attaching a permitted-file ID. An unsupported conclusion belongs in hypothesis/inconclusive/required gap or qualified advice as appropriate; do not put certainty into question choices.

Finding a prior overclaim during reconsideration requires meaningful action, not only limitations text: use existing assessmentCorrections for actual misinterpretation, a genuinely permitted recheck/update where needed, current gaps and qualified final text. Reflection does not itself carry assessments/resolutions. Preserve correct G02 proceed and grounded human-gap resolution; no needless repeated questions/automatic all-gap blocked rule. No new semantic schema/keyword filter/oracle.

Explicit current capability: this saved task's SDK budget and sealed deadline are fixed. Current helper has no same-goal extension route; another user instruction alone does not resume evaluation. Keep old understanding/stop/pending material; genuine new-goal transition is separate and not unbroken same-budget continuation. No broad extension API added.

Early in activation, record available original start/deadline source or the first real observation, BEFORE deep SDK/type exploration. Respect human waiting/cancellation/followups in the same clock. Unknown earlier origin remains unknown. If deadline already passed during preparation, keep useful source-bounded explanation/pending material without evaluation; no late fresh full interval claiming the original task limit was met.

## Ownership and real RED

Existing runtime writer ONLY session-store.mjs, session.mjs, test/session-followup.test.mjs; evidence own runtime/post-G/** and own API contract. Existing docs writer ONLY SKILL.md, host-session.md, README.md after actual GREEN. PM owns feature evidence/design/state/freeze only. No core/types/report/cli/new dependencies/held-out/Hidden-Side/CrossRAG/global settings changes. All16 original product paths incl7 new remain in final review even unchanged here.

Meaningful pre-product RED invariants:
1 undated source accepted with unknown provenance/actual helper time; invalid/zone-less/future new time rejected; same old payload replay before new-only validation; legacy hash/date/helper time unchanged; date presence/value collisions.
2 sealed absolute deadline while SDK budget remains: before firstinspect, prepare->apply expiry, in-budget operation, report/status/receive afterexpiry, no new evaluation, correct session-vs-SDK stop reasons, no invented usage/understanding.
3 restart/human wait/clockless legacy/real transition/history/changed deadline rejection, cache recovery/pending transaction/cancellation, internal receipts/invalidate/idempotence; actual OS delay tests rather than fake time labels.
4 SDK hashes/bindings/accounting and optional gaps/current reflection semantics preserved. A new flag's missing entry may be RED evidence, but require behaviour assertions beyond only unsupported-option parser failures. Existing SessionStore export/direct API plus actual helper subprocesses can exercise a clock argument ignored by old implementation without product shims/fake journals.
No semantic word-matching tests or counting declarations as efficacy. Preserve old tests except explicitly documented assertions for changed new-receipt contract, with old test evidence intact.

After actual RED -> minimal fix -> focused/affected regression/build/typecheck; PM full npm once new source frozen, measured counts no assumed724. Final code/tests/doc snapshot all16/new7.

## Blinded evidence before full review

Before changes snapshot current bundle as baseline artifact, not edits to product. Preserve original actual hashes and SDK build. After revised freeze create symmetrical opaque bundle snapshots, runtime path and artifact authority verified. Independently prepare new raw before actor release, not a reworded G task.

Minimum useful comparison: one new multistage semantic/human-answer/correction raw case in a2x2 (current vs revised bundle, Google observer family used in G vs another supported host/model selected live). Four independent conversations, same data/permissions and comparable finite limits. Revised-bundle deadline/undated-provenance case on both models adds two conversations if needed to measure clock contract/resumption. At most6 initial observers, bounded by20 active/queued and actual starts; phase/DAG/ownership constrain releases. Observer gets only its assigned bundle skill/runtime + current raw, no condition labels/expected actions/G findings/author rationale. New raw can provide an explicit absolute deadline as user data, avoiding an invented hidden origin; unknown-origin coverage also tested deterministically.
Compare bundles, not isolated prompt-component causal claims. Different-model success is host/model conformance evidence, not automatic product efficacy. Same-model improvement is scoped to those raw cases. Retain every fail/partial/cancel; don't remove failures by model swapping. If this size is unnecessary, independent design reviewer should propose the smallest still-discriminating matrix.

Then only when required outcomes have actual evidence: fresh independent full-diff review, original brief/all prior rounds/responses/remaining objections, exact all16/new7 plus approved additions, TDD/software/raw outcomes. Gate truthful; parent re-audit before completion/staging/commit/push/DraftPR. No merge. Costs/tokens/quota unknown until observed. Current proposal neither A2 acceptance nor independent review PASS.

