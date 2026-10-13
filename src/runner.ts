import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hashPassage, TomboError, understandingHash } from './core.js';
import { observationSchema, taskPacketSchema, type CriticAdapter, type InspectionResult, type Observation, type Probe, type TaskPacket, type Tombo, type UnderstandingState } from './types.js';

export interface ProbeExecutionInput {
  task: TaskPacket;
  state: UnderstandingState;
  probe: Probe;
  executionId: string;
  signal: AbortSignal;
}
export interface ProbeExecutor {
  execute(input: ProbeExecutionInput): Promise<Observation>;
  estimateMaxCostYen?(input: ProbeExecutionInput): number | Promise<number>;
}
export type RunUnderstandingResult =
  | { status: 'completed'; result: InspectionResult }
  | { status: 'stopped'; reason: string; result: InspectionResult | null };
export interface RunUnderstandingOptions {
  tombo: Tombo;
  task: TaskPacket;
  critic: CriticAdapter;
  executor: ProbeExecutor;
  signal?: AbortSignal;
  maxCycles?: number;
}

async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        abort = () => reject(new TomboError('invalid_input', 'runner_aborted'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        timer = setTimeout(() => reject(new TomboError('invalid_input', 'runner_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

export async function runUnderstandingCheck(options: RunUnderstandingOptions): Promise<RunUnderstandingResult> {
  const { tombo, critic, executor, signal } = options;
  if (!tombo || !critic || typeof critic.reflect !== 'function' || !executor || typeof executor.execute !== 'function') throw new TomboError('invalid_input', 'Explicit Tombo, critic and probe executor are required');
  const maxCycles = options.maxCycles ?? 32;
  if (!Number.isSafeInteger(maxCycles) || maxCycles < 0) throw new TomboError('invalid_input', 'maxCycles must be a nonnegative integer');
  if (signal?.aborted) return { status: 'stopped', reason: 'runner_aborted', result: null };
  const task = taskPacketSchema.parse({ ...options.task, reflectionRequired: true });
  let current = await tombo.inspect(task);
  const stop = (reason: string): RunUnderstandingResult => ({ status: 'stopped', reason, result: current });
  const attempted = new Set<string>();
  for (let cycle = 0; ; cycle++) {
    if (signal?.aborted) return stop('runner_aborted');
    if (current.state.decision === 'ready_for_requested_step') return { status: 'completed', result: current };
    if (current.state.pendingAssessmentExecutionIds) return stop(current.state.stopReason ?? 'assessment_pending');
    if (current.state.decision !== 'needs_check' && current.state.decision !== 'needs_reflection') return stop(current.state.stopReason ?? current.state.decision);
    if (cycle >= maxCycles) return stop('cycle_limit');
    if (current.state.decision === 'needs_reflection') {
      current = await tombo.reflect(current.state, critic);
      continue;
    }
    const state = current.state;
    const budget = state.task.budget;
    if (state.usage.toolCalls >= budget.maxToolCalls || state.usage.rounds >= budget.maxRounds || state.usage.modelCalls >= budget.maxModelCalls) return stop('budget_exhausted');
    const remaining = budget.maxElapsedMs - Math.max(state.usage.elapsedMs, Date.now() - Date.parse(state.startedAt));
    if (remaining <= 0) return stop('budget_exhausted');
    const probe = state.probes.find(item => current.nextProbeIds.includes(item.id) && state.task.capabilities.includes(item.requiredCapability) && (item.status === 'pending' || item.status === 'running'));
    if (!probe) return stop('capability_limit');
    const key = `${understandingHash(state)}:${probe.id}`;
    if (attempted.has(key)) return stop('no_progress');
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const input: ProbeExecutionInput = { task: structuredClone(state.task), state: structuredClone(state), probe: structuredClone(probe), executionId: randomUUID(), signal: controller.signal };
    let failure: string | undefined;
    let observation: Observation;
    let started: number | undefined;
    try {
      if (budget.maxCostYen !== undefined) {
        if (!executor.estimateMaxCostYen || state.usage.costYen === null) return stop('budget_accounting_unavailable');
        let estimate: number;
        try { estimate = await bounded(() => Promise.resolve(executor.estimateMaxCostYen!(input)), controller.signal, remaining); } catch {
          controller.abort();
          return stop(signal?.aborted ? 'runner_aborted' : 'budget_accounting_unavailable');
        }
        if (!Number.isFinite(estimate) || estimate < 0) return stop('budget_accounting_unavailable');
        if (state.usage.costYen + estimate > budget.maxCostYen) return stop('budget_exhausted');
      }
      if (signal?.aborted) return stop('runner_aborted');
      const toolRemaining = budget.maxElapsedMs - Math.max(state.usage.elapsedMs, Date.now() - Date.parse(state.startedAt));
      if (toolRemaining <= 0) return stop('budget_exhausted');
      attempted.add(key);
      started = Date.now();
      try {
        const output = await bounded(() => executor.execute(input), controller.signal, toolRemaining);
        if (signal?.aborted) throw new Error('runner_aborted');
        const parsed = observationSchema.safeParse(output);
        if (!parsed.success || parsed.data.executionId !== input.executionId || parsed.data.probeId !== probe.id || parsed.data.toolCalls !== 1 || parsed.data.evidence.some(item => item.passageUnavailable || hashPassage(item.passage) !== item.contentHash) || (parsed.data.outcome !== 'completed' && parsed.data.evidence.length !== 0)) throw new Error('invalid_probe_output');
        const evidenceIds = parsed.data.evidence.map(item => item.id);
        const otherIds = new Set([...state.claims, ...state.lenses, ...state.gaps, ...state.probes].map(item => item.id));
        if (new Set(evidenceIds).size !== evidenceIds.length || parsed.data.evidence.some(item => {
          const previous = state.evidence.find(old => old.id === item.id);
          return otherIds.has(item.id) || (previous !== undefined && !isDeepStrictEqual(previous, item));
        })) throw new Error('invalid_probe_output');
        observation = { ...parsed.data, elapsedMs: Math.max(parsed.data.elapsedMs, Date.now() - started) };
      } catch (error) {
        failure = error instanceof Error && ['runner_aborted', 'runner_timeout', 'invalid_probe_output'].includes(error.message) ? error.message : 'probe_error';
        controller.abort(failure);
        observation = { executionId: input.executionId, probeId: probe.id, outcome: 'error', evidence: [], toolCalls: 1, elapsedMs: Date.now() - started, costYen: null };
      }
      current = await tombo.update(state, [observation], failure ? { deferAssessment: true } : undefined);
      if (failure) return stop(failure);
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
}
