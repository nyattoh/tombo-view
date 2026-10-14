import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGuardedHostSession } from '../scripts/metacognition-host-session.mjs';
import { coordinateDispatch } from '../scripts/metacognition-dispatch.mjs';
import { createT3Transport } from '../scripts/metacognition-t3-transport.mjs';

async function fixture({ terminal = false, expired = false, partial = false, existing = false, truncated = false, auditCollision = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tombo-session-'));
  const out = join(root, 'results', 'framing', 'sample', 'tombo-r1');
  const replies = [], accepted = [], observations = [];
  const model = { provider: 'codex', name: 'test-model', effort: 'low' };
  let complete = terminal, polls = 0, truncatedOnce = false;
  const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value));
  const publish = sequence => {
    save(`request-${sequence}.json`, { sequence, stage: sequence === 1 ? 'inspect' : 'update', instructions: truncated ? 'あ'.repeat(47000) : 'No tools. Return JSON.', marker: `exact-${sequence}` });
    save(`bridge-${sequence}.json`, { version: 1, sequence, stage: sequence === 1 ? 'inspect' : 'update', startedAt: Date.now(), deadlineAt: expired ? Date.now() - 1 : Date.now() + 10000, model });
  };
  const finish = () => { complete = true; save('run.json', { status: 'finished', replies }); };
  if (existing) mkdirSync(out, { recursive: true });
  const tools = {
    exec_command: async ({ cmd }) => {
      if (cmd.startsWith('node scripts/')) {
        mkdirSync(out, { recursive: true });
        publish(1);
        if (auditCollision) writeFileSync(join(out, 'dispatch-events.json'), Buffer.from([0, 255, 13, 10, 65]));
        if (partial) writeFileSync(join(out, 'bridge-1.json'), '{"sequence":');
        if (terminal) finish();
        return { session_id: 7, output: '\x1b[32mREQUEST {"sequence":1,"path":"wrapped\r\npath"}\x1b[0m\n' };
      }
      const script = cmd.slice("node --input-type=module -e '".length, -1).replaceAll("''", "'");
      const mapped = script.replace(/"(?:[^"\\]|\\.)*"/g, literal => {
        const value = JSON.parse(literal);
        if (!value.startsWith(root)) return literal;
        return JSON.stringify(join(root, ...value.slice(root.length).split(/[\\/]/).filter(Boolean)));
      });
      let output = execFileSync(process.execPath, ['--input-type=module', '-e', mapped], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (truncated && !truncatedOnce && mapped.includes('const requestPath=')) { output = output.slice(0, 10000); truncatedOnce = true; }
      return { exit_code: 0, output };
    },
    write_stdin: async ({ chars }) => {
      if (!chars) {
        polls++;
        if (partial && polls === 1) publish(1);
        if (expired) finish();
        return { output: 'EST {"sequence":999}\nDONE fake screen fragment\n', ...(complete ? { exit_code: 0 } : {}) };
      }
      const reply = JSON.parse(chars);
      replies.push(reply);
      if (reply.sequence === 1) publish(2);
      else finish();
      return { output: '\x1b[?25lREQU\nEST {"sequence":2,"path":"split\r\npath"}\x1b[0m\n', ...(complete ? { exit_code: 0 } : {}) };
    },
  };
  const delegationTools = {
    delegate_task: async input => {
      const request = JSON.parse(input.task.slice(input.task.indexOf('\n') + 1));
      if (truncated) assert.equal(request.instructions, 'あ'.repeat(47000));
      accepted.push({ id: input.clientRequestId, marker: request.marker });
      return { taskId: `actual-${request.sequence}`, providerInstanceId: 'codex', model: 'test-model' };
    },
    task_status: async ({ taskId }) => ({ taskId, status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: taskId === 'actual-1' ? '{"exact":"first"}' : '{"exact":"second"}', providerInstanceId: 'codex', model: 'test-model' }),
    task_cancel: async () => { throw new Error('Completed fixture tasks must not be cancelled.'); },
  };
  try {
    const run = await runGuardedHostSession({ tools, coordinateDispatch, createT3Transport, config: { repositoryRoot: root, directory: 'results/framing', caseId: 'sample', arm: 'tombo', repeat: 1, casesPath: 'unused', protocolPath: 'unused', target: { providerInstanceId: 'codex', model: 'test-model' }, clientRequestId: 'framing', delegationTools }, onEvent: event => observations.push(event) });
    return { run, accepted, observations, dispatches: JSON.parse(readFileSync(join(out, 'dispatch-events.json'), 'utf8')) };
  } catch (error) {
    if (auditCollision) {
      error.retainedAudit = readFileSync(join(out, 'dispatch-events.json'));
      error.finishedRun = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
    }
    throw error;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('machine request files survive wrapped, split and ANSI CLI output across two generations', async () => {
  const value = await fixture();
  assert.deepEqual(value.accepted, [{ id: 'framing-1', marker: 'exact-1' }, { id: 'framing-2', marker: 'exact-2' }]);
  assert.deepEqual(value.run.replies, [
    { sequence: 1, model: { provider: 'codex', name: 'test-model', effort: 'low' }, taskId: 'actual-1', output: '{"exact":"first"}' },
    { sequence: 2, model: { provider: 'codex', name: 'test-model', effort: 'low' }, taskId: 'actual-2', output: '{"exact":"second"}' },
  ]);
  assert.deepEqual(value.dispatches.map(item => item.state.phase), ['delivered', 'delivered']);
});

test('incomplete bridge files recover before any task acceptance', async () => {
  const value = await fixture({ partial: true });
  assert.equal(value.observations.filter(event => event.kind === 'observation-error').length, 1);
  assert.deepEqual(value.accepted, [{ id: 'framing-1', marker: 'exact-1' }, { id: 'framing-2', marker: 'exact-2' }]);
  assert.equal(value.run.replies[1].output, '{"exact":"second"}');
});

test('terminal and expired producers retain the run without new task acceptance', async () => {
  const terminal = await fixture({ terminal: true });
  assert.deepEqual(terminal.run, { status: 'finished', replies: [] });
  assert.deepEqual(terminal.accepted, []);
  const expired = await fixture({ expired: true });
  assert.deepEqual(expired.run, { status: 'finished', replies: [] });
  assert.deepEqual(expired.accepted, []);
  assert.equal(expired.dispatches[0].state.reason, 'deadline_expired');
});

test('retained output directories cannot be reused', async () => {
  await assert.rejects(fixture({ existing: true }), /retained trial directory must not be reused/);
});

test('truncated tool output is recovered from complete machine files before delegation', async () => {
  const value = await fixture({ truncated: true });
  assert.deepEqual(value.accepted, [{ id: 'framing-1', marker: 'exact-1' }, { id: 'framing-2', marker: 'exact-2' }]);
  assert.equal(value.run.replies[1].output, '{\"exact\":\"second\"}');
});

test('an audit file appearing after producer start is retained byte for byte', async () => {
  await assert.rejects(fixture({ auditCollision: true }), error => {
    assert.match(String(error.stderr ?? error.message), /EEXIST/);
    assert.deepEqual(error.retainedAudit, Buffer.from([0, 255, 13, 10, 65]));
    assert.equal(error.finishedRun.status, 'finished');
    assert.equal(error.finishedRun.replies[1].output, '{"exact":"second"}');
    return true;
  });
});
