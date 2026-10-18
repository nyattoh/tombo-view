import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  BASE_COMMIT, prepareBaseline, projectToOldSchema, normaliseDecision,
  validateDataset, compareDataset, serialiseReport, sha256,
} from '../scripts/ask-policy-compare.mjs';

const root = resolve(import.meta.dirname, '..');
const vendors = ['openai', 'google', 'nvidia'];
function state(kind = 'empty', probe = false) {
  const task = {
    schemaVersion: '0.1', taskId: 'unit-task', goal: 'Choose the next bounded action', mode: 'explain',
    successCriteria: ['Ground the next action'], evidence: [], capabilities: ['local'],
    budget: { maxRounds: 5, maxModelCalls: 10, maxToolCalls: 10, maxElapsedMs: 10000, maxInputChars: 10000, maxOutputTokensPerCall: 1000 },
  };
  return {
    schemaVersion: '0.1', taskId: task.taskId, revision: 0, startedAt: '2026-10-18T00:00:00Z', task,
    evidence: [], claims: [], lenses: kind === 'empty' ? [] : [{ id: 'lens', label: 'Scope', rationale: 'Bound the question', origin: 'initial', status: 'active' }],
    gaps: kind === 'empty' ? [] : [{ id: 'gap', kind, lensId: 'lens', question: 'Which requirement applies?', triggerRefs: ['task:goal'], whyItMatters: 'Changes the next action', importance: 'required', claimIds: [], probeIds: probe ? ['probe'] : [], status: 'open' }],
    probes: probe ? [{ id: 'probe', gapIds: ['gap'], method: 'dependency', question: 'Read the local source', requiredCapability: 'local', sourceGroups: [], successCondition: 'Source found', refutationCondition: 'Source refutes', inconclusiveCondition: 'No result', status: 'pending' }] : [],
    usage: { rounds: 0, modelCalls: 0, toolCalls: 0, elapsedMs: 0, totalTokens: null, costYen: null },
    decision: 'blocked', stopReason: null, appliedExecutions: [],
  };
}
function dataset() {
  const cases = ['u-03', 'u-01', 'u-04', 'u-02'].map(caseId => {
    const s = state();
    return { caseId, domain: 'development', input: { packet: structuredClone(s.task), state: s } };
  });
  const actions = { 'u-01': ['ask', 'ask', 'ask'], 'u-02': ['check', 'check', 'check'], 'u-03': ['proceed', 'proceed', 'proceed'], 'u-04': ['ask', 'check', 'ask'] };
  const intent = cases.map(({ caseId }) => ({ caseId, authorIntentAction: 'proceed', isControl: caseId === 'u-02' }));
  const rawLabels = Object.fromEntries(vendors.map((vendor, i) => [vendor, cases.map(({ caseId }) => ({ caseId, vendor, model: `unit-${vendor}`, action: actions[caseId][i], reasonPath: 'state.task' }))]));
  const annotations = cases.map(({ caseId }) => {
    const unanimous = new Set(actions[caseId]).size === 1;
    const consensusAction = unanimous ? actions[caseId][0] : null;
    return { caseId, expectedAction: consensusAction, consensusAction, authorIntentAction: 'proceed', unanimous, authorIntentDiffers: unanimous && consensusAction !== 'proceed' };
  });
  return { cases, intent, rawLabels, annotations, disagreements: [{ caseId: 'u-04', votes: { openai: 'ask', google: 'check', nvidia: 'ask' }, reason: 'Independent votes differ' }] };
}
let baseline;
async function getBaseline() { return baseline ??= await prepareBaseline({ root }); }

test('snapshot bytes and blob IDs are exactly the committed Git objects; bridge runs as ESM', async () => {
  await getBaseline();
  for (const name of ['core', 'types']) {
    const bytes = execFileSync('git', ['show', `${BASE_COMMIT}:src/${name}.ts`], { cwd: root });
    assert.deepEqual(await readFile(join(baseline.directory, 'src', `${name}.ts`)), bytes);
    assert.equal(baseline.sources[name].sha256, sha256(bytes));
    assert.equal(baseline.sources[name].blobId, execFileSync('git', ['rev-parse', `${BASE_COMMIT}:src/${name}.ts`], { cwd: root, encoding: 'utf8' }).trim());
  }
  const core = await readFile(join(baseline.directory, 'src/core.ts'));
  const bridge = await readFile(join(baseline.directory, '.generated/core-bridge.ts'));
  assert.deepEqual(bridge, Buffer.concat([core, Buffer.from('\nexport { result as evaluateBaselinePolicy };\n')]));
  assert.equal(typeof baseline.module.evaluateBaselinePolicy, 'function');
  assert.equal(typeof baseline.module.validateState, 'function');
  assert.equal(baseline.evaluate(state()).state.decision, 'ready_for_requested_step');
});

