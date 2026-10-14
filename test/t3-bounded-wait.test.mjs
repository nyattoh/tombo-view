import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateDispatch } from '../scripts/metacognition-dispatch.mjs';
import { createT3Transport } from '../scripts/metacognition-t3-transport.mjs';
import { runGuardedHostSession } from '../scripts/metacognition-host-session.mjs';

function fixture(firstDelegateWaitMs = 50000) {
  const state = {}, calls = { delegate: [], status: [], cancel: [], reads: 0 }, replies = [];
  const clock = { at: 10, terminal: false }, hooks = {};
  const target = { providerInstanceId: 'codex', model: 'test-model' };
  const request = { sequence: 3, stage: 'inspect', instructions: 'Return JSON.', input: { unknown: true, evidence: 'retained' } };
  const bridge = { sequence: 3, stage: 'inspect', deadlineAt: 100, model: { provider: 'codex', name: 'test-model', effort: 'low' } };
  const result = { taskId: 'actual-third', ...target, status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: '{"unknown":true,"newCandidate":"retained"}', waitTimedOut: false };
  hooks.ready = async () => ({ terminal: clock.terminal });
  hooks.delegate = async () => result;
  hooks.status = async () => result;
  const tools = {
    delegate_task: async args => { calls.delegate.push(args); return { structuredContent: await hooks.delegate() }; },
    task_status: async args => { calls.status.push(args); return { structuredContent: await hooks.status() }; },
    task_cancel: async args => { calls.cancel.push(args); return { structuredContent: { taskId: args.taskId, status: 'cancel_requested' } }; },
  };
  const options = { state, target, tools, clientRequestId: 'bounded', firstDelegateWaitMs, now: () => clock.at, load: async () => ({ request, bridge }), ready: async () => { calls.reads++; return hooks.ready(); }, deliver: async reply => replies.push(reply) };
  const transport = createT3Transport(options);
  return { state, calls, replies, clock, hooks, target, request, bridge, result, options, transport };
}

test('bounded completion reads fresh status with the exact result and unchanged ready reads', async () => {
  const bounded = fixture(), asyncMode = fixture(0);
  await coordinateDispatch(bounded.state, bounded.transport.callbacks);
  await coordinateDispatch(asyncMode.state, asyncMode.transport.callbacks);
  assert.equal(bounded.state.phase, 'delivered');
  assert.deepEqual(bounded.replies, asyncMode.replies);
  assert.deepEqual(bounded.calls.status, [{ taskId: 'actual-third' }]);
  assert.equal(asyncMode.calls.status.length, 1);
  assert.equal(bounded.calls.reads, 6);
  assert.equal(asyncMode.calls.reads, 6);
  assert.equal(bounded.calls.delegate.length, 1);
  assert.deepEqual(bounded.calls.delegate[0], { mode: 'wait', role: 'test', interactionMode: 'default', timeoutMs: 90, clientRequestId: 'bounded-3', target: bounded.target, task: 'Return JSON.\n{"sequence":3,"stage":"inspect","instructions":"Return JSON.","input":{"unknown":true,"evidence":"retained"}}' });
  assert.equal(asyncMode.calls.delegate[0].mode, 'async');
  assert.equal(Object.hasOwn(asyncMode.calls.delegate[0], 'timeoutMs'), false);
  assert.deepEqual(bounded.replies, [{ sequence: 3, model: bounded.bridge.model, taskId: 'actual-third', output: '{"unknown":true,"newCandidate":"retained"}' }]);
});

test('configured wait below remaining deadline is retained', async () => {
  const t = fixture(20);
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.calls.delegate[0].timeoutMs, 20);
});

test('the maximum wait remains capped even when the producer has more time', async () => {
  const t = fixture(50000);
  t.bridge.deadlineAt = 60010;
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.equal(t.calls.delegate[0].timeoutMs, 50000);
});

test('an expired producer rejects bounded submission before acceptance', async () => {
  const t = fixture();
  t.clock.at = 100;
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'stopped');
  assert.equal(t.state.reason, 'deadline_expired');
  assert.equal(t.calls.delegate.length, 0);
});

for (const delegated of [{ status: 'running' }, { status: 'running', waitTimedOut: true }, { waitTimedOut: true }, { hasPendingChildRuns: true }, { workState: 'waiting_for_children' }]) {
  test(`nonterminal wait response polls the accepted handle ${JSON.stringify(delegated)}`, async () => {
    const t = fixture();
    t.hooks.delegate = async () => ({ ...t.result, ...delegated });
    t.hooks.status = async () => ({ ...t.result, status: 'running' });
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'active');
    assert.deepEqual(t.calls.status, [{ taskId: 'actual-third' }]);
    assert.deepEqual(t.replies, []);
    t.hooks.status = async () => t.result;
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'delivered');
    assert.equal(t.calls.delegate.length, 1);
    assert.equal(t.replies[0].taskId, 'actual-third');
  });
}

