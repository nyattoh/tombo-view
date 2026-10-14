import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { createTombo, hashPassage, TomboError, proposalSchema, reflectionOutputSchema, runUnderstandingCheck, proposalGuidance, reflectionGuidance } from '../dist/index.js';
import { RunSchema, participantPacket, executeTool, outputDigest } from '../evaluation/metacognition-runner.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const caseId = option('case'), arm = option('arm'), repeat = Number(option('repeat', '1'));
const origin = option('origin', 'real-model');
const out = resolve(option('out', 'results/metacognition-development/host-trial'));
if (!caseId || !['baseline', 'tombo'].includes(arm) || !Number.isInteger(repeat) || repeat < 1 || !['fixture', 'real-model'].includes(origin)) throw new Error('Use --case ID --arm baseline|tombo --repeat N --out DIRECTORY [--origin fixture].');
const casesPath = option('cases', new URL('../evaluation/metacognition-cases.json', import.meta.url));
const protocolPath = option('protocol', new URL('../evaluation/metacognition-protocol.json', import.meta.url));
const cases = JSON.parse(await readFile(casesPath, 'utf8'));
const protocol = JSON.parse(await readFile(protocolPath, 'utf8'));
const model = RunSchema.shape.model.parse(protocol.participantModel === undefined ? { provider: 'codex', name: 'gpt-6.1-sol', effort: 'medium' } : protocol.participantModel);
const repairs = Number(option('model-repair-attempts', protocol.modelValidationRepairs?.[arm === 'baseline' ? 'baselineSyntax' : 'tomboProposal'] ?? 0));
if (!Number.isInteger(repairs) || repairs < 0 || repairs > 2) throw new Error('Repair attempts must be 0, 1 or 2.');
const elapsedCap = protocol.maximumElapsedMs ?? 300000;
if (!Number.isSafeInteger(elapsedCap) || elapsedCap <= 0) throw new Error('Invalid elapsed cap.');
const digest = value => outputDigest(JSON.stringify(value));
if (digest(cases) !== protocol.caseDigest || !protocol.frozenBeforeResults) throw new Error('Frozen dataset mismatch');
const selected = cases.find(c => c.id === caseId);
if (!selected) throw new Error('Unknown case');
const staticPolicySchema = z.object({
  version: z.literal(1),
  mode: z.literal('immutable_case_records'),
  records: z.array(z.object({ caseId: z.string().min(1), sourceId: z.string().min(1), recordDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1),
}).strict();
let staticSnapshotPolicy;
const snapshots = new Map();
if (protocol.staticSnapshotPolicy !== undefined) {
  if (protocol.version !== 2 || protocol.frozenBeforeResults !== true) throw new Error('Static snapshot policy requires a new frozen version 2 protocol.');
  staticSnapshotPolicy = staticPolicySchema.parse(protocol.staticSnapshotPolicy);
  const declared = new Set();
  for (const entry of staticSnapshotPolicy.records) {
    const key = JSON.stringify([entry.caseId, entry.sourceId]);
    const recordCases = cases.filter(c => c.id === entry.caseId);
    const recordCase = recordCases[0];
    const records = recordCase?.sources.filter(s => s.id === entry.sourceId) ?? [];
    if (declared.has(key) || recordCases.length !== 1 || records.length !== 1 || records[0].capability !== 'read_record' || !recordCase.capabilities.includes('read_record') || !['ok', 'incomplete', 'conflict'].includes(records[0].status) || typeof records[0].text !== 'string' || !records[0].text.trim() || digest(records[0]) !== entry.recordDigest) throw new Error('Invalid immutable case record binding.');
    declared.add(key);
    Object.freeze(records[0]);
    snapshots.set(key, `case-record:${digest([protocol.caseDigest, entry.caseId, entry.sourceId, entry.recordDigest])}`);
  }
}
const packet = participantPacket(selected);
const requested = { capabilities: packet.capabilities, ...protocol.requested, modelRepairAttempts: repairs, maximumElapsedMs: elapsedCap };
const tracePath = join(out, 'trace.json'), runPath = join(out, 'run.json'), resultPath = join(out, 'result.json');
const trace = { version: 1, origin, model, caseId, arm, repeat, packetDigest: digest(packet), datasetDigest: protocol.caseDigest, protocolDigest: digest(protocol), events: [], notes: ['Host task IDs attest delegated generations. Upstream API calls, billing, tokens and hidden retries are unknown.', 'SDK local apply metadata outputTokens=0 is an accounting placeholder. Actual output character caps are enforced at the bridge.', 'Synthetic source checks execute locally through executeTool. No paid API is called by this driver.'] };
await mkdir(out, { recursive: true });
trace.methodConfiguration = { modelValidationRepairs: repairs, maximumElapsedMs: elapsedCap, casesPath: String(casesPath), protocolPath: String(protocolPath), ...(staticSnapshotPolicy ? { staticSnapshotPolicy } : {}) };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const log = async event => { trace.events.push({ at: new Date().toISOString(), ...event }); await save(tracePath, trace); };
const input = createInterface({ input: process.stdin, terminal: false });
const lines = input[Symbol.asyncIterator]();
process.once('SIGINT', () => { bridgeFailure ??= 'host_cancelled'; input.close(); });
const started = Date.now();
const deadlineAt = started + elapsedCap;
let modelCalls = 0, calls = 0, sequence = 0, bridgeFailure = null;
const checks = [], transcript = [];
const localUsage = { totalTokens: null, costYen: null, outputTokens: 0 };
const fail = (reason, code = 'invalid_model_output') => { bridgeFailure ??= reason; return new TomboError(code, reason); };
const reserve = () => { if (calls >= requested.maxCalls) throw fail('call_cap', 'budget_exhausted'); if (Date.now() - started >= elapsedCap) throw fail('trial_timeout', 'model_timeout'); calls++; };
const rejectModel = async (stage, reason, message = reason) => {
  const boundedMessage = message.slice(0, 512);
  await log({ kind: 'model_rejection', sequence, stage, reason, message: boundedMessage });
  return new TomboError('invalid_model_output', boundedMessage);
};
const schema = value => z.toJSONSchema(value, { unrepresentable: 'any' });
const proposalContract = schema(proposalSchema), reflectionContract = schema(reflectionOutputSchema);
const commonPrompt = 'Do not call tools, read files, browse, or delegate. Return one JSON object only, no Markdown or reasoning transcript. Use only the supplied packet and actual returned sources. Recheck your answer where needed. Each response must be at most 4000 characters. Final answers must state decision, answer, uncertainties and sourceRefs. Do not fabricate evidence. There is a shared maximum of 6 generation requests plus source checks.';
const finalSchema = z.object({ decision: z.enum(['supported', 'refuted', 'unknown']), answer: z.string(), uncertainties: z.array(z.string()), sourceRefs: z.array(z.string()) }).strict();
const baselineSchema = z.union([z.object({ action: z.literal('read'), sourceId: z.string() }).strict(), finalSchema.extend({ action: z.literal('finish') }).strict()]);

async function ask(stage, sdkInput) {
  reserve(); modelCalls++; sequence++;
  const instructions = stage === 'baseline' ? commonPrompt + ' Choose {"action":"read","sourceId":"declared source ID"} to retrieve a record, or {"action":"finish","decision":"supported|refuted|unknown","answer":"text","uncertainties":[],"sourceRefs":[]}. You may review again after each response.' : commonPrompt + (stage === 'reflect' ? ' Return ReflectionOutput matching the schema. Echo the exact input.binding. Review all current claims when completion is completed. Propose candidate lenses, gaps and probes only. Use inconclusive with limitations if review is incomplete. Usage may be omitted and is ignored.' : ' Return the Proposal object itself, without a proposal envelope or usage. Claim role must be observation, assumption, hypothesis or answer_claim; scope is trial. Lenses carry origin initial or proposed and status candidate, active or retired. Gaps triggerRefs must reference actual claim/evidence IDs (initial evidence e-context) or task conditions. Gap/probe references must be reciprocal. A record probe requires read_record and sourceGroups containing exactly one declared tool ID. Record tool IDs identify sources, while evidence IDs identify individual observations. Copy evidence IDs from input.observations or input.state.evidence for assessments and resolutions, with scopeMatched. Do not invent IDs or calculate hashes. New supported answer_claim text can supply a corrected final answer. Do not change claims by assuming the desired verdict.');
  const request = { sequence, stage, instructions: instructions + (stage === 'baseline' ? '' : `\n${stage === 'reflect' ? reflectionGuidance : proposalGuidance}`), packet, transcript: structuredClone(transcript), remainingCalls: requested.maxCalls - calls, input: sdkInput ?? null, responseSchema: stage === 'baseline' ? schema(baselineSchema) : stage === 'reflect' ? reflectionContract : proposalContract };
  if (JSON.stringify(request).length > 48000) throw fail('input_too_large', 'input_too_large');
  const path = join(out, `request-${sequence}.json`);
  const bridgePath = join(out, `bridge-${sequence}.json`);
  await save(path, request);
  await save(bridgePath, { version: 1, sequence, stage, startedAt: started, deadlineAt, model });
  await log({ kind: 'request', sequence, stage, path, request });
  process.stdout.write(`REQUEST ${JSON.stringify({ sequence, stage, path, bridgePath, deadlineAt })}\n`);
  let timer;
  try {
    const line = await Promise.race([lines.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('trial_timeout', 'model_timeout')), Math.max(1, elapsedCap - (Date.now() - started))); })]);
    if (Date.now() >= deadlineAt) throw fail('trial_timeout', 'model_timeout');
    if (line.done) throw fail('host_input_closed', 'invalid_input');
    await log({ kind: 'raw_reply', sequence, line: line.value });
    let reply;
    try { reply = JSON.parse(line.value); } catch { throw fail('invalid_host_json', 'invalid_input'); }
    await log({ ...reply, kind: 'reply' });
    if (!reply || typeof reply !== 'object') throw fail('invalid_host_binding', 'invalid_input');
    const metadata = RunSchema.shape.model.safeParse(reply.model);
    if (reply.error !== undefined) {
      const validError = reply.error && typeof reply.error === 'object' && reply.error.code === 'model_error' && typeof reply.error.message === 'string' && reply.error.message.length > 0 && reply.error.message.length <= 512;
      const validTask = reply.taskId === null || (typeof reply.taskId === 'string' && reply.taskId.trim() && !(origin === 'real-model' && reply.taskId.startsWith('fixture')));
      if (reply.sequence !== sequence || !metadata.success || digest(metadata.data) !== digest(model) || !validError || !validTask || reply.output !== undefined) throw fail('invalid_host_binding', 'invalid_input');
      await log({ kind: 'dispatch_failure', sequence, stage, taskId: reply.taskId, code: reply.error.code, message: reply.error.message });
      throw fail(reply.error.code, reply.error.code);
    }
    if (reply.sequence !== sequence || typeof reply.output !== 'string' || typeof reply.taskId !== 'string' || !reply.taskId.trim() || !metadata.success || digest(metadata.data) !== digest(model)) throw fail('invalid_host_binding', 'invalid_input');
    if (origin === 'real-model' && reply.taskId.startsWith('fixture')) throw fail('fixture_task_for_real_trial', 'invalid_input');
    if (reply.output.length > requested.maxOutputChars) throw await rejectModel(stage, 'response_character_cap', 'Response exceeds the 4000 character cap; return a shorter response.');
    transcript.push({ kind: 'model', stage, output: reply.output });
    try { return JSON.parse(reply.output); } catch { throw await rejectModel(stage, 'invalid_response_json', 'Return a valid JSON object without Markdown.'); }
  } finally { clearTimeout(timer); }
}

