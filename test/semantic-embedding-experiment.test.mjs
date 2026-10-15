import test from 'node:test';
import assert from 'node:assert/strict';
import { runSemanticEmbeddingExperiment } from '../scripts/semantic-embedding-experiment.mjs';

const validConfig = {
  model: 'text-embedding-3-small',
  priceUsdPerMillionTokens: 0.02,
  usdJpy: 200,
  apiKey: 'test-key',
  safetyFactor: 2,
};

function embeddingResponse(input, dimensions = 3) {
  const rows = input.map((_, index) => ({
    index,
    embedding: Array.from({ length: dimensions }, (_, axis) => axis === (index < 4 ? 0 : index === 4 ? 1 : index % dimensions) ? 1 : 0),
  }));
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: validConfig.model, usage: { total_tokens: 1 }, data: rows }),
  };
}

test('missing caller configuration fails before fetch', async () => {
  let fetchCount = 0;
  await assert.rejects(runSemanticEmbeddingExperiment({
    config: { ...validConfig, apiKey: undefined },
    fetchImpl: async () => { fetchCount++; throw new Error('unexpected fetch'); },
  }), /key/i);
  assert.equal(fetchCount, 0);
});

test('preflight estimate over the cap fails before fetch', async () => {
  let fetchCount = 0;
  await assert.rejects(runSemanticEmbeddingExperiment({
    config: { ...validConfig, safetyFactor: 1_000_000 },
    fetchImpl: async () => { fetchCount++; throw new Error('unexpected fetch'); },
  }), /preflight|budget/i);
  assert.equal(fetchCount, 0);
});

test('one batch request returns rankings and leaves candidates unverified', async () => {
  const calls = [];
  const result = await runSemanticEmbeddingExperiment({
    config: validConfig,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return embeddingResponse(JSON.parse(options.body).input);
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/embeddings');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    input: JSON.parse(calls[0].options.body).input,
    model: 'text-embedding-3-small',
    encoding_format: 'float',
  });
  assert.equal(result.embedding_model, validConfig.model);
  assert.match(result.input_context_digest, /^[a-f0-9]{64}$/);
  assert.equal(result.input_count, 33);
  assert.ok(result.methods.length > 0);
  assert.ok(result.methods.every(method => method.candidates.every(candidate => candidate.verification_status === 'unverified')));
  assert.equal(result.spend.usage_tokens, 1);
});

test('response model, vector count, dimensions, and finite values are validated', async t => {
  const invalid = [
    ['wrong model', body => ({ ...body, model: 'other/model' })],
    ['wrong vector count', body => ({ ...body, data: body.data.slice(1) })],
    ['wrong vector index', body => ({ ...body, data: body.data.map((row, index) => ({ ...row, index: index + 1 })) })],
    ['wrong dimensions', body => ({ ...body, data: body.data.map((row, index) => ({ embedding: index === 0 ? [1, 2] : [1, 2, 3] })) })],
    ['non-finite values', body => ({ ...body, data: body.data.map(row => ({ embedding: [1, NaN, 0] })) })],
  ];
  for (const [label, mutate] of invalid) await t.test(label, async () => {
    await assert.rejects(runSemanticEmbeddingExperiment({
      config: validConfig,
      fetchImpl: async (_url, options) => {
        const body = await embeddingResponse(JSON.parse(options.body).input).json();
        return { ok: true, status: 200, json: async () => mutate(body) };
      },
    }));
  });
});

test('actual usage cost over the cap is reported without hiding rankings', async () => {
  const result = await runSemanticEmbeddingExperiment({
    config: validConfig,
    fetchImpl: async (_url, options) => {
      const response = await embeddingResponse(JSON.parse(options.body).input).json();
      return { ok: true, status: 200, json: async () => ({ ...response, usage: { total_tokens: 200_000_000 } }) };
    },
  });
  assert.equal(result.spend.over_cap, true);
  assert.ok(result.methods.length > 0);
});

test('unsupported model is rejected before fetch', async () => {
  let fetchCount = 0;
  await assert.rejects(runSemanticEmbeddingExperiment({
    config: { ...validConfig, model: 'text-embedding-unknown' },
    fetchImpl: async () => { fetchCount++; throw new Error('unexpected fetch'); },
  }), /supported OpenAI embedding model/i);
  assert.equal(fetchCount, 0);
});

test('HTTP failures expose only the provider error code and do not retry', async () => {
  let fetchCount = 0;
  await assert.rejects(runSemanticEmbeddingExperiment({
    config: validConfig,
    fetchImpl: async () => {
      fetchCount++;
      return { ok: false, status: 403, json: async () => ({ error: { code: 'permission_denied', message: 'detail' } }) };
    },
  }), /HTTP 403 \(permission_denied\)/i);
  assert.equal(fetchCount, 1);
});
