import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as sdk from '../dist/index.js';

const helper = resolve('skills/tombo-view/scripts/session.mjs');
const { SessionStore, canonicalPath } = await import(pathToFileURL(resolve('skills/tombo-view/scripts/session-store.mjs')).href);
const budget = { maxRounds: 8, maxModelCalls: 12, maxToolCalls: 8, maxElapsedMs: 60000, maxInputChars: 100000, maxOutputTokensPerCall: 4000 };
const packet = (overrides = {}) => ({ schemaVersion: '0.1', taskId: 'platform-contract', goal: 'Explain the current runtime requirement.', mode: 'explain', successCriteria: ['Use the current requirement.'], proposedAnswer: 'Node 24 is required.', reflectionRequired: true, evidence: [], capabilities: ['read'], budget, ...overrides });
const proposal = { claims: [{ id: 'claim', role: 'answer_claim', text: 'Node 24 is required.', scope: 'project' }] };

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-platform-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = join(dir, 'sdk.jsonl'), state = join(dir, 'state.json'), input = join(dir, 'task.json');
  await writeFile(input, JSON.stringify(packet()));
  let seq = 0;
  const json = async value => {
    const path = join(dir, `input-${seq++}.json`);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TOMBO_ROOT: resolve('.') } });
  const call = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  call('activate', '--input', input, '--ledger', ledger, '--out', state);
  const prepared = call('prepare', '--input', input, '--ledger', ledger);
  call('inspect', '--input', input, '--ledger', ledger, '--out', state, '--proposal', await json({ binding: prepared.binding, proposal }));
  return { dir, ledger, state, input, json, run, call };
}

function transitionFrom(prior, time) {
  const task = packet({ taskId: 'platform-transition', goal: 'Explain the updated runtime requirement.', successCriteria: ['Use the updated requirement.'] });
  const passage = 'Please update the task to explain the updated runtime requirement.';
  return {
    task,
    reason: 'The user requested a changed goal.',
    previousSessionId: prior.binding.sessionId,
    userChange: {
      id: 'user-change-platform', kind: 'user_statement', locator: 'conversation:platform-change', receivedAt: time,
      passage, contentHash: sdk.hashPassage(passage), previousGoal: prior.task.goal, newGoal: task.goal,
      previousSuccessCriteria: prior.task.successCriteria, newSuccessCriteria: task.successCriteria,
    },
    hand_over_summary: { unresolvedGapIds: [], unknowns: [] },
  };
}

async function bytes(path) { return readFile(path); }

async function windowsShortPath(path) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$source = @'",
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public static class Pr8TestShortPath {',
    '  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="GetShortPathNameW")]',
    '  public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint bufferLength);',
    '}',
    "'@",
    'Add-Type -TypeDefinition $source -ErrorAction Stop',
    "$longPath = [Environment]::GetEnvironmentVariable('TOMBO_PR8_TEST_LONG_PATH')",
    '$buffer = [Text.StringBuilder]::new(32768)',
    '$written = [Pr8TestShortPath]::GetShortPathName($longPath, $buffer, [uint32]$buffer.Capacity)',
    'if ($written -eq 0 -or $written -ge $buffer.Capacity) { [Console]::Out.WriteLine((@{ ok = $false } | ConvertTo-Json -Compress)); exit 0 }',
    '$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($buffer.ToString()))',
    '[Console]::Out.WriteLine((@{ ok = $true; path = $encoded } | ConvertTo-Json -Compress))',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, TOMBO_PR8_TEST_LONG_PATH: path },
  });
  assert.equal(result.status, 0, 'Windows GetShortPathName probe must complete');
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.ok, true, 'Windows GetShortPathName must return an existing path');
  return Buffer.from(response.path, 'base64').toString('utf16le').replace(/\0+$/, '');
}

