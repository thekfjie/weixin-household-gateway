param(
  [ValidateSet("admin", "family")]
  [string] $Role = "admin",
  [switch] $SkipSetup,
  [switch] $ForceSetup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$pnpmVersion = "10.13.1"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..\..")

Set-Location $repoRoot

$env:COREPACK_HOME = Join-Path $repoRoot ".corepack"
$env:PNPM_HOME = Join-Path $repoRoot ".pnpm-home"

$dataDir = Join-Path $repoRoot "data"
$runtimeDir = Join-Path $repoRoot "runtime"
$adminWorkspace = Join-Path $runtimeDir "codex-admin"
$familyWorkspace = Join-Path $runtimeDir "codex-family"

New-Item -ItemType Directory -Force -Path $env:COREPACK_HOME | Out-Null
New-Item -ItemType Directory -Force -Path $env:PNPM_HOME | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path $adminWorkspace | Out-Null
New-Item -ItemType Directory -Force -Path $familyWorkspace | Out-Null

$env:PATH = "$env:PNPM_HOME;$env:PATH"

if (-not $env:DATA_DIR) {
  $env:DATA_DIR = $dataDir
}

if (-not $env:FILE_SEND_ALLOWED_DIRS) {
  $env:FILE_SEND_ALLOWED_DIRS = "$(Join-Path $dataDir 'outbox');$env:TEMP"
}

if (-not $env:CODEX_ADMIN_WORKSPACE) {
  $env:CODEX_ADMIN_WORKSPACE = $adminWorkspace
}

if (-not $env:CODEX_FAMILY_WORKSPACE) {
  $env:CODEX_FAMILY_WORKSPACE = $familyWorkspace
}

if (-not $env:CODEX_ADMIN_COMMAND) {
  $env:CODEX_ADMIN_COMMAND = "codex.cmd"
}

if (-not $env:CODEX_FAMILY_COMMAND) {
  $env:CODEX_FAMILY_COMMAND = $env:CODEX_ADMIN_COMMAND
}

if (-not $env:CODEX_ADMIN_ENV_MODE) {
  $env:CODEX_ADMIN_ENV_MODE = "inherit"
}

if (-not $env:CODEX_FAMILY_ENV_MODE) {
  $env:CODEX_FAMILY_ENV_MODE = "minimal"
}

if (-not $env:TIMEZONE) {
  $env:TIMEZONE = "Asia/Shanghai"
}

if (-not $env:PORT) {
  $env:PORT = "18080"
}

function Initialize-Pnpm {
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    & corepack enable *> $null
    & corepack prepare "pnpm@$pnpmVersion" --activate *> $null
  }

  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    return "pnpm"
  }

  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    return "corepack"
  }

  if (Get-Command npm -ErrorAction SilentlyContinue) {
    return "npm"
  }

  throw "Missing pnpm/corepack/npm. Install Node.js with Corepack enabled, then rerun."
}

$pnpmLauncher = Initialize-Pnpm

function Invoke-Pnpm {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $PnpmArgs
  )

  if ($pnpmLauncher -eq "pnpm") {
    & pnpm @PnpmArgs
  } elseif ($pnpmLauncher -eq "corepack") {
    & corepack pnpm @PnpmArgs
  } else {
    & npm exec --yes "pnpm@$pnpmVersion" -- @PnpmArgs
  }

  return $LASTEXITCODE
}

function Test-HasAccounts {
  $dbPath = Join-Path $env:DATA_DIR "weixin-household-gateway.sqlite"
  if (-not (Test-Path $dbPath)) {
    return $false
  }

  $script = 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); try { const row = db.prepare("SELECT COUNT(*) AS count FROM wechat_accounts").get(); process.exit(Number(row.count) > 0 ? 0 : 1); } catch { process.exit(1); } finally { db.close(); }'
  & node -e $script $dbPath *> $null
  return $LASTEXITCODE -eq 0
}

Write-Host "[run-local] installing dependencies if needed..."
$env:CI = "1"
$installCode = Invoke-Pnpm install --frozen-lockfile
if ($installCode -ne 0) {
  $installCode = Invoke-Pnpm install
}
if ($installCode -ne 0) {
  throw "pnpm install failed with exit code $installCode"
}

Write-Host "[run-local] building project..."
$buildCode = Invoke-Pnpm build
if ($buildCode -ne 0) {
  throw "pnpm build failed with exit code $buildCode"
}

if (-not $SkipSetup) {
  if ($ForceSetup -or -not (Test-HasAccounts)) {
    Write-Host "[run-local] starting QR login for role: $Role"
    Write-Host "[run-local] scan with WeChat and confirm; service will start afterwards."
    $setupArgs = @($Role)
    if ($ForceSetup) {
      $setupArgs += "--force"
    }
    & node .\dist\apps\server\setup.js @setupArgs
    if ($LASTEXITCODE -ne 0) {
      throw "setup failed with exit code $LASTEXITCODE"
    }
  } else {
    Write-Host "[run-local] saved WeChat account found; skipping QR login."
  }
}

Write-Host "[run-local] starting service on port $env:PORT..."
& node .\dist\apps\server\index.js
