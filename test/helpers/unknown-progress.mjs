import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createTombo, hashPassage } from '../../dist/index.js';

export async function recordedFixture() {
  return JSON.parse(await readFile(new URL('../fixtures/unknown-progress/recorded.json', import.meta.url), 'utf8'));
}

export async function replayRecorded({ budgetOverrides = {}, evidenceOverride, staticSnapshot = 'graph-exp-2025-02-14', alterProposal } = {}) {
  const recording = await recordedFixture();
  const task = structuredClone(recording.task);
  Object.assign(task.budget, budgetOverrides);
  const batches = structuredClone(recording.observations);
  if (staticSnapshot !== null) for (const batch of batches) for (const observation of batch) observation.staticSnapshot = staticSnapshot;
  if (evidenceOverride) Object.assign(batches[1][0].evidence[0], evidenceOverride);
  let proposalIndex = 0;
  const sdk = createTombo({ now: () => Date.parse(task.evidence[0].retrievedAt), adapter: { async generate() {
    assert.ok(proposalIndex < recording.proposals.length, 'Recorded proposals exhausted');
    const proposal = structuredClone(recording.proposals[proposalIndex]);
    alterProposal?.(proposal, proposalIndex);
    proposalIndex++;
    return { proposal, usage: { totalTokens: null, costYen: null, outputTokens: 0 } };
  } } });
  const states = [await sdk.inspect(task)];
  for (const observations of batches) states.push(await sdk.update(states.at(-1).state, observations));
  return { recording, states, sdk, batches, proposalIndex };
}

export function progressScenario({ secondProbe = false, budget = {}, reflectionRequired = true } = {}) {
  const passage = 'A and B rows are complete; C rows are unknown.';
  const evidence = (id, override = {}) => ({ id, kind: 'document', locator: 'record:fixed-export', sourceGroup: 'export', version: '1', scope: 'graph', passage, contentHash: hashPassage(passage), retrievedAt: '2026-10-14T00:00:00Z', validity: 'current', ...override });
  const probe = id => ({ id, gapIds: ['gap'], method: 'dependency', question: 'Read the authorised record.', requiredCapability: 'read_record', sourceGroups: ['export'], successCondition: 'D is shown to be reachable.', refutationCondition: 'Complete graph excludes D.', inconclusiveCondition: 'C remains unknown.' });
  const initial = {
    claims: [{ id: 'claim', role: 'answer_claim', text: 'D is reachable.', scope: 'graph' }],
    lenses: [{ id: 'lens', label: 'Coverage', rationale: 'Missing C rows can change reachability.', origin: 'initial', status: 'active' }],
    gaps: [{ id: 'gap', kind: 'unsupported_claim', lensId: 'lens', question: 'Can D be reached?', triggerRefs: ['claim'], whyItMatters: 'Missing rows can hide a path.', importance: 'required', claimIds: ['claim'], probeIds: secondProbe ? ['p-static', 'p-other'] : ['p-static'] }],
    probes: (secondProbe ? ['p-static', 'p-other'] : ['p-static']).map(probe),
  };
  let suppliedProposal;
  let generations = 0;
  const sdk = createTombo({ adapter: { async generate(input) {
    generations++;
    return { proposal: input.operation === 'inspect' ? initial : suppliedProposal ?? { assessments: input.observations.flatMap(item => item.evidence.map(e => ({ claimId: 'claim', evidenceIds: [e.id], verdict: 'inconclusive', scopeMatched: true, reason: 'C remains unknown.' }))) }, usage: { totalTokens: 0, costYen: 0, outputTokens: 0 } };
  } } });
  const task = { schemaVersion: '0.1', taskId: 'static-progress', goal: 'Check graph coverage.', mode: 'explain', successCriteria: ['Retain unknown rows.'], evidence: [], capabilities: ['read_record'], ...(reflectionRequired ? { reflectionRequired: true } : {}), budget: { maxRounds: 10, maxModelCalls: 20, maxToolCalls: 20, maxElapsedMs: 10000, maxInputChars: 48000, maxOutputTokensPerCall: 4000, ...budget } };
  const observation = (id, overrides = {}) => ({ executionId: `exec-${id}`, probeId: 'p-static', outcome: 'completed', evidence: [evidence(id)], toolCalls: 1, elapsedMs: 0, costYen: 0, staticSnapshot: 'export-run-1', ...overrides });
  const critic = { async reflect(input) { return { binding: input.binding, reviewedClaimIds: input.state.claims.map(c => c.id), completion: 'completed', limitations: [], proposal: {}, usage: { totalTokens: 0, costYen: 0, outputTokens: 0 } }; } };
  return { sdk, task, evidence, observation, critic, probe, setProposal: value => { suppliedProposal = value; }, generations: () => generations };
}

