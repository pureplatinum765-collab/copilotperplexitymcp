# setup.ps1 — Windows PowerShell 5.1 native bootstrap for the
# StackOne <-> GitHub <-> Perplexity MCP server.
#
# Designed to run on stock Windows PowerShell 5.1 (the default in Windows 10/11
# without PS7 installed). Avoids every PS7-only idiom:
#   - no -SkipHttpErrorCheck
#   - no -PipelineVariable
#   - no ternary operator
#   - no & for backgrounding (it's the call operator in PS 5.1)
#
# Idempotent: safe to re-run. Exits non-zero on the first failure.

[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

function Write-Section($text) {
    Write-Host ''
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

function Require-Command($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Host "Missing required tool: $name" -ForegroundColor Red
        Write-Host "  $hint" -ForegroundColor Yellow
        exit 1
    }
    return $cmd
}

# ---------------------------------------------------------------------------
Write-Section 'Tooling check'

$nodeCmd = Require-Command 'node' 'Install via: winget install OpenJS.NodeJS.LTS'
$npmCmd  = Require-Command 'npm'  'Comes with Node.js.'

$nodeVersion = & $nodeCmd.Path --version
$npmVersion  = & $npmCmd.Path --version
Write-Host "node: $nodeVersion"
Write-Host "npm:  $npmVersion"

$nodeMajor = [int](($nodeVersion -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 18) {
    Write-Host "Node 18+ required (found $nodeVersion)." -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
Write-Section 'Repo layout check'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

$missing = @()
foreach ($p in @('package.json', 'tsconfig.json', 'src\server.ts', 'src\auth\github.ts', 'src\adapters\factory.ts', 'src\tools\github\index.ts')) {
    if (-not (Test-Path (Join-Path $repoRoot $p))) { $missing += $p }
}
if ($missing.Count -gt 0) {
    Write-Host 'Missing required files:' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host 'Pull the latest branch then re-run this script.' -ForegroundColor Yellow
    exit 1
}
Write-Host 'All required source files present.'

# ---------------------------------------------------------------------------
Write-Section 'npm install'

# --no-fund/--no-audit cut down on the noise; --loglevel=error hides notices.
& $npmCmd.Path install --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) {
    Write-Host 'npm install failed.' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Section 'npm run build'
    & $npmCmd.Path run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'TypeScript build failed.' -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------------------
Write-Section 'Local config scaffolding'

$dataDir = Join-Path $repoRoot '.data'
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
    Write-Host "Created $dataDir (token store)."
}

$outputDir = Join-Path $repoRoot 'output'
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
    Write-Host "Created $outputDir (validation captures)."
}

$envFile = Join-Path $repoRoot '.env'
$envExample = Join-Path $repoRoot '.env.example'
if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
    Copy-Item $envExample $envFile
    Write-Host "Created .env from .env.example. Edit it before starting the server."
} elseif (Test-Path $envFile) {
    Write-Host '.env already exists (left untouched).'
}

# ---------------------------------------------------------------------------
Write-Section 'Done'
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Green
Write-Host '  1. Open .env and fill in GITHUB_TOKEN (and STACKONE_API_KEY if you have one).'
Write-Host '  2. Run validate.ps1 to capture runtime evidence into ./output/.'
Write-Host '  3. Or start the server: $env:PORT="3000"; node dist\server.js'
Write-Host ''
