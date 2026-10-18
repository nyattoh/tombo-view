import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';

export const BASE_COMMIT = 'f2ecc2e4ccbfe109596d9e156095fff7af76ea6a';
const ROOT = resolve(import.meta.dirname, '..');
const VENDORS = ['openai', 'google', 'nvidia'];
const ACTIONS = ['proceed', 'check', 'ask', 'reframe', 'blocked'];
const DOMAINS = ['development', 'automation', 'research'];
const APPEND = Buffer.from('\nexport { result as evaluateBaselinePolicy };\n');
const wireChoices = Object.freeze({
  ready_for_requested_step: 'proceed', needs_check: 'check', needs_user_input: 'ask',
  needs_reflection: 'reframe', blocked: 'blocked',
});
const text = z.string().min(1);
const action = z.enum(ACTIONS);
const caseSchema = z.strictObject({
  caseId: text.regex(/^[a-z0-9-]+$/), domain: z.enum(DOMAINS),
  input: z.strictObject({ packet: z.record(z.string(), z.unknown()), state: z.record(z.string(), z.unknown()) }),
});
const intentSchema = z.strictObject({ caseId: text, authorIntentAction: action, isControl: z.boolean(), rationale: text.optional() });
const annotationSchema = z.strictObject({
  caseId: text, expectedAction: action.nullable(), consensusAction: action.nullable(),
  authorIntentAction: action, unanimous: z.boolean(), authorIntentDiffers: z.boolean(),
});
const rawSchema = z.strictObject({ caseId: text, action: z.enum([...ACTIONS, 'invalid_output']), reasonPath: text, vendor: z.enum(VENDORS), model: text });
const votesSchema = z.strictObject(Object.fromEntries(VENDORS.map(v => [v, z.enum([...ACTIONS, 'invalid_output'])])));
const disagreementSchema = z.strictObject({ caseId: text, votes: votesSchema, reason: text });
const forbiddenKeys = new Set(['expectedAction', 'expectedDecision', 'authorIntent', 'authorIntentAction', 'groundTruth', 'targetAction', 'label', 'isControl']);

function requireThat(condition, message) { if (!condition) throw new Error(message); }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const byId = (a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0;
export function normaliseDecision(wire) {
  requireThat(Object.hasOwn(wireChoices, wire), `Unknown policy wire decision: ${wire}`);
  return wireChoices[wire];
}
export function projectToOldSchema(input) {
  const copy = structuredClone(input);
  delete copy.policyHistory;
  delete copy.reflectionEffects;
  for (const gap of copy.gaps ?? []) delete gap.humanRole;
  return copy;
}
function git(root, args) { return execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }); }
async function preserveExact(path, expected) {
  let existing;
  try { existing = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) requireThat(existing.equals(expected), `Baseline snapshot byte mismatch: ${path}`);
  else await writeFile(path, expected);
}
async function emitLocal(root, directory, names, noCheck = true) {
  const config = {
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      types: ['node'], skipLibCheck: true, noCheck, strict: true, noUnusedLocals: true, noUnusedParameters: true,
      outDir: '.', rootDir: '.', declaration: false },
    files: names.map(name => `${name}.ts`),
  };
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(directory, 'tsconfig.json'), serialiseReport(config));
  const args = [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(directory, 'tsconfig.json'), '--noCheck', String(noCheck)];
  execFileSync(process.execPath, args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return { executable: 'node', args: args.map((arg, index) => index === 0 || index === 2 ? relative(root, arg).replaceAll('\\', '/') : arg), exitCode: 0 };
}

