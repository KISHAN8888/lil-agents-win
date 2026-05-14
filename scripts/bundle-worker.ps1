# scripts/bundle-worker.ps1
# Bundles worker.py into a standalone worker.exe using PyInstaller.
# Called automatically as the npm predist hook.

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path $PSScriptRoot -Parent
$WorkerDir   = Join-Path $ProjectRoot "worker"
$VenvDir     = Join-Path $WorkerDir ".venv"
$VenvPip     = Join-Path $VenvDir "Scripts\pip.exe"
$VenvPyInst  = Join-Path $VenvDir "Scripts\pyinstaller.exe"

Write-Host "==> [worker] Setting up venv..." -ForegroundColor Cyan
if (-not (Test-Path $VenvDir)) {
    python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to create Python venv" }
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

Write-Host "==> [worker] Installing dependencies..." -ForegroundColor Cyan
& $VenvPython -m pip install --quiet pyinstaller
if ($LASTEXITCODE -ne 0) { throw "pyinstaller install failed" }

# Install worker dependencies directly (avoids pyproject.toml build-backend complexity)
& $VenvPython -m pip install --quiet `
    "pypdf>=4.2.0" `
    "python-docx>=1.1.2" `
    "trafilatura>=1.11.0" `
    "requests>=2.32.0" `
    "portalocker>=2.8.2" `
    "pydantic>=2.7.4" `
    "rapidfuzz>=3.9.3" `
    "pyyaml>=6.0.1"
if ($LASTEXITCODE -ne 0) { throw "worker dependency install failed" }

Write-Host "==> [worker] Running PyInstaller..." -ForegroundColor Cyan
Push-Location $WorkerDir
try {
    & $VenvPyInst `
        --onefile `
        --name worker `
        --distpath dist `
        --workpath build `
        --specpath build `
        --add-data "$WorkerDir\prompts;prompts" `
        --collect-all pypdf `
        --collect-all trafilatura `
        --collect-all rapidfuzz `
        --collect-all docx `
        --collect-all portalocker `
        --hidden-import yaml `
        --noconfirm `
        --clean `
        worker.py

    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
} finally {
    Pop-Location
}

$ExePath = Join-Path $WorkerDir "dist\worker.exe"
if (Test-Path $ExePath) {
    $SizeMB = [math]::Round((Get-Item $ExePath).Length / 1MB, 1)
    Write-Host "==> [worker] worker.exe ready ($SizeMB MB)" -ForegroundColor Green
} else {
    throw "worker.exe not found after PyInstaller run"
}
