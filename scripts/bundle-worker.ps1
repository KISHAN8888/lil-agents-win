# scripts/bundle-worker.ps1
# Requires pyinstaller: pip install pyinstaller

cd worker
pip install -r pyproject.toml # If we had one in pip format, but we have pyproject.toml
# For now, assume deps are installed

pyinstaller --onefile --name worker worker.py --collect-all pypdf --collect-all trafilatura --collect-all rapidfuzz

if ($LASTEXITCODE -eq 0) {
    Write-Host "Worker bundled successfully."
} else {
    Write-Host "Worker bundling failed." -ForegroundColor Red
}
