$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$temporaryRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) "pandora-electron-build"))
$systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $temporaryRoot.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe temporary build path: $temporaryRoot"
}

if (Test-Path -LiteralPath $temporaryRoot) {
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

$legacyNsis = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\nsis\nsis-3.0.4.1"
$legacyNsisResources = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\nsis\nsis-resources-3.4.1"
if (Test-Path -LiteralPath $legacyNsis) {
  $env:ELECTRON_BUILDER_NSIS_DIR = $legacyNsis
}
if (Test-Path -LiteralPath $legacyNsisResources) {
  $env:ELECTRON_BUILDER_NSIS_RESOURCES_DIR = $legacyNsisResources
}

Push-Location $projectRoot
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }

  $builder = Join-Path $projectRoot "node_modules\.bin\electron-builder.cmd"
  & $builder --win nsis portable "--config.directories.output=$temporaryRoot"
  if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed." }

  $version = (Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json).version
  $releaseRoot = Join-Path $projectRoot "release"
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  @(
    "Pandora-Setup-$version.exe",
    "Pandora-Setup-$version.exe.blockmap",
    "Pandora-Portable-$version.exe"
  ) | ForEach-Object {
    $source = Join-Path $temporaryRoot $_
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $releaseRoot $_) -Force
    }
  }
} finally {
  Pop-Location
}
