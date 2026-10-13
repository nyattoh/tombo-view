import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTombo, fixtureAdapter, TomboError } from '../dist/index.js';

const packet = JSON.parse(await readFile('examples/account/task.json', 'utf8'));
const observations = JSON.parse(await readFile('examples/account/observations.json', 'utf8'));
const now = () => new Date('2026-10-14T00:00:00.000Z');

test('reservation exceptions return a stopped state preserving actual tool execution', async () => {
  const task = structuredClone(packet);
  task.budget.maxCostYen = 100;
  const adapter = { ...fixtureAdapter, estimateMaxCostYen(input) {
    if (input.operation === 'update') throw new Error('estimator unavailable');
    return 0;
  } };
  const tombo = createTombo({ adapter, now });
  const first = await tombo.inspect(task);
  const observed = structuredClone(observations);
  observed[0].costYen = 4;
  const next = await tombo.update(first.state, observed);
  assert.equal(next.state.stopReason, 'budget_accounting_unavailable');
  assert.equal(next.state.usage.costYen, 4);
  assert.equal(next.state.usage.toolCalls, 1);
  assert.equal(next.state.usage.modelCalls, 1);
  assert.equal(next.state.appliedExecutions[0].executionId, observed[0].executionId);
  assert.equal(next.state.evidence.some(e => e.id === observed[0].evidence[0].id), true);
  assert.equal(next.state.revision, first.state.revision + 1);
});

test('typed adapter failures cannot leave unknown model consumption at zero', async () => {
  const adapter = { ...fixtureAdapter, async generate(input) {
    if (input.operation === 'update') throw new TomboError('model_error', 'provider failed after starting');
    return fixtureAdapter.generate(input);
  } };
  const tombo = createTombo({ adapter, now });
  const first = await tombo.inspect(packet);
  const next = await tombo.update(first.state, observations);
  assert.equal(next.state.stopReason, 'model_error');
  assert.equal(next.state.usage.totalTokens, null);
  assert.equal(next.state.usage.costYen, null);
  assert.equal(next.state.usage.modelCalls, 2);
  assert.equal(next.state.usage.toolCalls, 1);
});