test('workspace path spellings acquire the real lock', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-path-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const actualRealpath = await realpath(dir);
  const canonicalOnce = await canonicalPath(dir);
  const canonicalTwice = await canonicalPath(canonicalOnce);
  assert.ok(canonicalOnce === canonicalTwice, 'realpath spelling must remain stable on repeated canonical resolution');
  const workspaces = process.platform === 'win32'
    ? [
      ['lexical', dir],
      ['case-slash', [...dir].map((character, index) => /[a-z]/i.test(character) && index % 2 === 0 ? character.toUpperCase() : character).join('').replaceAll('\\', '/')],
      ['extended-prefix', `\\\\?\\${dir}`],
      ['filesystem-realpath', actualRealpath],
    ]
    : [
      ['canonical', dir],
      ['lexical-dot', `${dir}/.`],
      ['filesystem-realpath', actualRealpath],
    ];
  for (const [label, workspace] of workspaces) {
    const store = new SessionStore(workspace, sdk);
    try {
      assert.equal(await store.withLock(async () => 'locked'), 'locked');
    } catch (error) {
      assert.fail(`real filesystem lock rejected ${label} workspace spelling (${error.code ?? 'unknown'})`);
    }
  }
});

test('workspace spellings preserve same-directory identity and reject redirection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-path-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  const linked = join(dir, 'workspace-link');
  await mkdir(target);
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new SessionStore(linked, sdk).withLock(async () => undefined), error => error.code === 'revision_conflict', 'real workspace redirection must remain rejected');

  if (process.platform === 'win32') {
    const workspace = join(dir, 'component-long-enough-to-have-an-8dot3-alias');
    await mkdir(workspace);
    const short = await windowsShortPath(workspace);
    const normalized = value => win32.resolve(value).replace(/[\\/]+$/g, '').toLowerCase();
    assert.ok(normalized(short) !== normalized(workspace), 'isolated Windows filesystem must provide a distinct 8.3 spelling');
    const [longStat, shortStat] = await Promise.all([stat(workspace, { bigint: true }), stat(short, { bigint: true })]);
    assert.ok(longStat.ino !== 0n && shortStat.ino !== 0n && longStat.dev === shortStat.dev && longStat.ino === shortStat.ino, 'long and short spellings must resolve to the same available file identity');
    const canonical = await realpath(workspace);
    assert.equal(await new SessionStore(canonical, sdk).withLock(async () => 'locked'), 'locked', 'filesystem realpath spelling must acquire the lock');
    try {
      assert.equal(await new SessionStore(short, sdk).withLock(async () => 'locked'), 'locked');
    } catch (error) {
      assert.fail(`same-file 8.3 spelling was rejected (${error.code ?? 'unknown'})`);
    }
  } else {
    const canonical = await realpath(dir);
    const lexical = `${dir}/.`;
    const [canonicalStat, lexicalStat] = await Promise.all([stat(canonical, { bigint: true }), stat(lexical, { bigint: true })]);
    assert.ok(canonicalStat.ino !== 0n && lexicalStat.ino !== 0n && canonicalStat.dev === lexicalStat.dev && canonicalStat.ino === lexicalStat.ino, 'POSIX canonical and lexical paths must identify the same directory');
    for (const workspace of [canonical, lexical]) {
      assert.equal(await new SessionStore(workspace, sdk).withLock(async () => 'locked'), 'locked', 'POSIX canonical and lexical workspace paths must acquire the real lock');
    }
  }
});

