# hand_over_summary — understanding-oriented repository skill

Status: ready-for-parent-decision, NOT acceptance-ready or publication-ready. Same real goal PM is still running closing/audit coordination. Fresh review r2 is NEEDS_REVIEW with acceptance2 unresolved. No commit/push/PR performed. Locked charter unchanged.

## Goal and result so far

Repository skill now describes sustained attention to understanding in development and conversation, covering proceed/check/ask/reframe/blocked, model-authored real task inputs, follow-up observations and human answers, correction, persistence and honest resumption limits. Normal discovery remains host-dependent; no installed global skill/hook or all-message interception was added. Model semantic correctness remains fallible.

Scope mismatch diagnostics are a pure additive SDK function and helper/report explanation. They identify claim/evidence/assessment/scopes/reason, distinguish declared and literal mismatch, exclude corrected/invalid evidence, and flag historical redacted passages. They do not alter state/policy/hash/validity or universally block a task.

Changed runtime files: src/types.ts, src/core.ts, src/report.ts, skills/tombo-view/scripts/session.mjs. Skill/docs: skills/tombo-view/SKILL.md, references/host-session.md, agents/openai.yaml, README.md. New tests: assessment-scope-diagnostics.test.mjs, assessment-scope-report.test.mjs, understanding-session.test.mjs. Existing cli-model-repair.test.mjs assertion update is narrowly justified by the added report section; no skip or relaxed evidence validity.

## Actual checks

- Setup: writable probe created/read/deleted; exact attached worktree verified. Fresh origin/main dda5ff7, branch devin/20261020-1705-understanding-skill. Main checkout never directly inspected. All192 historical untracked ask-policy-work files retained; charter checksum unchanged.
- Baseline npm test: exit0,667/667,skip0.
- Actual pre-production RED: focused three-file command exit1,5pass/6fail. GREEN: same command exit0,11/11. TDD artifacts are under tdd/; initial test-adapter defects were corrected before the adopted red-final run.
- Related regression:202/202,skip0. Build/typecheck:exit0.
- Integrated npm test r1:676pass/2fail/skip0; old whole-report reason suppression conflicted with new diagnostic section. Test-only bounded-section assertions preserve old uncertainty and withdrawn/superseded suppression and positively assert new diagnostic fields.
- Integrated npm test r2:678/678,fail0/skip0. Runtime code/tests unchanged after this run; later skill prose validated with quick_validate and diff-check exit0. No unnecessary repeated full suite.
- Independent design review r1: actual Google PASS before implementation. Independent full-diff r1: static PASS, explicitly excluded then-pending behavioural acceptance. Fresh full-diff r2: NEEDS_REVIEW, specifically unmet acceptance2 in D01 same-goal accounting. Full report: full-review-r2.md/result.json.
- task_gate.py: parent-decision-gate.json actually executed exit3, G2 verify verdict needs_review and G12 PM still running. Not a gate PASS. No synthetic PM-completed status was entered to force the gate green.

## Behavioural evidence and unresolved items

Read behavioural-evaluation.md for all19 staged model turns across11 new synthetic raw cases. Observer briefs contained actual skill and raw current scenario only, without expected answers, charter, previous findings or future-stage messages. Complete observed examples include C01 adequate-evidence proceed, C02 actual human answer/update in the same task, and B04 fresh-conversation save/replay/invalidate/update/reflect in the same task with start/usage retained. B03 mismatch diagnosis/report was exercised with validation repair and unknown retained.

Failures/partial results remain, including budget estimation, malformed proposals, invented personal priority, incorrect causal certainty and same-goal task transitions. Two bounded instruction corrections were made, with new raw retesting. Latest D01 correctly keeps alternative-cause contributions unknown but still moves a same-goal follow-up to a fresh task/budget after expiration without complete prior-usage handover. That continuity limitation remains; it is not a pass and has not been hidden by the new task reaching ready. Review and parent must assess this against the charter before any completion/publication claim. No third silent correction is allowed.

Costs and tokens unknown. Catalogue cost indicators are selection metadata, not actual expenditure. No direct new/paid model API, secret access, new dependency, global configuration, Hidden-Side/CrossRAG or held-out data changes.

## Orchestration and next action

One real PM (original node receipt in pm-dispatch-receipt.json) owns this directory except the parent-owned charter/audit. Product/test/skill writes were delegated under disjoint ownership; PM wrote planning/evidence only and ran integration checks. Actual starts:31 child task turns across19 distinct child threads; maximum active/queued6, current children0. Final live task_status readback of all31 taskIds confirms completed, no pending child runs/questions (child-final-statuses.json). PM is still running closing work; PM runtime is not confused with child terminal status.

Parent must independently audit the concrete diff, actual31 child states, needs_review verdict and G2/G12 gate failures. Unmet acceptance must not be waived by relabelling it a generic model limitation or by marking PM done. Two bounded fix rounds are exhausted; no third implementation or review loop is silently authorised. Commit/push/Draft PR/link require all required passes and parent PASS, which are absent. Merge prohibited. Same PM awaits parent decision and retains all artifacts; this is not goal completion.
