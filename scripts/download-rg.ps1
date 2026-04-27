# scripts/download-rg.ps1
# Downloads ripgrep (rg.exe) and places it in resources/bin/rg.exe for packaging

$url = "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-pc-windows-msvc.zip"
$zipFile = "ripgrep.zip"
$extractPath = "ripgrep_extracted"
$targetDir = "resources\bin"
$targetFile = "$targetDir\rg.exe"

Write-Host "Downloading ripgrep from $url..."
Invoke-WebRequest -Uri $url -OutFile $zipFile

Write-Host "Extracting $zipFile..."
Expand-Archive -Path $zipFile -DestinationPath $extractPath -Force

Write-Host "Creating target directory $targetDir..."
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

Write-Host "Moving rg.exe to $targetFile..."
Move-Item -Path "$extractPath\ripgrep-14.1.0-x86_64-pc-windows-msvc\rg.exe" -Destination $targetFile -Force

Write-Host "Cleaning up..."
Remove-Item -Recurse -Force $extractPath
Remove-Item -Force $zipFile

if (Test-Path $targetFile) {
    Write-Host "ripgrep successfully bundled at $targetFile" -ForegroundColor Green
} else {
    Write-Host "Failed to bundle ripgrep" -ForegroundColor Red
}
