import { createHash } from 'node:crypto';
import { z } from 'zod';

const ACTIONS = ['proceed', 'check', 'ask', 'reframe', 'blocked'];
const VENDORS = ['openai', 'google', 'nvidia'];
const DOMAINS = ['development', 'automation', 'research'];
const text = z.string().min(1).refine(v => v.trim() === v && v.length > 0, 'Non-empty text without surrounding whitespace required');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const action = z.enum(ACTIONS);
const file = z.strictObject({
  path: text.refine(p => !p.includes('\\') && !p.includes(':') && !p.startsWith('/') && !p.split('/').some(s => s === '..' || s === '.' || !s), 'Relative artefact path required'),
  sha256: hash,
  bytes: z.custom(v => typeof v === 'string' || Buffer.isBuffer(v), 'Original artefact bytes required'),
});
const metadata = {
  taskId: text, runId: text, threadId: text, providerInstanceId: text, model: text,
  options: z.array(z.strictObject({ id: text, value: z.union([z.string(), z.boolean()]) })),
  status: z.literal('completed'),
};
const attemptSchema = z.strictObject({ ...metadata, sourceOnly: z.literal(true), repoExploration: z.literal(false), prompt: file, output: file });
const runSchema = z.strictObject({ vendor: z.enum(VENDORS), caseIds: z.array(text).min(1), fixturesHash: hash, rubricHash: hash,
  attempts: z.array(attemptSchema).min(1).max(2) });
const bundleSchema = z.strictObject({
  fixtures: file, authorIntent: file, rubric: file,
  freeze: z.strictObject({ status: z.literal('frozen'), fixturesHash: hash, authorIntentHash: hash, rubricHash: hash }),
  authors: z.array(z.strictObject({ caseId: text, ...metadata })), runs: z.array(runSchema),
  sourceEvidence: z.array(file).optional(),
});
const inputSchema = z.strictObject({ packet: z.record(z.string(), z.unknown()), state: z.record(z.string(), z.unknown()) });
const caseSchema = z.strictObject({ caseId: text.regex(/^[a-z0-9-]+$/), domain: z.enum(DOMAINS), input: inputSchema });
const intentSchema = z.strictObject({ caseId: text, authorIntentAction: action, isControl: z.boolean(), rationale: z.string().optional() });
const labelSchema = z.strictObject({ caseId: text, action, reasonPath: text });
const modelOutputSchema = z.union([z.array(labelSchema), z.strictObject({ annotations: z.array(labelSchema) })]);
const promptSchema = z.strictObject({ rubric: z.string(), cases: z.array(z.strictObject({ caseId: text, input: inputSchema })) });
const forbidden = new Set(['expectedAction', 'expectedDecision', 'authorIntent', 'authorIntentAction', 'groundTruth', 'targetAction', 'label', 'isControl']);
const byId = (a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
export const serialiseAnnotations = value => JSON.stringify(value, null, 2) + '\n';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const equal = (a, b) => canonical(a) === canonical(b);
const content = artefact => typeof artefact.bytes === 'string' ? artefact.bytes : artefact.bytes.toString('utf8');
function checkFile(artefact, label) {
  requireThat(sha256(artefact.bytes) === artefact.sha256, `${label} hash mismatch: ${artefact.path}`);
  return content(artefact);
}
function reference(artefact) {
  return { path: artefact.path, sha256: artefact.sha256, byteLength: Buffer.byteLength(artefact.bytes) };
}
function index(rows, label, ids) {
  const map = new Map();
  for (const row of rows) {
    requireThat(!map.has(row.caseId), `Duplicate ${label} caseId: ${row.caseId}`);
    requireThat(!ids || ids.has(row.caseId), `Unknown ${label} caseId: ${row.caseId}`);
    map.set(row.caseId, row);
  }
  if (ids) requireThat(map.size === ids.size, `Missing ${label} coverage`);
  return map;
}
function inputOnly(value, path = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const lensLabel = key === 'label' && path.length === 4 && path[0] === 'input' && path[1] === 'state' && path[2] === 'lenses' && /^\d+$/.test(path[3]);
    requireThat(lensLabel || !forbidden.has(key), `Forbidden label in fixture input: ${[...path, key].join('.')}`);
    inputOnly(item, [...path, key]);
  }
}
function checkModel(model) {
  requireThat(!/claude|grok/i.test(model), `Excluded model: ${model}`);
}
function entityIds(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return ids;
  if (typeof value.id === 'string') ids.add(value.id);
  if (typeof value.taskId === 'string') ids.add(value.taskId);
  if (typeof value.executionId === 'string') ids.add(value.executionId);
  for (const child of Object.values(value)) entityIds(child, ids);
  return ids;
}
function reasonExists(reason, input) {
  const ids = entityIds(input);
  if (Object.hasOwn(input.packet, 'goal')) ids.add('task:goal');
  if (Object.hasOwn(input.packet, 'mode')) ids.add('task:mode');
  for (let i = 0; i < (input.packet.successCriteria?.length ?? 0); i++) ids.add(`task:criterion:${i}`);
  if (ids.has(reason)) return true;
  let parts;
  if (reason.startsWith('/')) parts = reason.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  else {
    const path = reason.replace(/^\$\./, '').replace(/\[(\d+)\]/g, '.$1');
    if (!/^[a-zA-Z0-9_$-]+(?:\.[a-zA-Z0-9_$-]+)*$/.test(path)) return false;
    parts = path.split('.');
  }
  if (parts[0] === 'input') parts.shift();
  if (!['state', 'packet'].includes(parts[0]) && Object.hasOwn(input.state, parts[0])) parts.unshift('state');
  if (parts.length < 2 || !['state', 'packet'].includes(parts[0])) return false;
  let current = input;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return false;
    current = current[part];
  }
  return true;
}
function checkDistribution(cases, intent, formal) {
  requireThat(cases.size > 0, 'No fixture cases');
  for (const fixture of cases.values()) {
    inputOnly(fixture);
    requireThat(!/(ask|check|proceed|reframe|blocked)/i.test(fixture.caseId), `Answer-bearing caseId: ${fixture.caseId}`);
    requireThat(equal(fixture.input.packet, fixture.input.state.task), `Packet/state task mismatch: ${fixture.caseId}`);
    requireThat(typeof fixture.input.packet.taskId === 'string' && fixture.input.packet.taskId === fixture.input.state.taskId, `Task ID mismatch: ${fixture.caseId}`);
  }
  if (!formal) return;
  requireThat(cases.size === 60, 'Formal dataset must contain exactly 60 cases');
  for (const domain of DOMAINS) {
    const subset = [...cases.values()].filter(c => c.domain === domain);
    requireThat(subset.length === 20, `Expected 20 ${domain} cases`);
    for (const a of ACTIONS) requireThat(subset.filter(c => intent.get(c.caseId).authorIntentAction === a).length === 4, `Expected four authored ${a} cases in ${domain}`);
  }
  const controls = [...intent.values()].filter(c => c.isControl);
  requireThat(controls.length >= 9, 'At least nine unnecessary-ask controls required');
  requireThat(controls.every(c => ['check', 'proceed', 'reframe'].includes(c.authorIntentAction)), 'Controls must have authored check/proceed/reframe actions');
}