async function readSource(capability, sourceId, executionId) {
  const tool = packet.tools.find(t => t.id === sourceId && t.capability === capability);
  if (!tool) throw fail('undeclared_source', 'invalid_input');
  reserve();
  const response = executeTool(selected, capability, sourceId);
  checks.push({ capability, sourceId, status: response.status, responseDigest: digest(response) });
  transcript.push({ kind: 'source', response });
  const staticSnapshot = snapshots.get(JSON.stringify([caseId, sourceId]));
  await log({ kind: 'tool', executionId, capability, sourceId, response, responseDigest: digest(response), ...(staticSnapshot ? { staticSnapshot } : {}) });
  return response;
}

function renderUnderstanding(result) {
  const state = result?.state;
  if (!state) return { decision: 'unknown', answer: 'Understanding check did not produce a state.', uncertainties: [bridgeFailure ?? 'No state'], sourceRefs: [] };
  const claims = state.claims.filter(c => c.role === 'answer_claim');
  const refuted = claims.filter(c => c.status === 'contradicted');
  const supported = claims.filter(c => c.status === 'supported');
  const unresolved = state.gaps.filter(g => g.importance === 'required' && g.status !== 'resolved');
  const ready = state.decision === 'ready_for_requested_step' && !unresolved.length && claims.length > 0 && claims.every(c => ['supported', 'contradicted'].includes(c.status));
  const reasons = refuted.flatMap(c => c.assessments.filter(a => a.verdict === 'refutes').map(a => a.reason));
  const unknownReasons = claims.filter(c => !['supported', 'contradicted'].includes(c.status)).flatMap(c => {
    const assessment = c.assessments.at(-1);
    return assessment?.verdict === 'inconclusive' && assessment.scopeMatched && assessment.evidenceIds.every(id => state.evidence.some(e => e.id === id && e.validity === 'current' && e.scope === c.scope && !e.passageUnavailable)) ? [assessment.reason] : [];
  });
  const answer = [...refuted.map(c => `Rejected claim: ${c.text}`), ...reasons, ...supported.map(c => c.text), ...unknownReasons].join(' ') || (state.task.proposedAnswer ? `The original draft remains unverified: ${state.task.proposedAnswer}` : 'No grounded final answer.');
  const uncertainties = [...unresolved.map(g => g.question), ...claims.filter(c => !['supported', 'contradicted'].includes(c.status)).map(c => `Unverified: ${c.text}`), ...(state.reflection?.limitations ?? []), ...(state.stopReason ? [state.stopReason] : [])];
  if (!ready && !uncertainties.length) uncertainties.push('The understanding check is incomplete.');
  const evidenceIds = claims.flatMap(c => c.assessments.flatMap(a => a.evidenceIds));
  const sourceRefs = [...new Set(state.evidence.filter(e => evidenceIds.includes(e.id) && e.id !== 'e-context').map(e => e.sourceGroup))];
  return { decision: ready ? (refuted.length ? 'refuted' : 'supported') : 'unknown', answer, uncertainties, sourceRefs };
}

