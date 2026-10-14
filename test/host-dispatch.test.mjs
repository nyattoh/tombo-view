import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { coordinateDispatch } from '../scripts/metacognition-dispatch.mjs';

const model = { provider: 'codex', name: 'gpt-6.1-sol', effort: 'medium' };
const output = '{"action":"finish","decision":"unknown","answer":"Unverified","uncertainties":[],"sourceRefs":[]}';
function transport(overrides = {}) {
  const clock = { at: 10, terminal: false };
  const delivered = [], events = [], delegated = [], cancelled = [], polled = [];
  const request = { sequence: 1, stage: 'baseline', instructions: 'JSON only', packet: { task: 'Read evidence' } };
  const bridge = { sequence: 1, stage: 'baseline', startedAt: 0, deadlineAt: 100, model };
  const callbacks = {
    load: async () => ({ request, bridge }), ready: async () => ({ terminal: clock.terminal }),
    delegate: async participant => { delegated.push(participant); return { taskId: 'actual-task-1' }; },
    taskStatus: async id => { polled.push(id); return { status: 'completed', output }; },
    taskCancel: async id => cancelled.push(id), deliver: async reply => delivered.push(reply),
    record: async event => events.push(event), now: () => clock.at, sleep: async ms => { clock.at += ms; },
    ...overrides,
  };
  return { clock, delivered, events, delegated, cancelled, polled, request, bridge, callbacks };
}

test('live dispatch delivers the exact participant output and retains the actual handle', async () => {
  const t = transport();
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.phase, 'delivered');
  assert.equal(state.taskId, 'actual-task-1');
  assert.deepEqual(t.delivered, [{ sequence: 1, model, taskId: 'actual-task-1', output }]);
  assert.deepEqual(t.delegated, [{ sequence: 1, stage: 'baseline', instructions: 'JSON only', packet: { task: 'Read evidence' } }]);
  await coordinateDispatch(state, t.callbacks);
  assert.equal(t.delegated.length, 1);
});

test('delayed loading cannot launch after the whole-trial deadline', async () => {
  const t = transport();
  t.callbacks.load = async () => { t.clock.at = 100; return { request: t.request, bridge: t.bridge }; };
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.reason, 'deadline_expired');
  assert.deepEqual(t.delegated, []);
  assert.deepEqual(t.delivered, []);
});

test('terminal driver and delayed ready probe suppress dispatch', async () => {
  for (const reason of ['driver_terminal', 'deadline_expired']) {
    const t = transport();
    t.callbacks.ready = async () => { if (reason === 'deadline_expired') t.clock.at = 101; return { terminal: reason === 'driver_terminal' }; };
    const state = await coordinateDispatch({}, t.callbacks);
    assert.equal(state.reason, reason);
    assert.deepEqual(t.delegated, []);
  }
});

test('bounded polling resumes the same active task and never redispatches', async () => {
  const t = transport();
  t.callbacks.taskStatus = async id => { t.polled.push(id); return { status: t.polled.length < 3 ? 'running' : 'completed', output }; };
  const state = await coordinateDispatch({}, t.callbacks, { maxPolls: 2, pollMs: 5 });
  assert.equal(state.phase, 'active');
  assert.equal(t.clock.at, 15);
  assert.equal(await coordinateDispatch(state, t.callbacks), state);
  assert.equal(state.phase, 'delivered');
  assert.deepEqual(t.polled, ['actual-task-1', 'actual-task-1', 'actual-task-1']);
  assert.equal(t.delegated.length, 1);
  assert.equal(t.delivered[0].output, output);
});

test('expired active task cancels its known ID once without a late success or redispatch', async () => {
  const t = transport({ taskStatus: async () => ({ status: 'running' }) });
  const state = await coordinateDispatch({}, t.callbacks);
  t.clock.at = 100;
  await coordinateDispatch(state, t.callbacks);
  await coordinateDispatch(state, t.callbacks);
  assert.equal(state.reason, 'deadline_expired');
  assert.deepEqual(t.cancelled, ['actual-task-1']);
  assert.deepEqual(t.delivered, []);
  assert.equal(t.delegated.length, 1);
  assert.equal(t.events.find(e => e.kind === 'cancel_returned').upstreamAbortGuaranteed, false);
});

test('a status read that completes after deadline cannot deliver success', async () => {
  const t = transport();
  t.callbacks.taskStatus = async () => { t.clock.at = 101; return { status: 'completed', output }; };
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.reason, 'deadline_expired');
  assert.equal(state.taskId, 'actual-task-1');
  assert.deepEqual(t.delivered, []);
  assert.deepEqual(t.cancelled, []);
});