for (const changed of [{ providerInstanceId: 'wrong' }, { model: 'wrong' }]) {
  test(`wait binding mismatch cancels the actual accepted handle ${JSON.stringify(changed)}`, async () => {
    const t = fixture();
    t.hooks.delegate = async () => ({ ...t.result, ...changed });
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.taskId, 'actual-third');
    assert.equal(t.state.acceptance, 'accepted');
    assert.equal(t.calls.cancel[0].taskId, 'actual-third');
    assert.equal(t.replies[0].error.code, 'model_error');
    assert.equal(t.calls.status.length, 0);
  });
}

test('a different accepted handle cannot bypass fresh status binding validation', async () => {
  const t = fixture();
  await t.transport.callbacks.delegate(t.request, t.bridge);
  t.state.bridge = t.bridge;
  const observed = await t.transport.callbacks.taskStatus('other-accepted');
  assert.deepEqual(t.calls.status, [{ taskId: 'other-accepted' }]);
  assert.equal(observed.status, 'failed');
  assert.equal(t.calls.cancel[0].taskId, 'other-accepted');
});

for (const status of ['failed', 'cancelled', 'interrupted']) {
  test(`${status} with pending children retains cancellation semantics after wait`, async () => {
    const t = fixture();
    t.hooks.delegate = t.hooks.status = async () => ({ ...t.result, status, hasPendingChildRuns: true, summary: 'Original failure.' });
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.calls.cancel.length, 1);
    assert.equal(t.calls.cancel[0].taskId, 'actual-third');
    assert.equal(t.state.terminalFailure.hasPendingChildRuns, true);
    assert.deepEqual(t.replies[0].error, { code: 'model_error', message: 'Original failure.' });
  });
}

for (const stopped of ['deadline', 'terminal']) {
  test(`producer ${stopped} during wait prevents delivery and cancels known handle`, async () => {
    const t = fixture();
    t.hooks.delegate = async () => {
      if (stopped === 'deadline') t.clock.at = 100;
      else t.clock.terminal = true;
      return t.result;
    };
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'stopped');
    assert.equal(t.state.reason, stopped === 'deadline' ? 'deadline_expired' : 'driver_terminal');
    assert.deepEqual(t.replies, []);
    assert.equal(t.calls.cancel[0].taskId, 'actual-third');
    assert.equal(t.calls.status.length, 0);
    assert.equal(t.calls.delegate.length, 1);
  });
}

test('transient producer read after wait resumes with fresh status and no duplicate generation', async () => {
  const t = fixture();
  t.hooks.ready = async () => {
    if (t.calls.delegate.length && t.calls.reads === 4) throw new Error('Transient producer read.');
    return { terminal: false };
  };
  await assert.rejects(coordinateDispatch(t.state, t.transport.callbacks), /Transient producer read/);
  assert.equal(t.state.phase, 'active');
  assert.equal(t.state.taskId, 'actual-third');
  await coordinateDispatch(t.state, t.transport.callbacks);
  assert.equal(t.state.phase, 'delivered');
  assert.equal(t.calls.delegate.length, 1);
  assert.deepEqual(t.calls.status, [{ taskId: 'actual-third' }]);
  assert.equal(t.replies[0].output, '{"unknown":true,"newCandidate":"retained"}');
});

for (const firstDelegateWaitMs of [20, 0]) {
  test(`dynamic pending children after a transient fourth ready read block completion and cancel at deadline with wait ${firstDelegateWaitMs}`, async () => {
    const t = fixture(firstDelegateWaitMs);
    let pending = false;
    t.hooks.ready = async () => {
      if (t.calls.reads === 4) throw new Error('Transient ready read.');
      return { terminal: false };
    };
    t.hooks.status = async () => ({ ...t.result, hasPendingChildRuns: pending });
    await assert.rejects(coordinateDispatch(t.state, t.transport.callbacks), /Transient ready read/);
    assert.equal(t.state.phase, 'active');
    assert.equal(t.state.taskId, 'actual-third');
    pending = true;
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'active');
    assert.deepEqual(t.replies, []);
    assert.deepEqual(t.calls.status, [{ taskId: 'actual-third' }]);
    t.clock.at = 100;
    await coordinateDispatch(t.state, t.transport.callbacks);
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'stopped');
    assert.equal(t.state.reason, 'deadline_expired');
    assert.deepEqual(t.calls.cancel, [{ taskId: 'actual-third', clientRequestId: 'bounded-cancel-3', reason: 'Producer stopped or its deadline expired.' }]);
    assert.equal(t.calls.delegate.length, 1);
    assert.equal(t.calls.delegate[0].clientRequestId, 'bounded-3');
    assert.equal(t.calls.delegate[0].mode, firstDelegateWaitMs > 0 ? 'wait' : 'async');
  });
}

