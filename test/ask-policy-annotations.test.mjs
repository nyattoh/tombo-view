import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  integrateAnnotations, verifyIntegratedAnnotations, serialiseAnnotations,
} from '../scripts/ask-policy-annotations.mjs';

// All invented fixtures, labels and dispatch handles in this file are synthetic.
const vendors = ['openai', 'google', 'nvidia'];
const actions = ['proceed', 'check', 'ask', 'reframe', 'blocked'];
const domains = ['development', 'automation', 'research'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const artefact = (name, value, raw = false) => {
  const bytes = raw ? value : json(value);
  return { path: `docs/ask-policy-work/annotation-runs/${name}`, sha256: digest(bytes), bytes };
};
const replace = (file, value, raw = false) => Object.assign(file, artefact(file.path.split('/').at(-1), value, raw));
const parse = file => JSON.parse(file.bytes);
function handle(name) {
  return { taskId: `synthetic-task-${name}`, runId: `synthetic-run-${name}`, threadId: `synthetic-thread-${name}`,
    providerInstanceId: 'synthetic-host', model: `synthetic-model-${name}`, options: [], status: 'completed' };
}
function bundle(formal = false) {
  const fixtures = Array.from({ length: formal ? 60 : 4 }, (_, i) => {
    const packet = { taskId: `task-${i}`, goal: 'Choose a bounded next action', successCriteria: ['Use evidence'] };
    return { caseId: `case-${String(i).padStart(2, '0')}`, domain: domains[Math.floor(i / 20)],
      input: { packet, state: { taskId: packet.taskId, task: structuredClone(packet),
        gaps: [{ id: `gap-${i}`, question: 'Which source applies?' }], probes: [],
        lenses: [{ id: `lens-${i}`, label: 'Scope' }] } } };
  });
  const intent = fixtures.map(({ caseId }, i) => ({ caseId, authorIntentAction: formal ? actions[i % 5] : 'proceed',
    isControl: formal ? [0, 1, 3].includes(i % 5) : i === 1 }));
  const b = { fixtures: artefact('synthetic-fixtures.json', fixtures), authorIntent: artefact('synthetic-intent.json', intent),
    rubric: artefact('synthetic-rubric.txt', 'Choose the next action using only packet and state.', true),
    freeze: { status: 'frozen', fixturesHash: '', authorIntentHash: '', rubricHash: '' },
    authors: fixtures.map(({ caseId }) => ({ caseId, ...handle(`author-${caseId}`) })), runs: [] };
  b.freeze = { status: 'frozen', fixturesHash: b.fixtures.sha256, authorIntentHash: b.authorIntent.sha256, rubricHash: b.rubric.sha256 };
  b.runs = vendors.map((vendor, index) => ({ vendor, caseIds: fixtures.map(c => c.caseId),
    fixturesHash: b.fixtures.sha256, rubricHash: b.rubric.sha256,
    attempts: [{ ...handle(vendor), sourceOnly: true, repoExploration: false,
      prompt: artefact(`synthetic-${vendor}-prompt.json`, { rubric: b.rubric.bytes,
        cases: fixtures.map(({ caseId, input }) => ({ caseId, input })) }),
      output: artefact(`synthetic-${vendor}-output.json`, fixtures.map(({ caseId }, i) => ({ caseId,
        action: formal ? actions[i % 5] : i === 3 ? ['ask', 'check', 'ask'][index] : ['ask', 'check', 'proceed'][i],
        reasonPath: 'state.gaps[0].question' }))) }] }));
  return b;
}
const integrate = b => integrateAnnotations(b, { formal: false });
const output = (b, vendor = 0) => b.runs[vendor].attempts.at(-1).output;
function mutateOutput(b, fn, vendor = 0) {
  const file = output(b, vendor), rows = parse(file);
  fn(rows); replace(file, rows);
}
function rebind(b) {
  b.freeze.fixturesHash = b.fixtures.sha256;
  b.freeze.authorIntentHash = b.authorIntent.sha256;
  b.freeze.rubricHash = b.rubric.sha256;
  const fixtures = parse(b.fixtures);
  for (const run of b.runs) {
    run.fixturesHash = b.fixtures.sha256; run.rubricHash = b.rubric.sha256;
    for (const attempt of run.attempts) replace(attempt.prompt, { rubric: b.rubric.bytes,
      cases: fixtures.filter(c => run.caseIds.includes(c.caseId)).map(({ caseId, input }) => ({ caseId, input })) });
  }
}

test('unanimity alone supplies expected actions; 2:1 remains null and author intent stays separate', () => {
  const b = bundle(), before = structuredClone(b), result = integrate(b);
  assert.deepEqual(result.annotations, [
    { caseId: 'case-00', expectedAction: 'ask', consensusAction: 'ask', authorIntentAction: 'proceed', unanimous: true, authorIntentDiffers: true },
    { caseId: 'case-01', expectedAction: 'check', consensusAction: 'check', authorIntentAction: 'proceed', unanimous: true, authorIntentDiffers: true },
    { caseId: 'case-02', expectedAction: 'proceed', consensusAction: 'proceed', authorIntentAction: 'proceed', unanimous: true, authorIntentDiffers: false },
    { caseId: 'case-03', expectedAction: null, consensusAction: null, authorIntentAction: 'proceed', unanimous: false, authorIntentDiffers: false },
  ]);
  assert.equal(result.disagreements.length, 1);
  assert.deepEqual(result.disagreements[0].votes, { openai: 'ask', google: 'check', nvidia: 'ask' });
  for (const vendor of vendors) {
    assert.match(result.disagreements[0].reason, new RegExp(`${vendor}=.*state\\.gaps`));
    assert.deepEqual(Object.keys(result.rawLabels[vendor][0]).sort(), ['action', 'caseId', 'model', 'reasonPath', 'vendor']);
    assert.equal(result.rawLabels[vendor][0].model, b.runs[vendors.indexOf(vendor)].attempts[0].model);
  }
  assert.deepEqual(b, before);
  assert.equal(verifyIntegratedAnnotations(b, result, { formal: false }), true);
});

test('formal acceptance defaults to exactly sixty cases, complete labels and frozen provenance', () => {
  assert.throws(() => integrateAnnotations(bundle()), /60/);
  const b = bundle(true), result = integrateAnnotations(b);
  assert.equal(result.annotations.length, 60);
  assert.equal(result.provenance.acceptance, 'complete_valid_labels');
  assert.deepEqual(result.provenance.validLabelCounts, { openai: 60, google: 60, nvidia: 60 });
  assert.deepEqual(result.provenance.freeze, b.freeze);
  assert.equal(result.provenance.runs[0].attempts[0].output.sha256, output(b).sha256);
  assert.equal('bytes' in result.provenance.runs[0].attempts[0].output, false);
  assert.equal(result.provenance.authorIntent.sha256, b.authorIntent.sha256);
  for (const vendor of vendors) assert.equal(result.provenance.rawLabelHashes[vendor], digest(serialiseAnnotations(result.rawLabels[vendor])));
});

test('all differing cases are enumerated, including three-way disagreement', () => {
  const b = bundle();
  mutateOutput(b, rows => { rows[0].action = 'blocked'; }, 1);
  mutateOutput(b, rows => { rows[0].action = 'reframe'; }, 2);
  const result = integrate(b);
  assert.deepEqual(result.disagreements.map(r => r.caseId), ['case-00', 'case-03']);
  assert.deepEqual(result.disagreements[0].votes, { openai: 'ask', google: 'blocked', nvidia: 'reframe' });
  assert.equal(result.annotations[0].authorIntentDiffers, false);
});

test('the PM blind rubric annotations envelope is accepted without altering original JSON bytes', () => {
  const b = bundle(), expected = integrate(b);
  for (const run of b.runs) {
    const file = run.attempts[0].output;
    replace(file, { annotations: parse(file) });
  }
  const before = structuredClone(b), actual = integrate(b);
  assert.deepEqual(actual.rawLabels, expected.rawLabels);
  assert.deepEqual(actual.annotations, expected.annotations);
  assert.deepEqual(b, before);
  const bad = bundle(); replace(output(bad), { annotations: parse(output(bad)), expectedAction: 'ask' });
  assert.throws(() => integrate(bad));
});

test('shards may use different dispatch models and preserve per-case model identity', () => {
  const b = bundle(), original = b.runs.shift();
  const shards = [[0, 1], [2, 3]].map((indices, i) => {
    const run = structuredClone(original);
    run.caseIds = indices.map(j => original.caseIds[j]);
    Object.assign(run.attempts[0], handle(`openai-shard-${i}`));
    run.attempts[0].prompt = artefact(`synthetic-openai-shard-${i}-prompt.json`, {});
    run.attempts[0].output = artefact(`synthetic-openai-shard-${i}-output.json`, parse(original.attempts[0].output).filter(r => run.caseIds.includes(r.caseId)));
    return run;
  });
  b.runs.push(...shards); rebind(b);
  const result = integrate(b);
  assert.equal(result.rawLabels.openai[0].model, 'synthetic-model-openai-shard-0');
  assert.equal(result.rawLabels.openai[3].model, 'synthetic-model-openai-shard-1');
});

for (const [name, mutate, pattern] of [
  ['missing vendor', b => b.runs.pop(), /coverage|vendor/],
  ['unknown vendor', b => { b.runs[0].vendor = 'other'; }, /vendor/],
  ['missing result', b => { delete b.runs[0].attempts[0].output; }, /output/],
  ['duplicate shard', b => b.runs.push(structuredClone(b.runs[0])), /duplicate/i],
  ['duplicate case', b => mutateOutput(b, r => r.push(r[0])), /duplicate/i],
  ['missing case', b => mutateOutput(b, r => r.pop()), /coverage|missing/i],
  ['unknown case', b => mutateOutput(b, r => { r[0].caseId = 'unknown'; }), /unknown|coverage/i],
  ['unknown action', b => mutateOutput(b, r => { r[0].action = 'wait'; }), /action/],
  ['invalid_output is never a final valid label', b => mutateOutput(b, r => { r[0].action = 'invalid_output'; }), /action|invalid_output/],
  ['empty reason', b => mutateOutput(b, r => { r[0].reasonPath = '  '; }), /reasonPath/],
  ['invented reason entity', b => mutateOutput(b, r => { r[0].reasonPath = 'unseen-gap'; }), /reasonPath/],
  ['nonexistent reason path', b => mutateOutput(b, r => { r[0].reasonPath = 'state.gaps[50].kind'; }), /reasonPath/],
  ['generic reason root', b => mutateOutput(b, r => { r[0].reasonPath = 'state'; }), /reasonPath/],
  ['model self-reported metadata', b => mutateOutput(b, r => { r[0].vendor = 'openai'; r[0].model = 'invented'; }), /Unrecognized|Unrecognised|schema|keys/],
  ['raw schema extra', b => mutateOutput(b, r => { r[0].expectedAction = 'ask'; }), /Unrecognized|Unrecognised|schema|keys/],
  ['unfrozen inputs', b => { b.freeze.status = 'draft'; }, /frozen/],
  ['changed fixture bytes', b => { b.fixtures.bytes += ' '; }, /hash/i],
  ['changed author intent bytes', b => { b.authorIntent.bytes += ' '; }, /hash/i],
  ['changed rubric bytes', b => { b.rubric.bytes += ' '; }, /hash/i],
  ['different frozen input hash', b => { b.freeze.fixturesHash = 'a'.repeat(64); }, /hash/i],
  ['different shard input hash', b => { b.runs[0].fixturesHash = 'a'.repeat(64); }, /hash/i],
  ['changed prompt bytes', b => { b.runs[0].attempts[0].prompt.bytes += ' '; }, /hash/i],
  ['changed output bytes', b => { output(b).bytes += ' '; }, /hash/i],
  ['missing author', b => b.authors.pop(), /author.*coverage|missing.*author/i],
  ['duplicate author', b => b.authors.push(structuredClone(b.authors[0])), /duplicate/i],
  ['author as annotator', b => { b.authors[0].threadId = b.runs[0].attempts[0].threadId; }, /independen|author.*thread/i],
  ['same annotator thread across vendors', b => { b.runs[1].attempts[0].threadId = b.runs[0].attempts[0].threadId; }, /independen|thread/i],
  ['missing actual task handle', b => { b.runs[0].attempts[0].taskId = ''; }, /taskId/],
  ['unfinished dispatch', b => { b.runs[0].attempts[0].status = 'running'; }, /completed/],
  ['repository exploration', b => { b.runs[0].attempts[0].repoExploration = true; }, /repoExploration/],
  ['non-source-only run', b => { b.runs[0].attempts[0].sourceOnly = false; }, /sourceOnly/],
  ['excluded model', b => { b.runs[0].attempts[0].model = 'claude-excluded'; }, /excluded/i],
  ['excluded Grok model', b => { b.runs[0].attempts[0].model = 'grok-excluded'; }, /excluded/i],
]) test(`fail closed: ${name}`, () => {
  const b = bundle(); mutate(b); assert.throws(() => integrate(b), pattern);
});

test('input label leakage and fixture extras fail even when hashes and prompts are rebound', () => {
  for (const mutate of [
    r => { r[0].expectedAction = 'ask'; },
    r => { r[0].input.state.authorIntentAction = 'ask'; },
    r => { r[0].input.label = 'ask'; },
    r => { r[0].input.state.gaps[0].label = 'ask'; },
  ]) {
    const b = bundle(), rows = parse(b.fixtures); mutate(rows); replace(b.fixtures, rows); rebind(b);
    assert.throws(() => integrate(b), /label|keys|Unrecognized|Unrecognised/i);
  }
});

test('prompts are fixed input-only payloads, never intent, annotations, omitted cases or changed state', () => {
  for (const mutate of [
    p => { p.authorIntent = 'ask'; }, p => { p.cases.pop(); },
    p => { p.cases[0].input.state.task.goal = 'changed'; },
    p => { p.rubric = 'another rubric'; },
    p => { p.cases[0].domain = 'development'; },
  ]) {
    const b = bundle(), file = b.runs[0].attempts[0].prompt, prompt = parse(file);
    mutate(prompt); replace(file, prompt);
    assert.throws(() => integrate(b), /prompt|payload|rubric|keys|Unrecognized|Unrecognised/i);
  }
});

test('reason paths can identify actual entities, dotted paths, JSON pointers and input-prefixed paths', () => {
  const b = bundle();
  mutateOutput(b, rows => rows.forEach((r, i) => { r.reasonPath = ['gap-0', 'input.state.gaps[0].id', '/state/gaps/0/question', '$.state.probes'][i]; }));
  assert.equal(integrate(b).annotations.length, 4);
});

test('reason entities include actual executionId and state-relative structural paths', () => {
  const b = bundle(), cases = parse(b.fixtures);
  cases.forEach((c, i) => {
    c.input.state.appliedExecutions = [{ executionId: `execution-${i}`, outcome: 'unavailable' }];
    c.input.state.policyHistory = { consecutiveNoProgressRounds: 2 };
  });
  replace(b.fixtures, cases); rebind(b);
  mutateOutput(b, rows => rows.forEach((r, i) => { r.reasonPath = ['execution-0', 'policyHistory', 'policyHistory.consecutiveNoProgressRounds', 'gaps[0].question'][i]; }));
  assert.equal(integrate(b).annotations.length, 4);
  for (const reason of ['execution-unknown', 'unavailable', 'consecutiveNoProgressRounds', 'policyHistory.missing', 'gaps[99].question']) {
    mutateOutput(b, rows => { rows[0].reasonPath = reason; });
    assert.throws(() => integrate(b), /reasonPath/);
  }
});

test('original coordination and live audit artefacts are hash-bound provenance references', () => {
  const b = bundle();
  b.sourceEvidence = [artefact('synthetic-status.json', { summary: output(b).bytes }), artefact('synthetic-audit.json', { toolItems: [] })];
  const result = integrate(b);
  assert.deepEqual(result.provenance.sourceEvidence.map(r => r.sha256), b.sourceEvidence.map(r => r.sha256));
  assert(result.provenance.sourceEvidence.every(r => !Object.hasOwn(r, 'bytes')));
  assert.equal(verifyIntegratedAnnotations(b, result, { formal: false }), true);
  b.sourceEvidence[0].bytes += ' ';
  assert.throws(() => integrate(b), /hash/i);
});

test('one syntax-only retry retains both real artefact references and uses the retry labels', () => {
  const b = bundle(), run = b.runs[0], retry = structuredClone(run.attempts[0]);
  Object.assign(retry, handle('openai-retry'));
  retry.output = artefact('synthetic-openai-retry-output.json', parse(retry.output));
  replace(run.attempts[0].output, '{broken-json', true);
  run.attempts.push(retry);
  const result = integrate(b);
  assert.equal(result.provenance.runs[0].attempts.length, 2);
  assert.equal(result.provenance.runs[0].attempts[0].output.sha256, run.attempts[0].output.sha256);
  assert.equal(result.rawLabels.openai[0].model, retry.model);
});

test('missing/semantic-invalid/valid results are not syntax retries, and two retries are forbidden', () => {
  for (const kind of ['missing', 'empty', 'semantic', 'valid', 'two-retries', 'same-run']) {
    const b = bundle(), run = b.runs[0], retry = structuredClone(run.attempts[0]);
    Object.assign(retry, handle('retry'));
    if (kind === 'missing') delete run.attempts[0].output;
    if (kind === 'empty') replace(run.attempts[0].output, '', true);
    if (kind === 'semantic') mutateOutput(b, r => { r[0].action = 'other'; });
    if (kind === 'two-retries') run.attempts.push(structuredClone(retry));
    if (kind === 'same-run') { replace(run.attempts[0].output, '{broken', true); Object.assign(retry, handle('openai')); }
    run.attempts.push(retry);
    assert.throws(() => integrate(b), /retry|attempt|output|runId|syntax/i, kind);
  }
});

test('author intent joins require full unique IDs, valid actions, booleans and no extras', () => {
  for (const mutate of [r => r.pop(), r => r.push(r[0]), r => { r[0].caseId = 'unknown'; },
    r => { r[0].authorIntentAction = 'other'; }, r => { r[0].isControl = 'false'; }, r => { r[0].expectedAction = 'ask'; }]) {
    const b = bundle(), rows = parse(b.authorIntent); mutate(rows); replace(b.authorIntent, rows); rebind(b);
    assert.throws(() => integrate(b));
  }
});

test('formal domain/action/control distribution and input/task identity fail closed', () => {
  for (const target of ['domain', 'actions', 'controls', 'packet', 'taskId', 'duplicate', 'neutral-id']) {
    const b = bundle(true), cases = parse(b.fixtures), intent = parse(b.authorIntent);
    if (target === 'domain') cases[0].domain = 'research';
    if (target === 'actions') intent[0].authorIntentAction = 'ask';
    if (target === 'controls') intent.forEach(r => { r.isControl = false; });
    if (target === 'packet') cases[0].input.packet.goal = 'different';
    if (target === 'taskId') cases[0].input.state.taskId = 'different';
    if (target === 'duplicate') cases.push(cases[0]);
    if (target === 'neutral-id') cases[0].caseId = 'ask-01';
    replace(b.fixtures, cases); replace(b.authorIntent, intent); rebind(b);
    assert.throws(() => integrateAnnotations(b), undefined, target);
  }
});

test('derived consensus, disagreements and raw schemas cannot be forged during verification', () => {
  const b = bundle();
  for (const mutate of [
    r => { r.annotations[3].expectedAction = 'ask'; }, r => { r.annotations[0].authorIntentDiffers = false; },
    r => { r.annotations[0].extra = true; }, r => { r.disagreements = []; },
    r => { r.disagreements[0].votes.google = 'ask'; }, r => { r.disagreements[0].reason = 'invented correct answer'; },
    r => { r.rawLabels.openai[0].model = 'invented'; }, r => { r.provenance.acceptance = 'invented'; },
  ]) {
    const result = integrate(b); mutate(result);
    assert.throws(() => verifyIntegratedAnnotations(b, result, { formal: false }), /derived|mismatch/i);
  }
});

test('integration is deterministic under shard, label, author and fixture order permutations', () => {
  const b = bundle(), expected = integrate(b);
  b.runs.reverse(); b.authors.reverse();
  for (const run of b.runs) { const file = run.attempts[0].output; replace(file, parse(file).reverse()); }
  const actual = integrate(b);
  assert.equal(serialiseAnnotations(actual.annotations), serialiseAnnotations(expected.annotations));
  assert.equal(serialiseAnnotations(actual.disagreements), serialiseAnnotations(expected.disagreements));
  assert.equal(serialiseAnnotations(actual.rawLabels), serialiseAnnotations(expected.rawLabels));
  assert.equal(serialiseAnnotations(integrate(b)), serialiseAnnotations(actual));
});
