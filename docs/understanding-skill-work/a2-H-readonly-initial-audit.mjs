import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const plan = JSON.parse(await readFile(join(root, 'docs/understanding-skill-work/a2-H-initial-observer-plan-r1.json'), 'utf8'));
const json = async p => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const args = process.argv.slice(2);
const stage = /^(?:s[123]|user-r4)$/.test(args[0] ?? '') ? args.shift() : 's1';
for (const actor of args) {
  const target = plan.plans.find(p => p.actor === actor);
  if (!target) throw Error('Unknown actor');
  const bundle = join(root, 'results/understanding-acceptance2/bundles', target.bundle);
  const sdk = await import(pathToFileURL(join(bundle, 'dist/index.js')).href);
  const { digest, stateDigest, taskDigest } = await import(pathToFileURL(join(bundle, 'skills/tombo-view/scripts/session-store.mjs')).href);
  const dir = join(target.cwd, '.session');
  const events = (await readFile(join(dir, 'tombo-session.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const snapshot = events.at(-1).snapshot;
  const state = await new sdk.FileJournal(snapshot.binding.ledger).load();
  const output = await json(snapshot.binding.statePath);
  const cached = output.state ?? output;
  const sessionCache = await json(join(dir, 'tombo-session.json'));
  const files = await readdir(dir);
  const reflection = state?.reflection;
  const currentHash = state ? sdk.understandingHash(state) : null;
  const reflectionCurrent = !!reflection && reflection.completion === 'completed' && reflection.binding.taskId === state.taskId && reflection.binding.understandingHash === currentHash && reflection.reviewedClaimIds.length === state.claims.length && state.claims.every(c => reflection.reviewedClaimIds.includes(c.id));
  const checks = {
    contiguousSessionJournal: events.every((e, i) => e.sequence === i && e.previousHash === (i ? digest(events[i-1]) : null) && e.snapshotHash === digest(e.snapshot)),
    sessionCacheMatchesJournal: digest(sessionCache) === digest(snapshot),
    SDKcacheMatchesAuthority: state ? stateDigest(cached) === stateDigest(state) : cached === null,
    SDKheadMatchesAuthority: state ? snapshot.head.revision === state.revision && snapshot.head.stateHash === stateDigest(state) : snapshot.head === null,
    bindingTaskMatches: state ? state.taskId === snapshot.binding.taskId && taskDigest(state.task) === snapshot.binding.taskHash : true,
    pinnedTaskMatches: taskDigest(snapshot.task) === snapshot.binding.taskHash,
    pinnedBudgetMatches: state ? digest(state.task.budget) === digest(snapshot.binding.budget) : true,
    pinnedStartedAtMatches: state ? state.startedAt === snapshot.binding.startedAt : snapshot.binding.startedAt === null,
    noUnfinishedOperation: snapshot.pendingOperation === null,
    noAccountingUncertainty: snapshot.accountingUncertain === false,
    noSessionOrSDKLock: !files.some(f => f.endsWith('.lock'))
  };
  const observedAt = new Date().toISOString();
  const result = {
    actor, stage, observedAt, readOnly: true, checks,
    sessionId: snapshot.binding.sessionId, binding: snapshot.binding,
    sessionClock: snapshot.taskClock ?? null, actualPersistedSessionStop: snapshot.taskClockStop ?? null,
    clockExpiredAtReadback: snapshot.taskClock ? Date.parse(observedAt) >= Date.parse(snapshot.taskClock.deadlineAt) : null,
    clockBoundary: 'Expiry at this PM readback is a derived observation only, not a helper invocation or a new persisted SDK/session stop.',
    state: state ? { taskId: state.taskId, revision: state.revision, startedAt: state.startedAt, budget: state.task.budget, usage: state.usage, decision: state.decision, stopReason: state.stopReason, understandingHash: currentHash, reflectionCurrent, reflection: state.reflection ?? null, evidence: state.evidence.map(e => ({ id:e.id,locator:e.locator,retrievedAt:e.retrievedAt,scope:e.scope,validity:e.validity,contentHash:e.contentHash })), claims:state.claims, gaps:state.gaps, appliedExecutions:state.appliedExecutions, pendingAssessmentExecutionIds:state.pendingAssessmentExecutionIds ?? null } : null,
    cachedManagedFields: { effectiveDecision:output.effectiveDecision ?? null,understandingStatus:output.understandingStatus ?? null,taskClockStatus:output.taskClockStatus ?? null,sessionStopReason:output.sessionStopReason ?? null,hostUsage:output.hostUsage ?? null },
    receipts:snapshot.updates, stopReceipts:snapshot.stopReceipts, transitions:snapshot.transitions,
    outcome:'Structural evidence only; semantic and final-answer alignment require trace/raw readback. Completed actor task is not an acceptance PASS.'
  };
  await writeFile(join(root, 'docs/understanding-skill-work', 'a2-forward-'+actor+'-'+stage+'-managed-readback-r1.json'), JSON.stringify(result,null,2)+'\n', 'utf8');
  process.stdout.write(JSON.stringify({actor, checks, revision:state?.revision,decision:state?.decision,stopReason:state?.stopReason,budget:state?.task.budget,reflectionCurrent,sessionClock:snapshot.taskClock ?? null})+'\n');
}
