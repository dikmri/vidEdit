# vidEdit installer for Windows
# Usage: irm https://raw.githubusercontent.com/dikmri/vidEdit/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host "Fetching latest release info..." -ForegroundColor Cyan

$apiUrl = "https://api.github.com/repos/dikmri/vidEdit/releases/latest"
$release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "vidEdit-installer" }

$asset = $release.assets | Where-Object { $_.name -like "*-setup.exe" } | Select-Object -First 1

if (-not $asset) {
    Write-Error "Could not find setup.exe in the latest release."
    exit 1
}

$downloadUrl = $asset.browser_download_url
$fileName = $asset.name
$tmpPath = Join-Path $env:TEMP $fileName

Write-Host "Downloading $fileName..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpPath -UseBasicParsing

Write-Host "Installing..." -ForegroundColor Cyan
Start-Process -FilePath $tmpPath -ArgumentList "/S" -Wait

Write-Host "vidEdit has been installed successfully!" -ForegroundColor Green
Write-Host "Note: FFmpeg is required but not bundled. Install with:" -ForegroundColor Yellow
Write-Host "  winget install Gyan.FFmpeg" -ForegroundColor Yellow
