$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeDir = Join-Path $root ".node_venv"
$tuiDir  = Join-Path $root "tui"

$lockFile = Join-Path $tuiDir ".tui.lock"

if (Test-Path $lockFile) {
    $existingPid = (Get-Content $lockFile -Raw -ErrorAction SilentlyContinue)
    if ($existingPid) { $existingPid = $existingPid.Trim() }
    if ($existingPid -match '^\d+$' -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
        Write-Error "TUI appears to already be running (PID $existingPid). Close that window before starting a new one."
        Read-Host "Press Enter to exit"; exit 1
    }
    # Stale lock from a previous session that didn't exit cleanly — clean it up and proceed.
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $lockFile -Value $PID -NoNewline

if (-not (Test-Path "$nodeDir\node.exe")) {
    Write-Error "Portable Node.js not found. Run setup.bat first."
    Read-Host "Press Enter to exit"; exit 1
}

$cfgPath = Join-Path $root "engine_config.json"
$port = 18900
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        if ($cfg.port -ne $null) { $port = [int]$cfg.port }
    } catch {}
}

# Ensure the engine service is running on the configured port; start it if not.
function Test-Engine {
    try { Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true }
    catch { return $false }
}

$engineDir = Join-Path $root "Gemi_Engine_V2"
$enginePy  = Join-Path $engineDir ".venv\Scripts\python.exe"
$engineProc = $null   # track PID only if we launched it

if (Test-Engine) {
    Write-Host "Engine service already running on :$port." -ForegroundColor Green
} else {
    Write-Host "Engine service offline - starting it..." -ForegroundColor Yellow
    if (-not (Test-Path $enginePy)) {
        Write-Error "Engine venv not found. Run setup.bat first."
        Read-Host "Press Enter to exit"; exit 1
    }

    # Clean up leftover Playwright Chromium processes and lock files
    Write-Host "  Cleaning up leftover Playwright Chromium processes..." -ForegroundColor Cyan
    Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*ms-playwright*" } | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host "  Cleaning up leftover browser session sandboxes..." -ForegroundColor Cyan
    $sandboxPaths = @(
        (Join-Path $root "browser_session_sandbox"),
        (Join-Path $engineDir "browser_session_sandbox")
    )
    foreach ($path in $sandboxPaths) {
        if (Test-Path "$path\Default") {
            cmd /c rmdir "$path\Default" 2>$null
        }
        if (Test-Path $path) {
            Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $logOut = Join-Path $engineDir "engine.log"
    $logErr = Join-Path $engineDir "engine_err.log"
    $engineExe  = $enginePy -replace 'python\.exe$','pythonw.exe'
    $winStyle   = 'Hidden'
    $engineProc = Start-Process -FilePath $engineExe -ArgumentList "engine_service.py" -WorkingDirectory $engineDir -WindowStyle $winStyle -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru
    Write-Host "  Waiting for engine to come up..." -ForegroundColor Yellow
    $ready = $false
    foreach ($i in 1..20) {
        Start-Sleep -Milliseconds 500
        if (Test-Engine) { $ready = $true; break }
    }
    if ($ready) { Write-Host "  Engine service is up." -ForegroundColor Green }
    else { Write-Warning "  Engine did not respond in time - TUI will show offline." }
}

$env:PATH = "$nodeDir;" + $env:PATH
Set-Location $tuiDir

Write-Host "Building TUI..." -ForegroundColor Yellow
& "$nodeDir\node.exe" build.mjs
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; Read-Host; exit 1 }

Write-Host "Starting TUI..." -ForegroundColor Green
& "$nodeDir\node.exe" "dist\app.mjs"

Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

