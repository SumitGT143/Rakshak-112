@echo off
setlocal enabledelayedexpansion

title Rakshak 112 — Live Operations & Dispatch Center
color 0B

echo.
echo ===============================================================================
echo                RAKSHAK 112 EMERGENCY OPERATIONS SYSTEM
echo ===============================================================================
echo.
echo Freeing port 8000 from any inactive processes...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":8000 .*LISTENING"') do (
  taskkill /PID %%P /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

set "DIR=%~dp0frontend\"
if not exist "%DIR%serve_and_open.py" (
    set "DIR=%~dp0"
)
cd /d "%DIR%"

set "SERVER=serve_and_open.py"

if not exist "%SERVER%" (
    echo [ERROR] %SERVER% not found in "%DIR%"
    pause
    exit /b 1
)

echo.
echo Starting Rakshak 112 Live Backend Server...
echo.
echo ===============================================================================
echo   [1] Citizen / Bystander SOS App : http://localhost:8000/index.html
echo   [2] Command Center Control Room : http://localhost:8000/control-room-redesign.html
echo ===============================================================================
echo.

REM Try python, then py, then python3
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    python "%SERVER%"
    goto CHECK_ERR
)

where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    py "%SERVER%"
    goto CHECK_ERR
)

where python3 >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    python3 "%SERVER%"
    goto CHECK_ERR
)

echo [ERROR] Python not found in PATH. Please install Python 3.
pause
exit /b 1

:CHECK_ERR
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Server terminated with error code %ERRORLEVEL%.
    pause
)
