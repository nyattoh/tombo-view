# PR #8 review summary and local evidence index

This PR adds the repository TOMBO skill, managed session helper and additive SDK diagnostics described in the root README. It remains a Draft. **Original acceptance 2 and the independent parent audit are not accepted.** This repair round does not change those judgments.

## Current repair scope

- Windows workspace aliases are checked by nonzero bigint directory identity after rejecting root/ancestor link components. The original caller spelling remains available for link checks; authority paths, containment and new bindings use the physical canonical root. Existing journal events are not rewritten. Tests exercise real Windows 8.3 activation, both short/long reopen directions, exact binding and first-event preservation, managed junction rejection, and POSIX raw-store symlink/physical-cwd controls without skips.
- A goal transition now requires a valid timezone-qualified ISO `userChange.receivedAt` no more than 5 seconds beyond helper time. Date-only, timezone-less, impossible and far-future inputs reject before transition mutation. Existing identity, goal-change, budget and accounting checks remain.
- The skill sync script's Apply mode requires the exact resolved full merged commit SHA at HEAD, branch `main`, a clean tracked/untracked checkout, and containment in `origin/main`. Its deployable path list must also equal that commit's tree after the existing runtime/session exclusions. Ignored untracked deployable files cannot enter a copy. No deployed copy was synchronised in this round.

## Observed verification before PM integration

| Check | Actual result |
| --- | --- |
| Windows path/date focused RED, before store edits | 0/2 pass, exit 1 |
| Windows focused GREEN | 2/2 pass, exit 0 |
| Related binding/follow-up/host-trial regression | 74/74 pass, exit 0 |
| Platform-aware follow-up on Windows Node 24 | focused 2/2 and related 28/28, exit 0 |
| Initial sync guard RED / GREEN in temporary Git repos | 6 failures / 10/10 pass |
| Ignored-source counterexample RED / GREEN | clean Git status still reached intercepted copy / 11/11 pass |
| Destination-write isolation harness | 12/12 pass; copy and directory creation separately intercepted |

All listed successful tests had fail/skip/cancelled 0. Sync fixtures intercepted Copy-Item and did not write any real destination. Linux local execution was NOT_RUN (WSL access denied; no container runtime); final Ubuntu and Windows Node 22/24 CI are mandatory and are not inferred from the Windows results. PM integration and new-head CI results are recorded in the live PR body/checks after execution. Historical 767/767 and earlier counts in README refer to their stated older freezes.

## Hosted Windows follow-up (r2)

The first repair head `eb6e9c6` failed hosted Windows CI. Runs `39511489382` (push) and `39511495885` (pull_request) are retained as failures/cancellations; Ubuntu test success in a cancelled job is not a successful job. The two runs correspond to the two configured workflow events, not evidence of duplicate pushes. The actual local counterexample was an 8.3 alias with the same file identity that failed the old lexical workspace check.

The same A owner recorded no-skip RED, then actual managed CLI and canonical-binding RED (8 tests: 6 pass/2 fail) before the respective fixes. Final Windows Node24 focused tests are 8/8, related binding/follow-up/host-trial regression 74/74, build/typecheck exit 0. The test-only portability follow-up retained all Windows assertions and added POSIX physical-cwd observation alongside direct raw-store link rejection. Linux local execution remains NOT_RUN. Hosted Ubuntu/Windows Node22/24 success on the new head is required independently of local GREEN.

The earlier PM full suite at `eb6e9c6` was 781/781 (fail/skip/cancelled 0, exit 0), with build exit 0; it is a historical local baseline, not verification of this changed source. Current integration results and all eight job conclusions are recorded in the live PR body with their head/run IDs. No review-request comment is posted until all eight current-head jobs succeed.

## Codex P1/P2 repair — 2026-10-23

- P1: activation and genuine transition validate the parsed TaskPacket before committing a new session: unique evidence IDs, available passages, matching passage hashes and the existing SDK inspect input-character cap. Validation is pure; no model call or budget reset is used. The managed helper itself is unchanged.
- Direct Store rejection preserves all prior session/SDK/cache bytes; invalid CLI activation creates no authority. Invalid CLI transition rejects the task while retaining the existing checkpoint observation: exactly one journal event, only session journal/cache changed, only lastObservedAt advances. SDK ledger/state bytes, binding/task/head/history/revision and transaction/accounting state remain unchanged. Parent approved this explicit boundary after an isolated checkpoint-only control matched it; it does not permit an invalid-task commit.
- P2: Apply compares each deployable source file's raw Git object ID (`hash-object --no-filters`) with the exact blob in the resolved commit. Hidden edits using assume-unchanged or skip-worktree reject before both destination-write interceptors. Fixture flags are cleared in finally. No deployed copy was accessed or synchronised.

