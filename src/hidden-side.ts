import { createHash } from 'node:crypto';

export type HiddenSideMethod = 'similarity' | 'orthogonal' | 'reflected_view' | 'random_baseline';

export interface HiddenSideCandidateInput {
  id: string;
  concept: string;
  vector: number[];
  source: string | null;
}

export interface HiddenSideInput {
  inputContext: string;
  viewpoint: string;
  embeddingModel: string | null;
  contextVectors: number[][];
  viewpointVector: number[];
  candidates: HiddenSideCandidateInput[];
}

export interface HiddenSideCandidateResult {
  id: string;
  concept: string;
  context_rank: number | null;
  context_score: number | null;
  baseline_rank: number | null;
  hidden_rank: number | null;
  score: number | null;
  score_type: 'cosine_similarity' | 'random_order';
  source: string | null;
  interpretation: string | null;
  verification_status: 'unverified';
}

export interface HiddenSideMethodResult {
  method: HiddenSideMethod;
  viewpoint: 'current_context' | 'orthogonal_residual' | 'reflected_view' | 'random';
  candidates: HiddenSideCandidateResult[];
}

export interface HiddenSideComparison {
  method: Exclude<HiddenSideMethod, 'similarity'>;
  baseline_method: 'similarity';
  baseline_top_k: string[];
  method_top_k: string[];
  intersection_count: number;
  overlap_ratio: number;
  candidates: Array<{
    id: string;
    baseline_scored: boolean;
    baseline_rank: number | null;
    method_rank: number | null;
    rank_gain: number | null;
    entered_top_k: boolean;
  }>;
}

export interface HiddenSideObservation {
  schema_version: 'hidden-side-observation/1';
  input_context: string;
  viewpoint: string;
  embedding_model: string | null;
  dimension: number;
  context_surface_rank: number;
  context_aggregation: 'equal_weight_mean_of_unit_vectors';
  projection_norm: number | null;
  orthogonal_residual_norm: number | null;
  reflected_vector_norm: number | null;
  context_digest: string;
  top_k: number;
  random_seed: number;
  methods: HiddenSideMethodResult[];
  comparisons: HiddenSideComparison[];
  limitations: string[];
}

export class HiddenSideError extends Error {
  constructor(public readonly code: 'invalid_input' | 'dimension_mismatch' | 'zero_viewpoint' | 'zero_context' | 'zero_orthogonal_component') {
    super(code);
    this.name = 'HiddenSideError';
  }
}

const DEFAULT_TOLERANCE = 1e-10;
const DEFAULT_METHODS: HiddenSideMethod[] = ['similarity', 'orthogonal', 'reflected_view', 'random_baseline'];

function assertVector(vector: number[], dimension?: number): number {
  if (!Array.isArray(vector) || vector.length === 0 || vector.some(value => !Number.isFinite(value))) throw new HiddenSideError('invalid_input');
  if (dimension !== undefined && vector.length !== dimension) throw new HiddenSideError('dimension_mismatch');
  if (!Number.isFinite(norm(vector))) throw new HiddenSideError('invalid_input');
  return vector.length;
}

function dot(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i]! * b[i]!;
  return total;
}

function norm(vector: number[]): number {
  let magnitude = 0;
  let sum = 1;
  for (const value of vector) {
    const absolute = Math.abs(value);
    if (absolute === 0) continue;
    if (magnitude < absolute) {
      sum = 1 + sum * (magnitude / absolute) ** 2;
      magnitude = absolute;
    } else sum += (absolute / magnitude) ** 2;
  }
  return magnitude === 0 ? 0 : magnitude * Math.sqrt(sum);
}

function scale(vector: number[], factor: number): number[] {
  return vector.map(value => value * factor);
}

function unit(vector: number[]): number[] | null {
  let maximum = 0;
  for (const value of vector) maximum = Math.max(maximum, Math.abs(value));
  if (maximum === 0) return null;
  const reduced = vector.map(value => value / maximum);
  const reducedNorm = Math.sqrt(dot(reduced, reduced));
  return reduced.map(value => value / reducedNorm);
}

function subtract(a: number[], b: number[]): number[] {
  return a.map((value, index) => value - b[index]!);
}

function cosine(a: number[], b: number[]): number | null {
  const aUnit = unit(a);
  const bUnit = unit(b);
  if (!aUnit || !bUnit) return null;
  const score = dot(aUnit, bUnit);
  return Math.max(-1, Math.min(1, score));
}

