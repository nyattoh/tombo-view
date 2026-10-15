import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { compareHiddenSideMethods } from '../dist/index.js';

export const INPUT_CONTEXT = '犬、カレー、夕暮れ、帰宅';
export const VIEWPOINT = '家庭での食事';
export const CANDIDATES = [
  '家族で囲む夕食', 'スパイスカレーの夕食', '犬の散歩から帰宅', '夕暮れの散歩', '帰宅後に犬が迎える',
  'カレーの買い出し', '食卓の準備', '夕方の散歩後にカレーを作る', '外食でカレー', '朝食を作る',
  '食後の片付け', '夕暮れに帰宅', '犬のごはん', '家庭料理', '夜道の帰宅', '香辛料の種類',
  '家族の会話', '猫の夕食', 'カレー皿', '仕事帰りの夕飯', '犬と過ごす休日', '夕食の献立',
  '雨の日の帰宅', '公園の夕焼け', 'スープを温める', '帰宅時の玄関', '辛さを選ぶ', '犬と家族の食卓',
];

const ENDPOINT = 'https://api.openai.com/v1/embeddings';
const SPEND_CAP_JPY = 500;
const USD_JPY_PREFLIGHT_RATE = 200;
const PRICE_PER_MILLION_TOKENS = new Map([
  ['text-embedding-3-small', 0.02],
  ['text-embedding-3-large', 0.13],
]);
const INPUT_OVERHEAD_TOKENS = 8;
const REQUEST_OVERHEAD_TOKENS = 32;

function validateConfig(config) {
  if (!config || !PRICE_PER_MILLION_TOKENS.has(config.model)) throw new Error('A supported OpenAI embedding model is required.');
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) throw new Error('OPENAI_TEST_API_KEY is required.');
  const safetyFactor = config.safetyFactor ?? 2;
  if (!Number.isFinite(safetyFactor) || safetyFactor < 1) throw new Error('Safety factor must be a finite number greater than or equal to 1.');
  return safetyFactor;
}

export function estimatePreflightCost(input, { priceUsdPerMillionTokens, usdJpy = USD_JPY_PREFLIGHT_RATE, safetyFactor = 2 }) {
  if (!Array.isArray(input) || input.some(value => typeof value !== 'string')) throw new Error('Embedding input must be an array of strings.');
  const estimatedTokens = input.reduce((total, value) => total + Buffer.byteLength(value, 'utf8') + INPUT_OVERHEAD_TOKENS, REQUEST_OVERHEAD_TOKENS);
  const estimatedJpy = estimatedTokens * priceUsdPerMillionTokens / 1_000_000 * usdJpy * safetyFactor;
  return { estimated_tokens_upper_bound: estimatedTokens, estimated_jpy: estimatedJpy, safety_factor: safetyFactor };
}

export async function runSemanticEmbeddingExperiment({ config, fetchImpl = globalThis.fetch } = {}) {
  const safetyFactor = validateConfig(config);
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  const inputs = [...INPUT_CONTEXT.split('、'), VIEWPOINT, ...CANDIDATES];
  const priceUsdPerMillionTokens = PRICE_PER_MILLION_TOKENS.get(config.model);
  const preflight = estimatePreflightCost(inputs, {
    priceUsdPerMillionTokens,
    usdJpy: USD_JPY_PREFLIGHT_RATE,
    safetyFactor,
  });
  if (preflight.estimated_jpy > SPEND_CAP_JPY) {
    throw new Error(`Preflight estimate ${preflight.estimated_jpy.toFixed(6)} JPY exceeds the ${SPEND_CAP_JPY} JPY experimental budget.`);
  }

  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: inputs, model: config.model, encoding_format: 'float' }),
  });
  if (!response?.ok) {
    let errorCode = 'unspecified';
    try {
      const providerError = (await response.json())?.error;
      const candidateCode = providerError?.code ?? providerError?.type;
      if (typeof candidateCode === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(candidateCode)) errorCode = candidateCode;
    } catch {
      errorCode = 'unreadable_error_body';
    }
    throw new Error(`OpenAI embedding request failed with HTTP ${response?.status ?? 'unknown'} (${errorCode}).`);
  }
  const payload = await response.json();
  if (!payload || payload.model !== config.model) throw new Error('Embedding response model does not match the requested model.');
  if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) throw new Error('Embedding response vector count does not match the input count.');
  if (!payload.usage || !Number.isSafeInteger(payload.usage.total_tokens) || payload.usage.total_tokens < 0) throw new Error('Embedding response has invalid usage.total_tokens.');
  if (!payload.data.every((row, index) => row?.index === index)) throw new Error('Embedding response indices do not match the input order.');
  const vectors = payload.data.map(row => row?.embedding);
  if (!vectors.every(vector => Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite))) {
    throw new Error('Embedding response contains invalid vector dimensions or non-finite values.');
  }
  const dimensions = vectors[0].length;
  if (!vectors.every(vector => vector.length === dimensions)) throw new Error('Embedding response vectors have inconsistent dimensions.');

  const actualJpy = payload.usage.total_tokens * priceUsdPerMillionTokens / 1_000_000 * USD_JPY_PREFLIGHT_RATE;
  let comparison;
  try {
    comparison = compareHiddenSideMethods({
    inputContext: INPUT_CONTEXT,
    viewpoint: VIEWPOINT,
    embeddingModel: payload.model,
    contextVectors: vectors.slice(0, 4),
    viewpointVector: vectors[4],
    candidates: CANDIDATES.map((concept, index) => ({
      id: `candidate-${String(index + 1).padStart(2, '0')}`,
      concept,
      vector: vectors[index + 5],
      source: `synthetic:hidden-side-corpus-v1#${index + 1}`,
    })),
    }, { topK: 10, randomSeed: 20261016 });
  } catch (error) {
    if (error?.code === 'zero_orthogonal_component') {
      comparison = compareHiddenSideMethods({
        inputContext: INPUT_CONTEXT,
        viewpoint: VIEWPOINT,
        embeddingModel: payload.model,
        contextVectors: vectors.slice(0, 4),
        viewpointVector: vectors[4],
        candidates: CANDIDATES.map((concept, index) => ({
          id: `candidate-${String(index + 1).padStart(2, '0')}`,
          concept,
          vector: vectors[index + 5],
          source: `synthetic:hidden-side-corpus-v1#${index + 1}`,
        })),
      }, { topK: 10, randomSeed: 20261016, methods: ['similarity', 'reflected_view', 'random_baseline'] });
    } else throw error;
  }

  return {
    ...comparison,
    input_context_digest: createHash('sha256').update(JSON.stringify({ inputContext: INPUT_CONTEXT, viewpoint: VIEWPOINT })).digest('hex'),
    input_count: inputs.length,
    provider: 'openai',
    methods: comparison.methods.map(method => ({
      ...method,
      candidates: method.candidates.map(candidate => ({ ...candidate, verification_status: 'unverified' })),
    })),
    spend: {
      cap_jpy: SPEND_CAP_JPY,
      usd_jpy_rate_used: USD_JPY_PREFLIGHT_RATE,
      preflight,
      usage_tokens: payload.usage.total_tokens,
      actual_estimated_jpy: actualJpy,
      over_cap: actualJpy > SPEND_CAP_JPY,
    },
    experiment: { kind: 'OpenAI embedding comparison', paidOrExternalCalls: 1, candidatesVerified: false },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const apiKey = process.env.OPENAI_TEST_API_KEY;
  try {
    const result = await runSemanticEmbeddingExperiment({ config: { model, apiKey } });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Embedding experiment failed.');
    process.exitCode = 1;
  }
}
