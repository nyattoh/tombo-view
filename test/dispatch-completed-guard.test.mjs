import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateDispatch } from '../scripts/metacognition-dispatch.mjs';
import { createT3Transport } from '../scripts/metacognition-t3-transport.mjs';

function fixture() {
  const state = {};
  const clock = { at: 10 };
  const model = { provider: 'codex', name: 'gpt-6.1-sol', effort: 'low' };
  const bridge = { sequence: 1, stage: 'baseline', deadlineAt: 100, model };
  const request = { sequence: 1, stage: 'baseline', instructions: 'Return JSON.', packet: { task: 'Read evidence.' } };
  const output = '{"answer":"unverified"}';
  const replies = [], submitted = [], polled = [], cancelled = [], observations = [];
  let observed = false;
  const hooks = {
    ready: async () => ({ terminal: false }),
    result: async () => ({ status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: output }),
  };
  const tools = {
    delegate_task: async args => { submitted.push(args); return { structuredContent: { taskId: 'known-task' } }; },
    task_status: async args => {
      polled.push(args);
      const result = await hooks.result();
      observed = true;
      return { structuredContent: { taskId: args.taskId, ...result } };
    },
    task_cancel: async args => { cancelled.push(args); return { structuredContent: { taskId: args.taskId, status: 'cancel_requested' } }; },
  };
  const adapter = createT3Transport({
    state, load: async () => ({ request, bridge }),
    ready: async () => {
      if (observed) observations.push({ taskState: state.taskState, phase: state.phase });
      return hooks.ready(observed, observations.length);
    },
    deliver: async reply => replies.push(reply), tools,
    target: { providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoning_effort: 'low' } },
    clientRequestId: 'completed-guard', now: () => clock.at,
  });
  return { state, clock, model, bridge, output, replies, submitted, polled, cancelled, observations, hooks, adapter };
}

function expectedReply(t) {
  return { sequence: 1, model: t.model, taskId: 'known-task', output: '{"answer":"unverified"}' };
}