function buildBasis(rows: number[][], dimension: number, tolerance: number): number[][] {
  const basis: number[][] = [];
  for (const row of rows) {
    assertVector(row, dimension);
    const rowUnit = unit(row);
    if (!rowUnit) continue;
    let residual = rowUnit;
    // Re-orthogonalised modified Gram-Schmidt is stable for these small context sets.
    for (let pass = 0; pass < 2; pass++) {
      for (const direction of basis) residual = subtract(residual, scale(direction, dot(residual, direction)));
    }
    const residualNorm = norm(residual);
    if (residualNorm > tolerance) basis.push(scale(residual, 1 / residualNorm));
  }
  return basis;
}

function project(vector: number[], basis: number[][]): number[] {
  const output = Array.from({ length: vector.length }, () => 0);
  for (const direction of basis) {
    const coefficient = dot(vector, direction);
    for (let i = 0; i < output.length; i++) output[i] += coefficient * direction[i]!;
  }
  return output;
}

function seededCandidateOrder(seed: number, id: string): number {
  const digest = createHash('sha256').update(`${seed}:${id}`).digest();
  return digest.readUIntBE(0, 6) / 0x1_0000_0000_0000;
}

function rankOrder(candidates: HiddenSideCandidateInput[], query: number[] | null, randomSeed: number | null) {
  const scored = candidates.map(candidate => ({
    candidate,
    score: query ? cosine(query, candidate.vector) : null,
    tie: randomSeed === null ? 0 : seededCandidateOrder(randomSeed, candidate.id),
  }));
  scored.sort((a, b) => {
    const idOrder = a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
    if (randomSeed !== null) return a.tie - b.tie || idOrder;
    if (a.score === null || b.score === null) return a.score === b.score ? idOrder : a.score === null ? 1 : -1;
    return b.score - a.score || idOrder;
  });
  return scored;
}

