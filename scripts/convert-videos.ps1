#Requires -Version 5.1
# Converts source .mov files in assets-src\ to VP9 WebM with alpha channel.
# Run once per source video update. Requires ffmpeg in PATH.
$ErrorActionPreference = 'Stop'

$srcDir = Join-Path $PSScriptRoot '..\assets-src'
$outDir = Join-Path $PSScriptRoot '..\assets'

if (-not (Test-Path $srcDir)) {
    Write-Error "assets-src\ directory not found. Create it and add source .mov files."
    exit 1
}

$sources = Get-ChildItem "$srcDir\*.mov"
if ($sources.Count -eq 0) {
    Write-Warning "No .mov files found in assets-src\"
    exit 0
}

foreach ($src in $sources) {
    $out = Join-Path $outDir ($src.BaseName + '.webm')
    Write-Host "Converting $($src.Name) → $($src.BaseName).webm"
    ffmpeg -y -i $src.FullName `
        -c:v libvpx-vp9 `
        -pix_fmt yuva420p `
        -b:v 2M `
        -auto-alt-ref 0 `
        -metadata:s:v:0 alpha_mode="1" `
        $out
    Write-Host "Done: $out"

    # Export first frame as PNG fallback
    $png = Join-Path $outDir ($src.BaseName + '.png')
    ffmpeg -y -i $out -vframes 1 $png
    Write-Host "Fallback frame: $png"
}

Write-Host "All conversions complete."
