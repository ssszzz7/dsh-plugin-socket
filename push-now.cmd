@echo off
chcp 65001 >nul
title push dsh-plugin-socket
cd /d "%~dp0"
echo 正在推送到 https://github.com/ssszzz7/dsh-plugin-socket
echo 如果弹出 Git Credential Manager 窗口，点 [Sign in with your browser]，然后在浏览器里点 Authorize。
echo.
git push -u origin main
echo.
echo [结束] 按任意键关闭
pause >nul
