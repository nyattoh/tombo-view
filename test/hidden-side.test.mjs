import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHiddenSideMethods, HiddenSideError } from '../dist/index.js';

function fixture(overrides = {}) {
  return {
    inputContext: '犬、カレー、夕暮れ、帰宅',
    viewpoint: '家庭での食事',
    embeddingModel: 'test-three-dimensional-vectors-v1',
    contextVectors: [[1, 0, 0], [2, 0, 0], [0, 0, 0]],
    viewpointVector: [1, 1, 0],
    candidates: [
      { id: 'baseline', concept: 'household meal', vector: [1, 1, 0], source: 'fixture:baseline' },
      { id: 'hidden', concept: 'orthogonal-side candidate', vector: [1, -1, 0], source: null },
      { id: 'orthogonal', concept: 'orthogonal component', vector: [0, 1, 0], source: 'fixture:orthogonal' },
      { id: 'unscored', concept: 'zero vector', vector: [0, 0, 0], source: null },
    ],
    ...overrides,
  };
}

test('builds a rank-one surface, orthogonal residual and reflected query with expected rankings', () => {
  const result = compareHiddenSideMethods(fixture(), { topK: 4, randomSeed: 7 });
  const find = method => result.methods.find(item => item.method === method);
  assert.equal(result.context_surface_rank, 1, 'a scaled duplicate and zero context row add no basis direction');
  assert.ok(Math.abs(result.projection_norm - Math.SQRT1_2) < 1e-10);
  assert.ok(Math.abs(result.orthogonal_residual_norm - Math.SQRT1_2) < 1e-10);
  assert.ok(Math.abs(result.reflected_vector_norm - 1) < 1e-10);
  assert.deepEqual(find('similarity').candidates.slice(0, 3).map(item => item.id), ['baseline', 'orthogonal', 'hidden']);
  assert.deepEqual(find('orthogonal').candidates.slice(0, 3).map(item => item.id), ['orthogonal', 'baseline', 'hidden']);
  assert.deepEqual(find('reflected_view').candidates.slice(0, 3).map(item => item.id), ['hidden', 'baseline', 'orthogonal']);
  assert.equal(find('reflected_view').candidates[0].baseline_rank, 3);
  assert.equal(find('reflected_view').candidates[0].hidden_rank, 1);
  assert.ok(Number.isInteger(find('reflected_view').candidates[0].context_rank));
  assert.ok(find('reflected_view').candidates[0].context_score !== null);
  assert.equal(find('reflected_view').candidates[0].verification_status, 'unverified');
  assert.equal(find('reflected_view').candidates[0].interpretation, null);
  assert.equal(find('random_baseline').candidates.every(item => item.score === null && item.score_type === 'random_order'), true);
  assert.equal(find('similarity').candidates.at(-1).score, null, 'cosine for a zero candidate is undefined');
  assert.equal(find('similarity').candidates.at(-1).hidden_rank, null);
  assert.equal(find('similarity').candidates.at(-1).baseline_rank, null);
  assert.equal(result.comparisons.find(item => item.method === 'random_baseline').candidates.find(item => item.id === 'unscored').baseline_scored, false);
  assert.equal(result.comparisons.find(item => item.method === 'reflected_view').overlap_ratio, 1);
  assert.equal(compareHiddenSideMethods(fixture(), { topK: 2 }).comparisons.find(item => item.method === 'reflected_view').overlap_ratio, 0.5);
  assert.match(result.context_digest, /^[a-f0-9]{64}$/);
});

test('the random baseline is deterministic, input-order independent and changes with its seed', () => {
  const first = compareHiddenSideMethods(fixture(), { topK: 4, randomSeed: 7 });
  const repeat = compareHiddenSideMethods(fixture(), { topK: 4, randomSeed: 7 });
  const ids = result => result.methods.find(item => item.method === 'random_baseline').candidates.map(item => item.id);
  assert.deepEqual(ids(first), ids(repeat));
  const reversed = compareHiddenSideMethods(fixture({ candidates: [...fixture().candidates].reverse() }), { topK: 4, randomSeed: 7 });
  assert.deepEqual(ids(first), ids(reversed));
  const seedsDiffer = Array.from({ length: 16 }, (_, index) => compareHiddenSideMethods(fixture(), { topK: 4, randomSeed: index + 2 }))
    .some(result => JSON.stringify(ids(result)) !== JSON.stringify(ids(first)));
  assert.equal(seedsDiffer, true);
});

test('supports retrieval method selection without changing the default standard workflow', () => {
  const result = compareHiddenSideMethods(fixture(), { methods: ['similarity', 'reflected_view'] });
  assert.deepEqual(result.methods.map(item => item.method), ['similarity', 'reflected_view']);
  assert.deepEqual(result.comparisons.map(item => item.method), ['reflected_view']);
});

test('reflection equals the current view when the view lies inside the context surface', () => {
  const result = compareHiddenSideMethods(fixture({ viewpointVector: [1, 0, 0] }), { methods: ['similarity', 'reflected_view'] });
  assert.equal(result.orthogonal_residual_norm, 0);
  const similarity = result.methods[0].candidates.map(item => item.id);
  const reflected = result.methods[1].candidates.map(item => item.id);
  assert.deepEqual(reflected, similarity);
});

