# setup-1password-connect.ps1
#
# Stands up 1Password Connect (api + sync) on Docker, exposes it via a
# Cloudflare quick tunnel, then walks through linking the credentials into
# StackOne to mint an account_id for the Perplexity MCP bridge.
#
# Windows PowerShell 5.1 native. Honours the constraints set by the operator:
#   - Secrets (OP_ACCESS_TOKEN, STACKONE_API_KEY) are prompted interactively
#     via Read-Host -AsSecureString and only ever live in this process's
#     memory. They are not written to disk, not logged, not sent to any
#     network endpoint except the official 1Password / StackOne APIs.
#   - Idempotent: if op-connect-api / op-connect-sync containers exist they
#     are force-removed before recreation.
#   - Refuses to proceed unless /heartbeat returns 200 on both the local
#     and the public URL.
#
# Run from any directory:
#   .\setup-1password-connect.ps1 -CredDir 'C:\op-connect'
#
# Pre-reqs (the script checks them and tells you what to fix):
#   - Docker Desktop installed (script will try to start it)
#   - 1password-credentials.json already saved into -CredDir
#   - winget available (Windows 10 1809+ / Windows 11 default)

[CmdletBinding()]
param(
    [string]$CredDir = 'C:\op-connect',
    [int]$ApiPort = 8080,
    [int]$SyncPort = 8081,
    [int]$HeartbeatTimeoutSec = 30,
    [int]$TunnelReadyTimeoutSec = 30,
    [int]$DockerStartTimeoutSec = 120,
    [string]$StackOneAccountsUrl = 'https://app.stackone.com/org/Ebz6bfr1bSJqsNgGbZZPHSKEWNiQg8j6/project/wCbRrexDEy4L0Qr4dM3WMN4C0KVQpTVH/accounts'
)

$ErrorActionPreference = 'Stop'

function Write-Section($t) {
    Write-Host ''
    Write-Host "=== $t ===" -ForegroundColor Cyan
}

function Require-Command($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Host "Missing required command: $name" -ForegroundColor Red
        Write-Host "  $hint" -ForegroundColor Yellow
        exit 1
    }
    return $cmd
}

function Read-Secret($prompt) {
    $secure = Read-Host -AsSecureString $prompt
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
    }
}

function Add-CloudflaredToPath {
    $candidates = @(
        "$env:ProgramFiles\cloudflared\cloudflared.exe",
        "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
        "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $dir = Split-Path -Parent $c
            if ($env:PATH -notlike "*$dir*") {
                $env:PATH = "$env:PATH;$dir"
            }
            return $true
        }
    }
    return $false
}

# ---------------------------------------------------------------------------
Write-Section 'Step 1/11 — Docker Desktop check'

$dockerCmd = Require-Command 'docker' 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/'

# `docker info` returns non-zero when the daemon isn't reachable, regardless
# of whether the CLI itself is installed. That's the signal we want.
$null = & $dockerCmd info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Docker daemon not responding. Trying to start Docker Desktop...' -ForegroundColor Yellow
    $dd = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    if (Test-Path $dd) {
        Start-Process $dd
    } else {
        Write-Host "Docker Desktop not found at $dd. Start it manually and re-run." -ForegroundColor Red
        exit 1
    }

    $deadline = (Get-Date).AddSeconds($DockerStartTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $null = & $dockerCmd info 2>&1
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 3
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Docker still not responding after ${DockerStartTimeoutSec}s. Aborting." -ForegroundColor Red
        exit 1
    }
}
Write-Host 'Docker daemon is responsive.'

# ---------------------------------------------------------------------------
Write-Section 'Step 2/11 — cloudflared check'

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host 'cloudflared not found. Installing via winget...' -ForegroundColor Yellow
    $wingetCmd = Require-Command 'winget' 'Update Windows to get App Installer.'
    & $wingetCmd install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements --silent | Out-Host

    # winget often drops the binary at a path not yet on the current shell's PATH.
    Add-CloudflaredToPath | Out-Null

    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
        Write-Host 'cloudflared still not on PATH after install. Close this shell, open a new one, re-run.' -ForegroundColor Red
        exit 1
    }
}
Write-Host 'cloudflared is available.'