let status = 'success', result = null, final = { decision: 'unknown', answer: 'No final answer was produced.', uncertainties: [], sourceRefs: [] };
try {
  if (arm === 'baseline') {
    let feedback;
    let rejected = 0;
    while (true) {
      let response;
      try {
        const raw = await ask('baseline', feedback ? { validationFeedback: feedback } : undefined);
        const parsed = baselineSchema.safeParse(raw);
        if (!parsed.success) throw await rejectModel('baseline', 'invalid_baseline_response', parsed.error.issues.map(issue => issue.message).join('; '));
        response = parsed.data;
        const refs = response.action === 'read' ? [response.sourceId] : response.sourceRefs;
        if (refs.some(id => !packet.tools.some(t => t.id === id))) throw await rejectModel('baseline', 'unknown_source', 'Use only declared source IDs.');
        if (response.action === 'finish' && refs.some(id => !checks.some(c => c.sourceId === id))) throw await rejectModel('baseline', 'unread_source', 'Do not cite a source that has not been retrieved.');
      } catch (error) {
        if (!(error instanceof TomboError) || error.code !== 'invalid_model_output' || rejected >= repairs) throw error;
        rejected++;
        feedback = { code: error.code, message: error.message, rejectedAttempt: rejected, maxAttempts: repairs + 1 };
        continue;
      }
      feedback = undefined; rejected = 0;
      if (response.action === 'finish') {
        const { action, ...answer } = response;
        if (answer.sourceRefs.some(id => !packet.tools.some(t => t.id === id))) throw fail('unknown_final_source');
        final = answer; result = answer; break;
      }
      const tool = packet.tools.find(t => t.id === response.sourceId);
      await readSource(tool?.capability, response.sourceId);
    }
  } else {
    const task = { schemaVersion: '0.1', taskId: `trial-${caseId}-${repeat}`, goal: packet.task, proposedAnswer: packet.draft, mode: 'explain', successCriteria: ['Give a source-grounded final answer with any remaining uncertainty.'], evidence: [{ id: 'e-context', kind: 'document', locator: 'participant-context', sourceGroup: 'context', retrievedAt: new Date().toISOString(), version: null, scope: 'trial', passage: packet.context, contentHash: hashPassage(packet.context), validity: 'current' }], capabilities: packet.capabilities, budget: { maxRounds: 2, maxModelCalls: 6, maxToolCalls: 6, maxElapsedMs: 300000, maxInputChars: 48000, maxOutputTokensPerCall: 4000 } };
    task.budget.maxElapsedMs = elapsedCap;
    const tombo = createTombo({ maxModelRepairAttempts: repairs, adapter: { async generate(input) { const proposal = await ask(input.operation, input); return { proposal, usage: localUsage }; } } });
    const critic = { async reflect(input) { const response = await ask('reflect', input); return { ...response, usage: localUsage }; } };
    const executor = { async execute(input) {
      const before = Date.now();
      if (input.probe.sourceGroups.length !== 1) throw fail('invalid_source_group', 'invalid_input');
      const response = await readSource(input.probe.requiredCapability, input.probe.sourceGroups[0], input.executionId);
      const staticSnapshot = snapshots.get(JSON.stringify([caseId, response.id]));
      return { executionId: input.executionId, probeId: input.probe.id, outcome: response.status === 'unavailable' ? 'unavailable' : 'completed', evidence: response.status === 'unavailable' ? [] : [{ id: `${response.id}:${input.executionId}`, kind: 'document', locator: response.id, sourceGroup: response.id, retrievedAt: new Date().toISOString(), version: null, scope: 'trial', passage: response.text, contentHash: hashPassage(response.text), validity: 'current' }], toolCalls: 1, elapsedMs: Date.now() - before, costYen: null, ...(staticSnapshot ? { staticSnapshot } : {}) };
    } };
    result = await runUnderstandingCheck({ tombo, task, critic, executor, maxCycles: 12 });
    await log({ kind: 'sdk_result', result });
    final = renderUnderstanding(result.result);
    const reason = result.result?.state.stopReason ?? result.reason;
    if (bridgeFailure || (result.status === 'stopped' && !['capability_limit', 'reflection_inconclusive', 'no_progress', 'needs_user_input'].includes(reason))) status = 'error';
  }
  finalSchema.parse(final);
  if (JSON.stringify(final).length > requested.maxOutputChars) throw fail('final_character_cap');
} catch (error) {
  status = ['host_input_closed', 'host_cancelled'].includes(bridgeFailure) ? 'cancelled' : 'error';
  await log({ kind: 'error', code: error.code ?? null, message: error.message });
  final = { decision: 'unknown', answer: 'The trial did not complete.', uncertainties: [bridgeFailure ?? error.message], sourceRefs: checks.map(c => c.sourceId) };
  result ??= { error: error.message };
} finally {
  input.close();
}
if (['host_input_closed', 'host_cancelled'].includes(bridgeFailure)) status = 'cancelled';
const run = RunSchema.parse({ id: `${caseId}-${arm}-${repeat}`, caseId, arm, repeat, status, origin, model, requested, observed: { calls, modelCalls, inputTokens: 'UNKNOWN', outputTokens: 'UNKNOWN', cost: 'UNKNOWN', durationMs: Date.now() - started }, checks, output: JSON.stringify(final), packetDigest: digest(packet), protocolDigest: digest(protocol) });
await save(resultPath, result);
await save(runPath, run);
await log({ kind: 'done', status, observed: run.observed, outputDigest: outputDigest(run.output) });
process.stdout.write(`DONE ${JSON.stringify({ runPath, tracePath, resultPath })}\n`);
