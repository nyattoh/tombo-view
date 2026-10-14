import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateDispatch } from '../scripts/metacognition-dispatch.mjs';
import { createT3Transport } from '../scripts/metacognition-t3-transport.mjs';

const target = { providerInstanceId: 'codex', model: 'test-model' };

function setup(delegateResult, statuses) {
  const state = {};
  const calls = { delegate: [], status: [], cancel: [], replies: [] };
  const bridge = { sequence: 1, stage: 'inspect', deadlineAt: 1000, model: { provider: 'codex', name: 'test-model' } };
  const request = { sequence: 1, stage: 'inspect', instructions: 'Keep the supplied evidence.', input: { decision: 'unknown' } };
  const transport = createT3Transport({
    state,
    target,
    clientRequestId: 'timeout-test',
    now: () => 10,
    load: async () => ({ request, bridge }),
    ready: async () => ({ terminal: false }),
    deliver: async reply => calls.replies.push(reply),
    tools: {
      delegate_task: async args => { calls.delegate.push(args); return delegateResult; },
      task_status: async args => { calls.status.push(args); return { structuredContent: statuses.shift() }; },
      task_cancel: async args => { calls.cancel.push(args); return { structuredContent: { taskId: args.taskId, status: 'cancel_requested' } }; },
    },
  });
  return { state, calls, bridge, transport };
}

for (const identifier of ['taskId', 'acceptedTaskId']) {
  test(`an error-shaped wait timeout with ${identifier} resumes status on the same handle`, async () => {
    const handle = 'accepted-timeout-handle';
    const t = setup({ isError: true, structuredContent: { [identifier]: handle, waitTimedOut: true, message: 'Parent wait expired.' } }, [
      { taskId: handle, providerInstanceId: target.providerInstanceId, model: target.model, status: 'running', workState: 'working', hasPendingChildRuns: false },
      { taskId: handle, providerInstanceId: target.providerInstanceId, model: target.model, status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: 'Exact completed output.' },
    ]);

    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'active');
    assert.equal(t.state.taskId, handle);
    assert.deepEqual(t.calls.replies, []);
    assert.deepEqual(t.calls.cancel, []);
    assert.equal(t.calls.status.length, 1);

    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'delivered');
    assert.equal(t.calls.delegate.length, 1);
    assert.deepEqual(t.calls.status, [{ taskId: handle }, { taskId: handle }]);
    assert.deepEqual(t.calls.cancel, []);
    assert.deepEqual(t.calls.replies, [{ sequence: 1, model: t.bridge.model, taskId: handle, output: 'Exact completed output.' }]);
  });
}

test('an error-shaped timeout without a task handle remains unknown and is not retried', async () => {
  const t = setup({ isError: true, structuredContent: { waitTimedOut: true, message: 'Parent wait expired.' } }, []);

  await coordinateDispatch(t.state, t.transport.callbacks);

  assert.equal(t.state.acceptance, 'unknown');
  assert.equal(t.state.taskId, undefined);
  assert.equal(t.calls.delegate.length, 1);
  assert.deepEqual(t.calls.status, []);
  assert.deepEqual(t.calls.cancel, []);
  assert.equal(t.calls.replies.length, 1);
  assert.equal(t.calls.replies[0].taskId, null);
  assert.equal(t.calls.replies[0].error.code, 'model_error');
  assert.match(t.calls.replies[0].error.message, /Parent wait expired/);
});
