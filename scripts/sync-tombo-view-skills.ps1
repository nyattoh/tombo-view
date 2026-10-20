param(
  [switch]$Apply,
  [string]$MergedCommit
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path $repositoryRoot 'skills/tombo-view'
$userProfile = [Environment]::GetFolderPath('UserProfile')
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$targets = @(
  (Join-Path $userProfile '.claude/skills/tombo-view'),
  (Join-Path $userProfile '.agents/skills/tombo-view'),
  (Join-Path $userProfile '.codex/skills/tombo-view'),
  (Join-Path $localAppData 'hermes/skills/tombo-view')
)

function Get-GitOutput {
  param(
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$FailureMessage
  )
  $output = @(& git -C $repositoryRoot @Arguments 2>$null)
  $gitExitCode = $LASTEXITCODE
  if ($gitExitCode -ne 0) {
    throw "$FailureMessage (git exit code $gitExitCode)."
  }
  return ($output -join [Environment]::NewLine).Trim()
}

function Assert-GitSuccess {
  param(
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$FailureMessage
  )
  $null = & git -C $repositoryRoot @Arguments 2>$null
  $gitExitCode = $LASTEXITCODE
  if ($gitExitCode -ne 0) {
    throw "$FailureMessage (git exit code $gitExitCode)."
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'SKILL.md') -PathType Leaf)) {
  throw "Skill source not found: $sourceRoot"
}

if ($Apply) {
  if ([string]::IsNullOrWhiteSpace($MergedCommit)) {
    throw 'Pass -MergedCommit with the commit that contains the merged PR.'
  }
  if ($MergedCommit -notmatch '\A(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\z') {
    throw 'MergedCommit must be a full commit SHA; no copies were changed.'
  }

  $resolvedMergedCommit = Get-GitOutput -Arguments @('rev-parse', '--verify', "$MergedCommit^{commit}") -FailureMessage "Merged commit $MergedCommit cannot be resolved"
  $headCommit = Get-GitOutput -Arguments @('rev-parse', '--verify', 'HEAD^{commit}') -FailureMessage 'HEAD cannot be resolved'
  if ($resolvedMergedCommit -ne $headCommit) {
    throw "Merged commit $resolvedMergedCommit does not equal HEAD $headCommit; no copies were changed."
  }

  $currentBranch = Get-GitOutput -Arguments @('branch', '--show-current') -FailureMessage 'Current branch cannot be determined'
  if ($currentBranch -ne 'main') {
    throw "Apply requires the main branch; current branch is '$currentBranch'. No copies were changed."
  }

  $status = Get-GitOutput -Arguments @('status', '--porcelain=v1', '--untracked-files=all') -FailureMessage 'Working tree status cannot be determined'
  if (-not [string]::IsNullOrEmpty($status)) {
    throw 'Apply requires a clean working tree, including untracked files; no copies were changed.'
  }

  Assert-GitSuccess -Arguments @('merge-base', '--is-ancestor', $resolvedMergedCommit, 'origin/main') -FailureMessage "Merged commit $resolvedMergedCommit is not contained in origin/main; update origin/main after the PR is merged. No copies were changed"
}

$sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force | Where-Object {
  $relativePath = [IO.Path]::GetRelativePath($sourceRoot, $_.FullName).Replace('\', '/')
  $relativePath -ne 'references/runtime.json' -and
    -not $relativePath.StartsWith('.session/') -and
    -not $relativePath.Contains('/.session/')
} | Sort-Object { [IO.Path]::GetRelativePath($sourceRoot, $_.FullName).Replace('\', '/') })

if ($sourceFiles.Count -eq 0) { throw 'The skill source contains no deployable files.' }

if ($Apply) {
  $committedTree = Get-GitOutput -Arguments @('ls-tree', '-r', '--name-only', '--full-tree', $resolvedMergedCommit, '--', 'skills/tombo-view') -FailureMessage "Deployable files for $resolvedMergedCommit cannot be listed"
  $committedSourcePaths = @($committedTree -split '\r?\n' | Where-Object { -not [string]::IsNullOrEmpty($_) } | ForEach-Object {
    if (-not $_.StartsWith('skills/tombo-view/')) {
      throw "Unexpected skill path in commit tree: $_; no copies were changed."
    }
    $_.Substring('skills/tombo-view/'.Length)
  } | Where-Object {
    $_ -ne 'references/runtime.json' -and
      -not $_.StartsWith('.session/') -and
      -not $_.Contains('/.session/')
  } | Sort-Object)
  $sourcePaths = @($sourceFiles | ForEach-Object { [IO.Path]::GetRelativePath($sourceRoot, $_.FullName).Replace('\', '/') } | Sort-Object)
  $pathDifferences = @(Compare-Object -ReferenceObject $committedSourcePaths -DifferenceObject $sourcePaths -CaseSensitive)
  if ($pathDifferences.Count -gt 0) {
    throw "Deployable source files do not match commit $resolvedMergedCommit; no copies were changed."
  }
}

$sourceHashes = @{}
$manifestLines = foreach ($file in $sourceFiles) {
  $relativePath = [IO.Path]::GetRelativePath($sourceRoot, $file.FullName).Replace('\', '/')
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $sourceHashes[$relativePath] = $hash
  "$relativePath $hash"
}
$manifestHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($manifestLines -join "`n")))).ToLowerInvariant()

Write-Output "Source: $sourceRoot"
Write-Output "Deployable files: $($sourceFiles.Count); manifest SHA256: $manifestHash"
Write-Output 'Preserved at each destination: references/runtime.json and any .session data; stale destination files are not deleted.'
foreach ($target in $targets) {
  if ($Apply) { Write-Output "Copy and verify: $target" }
  else { Write-Output "Dry run: $target"; continue }

  foreach ($file in $sourceFiles) {
    $relativePath = [IO.Path]::GetRelativePath($sourceRoot, $file.FullName)
    $destination = Join-Path $target $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
      $null = New-Item -ItemType Directory -Path $destinationDirectory -Force
    }
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  }

  foreach ($relativePath in $sourceHashes.Keys) {
    $destination = Join-Path $target $relativePath
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
      throw "Copy verification failed for $target/$relativePath (missing file)."
    }
    $actualHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $sourceHashes[$relativePath]) {
      throw "Copy verification failed for $target/$relativePath (SHA256 mismatch)."
    }
  }
  Write-Output "Verified $($sourceHashes.Count) files; manifest SHA256: $manifestHash"
}

if (-not $Apply) {
  Write-Output 'Dry run only. After the PR is merged and the merged commit is checked out, rerun with -Apply -MergedCommit <sha>.'
}
