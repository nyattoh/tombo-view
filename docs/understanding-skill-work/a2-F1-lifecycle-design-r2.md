# F1 lifecycle amendment r2 — C1/C4 coexistence only

PROPOSED; fresh cross-vendor DESIGN READINESS required before production edits. Supersedes only r1/C1's unconditional new-revision deletion and the corresponding lifecycle expectations. F1 r1 design/result and accepted-conditions document, RED29/2pass/27assertfail/exit1, original test snapshots/logs and all historical failures remain immutable.

Authority locked-charter + A2-only amendment, same goal PM. Actual path D:/develop/works/tombo-view-ask-policy, branch devin/20261020-1705-understanding-skill, HEAD/base dda5ff739ff0c23c37cc2e1d067b8ed0294cbbf9. Parent audit remains not_accepted_needs_review, A2=false/publication=false. Production source is unchanged. Only two existing test files have F1 append-only RED additions; current snapshot/proof a2-F1-RED-actual-readback-r1.json and a2-F1-RED-evidence-r1/.

## Credible evidence and exact problem
Read runtime8 terminal a2-F1-runtime-RED-terminal-result-r1.json, complete RED evidence hand_over_summary.md/verification-summary.json/design-counterexample.md/proposed-api-test-contract.md and tests. PM independently read actual log SHA d07b726154c8ae24273df227f120956a5073828764bc67bb6a7b3ff40ada3281, counts29 selected/2pass/27 assertion failures/skip0/cancel0, exact exit1 05:09:13.4187995–05:09:23.1031929 JST. Protected14 including source3 preserve bytes/exactmtime; original two test byte-prefixes preserved. PM also rehashed historical409/ask192; staged0. These are deterministic SDK/helper checks, not real external-model efficacy or measured model cost.

The existing stale-legacy-feedback reproduction uses real helper inspect, then a public SDK update with positive repairs (two genuinely executed local adapter rejections), then an explicit SessionStore direct transaction setup using that SDK result, then actual helper invalidate/prepare. It does NOT claim ordinary helper-only creation of positive-repair states. That direct-setup boundary stays explicit.

The new capture flag/object do not exist yet. The future sequence “fresh opt-in object created -> C1 deletes it on invalidate new revision -> C4 absent-object legacy fallback” is a DESIGN-LOGIC counterexample, not an executed new-object path. Current helper restores the old invalid_model_output stop after invalidation and preserves modelRepairDiagnostics. Thus blindly implementing r1 C1+C4 can re-enable an older refusal. Do not implement that contradiction or weaken the observable no-stale-feedback assertion.

## Chosen minimal amendment: retain one inactive safe record until valid success or replacement
No new option/field beyond r1 captureProposalRejection + optional lastProposalRejection, no marker/epoch counter/authority/event, no array deletion. Existing metadata shape and safe private-provenance/phase capture, actual attempt counts, returned-state task/revision/hash binding and all default/inspect/positive-repair guarantees stay.

lastProposalRejection is a bounded recovery record, NOT an assertion that every later state is currently rejected. Its atRevision and understandingHash always describe the ACTUAL original failed returned state; never restamp these historical values when carrying it forward.

Lifecycle:
| Operation outcome | Record in returned state | Feedback eligibility |
| --- | --- | --- |
| New genuine opted-in terminal update/reflect invalid_model_output after actual adapter attempt | Replace with newly captured safe object bound to that failed result | Active only if exact r1/C4 matching/gates hold |
| Validly applied update, or valid reflect output (completed or inconclusive), irrespective of ultimate ready/needs_user_input/budget policy decision | Clear the previous record in this new state | No prior rejection feedback; old immutable journal snapshots preserve history |
| Changed invalidate, checkpoint-induced stop, or non-proposal/pre-generation stop producing a new revision | Retain at most the same historical object unchanged | Inactive: atRevision is older, so suppress legacy repair-array fallback too |
| Exact no-op/same-revision return | Preserve original object/state | Same actual failed context may remain active only under all matching conditions |
| Whole-task clock stops without a new SDK revision | Keep SDK snapshot/record unchanged | Session gate returns no new prepare request or evaluation; SDK record is not retry permission |
| Genuine new-task transition | Never transplant record into new SDK task; preserve old ledger/history references | New task has no manufactured rejection |
| Legacy state without the object | No backfill, no mode inference, no hash changes | Existing legacy array fallback unchanged under existing conditions |

captureProposalRejection controls creation, not deletion of history on later opt-out calls. A later default SDK call may carry an existing opt-in historical object but must not manufacture a fresh one. Old/default states that never carried the object are unchanged. The managed helper opts in on every update/reflect, so every fresh normal managed rejection obtains current bound metadata. Explicit capture-false direct SDK/legacy clients retain legacy diagnostic limitations; this amendment does not promise retroactively fresh recovery feedback for every legacy state. Existing automatic positive repairs and their within-call feedback/call counts remain unchanged.

