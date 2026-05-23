# validate.ps1 — Windows PowerShell 5.1 native validation harness.
#
# Boots the MCP server out-of-process, polls until the TCP port binds, hits
# every documented endpoint, and writes the raw HTTP responses (including
# non-2xx bodies) into .\output\. Outputs are the ground truth for the KERNEL
# audit.
#
# PS 5.1 constraints honoured:
#   - no -SkipHttpErrorCheck (PS7-only)
#   - no & for backgrounding (PS 5.1 call operator)
#   - Start-Process with -PassThru is used for backgrounding; we kill ONLY the
#     PID we spawned, never `Stop-Process -Name node`
#   - Invoke-WebRequest is called with -ErrorAction SilentlyContinue, and any
#     resulting error response is reconstructed from $Error[0].Exception.Response
#   - Out-File is always called with -Encoding utf8

[CmdletBinding()]
param(
    [int]$Port = 3000,
    [int]$ReadyTimeoutSeconds = 15
)

$ErrorActionPreference = 'Stop'

function Write-Section($text) {
    Write-Host ''
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

$outputDir = Join-Path $repoRoot 'output'
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}

if (-not (Test-Path (Join-Path $repoRoot 'dist\server.js'))) {
    Write-Host 'dist\server.js not found. Run setup.ps1 first (or `npm run build`).' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# HTTP capture helper — works on PS 5.1, captures both 2xx and error responses.
# Writes "HTTP <code>\n<body>" so the KERNEL audit can verify status + payload.
function Capture-Http {
    param(
        [Parameter(Mandatory)] [string]$Method,
        [Parameter(Mandatory)] [string]$Uri,
        [string]$Body,
        [Parameter(Mandatory)] [string]$OutFile
    )

    $Error.Clear()

    $invokeParams = @{
        Uri             = $Uri
        Method          = $Method
        UseBasicParsing = $true
        ErrorAction     = 'SilentlyContinue'
        TimeoutSec      = 10
    }
    if ($Body) {
        $invokeParams.Body        = $Body
        $invokeParams.ContentType = 'application/json'
    }

    $resp = Invoke-WebRequest @invokeParams

    if ($resp) {
        $line = "HTTP $([int]$resp.StatusCode)`r`n$($resp.Content)"
        $line | Out-File -FilePath $OutFile -Encoding utf8
        return
    }

    # No success response — pull the error body out of the last exception.
    # $Error was cleared at the top of this function, so $Error[0] is ours.
    $err = $Error[0]
    if ($err -and $err.Exception -and $err.Exception.Response) {
        $statusCode = [int]$err.Exception.Response.StatusCode
        $stream = $err.Exception.Response.GetResponseStream()
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            $body   = $reader.ReadToEnd()
            $reader.Close()
        } catch {
            $body = '<unreadable response body>'
        }
        "HTTP $statusCode`r`n$body" | Out-File -FilePath $OutFile -Encoding utf8
    } elseif ($err) {
        "ERROR: $($err.Exception.Message)" | Out-File -FilePath $OutFile -Encoding utf8
    } else {
        'ERROR: no response and no captured exception' | Out-File -FilePath $OutFile -Encoding utf8
    }
}

# ---------------------------------------------------------------------------
# Start the server out-of-process and return its [Diagnostics.Process].
# Stdout/stderr stream to log files in ./output/ so we have evidence of any
# startup error without keeping the console open.
function Start-McpServer {
    param([hashtable]$Env)

    foreach ($k in $Env.Keys) {
        Set-Item -Path "Env:$k" -Value $Env[$k]
    }

    $stdoutLog = Join-Path $outputDir 'server.stdout.log'
    $stderrLog = Join-Path $outputDir 'server.stderr.log'

    $procArgs = @{
        FilePath               = 'node'
        ArgumentList           = 'dist\server.js'
        WorkingDirectory       = $repoRoot
        RedirectStandardOutput = $stdoutLog
        RedirectStandardError  = $stderrLog
        WindowStyle            = 'Hidden'
        PassThru               = $true
    }
    return Start-Process @procArgs
}

function Wait-PortReady {
    param([int]$Port, [int]$TimeoutSec)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $task = $client.ConnectAsync('127.0.0.1', $Port)
            if ($task.Wait(500) -and $client.Connected) {
                $client.Close()
                return $true
            }
        } catch {
            # not ready yet — fall through to retry
        } finally {
            $client.Close()
        }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

function Stop-McpServer {
    param([Diagnostics.Process]$Proc)
    if ($Proc -and -not $Proc.HasExited) {
        try {
            Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $Proc.Id -Timeout 5 -ErrorAction SilentlyContinue
        } catch {
            # ignore — best effort cleanup
        }
    }
}