test('same-directory aliases activate, validate storage binding, and reopen the same authority', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-alias-reopen-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'component-long-enough-to-have-an-8dot3-alias');
  await mkdir(workspace);
  const alias = process.platform === 'win32' ? await windowsShortPath(workspace) : `${workspace}/.`;
  const ledger = join(workspace, 'sdk.jsonl'), statePath = join(workspace, 'state.json');
  const first = new SessionStore(alias, sdk);
  await first.withLock(async () => {
    await first.load();
    await first.activate(packet(), ledger, statePath);
    await first.validateStorageBinding();
  });
  const sessionId = first.snapshot.binding.sessionId;
  const savedBinding = structuredClone(first.snapshot.binding);
  const canonicalWorkspace = await canonicalPath(workspace);
  assert.ok(savedBinding.workspace === canonicalWorkspace, 'serialized workspace binding must use the canonical physical root');
  assert.ok(savedBinding.ledger === await canonicalPath(ledger), 'activation must bind the canonical SDK ledger');
  assert.ok(savedBinding.statePath === await canonicalPath(statePath), 'activation must bind the canonical state cache');

  const originalJournal = (await readFile(join(workspace, '.session', 'tombo-session.jsonl'), 'utf8')).split('\n')[0];
  const reopened = new SessionStore(canonicalWorkspace, sdk);
  await reopened.withLock(async () => {
    await reopened.load();
    await reopened.validateStorageBinding();
    await reopened.reconcile();
  });
  assert.equal(reopened.snapshot.binding.sessionId, sessionId, 'reopen must retain the same session authority');
  assert.ok(JSON.stringify(reopened.snapshot.binding) === JSON.stringify(savedBinding), 'reopen must retain the exact serialized binding');
  assert.ok((await readFile(join(workspace, '.session', 'tombo-session.jsonl'), 'utf8')).includes(sessionId), 'the same session journal must remain authoritative');
  assert.ok((await readFile(join(workspace, '.session', 'tombo-session.jsonl'), 'utf8')).split('\n')[0] === originalJournal, 'reopen must not rewrite the original authority event');

  const secondWorkspace = join(dir, 'second-long-workspace-component');
  await mkdir(secondWorkspace);
  const secondAlias = process.platform === 'win32' ? await windowsShortPath(secondWorkspace) : `${secondWorkspace}/.`;
  const canonicalStore = new SessionStore(secondWorkspace, sdk);
  await canonicalStore.withLock(async () => {
    await canonicalStore.load();
    await canonicalStore.activate(packet(), join(secondWorkspace, 'sdk.jsonl'), join(secondWorkspace, 'state.json'));
    await canonicalStore.validateStorageBinding();
  });
  const secondBinding = structuredClone(canonicalStore.snapshot.binding);
  const secondSessionId = secondBinding.sessionId;
  const secondJournal = (await readFile(join(secondWorkspace, '.session', 'tombo-session.jsonl'), 'utf8')).split('\n')[0];
  const aliasReopened = new SessionStore(secondAlias, sdk);
  await aliasReopened.withLock(async () => {
    await aliasReopened.load();
    await aliasReopened.validateStorageBinding();
    await aliasReopened.reconcile();
  });
  assert.ok(aliasReopened.snapshot.binding.sessionId === secondSessionId, 'canonical activation and alias reopen must retain one session authority');
  assert.ok(JSON.stringify(aliasReopened.snapshot.binding) === JSON.stringify(secondBinding), 'canonical activation and alias reopen must retain the exact workspace/ledger/state binding');
  assert.ok((await readFile(join(secondWorkspace, '.session', 'tombo-session.jsonl'), 'utf8')).split('\n')[0] === secondJournal, 'alias reopen must not rewrite the original authority event');
});

test('workspace root and ancestor links reject before creating session authority', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-path-ancestors-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const rootTarget = join(dir, 'root-target');
  const rootAlias = join(dir, 'root-alias');
  await mkdir(rootTarget);
  await symlink(rootTarget, rootAlias, linkType);
  await assert.rejects(new SessionStore(rootAlias, sdk).withLock(async () => undefined), error => error.code === 'revision_conflict', 'workspace root redirection must reject');
  await assert.rejects(lstat(join(rootTarget, '.session')), error => error.code === 'ENOENT', 'rejected root path must create no session authority');

  const parentTarget = join(dir, 'parent-target');
  const childWorkspace = join(parentTarget, 'workspace');
  const parentAlias = join(dir, 'parent-alias');
  await mkdir(childWorkspace, { recursive: true });
  await symlink(parentTarget, parentAlias, linkType);
  const ancestorWorkspace = join(parentAlias, 'workspace');
  await assert.rejects(new SessionStore(ancestorWorkspace, sdk).withLock(async () => undefined), error => error.code === 'revision_conflict', 'workspace ancestor redirection must reject');
  await assert.rejects(lstat(join(childWorkspace, '.session')), error => error.code === 'ENOENT', 'rejected ancestor path must create no session authority');
});

