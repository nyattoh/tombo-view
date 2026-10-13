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
});
export const gapSchema = gapDefinitionSchema.extend({
  status: z.enum(['open', 'checking', 'resolved', 'blocked']), resolution: resolutionSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.status === 'resolved') !== (value.resolution !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only resolved gaps require resolution' });
});
export const probeDefinitionSchema = z.strictObject({
  id, gapIds: ids.min(1), method: z.enum(['example', 'counterexample', 'boundary', 'dependency', 'corroboration', 'reconstruction']),
  question: text, requiredCapability: text, sourceGroups: z.array(text),
  successCondition: text, refutationCondition: text, inconclusiveCondition: text,
});
export const probeSchema = probeDefinitionSchema.extend({ status: z.enum(['pending', 'running', 'complete', 'unavailable', 'error']) });
export const taskPacketSchema = z.strictObject({
  schemaVersion: z.literal('0.1'), taskId: id, goal: text, mode: z.enum(['explain', 'execute']),
  successCriteria: z.array(text).min(1), evidence: z.array(evidenceSchema),
  proposedAnswer: text.optional(), proposedActions: z.array(text).optional(), capabilities: z.array(text), budget: budgetSchema,
});
export const observationSchema = z.strictObject({
  executionId: id, probeId: id, outcome: z.enum(['completed', 'no_result', 'unavailable', 'error']),
  evidence: z.array(evidenceSchema), toolCalls: count, elapsedMs: amount, costYen: amount.nullable(),
});
export const observationsSchema = z.array(observationSchema);
export const appliedExecutionSchema = z.strictObject({
  executionId: id, payloadHash: z.string().regex(/^[a-f0-9]{64}$/), probeId: id,
  outcome: z.enum(['completed', 'no_result', 'unavailable', 'error']),
});
export const decisionSchema = z.enum(['ready_for_requested_step', 'needs_check', 'needs_user_input', 'blocked']);
export const stateSchema = z.strictObject({
  schemaVersion: z.literal('0.1'), taskId: id, revision: count, startedAt: z.iso.datetime({ offset: true }),
  task: taskPacketSchema, evidence: z.array(evidenceSchema), claims: z.array(claimSchema), lenses: z.array(lensSchema),
  gaps: z.array(gapSchema), probes: z.array(probeSchema), usage: usageSchema, decision: decisionSchema,
  stopReason: text.nullable(), appliedExecutions: z.array(appliedExecutionSchema),
  pendingAssessmentExecutionIds: ids.min(1).optional(),
  excludedCandidates: z.array(z.strictObject({ id, reason: text, importance: z.enum(['required', 'optional']) })).optional(),
});
export const proposalSchema = z.strictObject({
  claims: z.array(claimDefinitionSchema).optional(), lenses: z.array(lensSchema).optional(),
  gaps: z.array(gapDefinitionSchema).optional(), probes: z.array(probeDefinitionSchema).optional(),
  assessments: z.array(assessmentSchema).optional(),
  resolutions: z.array(resolutionSchema.extend({ gapId: id })).optional(),
});
export const generationOutputSchema = z.strictObject({
  proposal: proposalSchema, usage: z.strictObject({ totalTokens: count.nullable(), costYen: amount.nullable(), outputTokens: count.optional() }).optional(),
  model: text.optional(),
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
export type Decision = z.infer<typeof decisionSchema>;
export type ClaimStatus = Claim['status'];
export type GapKind = Gap['kind'];
export type ProbeMethod = Probe['method'];
export interface GenerationInput {
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
export interface Tombo {
  inspect(packet: unknown): Promise<InspectionResult>;
  update(state: unknown, observations: unknown): Promise<InspectionResult>;
  invalidate(state: unknown, input: { evidenceIds: string[]; reason: string }): InspectionResult;
}
