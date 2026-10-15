import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { coordinateDispatch } from '../scripts/metacognition-dispatch.mjs';
import { createT3Transport } from '../scripts/metacognition-t3-transport.mjs';

function fixture() {
  const state = {};
  const clock = { at: 10, terminal: false };
  const submitted = [], replies = [], cancelled = [], polled = [];
  const request = { sequence: 1, stage: 'reflect', instructions: 'Return one JSON object.', input: { binding: 'current' } };
  const bridge = { sequence: 1, stage: 'reflect', deadlineAt: 100, model: { provider: 'codex', name: 'gpt-6.1-sol', effort: 'low' } };
  const target = { providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoning_effort: 'low' } };
  const terminal = { taskId: 'real:opaque:ID', providerInstanceId: 'codex', model: 'gpt-6.1-sol', status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: '```json\n{"exact":true}\n```' };
  const tools = {
    delegate_task: async args => { submitted.push(args); return { structuredContent: { ...terminal, status: 'running' } }; },
    task_status: async args => { polled.push(args); return { structuredContent: terminal }; },
    task_cancel: async args => { cancelled.push(args); return { structuredContent: { taskId: args.taskId, status: 'cancel_requested' } }; },
  };
  const options = { state, load: async () => ({ request, bridge }), ready: async () => ({ terminal: clock.terminal }), deliver: async reply => replies.push(reply), tools, target, clientRequestId: 'trial-A', now: () => clock.at };
  const transport = createT3Transport(options);
  return { state, clock, request, bridge, target, terminal, tools, options, transport, submitted, replies, cancelled, polled };
}

test('T3 adapter delivers the unmodified final summary with exact request and stable submission ID', async () => {
  const t = fixture();
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.deepEqual(t.submitted, [{ mode: 'async', role: 'test', interactionMode: 'default', clientRequestId: 'trial-A-1', target: t.target, task: 'Return one JSON object.\n{"sequence":1,"stage":"reflect","instructions":"Return one JSON object.","input":{"binding":"current"}}' }]);
  assert.deepEqual(t.replies, [{ sequence: 1, model: t.bridge.model, taskId: 'real:opaque:ID', output: '```json\n{"exact":true}\n```' }]);
  assert.equal(t.transport.events.find(event => event.kind === 'reply_delivered').taskId, 'real:opaque:ID');
});

test('pending children remain active and JSON-restored state polls the same task without another delegation', async () => {
  const t = fixture();
  t.terminal.hasPendingChildRuns = true;
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'active');
  const restored = JSON.parse(JSON.stringify(t.state));
  t.terminal.hasPendingChildRuns = false;
  const adapter = createT3Transport({ ...t.options, state: restored });
  await coordinateDispatch(restored, adapter.callbacks);
  assert.equal(restored.phase, 'delivered');
  assert.equal(t.submitted.length, 1);
  assert.deepEqual(t.polled, [{ taskId: 'real:opaque:ID' }, { taskId: 'real:opaque:ID' }]);
  assert.equal(t.replies[0].output, '```json\n{"exact":true}\n```');
});

test('adapter checks expiry and producer terminal immediately before submission', async () => {
  for (const terminal of [false, true]) {
    const t = fixture();
    t.state.bridge = t.bridge;
    if (terminal) t.clock.terminal = true;
    else t.clock.at = 100;
    await assert.rejects(t.transport.callbacks.delegate(t.request, t.bridge), error => error.rejectedBeforeAcceptance === true);
    assert.equal(t.submitted.length, 0);
    t.clock.at = 10;
    t.clock.terminal = false;
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'delivered');
  }
});

test('late status results cannot reach producer and known running tasks are cancelled once', async () => {
  const t = fixture();
  t.tools.task_status = async () => { t.clock.at = 100; return { structuredContent: { ...t.terminal, status: 'running' } }; };
  await coordinateDispatch(t.state, t.transport.callbacks);
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.reason, 'deadline_expired');
  assert.deepEqual(t.cancelled, [{ taskId: 'real:opaque:ID', clientRequestId: 'trial-A-cancel-1', reason: 'Producer stopped or its deadline expired.' }]);
  assert.equal(t.replies.length, 0);
  assert.equal(t.submitted.length, 1);
});

