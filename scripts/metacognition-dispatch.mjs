export async function coordinateDispatch(state, callbacks, { maxPolls = 1, pollMs = 1000 } = {}) {
  const { load, ready, delegate, taskStatus, taskCancel, deliver, record = async () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = callbacks;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || !Number.isFinite(pollMs) || pollMs < 0) throw new Error('Invalid polling bounds.');
  state.phase ??= 'new';
  if (!['new', 'active'].includes(state.phase)) return state;
  const fresh = state.phase === 'new';
  state.phase = 'checking';
  const event = async (kind, details = {}) => {
    try { await record({ kind, at: now(), sequence: state.bridge?.sequence, stage: state.bridge?.stage, taskId: state.taskId ?? null, ...details }); }
    catch (error) { state.recordError ??= String(error?.message ?? error).slice(0, 512); }
  };
  const stop = async reason => {
    state.phase = 'stopped';
    state.reason = reason;
    await event('dispatch_stopped', { reason, upstreamAbortGuaranteed: false, cost: 'UNKNOWN' });
    if (state.taskId && !state.cancelRequested && !['completed', 'failed', 'cancelled'].includes(state.taskState)) {
      state.cancelRequested = true;
      await event('cancel_requested', { upstreamAbortGuaranteed: false, cost: 'UNKNOWN' });
      try {
        await taskCancel(state.taskId);
        await event('cancel_returned', { upstreamAbortGuaranteed: false, cost: 'UNKNOWN' });
      } catch (error) {
        await event('cancel_failed', { message: String(error.message ?? error).slice(0, 512), upstreamAbortGuaranteed: false, cost: 'UNKNOWN' });
      }
    }
    return false;
  };
  const readReady = async () => {
    try { return await ready(); }
    catch (error) {
      if (state.taskId) state.phase = 'active';
      else if (['checking', 'loading'].includes(state.phase)) state.phase = 'new';
      await event('ready_failed', { message: String(error.message ?? error).slice(0, 512) });
      if (state.bridge && now() >= state.bridge.deadlineAt) await stop('deadline_expired');
      throw error;
    }
  };
  const live = async () => {
    if (now() >= state.bridge.deadlineAt) return stop('deadline_expired');
    const driver = await readReady();
    if (driver.terminal) return stop('driver_terminal');
    if (now() >= state.bridge.deadlineAt) return stop('deadline_expired');
    return true;
  };
  const send = async reply => {
    if (!await live()) return;
    state.phase = 'delivering';
    try {
      await deliver(reply);
      state.phase = 'delivered';
      await event('reply_delivered', { errorCode: reply.error?.code ?? null });
    } catch (error) {
      state.phase = 'stopped';
      state.reason = 'delivery_failed';
      await event('delivery_failed', { message: String(error.message ?? error).slice(0, 512) });
    }
  };
  const failure = async error => {
    await event('dispatch_failure', { message: String(error.message ?? error).slice(0, 512), actualAcceptanceUnknown: state.acceptance === 'unknown', cost: 'UNKNOWN', upstreamAbortGuaranteed: false });
    await send({ sequence: state.bridge.sequence, model: state.bridge.model, taskId: state.taskId ?? null, error: { code: 'model_error', message: String(error.message ?? error).slice(0, 512) || 'Dispatch failed.' } });
  };
  if (fresh) {
    if (state.bridge && now() >= state.bridge.deadlineAt) { await stop('deadline_expired'); return state; }
    const driver = await readReady();
    if (driver.terminal) { await stop('driver_terminal'); return state; }
    if (state.bridge && now() >= state.bridge.deadlineAt) { await stop('deadline_expired'); return state; }
    state.phase = 'loading';
    let loaded;
    try { loaded = await load(); }
    catch (error) {
      state.phase = 'new';
      await event('load_failed', { message: String(error.message ?? error).slice(0, 512) });
      if (state.bridge && now() >= state.bridge.deadlineAt) await stop('deadline_expired');
      throw error;
    }
    const { request, bridge } = loaded ?? {};
    state.bridge = bridge;
    if (!bridge || !Number.isSafeInteger(bridge.deadlineAt) || bridge.sequence !== request?.sequence || bridge.stage !== request?.stage || !bridge.model) {
      state.phase = 'stopped';
      state.reason = 'invalid_bridge';
      throw new Error('Invalid host bridge metadata.');
    }
    await event('request_loaded');
    if (!await live()) return state;
    state.phase = 'dispatching';
    state.acceptance = 'unknown';
    try {
      const accepted = await delegate(request, bridge);
      if (typeof accepted?.taskId !== 'string' || !accepted.taskId.trim()) throw new Error('Delegate returned no accepted task ID.');
      state.taskId = accepted.taskId;
      state.acceptance = 'accepted';
      await event('task_accepted');
    } catch (error) {
      if (!state.taskId && typeof error.acceptedTaskId === 'string' && error.acceptedTaskId.trim()) state.taskId = error.acceptedTaskId;
      state.acceptance = state.taskId ? 'accepted' : error.rejectedBeforeAcceptance === true ? 'rejected' : 'unknown';
      try { await failure(error); }
      finally {
        if (state.taskId && !state.cancelRequested && !['completed', 'failed', 'cancelled'].includes(state.taskState)) await stop(state.reason ?? 'delegate_failed');
      }
      return state;
    }
  }
  if (!await live()) return state;
  state.phase = 'polling';
  for (let poll = 0; poll < maxPolls; poll++) {
    let result;
    try { result = await taskStatus(state.taskId); }
    catch (error) { await event('status_failed', { message: String(error.message ?? error).slice(0, 512) }); if (await live()) state.phase = 'active'; return state; }
    state.taskState = result.status;
    await event('task_observed', { status: result.status });
    if (result.status === 'completed') {
      if (typeof result.output !== 'string') await failure(new Error('Completed task returned no output string.'));
      else await send({ sequence: state.bridge.sequence, model: state.bridge.model, taskId: state.taskId, output: result.output });
      return state;
    }
    if (!await live()) return state;
    if (['failed', 'cancelled'].includes(result.status)) { await failure(new Error(result.error || `Task ${result.status}.`)); return state; }
    if (poll + 1 < maxPolls) {
      await sleep(Math.min(pollMs, Math.max(0, state.bridge.deadlineAt - now())));
      if (!await live()) return state;
    }
  }
  state.phase = 'active';
  return state;
}