test('a modified snapshot is rejected rather than silently replaced', async () => {
  const directory = await mkdtemp(join(root, 'evaluation/ask-policy-baseline/f2ecc2e/.generated/tamper-'));
  try {
    await prepareBaseline({ root, directory });
    await writeFile(join(directory, 'src/core.ts'), 'tampered');
    await assert.rejects(prepareBaseline({ root, directory }), /snapshot.*mismatch/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual old rule checks before intent, asks only all-intent with no probe, blocks mixed gaps', async () => {
  await getBaseline();
  assert.equal(normaliseDecision(baseline.evaluate(state('ambiguous_intent', true)).state.decision), 'check');
  assert.equal(normaliseDecision(baseline.evaluate(state('ambiguous_intent')).state.decision), 'ask');
  const mixed = state('ambiguous_intent');
  mixed.gaps.push({ ...mixed.gaps[0], id: 'fact', kind: 'missing_fact' });
  assert.equal(normaliseDecision(baseline.evaluate(mixed).state.decision), 'blocked');
  const reflection = state(); reflection.task.reflectionRequired = true;
  assert.equal(normaliseDecision(baseline.evaluate(reflection).state.decision), 'reframe');
  const budget = state('ambiguous_intent'); budget.usage.modelCalls = budget.task.budget.maxModelCalls;
  assert.equal(baseline.evaluate(budget).state.stopReason, 'budget_exhausted');
  const invalid = state(); invalid.taskId = 'wrong';
  assert.throws(() => baseline.evaluate(invalid), /Task ID mismatch/);
});

test('old projection removes only three additive fields and never mutates the input', async () => {
  await getBaseline();
  const s = state('ambiguous_intent'); s.policyHistory = {}; s.reflectionEffects = {}; s.gaps[0].humanRole = 'goal';
  const before = structuredClone(s);
  assert.deepEqual(projectToOldSchema(s), state('ambiguous_intent'));
  assert.deepEqual(s, before);
  assert.equal(baseline.evaluate(s).state.decision, 'needs_user_input');
  s.unrecognised = true;
  assert.throws(() => baseline.evaluate(s), /unrecognised/);
});

test('schema-required lens.label is observable input and both real old validators run in the harness', async () => {
  await getBaseline();
  const data = dataset();
  const s = state('ambiguous_intent', true);
  data.cases[0].input = { packet: structuredClone(s.task), state: s };
  const report = compareDataset(data, { oldEvaluate: baseline.evaluate, newEvaluate: baseline.evaluate,
    oldValidate: baseline.module.validateState, newValidate: baseline.module.validateState }, { formal: false });
  assert.equal(report.cases.find(r => r.caseId === data.cases[0].caseId).oldPolicyChoice, 'check');
});

test('two real baseline generations have identical source, JS bytes and fingerprints', async () => {
  await getBaseline();
  const files = ['core-bridge.ts', 'core-bridge.js', 'types.ts', 'types.js'];
  const before = await Promise.all(files.map(f => readFile(join(baseline.directory, '.generated', f))));
  const second = await prepareBaseline({ root });
  const after = await Promise.all(files.map(f => readFile(join(baseline.directory, '.generated', f))));
  assert.deepEqual(before, after);
  assert.deepEqual(baseline.bridge, second.bridge);
  assert.deepEqual(baseline.sources, second.sources);
});

test('normalisation matches the five design wire values and rejects unknown decisions', () => {
  for (const [wire, choice] of Object.entries({ ready_for_requested_step: 'proceed', needs_check: 'check', needs_user_input: 'ask', needs_reflection: 'reframe', blocked: 'blocked' })) assert.equal(normaliseDecision(wire), choice);
  assert.throws(() => normaliseDecision('ask'), /Unknown/);
});

test('unanimous-only metrics distinguish all false asks from the control subset and missed asks', () => {
  const data = dataset();
  let i = 0;
  const oldEvaluate = () => ({ state: { decision: ['needs_check', 'needs_user_input', 'needs_user_input', 'needs_user_input'][i++] } });
  let j = 0;
  const newEvaluate = () => ({ state: { decision: ['needs_user_input', 'needs_check', 'needs_user_input', 'needs_user_input'][j++] } });
  const report = compareDataset(data, { oldEvaluate, newEvaluate, oldValidate: x => x, newValidate: x => x }, { formal: false });
  assert.deepEqual(report.cases.map(x => x.caseId), ['u-01', 'u-02', 'u-03', 'u-04']);
  assert.deepEqual(report.metrics.old, { tp: 0, fp: 2, fn: 1, precision: 0, recall: 0, unnecessaryAsks: 2, controlViolations: 1, missedAsks: 1 });
  assert.deepEqual(report.metrics.new, { tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1, unnecessaryAsks: 1, controlViolations: 0, missedAsks: 0 });
  assert.equal(report.consensusCount, 3);
  assert.equal(report.disagreementCount, 1);
  assert.deepEqual(report.changedCases, report.cases.filter(x => x.oldPolicyChoice !== x.newPolicyChoice));
  assert.deepEqual(report.nonConsensusCases, [report.cases[3]]);
  assert.equal(report.cases.length, data.cases.length);
});

test('zero denominators are null and author intent never substitutes for consensus', () => {
  const data = dataset();
  const evaluate = () => ({ state: { decision: 'ready_for_requested_step' } });
  const report = compareDataset(data, { oldEvaluate: evaluate, newEvaluate: evaluate, oldValidate: x => x, newValidate: x => x }, { formal: false });
  assert.equal(report.metrics.new.precision, null);
  assert.equal(report.metrics.new.recall, 0);
  for (const vendor of vendors) for (const row of data.rawLabels[vendor]) row.action = 'proceed';
  for (const row of data.annotations) Object.assign(row, { expectedAction: 'proceed', consensusAction: 'proceed', unanimous: true, authorIntentDiffers: false });
  data.disagreements = [];
  const empty = compareDataset(data, { oldEvaluate: evaluate, newEvaluate: evaluate, oldValidate: x => x, newValidate: x => x }, { formal: false });
  assert.equal(empty.metrics.new.recall, null);
});

const invalidMutations = {
  'duplicate case': d => d.cases.push(d.cases[0]),
  'unknown case': d => d.rawLabels.google[0].caseId = 'unknown',
  'missing vendor row': d => d.rawLabels.nvidia.pop(),
  'duplicate vendor row': d => d.rawLabels.openai.push(d.rawLabels.openai[0]),
  'missing vendor': d => delete d.rawLabels.nvidia,
  'unknown vendor': d => d.rawLabels.extra = d.rawLabels.openai,
  'same vendor': d => d.rawLabels.nvidia.forEach(r => r.vendor = 'openai'),
  'unknown action': d => d.rawLabels.google[0].action = 'maybe',
  'false consensus': d => d.annotations.find(r => r.caseId === 'u-04').expectedAction = 'ask',
  'missing annotation': d => d.annotations.pop(),
  'unknown annotation': d => d.annotations[0].caseId = 'unknown',
  'duplicate annotation': d => d.annotations.push(d.annotations[0]),
  'missing intent': d => d.intent.pop(),
  'unknown intent': d => d.intent[0].caseId = 'unknown',
  'missing disagreement': d => d.disagreements.pop(),
  'false votes': d => d.disagreements[0].votes.google = 'ask',
  'packet mismatch': d => d.cases[0].input.packet.goal = 'Different',
  'taskId mismatch': d => d.cases[0].input.state.taskId = 'Different',
  'leaked label': d => d.cases[0].input.state.label = 'ask',
  'unknown schema field': d => d.cases[0].surprise = 1,
  'answer-bearing ID': d => d.cases[0].caseId = 'ask-01',
};
for (const [name, mutate] of Object.entries(invalidMutations)) test(`validation fails closed: ${name}`, () => {
  const data = dataset(); mutate(data);
  assert.throws(() => validateDataset(data, { formal: false }));
});

test('formal dataset requirements cannot accept tiny synthetic fixtures', () => {
  assert.throws(() => validateDataset(dataset()), /60/);
});

test('the harness validates both states, isolates evaluator mutations, and produces identical bytes', () => {
  const data = dataset(), before = structuredClone(data), seen = [];
  const evaluate = s => { s.task.goal = 'mutated by evaluator'; return { state: { decision: 'ready_for_requested_step' } }; };
  const validators = { oldValidate: s => { seen.push(s.task.goal); return s; }, newValidate: s => { seen.push(s.task.goal); return s; } };
  const first = serialiseReport(compareDataset(data, { oldEvaluate: evaluate, newEvaluate: evaluate, ...validators }, { formal: false }));
  const second = serialiseReport(compareDataset(data, { oldEvaluate: evaluate, newEvaluate: evaluate, ...validators }, { formal: false }));
  assert.equal(first, second); assert.equal(sha256(first), sha256(second));
  assert.equal(seen.length, 16); assert.ok(seen.every(x => x === before.cases[0].input.packet.goal));
  assert.deepEqual(data, before);
  assert.throws(() => compareDataset(data, { oldEvaluate: evaluate, newEvaluate: evaluate, oldValidate: () => { throw Error('bad old state'); }, newValidate: x => x }, { formal: false }), /bad old state/);
  assert.throws(() => compareDataset(data, { oldEvaluate: evaluate, newEvaluate: evaluate, oldValidate: x => x, newValidate: () => { throw Error('bad new state'); } }, { formal: false }), /bad new state/);
});
