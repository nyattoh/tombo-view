import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const normal = path => process.platform === 'win32' ? path.toLowerCase() : path;
export async function canonicalPath(path) {
  const absolute = resolve(path);
  try { return normal(await realpath(absolute)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return normal(join(await canonicalPath(parent), relative(parent, absolute)));
  }
}
export function redacted(state) {
  const saved = structuredClone(state);
  for (const item of [...saved.evidence, ...saved.task.evidence]) { item.passage = ''; item.passageUnavailable = true; }
  return saved;
}
const taskSnapshot = task => ({ ...structuredClone(task), evidence: task.evidence.map(item => ({ ...item, passage: '', passageUnavailable: true })) });
export const taskDigest = task => digest(taskSnapshot(task));
export const stateDigest = state => digest(redacted(state));

function isoTime(value) {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function findSessionWorkspace(cwd) {
  let path = resolve(cwd);
  for (;;) {
    if (['tombo-session.jsonl', 'tombo-session.json', 'tombo-session.jsonl.lock'].some(name => existsSync(join(path, '.session', name)))) return path;
    const parent = dirname(path);
    if (parent === path) return null;
    path = parent;
  }
}

export class SessionStore {
  constructor(workspace, sdk) {
    this.workspace = normal(resolve(workspace));
    this.sdk = sdk;
    this.directory = join(this.workspace, '.session');
    this.path = join(this.directory, 'tombo-session.jsonl');
    this.cache = join(this.directory, 'tombo-session.json');
    this.lock = `${this.path}.lock`;
    this.snapshot = null;
    this.events = [];
    this.state = null;
  }

  require(condition, code, message) { if (!condition) throw new this.sdk.TomboError(code, message); }

  async withLock(operation) {
    const workspace = await canonicalPath(this.workspace);
    this.require(workspace === this.workspace, 'revision_conflict', 'Use the canonical activated workspace.');
    await mkdir(this.directory, { recursive: true });
    this.require(await canonicalPath(this.directory) === normal(resolve(this.directory)), 'revision_conflict', 'Session authority cannot be redirected through a symbolic link.');
    let lock;
    try { lock = await open(this.lock, 'wx'); } catch (error) {
      if (error.code === 'EEXIST') throw new this.sdk.TomboError('revision_conflict', 'Another writer or an interrupted process owns the session lock. Preserve it for explicit recovery.');
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, id: randomUUID() }));
      await lock.sync();
      this.locked = true;
      return await operation();
    } finally { this.locked = false; await lock.close(); await unlink(this.lock); }
  }

  async load() {
    let contents;
    try { contents = await readFile(this.path, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.require(!existsSync(this.cache), 'invalid_ledger', 'Session cache exists without its authority. Preserve and recover the original session journal.');
      this.events = []; this.snapshot = null;
      return null;
    }
    this.require(contents.length > 0 && contents.endsWith('\n'), 'invalid_ledger', 'Session journal is empty or incomplete.');
    const events = [];
    try {
      for (const line of contents.trimEnd().split('\n')) {
        const event = JSON.parse(line), previous = events.at(-1);
        this.require(event.schemaVersion === '0.1' && event.sequence === events.length && event.previousHash === (previous ? digest(previous) : null) && event.snapshotHash === digest(event.snapshot), 'invalid_ledger', 'Session sequence or digest mismatch.');
        const session = event.snapshot, binding = session.binding;
        this.require(binding.workspace === this.workspace && binding.taskId === session.task.taskId && binding.taskHash === taskDigest(session.task) && canonical(binding.budget) === canonical(session.task.budget) && typeof binding.sessionId === 'string' && Array.isArray(session.updates) && Array.isArray(session.transitions), 'invalid_ledger', 'Invalid session binding.');
        this.sdk.taskPacketSchema.parse(session.task);
        this.validateClockHistory(session, previous?.snapshot);
        if (session.pendingOperation?.result) this.sdk.validateState(session.pendingOperation.result);
        if (previous && previous.snapshot.binding.sessionId === binding.sessionId) {
          const prior = previous.snapshot.binding;
          this.require(['workspace', 'ledger', 'statePath', 'taskId', 'taskHash', 'budget'].every(key => canonical(binding[key]) === canonical(prior[key])) && (prior.startedAt === null || binding.startedAt === prior.startedAt), 'invalid_ledger', 'Session identity changed without a transition.');
        }
        events.push(event);
      }
    } catch (error) {
      if (error instanceof this.sdk.TomboError) throw error;
      throw new this.sdk.TomboError('invalid_ledger', 'Invalid session journal.');
    }
    this.events = events;
    this.snapshot = structuredClone(events.at(-1).snapshot);
    return this.snapshot;
  }

  async append() {
    this.require(this.locked, 'revision_conflict', 'An exclusive session lock is required.');
    await this.validateStorageBinding();
    const previous = this.events.at(-1);
    this.validateClockHistory(this.snapshot, previous?.snapshot);
    const event = { schemaVersion: '0.1', sequence: this.events.length, previousHash: previous ? digest(previous) : null, snapshotHash: digest(this.snapshot), snapshot: structuredClone(this.snapshot) };
    const file = await open(this.path, 'a');
    try { await file.writeFile(`${JSON.stringify(event)}\n`); await file.sync(); } finally { await file.close(); }
    this.events.push(event);
    await this.writeCache(this.cache, this.snapshot);
  }

  async writeCache(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(temporary, path);
      return true;
    } catch { await unlink(temporary).catch(() => undefined); return false; }
  }

  async paths(ledger, statePath) {
    this.require(ledger && statePath, 'invalid_input', 'Activation and transition require --ledger and --out for the fixed state cache.');
    const boundLedger = await canonicalPath(resolve(this.workspace, ledger)), boundState = await canonicalPath(resolve(this.workspace, statePath));
    const within = path => { const rel = relative(this.workspace, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
    this.require(within(boundLedger) && within(boundState) && boundLedger !== this.directory && boundState !== this.directory, 'revision_conflict', 'Ledger and state cache must be files inside the fixed workspace.');
    this.require(boundLedger !== boundState && `${boundLedger}.lock` !== boundState && `${boundState}.lock` !== boundLedger, 'invalid_input', 'Ledger, its lock and state cache must differ.');
    const proposed = [boundLedger, `${boundLedger}.lock`, boundState];
    this.require(!proposed.some((path, index) => proposed.slice(index + 1).some(other => pathsOverlap(path, other))) && !proposed.some(path => cacheTemporary(path, boundState)), 'revision_conflict', 'SDK ledger, lock, cache and cache temporary files must not overlap.');
    const current = this.snapshot?.binding;
    const history = (this.snapshot?.transitions ?? []).map(item => item.previous);
    if (current && (current.ledger !== boundLedger || current.statePath !== boundState)) history.push(current);
    const reserved = [this.path, this.cache, this.lock, ...history.flatMap(item => [item.ledger, `${item.ledger}.lock`, item.statePath])];
    const caches = [this.cache, ...history.map(item => item.statePath)];
    this.require(!proposed.some(path => reserved.some(other => pathsOverlap(path, other)) || caches.some(cache => cacheTemporary(path, cache))) && !reserved.some(path => cacheTemporary(path, boundState)), 'revision_conflict', 'SDK paths overlap reserved session or current/historical SDK artifacts or cache temporary names.');
    return { ledger: boundLedger, statePath: boundState };
  }

  async validateStorageBinding() {
    if (!this.snapshot) return;
    const binding = this.snapshot.binding;
    const paths = await this.paths(binding.ledger, binding.statePath);
    this.require(paths.ledger === binding.ledger && paths.statePath === binding.statePath, 'revision_conflict', 'The canonical storage paths no longer match the sealed binding.');
  }

  taskClock(input, now = Date.now()) {
    this.require(input && typeof input === 'object' && Object.keys(input).length === 4 && ['startedAt', 'deadlineAt', 'basis', 'sourceRef'].every(key => Object.hasOwn(input, key)) && ['host_provided', 'first_observed'].includes(input.basis) && typeof input.sourceRef === 'string' && input.sourceRef.trim().length > 0 && isoTime(input.deadlineAt) && (input.startedAt === null ? input.basis === 'host_provided' : isoTime(input.startedAt) && Date.parse(input.startedAt) <= now && Date.parse(input.startedAt) <= Date.parse(input.deadlineAt)), 'invalid_input', 'Task clock requires a timezone-qualified deadline, non-future known start (required for first_observed), basis and sourceRef.');
    return { ...structuredClone(input), recordedAt: new Date(now).toISOString() };
  }

  validateClockHistory(session, previous) {
    const clock = session.taskClock ?? null, stop = session.taskClockStop ?? null;
    if (clock) {
      const { recordedAt, ...input } = clock;
      this.require(isoTime(recordedAt), 'invalid_ledger', 'Invalid recorded task clock time.');
      try { this.taskClock(input, Date.parse(recordedAt)); } catch { throw new this.sdk.TomboError('invalid_ledger', 'Invalid sealed task clock.'); }
    }
    this.require(!stop || clock && Object.keys(stop).length === 2 && stop.reason === 'task_deadline_exceeded' && isoTime(stop.observedAt) && Date.parse(stop.observedAt) >= Date.parse(clock.deadlineAt), 'invalid_ledger', 'Invalid session deadline stop.');
    if (!previous) return;
    if (session.binding.sessionId === previous.binding.sessionId) {
      this.require(canonical(clock) === canonical(previous.taskClock ?? null) && (!previous.taskClockStop || canonical(stop) === canonical(previous.taskClockStop)), 'invalid_ledger', 'The sealed task clock or its first stop changed in the same session.');
      const history = value => value.transitions.map(item => [item.previous.sessionId, item.previous.taskClock ?? null, item.previous.taskClockStop ?? null]);
      this.require(canonical(history(session)) === canonical(history(previous)), 'invalid_ledger', 'Historical task clocks and stops must remain unchanged.');
    } else {
      const archived = session.transitions.at(-1)?.previous;
      this.require(archived?.sessionId === previous.binding.sessionId && canonical(archived.taskClock ?? null) === canonical(previous.taskClock ?? null) && canonical(archived.taskClockStop ?? null) === canonical(previous.taskClockStop ?? null), 'invalid_ledger', 'A transition must retain the previous task clock and stop.');
    }
  }

  clockStatus(now = this.taskClockObservedAt ?? Date.now()) {
    const clock = this.snapshot.taskClock;
    return { coverage: clock?.basis ?? 'unavailable', startedAt: clock?.startedAt ?? null, deadlineAt: clock?.deadlineAt ?? null, observedAt: new Date(now).toISOString(), expired: clock ? !!this.snapshot.taskClockStop || now >= Date.parse(clock.deadlineAt) : null };
  }

  async checkTaskClock() {
    const now = Date.now(), status = this.clockStatus(now);
    this.taskClockObservedAt = now;
    if (status.expired && !this.snapshot.taskClockStop) {
      this.snapshot.taskClockStop = { reason: 'task_deadline_exceeded', observedAt: status.observedAt };
      await this.append();
    }
    return status;
  }

  async activate(taskInput, ledger, statePath, clockInput) {
    const task = this.sdk.taskPacketSchema.parse(taskInput), paths = await this.paths(ledger, statePath);
    const clock = clockInput === undefined ? null : this.taskClock(clockInput);
    if (this.snapshot) {
      this.require(this.snapshot.binding.taskHash === taskDigest(task) && this.snapshot.binding.ledger === paths.ledger && this.snapshot.binding.statePath === paths.statePath, 'revision_conflict', 'This workspace already has a fixed session. Resume it; do not reactivate a new task or budget.');
      if (clock) {
        const { recordedAt, ...sealed } = this.snapshot.taskClock ?? {};
        this.require(canonical(sealed) === canonical(clockInput), 'revision_conflict', 'The original task clock is sealed; it cannot be attached or extended later.');
      }
      const state = await this.reconcile();
      await this.checkTaskClock();
      return state;
    }
    this.require(!existsSync(paths.ledger) && !existsSync(`${paths.ledger}.lock`) && !existsSync(paths.statePath), 'revision_conflict', 'Activation cannot adopt or overwrite unmanaged ledger/state files or an existing SDK lock.');
    this.snapshot = { schemaVersion: '0.1', binding: { sessionId: randomUUID(), workspace: this.workspace, ...paths, taskId: task.taskId, taskHash: taskDigest(task), budget: structuredClone(task.budget), startedAt: null }, task: taskSnapshot(task), taskClock: clock, taskClockStop: null, head: null, updates: [], transitions: [], pendingOperation: null, accountingUncertain: false, lastObservedAt: Date.now(), stopReceipts: [] };
    await this.append();
    await this.checkTaskClock();
    return null;
  }

  async guard(values, { existing = false, inspect = false } = {}) {
    await this.validateStorageBinding();
    const binding = this.snapshot.binding;
    this.require(values.ledger && await canonicalPath(resolve(this.workspace, values.ledger)) === binding.ledger, 'revision_conflict', 'Use the activated ledger explicitly; omission and replacement cannot bypass its authority.');
    if (values.out) this.require(await canonicalPath(resolve(this.workspace, values.out)) === binding.statePath, 'revision_conflict', 'Use the activated state cache; a different --out cannot create a new budget.');
    if (inspect) this.require(this.snapshot.head === null && this.snapshot.pendingOperation === null, 'revision_conflict', 'The activated task has already started. Resume its state rather than inspecting a new task.');
    if (existing) this.require(this.state !== null, 'revision_conflict', 'Inspect the activated task before this operation.');
  }

  async reconcile() {
    await this.validateStorageBinding();
    this.validateClockHistory(this.snapshot, this.events.at(-1)?.snapshot);
    const binding = this.snapshot.binding;
    let current = await new this.sdk.FileJournal(binding.ledger).load();
    const same = (state, reference) => state === null ? reference === null : reference !== null && state.revision === reference.revision && stateDigest(state) === reference.stateHash;
    const pending = this.snapshot.pendingOperation;
    if (pending?.result) {
      const intended = { revision: pending.result.revision, stateHash: stateDigest(pending.result) };
      if (!same(current, intended)) {
        this.require(same(current, pending.before), 'revision_conflict', 'SDK authority diverged from the prepared session commit.');
        await new this.sdk.FileJournal(binding.ledger).commit(pending.before?.revision ?? -1, pending.result);
        current = await new this.sdk.FileJournal(binding.ledger).load();
      }
      this.require(same(current, intended), 'invalid_ledger', 'Cannot recover the prepared SDK commit.');
      this.require(taskDigest(current.task) === binding.taskHash && (binding.startedAt === null || binding.startedAt === current.startedAt), 'revision_conflict', 'SDK task or sealed startedAt changed.');
      binding.startedAt ??= current.startedAt;
      this.snapshot.head = intended;
      if (pending.operation === 'checkpoint') this.snapshot.stopReceipts.push({ revision: current.revision, stateHash: intended.stateHash, stopReason: current.stopReason, usage: current.usage, budgetCheckpoint: pending.context });
      if (pending.operation === 'invalidate') {
        const executionIds = pending.context.discardedExecutionIds.filter(id => !current.pendingAssessmentExecutionIds?.includes(id));
        if (executionIds.length) {
          this.snapshot.discardedAssessments ??= [];
          this.snapshot.discardedAssessments.push({ atRevision: current.revision, executionIds, invalidatedEvidenceIds: pending.context.invalidation.evidenceIds, reason: 'pending_assessment_discarded_by_invalidation' });
        }
      }
      this.markApplied(current, pending.receiptIds ?? []);
      this.snapshot.pendingOperation = null;
      await this.append();
    } else {
      this.require(same(current, this.snapshot.head), 'revision_conflict', 'SDK ledger is ahead, rolled back or differs from its sealed session reference.');
      if (pending && !this.snapshot.accountingUncertain) {
        this.snapshot.accountingUncertain = true;
        await this.append();
      }
    }
    if (current) this.require(taskDigest(current.task) === binding.taskHash && current.startedAt === binding.startedAt, 'revision_conflict', 'SDK task/start binding mismatch.');
    this.state = current;
    return current;
  }

  async begin(operation, context = null, receiptIds = []) {
    this.require(!this.snapshot.pendingOperation && !this.snapshot.accountingUncertain, 'revision_conflict', 'Interrupted generation has uncertain consumption. Preserve the session; do not reset or repeat it.');
    if (operation === 'invalidate') {
      this.invalidation(context?.invalidation);
      this.require(context.previousStopReason === this.state.stopReason && Array.isArray(context.discardedExecutionIds) && new Set(context.discardedExecutionIds).size === context.discardedExecutionIds.length && context.discardedExecutionIds.every(id => this.state.pendingAssessmentExecutionIds?.includes(id)), 'revision_conflict', 'Invalidation context must preserve the actual previous stop and pending batch.');
    }
    this.snapshot.pendingOperation = { id: randomUUID(), operation, before: structuredClone(this.snapshot.head), context, receiptIds, result: null };
    await this.append();
  }

  async stage(state) {
    const pending = this.snapshot.pendingOperation;
    const candidate = structuredClone(state);
    if (pending?.operation === 'invalidate' && pending.context.previousStopReason !== null) {
      candidate.stopReason = pending.context.previousStopReason;
      candidate.decision = 'blocked';
    }
    const parsed = this.sdk.validateState(candidate);
    this.require(pending && taskDigest(parsed.task) === this.snapshot.binding.taskHash, 'revision_conflict', 'The result must belong to the fixed task and an open transaction.');
    const before = pending.before?.revision ?? -1;
    this.require(parsed.revision === before + 1 || (before === -1 && parsed.revision === 1) || (before >= 0 && parsed.revision === before && stateDigest(parsed) === pending.before.stateHash), 'revision_conflict', 'Unexpected SDK result revision.');
    pending.result = redacted(parsed);
    await this.append();
    return parsed;
  }

  async commit(state) {
    const prepared = await this.stage(state);
    const before = this.snapshot.pendingOperation.before;
    if (!before || prepared.revision !== before.revision) await new this.sdk.FileJournal(this.snapshot.binding.ledger).commit(before?.revision ?? -1, prepared);
    await this.reconcile();
    this.state = prepared;
    return prepared;
  }

  async observe() {
    const now = Date.now();
    if (now < this.snapshot.lastObservedAt) {
      this.snapshot.accountingUncertain = true;
      this.snapshot.clockRegression = { observedAt: now, previousObservedAt: this.snapshot.lastObservedAt };
    } else this.snapshot.lastObservedAt = now;
    await this.append();
    return Math.max(now, this.snapshot.lastObservedAt);
  }

  async checkpoint(operation = 'reflect') {
    const now = await this.observe();
    await this.checkTaskClock();
    if (!this.state) return null;
    const { toolCalls, costYen } = this.view().pendingUsage;
    const result = this.sdk.checkpointBudget(this.state, { operation, now, pendingUsage: { toolCalls, costYen } });
    if (result.state.revision !== this.state.revision && !this.snapshot.accountingUncertain) {
      await this.begin('checkpoint', result.budgetCheckpoint);
      await this.commit(result.state);
    }
    this.budgetCheckpoint = result.budgetCheckpoint;
    return result;
  }

  executionMap() {
    const map = new Map(this.state?.appliedExecutions.map(item => [item.executionId, item.payloadHash]) ?? []);
    for (const update of this.snapshot.updates) for (const observation of update.observations) {
      const hash = digest(observation);
      this.require(!map.has(observation.executionId) || map.get(observation.executionId) === hash, 'invalid_input', `Execution payload collision ${observation.executionId}`);
      map.set(observation.executionId, hash);
    }
    return map;
  }

  invalidation(input) {
    this.require(input && typeof input === 'object' && Object.keys(input).length === 2 && Array.isArray(input.evidenceIds) && input.evidenceIds.length > 0 && new Set(input.evidenceIds).size === input.evidenceIds.length && input.evidenceIds.every(id => this.state?.evidence.some(item => item.id === id)) && typeof input.reason === 'string' && input.reason.length > 0, 'invalid_input', 'Invalidation requires unique existing evidenceIds and a non-empty reason, with no extra fields.');
    return { evidenceIds: [...input.evidenceIds], reason: input.reason };
  }

  async receive(input) {
    this.require(input && typeof input.id === 'string' && input.id.length > 0 && input.source && ['document', 'user_statement', 'tool'].includes(input.source.kind) && typeof input.source.locator === 'string' && input.source.locator.length > 0, 'invalid_input', 'A receipt requires id and a source reference; omit an unknown caller date.');
    this.require(Object.keys(input).every(key => ['id', 'source', 'text', 'references', 'observations', 'invalidation'].includes(key)) && Object.keys(input.source).every(key => ['kind', 'locator', 'receivedAt'].includes(key)) && (input.text === undefined || typeof input.text === 'string') && (input.references === undefined || (Array.isArray(input.references) && input.references.every(item => typeof item === 'string' && item.length > 0))) && JSON.stringify(input).length <= this.snapshot.task.budget.maxInputChars, 'invalid_input', 'Receive only bounded text, source metadata, references and observations.');
    this.require((typeof input.text === 'string' && input.text.length > 0) || (Array.isArray(input.references) && input.references.length > 0) || input.observations?.length, 'invalid_input', 'Receive minimal text, references or actual observations.');
    const observations = this.sdk.observationsSchema.parse(input.observations ?? []);
    for (const observation of observations) {
      this.require(observation.outcome === 'completed' || observation.evidence.length === 0, 'invalid_input', 'An unsuccessful observation cannot contain evidence.');
      for (const evidence of observation.evidence) this.require(!evidence.passageUnavailable && evidence.contentHash === this.sdk.hashPassage(evidence.passage), 'invalid_input', 'Received observations must contain actual matching evidence passages.');
    }
    const normalized = { id: input.id, source: input.source, ...(input.text !== undefined ? { text: input.text } : {}), references: input.references ?? [], observations, ...(input.invalidation === undefined ? {} : { invalidation: this.invalidation(input.invalidation) }) };
    const executions = this.executionMap();
    for (const observation of observations) {
      this.require(!executions.has(observation.executionId) || executions.get(observation.executionId) === digest(observation), 'invalid_input', `Execution payload collision ${observation.executionId}`);
      executions.set(observation.executionId, digest(observation));
    }
    const payloadHash = digest(normalized), existing = this.snapshot.updates.find(item => item.id === input.id);
    if (existing) {
      this.require(existing.payloadHash === payloadHash, 'invalid_input', `Receipt payload collision ${input.id}`);
      return existing;
    }
    this.require(this.locked, 'revision_conflict', 'An exclusive session lock is required.');
    const helperNow = Date.now();
    this.require(!Object.hasOwn(input.source, 'receivedAt') || isoTime(input.source.receivedAt) && Date.parse(input.source.receivedAt) <= helperNow + 5000, 'invalid_input', 'New caller receivedAt must be timezone-qualified ISO and no more than 5000ms in the future; omit it if unknown.');
    const update = { ...normalized, payloadHash, helperReceivedAt: new Date(helperNow).toISOString(), status: 'received_unassessed', appliedRevision: null };
    this.snapshot.updates.push(update);
    this.markApplied(this.state, []);
    await this.append();
    return update;
  }

  validateReceipts(ids, observations) {
    const deliveries = new Map(observations.map(item => [item.executionId, digest(item)]));
    for (const id of ids) {
      const update = this.snapshot.updates.find(item => item.id === id);
      this.require(update, 'invalid_input', `Unknown receipt ${id}`);
      this.require(update.observations.length ? update.observations.every(item => deliveries.get(item.executionId) === digest(item)) : observations.some(item => item.evidence.some(evidence => (evidence.passage === update.text && evidence.locator === update.source.locator) || update.references.includes(evidence.locator))), 'invalid_input', 'The receipt must be linked to an actual matching observation.');
    }
  }

  markApplied(state, ids) {
    if (!state) return;
    const pending = new Set(state.pendingAssessmentExecutionIds ?? []);
    const executions = new Map(state.appliedExecutions.filter(item => !pending.has(item.executionId)).map(item => [item.executionId, item.payloadHash]));
    for (const update of this.snapshot.updates) {
      if (update.status === 'applied') continue;
      const discarded = (this.snapshot.discardedAssessments ?? []).filter(record => update.observations.some(item => record.executionIds.includes(item.executionId)));
      const discardedIds = new Set(discarded.flatMap(record => record.executionIds));
      if (discarded.length) update.discardedAssessment = {
        atRevision: discarded.at(-1).atRevision,
        executionIds: update.observations.filter(item => discardedIds.has(item.executionId)).map(item => item.executionId),
        invalidatedEvidenceIds: [...new Set(discarded.flatMap(record => record.invalidatedEvidenceIds))],
        reason: 'pending_assessment_discarded_by_invalidation',
      };
      const remaining = update.observations.filter(item => !discardedIds.has(item.executionId));
      if (update.observations.length ? remaining.every(item => executions.get(item.executionId) === digest(item)) : ids.includes(update.id) && !pending.size && state.stopReason !== 'invalid_model_output') {
        update.status = discarded.length ? 'discarded_unassessed' : 'applied';
        update.appliedRevision = discarded.length ? null : state.revision;
      }
    }
  }

  view() {
    const session = structuredClone(this.snapshot);
    session.pendingUpdates = session.updates.filter(item => item.status === 'received_unassessed');
    session.discardedUpdates = session.updates.filter(item => item.discardedAssessment);
    const applied = new Set(this.state?.appliedExecutions.map(item => item.executionId) ?? []);
    const pending = new Map();
    for (const update of session.updates) for (const observation of update.observations) if (!applied.has(observation.executionId)) pending.set(observation.executionId, observation);
    const observations = [...pending.values()];
    session.pendingUsage = { toolCalls: observations.reduce((sum, item) => sum + item.toolCalls, 0), costYen: observations.some(item => item.costYen === null) ? null : observations.reduce((sum, item) => sum + item.costYen, 0), totalTokens: null, executionIds: [...pending.keys()], observedElapsedMs: observations.map(item => ({ executionId: item.executionId, elapsedMs: item.elapsedMs })) };
    return session;
  }

  async transition(input, ledger, statePath, clockInput) {
    const task = this.sdk.taskPacketSchema.parse(input.task), change = input.userChange, previous = this.snapshot;
    this.require(!previous.pendingOperation && !previous.accountingUncertain && this.state, 'revision_conflict', 'Resolve or explicitly recover the current transaction before a goal transition.');
    this.require(input.previousSessionId === previous.binding.sessionId && typeof input.reason === 'string' && input.reason.length > 0 && change?.kind === 'user_statement' && typeof change.id === 'string' && typeof change.locator === 'string' && change.locator.length > 0 && Number.isFinite(Date.parse(change.receivedAt)) && typeof change.passage === 'string' && change.passage.length > 0 && change.contentHash === this.sdk.hashPassage(change.passage), 'invalid_input', 'Transition requires a referenced, dated user change, not an AI paraphrase.');
    this.require(change.previousGoal === previous.task.goal && change.newGoal === task.goal && canonical(change.previousSuccessCriteria) === canonical(previous.task.successCriteria) && canonical(change.newSuccessCriteria) === canonical(task.successCriteria), 'invalid_input', 'The user change must reference the actual previous and new conditions.');
    this.require(task.taskId !== previous.binding.taskId && (task.goal.trim() !== previous.task.goal.trim() || canonical(task.successCriteria) !== canonical(previous.task.successCriteria)), 'revision_conflict', 'A same-goal follow-up cannot start a new task or budget.');
    const summary = input.hand_over_summary;
    const unresolved = this.state.gaps.filter(item => item.status !== 'resolved').map(item => item.id);
    this.require(summary && Array.isArray(summary.unknowns) && summary.unknowns.every(item => typeof item === 'string' && item.length > 0) && Array.isArray(summary.unresolvedGapIds) && unresolved.every(id => summary.unresolvedGapIds.includes(id)), 'invalid_input', 'Carry unresolved gaps and explicit unknowns into the goal transition.');
    const paths = await this.paths(ledger, statePath);
    const clock = clockInput === undefined ? null : this.taskClock(clockInput);
    this.require(paths.ledger !== previous.binding.ledger && paths.statePath !== previous.binding.statePath && !existsSync(paths.ledger) && !existsSync(`${paths.ledger}.lock`) && !existsSync(paths.statePath), 'revision_conflict', 'A real new goal needs distinct, unused SDK ledger and state paths without a leftover SDK lock.');
    const view = this.view();
    const record = { userChange: structuredClone(change), reason: input.reason, previous: { ...previous.binding, taskClock: previous.taskClock ?? null, taskClockStop: previous.taskClockStop ?? null, revision: this.state.revision, stateHash: stateDigest(this.state), usage: this.state.usage, stopReason: this.state.stopReason, unresolvedGapIds: unresolved, unknowns: summary.unknowns, pendingUpdates: view.pendingUpdates, discardedUpdates: view.discardedUpdates, discardedAssessments: previous.discardedAssessments ?? [], pendingUsage: view.pendingUsage, stopReceipts: previous.stopReceipts } };
    this.snapshot = { schemaVersion: '0.1', binding: { sessionId: randomUUID(), workspace: this.workspace, ...paths, taskId: task.taskId, taskHash: taskDigest(task), budget: structuredClone(task.budget), startedAt: null }, task: taskSnapshot(task), taskClock: clock, taskClockStop: null, head: null, updates: [], transitions: [...previous.transitions, record], pendingOperation: null, accountingUncertain: false, lastObservedAt: Date.now(), stopReceipts: [] };
    this.state = null;
    await this.append();
    await this.checkTaskClock();
  }
}

function withinSession(directory, path) {
  const rel = relative(directory, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function pathsOverlap(left, right) {
  return withinSession(left, right) || withinSession(right, left);
}

function cacheTemporary(path, cache) {
  const name = relative(dirname(cache), path).split(sep)[0];
  const prefix = `${basename(cache)}.`;
  return name.startsWith(prefix) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/i.test(name.slice(prefix.length));
}
