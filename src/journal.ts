import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TomboError, validateState } from './core.js';
import { stateSchema, type UnderstandingState } from './types.js';

type Event = {
  schemaVersion: '0.1';
  sequence: number;
  expectedRevision: number;
  previousHash: string | null;
  stateHash: string;
  state: UnderstandingState;
};

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stateShape(value: unknown): UnderstandingState {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) throw new TomboError('invalid_input', 'Invalid journal state shape.');
  return parsed.data;
}

function redact(state: UnderstandingState): UnderstandingState {
  const result = structuredClone(state);
  for (const evidence of [...result.evidence, ...result.task.evidence]) {
    evidence.passage = '';
    evidence.passageUnavailable = true;
  }
  return result;
}

async function readEvents(path: string): Promise<Event[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (text && !text.endsWith('\n')) throw new TomboError('invalid_ledger', 'The journal ends with an incomplete event. Preserve it and recover explicitly.');
  const events: Event[] = [];
  for (const line of text.split('\n').filter(Boolean)) {
    let event: Event;
    try {
      event = JSON.parse(line) as Event;
      event.state = validateState(event.state);
    } catch {
      throw new TomboError('invalid_ledger', 'A journal event or state is invalid.');
    }
    const previous = events.at(-1);
    if (event.schemaVersion !== '0.1' || event.sequence !== events.length ||
      event.expectedRevision !== (previous?.state.revision ?? -1) ||
      event.previousHash !== (previous ? digest(previous) : null) ||
      event.stateHash !== digest(event.state) ||
      (previous && (event.state.revision !== previous.state.revision + 1 || event.state.taskId !== previous.state.taskId))) {
      throw new TomboError('invalid_ledger', 'Journal sequence, revision, task or digest mismatch.');
    }
    events.push(event);
  }
  return events;
}

export async function replayJournal(path: string): Promise<UnderstandingState> {
  const state = (await readEvents(path)).at(-1)?.state;
  if (!state) throw new TomboError('invalid_ledger', 'The journal contains no state.');
  return structuredClone(state);
}

export class FileJournal {
  constructor(readonly path: string, readonly cachePath?: string) {
    const normalise = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
    if (cachePath && (normalise(path) === normalise(cachePath) || normalise(`${path}.lock`) === normalise(cachePath))) {
      throw new TomboError('invalid_input', 'The cache must differ from the journal and its lock.');
    }
  }

  async load(): Promise<UnderstandingState | null> {
    return (await readEvents(this.path)).at(-1)?.state ?? null;
  }

  async assertCurrent(value: unknown): Promise<void> {
    const state = value === null ? null : stateShape(value);
    if (!isDeepStrictEqual(state === null ? null : redact(state), await this.load())) {
      throw new TomboError('revision_conflict', 'Reload the authoritative journal state before running this command.');
    }
    if (state !== null) validateState(state);
  }

  async commit(expectedRevision: number, value: UnderstandingState): Promise<{ cacheWritten: boolean }> {
    const state = stateShape(value);
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TomboError('revision_conflict', 'Another writer owns the journal. Retry after reloading; preserve stale locks for explicit recovery.');
      throw error;
    }
    try {
      const events = await readEvents(this.path);
      const previous = events.at(-1);
      const saved = redact(state);
      if ((previous?.state.revision ?? -1) !== expectedRevision ||
        (previous && (state.revision !== previous.state.revision + 1 || state.taskId !== previous.state.taskId || !isDeepStrictEqual(saved.task, previous.state.task)))) {
        throw new TomboError('revision_conflict', 'Reload the latest state before committing.');
      }
      validateState(state);
      const event: Event = {
        schemaVersion: '0.1', sequence: events.length, expectedRevision,
        previousHash: previous ? digest(previous) : null, stateHash: digest(saved), state: saved,
      };
      const file = await open(this.path, 'a');
      try {
        await file.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      if (!this.cachePath) return { cacheWritten: false };
      const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.cachePath), { recursive: true });
        await import('node:fs/promises').then(fs => fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8'));
        await rename(temporary, this.cachePath);
        return { cacheWritten: true };
      } catch {
        await unlink(temporary).catch(() => undefined);
        return { cacheWritten: false };
      }
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
