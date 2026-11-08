# 一键发布到 GitHub
# 用法:  .\publish.ps1 -Repo dsh-plugin-socket [-User YOUR_NAME] [-Private]
param(
  [string]$Repo = "dsh-plugin-socket",
  [string]$User = "",
  [switch]$Private
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "未找到 git，请先安装 Git for Windows"
}

if (-not (Test-Path ".git")) { git init | Out-Null }
git add -A
git -c user.name="$User" -c user.email="$User@users.noreply.github.com" commit -m "feat: dsh-plugin-socket v0.1.0" 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "（无新改动可提交，继续）" }

$hasGh = Get-Command gh -ErrorAction SilentlyContinue
if ($hasGh) {
  if (-not (gh auth status 2>$null)) { gh auth login }
  $vis = if ($Private) { "--private" } else { "--public" }
  gh repo create $Repo $vis --source=. --remote=origin --push
} else {
  Write-Host ""
  Write-Host "没有 gh CLI。请先在 https://github.com/new 建一个空仓库 $Repo，然后执行："
  if (-not $User) { $User = "<你的用户名>" }
  Write-Host "  git remote add origin https://github.com/$User/$Repo.git"
  Write-Host "  git branch -M main"
  Write-Host "  git push -u origin main"
}