test('delivery adapter independently rejects a terminal producer and expired deadline', async () => {
  const t = fixture();
  t.state.bridge = t.bridge;
  t.clock.terminal = true;
  await assert.rejects(t.transport.callbacks.deliver({ output: 'late' }), /terminal/);
  t.clock.terminal = false;
  t.clock.at = 100;
  await assert.rejects(t.transport.callbacks.deliver({ output: 'late' }), /deadline/);
  t.clock.at = 10;
  await t.transport.callbacks.deliver({ output: 'on time' });
  assert.deepEqual(t.replies, [{ output: 'on time' }]);
});

test('MCP error is never accepted success or falsely confirmed rejection', async () => {
  const t = fixture();
  t.tools.delegate_task = async () => ({ isError: true, content: [{ type: 'text', text: 'transport failure' }] });
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.acceptance, 'unknown');
  assert.deepEqual(t.replies, [{ sequence: 1, model: t.bridge.model, taskId: null, error: { code: 'model_error', message: 'transport failure' } }]);
  assert.equal(t.cancelled.length, 0);
});

test('accepted provider mismatch preserves its actual ID and cancels it', async () => {
  const t = fixture();
  t.tools.delegate_task = async () => ({ structuredContent: { ...t.terminal, providerInstanceId: 'other-provider' } });
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.acceptance, 'accepted');
  assert.equal(t.state.taskId, 'real:opaque:ID');
  assert.equal(t.replies[0].error.code, 'model_error');
  assert.equal(t.cancelled[0].taskId, 'real:opaque:ID');
});

test('status model and handle mismatches fail and cancel the accepted handle, never the returned handle', async () => {
  for (const changed of [{ model: 'different-model' }, { taskId: 'wrong-handle' }]) {
    const t = fixture();
    t.tools.task_status = async () => ({ structuredContent: { ...t.terminal, ...changed } });
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'delivered');
    assert.equal(t.replies[0].error.code, 'model_error');
    assert.equal(t.cancelled[0].taskId, 'real:opaque:ID');
  }
});

test('interrupted tasks return a bounded producer model_error', async () => {
  const t = fixture();
  t.terminal.status = 'interrupted';
  t.terminal.summary = 'Interrupted by provider.';
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.deepEqual(t.replies[0].error, { code: 'model_error', message: 'Interrupted by provider.' });
});

test('observer buffering is synchronous and does not enter the tools or producer transport', async () => {
  const t = fixture();
  const event = { kind: 'custom', taskId: 'known', extra: { count: 1 } };
  assert.equal(t.transport.callbacks.record(event), undefined);
  event.extra.count = 2;
  assert.deepEqual(t.transport.events, [{ kind: 'custom', taskId: 'known', extra: { count: 1 } }]);
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.equal(t.submitted.length, 1);
});

test('completed turn without available result stays active until the same task has a result', async () => {
  const t = fixture();
  t.terminal.workState = 'waiting_for_children';
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'active');
  t.terminal.workState = 'result_available';
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.equal(t.submitted.length, 1);
  assert.equal(t.replies[0].taskId, 'real:opaque:ID');
});

test('MCP status failure retries observation on the accepted task without re-submission', async () => {
  const t = fixture();
  t.tools.task_status = async () => ({ isError: true, content: [{ type: 'text', text: 'temporary observation failure' }] });
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'active');
  t.tools.task_status = async args => ({ structuredContent: { ...t.terminal, taskId: args.taskId } });
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.equal(t.submitted.length, 1);
  assert.equal(t.replies[0].taskId, 'real:opaque:ID');
});

