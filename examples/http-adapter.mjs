const endpoint = process.env.TOMBO_GENERATE_URL;
const timeoutMs = Number(process.env.TOMBO_GENERATE_TIMEOUT_MS ?? 10000);
const upperCost = process.env.TOMBO_GENERATE_MAX_COST_YEN?.trim() || undefined;

if (!endpoint || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Set TOMBO_GENERATE_URL and a positive request timeout.');
const url = new URL(endpoint);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS or a local HTTP endpoint.');

export default {
  ...(upperCost === undefined ? {} : {
    estimateMaxCostYen() {
      const value = Number(upperCost);
      if (!Number.isFinite(value) || value < 0) throw new Error('Set a non-negative maximum cost per request.');
      return value;
    },
  }),
  async generate(input) {
    const headers = { 'Content-Type': 'application/json' };
    const key = process.env.TOMBO_GENERATE_KEY;
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(input), redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Generation endpoint returned HTTP ${response.status}.`);
    return await response.json();
  },
};
