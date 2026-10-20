# Post-G design readiness readback and implementation contract

2026-10-21 JST. Same goal PM run62. Actual Google review completed; full result and exact handle saved in a2-post-G-independent-design-result-r1.json. Verdict PASS (DESIGN READINESS ONLY), not A2/full-diff/goal acceptance.

The immutable charter and parent A2 amendment authorise this narrow repair after earlier escalation; they do not erase the two-round history or any D/E/F/G failure. Fresh final full-diff review and independent parent audit remain required before publication.

Accepted pre-implementation conditions:
1. Guard null SDK state in helper managedReport; do not modify SDK report.ts. An activated task can expire before first inspect and must remain honestly reportable.
2. Validate base receipt shape and deterministic payload/execution integrity; exact existing legacy payload replay returns its original receipt before NEW-only timestamp validation. New receivedAt is optional; supplied new date requires explicit ISO timezone and cannot exceed the single helper acceptance observation by more than 5000ms. Reject before append/ID reservation. Preserve collision checks, old hash/time/usage and internal-receipt idempotence. Do not interpret this tolerance as authenticated provenance or automatic date correction.
3. Optional sealed activate/legitimate-transition task-clock descriptor as proposal. first_observed requires non-null actual observed start. Already-past deadline seals an expired session rather than throwing. Gate prepare and inspect/update/reflect/invalidate, including pre-initial-inspect. Preserve SDK clocks/accounting/reasons; expose separate session deadline stop and false completion. Preserve sealed clock through recovery and genuine transition history.
4. K4 baseline snapshot was created BEFORE RED/product edits. a2-post-G-baseline-recheck-r1.json verifies all 37 copied files including every current16/new7 file. This is the uncommitted post-F/G working tree at HEAD dda5ff7, NOT the contents committed at dda5ff7. Reviewer's shorthand about commit contents is not adopted.
5. Real behavioural RED assertions before product edits, then minimal GREEN/affected regression/build/typecheck. Preserve 724 baseline evidence. Record any directly necessary old timestamp assertion changes explicitly; no skips as success.

Schema precision: reviewer prose says assessment verdict 'disputed'; implementers must use the EXISTING SDK assessment enum (e.g. inconclusive where supported). Claim status disputed is distinct. No new verdict/API or core/types changes are authorised.

Comparative evaluation is a bounded bundle/model comparison, not proof isolating a component's causal effect or general efficacy. At most six initial observers, opaque bundle labels and unseen raw only, same access/permissions. No observers until revised runtime/docs freeze. No author findings, expectations, future stages or condition labels disclosed.

Runtime sole write set: skills/tombo-view/scripts/session-store.mjs, skills/tombo-view/scripts/session.mjs, test/session-followup.test.mjs; own results/understanding-acceptance2/runtime/post-G/** and own runtime/api-contract.md additive current-contract record. All other product/test files frozen.
Docs sole write set after actual API GREEN: skills/tombo-view/SKILL.md, skills/tombo-view/references/host-session.md, README.md and own results docs. PM writes only evidence/state/plan. No overlapping writers, no additional implementation owner.