/** Compare ranked retrieval directions over one caller-supplied, same-model vector set. */
export function compareHiddenSideMethods(
  input: HiddenSideInput,
  options: { topK?: number; randomSeed?: number; methods?: HiddenSideMethod[]; tolerance?: number } = {},
): HiddenSideObservation {
  if (options === null || typeof options !== 'object') throw new HiddenSideError('invalid_input');
  if (!input || typeof input.inputContext !== 'string' || !input.inputContext.trim() || typeof input.viewpoint !== 'string' || !input.viewpoint.trim() ||
    !Array.isArray(input.contextVectors) || !Array.isArray(input.candidates) || input.candidates.length === 0 ||
    (typeof input.embeddingModel !== 'string' && input.embeddingModel !== null) || (typeof input.embeddingModel === 'string' && !input.embeddingModel.trim())) throw new HiddenSideError('invalid_input');

  const dimension = assertVector(input.viewpointVector);
  for (const vector of input.contextVectors) assertVector(vector, dimension);
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate || typeof candidate !== 'object') throw new HiddenSideError('invalid_input');
    if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.concept !== 'string' || !candidate.concept ||
      (typeof candidate.source !== 'string' && candidate.source !== null) || ids.has(candidate.id)) throw new HiddenSideError('invalid_input');
    ids.add(candidate.id);
    assertVector(candidate.vector, dimension);
  }
  const topK = options.topK ?? 10;
  const randomSeed = options.randomSeed ?? 1;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const methods = options.methods ?? DEFAULT_METHODS;
  if ((options.methods !== undefined && !Array.isArray(options.methods)) ||
    !Number.isSafeInteger(topK) || topK < 1 || !Number.isSafeInteger(randomSeed) || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 1 ||
    new Set(methods).size !== methods.length || methods.length === 0 || methods.some(method => !DEFAULT_METHODS.includes(method))) {
    throw new HiddenSideError('invalid_input');
  }

  const viewpoint = unit(input.viewpointVector);
  if (!viewpoint) throw new HiddenSideError('zero_viewpoint');
  const basis = buildBasis(input.contextVectors, dimension, tolerance);
  if (basis.length === 0 && methods.some(method => method === 'orthogonal' || method === 'reflected_view')) throw new HiddenSideError('zero_context');
  const projected = project(viewpoint, basis);
  const residual = subtract(viewpoint, projected);
  const residualNorm = norm(residual);
  if (methods.includes('orthogonal') && residualNorm <= tolerance) throw new HiddenSideError('zero_orthogonal_component');
  const reflected = subtract(projected, residual);
  const baseline = rankOrder(input.candidates, viewpoint, null);
  const baselineRanks = new Map(baseline.map((item, index) => [item.candidate.id, item.score === null ? null : index + 1]));
  const contextCentroid = Array.from({ length: dimension }, () => 0);
  let contextVectorCount = 0;
  for (const vector of input.contextVectors) {
    const vectorUnit = unit(vector);
    if (!vectorUnit) continue;
    contextVectorCount++;
    for (let index = 0; index < dimension; index++) contextCentroid[index] += vectorUnit[index]!;
  }
  if (contextVectorCount) for (let index = 0; index < dimension; index++) contextCentroid[index] /= contextVectorCount;
  if (norm(contextCentroid) <= tolerance) contextCentroid.fill(0);
  const contextRanking = rankOrder(input.candidates, contextCentroid, null);
  const contextRanks = new Map(contextRanking.map((item, index) => [item.candidate.id, item.score === null ? null : index + 1]));
  const contextScores = new Map(contextRanking.map(item => [item.candidate.id, item.score]));
  const queryFor: Record<HiddenSideMethod, number[] | null> = {
    similarity: viewpoint,
    orthogonal: residualNorm <= tolerance ? null : residual,
    reflected_view: reflected,
    random_baseline: null,
  };
  const viewpointFor: Record<HiddenSideMethod, HiddenSideMethodResult['viewpoint']> = {
    similarity: 'current_context', orthogonal: 'orthogonal_residual', reflected_view: 'reflected_view', random_baseline: 'random',
  };
  const ordered = new Map<HiddenSideMethod, ReturnType<typeof rankOrder>>();
  const results = methods.map(method => {
    const ranking = rankOrder(input.candidates, queryFor[method], method === 'random_baseline' ? randomSeed : null);
    ordered.set(method, ranking);
    return {
      method,
      viewpoint: viewpointFor[method],
      candidates: ranking.slice(0, topK).map((item, index) => ({
        id: item.candidate.id,
        concept: item.candidate.concept,
        context_rank: contextRanks.get(item.candidate.id) ?? null,
        context_score: contextScores.get(item.candidate.id) ?? null,
        baseline_rank: baselineRanks.get(item.candidate.id) ?? null,
        hidden_rank: method === 'random_baseline' || item.score !== null ? index + 1 : null,
        score: item.score,
        score_type: method === 'random_baseline' ? 'random_order' as const : 'cosine_similarity' as const,
        source: item.candidate.source,
        interpretation: null,
        verification_status: 'unverified' as const,
      })),
    };
  });

  const baselineTop = baseline.filter(item => item.score !== null).slice(0, topK).map(item => item.candidate.id);
  const comparisons = methods.filter(method => method !== 'similarity').map(method => {
    const ranking = ordered.get(method)!;
    const rankedForTopK = method === 'random_baseline' ? ranking.slice(0, topK) : ranking.filter(item => item.score !== null).slice(0, topK);
    const methodTop = rankedForTopK.map(item => item.candidate.id);
    const methodRank = new Map(ranking.map((item, index) => [item.candidate.id,
      method === 'random_baseline' || item.score !== null ? index + 1 : null]));
    const baselineSet = new Set(baselineTop);
    const intersectionCount = methodTop.filter(id => baselineSet.has(id)).length;
    const denominator = Math.min(topK, baselineTop.length, methodTop.length);
    return {
      method,
      baseline_method: 'similarity' as const,
      baseline_top_k: baselineTop,
      method_top_k: methodTop,
      intersection_count: intersectionCount,
      overlap_ratio: denominator === 0 ? 0 : intersectionCount / denominator,
      candidates: rankedForTopK.map(item => {
        const baselineRank = baselineRanks.get(item.candidate.id) ?? null;
        const hiddenRank = methodRank.get(item.candidate.id) ?? null;
        return { id: item.candidate.id, baseline_scored: baselineRank !== null, baseline_rank: baselineRank, method_rank: hiddenRank,
          rank_gain: baselineRank === null || hiddenRank === null ? null : baselineRank - hiddenRank,
          entered_top_k: !baselineSet.has(item.candidate.id) };
      }),
    };
  });

  const contextDigest = createHash('sha256').update(JSON.stringify({ inputContext: input.inputContext, viewpoint: input.viewpoint,
    embeddingModel: input.embeddingModel, contextVectors: input.contextVectors, viewpointVector: input.viewpointVector })).digest('hex');
  return {
    schema_version: 'hidden-side-observation/1', input_context: input.inputContext, viewpoint: input.viewpoint,
    embedding_model: input.embeddingModel, dimension, context_surface_rank: basis.length,
    context_aggregation: 'equal_weight_mean_of_unit_vectors',
    projection_norm: basis.length ? norm(projected) : null,
    orthogonal_residual_norm: basis.length ? residualNorm : null,
    reflected_vector_norm: basis.length ? norm(reflected) : null,
    context_digest: contextDigest,
    top_k: topK, random_seed: randomSeed, methods: results, comparisons,
    limitations: [
      'A rank change is retrieval behaviour, not proof of a hidden fact or useful discovery.',
      'Candidate meaning, source quality and verification remain unverified until checked independently.',
      'All vectors must come from the same embedding model and version; this function does not create embeddings or search an external corpus.',
      'Random baseline is a deterministic random ordering, not a diversity-optimising baseline.',
    ],
  };
}
