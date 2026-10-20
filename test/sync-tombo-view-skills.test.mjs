import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const sourceScript = resolve('scripts/sync-tombo-view-skills.ps1');
const isolatedHarness = `
$userProfile = [Environment]::GetFolderPath('UserProfile')
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$destinationRoots = @(
  (Join-Path $userProfile '.claude/skills/tombo-view'),
  (Join-Path $userProfile '.agents/skills/tombo-view'),
  (Join-Path $userProfile '.codex/skills/tombo-view'),
  (Join-Path $localAppData 'hermes/skills/tombo-view')
)
function Test-IsDestinationPath {
  param([string]$Candidate)
  foreach ($root in $destinationRoots) {
    $prefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($Candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $Candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
function Test-Path {
  param([string]$LiteralPath, [string]$PathType)
  if (Test-IsDestinationPath $LiteralPath) {
    if ($env:FORCE_DESTINATION_ABSENT -eq '1') { return $false }
    return $true
  }
  return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath -PathType $PathType
}
function New-Item {
  param([string]$ItemType, [string]$Path, [switch]$Force)
  if (Test-IsDestinationPath $Path) { throw 'NEW_ITEM_INTERCEPTED: destination directory creation was intercepted by the isolated test harness' }
  throw "UNEXPECTED_NEW_ITEM: write outside the isolated destination roots was blocked ($Path)"
}
function Copy-Item {
  param([string]$LiteralPath, [string]$Destination, [switch]$Force)
  if (Test-IsDestinationPath $Destination) { throw 'COPY_ITEM_INTERCEPTED: destination file copy was intercepted by the isolated test harness' }
  throw "UNEXPECTED_COPY_ITEM: write outside the isolated destination roots was blocked ($Destination)"
}
& $env:SYNC_SCRIPT -Apply -MergedCommit $env:MERGED_COMMIT
`;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'tombo-pr8-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'PR8 isolated test');
  git(root, 'config', 'user.email', 'pr8-test@example.invalid');
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\nskills/tombo-view/*.log\n');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'skills', 'tombo-view'), { recursive: true });
  await writeFile(join(root, 'scripts', 'sync-tombo-view-skills.ps1'), await readFile(sourceScript));
  await writeFile(join(root, 'skills', 'tombo-view', 'SKILL.md'), '# isolated source\n');
  await mkdir(join(root, 'skills', 'tombo-view', 'references'), { recursive: true });
  await mkdir(join(root, 'skills', 'tombo-view', '.session', 'nested'), { recursive: true });
  await writeFile(join(root, 'skills', 'tombo-view', 'references', 'runtime.json'), '{"fixture":true}\n');
  await writeFile(join(root, 'skills', 'tombo-view', 'references', 'keep.md'), 'deployable reference\n');
  await writeFile(join(root, 'skills', 'tombo-view', '.session', 'nested', 'state.json'), '{"fixture":true}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial fixture');
  const initial = git(root, 'rev-parse', 'HEAD');
  return {
    root,
    initial,
    commit: () => {
      git(root, 'add', '-A');
      git(root, 'commit', '-m', 'fixture change');
      return git(root, 'rev-parse', 'HEAD');
    },
    pointOriginMain: sha => git(root, 'update-ref', 'refs/remotes/origin/main', sha),
  };
}

function apply(root, mergedCommit, { forceDestinationAbsent = false } = {}) {
  const run = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', isolatedHarness], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SYNC_SCRIPT: join(root, 'scripts', 'sync-tombo-view-skills.ps1'),
      MERGED_COMMIT: mergedCommit,
      FORCE_DESTINATION_ABSENT: forceDestinationAbsent ? '1' : '0',
    },
  });
  assert.ifError(run.error);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function dryRun(root) {
  const run = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& $env:SYNC_SCRIPT'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SYNC_SCRIPT: join(root, 'scripts', 'sync-tombo-view-skills.ps1') },
  });
  assert.ifError(run.error);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function assertRejectedBeforeCopy(result, message) {
  assert.notEqual(result.status, 0, `${message}: Apply unexpectedly succeeded`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /(?:COPY_ITEM_INTERCEPTED|NEW_ITEM_INTERCEPTED|UNEXPECTED_COPY_ITEM|UNEXPECTED_NEW_ITEM)/, `${message}: reached a destination write guard`);
}

test('Apply binds deployment to the exact clean main commit before any copy', async t => {
  await t.test('rejects an old merged ancestor when HEAD has moved on a feature branch', async t => {
    const fixture = await repository(t);
    fixture.pointOriginMain(fixture.initial);
    git(fixture.root, 'switch', '-c', 'feature/fixture');
    await writeFile(join(fixture.root, 'skills', 'tombo-view', 'SKILL.md'), '# feature source\n');
    fixture.commit();
    assertRejectedBeforeCopy(apply(fixture.root, fixture.initial), 'feature branch with old merged ancestor');
  });

  await t.test('rejects an old merged SHA when main HEAD is later', async t => {
    const fixture = await repository(t);
    fixture.pointOriginMain(fixture.initial);
    await writeFile(join(fixture.root, 'skills', 'tombo-view', 'SKILL.md'), '# later main source\n');
    fixture.commit();
    assertRejectedBeforeCopy(apply(fixture.root, fixture.initial), 'later main HEAD');
  });

  await t.test('rejects tracked working tree edits', async t => {
    const fixture = await repository(t);
    fixture.pointOriginMain(fixture.initial);
    await writeFile(join(fixture.root, 'skills', 'tombo-view', 'SKILL.md'), '# dirty source\n');
    assertRejectedBeforeCopy(apply(fixture.root, fixture.initial), 'tracked dirty source');
  });

  await t.test('rejects untracked working tree files', async t => {
    const fixture = await repository(t);
    fixture.pointOriginMain(fixture.initial);
    await writeFile(join(fixture.root, 'skills', 'tombo-view', 'untracked.txt'), 'untracked source\n');
    assertRejectedBeforeCopy(apply(fixture.root, fixture.initial), 'untracked source');
  });

  await t.test('rejects a missing origin/main ref', async t => {
    const fixture = await repository(t);
    assertRejectedBeforeCopy(apply(fixture.root, fixture.initial), 'missing origin/main');
  });

  await t.test('rejects malformed and non-commit object IDs', async t => {
    const fixture = await repository(t);
    fixture.pointOriginMain(fixture.initial);
    assertRejectedBeforeCopy(apply(fixture.root, 'HEAD'), 'revision expression instead of SHA');
    const tree = git(fixture.root, 'rev-parse', 'HEAD^{tree}');
    assertRejectedBeforeCopy(apply(fixture.root, tree), 'tree object instead of commit');
    assertRejectedBeforeCopy(apply(fixture.root, '0000000000000000000000000000000000000000'), 'unresolvable commit SHA');
  });

  await t.test('rejects a requested commit that is absent from origin/main', async t => {
    const fixture = await repository(t);
    fixture.pointOriginMain(fixture.initial);
    await writeFile(join(fixture.root, 'skills', 'tombo-view', 'SKILL.md'), '# unmerged source\n');
    const later = fixture.commit();
    assertRejectedBeforeCopy(apply(fixture.root, later), 'commit outside origin/main');
  });

  await t.test('accepts validation for exact clean main HEAD and stops at copy interception', async t => {
    const fixture = await repository(t);
    fixture.pointOriginMain(fixture.initial);
    await mkdir(join(fixture.root, 'node_modules'), { recursive: true });
    await mkdir(join(fixture.root, 'dist'), { recursive: true });
    await writeFile(join(fixture.root, 'node_modules', 'ignored-fixture.txt'), 'outside copy source\n');
    await writeFile(join(fixture.root, 'dist', 'ignored-fixture.txt'), 'outside copy source\n');
    assert.equal(git(fixture.root, 'status', '--porcelain', '--untracked-files=all'), '', 'ignored root build output must remain outside the clean-tree gate');
    const result = apply(fixture.root, fixture.initial);
    assert.notEqual(result.status, 0, 'intercepted Apply must terminate the isolated copy');
    assert.match(`${result.stdout}\n${result.stderr}`, /COPY_ITEM_INTERCEPTED/, 'valid source must pass all checks and reach copy interception');
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /NEW_ITEM_INTERCEPTED/, 'present destination mock must not request directory creation');
  });

  await t.test('intercepts destination New-Item when the destination directory is absent', async t => {
    const fixture = await repository(t);
    fixture.pointOriginMain(fixture.initial);
    const result = apply(fixture.root, fixture.initial, { forceDestinationAbsent: true });
    assert.notEqual(result.status, 0, 'intercepted New-Item must terminate the isolated Apply');
    assert.match(`${result.stdout}\n${result.stderr}`, /NEW_ITEM_INTERCEPTED/, 'absent destination branch must reach the New-Item interception');
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /COPY_ITEM_INTERCEPTED/, 'copy must not follow intercepted directory creation');
  });

  await t.test('rejects an ignored untracked file inside the deployable source before copy', async t => {
    const fixture = await repository(t);
    fixture.pointOriginMain(fixture.initial);
    await writeFile(join(fixture.root, 'skills', 'tombo-view', 'extra.log'), 'ignored copy candidate\n');
    assert.equal(git(fixture.root, 'status', '--porcelain', '--untracked-files=all'), '', 'fixture must be Git-clean while the ignored source exists');
    assert.match(git(fixture.root, 'check-ignore', 'skills/tombo-view/extra.log'), /extra\.log/);
    const committedPaths = git(fixture.root, 'ls-tree', '-r', '--name-only', fixture.initial, '--', 'skills/tombo-view');
    assert.doesNotMatch(committedPaths, /extra\.log/, 'ignored source must be absent from the pinned commit tree');
    const result = apply(fixture.root, fixture.initial);
    assertRejectedBeforeCopy(result, 'ignored deployable source');
    assert.match(`${result.stdout}\n${result.stderr}`, /Deployable source files do not match commit/, 'rejection must come from the commit-tree source-list check');
  });

  await t.test('dry run remains available and excludes runtime.json and .session files', async t => {
    const fixture = await repository(t);
    git(fixture.root, 'switch', '-c', 'feature/dry-run');
    const result = dryRun(fixture.root);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Deployable files: 2;/);
    assert.equal((result.stdout.match(/^Dry run:/gm) ?? []).length, 4, 'dry run must list all four destinations');
    assert.match(result.stdout, /references\/runtime\.json and any \.session data/);
  });
});