# Wipes server-related env vars so each run starts from a known state.
# Using foreach instead of backtick-continuation to stay robust against
# trailing whitespace (which silently breaks line continuation in PS 5.1).
function Reset-McpEnv {
    $varsToClear = @(
        'GITHUB_TOKEN', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
        'GITHUB_REDIRECT_URI', 'STACKONE_API_KEY', 'STACKONE_ACCOUNT_ID',
        'GITHUB_TOKEN_STORE_PATH', 'PORT', 'LOG_LEVEL'
    )
    foreach ($var in $varsToClear) {
        Remove-Item -Path "Env:$var" -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
Write-Section "Run 1: no env vars (clean defaults)"

Reset-McpEnv

$proc1 = Start-McpServer -Env @{ PORT = "$Port"; LOG_LEVEL = 'info' }
Write-Host "Started node PID $($proc1.Id)"

if (-not (Wait-PortReady -Port $Port -TimeoutSec $ReadyTimeoutSeconds)) {
    Write-Host "Server did not bind to :$Port within $ReadyTimeoutSeconds s." -ForegroundColor Red
    Stop-McpServer $proc1
    if (Test-Path (Join-Path $outputDir 'server.stderr.log')) {
        Write-Host '--- server stderr ---' -ForegroundColor Yellow
        Get-Content (Join-Path $outputDir 'server.stderr.log')
    }
    exit 1
}

$base = "http://127.0.0.1:$Port"

Capture-Http -Method GET  -Uri "$base/healthz"                           -OutFile (Join-Path $outputDir 'healthz.json')
Capture-Http -Method GET  -Uri "$base/auth/github/start?user_id=alice"   -OutFile (Join-Path $outputDir 'oauth_start.json')
Capture-Http -Method POST -Uri "$base/invoke/github.get_user" -Body '{}' -OutFile (Join-Path $outputDir 'tool_no_token.json')
Capture-Http -Method POST -Uri "$base/invoke/github.no_such_tool" -Body '{}' -OutFile (Join-Path $outputDir 'tool_unknown.json')
Capture-Http -Method POST -Uri "$base/invoke/github.get_repository" -Body '{}' -OutFile (Join-Path $outputDir 'tool_validation_error.json')

Stop-McpServer $proc1

# ---------------------------------------------------------------------------
Write-Section "Run 2: seed token, restart, verify persistence"

Reset-McpEnv

$tokenStorePath = Join-Path $repoRoot '.data\github-tokens.json'
$tokenStoreDir  = Split-Path -Parent $tokenStorePath
if (-not (Test-Path $tokenStoreDir)) {
    New-Item -ItemType Directory -Path $tokenStoreDir | Out-Null
}

$seed = @{
    alice = @{
        accessToken = 'ghp_seed_value_for_validation'
        obtainedAt  = 0
    }
} | ConvertTo-Json -Depth 5
$seed | Out-File -FilePath $tokenStorePath -Encoding utf8

$proc2 = Start-McpServer -Env @{
    PORT                    = "$Port"
    LOG_LEVEL               = 'info'
    GITHUB_TOKEN_STORE_PATH = $tokenStorePath
}
Write-Host "Started node PID $($proc2.Id)"

if (-not (Wait-PortReady -Port $Port -TimeoutSec $ReadyTimeoutSeconds)) {
    Write-Host "Server did not bind to :$Port within $ReadyTimeoutSeconds s." -ForegroundColor Red
    Stop-McpServer $proc2
    exit 1
}

Capture-Http -Method GET -Uri "$base/healthz" -OutFile (Join-Path $outputDir 'post_restart_health.json')

# Snapshot the token store file as-is so we can see whether the server kept
# the alice entry or rewrote it.
if (Test-Path $tokenStorePath) {
    Get-Content -Raw -Path $tokenStorePath |
        Out-File -FilePath (Join-Path $outputDir 'token_store_after_restart.txt') -Encoding utf8
} else {
    'MISSING' | Out-File -FilePath (Join-Path $outputDir 'token_store_after_restart.txt') -Encoding utf8
}

Stop-McpServer $proc2

# ---------------------------------------------------------------------------
Write-Section "Run 3: server with PAT only (no StackOne)"

Reset-McpEnv

$proc3 = Start-McpServer -Env @{
    PORT         = "$Port"
    LOG_LEVEL    = 'info'
    GITHUB_TOKEN = 'ghp_fake_for_runtime_shape_only'
}
Write-Host "Started node PID $($proc3.Id)"

if (-not (Wait-PortReady -Port $Port -TimeoutSec $ReadyTimeoutSeconds)) {
    Write-Host "Server did not bind to :$Port within $ReadyTimeoutSeconds s." -ForegroundColor Red
    Stop-McpServer $proc3
    exit 1
}

Capture-Http -Method GET -Uri "$base/healthz" -OutFile (Join-Path $outputDir 'healthz_with_pat.json')

Stop-McpServer $proc3

# ---------------------------------------------------------------------------
# Snapshot of the stderr from the most recent run — useful evidence for
# silent-error analysis. (Each run overwrites this file because we don't
# rotate; it reflects Run 3.)
if (Test-Path (Join-Path $outputDir 'server.stderr.log')) {
    Get-Content -Raw -Path (Join-Path $outputDir 'server.stderr.log') |
        Out-File -FilePath (Join-Path $outputDir 'server_stderr_tail.txt') -Encoding utf8
}

Write-Section 'Captured files'
Get-ChildItem -Path $outputDir -File |
    Sort-Object Name |
    ForEach-Object { '{0,8}  {1}' -f $_.Length, $_.Name }

Write-Host ''
Write-Host "All evidence written to: $outputDir" -ForegroundColor Green
Write-Host 'Paste the contents of each .json/.txt file in your next chat message.'
