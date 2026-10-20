import { z } from 'zod';

const id = z.string().min(1).max(200).refine(value => !value.startsWith('task:'), 'Reserved task reference');
const text = z.string().min(1);
const count = z.number().int().nonnegative();
const amount = z.number().finite().nonnegative();
const ids = z.array(id).refine(values => new Set(values).size === values.length, 'Duplicate references');
export const budgetSchema = z.strictObject({
  maxRounds: count, maxModelCalls: count, maxToolCalls: count, maxElapsedMs: count,
  maxInputChars: count, maxOutputTokensPerCall: count, maxCostYen: amount.optional(),
});
export const usageSchema = z.strictObject({
  rounds: count, modelCalls: count, toolCalls: count, elapsedMs: amount,
  totalTokens: count.nullable(), costYen: amount.nullable(),
});
export const evidenceSchema = z.strictObject({
  id, kind: z.enum(['document', 'code', 'test', 'user_statement']),
  locator: text, sourceGroup: text, retrievedAt: z.iso.datetime({ offset: true }),
  version: text.nullable(), scope: text, passage: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  validity: z.enum(['current', 'withdrawn', 'superseded']),
  passageUnavailable: z.literal(true).optional(),
}).superRefine((value, ctx) => {
  if (value.passageUnavailable && value.passage !== '') ctx.addIssue({ code: 'custom', message: 'Unavailable passage must be empty' });
});
export const assessmentSchema = z.strictObject({
  claimId: id, evidenceIds: ids.min(1), verdict: z.enum(['supports', 'refutes', 'inconclusive']),
  scopeMatched: z.boolean(), reason: text,
});
export const assessmentCorrectionSchema = z.strictObject({
  claimId: id, targetDigest: z.string().regex(/^[a-f0-9]{64}$/), replacementDigest: z.string().regex(/^[a-f0-9]{64}$/),
  groundingEvidenceIds: ids.min(1), reason: text,
});
export const assessmentCorrectionProposalSchema = assessmentCorrectionSchema.omit({ replacementDigest: true }).extend({
  replacement: assessmentSchema,
});
export interface AssessmentReference {
  claimId: string;
  assessmentIndex: number;
  digest: string;
}
export interface AssessmentScopeDiagnostic extends AssessmentReference {
  evidenceId: string;
  claimScope: string;
  evidenceScope: string;
  kind: 'assessment_scope_unmatched' | 'evidence_scope_mismatch';
  reason: string;
  passageUnavailable: boolean;
}
export const claimDefinitionSchema = z.strictObject({
  id, role: z.enum(['observation', 'assumption', 'hypothesis', 'answer_claim']), text, scope: text,
});
export const claimSchema = claimDefinitionSchema.extend({
  status: z.enum(['unverified', 'supported', 'contradicted', 'disputed']),
  assessments: z.array(assessmentSchema),
});
export const lensSchema = z.strictObject({
  id, label: text, rationale: text, origin: z.enum(['initial', 'proposed']),
  status: z.enum(['candidate', 'active', 'retired']),
});
export const resolutionSchema = z.strictObject({
  reason: z.enum(['supported', 'refuted', 'not_applicable']), evidenceIds: ids.min(1), explanation: text,
});
export const gapDefinitionSchema = z.strictObject({
  id, kind: z.enum(['missing_fact', 'ambiguous_intent', 'unsupported_claim', 'conflicting_evidence', 'unexplored_view', 'capability_limit']),
  lensId: id, question: text, triggerRefs: z.array(text).min(1), whyItMatters: text,
  importance: z.enum(['required', 'optional']), claimIds: ids, probeIds: ids,
  humanRole: z.enum(['goal', 'priority', 'value', 'permission']).optional(),
}).refine(value => value.humanRole === undefined || value.kind === 'ambiguous_intent', 'Human role requires ambiguous intent');
export const humanRoleSchema = gapDefinitionSchema.shape.humanRole;
export const gapSchema = gapDefinitionSchema.safeExtend({
  status: z.enum(['open', 'checking', 'resolved', 'blocked']), resolution: resolutionSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.status === 'resolved') !== (value.resolution !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only resolved gaps require resolution' });
});
export const probeDefinitionSchema = z.strictObject({
  id, gapIds: ids.min(1), method: z.enum(['example', 'counterexample', 'boundary', 'dependency', 'corroboration', 'reconstruction']),
  question: text, requiredCapability: text, sourceGroups: z.array(text),
  successCondition: text, refutationCondition: text, inconclusiveCondition: text,
});
export const probeSchema = probeDefinitionSchema.extend({ status: z.enum(['pending', 'running', 'complete', 'unavailable', 'error', 'exhausted']) });
export const taskPacketSchema = z.strictObject({
  schemaVersion: z.literal('0.1'), taskId: id, goal: text, mode: z.enum(['explain', 'execute']),
  successCriteria: z.array(text).min(1), evidence: z.array(evidenceSchema),
  reflectionRequired: z.literal(true).optional(), proposedAnswer: text.optional(), proposedActions: z.array(text).optional(), capabilities: z.array(text), budget: budgetSchema,
});
export const observationSchema = z.strictObject({
  executionId: id, probeId: id, outcome: z.enum(['completed', 'no_result', 'unavailable', 'error']),
  evidence: z.array(evidenceSchema), toolCalls: count, elapsedMs: amount, costYen: amount.nullable(),
  staticSnapshot: text.optional(),
}).superRefine((value, ctx) => {
  if (value.staticSnapshot !== undefined && (value.outcome !== 'completed' || !value.evidence.length)) ctx.addIssue({ code: 'custom', message: 'A static snapshot requires completed evidence' });
});
export const observationsSchema = z.array(observationSchema);
export const appliedExecutionSchema = z.strictObject({
  executionId: id, payloadHash: z.string().regex(/^[a-f0-9]{64}$/), probeId: id,
  outcome: z.enum(['completed', 'no_result', 'unavailable', 'error']),
  staticSnapshot: z.strictObject({ id: text, evidenceIds: ids.min(1) }).optional(),
});
export const reflectionBindingSchema = z.strictObject({
  taskId: id, basedRevision: count, understandingHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const reflectionReceiptSchema = z.strictObject({
  binding: reflectionBindingSchema, reviewedClaimIds: ids, completion: z.enum(['completed', 'inconclusive']), limitations: z.array(text),
});
export const policyOutcomeSchema = z.enum(['progress', 'no_result', 'unavailable', 'error', 'deferred', 'invalid_output']);
export const policyHistorySchema = z.strictObject({
  consecutiveNoProgressRounds: count,
  lastUnderstandingHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recentOutcomes: z.array(policyOutcomeSchema).max(10), lastProgressAtRevision: count,
});
export const reflectionEffectsSchema = z.strictObject({
  binding: reflectionBindingSchema, appliedRevision: count, addedGoalGapIds: ids, addedLensIds: ids,
});
export const decisionSchema = z.enum(['ready_for_requested_step', 'needs_reflection', 'needs_check', 'needs_user_input', 'blocked']);
export const modelValidationFeedbackSchema = z.strictObject({
  code: z.literal('invalid_model_output'), message: text.max(512),
  rejectedAttempt: z.number().int().min(1).max(3), maxAttempts: z.number().int().min(1).max(3),
}).refine(value => value.rejectedAttempt <= value.maxAttempts, 'Rejected attempt exceeds attempt limit');
export const modelRepairDiagnosticSchema = modelValidationFeedbackSchema.extend({
  operation: z.enum(['inspect', 'update', 'reflect']),
});
export const proposalRejectionTargetSchema = z.strictObject({
  kind: z.enum(['gap', 'claim', 'probe', 'lens']),
  id: id.refine(value => !/[\s\x00-\x1f\x7f]/u.test(value), 'Unsafe diagnostic target'),
});
export const lastProposalRejectionSchema = z.strictObject({
  operation: z.enum(['update', 'reflect']), taskId: id, atRevision: count,
  understandingHash: z.string().regex(/^[a-f0-9]{64}$/), code: z.literal('invalid_model_output'),
  kind: z.enum(['resolution_not_justified', 'reflection_binding_mismatch', 'reflection_claim_coverage_mismatch', 'proposal_validation_failed']),
  target: proposalRejectionTargetSchema.optional(),
  rejectedAttempt: z.number().int().min(1).max(3), maxAttempts: z.number().int().min(1).max(3),
}).refine(value => value.rejectedAttempt <= value.maxAttempts, 'Rejected attempt exceeds attempt limit');
export const stateSchema = z.strictObject({
  schemaVersion: z.literal('0.1'), taskId: id, revision: count, startedAt: z.iso.datetime({ offset: true }),
  task: taskPacketSchema, evidence: z.array(evidenceSchema), claims: z.array(claimSchema), lenses: z.array(lensSchema),
  gaps: z.array(gapSchema), probes: z.array(probeSchema), usage: usageSchema, decision: decisionSchema,
  stopReason: text.nullable(), appliedExecutions: z.array(appliedExecutionSchema),
  modelRepairDiagnostics: z.array(modelRepairDiagnosticSchema).optional(),
  lastProposalRejection: lastProposalRejectionSchema.optional(),
  assessmentCorrections: z.array(assessmentCorrectionSchema).optional(),
  pendingAssessmentExecutionIds: ids.min(1).optional(), reflection: reflectionReceiptSchema.optional(),
  policyHistory: policyHistorySchema.optional(), reflectionEffects: reflectionEffectsSchema.optional(),
  excludedCandidates: z.array(z.strictObject({ id, reason: text, importance: z.enum(['required', 'optional']) })).optional(),
});
export const proposalSchema = z.strictObject({
  claims: z.array(claimDefinitionSchema).optional(), lenses: z.array(lensSchema).optional(),
  gaps: z.array(gapDefinitionSchema).optional(), probes: z.array(probeDefinitionSchema).optional(),
  assessments: z.array(assessmentSchema).optional(),
  assessmentCorrections: z.array(assessmentCorrectionProposalSchema).optional(),
  resolutions: z.array(resolutionSchema.extend({ gapId: id })).optional(),
});
export const generationOutputSchema = z.strictObject({
  proposal: proposalSchema, usage: z.strictObject({ totalTokens: count.nullable(), costYen: amount.nullable(), outputTokens: count.optional() }).optional(),
  model: text.optional(),
});
export const reflectionProposalSchema = z.strictObject({
  lenses: z.array(lensSchema).optional(), gaps: z.array(gapDefinitionSchema).optional(), probes: z.array(probeDefinitionSchema).optional(),
});
export const reflectionOutputSchema = reflectionReceiptSchema.extend({
  proposal: reflectionProposalSchema, usage: generationOutputSchema.shape.usage, model: text.optional(),
});
export const changeSchema = z.strictObject({
  kind: z.enum(['claim_changed', 'gap_changed', 'lens_changed']), targetId: id,
  before: z.string(), after: z.string(), evidenceIds: ids, reason: text,
});
export const inspectionResultSchema = z.strictObject({
  state: stateSchema, changes: z.array(changeSchema), nextProbeIds: ids, userQuestions: z.array(text),
});

export type Budget = z.infer<typeof budgetSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type AssessmentCorrectionProposal = z.infer<typeof assessmentCorrectionProposalSchema>;
export type AssessmentCorrection = z.infer<typeof assessmentCorrectionSchema>;
export type Assessment = z.infer<typeof assessmentSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Lens = z.infer<typeof lensSchema>;
export type Gap = z.infer<typeof gapSchema>;
export type Probe = z.infer<typeof probeSchema>;
export type TaskPacket = z.infer<typeof taskPacketSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type UnderstandingState = z.infer<typeof stateSchema>;
export type UnderstandingChange = z.infer<typeof changeSchema>;
export type InspectionResult = z.infer<typeof inspectionResultSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type GenerationOutput = z.infer<typeof generationOutputSchema>;
export type ReflectionBinding = z.infer<typeof reflectionBindingSchema>;
export type ReflectionReceipt = z.infer<typeof reflectionReceiptSchema>;
export type PolicyHistory = z.infer<typeof policyHistorySchema>;
export type ReflectionEffects = z.infer<typeof reflectionEffectsSchema>;
export type ReflectionProposal = z.infer<typeof reflectionProposalSchema>;
export type ReflectionOutput = z.infer<typeof reflectionOutputSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type ClaimStatus = Claim['status'];
export type GapKind = Gap['kind'];
export type ProbeMethod = Probe['method'];
export type ModelValidationFeedback = z.infer<typeof modelValidationFeedbackSchema>;
export type ModelRepairDiagnostic = z.infer<typeof modelRepairDiagnosticSchema>;
export type LastProposalRejection = z.infer<typeof lastProposalRejectionSchema>;
export interface GenerationInput {
  assessmentReferences?: AssessmentReference[];
  validationFeedback?: ModelValidationFeedback;
  operation: 'inspect' | 'update';
  task: TaskPacket;
  state?: UnderstandingState;
  observations?: Observation[];
  maxOutputTokens?: number;
}
export interface GenerationAdapter {
  generate(input: GenerationInput): Promise<GenerationOutput>;
  estimateMaxCostYen?(input: GenerationInput): number | Promise<number>;
}
export interface ReflectionInput {
  assessmentReferences?: AssessmentReference[];
  validationFeedback?: ModelValidationFeedback;
  operation: 'reflect';
  task: TaskPacket;
  state: UnderstandingState;
  binding: ReflectionBinding;
  maxOutputTokens: number;
}
export interface CriticAdapter {
  reflect(input: ReflectionInput): Promise<ReflectionOutput>;
  estimateMaxCostYen?(input: ReflectionInput): number | Promise<number>;
}
export interface Tombo {
  inspect(packet: unknown): Promise<InspectionResult>;
  reflect(state: unknown, critic: CriticAdapter): Promise<InspectionResult>;
  update(state: unknown, observations: unknown, options?: { deferAssessment?: true }): Promise<InspectionResult>;
  invalidate(state: unknown, input: { evidenceIds: string[]; reason: string }): InspectionResult;
}