# ---------------------------------------------------------------------------
Write-Section 'Step 3/11 — Credentials file check'

$credFile = Join-Path $CredDir '1password-credentials.json'
if (-not (Test-Path $credFile)) {
    Write-Host "Missing $credFile" -ForegroundColor Red
    Write-Host '  Download it from your 1Password "Deploy a Connect Server" page' -ForegroundColor Yellow
    Write-Host "  and save it as 1password-credentials.json under $CredDir" -ForegroundColor Yellow
    exit 1
}
$CredDir = (Resolve-Path $CredDir).Path
Write-Host "Credentials file found at $credFile"

# ---------------------------------------------------------------------------
Write-Section 'Step 4/11 — Prompt for OP_ACCESS_TOKEN (stays on this machine)'

$opToken = Read-Secret 'Paste OP_ACCESS_TOKEN (the JWT from the Deploy Connect Server page)'
if (-not $opToken) {
    Write-Host 'Empty token. Aborting.' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
Write-Section 'Step 5/11 — Recreate Connect containers (idempotent)'

# `docker rm -f` on a missing container prints to stderr and exits non-zero;
# we suppress both so a clean first run doesn't look like a failure.
& $dockerCmd rm -f op-connect-api 2>$null | Out-Null
& $dockerCmd rm -f op-connect-sync 2>$null | Out-Null

$apiArgs = @(
    'run', '-d', '--name', 'op-connect-api',
    '-p', "${ApiPort}:8080",
    '-v', "${CredDir}:/home/opuser/.op",
    '1password/connect-api:latest'
)
$syncArgs = @(
    'run', '-d', '--name', 'op-connect-sync',
    '-p', "${SyncPort}:8080",
    '-v', "${CredDir}:/home/opuser/.op",
    '1password/connect-sync:latest'
)

& $dockerCmd @apiArgs
if ($LASTEXITCODE -ne 0) { Write-Host 'docker run op-connect-api failed' -ForegroundColor Red; exit 1 }

& $dockerCmd @syncArgs
if ($LASTEXITCODE -ne 0) { Write-Host 'docker run op-connect-sync failed' -ForegroundColor Red; exit 1 }

Write-Host "Containers up. api on :$ApiPort, sync on :$SyncPort"

# ---------------------------------------------------------------------------
Write-Section "Step 6/11 — Polling /heartbeat (up to ${HeartbeatTimeoutSec}s)"

$heartbeatUrl = "http://localhost:$ApiPort/heartbeat"
$ready = $false
$deadline = (Get-Date).AddSeconds($HeartbeatTimeoutSec)
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri $heartbeatUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $ready) {
    Write-Host "Connect API did not respond on $heartbeatUrl within ${HeartbeatTimeoutSec}s." -ForegroundColor Red
    Write-Host '  Diagnose with: docker logs op-connect-api' -ForegroundColor Yellow
    exit 1
}
Write-Host "Local heartbeat OK at $heartbeatUrl"

# ---------------------------------------------------------------------------
Write-Section 'Step 7/11 — Start Cloudflare quick tunnel'

$tunnelLog = Join-Path $env:TEMP "cloudflared-$([guid]::NewGuid()).log"
$tunnelArgs = @{
    FilePath               = 'cloudflared'
    ArgumentList           = @('tunnel', '--no-autoupdate', '--url', "http://localhost:$ApiPort")
    RedirectStandardError  = $tunnelLog
    RedirectStandardOutput = "$tunnelLog.out"
    WindowStyle            = 'Hidden'
    PassThru               = $true
}
$tunnelProc = Start-Process @tunnelArgs
Write-Host "cloudflared started as PID $($tunnelProc.Id) (log: $tunnelLog)"

$publicUrl = $null
$deadline = (Get-Date).AddSeconds($TunnelReadyTimeoutSec)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    foreach ($f in @($tunnelLog, "$tunnelLog.out")) {
        if (Test-Path $f) {
            $content = Get-Content -Raw -Path $f -ErrorAction SilentlyContinue
            if ($content -and $content -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
                $publicUrl = $Matches[0]
                break
            }
        }
    }
    if ($publicUrl) { break }
}

