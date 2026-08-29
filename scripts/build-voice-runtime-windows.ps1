param(
  [string]$WhisperVersion = "",
  [string]$WhisperCommit = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot "scripts\voice-runtime-config.json"
$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not $WhisperVersion) { $WhisperVersion = [string]$Config.runtimeVersion }
if (-not $WhisperCommit) { $WhisperCommit = [string]$Config.whisperCommit }
if ($WhisperVersion -ne [string]$Config.runtimeVersion -or $WhisperCommit -ne [string]$Config.whisperCommit) {
  throw "voice runtime version/commit must match $ConfigPath"
}
if ($env:TARGET_ARCH -and $env:TARGET_ARCH -ne "x64") {
  throw "Windows voice runtime only supports the x64 target, got $env:TARGET_ARCH"
}
$CommitKey = $WhisperCommit.Substring(0, 12)
$WorkBase = $env:RUNNER_TEMP ?? (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".mvr")
$WorkRoot = Join-Path $WorkBase $CommitKey
$ArchivePath = Join-Path $WorkRoot "source.zip"
$ExtractedSourceRoot = Join-Path $WorkRoot "whisper.cpp-$WhisperCommit"
$SourceRoot = Join-Path $WorkRoot "src"
$BuildRoot = Join-Path $WorkRoot "build"
$StageRoot = Join-Path $WorkRoot "stage"
$DistRoot = Join-Path $ProjectRoot "dist"
$OutputPath = Join-Path $DistRoot "whisper-server-win32-x64-vulkan.zip"
$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $VsWhere)) {
  throw "vswhere.exe was not found; Visual Studio 2022 C++ Build Tools are required"
}
$VsInstall = (& $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if (-not $VsInstall) {
  throw "Visual Studio 2022 C++ Build Tools were not found"
}
$VsDevCmd = Join-Path $VsInstall "Common7\Tools\VsDevCmd.bat"
$DevEnvironment = & $env:ComSpec /d /s /c "`"$VsDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) {
  throw "Visual Studio developer environment initialization failed"
}
foreach ($Line in $DevEnvironment) {
  $Parts = $Line -split "=", 2
  if ($Parts.Count -eq 2 -and -not $Parts[0].StartsWith("=")) {
    [Environment]::SetEnvironmentVariable($Parts[0], $Parts[1], "Process")
  }
}
if (-not $env:VCINSTALLDIR -or -not $env:VCToolsInstallDir) {
  throw "Visual Studio developer environment did not provide the C++ toolchain paths"
}
$env:VCInstallDir_170 = $env:VCINSTALLDIR
$env:VCToolsInstallDir_170 = $env:VCToolsInstallDir
$VcTargetsPath = Join-Path $VsInstall "MSBuild\Microsoft\VC\v170"
if (-not (Test-Path -LiteralPath (Join-Path $VcTargetsPath "Microsoft.Cpp.Default.props"))) {
  throw "Visual Studio C++ targets were not found under $VcTargetsPath"
}
$env:VCTargetsPath = "$VcTargetsPath\"
if (-not $env:VULKAN_SDK) {
  throw "VULKAN_SDK is not set; install the configured Vulkan SDK before building"
}
foreach ($RequiredVulkanPath in @(
  (Join-Path $env:VULKAN_SDK "Include\vulkan\vulkan.h"),
  (Join-Path $env:VULKAN_SDK "Lib\vulkan-1.lib"),
  (Join-Path $env:VULKAN_SDK "Bin\glslc.exe"),
  (Join-Path $env:VULKAN_SDK "Lib\cmake\SPIRV-HeadersConfig.cmake")
)) {
  if (-not (Test-Path -LiteralPath $RequiredVulkanPath)) {
    throw "Vulkan SDK file was not found: $RequiredVulkanPath"
  }
}

Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $WorkRoot, $StageRoot, $DistRoot | Out-Null

$SourceUrl = "https://github.com/ggml-org/whisper.cpp/archive/$WhisperCommit.zip"
Invoke-WebRequest -Uri $SourceUrl -OutFile $ArchivePath
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $WorkRoot
Move-Item -LiteralPath $ExtractedSourceRoot -Destination $SourceRoot

# Portability baseline (GGML_NATIVE=OFF + explicit ISA).
#
# ggml defaults GGML_NATIVE=ON, which tunes the binary to the BUILD machine.
# GitHub's Windows runners expose AVX-512, so the published asset carried
# AVX-512 instructions and died with STATUS_ILLEGAL_INSTRUCTION (0xC000001D)
# on any narrower CPU — observed on Intel Arrow Lake (Core Ultra 7 265KF),
# which tops out at AVX2. The crash landed right after backend init, so the
# `--help` smoke below could never catch it: on the build machine it passes.
#
# Pin an AVX2/FMA/F16C baseline (Haswell 2013+) so one asset runs on every
# supported x64 machine. AVX-512 / AVX-VNNI / BMI2 stay OFF: they are not
# universal on current consumer CPUs and this build leans on Vulkan for the
# heavy math anyway.
cmake -S $SourceRoot -B $BuildRoot -G "Visual Studio 17 2022" -A x64 `
  "-DCMAKE_GENERATOR_INSTANCE=$VsInstall" `
  "-DCMAKE_PREFIX_PATH=$env:VULKAN_SDK" `
  "-DSPIRV-Headers_DIR=$(Join-Path $env:VULKAN_SDK 'Lib\cmake')" `
  -DCMAKE_BUILD_TYPE=Release `
  -DBUILD_SHARED_LIBS=ON `
  -DGGML_VULKAN=ON `
  -DGGML_NATIVE=OFF `
  -DGGML_AVX=ON `
  -DGGML_AVX2=ON `
  -DGGML_FMA=ON `
  -DGGML_F16C=ON `
  -DGGML_AVX512=OFF `
  -DGGML_AVX_VNNI=OFF `
  -DGGML_BMI2=OFF `
  -DWHISPER_BUILD_EXAMPLES=ON `
  -DWHISPER_BUILD_SERVER=ON `
  -DWHISPER_BUILD_TESTS=OFF `
  -DWHISPER_SDL2=OFF
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Serial compilation avoids MSVC PDB contention in the Vulkan shader generator.
cmake --build $BuildRoot --config Release --target whisper-server --parallel 1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Server = Get-ChildItem -LiteralPath $BuildRoot -Recurse -File -Filter "whisper-server.exe" |
  Select-Object -First 1
if (-not $Server) { throw "whisper-server.exe was not produced" }

Copy-Item -LiteralPath $Server.FullName -Destination (Join-Path $StageRoot "whisper-server.exe")
Copy-Item -LiteralPath (Join-Path $SourceRoot "LICENSE") -Destination (Join-Path $StageRoot "LICENSE-whisper.cpp.txt")
Get-ChildItem -LiteralPath $Server.DirectoryName -File -Filter "*.dll" |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $StageRoot }

& (Join-Path $StageRoot "whisper-server.exe") --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw "packaged whisper-server --help failed with exit code $LASTEXITCODE" }

Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $StageRoot "*") -DestinationPath $OutputPath -CompressionLevel Optimal

$Hash = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
$Size = (Get-Item -LiteralPath $OutputPath).Length
Set-Content -LiteralPath "$OutputPath.sha256" -Value "$Hash  $(Split-Path -Leaf $OutputPath)" -Encoding utf8NoBOM
Write-Host "voice-runtime $WhisperVersion win32-x64 vulkan: $OutputPath ($Size bytes, sha256=$Hash)"
