import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assessmentSchema, taskPacketSchema, stateSchema, observationsSchema, generationOutputSchema, reflectionOutputSchema,
  type Assessment, type AssessmentReference, type AssessmentScopeDiagnostic, type Evidence, type Gap, type GenerationAdapter, type GenerationInput,
  type GenerationOutput, type ReflectionInput, type ModelValidationFeedback, type LastProposalRejection, type InspectionResult, type Observation, type Proposal,
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

type RejectionDetail = Pick<LastProposalRejection, 'kind' | 'target'>;
const proposalGuardDetails = new WeakMap<TomboError, RejectionDetail>();
function proposalGuard(condition: unknown, message: string, detail: RejectionDetail): asserts condition {
  if (condition) return;
  const error = new TomboError('invalid_model_output', message);
  proposalGuardDetails.set(error, detail);
  throw error;
}

function rejectionTargetExists(state: UnderstandingState, target: NonNullable<LastProposalRejection['target']>): boolean {
  const collections = { gap: state.gaps, claim: state.claims, probe: state.probes, lens: state.lenses };
  return collections[target.kind].some(item => item.id === target.id);
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

export function assessmentDigest(input: unknown): string {
  return hashPassage(canonical(parse(assessmentSchema, input, 'invalid_input')));
}

export function assessmentReferences(state: UnderstandingState): AssessmentReference[] {
  return state.claims.flatMap(claim => claim.assessments.map((assessment, assessmentIndex) => ({
    claimId: claim.id, assessmentIndex, digest: assessmentDigest(assessment),
  })));
}

export function assessmentScopeDiagnostics(state: UnderstandingState): AssessmentScopeDiagnostic[] {
  const diagnostics: AssessmentScopeDiagnostic[] = [];
  const corrected = new Set(state.assessmentCorrections?.map(item => item.targetDigest));
  const evidenceById = new Map(state.evidence.map(item => [item.id, item]));
  for (const claim of state.claims) claim.assessments.forEach((assessment, assessmentIndex) => {
    const digest = assessmentDigest(assessment);
    if (corrected.has(digest)) return;
    const passageUnavailable = assessment.evidenceIds.some(id => evidenceById.get(id)?.passageUnavailable === true);
    for (const evidenceId of assessment.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (evidence?.validity !== 'current') continue;
      const details = { claimId: claim.id, assessmentIndex, digest, evidenceId, claimScope: claim.scope, evidenceScope: evidence.scope, reason: assessment.reason, passageUnavailable };
      if (!assessment.scopeMatched) diagnostics.push({ ...details, kind: 'assessment_scope_unmatched' });
      if (evidence.scope !== claim.scope) diagnostics.push({ ...details, kind: 'evidence_scope_mismatch' });
    }
  });
  return diagnostics;
}

export function understandingHash(state: UnderstandingState): string {
  const metadata = (items: Evidence[]) => items.map(({ passage: _, passageUnavailable: __, ...item }) => item);
  return hashPassage(canonical({
    task: { ...state.task, evidence: metadata(state.task.evidence) }, evidence: metadata(state.evidence),
    assessmentCorrections: state.assessmentCorrections, claims: state.claims, lenses: state.lenses, gaps: state.gaps, probes: state.probes, excludedCandidates: state.excludedCandidates,
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

function effectiveAssessment(state: UnderstandingState, assessment: Assessment, allowRedacted = false): boolean {
  if (state.assessmentCorrections?.some(item => item.targetDigest === assessmentDigest(assessment))) return false;
  const claim = state.claims.find(item => item.id === assessment.claimId)!;
  return assessment.scopeMatched && assessment.evidenceIds.every(id => {
    const evidence = state.evidence.find(item => item.id === id)!;
    return evidence.validity === 'current' && (allowRedacted || !evidence.passageUnavailable) && evidence.scope === claim.scope;
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
    const redactedResolution = allowRedacted && evidence.some(item => item.passageUnavailable);
    if (redactedResolution && !state.assessmentCorrections?.length) return claim.status === expected;
    return (redactedResolution ? claim.status : claimStatus(state, claim)) === expected && claim.assessments.some(assessment =>
      assessment.verdict === (expected === 'supported' ? 'supports' : 'refutes') && effectiveAssessment(state, assessment, redactedResolution) &&
      assessment.evidenceIds.every(ref => gap.resolution!.evidenceIds.includes(ref)));
  });
}

function checkState(state: UnderstandingState, code: TomboErrorCode, derived = true, policyMetadata = true): void {
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
  const corrected = new Set<string>();
  for (const correction of state.assessmentCorrections ?? []) {
    const history = state.claims.find(item => item.id === correction.claimId)?.assessments ?? [];
    const target = history.find(item => assessmentDigest(item) === correction.targetDigest);
    const replacement = history.find(item => assessmentDigest(item) === correction.replacementDigest);
    requireCondition(target && replacement, code, 'Correction references must belong to the same claim history');
    requireCondition(correction.targetDigest !== correction.replacementDigest, code, 'Correction cannot replace itself');
    requireCondition(!corrected.has(correction.targetDigest), code, 'Assessment already corrected');
    requireCondition(!corrected.has(correction.replacementDigest), code, 'Replacement assessment already corrected');
    requireCondition(correction.groundingEvidenceIds.every(id => evidences.has(id) && replacement.evidenceIds.includes(id)), code, 'Correction grounding must reference replacement evidence');
    corrected.add(correction.targetDigest);
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
  for (const execution of state.appliedExecutions) if (execution.staticSnapshot) {
    requireCondition(execution.outcome === 'completed' && execution.staticSnapshot.evidenceIds.every(id => evidences.has(id)), code, 'Invalid static snapshot execution');
  }
  requireCondition(state.pendingAssessmentExecutionIds?.every(id => state.appliedExecutions.some(item => item.executionId === id)) ?? true, code, 'Unknown pending assessment execution');
  if (state.reflection) requireCondition(state.reflection.binding.taskId === state.taskId && state.reflection.binding.basedRevision < state.revision, code, 'Invalid reflection receipt binding');
  if (policyMetadata) {
    const rejection = state.lastProposalRejection;
    if (rejection) {
      requireCondition(rejection.taskId === state.taskId && rejection.atRevision <= state.revision, code, 'Invalid proposal rejection task or revision');
      if (rejection.atRevision === state.revision) requireCondition(state.stopReason === 'invalid_model_output' && rejection.understandingHash === understandingHash(state) && (!rejection.target || rejectionTargetExists(state, rejection.target)), code, 'Invalid current proposal rejection binding');
    }
    const history = state.policyHistory;
    if (history) {
      requireCondition(history.lastUnderstandingHash !== null && history.lastUnderstandingHash === understandingHash(state), code, 'Policy history understanding hash mismatch');
      requireCondition(history.lastProgressAtRevision <= state.revision && history.consecutiveNoProgressRounds <= state.revision - history.lastProgressAtRevision, code, 'Invalid policy history revisions');
    }
    requireCondition(reflectionEffectsValid(state), code, 'Invalid reflection effects references or binding');
  }
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

function reflectionEffectsValid(state: UnderstandingState): boolean {
  const effects = state.reflectionEffects;
  return !effects || (!!state.reflection && canonical(effects.binding) === canonical(state.reflection.binding) &&
    effects.appliedRevision === effects.binding.basedRevision + 1 && effects.appliedRevision <= state.revision &&
    effects.addedGoalGapIds.every(id => state.gaps.some(gap => gap.id === id && gap.importance === 'required' && gap.triggerRefs.includes('task:goal'))) &&
    effects.addedLensIds.every(id => state.lenses.some(lens => lens.id === id && lens.origin === 'proposed' && lens.status !== 'retired')));
}

function refreshPolicyMetadata(state: UnderstandingState): void {
  if (state.policyHistory) state.policyHistory.lastUnderstandingHash = understandingHash(state);
  if (!reflectionEffectsValid(state) || state.reflectionEffects?.addedGoalGapIds.some(id => state.gaps.some(gap => gap.id === id && gap.status === 'resolved'))) delete state.reflectionEffects;
}

function recordPolicyOutcome(original: UnderstandingState, state: UnderstandingState, outcome: 'progress' | 'no_result' | 'unavailable' | 'error' | 'deferred' | null): void {
  const history = original.policyHistory ?? { consecutiveNoProgressRounds: 0, lastUnderstandingHash: null, recentOutcomes: [], lastProgressAtRevision: original.revision };
  state.policyHistory = {
    consecutiveNoProgressRounds: outcome === 'progress' ? 0 : history.consecutiveNoProgressRounds + (outcome && outcome !== 'deferred' ? 1 : 0),
    lastUnderstandingHash: understandingHash(state),
    recentOutcomes: outcome ? [...history.recentOutcomes, outcome].slice(-10) : [...history.recentOutcomes],
    lastProgressAtRevision: outcome === 'progress' ? state.revision : history.lastProgressAtRevision,
  };
  refreshPolicyMetadata(state);
}

export function evaluatePolicy(inputState: UnderstandingState): InspectionResult {
  return result(validateState(structuredClone(inputState)), []);
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
  const human = needed.filter(gap => gap.kind === 'ambiguous_intent');
  const early = human.filter(gap => gap.triggerRefs.includes('task:goal') || gap.humanRole !== undefined);
  const contradictions = state.claims.filter(claim => claim.status === 'disputed' &&
    (claim.role === 'answer_claim' || needed.some(gap => gap.claimIds.includes(claim.id))) &&
    !state.probes.some(probe => availableProbe(state, probe) && probe.gapIds.some(id => needed.some(gap => gap.id === id && gap.claimIds.includes(claim.id)))));
  const questionFor = (gap: Gap) => {
    const actions = state.task.proposedActions?.length ? state.task.proposedActions :
      state.probes.filter(probe => gap.probeIds.includes(probe.id)).map(probe => probe.question);
    return `${gap.question} ${gap.whyItMatters} 目的: ${state.task.goal} 回答に基づき、次の行動「${actions.length ? actions.join(' / ') : state.task.goal}」の選択・実施条件を確定します。`;
  };
  const arbitration = () => contradictions.map(claim => {
    const linked = needed.find(gap => gap.claimIds.includes(claim.id));
    return linked ? `${questionFor(linked)} 対立する主張「${claim.text}」の採用すべき根拠を指定してください。` :
      `主張「${claim.text}」の証拠が対立しています。目的「${state.task.goal}」に対し、どの根拠を採用しますか。回答に基づき、次の実行案または確認対象を選択します。`;
  });
  let userQuestions: string[] = [];
  const ask = (gaps: Gap[], includeContradictions = false) => {
    state.decision = 'needs_user_input'; state.stopReason = null;
    userQuestions = [...new Set([...gaps.map(questionFor), ...(includeContradictions ? arbitration() : [])])];
  };
  const noProgress = (state.policyHistory?.consecutiveNoProgressRounds ?? 0) >= 2;
  const stoppedPolicy = state.stopReason !== null && (state.stopReason !== 'no_progress' || !noProgress);
  const effectGaps = needed.filter(gap => state.reflectionEffects?.addedGoalGapIds.includes(gap.id));
  if (state.excludedCandidates?.some(item => item.importance === 'required')) { state.decision = 'blocked'; state.stopReason = 'candidate_limit'; }
  else if (state.task.reflectionRequired && stoppedPolicy) state.decision = 'blocked';
  else if (state.pendingAssessmentExecutionIds?.length) state.decision = 'blocked';
  else if (!needed.length && !state.pendingAssessmentExecutionIds && !contradictions.length) {
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
  else if (stoppedPolicy) state.decision = 'blocked';
  else if (exhausted(state, true)) { state.decision = 'blocked'; state.stopReason = 'budget_exhausted'; }
  else if (noProgress) {
    if (human.length || contradictions.length) ask(human, true);
    else { state.decision = 'blocked'; state.stopReason = 'no_progress'; }
  }
  else if (effectGaps.some(gap => gap.kind === 'ambiguous_intent')) ask(effectGaps.filter(gap => gap.kind === 'ambiguous_intent'));
  else if (early.length) ask(early);
  else if (effectGaps.some(gap => gap.kind !== 'ambiguous_intent' && gap.probeIds.some(id => next.some(probe => probe.id === id))) || next.length) { state.decision = 'needs_check'; state.stopReason = null; }
  else if (contradictions.length) ask([], true);
  else if (human.length) ask(human);
  else { state.decision = 'blocked'; state.stopReason = needed.some(gap => gap.probeIds.some(id => state.probes.find(probe => probe.id === id)?.status === 'exhausted')) ? 'no_progress' : 'capability_limit'; }
  return { state: parse(stateSchema, state, 'invalid_input'), changes, nextProbeIds: state.decision === 'needs_check' ? next.map(probe => probe.id) : [], userQuestions };
}

function stopped(original: UnderstandingState, usage: Usage, code: TomboErrorCode, executions = original.appliedExecutions, diagnostics = original.modelRepairDiagnostics): InspectionResult {
  const state = structuredClone(original);
  state.usage = usage;
  if (diagnostics) state.modelRepairDiagnostics = structuredClone(diagnostics);
  state.appliedExecutions = executions;
  state.revision++;
  state.stopReason = code;
  state.decision = 'blocked';
  recordPolicyOutcome(original, state, null);
  return { state: parse(stateSchema, state, 'invalid_input'), changes: [], nextProbeIds: [], userQuestions: [] };
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

function applyProposal(state: UnderstandingState, proposal: Proposal, operation: GenerationInput['operation'] | 'reflect'): void {
  requireCondition(proposal.assessmentCorrections === undefined || operation === 'update', 'invalid_model_output', 'Assessment corrections require update');
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
  for (const assessment of [...proposal.assessments ?? [], ...(proposal.assessmentCorrections ?? []).map(item => item.replacement)]) {
    const claim = state.claims.find(item => item.id === assessment.claimId);
    requireCondition(claim, 'invalid_model_output', `Unknown claim ${assessment.claimId}`);
    requireCondition(assessment.evidenceIds.every(id => state.evidence.some(item => item.id === id)), 'invalid_model_output', 'Unknown evidence assessment');
    if (!claim.assessments.some(old => canonical(old) === canonical(assessment))) claim.assessments.push(assessment);
  }
  for (const correction of proposal.assessmentCorrections ?? []) {
    requireCondition(correction.groundingEvidenceIds.every(id => {
      const evidence = state.evidence.find(item => item.id === id);
      return evidence?.validity === 'current' && !evidence.passageUnavailable;
    }), 'invalid_model_output', 'Correction requires current evidence with an available passage');
    state.assessmentCorrections ??= [];
    const { replacement, ...record } = correction;
    state.assessmentCorrections.push({ ...record, replacementDigest: assessmentDigest(replacement) });
  }
  checkState(state, 'invalid_model_output', false, false);
  recompute(state);
  const resolved = new Set<string>();
  for (const resolution of proposal.resolutions ?? []) {
    const detail: RejectionDetail = { kind: 'resolution_not_justified', target: { kind: 'gap', id: resolution.gapId } };
    proposalGuard(!resolved.has(resolution.gapId), 'Duplicate gap resolution', detail);
    resolved.add(resolution.gapId);
    const gap = state.gaps.find(item => item.id === resolution.gapId);
    requireCondition(gap, 'invalid_model_output', `Unknown resolution gap ${resolution.gapId}`);
    proposalGuard(resolution.evidenceIds.every(id => state.evidence.some(item => item.id === id)), 'Unknown resolution evidence', detail);
    const { gapId: _, ...details } = resolution;
    gap.resolution = details;
    proposalGuard(resolutionValid(state, gap), `Resolution lacks current matching evidence ${gap.id}`, detail);
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
    if (!gap.probeIds.some(id => state.probes.some(probe => probe.id === id && (availableProbe(state, probe) || probe.status === 'exhausted')))) gap.status = 'blocked';
  }
  checkState(state, 'invalid_model_output', true, false);
}

function evidenceMeaning(evidence: Evidence): string {
  const { kind, locator, sourceGroup, version, scope, contentHash, validity } = evidence;
  return canonical({ kind, locator, sourceGroup, version, scope, contentHash, validity });
}

function repeatedSnapshot(original: UnderstandingState, observation: Observation, batchIds: Set<string>): boolean {
  if (!observation.staticSnapshot) return false;
  const priorIds = new Set(original.appliedExecutions.filter(execution => !batchIds.has(execution.executionId) &&
    execution.staticSnapshot?.id === observation.staticSnapshot).flatMap(execution => execution.staticSnapshot!.evidenceIds));
  return observation.evidence.every(evidence => original.evidence.some(old => priorIds.has(old.id) &&
    !old.passageUnavailable && evidenceMeaning(old) === evidenceMeaning(evidence)));
}

function reopenExhaustedProbes(state: UnderstandingState): void {
  for (const probe of state.probes) if (probe.status === 'exhausted') probe.status = 'pending';
}

function elapsed(state: UnderstandingState, now: number): number {
  return Math.max(state.usage.elapsedMs, Math.max(0, now - Date.parse(state.startedAt)));
}

function generationBudgetAvailable(state: UnderstandingState): boolean {
  const budget = state.task.budget;
  return state.usage.modelCalls < budget.maxModelCalls && state.usage.elapsedMs < budget.maxElapsedMs && budget.maxOutputTokensPerCall > 0;
}

export function checkpointBudget(input: unknown, options: { operation?: 'update' | 'reflect'; now?: Date | number; pendingUsage?: { toolCalls: number; costYen: number | null } } = {}): InspectionResult & {
  budgetCheckpoint: { operation: 'update' | 'reflect'; exhausted: boolean; accountingUnavailable: boolean; elapsedMs: number; previousStopReason: string | null };
} {
  const settings = parse(z.strictObject({ operation: z.enum(['update', 'reflect']).default('update'), now: z.union([z.date(), z.number().finite()]).optional(), pendingUsage: z.strictObject({ toolCalls: z.number().int().nonnegative(), costYen: z.number().finite().nonnegative().nullable() }).optional() }), options, 'invalid_input');
  const original = validateState(input);
  const timestamp = settings.now instanceof Date ? settings.now.getTime() : settings.now ?? Date.now();
  requireCondition(Number.isFinite(timestamp), 'invalid_input', 'Invalid clock value');
  const measured = structuredClone(original);
  measured.usage.elapsedMs = elapsed(original, timestamp);
  const budget = original.task.budget;
  const pending = settings.pendingUsage ?? { toolCalls: 0, costYen: 0 };
  const combinedCost = sumKnown(measured.usage.costYen, pending.costYen);
  const accountingUnavailable = budget.maxCostYen !== undefined && combinedCost === null;
  const exhausted = original.stopReason === 'budget_exhausted' || !generationBudgetAvailable(measured) ||
    measured.usage.toolCalls + pending.toolCalls > budget.maxToolCalls ||
    (settings.operation === 'update' && measured.usage.rounds >= budget.maxRounds) ||
    (budget.maxCostYen !== undefined && combinedCost !== null && combinedCost >= budget.maxCostYen);
  const stoppedCode = exhausted ? 'budget_exhausted' : 'budget_accounting_unavailable';
  const result: InspectionResult = (exhausted || accountingUnavailable) && (original.decision !== 'blocked' || original.usage.elapsedMs !== measured.usage.elapsedMs || !original.stopReason)
    ? stopped(original, measured.usage, stoppedCode)
    : { state: original, changes: [], nextProbeIds: [], userQuestions: [] };
  if (exhausted || accountingUnavailable) result.state.stopReason = original.stopReason ?? stoppedCode;
  return { ...result, budgetCheckpoint: { operation: settings.operation, exhausted, accountingUnavailable, elapsedMs: measured.usage.elapsedMs, previousStopReason: original.stopReason } };
}

async function timed<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TomboError('model_timeout', 'Generation exceeded remaining elapsed budget')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function createTombo(options: { adapter: GenerationAdapter; now?: () => Date | number; maxModelRepairAttempts?: number; captureProposalRejection?: boolean }): Tombo {
  requireCondition(options.adapter && typeof options.adapter.generate === 'function', 'invalid_input', 'Explicit generation adapter required');
  requireCondition(options.captureProposalRejection === undefined || typeof options.captureProposalRejection === 'boolean', 'invalid_input', 'captureProposalRejection must be a boolean');
  const maxRepairs = options.maxModelRepairAttempts === undefined ? 0 : options.maxModelRepairAttempts;
  requireCondition(Number.isInteger(maxRepairs) && maxRepairs >= 0 && maxRepairs <= 2, 'invalid_input', 'maxModelRepairAttempts must be an integer from 0 to 2');
  const terminalRejections = new WeakMap<TomboError, RejectionDetail & Pick<LastProposalRejection, 'operation' | 'rejectedAttempt' | 'maxAttempts'>>();
  function captureRejection(result: InspectionResult, error: TomboError, operation: 'update' | 'reflect', callsBefore: number): InspectionResult {
    const rejection = terminalRejections.get(error);
    if (!rejection || rejection.operation !== operation || result.state.usage.modelCalls <= callsBefore || result.state.stopReason !== 'invalid_model_output') return result;
    const { target, ...details } = rejection;
    const knownTarget = target && rejectionTargetExists(result.state, target);
    const safeTarget = knownTarget && target.id.length > 0 && target.id.length <= 200 && !target.id.startsWith('task:') && !/[\s\x00-\x1f\x7f]/u.test(target.id) ? target : undefined;
    result.state.lastProposalRejection = { ...details, ...(target && !knownTarget ? { kind: 'proposal_validation_failed' } : {}), ...(safeTarget ? { target: safeTarget } : {}), code: 'invalid_model_output', taskId: result.state.taskId, atRevision: result.state.revision, understandingHash: understandingHash(result.state) };
    result.state = validateState(result.state);
    return result;
  }
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
      requireCondition(generationBudgetAvailable(state), 'budget_exhausted', 'Generation budget exhausted');
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
      let validationPhase = false;
      try {
        const output = await generate(state, feedback ? { ...input, validationFeedback: feedback } : input, adapter, schema);
        validationPhase = true;
        const candidate = structuredClone(state);
        delete candidate.lastProposalRejection;
        apply(candidate, output);
        return candidate;
      } catch (error) {
        if (error instanceof TomboError) terminalRejections.delete(error);
        const rejected = error instanceof TomboError && error.code === 'invalid_model_output' && state.usage.modelCalls > callsBeforeAttempt;
        const remember = () => {
          if (rejected && options.captureProposalRejection && input.operation !== 'inspect') terminalRejections.set(error, { ...(validationPhase ? proposalGuardDetails.get(error) : undefined) ?? { kind: 'proposal_validation_failed' }, operation: input.operation, rejectedAttempt: attempt, maxAttempts: maxRepairs + 1 });
        };
        if (!maxRepairs || !rejected) { remember(); throw error; }
        feedback = { code: error.code, message: error.message.slice(0, 512) || 'Invalid model output', rejectedAttempt: attempt, maxAttempts: maxRepairs + 1 };
        state.modelRepairDiagnostics ??= [];
        state.modelRepairDiagnostics.push({ operation: input.operation, ...feedback });
        requireCondition(state.usage.elapsedMs < state.task.budget.maxElapsedMs, 'budget_exhausted', 'Generation elapsed budget exhausted');
        if (state.task.budget.maxCostYen !== undefined) requireCondition(state.usage.costYen !== null, 'budget_accounting_unavailable', 'Monetary usage unavailable after rejected model output');
        if (attempt > maxRepairs) { remember(); throw error; }
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
          (candidate, output) => applyProposal(candidate, output.proposal, 'inspect'));
        candidate.revision = 1;
        recordPolicyOutcome(original, candidate, 'progress');
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
        const reflectionInput: ReflectionInput = { operation: 'reflect', task: state.task, state: structuredClone(original), binding, assessmentReferences: assessmentReferences(original),
          maxOutputTokens: state.task.budget.maxOutputTokensPerCall };
        const candidate = await propose(state, reflectionInput, {
          generate: value => critic.reflect(value),
          ...(critic.estimateMaxCostYen ? { estimateMaxCostYen: (value: ReflectionInput) => critic.estimateMaxCostYen!(value) } : {}),
        }, reflectionOutputSchema, (candidate, output) => {
          proposalGuard(canonical(output.binding) === canonical(binding), 'Reflection binding does not match current understanding', { kind: 'reflection_binding_mismatch' });
          const knownClaims = output.reviewedClaimIds.every(id => original.claims.some(claim => claim.id === id));
          const missingClaim = original.claims.find(claim => !output.reviewedClaimIds.includes(claim.id));
          proposalGuard(knownClaims &&
            (output.completion !== 'completed' || original.claims.every(claim => output.reviewedClaimIds.includes(claim.id))),
            'Reflection claim coverage does not match current claims', { kind: 'reflection_claim_coverage_mismatch', ...(knownClaims && output.completion === 'completed' && missingClaim ? { target: { kind: 'claim', id: missingClaim.id } } : {}) });
          applyProposal(candidate, output.proposal, 'reflect');
          candidate.reflection = { binding: output.binding, reviewedClaimIds: output.reviewedClaimIds, completion: output.completion, limitations: output.limitations };
        });
        candidate.revision = original.revision + 1;
        const changes = changesBetween(original, candidate, 'Reflection proposed additional checks');
        if (changes.length || candidate.probes.some(probe => !original.probes.some(old => old.id === probe.id))) reopenExhaustedProbes(candidate);
        if (candidate.reflection!.completion === 'inconclusive') {
          delete candidate.reflectionEffects;
          recordPolicyOutcome(original, candidate, null);
          candidate.decision = 'blocked'; candidate.stopReason = 'reflection_inconclusive';
          return { state: parse(stateSchema, candidate, 'invalid_input'), changes, nextProbeIds: [], userQuestions: [] };
        }
        candidate.reflectionEffects = {
          binding: structuredClone(candidate.reflection!.binding), appliedRevision: candidate.revision,
          addedGoalGapIds: candidate.gaps.filter(gap => !original.gaps.some(old => old.id === gap.id) && gap.importance === 'required' && gap.triggerRefs.includes('task:goal')).map(gap => gap.id),
          addedLensIds: candidate.lenses.filter(lens => !original.lenses.some(old => old.id === lens.id) && lens.origin === 'proposed' && lens.status !== 'retired').map(lens => lens.id),
        };
        recordPolicyOutcome(original, candidate, changes.length > 0 || reflectionFresh(candidate) ? 'progress' : 'no_result');
        return result(candidate, changes);
      } catch (error) {
        if (error instanceof TomboError) return captureRejection(stopped(original, state.usage, error.code, original.appliedExecutions, state.modelRepairDiagnostics), error, 'reflect', original.usage.modelCalls);
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
          state.appliedExecutions.push({ executionId: observation.executionId, payloadHash: deliveries.get(observation.executionId)!, probeId: observation.probeId, outcome: observation.outcome,
            ...(observation.staticSnapshot ? { staticSnapshot: { id: observation.staticSnapshot, evidenceIds: observation.evidence.map(item => item.id) } } : {}) });
          const probe = state.probes.find(item => item.id === observation.probeId)!;
          probe.status = observation.outcome === 'completed' ? 'complete' : observation.outcome === 'no_result' ? 'pending' : observation.outcome;
          for (const gapId of probe.gapIds) {
            const gap = state.gaps.find(item => item.id === gapId)!;
            if (gap.status !== 'resolved') gap.status = observation.outcome === 'unavailable' || observation.outcome === 'error' ? 'blocked' : 'open';
          }
        }
        checkState(state, 'invalid_input', true, false);
        state.pendingAssessmentExecutionIds = assessmentObservations.map(item => item.executionId);
        state.decision = 'blocked';
        if (!mode.deferAssessment) state.usage.rounds++;
        state.usage.toolCalls += newTools;
        state.usage.elapsedMs = Math.max(original.usage.elapsedMs + toolTime, state.usage.elapsedMs);
        for (const observation of unique) state.usage.costYen = sumKnown(state.usage.costYen, observation.costYen);
        validatedObservations = structuredClone(state);
        if (mode.deferAssessment) {
          const deferred = stopped(state, state.usage, 'assessment_pending');
          recordPolicyOutcome(original, deferred.state, 'deferred');
          return deferred;
        }
        requireCondition(state.usage.modelCalls < budget.maxModelCalls && state.usage.rounds <= budget.maxRounds &&
          state.usage.toolCalls <= budget.maxToolCalls && state.usage.elapsedMs < budget.maxElapsedMs && budget.maxOutputTokensPerCall > 0,
          'budget_exhausted', 'Update or observed tool budget exhausted');
        if (budget.maxCostYen !== undefined) {
          requireCondition(state.usage.costYen !== null, 'budget_accounting_unavailable', 'Tool monetary usage unavailable');
          requireCondition(state.usage.costYen <= budget.maxCostYen, 'budget_exhausted', 'Tool monetary cap exceeded');
        }
        requireCondition(!state.evidence.some(item => item.validity === 'current' && item.passageUnavailable), 'passage_unavailable', 'Reacquire current evidence passages before generation');
        const beforeProposal = structuredClone(state);
        const candidate = await propose(state, { operation: 'update', task: state.task, state: beforeProposal, assessmentReferences: assessmentReferences(beforeProposal), observations: assessmentObservations }, options.adapter, generationOutputSchema, (candidate, output) => {
          for (const resolution of output.proposal.resolutions ?? []) {
            const gap = state.gaps.find(item => item.id === resolution.gapId);
            const observationsForGap = assessmentObservations.filter(observation => gap?.probeIds.includes(observation.probeId));
            proposalGuard(!observationsForGap.length || observationsForGap.some(observation => observation.outcome === 'completed' && observation.evidence.length > 0), 'Unsuccessful probe outcome cannot resolve a gap', { kind: 'resolution_not_justified', ...(gap ? { target: { kind: 'gap', id: gap.id } } : {}) });
          }
          applyProposal(candidate, output.proposal, 'update');
          delete candidate.pendingAssessmentExecutionIds;
        });
        state = candidate;
        state.revision = original.revision + 1;
        const changes = changesBetween(original, state, 'Evidence assessment proposal');
        const batchIds = new Set(assessmentObservations.map(item => item.executionId));
        const repeated = new Set(assessmentObservations.filter(item => repeatedSnapshot(original, item, batchIds)).map(item => item.executionId));
        const hasNewEvidence = assessmentObservations.some(observation => observation.staticSnapshot ? !repeated.has(observation.executionId) :
          observation.evidence.some(item => !original.evidence.some(old => old.id === item.id)));
        const hasCorrection = (state.assessmentCorrections?.length ?? 0) > (original.assessmentCorrections?.length ?? 0);
        const hasNewProbe = state.probes.some(probe => !original.probes.some(old => old.id === probe.id));
        const progress = hasNewEvidence || hasCorrection || changes.length > 0 || hasNewProbe;
        if (progress) reopenExhaustedProbes(state);
        else if (repeated.size) {
          for (const observation of assessmentObservations) if (repeated.has(observation.executionId) || observation.outcome === 'no_result') {
            state.probes.find(probe => probe.id === observation.probeId)!.status = 'exhausted';
          }
          const canContinue = state.probes.some(probe => availableProbe(state, probe) && probe.gapIds.some(id => state.gaps.some(gap => gap.id === id && gap.importance === 'required' && gap.status !== 'resolved')));
          if (!canContinue) state.stopReason = 'no_progress';
        } else state.stopReason = assessmentObservations.some(item => item.outcome === 'unavailable' || item.outcome === 'error') ? 'capability_limit' : 'no_progress';
        if (understandingHash(original) !== understandingHash(state)) delete state.reflectionEffects;
        recordPolicyOutcome(original, state, progress ? 'progress' : assessmentObservations.some(item => item.outcome === 'error') ? 'error' :
          assessmentObservations.some(item => item.outcome === 'unavailable') ? 'unavailable' : 'no_result');
        return result(state, changes);
      } catch (error) {
        if (error instanceof TomboError) return captureRejection(stopped(validatedObservations ?? original, state.usage, error.code, validatedObservations?.appliedExecutions ?? original.appliedExecutions, state.modelRepairDiagnostics), error, 'update', original.usage.modelCalls);
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
      reopenExhaustedProbes(state);
      recompute(state);
      const pendingProbes = new Set(state.appliedExecutions.filter(item => state.pendingAssessmentExecutionIds?.includes(item.executionId)).map(item => item.probeId));
      delete state.pendingAssessmentExecutionIds;
      for (const probe of state.probes) if (pendingProbes.has(probe.id) && probe.status === 'complete' &&
        probe.gapIds.some(id => state.gaps.find(gap => gap.id === id)!.status !== 'resolved')) probe.status = 'pending';
      state.revision++;
      if (understandingHash(original) !== understandingHash(state)) delete state.reflectionEffects;
      recordPolicyOutcome(original, state, 'progress');
      checkState(state, 'invalid_input');
      return result(state, changesBetween(original, state, request.reason));
    },
  };
}
