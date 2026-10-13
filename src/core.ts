import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  taskPacketSchema, stateSchema, observationsSchema, generationOutputSchema, reflectionOutputSchema,
  type Assessment, type Evidence, type Gap, type GenerationAdapter, type GenerationInput,
  type GenerationOutput, type ReflectionInput, type ModelValidationFeedback, type InspectionResult, type Observation, type Proposal,
  type TaskPacket, type Tombo, type UnderstandingChange, type UnderstandingState, type Usage,
} from './types.js';

export type TomboErrorCode = 'invalid_input' | 'input_too_large' | 'invalid_model_output' |
  'model_error' | 'model_timeout' | 'budget_accounting_unavailable' | 'budget_exhausted' |
  'no_progress' | 'reflection_inconclusive' | 'assessment_pending' | 'capability_limit' | 'passage_unavailable' | 'revision_conflict' | 'unsupported_fixture' | 'invalid_ledger' | 'candidate_limit';

export class TomboError extends Error {
  constructor(public readonly code: TomboErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TomboError';
  }
}

export function hashPassage(passage: string): string {
  return createHash('sha256').update(passage, 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().filter(key => record[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function understandingHash(state: UnderstandingState): string {
  const metadata = (items: Evidence[]) => items.map(({ passage: _, passageUnavailable: __, ...item }) => item);
  return hashPassage(canonical({
    task: { ...state.task, evidence: metadata(state.task.evidence) }, evidence: metadata(state.evidence),
    claims: state.claims, lenses: state.lenses, gaps: state.gaps, probes: state.probes, excludedCandidates: state.excludedCandidates,
  }));
}

function reflectionFresh(state: UnderstandingState): boolean {
  const receipt = state.reflection;
  return receipt?.completion === 'completed' && receipt.binding.taskId === state.taskId &&
    receipt.binding.understandingHash === understandingHash(state) &&
    receipt.reviewedClaimIds.length === state.claims.length && state.claims.every(claim => receipt.reviewedClaimIds.includes(claim.id));
}

function parse<T>(schema: z.ZodType<T>, input: unknown, code: TomboErrorCode): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new TomboError(code, parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return parsed.data;
}

function requireCondition(condition: unknown, code: TomboErrorCode, message: string): asserts condition {
  if (!condition) throw new TomboError(code, message);
}

function checkEvidence(evidence: Evidence[], code: TomboErrorCode, allowRedacted: boolean): void {
  const known = new Set<string>();
  for (const item of evidence) {
    requireCondition(!known.has(item.id), code, `Duplicate evidence ID ${item.id}`);
    known.add(item.id);
    requireCondition(allowRedacted || !item.passageUnavailable, code, `Evidence passage unavailable ${item.id}`);
    if (!item.passageUnavailable) requireCondition(hashPassage(item.passage) === item.contentHash, code, `Passage hash mismatch ${item.id}`);
  }
}

function conditionIds(task: TaskPacket): Set<string> {
  return new Set(['task:goal', 'task:mode', ...task.successCriteria.map((_, index) => `task:criterion:${index}`)]);
}

function effectiveAssessment(state: UnderstandingState, assessment: Assessment): boolean {
  const claim = state.claims.find(item => item.id === assessment.claimId)!;
  return assessment.scopeMatched && assessment.evidenceIds.every(id => {
    const evidence = state.evidence.find(item => item.id === id)!;
    return evidence.validity === 'current' && !evidence.passageUnavailable && evidence.scope === claim.scope;
  });
}

function claimStatus(state: UnderstandingState, claim: UnderstandingState['claims'][number]): UnderstandingState['claims'][number]['status'] {
  const assessments = claim.assessments.filter(item => effectiveAssessment(state, item));
  const supports = assessments.some(item => item.verdict === 'supports');
  const refutes = assessments.some(item => item.verdict === 'refutes');
  return supports && refutes ? 'disputed' : supports ? 'supported' : refutes ? 'contradicted' : 'unverified';
}

function resolutionValid(state: UnderstandingState, gap: Gap, allowRedacted = false): boolean {
  if (!gap.resolution) return false;
  const evidence = gap.resolution.evidenceIds.map(id => state.evidence.find(item => item.id === id)!);
  if (!evidence.every(item => item.validity === 'current' && (allowRedacted || !item.passageUnavailable))) return false;
  if (gap.resolution.reason === 'not_applicable') return evidence.every(item =>
    gap.claimIds.length ? gap.claimIds.every(id => state.claims.find(claim => claim.id === id)!.scope === item.scope) :
      gap.triggerRefs.includes(item.id) || (gap.triggerRefs.some(ref => ref.startsWith('task:')) && state.task.evidence.some(original => original.id === item.id)));
  const expected = gap.resolution.reason === 'supported' ? 'supported' : 'contradicted';
  if (!gap.claimIds.length) return false;
  return gap.claimIds.every(id => {
    const claim = state.claims.find(item => item.id === id)!;
    if (allowRedacted && evidence.some(item => item.passageUnavailable)) return claim.status === expected;
    return claimStatus(state, claim) === expected && claim.assessments.some(assessment =>
      assessment.verdict === (expected === 'supported' ? 'supports' : 'refutes') && effectiveAssessment(state, assessment) &&
      assessment.evidenceIds.every(ref => gap.resolution!.evidenceIds.includes(ref)));
  });
}

function checkState(state: UnderstandingState, code: TomboErrorCode, derived = true): void {
  requireCondition(state.taskId === state.task.taskId, code, 'Task ID mismatch');
  checkEvidence(state.task.evidence, code, true);
  checkEvidence(state.evidence, code, true);
  const all = [...state.evidence, ...state.claims, ...state.lenses, ...state.gaps, ...state.probes];
  requireCondition(new Set(all.map(item => item.id)).size === all.length, code, 'IDs must be unique across entity kinds');
  const claims = new Set(state.claims.map(item => item.id));
  const evidences = new Set(state.evidence.map(item => item.id));
  const lenses = new Set(state.lenses.map(item => item.id));
  const gaps = new Set(state.gaps.map(item => item.id));
  const probes = new Set(state.probes.map(item => item.id));
  const triggers = new Set([...claims, ...evidences, ...conditionIds(state.task)]);
  for (const original of state.task.evidence) {
    const current = state.evidence.find(item => item.id === original.id);
    requireCondition(current && current.contentHash === original.contentHash && current.scope === original.scope && current.sourceGroup === original.sourceGroup, code, `Task snapshot evidence mismatch ${original.id}`);
  }
  for (const claim of state.claims) for (const assessment of claim.assessments) {
    requireCondition(assessment.claimId === claim.id, code, 'Assessment assigned to wrong claim');
    requireCondition(assessment.evidenceIds.every(id => evidences.has(id)), code, 'Unknown assessment evidence');
  }
  for (const gap of state.gaps) {
    requireCondition(lenses.has(gap.lensId) && gap.claimIds.every(id => claims.has(id)) && gap.probeIds.every(id => probes.has(id)), code, `Unknown gap reference ${gap.id}`);
    requireCondition(gap.triggerRefs.every(id => triggers.has(id)), code, `Unknown trigger reference ${gap.id}`);
    if (gap.resolution) requireCondition(gap.resolution.evidenceIds.every(id => evidences.has(id)), code, 'Unknown resolution evidence');
    for (const probeId of gap.probeIds) requireCondition(state.probes.find(probe => probe.id === probeId)!.gapIds.includes(gap.id), code, 'Gap/probe relation mismatch');
  }
  for (const probe of state.probes) {
    requireCondition(probe.gapIds.every(id => gaps.has(id)), code, `Unknown probe gap ${probe.id}`);
    for (const gapId of probe.gapIds) requireCondition(state.gaps.find(gap => gap.id === gapId)!.probeIds.includes(probe.id), code, 'Probe/gap relation mismatch');
  }
  requireCondition(new Set(state.appliedExecutions.map(item => item.executionId)).size === state.appliedExecutions.length, code, 'Duplicate execution ID');
  requireCondition(state.appliedExecutions.every(item => probes.has(item.probeId)), code, 'Unknown execution probe');
  requireCondition(state.pendingAssessmentExecutionIds?.every(id => state.appliedExecutions.some(item => item.executionId === id)) ?? true, code, 'Unknown pending assessment execution');
  if (state.reflection) requireCondition(state.reflection.binding.taskId === state.taskId && state.reflection.binding.basedRevision < state.revision, code, 'Invalid reflection receipt binding');
  if (!derived) return;
  requireCondition(state.gaps.length <= 8, code, 'Candidate cap exceeded');
  for (const claim of state.claims) {
    const hasRedacted = claim.assessments.some(item => item.evidenceIds.some(id => state.evidence.find(ev => ev.id === id)!.passageUnavailable));
    if (!hasRedacted) requireCondition(claim.status === claimStatus(state, claim), code, `Claim status does not follow evidence ${claim.id}`);
  }
  for (const gap of state.gaps) if (gap.status === 'resolved') requireCondition(resolutionValid(state, gap, true), code, `Unjustified resolution ${gap.id}`);
  if (state.decision === 'ready_for_requested_step' && state.task.reflectionRequired) requireCondition(
    !state.stopReason && reflectionFresh(state) && (!state.task.proposedAnswer || state.claims.length > 0), code, 'Current completed reflection required');
  if (state.decision === 'ready_for_requested_step') requireCondition(!state.pendingAssessmentExecutionIds && !state.gaps.some(gap => gap.importance === 'required' && gap.status !== 'resolved') && !state.excludedCandidates?.some(item => item.importance === 'required'), code, 'Required gaps or assessments remain');
}

function sumKnown(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

export function validateState(input: unknown): UnderstandingState {
  const state = parse(stateSchema, input, 'invalid_input');
  checkState(state, 'invalid_input');
  return state;
}

function exhausted(state: UnderstandingState, forUpdate = false): boolean {
  const { budget } = state.task;
  return state.usage.modelCalls >= budget.maxModelCalls || state.usage.toolCalls >= budget.maxToolCalls ||
    state.usage.elapsedMs >= budget.maxElapsedMs || budget.maxOutputTokensPerCall === 0 ||
    (forUpdate && state.usage.rounds >= budget.maxRounds) ||
    (budget.maxCostYen !== undefined && state.usage.costYen !== null && state.usage.costYen >= budget.maxCostYen);
}

function availableProbe(state: UnderstandingState, probe: UnderstandingState['probes'][number]): boolean {
  return state.task.capabilities.includes(probe.requiredCapability) && (probe.status === 'pending' || probe.status === 'running') &&
    probe.gapIds.some(id => state.gaps.find(gap => gap.id === id)!.status !== 'resolved');
}

function result(state: UnderstandingState, changes: UnderstandingChange[] = []): InspectionResult {
  const needed = state.gaps.filter(gap => gap.importance === 'required' && gap.status !== 'resolved');
  const next = state.probes.filter(probe => availableProbe(state, probe) && probe.gapIds.some(id => needed.some(gap => gap.id === id)))
    .sort((a, b) => {
      const aGap = state.gaps.find(gap => a.gapIds.includes(gap.id))!;
      const bGap = state.gaps.find(gap => b.gapIds.includes(gap.id))!;
      const rank = (gap: Gap) => gap.kind === 'conflicting_evidence' ? 0 : gap.kind === 'unsupported_claim' ? 1 : 2;
      return rank(aGap) - rank(bGap) || a.id.localeCompare(b.id);
    }).slice(0, 3);
  const userQuestions = needed.filter(gap => gap.kind === 'ambiguous_intent').map(gap => gap.question);
  if (state.excludedCandidates?.some(item => item.importance === 'required')) { state.decision = 'blocked'; state.stopReason = 'candidate_limit'; }
  else if (state.task.reflectionRequired && state.stopReason) state.decision = 'blocked';
  else if (!needed.length && !state.pendingAssessmentExecutionIds) {
    if (state.task.reflectionRequired && state.task.proposedAnswer && !state.claims.length) { state.decision = 'blocked'; state.stopReason = 'no_progress'; }
    else if (state.task.reflectionRequired && !reflectionFresh(state)) {
      const budget = state.task.budget;
      if (state.usage.modelCalls >= budget.maxModelCalls || state.usage.toolCalls > budget.maxToolCalls ||
        state.usage.elapsedMs >= budget.maxElapsedMs || budget.maxOutputTokensPerCall === 0 ||
        (budget.maxCostYen !== undefined && state.usage.costYen !== null && state.usage.costYen >= budget.maxCostYen)) {
        state.decision = 'blocked'; state.stopReason = 'budget_exhausted';
      } else state.decision = 'needs_reflection';
    } else { state.decision = 'ready_for_requested_step'; state.stopReason = null; }
  }
  else if (state.stopReason) state.decision = 'blocked';
  else if (exhausted(state, true)) { state.decision = 'blocked'; state.stopReason = 'budget_exhausted'; }
  else if (next.length) state.decision = 'needs_check';
  else if (userQuestions.length && needed.every(gap => gap.kind === 'ambiguous_intent')) state.decision = 'needs_user_input';
  else { state.decision = 'blocked'; state.stopReason = 'capability_limit'; }
  return { state, changes, nextProbeIds: state.decision === 'needs_check' ? next.map(probe => probe.id) : [], userQuestions };
}

function stopped(original: UnderstandingState, usage: Usage, code: TomboErrorCode, executions = original.appliedExecutions, diagnostics = original.modelRepairDiagnostics): InspectionResult {
  const state = structuredClone(original);
  state.usage = usage;
  if (diagnostics) state.modelRepairDiagnostics = structuredClone(diagnostics);
  state.appliedExecutions = executions;
  state.revision++;
  state.stopReason = code;
  state.decision = 'blocked';
  return { state, changes: [], nextProbeIds: [], userQuestions: [] };
}

function changesBetween(before: UnderstandingState, after: UnderstandingState, reason: string): UnderstandingChange[] {
  const changes: UnderstandingChange[] = [];
  for (const claim of after.claims) {
    const old = before.claims.find(item => item.id === claim.id);
    if (old?.status !== claim.status) changes.push({ kind: 'claim_changed', targetId: claim.id, before: old?.status ?? 'absent', after: claim.status,
      evidenceIds: [...new Set(claim.assessments.flatMap(item => item.evidenceIds))], reason });
  }
  for (const gap of after.gaps) {
    const old = before.gaps.find(item => item.id === gap.id);
    if (old?.status !== gap.status) changes.push({ kind: 'gap_changed', targetId: gap.id, before: old?.status ?? 'absent', after: gap.status,
      evidenceIds: gap.resolution?.evidenceIds ?? old?.resolution?.evidenceIds ?? [], reason });
  }
  for (const lens of after.lenses) {
    const old = before.lenses.find(item => item.id === lens.id);
    if (old?.status !== lens.status) changes.push({ kind: 'lens_changed', targetId: lens.id, before: old?.status ?? 'absent', after: lens.status, evidenceIds: [], reason });
  }
  return changes;
}

function recompute(state: UnderstandingState): void {
  for (const claim of state.claims) claim.status = claimStatus(state, claim);
  for (const gap of state.gaps) if (gap.status === 'resolved' && !resolutionValid(state, gap)) {
    gap.status = 'open';
    delete gap.resolution;
    for (const id of gap.probeIds) state.probes.find(probe => probe.id === id)!.status = 'pending';
  }
}

function applyProposal(state: UnderstandingState, proposal: Proposal): void {
  state.decision = 'blocked';
  const all = new Set([...state.evidence, ...state.claims, ...state.lenses, ...state.gaps, ...state.probes].map(item => item.id));
  for (const entity of [...proposal.claims ?? [], ...proposal.lenses ?? [], ...proposal.gaps ?? [], ...proposal.probes ?? []]) {
    requireCondition(!all.has(entity.id), 'invalid_model_output', `Existing entity cannot be overwritten ${entity.id}`);
    all.add(entity.id);
  }
  state.claims.push(...(proposal.claims ?? []).map(claim => ({ ...claim, status: 'unverified' as const, assessments: [] })));
  state.lenses.push(...proposal.lenses ?? []);
  state.gaps.push(...(proposal.gaps ?? []).map(gap => ({ ...gap, status: 'open' as const })));
  state.probes.push(...(proposal.probes ?? []).map(probe => ({ ...probe, status: 'pending' as const })));
  for (const assessment of proposal.assessments ?? []) {
    const claim = state.claims.find(item => item.id === assessment.claimId);
    requireCondition(claim, 'invalid_model_output', `Unknown claim ${assessment.claimId}`);
    requireCondition(assessment.evidenceIds.every(id => state.evidence.some(item => item.id === id)), 'invalid_model_output', 'Unknown evidence assessment');
    if (!claim.assessments.some(old => canonical(old) === canonical(assessment))) claim.assessments.push(assessment);
  }
  checkState(state, 'invalid_model_output', false);
  recompute(state);
  const resolved = new Set<string>();
  for (const resolution of proposal.resolutions ?? []) {
    requireCondition(!resolved.has(resolution.gapId), 'invalid_model_output', 'Duplicate gap resolution');
    resolved.add(resolution.gapId);
    const gap = state.gaps.find(item => item.id === resolution.gapId);
    requireCondition(gap, 'invalid_model_output', `Unknown resolution gap ${resolution.gapId}`);
    requireCondition(resolution.evidenceIds.every(id => state.evidence.some(item => item.id === id)), 'invalid_model_output', 'Unknown resolution evidence');
    const { gapId: _, ...details } = resolution;
    gap.resolution = details;
    requireCondition(resolutionValid(state, gap), 'invalid_model_output', `Resolution lacks current matching evidence ${gap.id}`);
    gap.status = 'resolved';
  }
  if (state.gaps.length > 8) {
    const excess = state.gaps.splice(8);
    const excessIds = new Set(excess.map(gap => gap.id));
    state.excludedCandidates ??= [];
    state.excludedCandidates.push(...excess.map(gap => ({ id: gap.id, reason: 'Candidate cap of 8 reached', importance: gap.importance })));
    state.probes = state.probes.map(probe => ({ ...probe, gapIds: probe.gapIds.filter(id => !excessIds.has(id)) })).filter(probe => probe.gapIds.length);
  }
  for (const gap of state.gaps) if (gap.status !== 'resolved' && gap.kind !== 'ambiguous_intent') {
    for (const probeId of gap.probeIds) {
      const probe = state.probes.find(item => item.id === probeId)!;
      if (probe.status === 'complete') probe.status = 'pending';
    }
    if (!gap.probeIds.some(id => state.probes.some(probe => probe.id === id && availableProbe(state, probe)))) gap.status = 'blocked';
  }
  checkState(state, 'invalid_model_output');
}

function elapsed(state: UnderstandingState, now: number): number {
  return Math.max(state.usage.elapsedMs, Math.max(0, now - Date.parse(state.startedAt)));
}

async function timed<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TomboError('model_timeout', 'Generation exceeded remaining elapsed budget')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function createTombo(options: { adapter: GenerationAdapter; now?: () => Date | number; maxModelRepairAttempts?: number }): Tombo {
  requireCondition(options.adapter && typeof options.adapter.generate === 'function', 'invalid_input', 'Explicit generation adapter required');
  const maxRepairs = options.maxModelRepairAttempts === undefined ? 0 : options.maxModelRepairAttempts;
  requireCondition(Number.isInteger(maxRepairs) && maxRepairs >= 0 && maxRepairs <= 2, 'invalid_input', 'maxModelRepairAttempts must be an integer from 0 to 2');
  const clock = () => {
    const value = options.now?.() ?? new Date();
    const timestamp = value instanceof Date ? value.getTime() : value;
    requireCondition(Number.isFinite(timestamp), 'invalid_input', 'Invalid clock value');
    return timestamp;
  };

  async function generate<I extends GenerationInput | ReflectionInput, O extends { usage?: GenerationOutput['usage'] }>(
    state: UnderstandingState, input: I,
    adapter: { generate(input: I): Promise<O>; estimateMaxCostYen?(input: I): number | Promise<number> }, schema: z.ZodType<O>,
  ): Promise<O> {
    const budget = state.task.budget;
    const generationInput = { ...input, maxOutputTokens: budget.maxOutputTokensPerCall };
    requireCondition(JSON.stringify(generationInput).length <= budget.maxInputChars, 'input_too_large', 'Generation input exceeds character cap');
    for (let attempt = 0; attempt < 2; attempt++) {
      state.usage.elapsedMs = elapsed(state, clock());
      requireCondition(state.usage.modelCalls < budget.maxModelCalls && state.usage.elapsedMs < budget.maxElapsedMs && budget.maxOutputTokensPerCall > 0, 'budget_exhausted', 'Generation budget exhausted');
      let reserved: number | undefined;
      if (budget.maxCostYen !== undefined) {
        requireCondition(adapter.estimateMaxCostYen && state.usage.costYen !== null, 'budget_accounting_unavailable', 'Monetary cap requires a cost upper bound and known usage');
        try {
          reserved = await timed(() => Promise.resolve(adapter.estimateMaxCostYen!(structuredClone(generationInput))), budget.maxElapsedMs - state.usage.elapsedMs);
        } catch (error) {
          if (error instanceof TomboError) throw error;
          throw new TomboError('budget_accounting_unavailable', 'Cost reservation failed', { cause: error });
        } finally {
          state.usage.elapsedMs = elapsed(state, clock());
        }
        requireCondition(Number.isFinite(reserved) && reserved >= 0, 'budget_accounting_unavailable', 'Invalid maximum cost estimate');
        requireCondition(state.usage.costYen + reserved <= budget.maxCostYen, 'budget_exhausted', 'Reserved generation cost exceeds monetary cap');
      }
      state.usage.elapsedMs = elapsed(state, clock());
      requireCondition(state.usage.elapsedMs < budget.maxElapsedMs, 'budget_exhausted', 'Cost estimate consumed remaining elapsed budget');
      const started = clock();
      const elapsedBeforeCall = state.usage.elapsedMs;
      state.usage.modelCalls++;
      let accountedOutput = false;
      try {
        const raw = await timed(() => adapter.generate(structuredClone(generationInput)), budget.maxElapsedMs - state.usage.elapsedMs);
        const reported = parse(z.object({ usage: generationOutputSchema.shape.usage }), raw, maxRepairs ? 'budget_accounting_unavailable' : 'invalid_model_output');
        state.usage.totalTokens = sumKnown(state.usage.totalTokens, reported.usage?.totalTokens ?? null);
        state.usage.costYen = sumKnown(state.usage.costYen, reported.usage?.costYen ?? null);
        accountedOutput = true;
        if (budget.maxCostYen !== undefined) requireCondition(reported.usage?.costYen !== null && reported.usage?.costYen !== undefined && reported.usage.costYen <= reserved!, 'budget_accounting_unavailable', 'Reported model cost exceeds reserved upper bound or is unavailable');
        const outputTokens = reported.usage?.outputTokens ?? reported.usage?.totalTokens;
        requireCondition(outputTokens !== null && outputTokens !== undefined, 'budget_accounting_unavailable', 'Adapter must report output token count or total token upper bound');
        requireCondition(outputTokens <= budget.maxOutputTokensPerCall, 'budget_exhausted', 'Output token cap exceeded');
        state.usage.elapsedMs = elapsed(state, clock());
        requireCondition(state.usage.elapsedMs < budget.maxElapsedMs, 'budget_exhausted', 'Generation consumed remaining elapsed budget');
        return parse(schema, raw, 'invalid_model_output');
      } catch (error) {
        if (!accountedOutput) { state.usage.totalTokens = null; state.usage.costYen = null; }
        if (error instanceof TomboError && error.code !== 'model_timeout') {
          throw error;
        }
        state.usage.totalTokens = null;
        state.usage.costYen = null;
        if (error instanceof TomboError && error.code === 'model_timeout') { state.usage.elapsedMs = budget.maxElapsedMs; throw error; }
        if (maxRepairs > 0 || attempt === 1 || budget.maxCostYen !== undefined) throw error instanceof TomboError ? error : new TomboError('model_error', 'Generation adapter failed', { cause: error });
      } finally {
        state.usage.elapsedMs = Math.max(elapsed(state, clock()), elapsedBeforeCall + Math.max(0, clock() - started));
      }
    }
    throw new TomboError('model_error', 'Generation failed');
  }

  async function propose<I extends GenerationInput | ReflectionInput, O extends { usage?: GenerationOutput['usage'] }>(
    state: UnderstandingState, input: I,
    adapter: { generate(input: I): Promise<O>; estimateMaxCostYen?(input: I): number | Promise<number> },
    schema: z.ZodType<O>, apply: (candidate: UnderstandingState, output: O) => void,
  ): Promise<UnderstandingState> {
    let feedback: ModelValidationFeedback | undefined;
    for (let attempt = 1; ; attempt++) {
      const callsBeforeAttempt = state.usage.modelCalls;
      try {
        const output = await generate(state, feedback ? { ...input, validationFeedback: feedback } : input, adapter, schema);
        const candidate = structuredClone(state);
        apply(candidate, output);
        return candidate;
      } catch (error) {
        if (!maxRepairs || state.usage.modelCalls === callsBeforeAttempt || !(error instanceof TomboError) || error.code !== 'invalid_model_output') throw error;
        feedback = { code: error.code, message: error.message.slice(0, 512) || 'Invalid model output', rejectedAttempt: attempt, maxAttempts: maxRepairs + 1 };
        state.modelRepairDiagnostics ??= [];
        state.modelRepairDiagnostics.push({ operation: input.operation, ...feedback });
        requireCondition(state.usage.elapsedMs < state.task.budget.maxElapsedMs, 'budget_exhausted', 'Generation elapsed budget exhausted');
        if (state.task.budget.maxCostYen !== undefined) requireCondition(state.usage.costYen !== null, 'budget_accounting_unavailable', 'Monetary usage unavailable after rejected model output');
        if (attempt > maxRepairs) throw error;
      }
    }
  }

  return {
    async inspect(input) {
      const task = parse(taskPacketSchema, input, 'invalid_input');
      checkEvidence(task.evidence, 'invalid_input', false);
      requireCondition(JSON.stringify(task).length <= task.budget.maxInputChars, 'input_too_large', 'Task exceeds character cap');
      const state: UnderstandingState = { schemaVersion: '0.1', taskId: task.taskId, revision: 0, startedAt: new Date(clock()).toISOString(), task,
        evidence: structuredClone(task.evidence), claims: [], lenses: [], gaps: [], probes: [],
        usage: { rounds: 0, modelCalls: 0, toolCalls: 0, elapsedMs: 0, totalTokens: 0, costYen: 0 },
        decision: 'blocked', stopReason: null, appliedExecutions: [], excludedCandidates: [] };
      if (exhausted(state) || task.budget.maxRounds === 0) return { state: { ...state, stopReason: 'budget_exhausted' }, changes: [], nextProbeIds: [], userQuestions: [] };
      const original = structuredClone(state);
      try {
        const candidate = await propose(state, { operation: 'inspect', task }, options.adapter, generationOutputSchema,
          (candidate, output) => applyProposal(candidate, output.proposal));
        candidate.revision = 1;
        return result(candidate, changesBetween(original, candidate, 'Initial inspection proposal'));
      } catch (error) {
        if (maxRepairs && error instanceof TomboError) return stopped(original, state.usage, error.code, original.appliedExecutions, state.modelRepairDiagnostics);
        throw error;
      }
    },
    async reflect(input, critic) {
      const original = parse(stateSchema, input, 'invalid_input');
      checkState(original, 'invalid_input');
      const state = structuredClone(original);
      state.decision = 'blocked';
      state.stopReason = null;
      state.usage.elapsedMs = elapsed(state, clock());
      try {
        requireCondition(critic && typeof critic.reflect === 'function', 'invalid_input', 'Explicit critic adapter required');
        requireCondition(!state.pendingAssessmentExecutionIds, 'assessment_pending', 'Complete the pending assessment before reflection');
        requireCondition(state.usage.toolCalls <= state.task.budget.maxToolCalls, 'budget_exhausted', 'Observed tool budget exceeded');
        requireCondition(!state.evidence.some(item => item.validity === 'current' && item.passageUnavailable), 'passage_unavailable', 'Reacquire current evidence passages before reflection');
        const binding = { taskId: state.taskId, basedRevision: original.revision, understandingHash: understandingHash(original) };
        const reflectionInput: ReflectionInput = { operation: 'reflect', task: state.task, state: structuredClone(original), binding,
          maxOutputTokens: state.task.budget.maxOutputTokensPerCall };
        const candidate = await propose(state, reflectionInput, {
          generate: value => critic.reflect(value),
          ...(critic.estimateMaxCostYen ? { estimateMaxCostYen: (value: ReflectionInput) => critic.estimateMaxCostYen!(value) } : {}),
        }, reflectionOutputSchema, (candidate, output) => {
          requireCondition(canonical(output.binding) === canonical(binding), 'invalid_model_output', 'Reflection binding does not match current understanding');
          requireCondition(output.reviewedClaimIds.every(id => original.claims.some(claim => claim.id === id)) &&
            (output.completion !== 'completed' || original.claims.every(claim => output.reviewedClaimIds.includes(claim.id))),
            'invalid_model_output', 'Reflection claim coverage does not match current claims');
          applyProposal(candidate, output.proposal);
          candidate.reflection = { binding: output.binding, reviewedClaimIds: output.reviewedClaimIds, completion: output.completion, limitations: output.limitations };
        });
        candidate.revision = original.revision + 1;
        const changes = changesBetween(original, candidate, 'Reflection proposed additional checks');
        if (candidate.reflection!.completion === 'inconclusive') {
          candidate.decision = 'blocked'; candidate.stopReason = 'reflection_inconclusive';
          return { state: candidate, changes, nextProbeIds: [], userQuestions: [] };
        }
        return result(candidate, changes);
      } catch (error) {
        if (error instanceof TomboError) return stopped(original, state.usage, error.code, original.appliedExecutions, state.modelRepairDiagnostics);
        throw error;
      }
    },
    async update(input, observationsInput, updateOptions) {
      const original = parse(stateSchema, input, 'invalid_input');
      checkState(original, 'invalid_input');
      let state = structuredClone(original);
      let validatedObservations: UnderstandingState | undefined;
      state.decision = 'blocked';
      state.stopReason = null;
      state.usage.elapsedMs = elapsed(state, clock());
      try {
        const mode = parse(z.strictObject({ deferAssessment: z.literal(true).optional() }), updateOptions ?? {}, 'invalid_input');
        const observations = parse(observationsSchema, observationsInput, 'invalid_input');
        const unique: Observation[] = [];
        const supplied = new Map<string, Observation>();
        const pending = original.pendingAssessmentExecutionIds ?? [];
        const deliveries = new Map(original.appliedExecutions.map(item => [item.executionId, item.payloadHash]));
        for (const observation of observations) {
          checkEvidence(observation.evidence, 'invalid_input', false);
          requireCondition(state.probes.some(probe => probe.id === observation.probeId), 'invalid_input', `Unknown probe ${observation.probeId}`);
          requireCondition(observation.outcome === 'completed' || observation.evidence.length === 0, 'invalid_input', 'Non-completed outcome cannot contain evidence');
          const payloadHash = hashPassage(canonical(observation));
          const previous = deliveries.get(observation.executionId);
          requireCondition(previous === undefined || previous === payloadHash, 'invalid_input', `Execution payload collision ${observation.executionId}`);
          supplied.set(observation.executionId, observation);
          if (previous === undefined) { deliveries.set(observation.executionId, payloadHash); unique.push(observation); }
        }
        requireCondition(!pending.length || (supplied.size === pending.length && pending.every(id => supplied.has(id))), 'invalid_input', 'Redeliver the exact pending assessment batch before another update');
        if (observations.length && !unique.length && (!pending.length || mode.deferAssessment)) return { state: original, changes: [], nextProbeIds: original.decision === 'needs_check' ? result(structuredClone(original)).nextProbeIds : [], userQuestions: [] };
        const assessmentObservations = pending.length ? pending.map(id => supplied.get(id)!) : unique;
        if (!assessmentObservations.length) return stopped(original, state.usage, 'no_progress');
        const budget = state.task.budget;
        if (pending.length && !mode.deferAssessment) {
          const canRetry = state.usage.modelCalls < budget.maxModelCalls && state.usage.rounds < budget.maxRounds &&
            state.usage.toolCalls <= budget.maxToolCalls && state.usage.elapsedMs < budget.maxElapsedMs && budget.maxOutputTokensPerCall > 0 &&
            (budget.maxCostYen === undefined || state.usage.costYen === null || state.usage.costYen < budget.maxCostYen);
          if (!canRetry && original.stopReason === 'budget_exhausted') return { state: original, changes: [], nextProbeIds: [], userQuestions: [] };
          requireCondition(canRetry, 'budget_exhausted', 'Assessment retry budget exhausted');
        }
        const newTools = unique.reduce((sum, item) => sum + item.toolCalls, 0);
        const toolTime = unique.reduce((sum, item) => sum + item.elapsedMs, 0);
        const registered = new Map(state.evidence.map(item => [item.id, item]));
        for (const observation of assessmentObservations) for (const evidence of observation.evidence) {
          const old = registered.get(evidence.id);
          const rehydrated = old?.passageUnavailable && canonical({ ...old, passage: evidence.passage, passageUnavailable: undefined }) === canonical(evidence);
          requireCondition(!old || canonical(old) === canonical(evidence) || rehydrated, 'invalid_input', `Evidence ID collision ${evidence.id}`);
          if (rehydrated) {
            state.evidence[state.evidence.findIndex(item => item.id === old.id)] = evidence;
            const originalEvidence = state.task.evidence.find(item => item.id === old.id);
            if (originalEvidence?.passageUnavailable) { originalEvidence.passage = evidence.passage; delete originalEvidence.passageUnavailable; }
          }
          if (!old) { registered.set(evidence.id, evidence); state.evidence.push(evidence); }
        }
        for (const observation of unique) {
          state.appliedExecutions.push({ executionId: observation.executionId, payloadHash: deliveries.get(observation.executionId)!, probeId: observation.probeId, outcome: observation.outcome });
          const probe = state.probes.find(item => item.id === observation.probeId)!;
          probe.status = observation.outcome === 'completed' ? 'complete' : observation.outcome === 'no_result' ? 'pending' : observation.outcome;
          for (const gapId of probe.gapIds) {
            const gap = state.gaps.find(item => item.id === gapId)!;
            if (gap.status !== 'resolved') gap.status = observation.outcome === 'unavailable' || observation.outcome === 'error' ? 'blocked' : 'open';
          }
        }
        checkState(state, 'invalid_input');
        state.pendingAssessmentExecutionIds = assessmentObservations.map(item => item.executionId);
        state.decision = 'blocked';
        if (!mode.deferAssessment) state.usage.rounds++;
        state.usage.toolCalls += newTools;
        state.usage.elapsedMs = Math.max(original.usage.elapsedMs + toolTime, state.usage.elapsedMs);
        for (const observation of unique) state.usage.costYen = sumKnown(state.usage.costYen, observation.costYen);
        validatedObservations = structuredClone(state);
        if (mode.deferAssessment) return stopped(state, state.usage, 'assessment_pending');
        requireCondition(state.usage.modelCalls < budget.maxModelCalls && state.usage.rounds <= budget.maxRounds &&
          state.usage.toolCalls <= budget.maxToolCalls && state.usage.elapsedMs < budget.maxElapsedMs && budget.maxOutputTokensPerCall > 0,
          'budget_exhausted', 'Update or observed tool budget exhausted');
        if (budget.maxCostYen !== undefined) {
          requireCondition(state.usage.costYen !== null, 'budget_accounting_unavailable', 'Tool monetary usage unavailable');
          requireCondition(state.usage.costYen <= budget.maxCostYen, 'budget_exhausted', 'Tool monetary cap exceeded');
        }
        requireCondition(!state.evidence.some(item => item.validity === 'current' && item.passageUnavailable), 'passage_unavailable', 'Reacquire current evidence passages before generation');
        const beforeProposal = structuredClone(state);
        const candidate = await propose(state, { operation: 'update', task: state.task, state: beforeProposal, observations: assessmentObservations }, options.adapter, generationOutputSchema, (candidate, output) => {
          for (const resolution of output.proposal.resolutions ?? []) {
            const gap = state.gaps.find(item => item.id === resolution.gapId);
            const observationsForGap = assessmentObservations.filter(observation => gap?.probeIds.includes(observation.probeId));
            requireCondition(!observationsForGap.length || observationsForGap.some(observation => observation.outcome === 'completed' && observation.evidence.length > 0), 'invalid_model_output', 'Unsuccessful probe outcome cannot resolve a gap');
          }
          applyProposal(candidate, output.proposal);
          delete candidate.pendingAssessmentExecutionIds;
        });
        state = candidate;
        state.revision = original.revision + 1;
        const changes = changesBetween(original, state, 'Evidence assessment proposal');
        const hasNewEvidence = state.evidence.some(item => !original.evidence.some(old => old.id === item.id));
        if (!hasNewEvidence && !changes.length) state.stopReason = assessmentObservations.some(item => item.outcome === 'unavailable' || item.outcome === 'error') ? 'capability_limit' : 'no_progress';
        return result(state, changes);
      } catch (error) {
        if (error instanceof TomboError) return stopped(validatedObservations ?? original, state.usage, error.code, validatedObservations?.appliedExecutions ?? original.appliedExecutions, state.modelRepairDiagnostics);
        throw error;
      }
    },
    invalidate(input, invalidation) {
      const original = parse(stateSchema, input, 'invalid_input');
      checkState(original, 'invalid_input');
      const request = parse(z.strictObject({ evidenceIds: z.array(z.string().min(1)).min(1), reason: z.string().min(1) }), invalidation, 'invalid_input');
      requireCondition(new Set(request.evidenceIds).size === request.evidenceIds.length && request.evidenceIds.every(id => original.evidence.some(item => item.id === id)), 'invalid_input', 'Invalid evidence IDs for invalidation');
      const state = structuredClone(original);
      state.decision = 'blocked';
      state.stopReason = null;
      let changed = false;
      for (const evidence of state.evidence) if (request.evidenceIds.includes(evidence.id) && evidence.validity === 'current') { evidence.validity = 'withdrawn'; changed = true; }
      if (!changed) return { state: original, changes: [], nextProbeIds: [], userQuestions: [] };
      recompute(state);
      const pendingProbes = new Set(state.appliedExecutions.filter(item => state.pendingAssessmentExecutionIds?.includes(item.executionId)).map(item => item.probeId));
      delete state.pendingAssessmentExecutionIds;
      for (const probe of state.probes) if (pendingProbes.has(probe.id) && probe.status === 'complete' &&
        probe.gapIds.some(id => state.gaps.find(gap => gap.id === id)!.status !== 'resolved')) probe.status = 'pending';
      state.revision++;
      checkState(state, 'invalid_input');
      return result(state, changesBetween(original, state, request.reason));
    },
  };
}
