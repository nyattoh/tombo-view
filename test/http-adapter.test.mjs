import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createTombo, fixtureAdapter } from '../dist/index.js';

test('explicit HTTP adapter applies the typed contract through a local service', async () => {
  const original = { url: process.env.TOMBO_GENERATE_URL, key: process.env.TOMBO_GENERATE_KEY, cost: process.env.TOMBO_GENERATE_MAX_COST_YEN };
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      requests++;
      assert.equal(request.headers.authorization, 'Bearer local-test-key');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(input.maxOutputTokens, 4000);
      const result = await fixtureAdapter.generate(input);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    process.env.TOMBO_GENERATE_URL = `http://127.0.0.1:${server.address().port}/generate`;
    process.env.TOMBO_GENERATE_KEY = 'local-test-key';
    process.env.TOMBO_GENERATE_MAX_COST_YEN = '0';
    const { default: adapter } = await import('../examples/http-adapter.mjs?local-contract');
    const tombo = createTombo({ adapter });
    const task = JSON.parse(await readFile('examples/account/task.json', 'utf8'));
    task.budget.maxCostYen = 1;
    const first = await tombo.inspect(task);
    assert.equal(first.state.decision, 'needs_check');
    const observations = JSON.parse(await readFile('examples/account/observations.json', 'utf8'));
    const next = await tombo.update(first.state, observations);
    assert.equal(next.state.gaps[0].status, 'resolved');
    assert.equal(next.state.claims.some(claim => claim.status === 'contradicted'), true);
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const [name, value] of [['TOMBO_GENERATE_URL', original.url], ['TOMBO_GENERATE_KEY', original.key], ['TOMBO_GENERATE_MAX_COST_YEN', original.cost]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
