# dsh-plugin-socket — Windows 一行安装
# irm https://raw.githubusercontent.com/ssszzz7/dsh-plugin-socket/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/ssszzz7/dsh-plugin-socket.git'
$dest = if ($env:DSH_SOCKET_HOME) { $env:DSH_SOCKET_HOME } else { Join-Path $env:USERPROFILE 'dsh-plugin-socket' }
$binDir = if ($env:DSH_SOCKET_BIN) { $env:DSH_SOCKET_BIN } else { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node not found in PATH, install Node.js 18+ first' }

if (Test-Path (Join-Path $dest '.git')) {
  Write-Host "[1/3] updating $dest"
  git -C $dest pull --ff-only
} else {
  Write-Host "[1/3] cloning into $dest"
  git clone --depth 1 $repo $dest
}

Write-Host "[2/3] writing launcher"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$cmd = Join-Path $binDir 'dsh-plugin.cmd'
Set-Content -Path $cmd -Encoding ASCII -Value "@echo off`r`nnode `"$dest\bin\dsh-plugin.js`" %*"

Write-Host "[3/3] smoke test"
node "$dest\bin\dsh-plugin.js" --help | Select-Object -First 2
Write-Host ""
Write-Host "done. try:  dsh-plugin scan --profile desktop"