P1 preserves initial RED12/12 and the intermediate11/12 checkpoint-boundary result. The final revised baseline run is21 tests/16 pass/5 fail: the five failures are baseline direct-activation parent+four variants; other direct/CLI paths in that run use current code. Current-source focused GREEN is21/21, related regression82/82, build/typecheck exit0. P2's RED is14 tests/11 pass/3 fail (two flag cases plus their parent), then14/14 GREEN. All final tests have skip0. PM integrated npm/build results and current-head CI/review results belong to the live PR execution record; previous787/787 is an older freeze only.

## R3 session lifecycle repair (base ef009567)

- Managed inspect validates the supplied activated evidence passages/hashes before opening the SDK transaction, while retaining sealed task/budget matching. A rejected changed passage does not leave an unfinished transaction or accounting uncertainty.
- New observation receipts are checked against the current SDK probes/evidence before append. Exact receipt replay is resolved first and preserves the original helper time/status, including after evidence invalidation. Compatible redacted passage rehydration and evidence whose assessment is out of scope remain supported.
- Receipt application uses linked, committed, non-pending execution proof. Unevaluated managed invalid_input and direct SDK/store no_progress results retain pending receipts; valid assessment/retry applies them. Mixed receipts retain their unassessed fresh observations after invalidation. The existing actual-matching receipt guard and existing tests/fixtures are preserved.

The exact base helper/store bundle produced the accepted baseline RED:7 tests/2 pass/5 assertion failures/skip0. It covers altered inspect transaction poisoning, unknown probe intake, evidence-ID collision intake, actual managed invalid_input receipt promotion, and direct SDK/store no_progress promotion. Managed no_progress with a receipt is not reachable through the existing receipt-link guard; that case is labelled as a direct SDK/store test. Initial contract-3 fixture/link failures are preserved but excluded from meaningful RED claims. A provisional empty-observation guard relaxation was rejected and removed. The introduced exact-replay regression (7/8) and mixed-receipt regression (81/82) are retained as failures and were corrected without changing existing assertions.

Final runtime focused tests:8/8; related session/binding/platform/host-trial regression:82/82; build/typecheck exit0; skip0. These are Windows Node24 deterministic results. PM full npm/build and the separate internal different-vendor review are recorded for their actual later runs, not assumed here. This repair does not complete A2, the original full-review gate or the parent audit. No GitHub review-request comments or deployed-copy sync are authorised for R3.

### R3 review finding response

The first Google internal review passed its original freeze and identified a low receipt-ID object-key issue. Actual follow-up RED reproduced two failures: __proto__ link loss after staged journal recovery and constructor inherited-function lookup. Receipt IDs remain arbitrary nonempty strings; no UUID/prefix restriction was introduced. A null-prototype execution-link map plus own-property lookup now preserves selected receipt application and unselected pending status across staged SDK commit/reconcile/reload for __proto__, constructor and toString. Focused11/11 and related82/82 pass, skip0. The first PASS remains bound to its old hashes; the final hardening freeze is submitted to one fresh Google round2. PM full npm/build is not yet run for this final freeze.

## Historical evidence and review boundaries

The earlier D01 same-goal task/budget reset failure, E activation limits, F/G timestamp and semantic overclaims, H semantic/quota partials and remaining old gaps are retained. Registered H's 18 turns/8 threads remain separate from the two additional actual-user continuations. H01-A3's old pending request is not answered using another case. F1's bounded rejection diagnostics do not repair already-created claimless required gaps or prove semantic truth/model efficacy.

The former full-diff review was NEEDS_REVIEW; its unreliable hash/read-coverage claims are not adopted. The recorded gate was exit 3 (G2/G12/G14), the independent parent decision was `not_accepted_needs_review`, and the AGENTS discovery deviation remains `recorded_unwaived_for_parent_audit`. This PR repair/push authorisation is separate from original goal acceptance. No merge, main/force push, deployment or general efficacy claim is authorised.

## Local-only evidence manifest

[evidence-manifest.jsonl](evidence-manifest.jsonl) contains one JSON object per locally retained evidence file: repository-relative `path`, raw-byte `sha256` and `size`. It includes the files removed from this PR's current index plus frozen A/B repair evidence. These entries identify bytes; they do not make local data downloadable from the PR or establish acceptance.

The 1821 bulk `docs/understanding-skill-work/**` records, including `linked-evidence/`, remain locally retained and excluded from the current PR tree. The mutable PM `task-state.json` was updated during continuation; its current frozen bytes and previous manifest entry are explicitly recorded. The other prior manifest entries match their original bytes. Further live PM metadata is kept outside this frozen snapshot. Existing Git history is not rewritten. Historical `docs/ask-policy-work/` files and ignored results/build outputs are also retained locally. The PR keeps this short summary, the manifest and its body draft; root README links formerly targeting excluded records now point here. Detailed audit/evaluation requires the retained local files, not just this summary.