test('managed CLI alias activation and platform-specific root link controls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-managed-root-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const input = join(dir, 'task.json');
  await writeFile(input, JSON.stringify(packet()));
  const run = (cwd, ...args) => spawnSync(process.execPath, [helper, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, TOMBO_ROOT: resolve('.') },
  });

  const workspace = join(dir, 'component-long-enough-to-have-an-8dot3-alias');
  await mkdir(workspace);
  const alias = process.platform === 'win32' ? await windowsShortPath(workspace) : `${workspace}/.`;
  if (process.platform === 'win32') {
    const normalised = value => win32.resolve(value).replace(/[\\/]+$/g, '').toLowerCase();
    assert.notEqual(normalised(alias), normalised(workspace), 'managed Windows test must use a distinct 8.3 spelling');
    const [aliasStat, workspaceStat] = await Promise.all([stat(alias, { bigint: true }), stat(workspace, { bigint: true })]);
    assert.ok(aliasStat.ino !== 0n && workspaceStat.ino !== 0n && aliasStat.dev === workspaceStat.dev && aliasStat.ino === workspaceStat.ino, 'managed alias must identify the same real directory');
  }
  const ledger = join(workspace, 'sdk.jsonl'), state = join(workspace, 'state.json');
  const activated = run(alias, 'activate', '--input', input, '--ledger', ledger, '--out', state);
  assert.equal(activated.status, 0, 'actual managed activation must accept the same-directory spelling');
  const activation = JSON.parse(activated.stdout);
  const canonicalWorkspace = await canonicalPath(workspace);
  assert.ok(activation.session.binding.workspace === canonicalWorkspace, 'actual managed activation must bind the canonical physical root');
  assert.ok(activation.session.binding.ledger === await canonicalPath(ledger), 'actual managed activation must bind the canonical SDK ledger');
  assert.ok(activation.session.binding.statePath === await canonicalPath(state), 'actual managed activation must bind the canonical state cache');
  const reopened = run(alias, 'status', '--ledger', ledger, '--out', state);
  assert.equal(reopened.status, 0, 'actual managed status must reopen the same authority');
  assert.ok(JSON.stringify(JSON.parse(reopened.stdout).session.binding) === JSON.stringify(activation.session.binding), 'reopen must preserve the exact session and ledger binding');
  const prepared = run(alias, 'prepare', '--input', input, '--ledger', ledger);
  assert.equal(prepared.status, 0, 'actual managed prepare must validate the same ledger binding');
  assert.equal(JSON.parse(prepared.stdout).binding.taskId, packet().taskId, 'prepare must remain bound to the activated task');
  const longReopen = run(workspace, 'status', '--ledger', ledger, '--out', state);
  assert.equal(longReopen.status, 0, 'long workspace spelling must reopen the alias-created authority');
  assert.ok(JSON.stringify(JSON.parse(longReopen.stdout).session.binding) === JSON.stringify(activation.session.binding), 'short and long spellings must retain the exact same canonical workspace/ledger/state binding');

  const reverseWorkspace = join(dir, 'canonical-activated-long-workspace');
  await mkdir(reverseWorkspace);
  const reverseAlias = process.platform === 'win32' ? await windowsShortPath(reverseWorkspace) : `${reverseWorkspace}/.`;
  const reverseLedger = join(reverseWorkspace, 'sdk.jsonl'), reverseState = join(reverseWorkspace, 'state.json');
  const canonicalActivation = run(reverseWorkspace, 'activate', '--input', input, '--ledger', reverseLedger, '--out', reverseState);
  assert.equal(canonicalActivation.status, 0, 'actual managed canonical activation must succeed');
  const canonicalSession = JSON.parse(canonicalActivation.stdout).session;
  const reverseJournal = (await readFile(join(reverseWorkspace, '.session', 'tombo-session.jsonl'), 'utf8')).split('\n')[0];
  const aliasStatus = run(reverseAlias, 'status', '--ledger', reverseLedger, '--out', reverseState);
  assert.equal(aliasStatus.status, 0, 'actual managed alias cwd must reopen the canonical activation');
  assert.ok(JSON.stringify(JSON.parse(aliasStatus.stdout).session.binding) === JSON.stringify(canonicalSession.binding), 'canonical activation and alias reopen must retain the exact binding');
  assert.ok((await readFile(join(reverseWorkspace, '.session', 'tombo-session.jsonl'), 'utf8')).split('\n')[0] === reverseJournal, 'alias reopen must leave the original authority event unchanged');

  const rootTarget = join(dir, 'root-target');
  await mkdir(rootTarget);
  const rootAlias = join(dir, 'root-alias');
  await symlink(rootTarget, rootAlias, linkType);
  const parentTarget = join(dir, 'parent-target');
  const childWorkspace = join(parentTarget, 'workspace');
  await mkdir(childWorkspace, { recursive: true });
  const parentAlias = join(dir, 'parent-alias');
  await symlink(parentTarget, parentAlias, linkType);
  const ancestorAlias = join(parentAlias, 'workspace');

  if (process.platform === 'win32') {
    const rootResult = run(rootAlias, 'activate', '--input', input, '--ledger', join(rootTarget, 'sdk.jsonl'), '--out', join(rootTarget, 'state.json'));
    assert.equal(rootResult.status, 1, 'actual managed CLI must reject a redirected root');
    assert.equal(JSON.parse(rootResult.stderr).error.code, 'revision_conflict', 'redirected root must fail closed');
    await assert.rejects(lstat(join(rootTarget, '.session')), error => error.code === 'ENOENT', 'redirected root must create no session authority');

    const ancestorResult = run(ancestorAlias, 'activate', '--input', input, '--ledger', join(childWorkspace, 'sdk.jsonl'), '--out', join(childWorkspace, 'state.json'));
    assert.equal(ancestorResult.status, 1, 'actual managed CLI must reject a redirected ancestor');
    assert.equal(JSON.parse(ancestorResult.stderr).error.code, 'revision_conflict', 'redirected ancestor must fail closed');
    await assert.rejects(lstat(join(childWorkspace, '.session')), error => error.code === 'ENOENT', 'redirected ancestor must create no session authority');
  } else {
    await assert.rejects(new SessionStore(rootAlias, sdk).withLock(async () => undefined), error => error.code === 'revision_conflict', 'raw POSIX workspace-root spelling must reject redirection');
    await assert.rejects(lstat(join(rootTarget, '.session')), error => error.code === 'ENOENT', 'raw root rejection must create no session authority');
    await assert.rejects(new SessionStore(ancestorAlias, sdk).withLock(async () => undefined), error => error.code === 'revision_conflict', 'raw POSIX ancestor spelling must reject redirection');
    await assert.rejects(lstat(join(childWorkspace, '.session')), error => error.code === 'ENOENT', 'raw ancestor rejection must create no session authority');

    const cwdProbeCode = "const fs=require('node:fs'),path=require('node:path');const cwd=process.cwd(),canonical=fs.realpathSync(process.env.PR8_CANONICAL_ROOT),a=fs.statSync(cwd,{bigint:true}),b=fs.statSync(canonical,{bigint:true});console.log(JSON.stringify({cwdMatchesAlias:path.resolve(cwd)===path.resolve(process.env.PR8_ROOT_ALIAS),cwdMatchesCanonical:path.resolve(cwd)===path.resolve(canonical),samePhysicalIdentity:a.isDirectory()&&b.isDirectory()&&a.dev!==0n&&b.dev!==0n&&a.ino!==0n&&b.ino!==0n&&a.dev===b.dev&&a.ino===b.ino}));";
    const cwdProbe = spawnSync(process.execPath, ['-e', cwdProbeCode], {
      cwd: rootAlias,
      encoding: 'utf8',
      env: { ...process.env, PR8_ROOT_ALIAS: rootAlias, PR8_CANONICAL_ROOT: rootTarget },
    });
    assert.equal(cwdProbe.status, 0, 'POSIX child cwd spelling observation must complete');
    const cwdObservation = JSON.parse(cwdProbe.stdout);
    assert.equal(cwdObservation.samePhysicalIdentity, true, 'POSIX child cwd must identify the same physical root');
  }
});