for (const status of ['failed', 'cancelled', 'interrupted']) {
  test(`fresh ${status} with pending children overrides a completed wait response`, async () => {
    const t = fixture(20);
    t.hooks.status = async () => ({ ...t.result, status, hasPendingChildRuns: true, summary: 'Later failure.' });
    await coordinateDispatch(t.state, t.transport.callbacks);
    assert.equal(t.state.phase, 'delivered');
    assert.deepEqual(t.replies, [{ sequence: 3, model: t.bridge.model, taskId: 'actual-third', error: { code: 'model_error', message: 'Later failure.' } }]);
    assert.deepEqual(t.calls.status, [{ taskId: 'actual-third' }]);
    assert.deepEqual(t.calls.cancel, [{ taskId: 'actual-third', clientRequestId: 'bounded-cancel-3', reason: 'Producer stopped or its deadline expired.' }]);
    assert.equal(t.state.terminalFailure.hasPendingChildRuns, true);
  });
}

test('restored state observes the same handle without delegation', async () => {
  const t = fixture();
  t.hooks.ready = async () => {
    if (t.calls.delegate.length) throw new Error('Read failed.');
    return { terminal: false };
  };
  await assert.rejects(coordinateDispatch(t.state, t.transport.callbacks), /Read failed/);
  const state = JSON.parse(JSON.stringify(t.state));
  t.hooks.ready = async () => ({ terminal: false });
  const resumed = createT3Transport({ ...t.options, state });
  await coordinateDispatch(state, resumed.callbacks);
  assert.equal(state.phase, 'delivered');
  assert.equal(t.calls.delegate.length, 1);
  assert.deepEqual(t.calls.status, [{ taskId: 'actual-third' }]);
});

test('invalid wait options fail before any delegation or producer observation', () => {
  const t = fixture();
  for (const firstDelegateWaitMs of [-1, 50001, 0.5, NaN, Infinity, '20', null]) {
    assert.throws(() => createT3Transport({ ...t.options, firstDelegateWaitMs }), /integer from 0 to 50000/);
  }
  assert.deepEqual(t.calls.delegate, []);
  assert.equal(t.calls.reads, 0);
});

test('host-session forwards the optional bound through its actual transport binding', async () => {
  const submitted = [], statuses = [], replies = [], executions = [];
  const config = { repositoryRoot: 'D:\\prototype', directory: 'results/bounded', caseId: 'sample', arm: 'tombo', repeat: 1, casesPath: 'unused', protocolPath: 'unused', target: { providerInstanceId: 'codex', model: 'test-model' }, clientRequestId: 'host', firstDelegateWaitMs: 20 };
  const tools = {
    exec_command: async args => {
      executions.push(args);
      if (args.cmd.startsWith('node scripts/')) return { session_id: 7, output: '' };
      if (args.cmd.includes('const requestPath=')) return { exit_code: 0, output: JSON.stringify({ request: { sequence: 1, stage: 'inspect', instructions: 'Keep full input.', input: 'unknown' }, bridge: { sequence: 1, stage: 'inspect', deadlineAt: Date.now() + 10000, model: { provider: 'codex', name: 'test-model' } } }) };
      if (args.cmd.includes('existsSync')) return { exit_code: 0, output: 'false' };
      if (args.cmd.includes('console.log(readFileSync')) return { exit_code: 0, output: '{"status":"finished"}' };
      if (args.cmd.includes('writeFileSync')) return { exit_code: 0, output: '' };
      throw new Error('Unexpected host observation.');
    },
    write_stdin: async args => { replies.push(JSON.parse(args.chars)); return { exit_code: 0, output: '' }; },
    mcp__t3_code__delegate_task: async args => { submitted.push(args); return { structuredContent: { taskId: 'host-actual', ...config.target, status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: '{"unknown":true}' } }; },
    mcp__t3_code__task_status: async args => { statuses.push(args); return { structuredContent: { taskId: 'host-actual', ...config.target, status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: '{"unknown":true}' } }; },
    mcp__t3_code__task_cancel: async () => { throw new Error('On-time completion requires no cancellation.'); },
  };
  const run = await runGuardedHostSession({ tools, coordinateDispatch, createT3Transport, config });
  assert.deepEqual(run, { status: 'finished' });
  assert.equal(submitted[0].mode, 'wait');
  assert.equal(submitted[0].timeoutMs, 20);
  assert.equal(submitted[0].clientRequestId, 'host-1');
  assert.equal(replies[0].taskId, 'host-actual');
  assert.equal(replies[0].output, '{"unknown":true}');
  assert.deepEqual(statuses, [{ taskId: 'host-actual' }]);
  assert.equal(executions.every(args => args.workdir === 'D:\\prototype' && args.sandbox_permissions === 'require_escalated'), true);
});

test('host-session rejects invalid bounds before starting its producer', async () => {
  let executed = false;
  for (const firstDelegateWaitMs of [-1, 50001, 0.5, NaN, Infinity, '20', null]) {
    await assert.rejects(runGuardedHostSession({ tools: { exec_command: async () => { executed = true; } }, coordinateDispatch, createT3Transport, config: { firstDelegateWaitMs } }), /integer from 0 to 50000/);
  }
  assert.equal(executed, false);
});
