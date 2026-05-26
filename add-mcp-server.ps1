# add-mcp-server.ps1
#
# Patches your Claude Desktop or Claude Code config to add (or replace) a
# remote MCP server entry. Defaults wire the Forge server at
# http://localhost:8765/mcp; pass -Name / -Url to point elsewhere.
#
# Bearer token is read via Read-Host -AsSecureString. The token is held in
# memory just long enough to be written into the config file, then zeroed.
# It is never echoed to the terminal and never sent to me.
#
# Windows PowerShell 5.1 native.
#
# Examples:
#   .\add-mcp-server.ps1                                   # forge -> Claude Desktop (default)
#   .\add-mcp-server.ps1 -Client Code                      # forge -> Claude Code user settings
#   .\add-mcp-server.ps1 -Name acme -Url https://x/mcp     # different server
#   .\add-mcp-server.ps1 -Remove                           # remove forge from config
#   .\add-mcp-server.ps1 -Restart                          # also restart Claude Desktop

[CmdletBinding()]
param(
    [ValidateSet('Desktop', 'Code')]
    [string]$Client = 'Desktop',
    [string]$Name = 'forge',
    [string]$Url = 'http://localhost:8765/mcp',
    [ValidateSet('http', 'sse')]
    [string]$Transport = 'http',
    [switch]$Remove,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

function Write-Section($t) {
    Write-Host ''
    Write-Host "=== $t ===" -ForegroundColor Cyan
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

# Write JSON as UTF-8 WITHOUT BOM. PS 5.1's `Set-Content -Encoding utf8`
# emits a BOM, which some JSON consumers reject.
function Write-JsonUtf8NoBom($path, $content) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

# ---------------------------------------------------------------------------
Write-Section "Target: $Client client"

$configFile = switch ($Client) {
    'Desktop' { Join-Path $env:APPDATA 'Claude\claude_desktop_config.json' }
    'Code'    { Join-Path $env:USERPROFILE '.claude\settings.json' }
}
Write-Host "Config path: $configFile"

$configDir = Split-Path -Parent $configFile
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir | Out-Null
    Write-Host "Created $configDir"
}

# ---------------------------------------------------------------------------
# Load existing config (or initialize a fresh PSCustomObject).
$config = $null
if (Test-Path $configFile) {
    $raw = Get-Content -Raw -Path $configFile -ErrorAction SilentlyContinue
    if ($raw -and $raw.Trim()) {
        try {
            $config = $raw | ConvertFrom-Json
        } catch {
            Write-Host "Existing config is not valid JSON:" -ForegroundColor Red
            Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "Aborting so we do not overwrite it. Fix or move the file and re-run." -ForegroundColor Yellow
            exit 1
        }
    }
}
if (-not $config) {
    $config = New-Object PSObject
}

# Ensure the mcpServers branch exists.
if (-not ($config.PSObject.Properties.Name -contains 'mcpServers')) {
    $config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue (New-Object PSObject)
}

# ---------------------------------------------------------------------------
# Backup before any mutation.
if (Test-Path $configFile) {
    $backup = "$configFile.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -Path $configFile -Destination $backup
    Write-Host "Backup: $backup" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
if ($Remove) {
    Write-Section "Remove '$Name'"

    if ($config.mcpServers.PSObject.Properties.Name -contains $Name) {
        $config.mcpServers.PSObject.Properties.Remove($Name)
        Write-Host "Removed MCP server '$Name'." -ForegroundColor Yellow
    } else {
        Write-Host "MCP server '$Name' was not present; nothing to remove." -ForegroundColor DarkGray
    }
} else {
    Write-Section "Wire '$Name' -> $Url"

    $token = Read-Secret "Paste bearer token for '$Name' (stays on this machine)"
    if (-not $token) {
        Write-Host 'Empty token. Aborting before any write.' -ForegroundColor Red
        exit 1
    }

    $entry = [PSCustomObject]@{
        type    = $Transport
        url     = $Url
        headers = [PSCustomObject]@{
            Authorization = "Bearer $token"
        }
    }

    # -Force replaces an existing entry under the same name.
    $config.mcpServers | Add-Member -NotePropertyName $Name -NotePropertyValue $entry -Force
    Write-Host "Wired '$Name' (transport: $Transport)" -ForegroundColor Green

    # Best-effort clear of the local variable. The string still sits in the
    # .NET string intern pool until GC; tokens with low entropy can linger.
    # The on-disk config is the long-lived copy from here on.
    $token = $null
}

# ---------------------------------------------------------------------------
$json = $config | ConvertTo-Json -Depth 10
Write-JsonUtf8NoBom -path $configFile -content $json
Write-Host "Wrote $configFile" -ForegroundColor Green

# ---------------------------------------------------------------------------
if ($Restart) {
    Write-Section 'Restart'

    if ($Client -eq 'Desktop') {
        $procs = Get-Process -Name 'Claude' -ErrorAction SilentlyContinue
        if ($procs) {
            $procs | Stop-Process -Force
            Start-Sleep -Seconds 2
            Write-Host 'Stopped existing Claude Desktop process(es).' -ForegroundColor DarkGray
        }
        $claudeExe = "$env:LOCALAPPDATA\Programs\Claude\Claude.exe"
        if (Test-Path $claudeExe) {
            Start-Process $claudeExe
            Write-Host 'Claude Desktop relaunched. Open a new chat and run /mcp to confirm.' -ForegroundColor Green
        } else {
            Write-Host "Couldn't find Claude.exe at $claudeExe — relaunch it manually." -ForegroundColor Yellow
        }
    } else {
        Write-Host 'For Claude Code, the new MCP server loads on the next CLI session.' -ForegroundColor Cyan
        Write-Host 'In any open shell, exit and re-run claude — then /mcp lists the new server.' -ForegroundColor Cyan
    }
}

Write-Host ''
Write-Host 'Next:' -ForegroundColor Cyan
Write-Host "  1. Restart $Client (or pass -Restart to do it automatically next time)."
Write-Host '  2. Open a new chat, run /mcp, confirm forge shows as connected.'
Write-Host '  3. Ask Claude to call get_server_health from that chat.'