test('late delegate acceptance cancels the accepted task with honest accounting', async () => {
  const t = transport();
  t.callbacks.delegate = async () => { t.clock.at = 101; return { taskId: 'late-task' }; };
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.reason, 'deadline_expired');
  assert.equal(state.taskId, 'late-task');
  assert.deepEqual(t.cancelled, ['late-task']);
  assert.equal(t.events.find(e => e.kind === 'cancel_requested').cost, 'UNKNOWN');
});

test('dispatch rejection is forwarded immediately as a bounded explicit error', async () => {
  const t = transport({ delegate: async () => { throw new Error('Approval rejected'); } });
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.phase, 'delivered');
  assert.deepEqual(t.delivered, [{ sequence: 1, model, taskId: null, error: { code: 'model_error', message: 'Approval rejected' } }]);
  assert.equal(t.clock.at, 10);
  const long = transport({ delegate: async () => { throw new Error('x'.repeat(900)); } });
  await coordinateDispatch({}, long.callbacks);
  assert.equal(long.delivered[0].error.message.length, 512);
});

test('concurrent resumes cannot duplicate delegate acceptance or status reads', async () => {
  const t = transport();
  const state = {};
  let unlock;
  let first = true;
  t.callbacks.ready = async () => {
    if (!first) return { terminal: false };
    first = false;
    return new Promise(resolve => { unlock = resolve; });
  };
  const pending = coordinateDispatch(state, t.callbacks);
  while (!unlock) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await coordinateDispatch(state, t.callbacks), state);
  t.callbacks.ready = async () => ({ terminal: false });
  unlock({ terminal: false });
  await pending;
  assert.equal(state.phase, 'delivered');
  assert.equal(t.delegated.length, 1);
  assert.deepEqual(t.polled, ['actual-task-1']);
});

test('terminal driver during polling cancels a running task', async () => {
  const t = transport();
  t.callbacks.taskStatus = async () => { t.clock.terminal = true; return { status: 'running' }; };
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.reason, 'driver_terminal');
  assert.deepEqual(t.cancelled, ['actual-task-1']);
  assert.deepEqual(t.delivered, []);
});

async function rejectedTrial(arm, malformed = false, rejectUpdate = false) {
  const out = await mkdtemp(join(tmpdir(), 'tombo-dispatch-'));
  const child = spawn(process.execPath, ['scripts/metacognition-host-trial.mjs', '--case', 'work-01', '--arm', arm, '--origin', 'fixture', '--out', out]);
  let stderr = '', done, request, bridge;
  child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.on('close', resolve));
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('REQUEST ')) {
        const frame = JSON.parse(line.slice(8));
        request = JSON.parse(await readFile(frame.path, 'utf8'));
        bridge = JSON.parse(await readFile(frame.bridgePath, 'utf8'));
        assert.equal(frame.deadlineAt, bridge.deadlineAt);
        if (rejectUpdate && frame.sequence === 1) {
          const proposal = {
            claims: [{ id: 'c1', role: 'answer_claim', text: 'Replay is safe.', scope: 'trial' }],
            lenses: [{ id: 'l1', label: 'Replay', rationale: 'Check replay.', origin: 'initial', status: 'active' }],
            gaps: [{ id: 'g1', kind: 'unsupported_claim', lensId: 'l1', question: 'Does replay duplicate fulfilment?', triggerRefs: ['c1'], whyItMatters: 'Readiness depends on replay.', importance: 'required', claimIds: ['c1'], probeIds: ['p1'] }],
            probes: [{ id: 'p1', gapIds: ['g1'], method: 'counterexample', question: 'Read replay evidence.', requiredCapability: 'read_record', sourceGroups: ['replay-report'], successCondition: 'One row.', refutationCondition: 'Two rows.', inconclusiveCondition: 'No evidence.' }]
          };
          child.stdin.write(JSON.stringify({ sequence: frame.sequence, model, taskId: 'fixture-inspect', output: JSON.stringify(proposal) }) + '\n');
          continue;
        }
        child.stdin.write(JSON.stringify({ sequence: frame.sequence, model, taskId: null, error: { code: 'model_error', message: malformed ? 'x'.repeat(513) : 'Approval rejected' } }) + '\n');
      } else if (line.startsWith('DONE ')) done = JSON.parse(line.slice(5));
    }
    assert.equal(await exited, 0, stderr);
    assert.ok(done);
    return { request, bridge, run: JSON.parse(await readFile(done.runPath, 'utf8')), trace: JSON.parse(await readFile(done.tracePath, 'utf8')), result: JSON.parse(await readFile(done.resultPath, 'utf8')) };
  } finally { child.kill(); await rm(out, { recursive: true, force: true }); }
}