test('completed output reaches the producer with only send and adapter observations after status', async () => {
  const t = fixture();
  await coordinateDispatch(t.state, t.adapter.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.deepEqual(t.replies, [expectedReply(t)]);
  assert.deepEqual(t.observations, [
    { taskState: 'completed', phase: 'polling' },
    { taskState: 'completed', phase: 'delivering' },
  ]);
  assert.equal(t.submitted.length, 1);
});

for (const boundary of ['status_deadline', 'ready_deadline', 'producer_terminal']) {
  test(`completed output is withheld at ${boundary}`, async () => {
    const t = fixture();
    if (boundary === 'status_deadline') t.hooks.result = async () => {
      t.clock.at = 100;
      return { status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: t.output };
    };
    t.hooks.ready = async observed => {
      if (observed && boundary === 'ready_deadline') t.clock.at = 100;
      return { terminal: observed && boundary === 'producer_terminal' };
    };
    await coordinateDispatch(t.state, t.adapter.callbacks);
    assert.equal(t.state.phase, 'stopped');
    assert.equal(t.state.reason, boundary === 'producer_terminal' ? 'driver_terminal' : 'deadline_expired');
    assert.equal(t.state.taskId, 'known-task');
    assert.deepEqual(t.replies, []);
    assert.deepEqual(t.cancelled, []);
    assert.equal(t.submitted.length, 1);
  });
}

test('ready failure after completed status resumes the same known handle without delegation', async () => {
  const t = fixture();
  t.hooks.ready = async observed => {
    if (observed) throw new Error('Readiness unavailable after completion.');
    return { terminal: false };
  };
  await assert.rejects(coordinateDispatch(t.state, t.adapter.callbacks), /Readiness unavailable after completion/);
  assert.equal(t.state.phase, 'active');
  assert.equal(t.state.taskId, 'known-task');
  assert.equal(t.state.taskState, 'completed');
  assert.deepEqual(t.replies, []);
  assert.equal(t.adapter.events.find(event => event.kind === 'ready_failed').message, 'Readiness unavailable after completion.');
  t.hooks.ready = async () => ({ terminal: false });
  await coordinateDispatch(t.state, t.adapter.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.deepEqual(t.replies, [expectedReply(t)]);
  assert.deepEqual(t.polled, [{ taskId: 'known-task' }, { taskId: 'known-task' }]);
  assert.equal(t.submitted.length, 1);
});

for (const boundary of ['terminal', 'deadline', 'read_failure']) {
  test(`adapter catches ${boundary} after the completed send check passed`, async () => {
    const t = fixture();
    t.hooks.ready = async observed => {
      if (observed && t.state.phase === 'delivering') {
        if (boundary === 'read_failure') throw new Error('Final readiness unavailable.');
        if (boundary === 'deadline') t.clock.at = 100;
        return { terminal: boundary === 'terminal' };
      }
      return { terminal: false };
    };
    await coordinateDispatch(t.state, t.adapter.callbacks);
    assert.equal(t.state.phase, 'stopped');
    assert.equal(t.state.reason, 'delivery_failed');
    const message = t.adapter.events.find(event => event.kind === 'delivery_failed').message;
    assert.equal(message, boundary === 'terminal' ? 'Producer is terminal.' : boundary === 'deadline' ? 'Producer deadline expired.' : 'Final readiness unavailable.');
    assert.deepEqual(t.replies, []);
    assert.deepEqual(t.cancelled, []);
    assert.equal(t.submitted.length, 1);
  });
}

for (const status of ['failed', 'cancelled']) {
  test(`${status} result retains its existing observations and bounded failure delivery`, async () => {
    const t = fixture();
    t.hooks.result = async () => ({ status, summary: 'Original failure.' });
    await coordinateDispatch(t.state, t.adapter.callbacks);
    assert.equal(t.state.phase, 'delivered');
    assert.deepEqual(t.replies, [{ sequence: 1, model: t.model, taskId: 'known-task', error: { code: 'model_error', message: 'Original failure.' } }]);
    assert.deepEqual(t.observations, [
      { taskState: status, phase: 'polling' },
      { taskState: status, phase: 'polling' },
      { taskState: status, phase: 'delivering' },
    ]);
  });
}

for (const boundary of ['terminal', 'deadline', 'read_failure']) {
  test(`failed result is withheld if ${boundary} arises between the first check and send`, async () => {
    const t = fixture();
    t.hooks.result = async () => ({ status: 'failed', summary: 'Original failure.' });
    t.hooks.ready = async (observed, count) => {
      if (observed && count === 2) {
        if (boundary === 'read_failure') throw new Error('Failure readiness unavailable.');
        if (boundary === 'deadline') t.clock.at = 100;
        return { terminal: boundary === 'terminal' };
      }
      return { terminal: false };
    };
    if (boundary === 'read_failure') {
      await assert.rejects(coordinateDispatch(t.state, t.adapter.callbacks), /Failure readiness unavailable/);
      assert.equal(t.state.phase, 'active');
      assert.equal(t.adapter.events.find(event => event.kind === 'ready_failed').message, 'Failure readiness unavailable.');
    } else {
      await coordinateDispatch(t.state, t.adapter.callbacks);
      assert.equal(t.state.phase, 'stopped');
      assert.equal(t.state.reason, boundary === 'terminal' ? 'driver_terminal' : 'deadline_expired');
    }
    assert.equal(t.state.taskId, 'known-task');
    assert.deepEqual(t.replies, []);
    assert.equal(t.submitted.length, 1);
  });
}

test('running result still checks producer liveness and cancels the accepted handle', async () => {
  const t = fixture();
  t.hooks.result = async () => ({ status: 'running' });
  t.hooks.ready = async observed => ({ terminal: observed });
  await coordinateDispatch(t.state, t.adapter.callbacks);
  assert.equal(t.state.phase, 'stopped');
  assert.equal(t.state.reason, 'driver_terminal');
  assert.deepEqual(t.cancelled, [{ taskId: 'known-task', clientRequestId: 'completed-guard-cancel-1', reason: 'Producer stopped or its deadline expired.' }]);
  assert.deepEqual(t.replies, []);
  assert.deepEqual(t.observations, [{ taskState: 'running', phase: 'polling' }]);
});
