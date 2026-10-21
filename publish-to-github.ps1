<#
  publish-to-github.ps1
  Commits this project and pushes it to GitHub.

  Usage (PowerShell, from the project folder):
      .\publish-to-github.ps1
      .\publish-to-github.ps1 -Message "Add manuals viewer"
      .\publish-to-github.ps1 -DryRun          # shows what would be committed, changes nothing

  If PowerShell blocks the script, run it once like this instead:
      powershell -ExecutionPolicy Bypass -File .\publish-to-github.ps1
#>
param(
  [string]$Message = "",
  [string]$Remote = "https://github.com/Frosty-Graybob/Lantern-Launcher.git",
  [string]$Branch = "main",
  [switch]$DryRun
)

$ErrorActionPreference = "Continue"   # every git call is checked explicitly below
Set-Location -Path $PSScriptRoot

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Invoke-Git { & git @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed (exit $LASTEXITCODE)" } }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git isn't installed. Get it from https://git-scm.com/download/win and run this again."
}

# --- 1. Repository and remote ---------------------------------------------------------
Step "Repository"
if (-not (Test-Path ".git")) {
  Invoke-Git init -b $Branch
}
$current = "$(git remote get-url origin 2>$null)".Trim()
if (-not $current) {
  Invoke-Git remote add origin $Remote
  Write-Host "Added remote origin: $Remote"
} elseif ($current -ne $Remote) {
  Write-Host "Remote origin is $current (leaving it as it is)."
  $Remote = $current
} else {
  Write-Host "Remote origin: $current"
}
$onBranch = "$(git rev-parse --abbrev-ref HEAD 2>$null)".Trim()
if ($onBranch -and $onBranch -ne $Branch -and $onBranch -ne "HEAD") {
  Write-Host "You're on branch '$onBranch', so that's what will be pushed."
  $Branch = $onBranch
}

# --- 2. .gitignore (only created if you don't have one) --------------------------------
Step ".gitignore"
if (-not (Test-Path ".gitignore")) {
  @"
# dependencies and build output
node_modules/
dist/
build/
*.log

# your game files and local data: never upload these
server/library/*
!server/library/README.txt
!server/library/.gitkeep

# local backups
_backup_*/
*.bak

# the bundled tools are fetched by hand (see client/tools/README.txt)
client/tools/*.exe
client/tools/*.dll
client/tools/*.zip
client/tools/unrar
client/tools/UnRAR.exe

# editor and OS files
.DS_Store
Thumbs.db
.vscode/
.idea/
"@ | Set-Content -Path ".gitignore" -Encoding UTF8
  Write-Host "Created .gitignore (node_modules, dist, backups, your games folder and the bundled tools are left out)."
} else {
  Write-Host ".gitignore already exists, using it."
}

# Stop tracking anything that should now be ignored (does nothing if it was never tracked).
& git rm -r --cached -q --ignore-unmatch node_modules server/node_modules client/node_modules server/dist client/dist server/build _backup_before_dlc _backup_before_checksums 2>$null | Out-Null

# --- 3. Look at what will be committed --------------------------------------------------
Step "Changes"
Invoke-Git add -A
$changes = (& git status --porcelain)
if (-not $changes) {
  Write-Host "Nothing to commit: everything is already saved."
} else {
  Invoke-Git status --short

  # Warn about big files: GitHub refuses anything over 100 MB.
  $big = @(& git diff --cached --name-only | Where-Object { Test-Path $_ } | ForEach-Object { Get-Item $_ } | Where-Object { $_.Length -gt 50MB })
  if ($big.Count -gt 0) {
    Write-Host "`nThese files are very large and GitHub rejects anything over 100 MB:" -ForegroundColor Yellow
    $big | ForEach-Object { Write-Host ("  {0}  ({1:N0} MB)" -f $_.FullName, ($_.Length / 1MB)) }
    Invoke-Git reset -q
    throw "Add them to .gitignore (or delete them), then run this again. Nothing was committed."
  }
}

if ($DryRun) {
  Invoke-Git reset -q
  Write-Host "`nDry run: nothing was committed or pushed." -ForegroundColor Yellow
  exit 0
}

# --- 4. Commit ---------------------------------------------------------------------------
if ($changes) {
  Step "Commit"
  if (-not $Message) {
    $Message = Read-Host "Commit message (Enter for 'Update project')"
    if (-not $Message) { $Message = "Update project" }
  }
  & git config user.name  *> $null; $hasName  = ($LASTEXITCODE -eq 0)
  & git config user.email *> $null; $hasEmail = ($LASTEXITCODE -eq 0)
  if (-not $hasName -or -not $hasEmail) {
    throw "Git doesn't know who you are yet. Run these two lines once, then run this again:`n  git config --global user.name `"Your Name`"`n  git config --global user.email `"you@example.com`""
  }
  Invoke-Git commit -m $Message
}

# --- 5. Push -----------------------------------------------------------------------------
Step "Push to $Remote"
& git push -u origin $Branch
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nGitHub has commits that aren't here yet (often a README created on the website)." -ForegroundColor Yellow
  Write-Host "Merging them in, keeping your local files where they overlap, then pushing again..." -ForegroundColor Yellow
  & git pull --rebase -X theirs origin $Branch
  if ($LASTEXITCODE -ne 0) {
    # A file that was changed here but deleted on GitHub (or the reverse) can't be merged automatically.
    # Your local copy is the one you want to publish, so keep it and carry on.
    Write-Host "`nKeeping your local version of the conflicting files and continuing..." -ForegroundColor Yellow
    & git add -A
    & git -c core.editor=true rebase --continue
  }
  if ($LASTEXITCODE -ne 0) {
    & git rebase --abort 2>$null
    Write-Host "`nThe automatic merge didn't work, and nothing was changed. Run these by hand to see why:" -ForegroundColor Red
    Write-Host "  git pull --rebase origin $Branch" -ForegroundColor Red
    exit 1
  }
  & git push -u origin $Branch
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`nStill rejected. If GitHub asked you to sign in, use your GitHub username and a personal access token" -ForegroundColor Red
    Write-Host "as the password (https://github.com/settings/tokens), or sign in through the browser window if one opens." -ForegroundColor Red
    exit 1
  }
}

Write-Host "`nDone. https://github.com/Frosty-Graybob/Lantern-Launcher" -ForegroundColor Green