if (-not $publicUrl) {
    Write-Host "cloudflared did not surface a trycloudflare URL within ${TunnelReadyTimeoutSec}s." -ForegroundColor Red
    Write-Host "Tunnel log: $tunnelLog" -ForegroundColor Yellow
    Stop-Process -Id $tunnelProc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "Tunnel public URL: $publicUrl"

# ---------------------------------------------------------------------------
Write-Section 'Step 8/11 — Verify public reachability'

$publicHeartbeat = "$publicUrl/heartbeat"
$ok = $false
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri $publicHeartbeat -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $ok = $true; break }
    } catch {
        Start-Sleep -Seconds 2
    }
}
if (-not $ok) {
    Write-Host "Could not reach $publicHeartbeat yet (Cloudflare propagation can take 30-60s)." -ForegroundColor Yellow
    Write-Host 'Continuing. You can confirm manually from a fresh shell.'
} else {
    Write-Host "Public heartbeat OK at $publicHeartbeat"
}

# ---------------------------------------------------------------------------
Write-Section 'Step 9/11 — Paste these into the StackOne 1Password connector form'

Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor Yellow
Write-Host "Connect Server URL: $publicUrl"
Write-Host "Access Token:       $opToken"
Write-Host '------------------------------------------------------------' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Opening the StackOne accounts page in your default browser...'
Start-Process $StackOneAccountsUrl

Read-Host 'Press Enter AFTER you have clicked +Link Account, selected 1Password, pasted the two values above, and seen StackOne report success'

# ---------------------------------------------------------------------------
Write-Section 'Step 10/11 — Fetch the new account_id from StackOne'

$stackOneKey = Read-Secret 'Paste STACKONE_API_KEY (used once to query /accounts, never written to disk)'
if (-not $stackOneKey) {
    Write-Host 'Empty STACKONE_API_KEY. Aborting.' -ForegroundColor Red
    exit 1
}

$basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${stackOneKey}:"))
try {
    $accountsResp = Invoke-RestMethod `
        -Uri 'https://api.stackone.com/accounts' `
        -Method GET `
        -Headers @{ Authorization = "Basic $basicAuth"; Accept = 'application/json' } `
        -ErrorAction Stop
} catch {
    Write-Host 'StackOne /accounts call failed.' -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}

# Schema varies by workspace: sometimes a bare array, sometimes { data: [...] }.
if ($accountsResp -is [array]) {
    $accountList = $accountsResp
} elseif ($accountsResp.data) {
    $accountList = $accountsResp.data
} else {
    $accountList = @()
}

$account = $accountList | Where-Object {
    ($_.provider -and $_.provider.ToString().ToLower().Contains('1password')) -or
    ($_.provider_key -and $_.provider_key.ToString().ToLower().Contains('1password')) -or
    ($_.provider_id -and $_.provider_id.ToString().ToLower().Contains('1password'))
} | Select-Object -Last 1

if (-not $account) {
    Write-Host 'No 1Password account found in StackOne. Verify the link succeeded.' -ForegroundColor Red
    Write-Host 'Full response (for debugging):' -ForegroundColor Yellow
    $accountsResp | ConvertTo-Json -Depth 6 | Out-Host
    exit 1
}

$accountId = $account.id
Write-Host "Found StackOne account_id: $accountId"

# ---------------------------------------------------------------------------
Write-Section 'Step 11/11 — Final MCP URL + Authorization header'

Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor Green
Write-Host 'Perplexity MCP URL:'
Write-Host "  https://api.stackone.com/mcp?x-account-id=$accountId"
Write-Host ''
Write-Host 'Authorization header to use:'
Write-Host "  Authorization: Basic $basicAuth"
Write-Host '------------------------------------------------------------' -ForegroundColor Green
Write-Host ''
Write-Host "cloudflared is still running as PID $($tunnelProc.Id) — keep it up for StackOne to keep reaching your Connect server." -ForegroundColor Cyan
Write-Host "Stop it later with: Stop-Process -Id $($tunnelProc.Id) -Force" -ForegroundColor Cyan