This retention is metadata only: F2 observations/execution/evidence scope/usage remain immutable; F3 required gap/validity/schema resolution rules are not relaxed. No same-goal budget/time extension, new discard flag, scope alias, automatic gap closure/demotion/retarget or rollback.

## Validation and feedback rules
- Optional record remains one strict bounded object; no body/raw exception/Zod/new-candidate/evidence ID copied. Safe known existing protocol targets only, otherwise generic/no target; no global ID tightening.
- checkState validates same task, atRevision <= current revision, well-shaped hash/counts/safe target and target membership. If atRevision == current revision, it must be a genuine current invalid_model_output binding with matching semantic understandingHash; corruption is invalid input, not feedback. For an OLDER record, do NOT require old hash or old stop to equal current semantic state—historical inactive metadata is valid. This permits normal invalidate/checkpoint/stops without clearing or rebasing history.
- shared helper derivation: if any lastProposalRejection is present, only its exact active operation/task/revision/hash/stop/target context can produce the deterministic safe request.validationFeedback; an inactive object yields NO feedback and NO older-array fallback. Legacy fallback remains only when object absent. Whole budget/session/accounting/pending-batch gates still precede requests. Prepare/apply requestHash derivation must be identical.
- Semantic understandingHash excludes metadata; normal whole-state/session digests include the optional saved object. The two journal digest algorithms are distinct and must not be equated. No old journal/hash rewrite or backfill.
- Success clearing is safe because that valid operation ends the rejected-proposal recovery context; stopReason is no longer that prior rejection. New normal managed failures opt in and replace metadata. Direct opt-out legacy behaviour is not strengthened by inference.

Alternatives rejected for now:
A) Delete modelRepairDiagnostics to block fallback: destroys current legacy diagnostic history/compatibility unnecessarily.
B) Add a tombstone/feedback-epoch/mode watermark: can encode suppression but adds another state dimension/lifecycle and migration distinctions not needed for this demonstrated coexistence.
C) Reset old stopReason or edit evidence/usage: violates preserved contracts.
D) Keep r1 deleting object without another discriminator: does not close the counterexample.

## RED amendment and ownership
Existing runtime owner only: src/core.ts, src/types.ts, skills/tombo-view/scripts/session.mjs, existing test/cli-model-repair.test.mjs and test/session-followup.test.mjs plus own F1 evidence, AFTER this fresh design gate and separate explicit production release. Store/report/journal/CLI/global/SKILL remain outside write set. Existing docs owner only after real API GREEN for host-session/README sync. PM writes design/evidence/state only.

After actual readiness and explicit owner release, preserve RED r1 source copies/logs. Amend ONLY new F1 lifecycle expectations that conflict with this r2 retention contract; pre-F1 test prefixes and all no-stale-feedback, no-extra-call/usage, scope/identity/expiry/privacy protections remain. In particular:
- keep “prepare.validationFeedback is undefined after changed invalidate” assertion unchanged;
- replace only new-metadata-after-new-revision undefined expectation with equality to original historical record, older atRevision and failed active checks;
- in coexistence test, positively prove actual opt-in failed state contains the new record plus real old repair array before invalidation, then assert record retained but inactive, array preserved, original stop/usage retained and no legacy feedback revival;
- valid same-batch success/valid reflection still clears record; retain these assertions;
- separately exercise no-object legacy compatibility without claiming it became fresh-only;
- stale historical task/revision/hash/operation vs corrupt current metadata are distinguished; privacy/persistence checks must actually reach the new object before being counted GREEN.
Run and record a fresh meaningful RED after approved test amendments BEFORE source edit, preserving all first attempts. No unknown-flag-only or missing-object negative privacy PASS. If another contradiction appears, stop and return it before source changes. No new worker.

Then minimal source fix -> exact targeted GREEN/all focused/related/typecheck/build -> docs API readback/freeze -> fresh full npm with actual count -> fresh raw-only behavioural checks (adequate actual answer, genuine ambiguity, correction/reframe, expiry/fresh resume) -> reliable fresh full diff all16/new7/current added tests -> task_gate -> independent parent audit -> parentPASS only exact stage/commit/push/DraftPR. No merge. Neither bounded diagnostic change nor metadata retention proves F3 fixed or general model efficacy.

## Review request
Return explicit pass/fail/needs_review for this LIFECYCLE DESIGN AMENDMENT ONLY. Read r1 complete design/review/accepted conditions, actual counterexample/test/handover, current core stopped/update/reflect/invalidate/checkpointBudget and managed stage/feedback source. Critically test whether retaining one inactive record + exact active binding + absent-only legacy fallback closes C1/C4 without new regressions or unsound legacy promises. Challenge success-clearing, opt-out calls on opt-in-derived state, no-op/current/corrupt/historical records, redacted replay, privacy/digests and meaningful test changes. Do not invent SHA values, numerical source-read limits, commands, case names or successful executions. Independent hashes/tests NOT_RUN unless actually performed. Reviewer request metadata alone is not proof of full-source reading. All prior needs_review/failures/deviation and A3 old pending remain unwaived; parent A2/publication still false.