export async function prepareBaseline({ root = ROOT, directory = join(root, 'evaluation/ask-policy-baseline/f2ecc2e') } = {}) {
  await mkdir(join(directory, 'src'), { recursive: true });
  await mkdir(join(directory, '.generated'), { recursive: true });
  await preserveExact(join(directory, '.gitignore'), Buffer.from('.generated/\n'));
  const sources = {}, buffers = {};
  for (const name of ['core', 'types']) {
    const bytes = git(root, ['show', `${BASE_COMMIT}:src/${name}.ts`]);
    const blobId = git(root, ['rev-parse', `${BASE_COMMIT}:src/${name}.ts`]).toString('utf8').trim();
    const actualBlob = execFileSync('git', ['hash-object', '--stdin'], { cwd: root, input: bytes, encoding: 'utf8' }).trim();
    requireThat(actualBlob === blobId, `Git blob mismatch: ${name}`);
    await preserveExact(join(directory, 'src', `${name}.ts`), bytes);
    buffers[name] = bytes;
    sources[name] = { blobId, sha256: sha256(bytes), bytes: bytes.length };
  }
  const bridge = Buffer.concat([buffers.core, APPEND]);
  const generated = join(directory, '.generated');
  await writeFile(join(generated, 'core-bridge.ts'), bridge);
  await writeFile(join(generated, 'types.ts'), buffers.types);
  const compiler = await emitLocal(root, generated, ['core-bridge', 'types']);
  const bridgeJs = await readFile(join(generated, 'core-bridge.js'));
  const typesJs = await readFile(join(generated, 'types.js'));
  const module = await import(pathToFileURL(join(directory, '.generated/core-bridge.js')).href);
  requireThat(typeof module.evaluateBaselinePolicy === 'function' && typeof module.validateState === 'function', 'Baseline ESM exports missing');
  return {
    directory, module, sources,
    bridge: { sourceSha256: sha256(bridge), javascriptSha256: sha256(bridgeJs), typesJavascriptSha256: sha256(typesJs),
      typescriptVersion: ts.version, compiler, fileNameMode: '.ts + scope-local package.json type=module (NodeNext ESM)',
      target: 'ES2022', module: 'NodeNext', environmentAdaptation: 'TypeScript 7 root API has no transpileModule; existing local CLI emit authorised by PM. noCheck applies to this comparison emit only.' },
    evaluate: input => module.evaluateBaselinePolicy(module.validateState(projectToOldSchema(input)), []),
  };
}

function indexRows(rows, schema, label, ids) {
  const parsed = z.array(schema).parse(rows), indexed = new Map();
  for (const row of parsed) {
    requireThat(!indexed.has(row.caseId), `Duplicate ${label} caseId: ${row.caseId}`);
    requireThat(!ids || ids.has(row.caseId), `Unknown ${label} caseId: ${row.caseId}`);
    indexed.set(row.caseId, row);
  }
  if (ids) requireThat(indexed.size === ids.size, `Missing ${label} coverage`);
  return indexed;
}
function checkInputOnly(value, path = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const lensLabel = key === 'label' && path.length === 4 && path[0] === 'input' && path[1] === 'state' && path[2] === 'lenses' && /^\d+$/.test(path[3]);
    requireThat(lensLabel || !forbiddenKeys.has(key), `Forbidden label in input fixture: ${key}`);
    checkInputOnly(item, [...path, key]);
  }
}
export function validateDataset(data, { formal = true } = {}) {
  const cases = indexRows(data.cases, caseSchema, 'fixture');
  requireThat(cases.size > 0, 'No cases');
  const ids = new Set(cases.keys());
  const intent = indexRows(data.intent, intentSchema, 'author intent', ids);
  const annotations = indexRows(data.annotations, annotationSchema, 'annotation', ids);
  requireThat(data.rawLabels && canonical(Object.keys(data.rawLabels).sort()) === canonical([...VENDORS].sort()), 'Exactly three distinct vendors openai/google/nvidia required');
  const raw = Object.fromEntries(VENDORS.map(v => [v, indexRows(data.rawLabels[v], rawSchema, `${v} raw label`, ids)]));
  for (const vendor of VENDORS) for (const row of raw[vendor].values()) requireThat(row.vendor === vendor, `Vendor identity mismatch: ${vendor}`);
  const disagreements = indexRows(data.disagreements, disagreementSchema, 'disagreement');
  for (const id of disagreements.keys()) requireThat(ids.has(id), `Unknown disagreement caseId: ${id}`);
  const consensus = new Map();
  for (const [id, fixture] of cases) {
    checkInputOnly(fixture);
    requireThat(!/(ask|check|proceed|reframe|blocked)/i.test(id), `Answer-bearing caseId: ${id}`);
    requireThat(canonical(fixture.input.packet) === canonical(fixture.input.state.task), `Packet/state task mismatch: ${id}`);
    requireThat(fixture.input.packet.taskId === fixture.input.state.taskId, `Task ID mismatch: ${id}`);
    const votes = Object.fromEntries(VENDORS.map(v => [v, raw[v].get(id).action]));
    const unanimous = new Set(Object.values(votes)).size === 1 && ACTIONS.includes(votes.openai);
    const agreed = unanimous ? votes.openai : null;
    const annotation = annotations.get(id), author = intent.get(id);
    requireThat(annotation.expectedAction === agreed && annotation.consensusAction === agreed && annotation.unanimous === unanimous, `Annotation does not match 3/3 raw consensus: ${id}`);
    requireThat(annotation.authorIntentAction === author.authorIntentAction && annotation.authorIntentDiffers === (unanimous && agreed !== author.authorIntentAction), `Author intent mismatch: ${id}`);
    if (unanimous) requireThat(!disagreements.has(id), `Consensus case listed as disagreement: ${id}`);
    else requireThat(disagreements.has(id) && canonical(disagreements.get(id).votes) === canonical(votes), `Missing or inconsistent disagreement: ${id}`);
    consensus.set(id, agreed);
  }
  if (formal) {
    requireThat(cases.size === 60, 'Formal dataset must contain exactly 60 cases');
    for (const domain of DOMAINS) {
      const domainCases = [...cases.values()].filter(c => c.domain === domain);
      requireThat(domainCases.length === 20, `Expected 20 ${domain} cases`);
      for (const a of ACTIONS) requireThat(domainCases.filter(c => intent.get(c.caseId).authorIntentAction === a).length === 4, `Expected four authored ${a} cases in ${domain}`);
    }
    const controls = [...intent.values()].filter(x => x.isControl);
    requireThat(controls.length >= 9, 'At least nine unnecessary-ask controls required');
    requireThat(controls.every(x => ['check', 'proceed', 'reframe'].includes(x.authorIntentAction)), 'Control author actions must be check/proceed/reframe');
  }
  return { cases, intent, annotations, raw, disagreements, consensus };
}