test('MCP error carrying a known acceptance resumes status without immediate cancellation', async () => {
  const t = fixture();
  t.tools.delegate_task = async args => {
    t.submitted.push(args);
    return { isError: true, structuredContent: { acceptedTaskId: 'real:opaque:ID', message: 'accepted but failed' } };
  };
  const statusResults = [{ ...t.terminal, status: 'running', workState: 'working' }, t.terminal];
  t.tools.task_status = async args => { t.polled.push(args); return { structuredContent: statusResults.shift() }; };
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.acceptance, 'accepted');
  assert.equal(t.state.taskId, 'real:opaque:ID');
  assert.equal(t.submitted[0].mode, 'async');
  assert.equal(Object.hasOwn(t.submitted[0], 'timeoutMs'), false);
  assert.equal(t.state.phase, 'active');
  assert.deepEqual(t.replies, []);
  assert.deepEqual(t.cancelled, []);
  assert.deepEqual(t.polled, [{ taskId: 'real:opaque:ID' }]);
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.equal(t.replies[0].taskId, 'real:opaque:ID');
  assert.equal(t.replies[0].output, t.terminal.summary);
  assert.equal(t.submitted.length, 1);
  assert.deepEqual(t.polled, [{ taskId: 'real:opaque:ID' }, { taskId: 'real:opaque:ID' }]);
  assert.deepEqual(t.cancelled, []);
  assert.equal(t.transport.events.find(event => event.kind === 'transport_delegate_error_with_handle').taskId, 'real:opaque:ID');
});

test('slow final ready probe cannot submit after the deadline', async () => {
  const t = fixture();
  t.state.bridge = t.bridge;
  const adapter = createT3Transport({ ...t.options, ready: async () => { t.clock.at = 100; return { terminal: false }; } });
  await assert.rejects(adapter.callbacks.delegate(t.request, t.bridge), error => error.rejectedBeforeAcceptance === true && /deadline/.test(error.message));
  t.clock.at = 10;
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.equal(t.submitted.length, 1);
});

test('V8 without structuredClone retains detached telemetry through actual coordinator delivery', async () => {
  const t = fixture();
  const source = await readFile(new URL('../scripts/metacognition-t3-transport.mjs', import.meta.url), 'utf8');
  const create = runInNewContext(source.replace('export function createT3Transport', 'function createT3Transport') + '\ncreateT3Transport;', { structuredClone: undefined });
  const adapter = create(t.options);
  const event = { kind: 'custom', details: { value: 'original' } };
  adapter.callbacks.record(event);
  event.details.value = 'changed';
  await coordinateDispatch(t.state, adapter.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.equal(t.state.recordError, undefined);
  assert.equal(adapter.events[0].details.value, 'original');
  assert.equal(adapter.events.find(item => item.kind === 'task_accepted').taskId, 'real:opaque:ID');
  assert.equal(adapter.events.find(item => item.kind === 'reply_delivered').taskId, 'real:opaque:ID');
  assert.equal(t.replies[0].output, '```json\n{"exact":true}\n```');
});

for (const status of ['failed', 'cancelled', 'interrupted']) {
  for (const expired of [false, true]) {
    test(`${status} with live later children cancels its known handle once ${expired ? 'after expiry' : 'before expiry'}`, async () => {
      const t = fixture();
      t.tools.task_status = async () => {
        if (expired) t.clock.at = 100;
        return { structuredContent: { ...t.terminal, status, hasPendingChildRuns: true, summary: 'Original terminal failure.' } };
      };
      await coordinateDispatch(t.state, t.transport.callbacks);
      await coordinateDispatch(t.state, t.transport.callbacks);
      assert.equal(t.state.taskId, 'real:opaque:ID');
      assert.equal(t.state.cancelRequested, true);
      assert.deepEqual(t.state.terminalFailure, { status, message: 'Original terminal failure.', hasPendingChildRuns: true });
      assert.equal(t.cancelled.length, 1);
      assert.equal(t.cancelled[0].taskId, 'real:opaque:ID');
      assert.equal(t.submitted.length, 1);
      if (expired) {
        assert.equal(t.state.reason, 'deadline_expired');
        assert.equal(t.replies.length, 0);
      } else {
        assert.equal(t.state.phase, 'delivered');
        assert.deepEqual(t.replies[0].error, { code: 'model_error', message: 'Original terminal failure.' });
        assert.equal(Object.hasOwn(t.replies[0], 'output'), false);
      }
    });
  }
}
