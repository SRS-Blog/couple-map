@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 我们的足迹 · 情侣地图

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js，请先装一个：https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "data\geo\china.json" (
  echo.
  echo   第一次运行，先把地图数据下载下来，大概一两分钟...
  echo.
  node tools\fetch-geo.mjs
)

start "" http://localhost:5200
node server.mjs
pause