for (const arm of ['baseline', 'tombo']) test(`${arm} real driver records rejection promptly and keeps bridge metadata out of the participant request`, async () => {
  const { request, bridge, run, trace } = await rejectedTrial(arm);
  assert.equal(run.status, 'error');
  assert.equal(run.observed.calls, 1);
  assert.equal(run.observed.modelCalls, 1);
  assert.deepEqual(run.checks, []);
  assert.deepEqual(JSON.parse(run.output).uncertainties, ['model_error']);
  assert.equal(bridge.deadlineAt - bridge.startedAt, run.requested.maximumElapsedMs);
  assert.equal(request.deadlineAt, undefined);
  assert.equal(request.model, undefined);
  assert.equal(request.bridge, undefined);
  assert.equal(/"(family|split|control|annotation)"/.test(JSON.stringify(request)), false);
  assert.equal(trace.events.find(e => e.kind === 'dispatch_failure').message, 'Approval rejected');
  assert.equal(trace.events.at(-1).kind, 'done');
});

test('real driver rejects an oversized transport failure message', async () => {
  const { run } = await rejectedTrial('baseline', true);
  assert.equal(run.status, 'error');
  assert.deepEqual(JSON.parse(run.output).uncertainties, ['invalid_host_binding']);
});


test('serialised active state resumes the same accepted task', async () => {
  const t = transport({ taskStatus: async () => ({ status: 'running' }) });
  const active = await coordinateDispatch({}, t.callbacks);
  const resumed = JSON.parse(JSON.stringify(active));
  t.callbacks.taskStatus = async id => { t.polled.push(id); return { status: 'completed', output }; };
  await coordinateDispatch(resumed, t.callbacks);
  assert.equal(resumed.phase, 'delivered');
  assert.equal(t.delegated.length, 1);
  assert.deepEqual(t.polled, ['actual-task-1']);
  assert.equal(t.delivered[0].taskId, 'actual-task-1');
  assert.equal(resumed.request, undefined);
});

test('deadline reached during failed status read still cancels the task', async () => {
  const t = transport();
  t.callbacks.taskStatus = async () => { t.clock.at = 100; throw new Error('Transport unavailable'); };
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.reason, 'deadline_expired');
  assert.deepEqual(t.cancelled, ['actual-task-1']);
});

test('cancel failure records the unknown upstream outcome and does not redispatch', async () => {
  const t = transport({ taskStatus: async () => ({ status: 'running' }), taskCancel: async () => { throw new Error('Cancellation unavailable'); } });
  const state = await coordinateDispatch({}, t.callbacks);
  t.clock.at = 100;
  await coordinateDispatch(state, t.callbacks);
  await coordinateDispatch(state, t.callbacks);
  assert.equal(state.reason, 'deadline_expired');
  assert.equal(t.events.find(e => e.kind === 'cancel_failed').message, 'Cancellation unavailable');
  assert.equal(t.events.find(e => e.kind === 'cancel_failed').cost, 'UNKNOWN');
  assert.equal(t.delegated.length, 1);
});

test('a terminal driver prevents even loading participant data', async () => {
  const t = transport({ load: async () => { throw new Error('Must not read'); } });
  t.clock.terminal = true;
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.reason, 'driver_terminal');
});

test('TOMBO update rejection retains source usage and pending observations', async () => {
  const { run, result, request } = await rejectedTrial('tombo', false, true);
  assert.equal(request.stage, 'update');
  assert.equal(run.status, 'error');
  assert.equal(run.observed.calls, 3);
  assert.equal(run.observed.modelCalls, 2);
  assert.equal(run.checks[0].sourceId, 'replay-report');
  const state = result.result.state;
  assert.equal(state.stopReason, 'model_error');
  assert.equal(state.appliedExecutions.length, 1);
  assert.deepEqual(state.pendingAssessmentExecutionIds, [state.appliedExecutions[0].executionId]);
  assert.equal(state.evidence.some(e => e.sourceGroup === 'replay-report'), true);
  assert.equal(state.claims[0].status, 'unverified');
});

test('transient ready read failure resumes the same known handle', async () => {
  const t = transport();
  const state = { phase: 'active', taskId: 'existing-task', bridge: t.bridge };
  let reads = 0;
  t.callbacks.ready = async () => { if (++reads === 1) throw new Error('Transient readiness read failure'); return { terminal: false }; };
  await assert.rejects(coordinateDispatch(state, t.callbacks), /Transient readiness read failure/);
  assert.equal(state.phase, 'active');
  await coordinateDispatch(state, t.callbacks);
  assert.equal(state.phase, 'delivered');
  assert.deepEqual(t.polled, ['existing-task']);
  assert.deepEqual(t.delivered, [{ sequence: 1, model, taskId: 'existing-task', output }]);
  assert.deepEqual(t.delegated, []);
});