test('a session directory junction or symlink remains an unmodified rejected authority', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-session-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace');
  const target = join(dir, 'redirected-session');
  await mkdir(workspace);
  await mkdir(target);
  const authority = join(workspace, '.session');
  await symlink(target, authority, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new SessionStore(workspace, sdk).withLock(async () => undefined), error => error.code === 'revision_conflict', 'session directory redirection must reject');
  assert.equal((await lstat(authority)).isSymbolicLink(), true, 'rejected session redirection must remain intact');
  assert.deepEqual(await readdir(target), [], 'rejected session redirection must create no lock or journal');
});

test('workspace symlink or junction redirection remains rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tombo-path-authority-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  const linked = join(dir, 'workspace-link');
  await mkdir(target);
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const redirected = new SessionStore(linked, sdk);
  await assert.rejects(redirected.withLock(async () => undefined), error => error.code === 'revision_conflict', 'real workspace redirection must remain rejected');
});

test('goal transition rejects non-canonical, impossible and over-skew dates without mutating either authority', async t => {
  const h = await harness(t);
  const store = new SessionStore(h.dir, sdk);
  await store.withLock(async () => { await store.load(); await store.reconcile(); });
  const prior = structuredClone(store.snapshot);
  const paths = [h.ledger, h.state, join(h.dir, '.session', 'tombo-session.jsonl'), join(h.dir, '.session', 'tombo-session.json')];
  const before = await Promise.all(paths.map(bytes));
  const invalidDates = [
    '2026-10-21',
    '2026-10-21T12:00:00',
    '2026-02-30T12:00:00Z',
    new Date(Date.now() + 60_000).toISOString(),
  ];
  for (const receivedAt of invalidDates) {
    await assert.rejects(store.withLock(() => store.transition(transitionFrom(prior, receivedAt), join(h.dir, 'next-sdk.jsonl'), join(h.dir, 'next-state.json'))), error => error.code === 'invalid_input', `transition must reject ${receivedAt}`);
    for (let index = 0; index < paths.length; index++) assert.deepEqual(await bytes(paths[index]), before[index], `authority changed after rejecting ${receivedAt}`);
    assert.equal(store.snapshot.binding.sessionId, prior.binding.sessionId);
    assert.equal(store.snapshot.binding.taskId, prior.binding.taskId);
    assert.equal(store.snapshot.head.revision, prior.head.revision);
    assert.equal(store.snapshot.transitions.length, prior.transitions.length);
  }
  const offsetFuture = new Date(Date.now() + 2000 + 60 * 60 * 1000).toISOString().replace('Z', '+01:00');
  await store.withLock(() => store.transition(transitionFrom(prior, offsetFuture), join(h.dir, 'next-sdk.jsonl'), join(h.dir, 'next-state.json')));
  assert.equal(store.snapshot.binding.taskId, 'platform-transition');
  assert.equal(store.snapshot.transitions.length, 1);
  assert.equal(store.snapshot.transitions[0].userChange.receivedAt, offsetFuture);
});