function metrics(rows, prefix) {
  const population = rows.filter(r => r.unanimous);
  const tp = population.filter(r => r.consensusAction === 'ask' && r[`${prefix}PolicyChoice`] === 'ask').length;
  const fpRows = population.filter(r => r.consensusAction !== 'ask' && r[`${prefix}PolicyChoice`] === 'ask');
  const fn = population.filter(r => r.consensusAction === 'ask' && r[`${prefix}PolicyChoice`] !== 'ask').length;
  const fp = fpRows.length;
  return { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null,
    unnecessaryAsks: fp, controlViolations: fpRows.filter(r => r.isControl).length, missedAsks: fn };
}
export function compareDataset(data, evaluators, options) {
  const validated = validateDataset(data, options);
  for (const name of ['oldEvaluate', 'newEvaluate', 'oldValidate', 'newValidate']) requireThat(typeof evaluators[name] === 'function', `Missing ${name}`);
  const cases = [...validated.cases.values()].sort(byId).map(fixture => {
    const id = fixture.caseId, author = validated.intent.get(id), agreed = validated.consensus.get(id);
    // Validation and each evaluator receive independent clones, including nested task fields.
    evaluators.oldValidate(projectToOldSchema(fixture.input.state));
    evaluators.newValidate(structuredClone(fixture.input.state));
    const oldResult = evaluators.oldEvaluate(projectToOldSchema(fixture.input.state));
    const newResult = evaluators.newEvaluate(structuredClone(fixture.input.state));
    const oldWireDecision = oldResult.state.decision, newWireDecision = newResult.state.decision;
    return { caseId: id, domain: fixture.domain, oldWireDecision, oldPolicyChoice: normaliseDecision(oldWireDecision),
      newWireDecision, newPolicyChoice: normaliseDecision(newWireDecision), consensusAction: agreed,
      expectedAction: agreed, authorIntentAction: author.authorIntentAction, unanimous: agreed !== null,
      authorIntentDiffers: agreed !== null && agreed !== author.authorIntentAction, isControl: author.isControl };
  });
  return {
    totalCases: cases.length, consensusCount: cases.filter(r => r.unanimous).length,
    disagreementCount: cases.filter(r => !r.unanimous).length,
    metricDefinitions: {
      population: 'Only 3/3 unanimous openai/google/nvidia cases; author intent is never an expected label.',
      tp: 'Consensus ask and predicted ask.', fp: 'Consensus non-ask and predicted ask.', fn: 'Consensus ask and predicted non-ask.',
      precision: 'tp / (tp + fp); null when denominator is zero.', recall: 'tp / (tp + fn); null when denominator is zero.',
      unnecessaryAsks: 'fp over all consensus cases.', missedAsks: 'fn over all consensus cases.',
      controlViolations: 'Subset of fp in consensus cases whose separate author-intent isControl is true.',
      nonClaims: 'Deterministic state-to-action comparison only; provisional model labels, no live behavioural efficacy or subjective interest measurement.',
    },
    metrics: { old: metrics(cases, 'old'), new: metrics(cases, 'new') }, cases,
    changedCases: cases.filter(r => r.oldPolicyChoice !== r.newPolicyChoice),
    disagreements: [...validated.disagreements.values()].sort(byId), nonConsensusCases: cases.filter(r => !r.unanimous),
  };
}
export function serialiseReport(report) { return JSON.stringify(report, null, 2) + '\n'; }