test('ready read failure before delegation can safely retry the new request', async () => {
  const t = transport();
  const state = {};
  let reads = 0;
  t.callbacks.ready = async () => { if (++reads === 1) throw new Error('Read unavailable'); return { terminal: false }; };
  await assert.rejects(coordinateDispatch(state, t.callbacks), /Read unavailable/);
  assert.equal(state.phase, 'new');
  await coordinateDispatch(state, t.callbacks);
  assert.equal(state.phase, 'delivered');
  assert.equal(t.delivered[0].output, output);
  assert.equal(t.delegated.length, 1);
});

test('transient load read failure can retry without reserving a delegated task', async () => {
  const t = transport();
  const state = {};
  let reads = 0;
  t.callbacks.load = async () => { if (++reads === 1) throw new Error('Request read unavailable'); return { request: t.request, bridge: t.bridge }; };
  await assert.rejects(coordinateDispatch(state, t.callbacks), /Request read unavailable/);
  assert.equal(state.phase, 'new');
  await coordinateDispatch(state, t.callbacks);
  assert.equal(state.phase, 'delivered');
  assert.equal(t.delivered[0].output, output);
  assert.equal(t.delegated.length, 1);
});

test('transient status read failure resumes the accepted handle and delivers its result', async () => {
  const t = transport();
  let reads = 0;
  t.callbacks.taskStatus = async id => { t.polled.push(id); if (++reads === 1) throw new Error('Status read unavailable'); return { status: 'completed', output }; };
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.phase, 'active');
  await coordinateDispatch(state, t.callbacks);
  assert.equal(state.phase, 'delivered');
  assert.deepEqual(t.polled, ['actual-task-1', 'actual-task-1']);
  assert.equal(t.delivered[0].output, output);
  assert.equal(t.delegated.length, 1);
});

test('ready failure after uncertain delegate rejection cannot redispatch the request', async () => {
  const t = transport();
  const state = {};
  let readiness = 0, delegations = 0;
  t.callbacks.ready = async () => { if (++readiness === 3) throw new Error('Read unavailable after dispatch'); return { terminal: false }; };
  t.callbacks.delegate = async () => { delegations++; throw new Error('Delegate transport failed'); };
  await assert.rejects(coordinateDispatch(state, t.callbacks), /Read unavailable after dispatch/);
  assert.equal(state.phase, 'dispatching');
  await coordinateDispatch(state, t.callbacks);
  assert.equal(delegations, 1);
  assert.equal(state.phase, 'dispatching');
  assert.equal(t.events.find(e => e.kind === 'dispatch_failure').message, 'Delegate transport failed');
});

test('ready read failure at deadline cancels an accepted task and keeps it terminal', async () => {
  const t = transport();
  const state = { phase: 'active', taskId: 'existing-task', bridge: t.bridge };
  t.callbacks.ready = async () => { t.clock.at = 100; throw new Error('Late readiness failure'); };
  await assert.rejects(coordinateDispatch(state, t.callbacks), /Late readiness failure/);
  assert.equal(state.phase, 'stopped');
  assert.equal(state.reason, 'deadline_expired');
  assert.deepEqual(t.cancelled, ['existing-task']);
  await coordinateDispatch(state, t.callbacks);
  assert.deepEqual(t.cancelled, ['existing-task']);
});

for (const failedKind of ['dispatch_stopped', 'cancel_requested']) test(`logging failure at ${failedKind} cannot suppress cancellation`, async () => {
  const t = transport();
  const state = { phase: 'active', taskId: 'existing-task', bridge: t.bridge };
  t.callbacks.record = async event => { if (event.kind === failedKind) throw new Error('Audit write failed'); t.events.push(event); };
  t.clock.at = 100;
  await coordinateDispatch(state, t.callbacks);
  await coordinateDispatch(state, t.callbacks);
  assert.equal(state.phase, 'stopped');
  assert.deepEqual(t.cancelled, ['existing-task']);
  assert.equal(state.recordError, 'Audit write failed');
});

