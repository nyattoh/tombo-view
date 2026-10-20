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

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'SKILL.md') -PathType Leaf)) {
  throw "Skill source not found: $sourceRoot"
}

if ($Apply) {
  if ([string]::IsNullOrWhiteSpace($MergedCommit)) {
    throw 'Pass -MergedCommit with the commit that contains the merged PR.'
  }
  $null = & git -C $repositoryRoot merge-base --is-ancestor $MergedCommit origin/main
  if ($LASTEXITCODE -ne 0) {
    throw "Merged commit $MergedCommit is not contained in origin/main; no copies were changed. Update origin/main after the PR is merged."
  }
  $null = & git -C $repositoryRoot merge-base --is-ancestor $MergedCommit HEAD
  if ($LASTEXITCODE -ne 0) {
    throw "Merged commit $MergedCommit is not an ancestor of HEAD; no copies were changed."
  }
}

$sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force | Where-Object {
  $relativePath = [IO.Path]::GetRelativePath($sourceRoot, $_.FullName).Replace('\', '/')
  $relativePath -ne 'references/runtime.json' -and
    -not $relativePath.StartsWith('.session/') -and
    -not $relativePath.Contains('/.session/')
} | Sort-Object { [IO.Path]::GetRelativePath($sourceRoot, $_.FullName).Replace('\', '/') })

if ($sourceFiles.Count -eq 0) { throw 'The skill source contains no deployable files.' }
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