export async function runComparison({ root = ROOT } = {}) {
  const paths = {
    cases: 'evaluation/ask-policy-cases.json', intent: 'evaluation/ask-policy-author-intent.json',
    annotations: 'evaluation/ask-policy-annotations.json', disagreements: 'evaluation/ask-policy-disagreements.json',
    ...Object.fromEntries(VENDORS.map(v => [v, `evaluation/ask-policy-blind/vendor-${v}.json`])),
  };
  const buffers = {}, values = {};
  for (const [key, path] of Object.entries(paths)) {
    buffers[key] = await readFile(join(root, path)); values[key] = JSON.parse(buffers[key].toString('utf8'));
  }
  const data = { cases: values.cases, intent: values.intent, annotations: values.annotations, disagreements: values.disagreements,
    rawLabels: Object.fromEntries(VENDORS.map(v => [v, values[v]])) };
  validateDataset(data);
  const baseline = await prepareBaseline({ root });
  const currentFiles = {};
  for (const path of ['src/core.ts', 'src/types.ts', 'dist/core.js', 'dist/types.js']) currentFiles[path] = await readFile(join(root, path));
  const consistencyDirectory = join(baseline.directory, '.generated/current-consistency');
  await mkdir(consistencyDirectory, { recursive: true });
  for (const name of ['core', 'types']) await writeFile(join(consistencyDirectory, `${name}.ts`), currentFiles[`src/${name}.ts`]);
  const newEmitConsistency = await emitLocal(root, consistencyDirectory, ['core', 'types'], false);
  for (const name of ['core', 'types']) requireThat((await readFile(join(consistencyDirectory, `${name}.js`))).equals(currentFiles[`dist/${name}.js`]), `Stale dist/${name}.js: core writer must build first`);
  const current = await import(pathToFileURL(join(root, 'dist/core.js')).href);
  requireThat(typeof current.evaluatePolicy === 'function', 'Production dist/core.js evaluatePolicy export missing');
  const report = compareDataset(data, {
    oldValidate: baseline.module.validateState, oldEvaluate: baseline.evaluate,
    newValidate: current.validateState, newEvaluate: current.evaluatePolicy,
  });
  Object.assign(report, {
    casesHash: sha256(buffers.cases), authorIntentHash: sha256(buffers.intent), annotationsHash: sha256(buffers.annotations),
    disagreementsHash: sha256(buffers.disagreements), blindHashes: Object.fromEntries(VENDORS.map(v => [v, sha256(buffers[v])])),
    baselineCommit: BASE_COMMIT, baselineBlobSha: sha256(canonical(baseline.sources)), baselineSources: baseline.sources,
    baselineBridgeSha: baseline.bridge.sourceSha256, baselineBridge: baseline.bridge,
    newEmitConsistency,
    newVersionSha: sha256(Buffer.concat(Object.values(currentFiles))),
    newFiles: Object.fromEntries(Object.entries(currentFiles).map(([path, bytes]) => [path, { sha256: sha256(bytes), bytes: bytes.length }])),
    inputFiles: paths,
  });
  const bytes = serialiseReport(report), output = join(root, 'evaluation/reports/ask-policy-compare.json');
  for (const [key, path] of Object.entries(paths)) requireThat((await readFile(join(root, path))).equals(buffers[key]), `Input changed during comparison: ${path}`);
  for (const [path, buffer] of Object.entries(currentFiles)) requireThat((await readFile(join(root, path))).equals(buffer), `Core changed during comparison: ${path}`);
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, bytes);
  return { output: relative(root, output).replaceAll('\\', '/'), sha256: sha256(bytes), totalCases: report.totalCases, consensusCount: report.consensusCount };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    requireThat(process.argv.length === 2, 'Usage: node scripts/ask-policy-compare.mjs');
    console.log(JSON.stringify(await runComparison()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
