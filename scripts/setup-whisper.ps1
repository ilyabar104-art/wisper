# Build whisper.cpp on Windows and copy whisper-server.exe + DLLs into resources/bin.
# Requires: Visual Studio Build Tools (cl, MSBuild) and CMake on PATH.
#
# GPU acceleration (auto-detected):
#   Vulkan  — enabled if Vulkan SDK is found (works on Intel/AMD/NVIDIA integrated & discrete)
#   CUDA    — enabled if nvcc is on PATH (NVIDIA only)
#   Default — optimised CPU build with OpenMP
#
# To force a specific backend:
#   .\setup-whisper.ps1 -Backend vulkan
#   .\setup-whisper.ps1 -Backend cuda
#   .\setup-whisper.ps1 -Backend cpu
param(
  [ValidateSet('auto','vulkan','cuda','cpu')]
  [string]$Backend = 'auto'
)
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$cache  = Join-Path $root '.cache\whisper.cpp'
$outDir = Join-Path $root 'resources\bin'
$outBin = Join-Path $outDir 'whisper-server.exe'

if (Test-Path $outBin) {
  Write-Host "whisper-server.exe already exists at $outBin — skipping. Delete to force rebuild."
  exit 0
}

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
  Write-Error 'cmake not found. Install with: winget install Kitware.CMake'
  exit 1
}

New-Item -ItemType Directory -Force -Path $outDir          | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $cache) | Out-Null

# ---- Clone / update whisper.cpp ------------------------------------------
if (-not (Test-Path $cache)) {
  Write-Host 'Cloning whisper.cpp…'
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git $cache
} else {
  Write-Host 'Updating whisper.cpp…'
  Push-Location $cache
  try { git pull --ff-only } catch {} finally { Pop-Location }
}

# ---- Detect best available backend ---------------------------------------
function Test-Vulkan {
  # Check for Vulkan SDK (installer sets VULKAN_SDK env var)
  if ($env:VULKAN_SDK -and (Test-Path $env:VULKAN_SDK)) { return $true }
  # Fallback: look for vulkan-1.dll in system32
  return Test-Path 'C:\Windows\System32\vulkan-1.dll'
}

function Test-Cuda {
  return [bool](Get-Command nvcc -ErrorAction SilentlyContinue)
}

$resolved = $Backend
if ($resolved -eq 'auto') {
  if (Test-Cuda)   { $resolved = 'cuda' }
  elseif (Test-Vulkan) { $resolved = 'vulkan' }
  else             { $resolved = 'cpu' }
}

Write-Host "Backend selected: $($resolved.ToUpper())"

$cmakeExtra = @(
  '-DCMAKE_BUILD_TYPE=Release',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_TESTS=OFF'
)

switch ($resolved) {
  'cuda' {
    $cmakeExtra += '-DGGML_CUDA=ON'
    Write-Host 'CUDA enabled — NVIDIA GPU will be used for inference.'
  }
  'vulkan' {
    $cmakeExtra += '-DGGML_VULKAN=ON'
    if ($env:VULKAN_SDK) { $cmakeExtra += "-DVULKAN_SDK=$env:VULKAN_SDK" }
    Write-Host 'Vulkan enabled — Intel/AMD/NVIDIA GPU will be used for inference.'
    Write-Host 'If build fails, install the Vulkan SDK from https://vulkan.lunarg.com/'
  }
  'cpu' {
    Write-Host 'CPU-only build. For faster inference install Vulkan SDK and re-run.'
  }
}

# ---- CMake configure + build ---------------------------------------------
Write-Host 'Configuring CMake…'
$cmakeArgs = @('-S', $cache, '-B', "$cache\build") + $cmakeExtra
& cmake @cmakeArgs

Write-Host 'Building whisper-server…'
cmake --build "$cache\build" --config Release --target whisper-server -j

# ---- Locate built binary -------------------------------------------------
$built = $null
foreach ($cand in @(
  "$cache\build\bin\Release\whisper-server.exe",
  "$cache\build\Release\whisper-server.exe",
  "$cache\build\examples\server\Release\whisper-server.exe",
  "$cache\build\bin\whisper-server.exe"
)) {
  if (Test-Path $cand) { $built = $cand; break }
}
if (-not $built) {
  Write-Error 'whisper-server.exe not found after build. Check CMake output above.'
  exit 1
}

Copy-Item $built $outBin -Force
Write-Host "Copied whisper-server.exe → $outBin"

# ---- Copy runtime DLLs ---------------------------------------------------
# MSVC puts them next to the .exe; Vulkan/CUDA add extra ones in subdirs.
$srcDir = Split-Path $built
Get-ChildItem $srcDir -Filter '*.dll' -ErrorAction SilentlyContinue |
  ForEach-Object { Copy-Item $_.FullName $outDir -Force; Write-Host "  dll: $($_.Name)" }

Get-ChildItem -Path "$cache\build" -Recurse -Filter '*.dll' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notlike '*CMakeFiles*' } |
  ForEach-Object { Copy-Item $_.FullName $outDir -Force }

# Copy Vulkan helper DLL if present in Vulkan SDK
if ($resolved -eq 'vulkan' -and $env:VULKAN_SDK) {
  $vkDll = Join-Path $env:VULKAN_SDK 'Bin\vulkan-1.dll'
  if (Test-Path $vkDll) {
    Copy-Item $vkDll $outDir -Force
    Write-Host '  dll: vulkan-1.dll (from Vulkan SDK)'
  }
}

# ---- Build win-hotkey.exe (keyboard hook helper) -------------------------
$hookSrc = Join-Path $root 'native\win-hotkey.c'
$hookBin = Join-Path $outDir 'win-hotkey.exe'

if (-not (Test-Path $hookBin)) {
  if (Get-Command cl -ErrorAction SilentlyContinue) {
    Write-Host 'Building win-hotkey.exe…'
    & cl /O2 /W3 $hookSrc /Fe:$hookBin user32.lib /nologo
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'win-hotkey.exe build failed — hotkeys will work but Space/Tab may leak into the active app.'
    } else {
      Write-Host "Copied win-hotkey.exe → $hookBin"
    }
  } else {
    Write-Warning 'cl.exe not found — run this script from a VS Developer Command Prompt to build win-hotkey.exe.'
    Write-Warning 'Without it, hotkeys work but printable keys (Space, Tab) may leak into the active app.'
  }
} else {
  Write-Host "win-hotkey.exe already exists — skipping."
}

Write-Host ''
Write-Host "Done. Backend: $($resolved.ToUpper())"
Write-Host "whisper-server.exe installed at: $outBin"
