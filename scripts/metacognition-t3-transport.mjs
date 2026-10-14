function payload(result) {
  const data = result?.structuredContent ?? (() => {
    const text = result?.content?.find(item => item.type === 'text')?.text;
    if (text === undefined) return result;
    try { return JSON.parse(text); }
    catch (error) { if (result?.isError) return text; throw error; }
  })();
  if (result?.isError) {
    const error = new Error(typeof data === 'string' ? data : data?.message ?? 'T3 tool returned an error.');
    if (typeof data?.acceptedTaskId === 'string' && data.acceptedTaskId.trim()) error.acceptedTaskId = data.acceptedTaskId;
    throw error;
  }
  if (!data || typeof data !== 'object') throw new Error('Invalid T3 result.');
  return data;
}

function bindingError(data, taskId, target) {
  if (data.taskId !== taskId) return 'T3 task ID does not match the accepted handle.';
  if (data.providerInstanceId != null && data.providerInstanceId !== target.providerInstanceId) return 'T3 provider does not match the requested provider.';
  if (data.model != null && data.model !== target.model) return 'T3 model does not match the requested model.';
  return null;
}

export function createT3Transport({ state, load, ready, deliver, tools, clientRequestId, target, now = Date.now, sleep, firstDelegateWaitMs = 0 }) {
  if (!Number.isInteger(firstDelegateWaitMs) || firstDelegateWaitMs < 0 || firstDelegateWaitMs > 50000) throw new Error('firstDelegateWaitMs must be an integer from 0 to 50000.');
  if (typeof clientRequestId !== 'string' || !clientRequestId.trim()) throw new Error('A stable clientRequestId is required.');
  if (!target?.providerInstanceId || !target.model) throw new Error('An explicit T3 target is required.');
  const events = [];
  let completedResult;
  const guard = async bridge => {
    if (now() >= bridge.deadlineAt) throw new Error('Producer deadline expired.');
    if ((await ready()).terminal) throw new Error('Producer is terminal.');
    if (now() >= bridge.deadlineAt) throw new Error('Producer deadline expired.');
  };
  const cancelKnown = async taskId => {
    if (state.cancelRequested) return;
    state.cancelRequested = true;
    try { await callbacks.taskCancel(taskId); }
    catch (error) { events.push({ kind: 'transport_cancel_failed', taskId, message: String(error.message ?? error).slice(0, 512), cost: 'UNKNOWN', upstreamAbortGuaranteed: false }); }
  };
  const callbacks = {
    load, ready, now,
    ...(sleep ? { sleep } : {}),
    record: event => { events.push(JSON.parse(JSON.stringify(event))); },
    delegate: async (request, bridge) => {
      let waitMs;
      try {
        if (bridge.model.provider !== target.providerInstanceId || bridge.model.name !== target.model) throw new Error('T3 target does not match the producer model.');
        await guard(bridge);
        if (firstDelegateWaitMs > 0) {
          waitMs = Math.min(firstDelegateWaitMs, bridge.deadlineAt - now());
          if (waitMs <= 0) throw new Error('Producer deadline expired.');
        }
      } catch (error) {
        error.rejectedBeforeAcceptance = true;
        throw error;
      }
      const result = payload(await tools.delegate_task({
        mode: firstDelegateWaitMs > 0 ? 'wait' : 'async', role: 'test', interactionMode: 'default',
        ...(firstDelegateWaitMs > 0 ? { timeoutMs: waitMs } : {}),
        clientRequestId: `${clientRequestId}-${bridge.sequence}`,
        target,
        task: `${request.instructions}\n${JSON.stringify(request)}`,
      }));
      if (typeof result.taskId !== 'string' || !result.taskId.trim()) throw new Error('T3 returned no accepted task ID.');
      const mismatch = bindingError(result, result.taskId, target);
      if (mismatch) {
        const error = new Error(mismatch);
        error.acceptedTaskId = result.taskId;
        throw error;
      }
      if (firstDelegateWaitMs > 0 && !result.waitTimedOut && result.status === 'completed' && result.workState === 'result_available' && result.hasPendingChildRuns === false) completedResult = result;
      return { taskId: result.taskId };
    },
    taskStatus: async taskId => {
      const result = completedResult?.taskId === taskId ? completedResult : payload(await tools.task_status({ taskId }));
      const mismatch = bindingError(result, taskId, target);
      if (mismatch) {
        await cancelKnown(taskId);
        return { status: 'failed', error: mismatch };
      }
      if (['failed', 'cancelled', 'interrupted'].includes(result.status)) {
        const error = result.summary ?? `T3 task ${result.status}.`;
        state.terminalFailure = { status: result.status, message: String(error).slice(0, 512), hasPendingChildRuns: result.hasPendingChildRuns === true };
        if (result.hasPendingChildRuns === true) await cancelKnown(taskId);
        return { status: result.status === 'interrupted' ? 'failed' : result.status, error };
      }
      if (result.status === 'completed' && result.workState === 'result_available' && result.hasPendingChildRuns === false) return { status: 'completed', output: result.summary };
      return { status: 'running' };
    },
    taskCancel: async taskId => {
      events.push({ kind: 'transport_cancel_requested', taskId, cost: 'UNKNOWN', upstreamAbortGuaranteed: false });
      const result = payload(await tools.task_cancel({ taskId, clientRequestId: `${clientRequestId}-cancel-${state.bridge.sequence}`, reason: 'Producer stopped or its deadline expired.' }));
      if (result.taskId !== taskId) throw new Error('T3 cancellation returned a different task ID.');
      events.push({ kind: 'transport_cancel_returned', taskId, status: result.status, cost: 'UNKNOWN', upstreamAbortGuaranteed: false });
      return result;
    },
    deliver: async reply => {
      await guard(state.bridge);
      return deliver(reply);
    },
  };
  return { callbacks, events };
}