// Pure integration: the caller supplies original local bytes; no model calls or file writes occur.
export function integrateAnnotations(input, { formal = true } = {}) {
  const b = bundleSchema.parse(input);
  const fixtureText = checkFile(b.fixtures, 'Fixture'), intentText = checkFile(b.authorIntent, 'Author intent'), rubric = checkFile(b.rubric, 'Rubric');
  requireThat(b.freeze.fixturesHash === b.fixtures.sha256 && b.freeze.authorIntentHash === b.authorIntent.sha256 && b.freeze.rubricHash === b.rubric.sha256, 'Frozen input/rubric hash mismatch');
  const cases = index(z.array(caseSchema).parse(JSON.parse(fixtureText)), 'fixture');
  const ids = new Set(cases.keys());
  const intent = index(z.array(intentSchema).parse(JSON.parse(intentText)), 'author intent', ids);
  const authors = index(b.authors, 'author', ids);
  checkDistribution(cases, intent, formal);
  for (const author of authors.values()) checkModel(author.model);
  const raw = Object.fromEntries(VENDORS.map(v => [v, new Map()]));
  const threads = new Map([...ids].map(id => [id, new Map()]));
  const runIds = new Set(), artefacts = new Map();
  function registerFile(artefact, label) {
    const bytes = checkFile(artefact, label);
    const previous = artefacts.get(artefact.path);
    requireThat(previous === undefined || previous === artefact.sha256, `Conflicting artefact hashes for ${artefact.path}`);
    artefacts.set(artefact.path, artefact.sha256);
    return bytes;
  }
  for (const artefact of [b.fixtures, b.authorIntent, b.rubric]) registerFile(artefact, 'Frozen input');
  for (const artefact of b.sourceEvidence ?? []) registerFile(artefact, 'Source evidence');
  const provenanceRuns = [];
  for (const run of b.runs) {
    requireThat(run.fixturesHash === b.fixtures.sha256 && run.rubricHash === b.rubric.sha256, `Run fixture/rubric hash mismatch: ${run.vendor}`);
    const shard = new Set(run.caseIds);
    requireThat(shard.size === run.caseIds.length, `Duplicate shard caseId: ${run.vendor}`);
    for (const id of shard) {
      requireThat(ids.has(id), `Unknown shard caseId: ${id}`);
      requireThat(!raw[run.vendor].has(id), `Duplicate vendor shard coverage: ${run.vendor}/${id}`);
    }
    let labels;
    for (let i = 0; i < run.attempts.length; i++) {
      const attempt = run.attempts[i];
      checkModel(attempt.model);
      requireThat(!runIds.has(attempt.runId), `Duplicate actual runId or retry attempt: ${attempt.runId}`);
      runIds.add(attempt.runId);
      const prompt = promptSchema.parse(JSON.parse(registerFile(attempt.prompt, 'Prompt')));
      requireThat(prompt.rubric === rubric, 'Prompt rubric differs from frozen rubric');
      const promptCases = index(prompt.cases, 'prompt payload', shard);
      for (const id of shard) {
        requireThat(equal(promptCases.get(id).input, cases.get(id).input), `Prompt payload input differs: ${id}`);
        requireThat(attempt.threadId !== authors.get(id).threadId, `Author/annotator thread independence violated: ${id}`);
        const seen = threads.get(id);
        for (const [vendor, vendorThreads] of seen) requireThat(vendor === run.vendor || !vendorThreads.has(attempt.threadId), `Annotator thread independence violated: ${id}`);
        if (!seen.has(run.vendor)) seen.set(run.vendor, new Set());
        seen.get(run.vendor).add(attempt.threadId);
      }
      const output = registerFile(attempt.output, 'Output');
      requireThat(output.trim().length > 0, `Missing output is not a syntax retry: ${run.vendor}`);
      let parsed;
      try { parsed = JSON.parse(output); }
      catch (error) {
        requireThat(error instanceof SyntaxError && i === 0 && run.attempts.length === 2, `Invalid output syntax without one valid retry: ${run.vendor}`);
        continue;
      }
      requireThat(i === run.attempts.length - 1, `Syntax-only retry forbidden for a parseable output: ${run.vendor}`);
      const decoded = modelOutputSchema.parse(parsed);
      labels = index(Array.isArray(decoded) ? decoded : decoded.annotations, `${run.vendor} label`, shard);
      for (const row of labels.values()) requireThat(reasonExists(row.reasonPath, cases.get(row.caseId).input), `reasonPath does not identify an input path/entity: ${row.caseId}/${row.reasonPath}`);
    }
    requireThat(labels, `Missing valid output labels: ${run.vendor}`);
    const final = run.attempts.at(-1);
    for (const row of labels.values()) raw[run.vendor].set(row.caseId, { ...row, vendor: run.vendor, model: final.model });
    provenanceRuns.push({ ...run, caseIds: [...shard].sort(), attempts: run.attempts.map(a => ({ ...a, prompt: reference(a.prompt), output: reference(a.output) })) });
  }
  for (const vendor of VENDORS) requireThat(raw[vendor].size === ids.size, `Missing ${vendor} vendor coverage`);
  const annotations = [], disagreements = [];
  for (const caseId of [...ids].sort()) {
    const votes = Object.fromEntries(VENDORS.map(v => [v, raw[v].get(caseId).action]));
    const unanimous = new Set(Object.values(votes)).size === 1;
    const consensusAction = unanimous ? votes.openai : null;
    const authorIntentAction = intent.get(caseId).authorIntentAction;
    annotations.push({ caseId, expectedAction: consensusAction, consensusAction, authorIntentAction, unanimous,
      authorIntentDiffers: unanimous && consensusAction !== authorIntentAction });
    if (!unanimous) disagreements.push({ caseId, votes,
      reason: `Votes differ: ${VENDORS.map(v => `${v}=${votes[v]} (${raw[v].get(caseId).reasonPath})`).join('; ')}. No unanimous consensus.` });
  }
  const rawLabels = Object.fromEntries(VENDORS.map(v => [v, [...raw[v].values()].sort(byId)]));
  provenanceRuns.sort((a, b) => VENDORS.indexOf(a.vendor) - VENDORS.indexOf(b.vendor) || byId({ caseId: a.caseIds[0] }, { caseId: b.caseIds[0] }));
  const provenance = {
    schemaVersion: '1', acceptance: 'complete_valid_labels', formal,
    decisionSource: 'framework_only_local', jevApiCall: 'not made', cost: 'unknown',
    freeze: b.freeze, fixtures: reference(b.fixtures), authorIntent: reference(b.authorIntent), rubric: reference(b.rubric),
    ...(b.sourceEvidence ? { sourceEvidence: b.sourceEvidence.map(reference) } : {}),
    validLabelCounts: Object.fromEntries(VENDORS.map(v => [v, rawLabels[v].length])),
    authors: [...authors.values()].sort(byId), runs: provenanceRuns,
    rawLabelHashes: Object.fromEntries(VENDORS.map(v => [v, sha256(serialiseAnnotations(rawLabels[v]))])),
    annotationsHash: sha256(serialiseAnnotations(annotations)), disagreementsHash: sha256(serialiseAnnotations(disagreements)),
  };
  return { annotations, disagreements, rawLabels, provenance };
}

export function verifyIntegratedAnnotations(bundle, result, options) {
  const derived = integrateAnnotations(bundle, options);
  requireThat(equal(derived, result), 'Derived integration mismatch (consensus/schema/provenance)');
  return true;
}
