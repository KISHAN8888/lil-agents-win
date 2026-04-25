#Requires -Version 5.1
# Generates app.ico from a source PNG (requires ImageMagick 'magick' in PATH)
$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot '..\assets\app-source.png'
$out = Join-Path $PSScriptRoot '..\assets\app.ico'

if (-not (Test-Path $src)) {
    Write-Error "Source PNG not found at assets\app-source.png"
    exit 1
}

magick convert $src -define icon:auto-resize=256,48,32,16 $out
Write-Host "Icon written to $out"