test('delegate communication failure keeps actual acceptance unknown', async () => {
  const t = transport({ delegate: async () => { throw new Error('Client timeout after send'); } });
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.phase, 'delivered');
  assert.equal(state.acceptance, 'unknown');
  assert.deepEqual(t.delivered, [{ sequence: 1, model, taskId: null, error: { code: 'model_error', message: 'Client timeout after send' } }]);
  const failure = t.events.find(e => e.kind === 'dispatch_failure');
  assert.equal(failure.actualAcceptanceUnknown, true);
  assert.equal(failure.cost, 'UNKNOWN');
  assert.equal(failure.upstreamAbortGuaranteed, false);
  assert.deepEqual(t.cancelled, []);
});

test('confirmed pre-send rejection is distinguished from unknown acceptance', async () => {
  const t = transport({ delegate: async () => { throw Object.assign(new Error('Approval rejected before send'), { rejectedBeforeAcceptance: true }); } });
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.acceptance, 'rejected');
  assert.equal(t.events.find(e => e.kind === 'dispatch_failure').actualAcceptanceUnknown, false);
  assert.equal(t.delivered[0].taskId, null);
});

test('delegate exception with a known accepted ID stops the driver and cancels that task', async () => {
  const t = transport({ delegate: async () => { throw Object.assign(new Error('Accepted response interrupted'), { acceptedTaskId: 'accepted-before-error' }); } });
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.taskId, 'accepted-before-error');
  assert.equal(state.acceptance, 'accepted');
  assert.equal(state.phase, 'stopped');
  assert.deepEqual(t.cancelled, ['accepted-before-error']);
  assert.equal(t.delivered[0].taskId, 'accepted-before-error');
  assert.equal(t.delivered[0].error.code, 'model_error');
});

test('undefined load result becomes an explicit invalid bridge terminal state', async () => {
  const t = transport({ load: async () => undefined });
  const state = {};
  await assert.rejects(coordinateDispatch(state, t.callbacks), /Invalid host bridge metadata/);
  assert.equal(state.phase, 'stopped');
  assert.equal(state.reason, 'invalid_bridge');
});

for (const failedKind of ['task_observed', 'request_loaded', 'task_accepted']) test(`telemetry failure at ${failedKind} cannot block or change actual task delivery`, async () => {
  const t = transport();
  const state = failedKind === 'task_observed' ? { phase: 'active', taskId: 'existing-task', bridge: t.bridge } : {};
  let failed = false;
  t.callbacks.record = async event => {
    if (event.kind === failedKind && !failed) { failed = true; throw new Error('Observer write unavailable'); }
    t.events.push(event);
  };
  await coordinateDispatch(state, t.callbacks);
  assert.equal(state.phase, 'delivered');
  assert.equal(state.recordError, 'Observer write unavailable');
  assert.deepEqual(t.delivered, [{ sequence: 1, model, taskId: failedKind === 'task_observed' ? 'existing-task' : 'actual-task-1', output }]);
  assert.deepEqual(t.cancelled, []);
  assert.equal(t.events.some(e => e.kind === 'dispatch_failure'), false);
  await coordinateDispatch(state, t.callbacks);
  assert.equal(t.delegated.length, failedKind === 'task_observed' ? 0 : 1);
  assert.equal(t.delivered.length, 1);
});

test('pending acceptance telemetry cannot expose the same task to concurrent polling', async () => {
  const t = transport();
  const state = {};
  let release;
  t.callbacks.record = async event => { if (event.kind === 'task_accepted') await new Promise(resolve => { release = resolve; }); };
  const pending = coordinateDispatch(state, t.callbacks);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await coordinateDispatch(state, t.callbacks);
  release();
  await pending;
  assert.equal(state.phase, 'delivered');
  assert.deepEqual(t.polled, ['actual-task-1']);
  assert.deepEqual(t.delivered, [{ sequence: 1, model, taskId: 'actual-task-1', output }]);
});

test('accepted delegate exception and failed delivery still cancel the known task once', async () => {
  const t = transport({
    delegate: async () => { throw Object.assign(new Error('Accepted response interrupted'), { acceptedTaskId: 'accepted-before-delivery-error' }); },
    deliver: async () => { throw new Error('EPIPE'); },
  });
  const state = await coordinateDispatch({}, t.callbacks);
  assert.equal(state.phase, 'stopped');
  assert.equal(state.reason, 'delivery_failed');
  assert.equal(state.taskId, 'accepted-before-delivery-error');
  assert.deepEqual(t.cancelled, ['accepted-before-delivery-error']);
  await coordinateDispatch(state, t.callbacks);
  assert.deepEqual(t.cancelled, ['accepted-before-delivery-error']);
  assert.equal(t.events.find(e => e.kind === 'delivery_failed').message, 'EPIPE');
  assert.equal(t.events.find(e => e.kind === 'cancel_returned').upstreamAbortGuaranteed, false);
});
