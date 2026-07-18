[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

$workDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $workDir

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Gemi MCP V2 -- Setup" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# ── 1. Check Python ───────────────────────────────────────────
Write-Host "`n[1/6] Checking Python..." -ForegroundColor Yellow
try {
    $pyVer = & python --version 2>&1
    Write-Host "  Found: $pyVer" -ForegroundColor Green
} catch {
    Write-Error "Python not found. Install Python 3.10+ from https://python.org"
    Read-Host "Press Enter to exit"; exit 1
}

# ── 2. Engine venv ────────────────────────────────────────────
Write-Host "`n[2/6] Engine venv (Playwright + FastAPI)..." -ForegroundColor Yellow
$engineVenv = Join-Path $workDir "Gemi_Engine_V2\.venv"
if (-not (Test-Path $engineVenv)) {
    & python -m venv $engineVenv
}
& "$engineVenv\Scripts\python.exe" -m pip install -r "Gemi_Engine_V2\requirements.txt" --quiet
if ($LASTEXITCODE -ne 0) { Write-Error "pip install (engine) failed"; Read-Host; exit 1 }

# VC++ Runtime check -- after pip install so msvc-runtime's DLLs are already in the venv,
# and before playwright install which imports greenlet (needs msvcp140.dll).
if (Test-Path "$engineVenv\Scripts\msvcp140.dll") {
    Write-Host "  VC++ Runtime present (venv, portable)." -ForegroundColor Green
} elseif (Test-Path "$env:WINDIR\System32\msvcp140.dll") {
    Write-Host "  VC++ Runtime present (system)." -ForegroundColor Green
} else {
    Write-Host "  msvcp140.dll missing, installing VCRedist via winget..." -ForegroundColor Yellow
    winget install --id Microsoft.VCRedist.2015+.x64 -e --accept-source-agreements --accept-package-agreements
    if (-not (Test-Path "$env:WINDIR\System32\msvcp140.dll")) {
        Write-Warning "  VCRedist install could not be confirmed. If startup fails with a greenlet DLL error, install 'Microsoft Visual C++ 2015-2022 Redistributable (x64)' manually."
    }
}

# Portable Playwright browsers -- keep Chromium inside the project folder.
# Must be an ABSOLUTE path (relative paths resolve against process CWD).
$pwBrowsers = Join-Path $workDir "Gemi_Engine_V2\ms-playwright"
$env:PLAYWRIGHT_BROWSERS_PATH = $pwBrowsers

# One-time migration: reuse browsers already downloaded to %LOCALAPPDATA% (~250MB)
# and clean the old C-drive directory in the same move.
$oldPwBrowsers = Join-Path $env:LOCALAPPDATA "ms-playwright"
if ((Test-Path $oldPwBrowsers) -and (-not (Test-Path $pwBrowsers))) {
    Write-Host "  Migrating existing browsers from $oldPwBrowsers ..." -ForegroundColor Yellow
    try {
        Move-Item -Path $oldPwBrowsers -Destination $pwBrowsers -Force -ErrorAction Stop
        Write-Host "  Migration done." -ForegroundColor Green
    } catch {
        Write-Warning "  Migration failed ($_). A fresh copy will be downloaded instead."
    }
}

& "$engineVenv\Scripts\python.exe" -m playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Error "playwright install failed"; Read-Host; exit 1 }
Write-Host "  Done." -ForegroundColor Green

# ── 3. Outer venv ─────────────────────────────────────────────
Write-Host "`n[3/6] Outer venv (MCP Python deps)..." -ForegroundColor Yellow
$outerVenv = Join-Path $workDir ".venv"
if (-not (Test-Path $outerVenv)) {
    & python -m venv $outerVenv
}
& "$outerVenv\Scripts\python.exe" -m pip install -r "mcp\requirements.txt" --quiet
if ($LASTEXITCODE -ne 0) { Write-Error "pip install (mcp) failed"; Read-Host; exit 1 }
Write-Host "  Done." -ForegroundColor Green

# ── 4. Portable Node.js ───────────────────────────────────────
Write-Host "`n[4/6] Portable Node.js..." -ForegroundColor Yellow
$nodeDir = Join-Path $workDir ".node_venv"
$nodeUrl = "https://nodejs.org/dist/v20.11.1/node-v20.11.1-win-x64.zip"
$nodeZip = Join-Path $workDir "node-portable.zip"

if (-not (Test-Path $nodeDir)) {
    Write-Host "  Downloading Node.js v20.11.1..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UserAgent "Mozilla/5.0" -UseBasicParsing
        $tempDir = Join-Path $workDir ".node_temp"
        New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
        Expand-Archive -Path $nodeZip -DestinationPath $tempDir -Force
        $inner = Get-ChildItem -Path $tempDir -Directory | Select-Object -First 1
        Move-Item -Path $inner.FullName -Destination $nodeDir -Force
        Remove-Item $nodeZip -Force
        Remove-Item $tempDir -Recurse -Force
        Write-Host "  Node.js extracted to .node_venv" -ForegroundColor Green
    } catch {
        if (Test-Path $nodeZip) { Remove-Item $nodeZip -Force }
        Write-Error "Failed to download Node.js: $_"; Read-Host; exit 1
    }
} else {
    Write-Host "  .node_venv already exists, skipping download." -ForegroundColor Green
}

$env:PATH = "$nodeDir;" + $env:PATH
$nodeVer = & "$nodeDir\node.exe" --version
$npmVer  = & "$nodeDir\npm.cmd" --version
Write-Host "  node $nodeVer  /  npm $npmVer" -ForegroundColor Green

# ── 5. npm install (TUI) ──────────────────────────────────────
Write-Host "`n[5/6] npm install (Ink TUI)..." -ForegroundColor Yellow
Push-Location "tui"
& "$nodeDir\npm.cmd" install
$npmExit = $LASTEXITCODE
Pop-Location
if ($npmExit -ne 0) { Write-Error "npm install failed"; Read-Host; exit 1 }
Write-Host "  Done." -ForegroundColor Green

# ── 6. Create Desktop Shortcut ────────────────────────────────
Write-Host "`n[6/6] Creating Desktop Shortcut..." -ForegroundColor Yellow
try {
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktopPath "Gemi MCP V2.lnk"
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($shortcutPath)
    $Shortcut.TargetPath = Join-Path $workDir "run.bat"
    $Shortcut.WorkingDirectory = $workDir
    $Shortcut.IconLocation = Join-Path $workDir "asset\logo\logo.ico"
    $Shortcut.Save()
    Write-Host "  Shortcut created at: $shortcutPath" -ForegroundColor Green
} catch {
    Write-Warning "  Failed to create Desktop shortcut: $_"
}

# ── Done ──────────────────────────────────────────────────────
Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "  Setup complete." -ForegroundColor Cyan
Write-Host "" -ForegroundColor Cyan
Write-Host "  Start engine:" -ForegroundColor White
Write-Host "    cd Gemi_Engine_V2" -ForegroundColor Gray
Write-Host "    .venv\Scripts\python.exe engine_service.py" -ForegroundColor Gray
Write-Host "" -ForegroundColor Cyan
Write-Host "  Start TUI:" -ForegroundColor White
Write-Host "    .node_venv\node.exe tui\app.js" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan
Read-Host "`nPress Enter to exit"
