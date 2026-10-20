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

## Historical evidence and review boundaries

The earlier D01 same-goal task/budget reset failure, E activation limits, F/G timestamp and semantic overclaims, H semantic/quota partials and remaining old gaps are retained. Registered H's 18 turns/8 threads remain separate from the two additional actual-user continuations. H01-A3's old pending request is not answered using another case. F1's bounded rejection diagnostics do not repair already-created claimless required gaps or prove semantic truth/model efficacy.

The former full-diff review was NEEDS_REVIEW; its unreliable hash/read-coverage claims are not adopted. The recorded gate was exit 3 (G2/G12/G14), the independent parent decision was `not_accepted_needs_review`, and the AGENTS discovery deviation remains `recorded_unwaived_for_parent_audit`. This PR repair/push authorisation is separate from original goal acceptance. No merge, main/force push, deployment or general efficacy claim is authorised.

## Local-only evidence manifest

[evidence-manifest.jsonl](evidence-manifest.jsonl) contains one JSON object per locally retained evidence file: repository-relative `path`, raw-byte `sha256` and `size`. It includes the files removed from this PR's current index plus frozen A/B repair evidence. These entries identify bytes; they do not make local data downloadable from the PR or establish acceptance.

The 1821 bulk `docs/understanding-skill-work/**` records, including `linked-evidence/`, remain locally retained and excluded from the current PR tree. The mutable PM `task-state.json` was updated during continuation; its current frozen bytes and previous manifest entry are explicitly recorded. The other prior manifest entries match their original bytes. Further live PM metadata is kept outside this frozen snapshot. Existing Git history is not rewritten. Historical `docs/ask-policy-work/` files and ignored results/build outputs are also retained locally. The PR keeps this short summary, the manifest and its body draft; root README links formerly targeting excluded records now point here. Detailed audit/evaluation requires the retained local files, not just this summary.