test('an empty context permits standard similarity but not hidden-side geometry', () => {
  assert.throws(() => compareHiddenSideMethods(fixture({ contextVectors: [] })), error => error.code === 'zero_context');
  assert.throws(() => compareHiddenSideMethods(fixture({ contextVectors: [[0, 0, 0]] })), error => error.code === 'zero_context');
  const result = compareHiddenSideMethods(fixture({ contextVectors: [] }), { methods: ['similarity', 'random_baseline'] });
  assert.equal(result.context_surface_rank, 0);
  assert.equal(result.projection_norm, null);
  assert.equal(result.orthogonal_residual_norm, null);
  assert.equal(result.reflected_vector_norm, null);
  assert.ok(result.methods.every(method => method.candidates.every(candidate => candidate.context_rank === null && candidate.context_score === null)));
});

test('normalisation makes direction rankings invariant to positive vector scale', () => {
  const original = compareHiddenSideMethods(fixture(), { topK: 4, randomSeed: 7 });
  const input = fixture({
    contextVectors: fixture().contextVectors.map(vector => vector.map(value => value * 1e-100)),
    viewpointVector: fixture().viewpointVector.map(value => value * 1e-100),
    candidates: fixture().candidates.map(candidate => ({ ...candidate, vector: candidate.vector.map(value => value * 1e100) })),
  });
  const scaled = compareHiddenSideMethods(input, { topK: 4, randomSeed: 7 });
  assert.deepEqual(scaled.methods.map(method => method.candidates.map(candidate => candidate.id)),
    original.methods.map(method => method.candidates.map(candidate => candidate.id)));
});

test('stable normalisation accepts subnormal-scale vectors', () => {
  const input = fixture({
    contextVectors: [[Number.MIN_VALUE, 0, 0]],
    viewpointVector: [Number.MIN_VALUE, Number.MIN_VALUE, 0],
  });
  const result = compareHiddenSideMethods(input, { topK: 4, methods: ['similarity', 'orthogonal', 'reflected_view'] });
  assert.equal(result.context_surface_rank, 1);
  assert.ok(result.methods.every(method => method.candidates.every(candidate => candidate.score === null || Number.isFinite(candidate.score))));
});

test('keeps the correct rank for a linearly dependent non-parallel context set', () => {
  const result = compareHiddenSideMethods(fixture({
    contextVectors: [[1, 0, 0], [0, 1, 0], [1, 1, 0]],
    viewpointVector: [1, 1, 1],
  }));
  assert.equal(result.context_surface_rank, 2);
});

test('a cancelling context centroid has no context contact score', () => {
  const result = compareHiddenSideMethods(fixture({ contextVectors: [[1, 0, 0], [-1, 0, 0]] }), { methods: ['similarity'] });
  assert.ok(result.context_surface_rank > 0);
  assert.ok(result.methods[0].candidates.every(candidate => candidate.context_rank === null && candidate.context_score === null));
});

for (const [name, input, code] of [
  ['zero viewpoint', fixture({ viewpointVector: [0, 0, 0] }), 'zero_viewpoint'],
  ['dimension mismatch', fixture({ contextVectors: [[1, 0]] }), 'dimension_mismatch'],
  ['non-finite values', fixture({ viewpointVector: [1, Number.NaN, 0] }), 'invalid_input'],
  ['zero orthogonal residual', fixture({ contextVectors: [[1, 0, 0], [0, 1, 0]] }), 'zero_orthogonal_component'],
]) test(`rejects ${name}`, () => {
  assert.throws(() => compareHiddenSideMethods(input), error => error instanceof HiddenSideError && error.code === code);
});

test('rejects duplicate candidate IDs and incompatible options', () => {
  const input = fixture({ candidates: [...fixture().candidates, fixture().candidates[0]] });
  assert.throws(() => compareHiddenSideMethods(input), error => error.code === 'invalid_input');
  assert.throws(() => compareHiddenSideMethods(fixture(), { topK: 0 }), error => error.code === 'invalid_input');
  assert.throws(() => compareHiddenSideMethods(fixture({ candidates: [null] })), error => error.code === 'invalid_input');
  assert.throws(() => compareHiddenSideMethods(fixture(), null), error => error.code === 'invalid_input');
  assert.throws(() => compareHiddenSideMethods(fixture(), { methods: 'similarity' }), error => error.code === 'invalid_input');
});

test('unscorable vectors are excluded from cosine top-k and overlap denominators', () => {
  const input = fixture({
    contextVectors: [],
    candidates: [{ id: 'zero', concept: 'unscorable', vector: [0, 0, 0], source: null }],
  });
  const result = compareHiddenSideMethods(input, { methods: ['similarity', 'random_baseline'], topK: 10 });
  const similarity = result.methods.find(method => method.method === 'similarity');
  const comparison = result.comparisons[0];
  assert.equal(similarity.candidates[0].hidden_rank, null);
  assert.equal(comparison.baseline_top_k.length, 0);
  assert.equal(comparison.overlap_ratio, 0);
  assert.equal(comparison.candidates[0].baseline_rank, null);
  assert.equal(comparison.candidates[0].rank_gain, null);
});
