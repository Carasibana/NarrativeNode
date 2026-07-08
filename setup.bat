@echo off
title NarrativeNode Setup
echo ================================================
echo  NarrativeNode - First-Time Setup
echo ================================================
echo.

REM Python runs setup.py itself, so a missing Python can't be reported
REM from inside it. Detect it here and give a friendly message instead
REM of a cryptic "'python' is not recognized" error.
python --version >nul 2>nul
if errorlevel 1 (
    echo Python was not found.
    echo.
    echo NarrativeNode needs Python 3.11 or newer to run.
    echo   Download: https://www.python.org/downloads/
    echo   During install, tick "Add python.exe to PATH".
    echo.
    echo After installing Python, run setup.bat again.
    echo.
    pause
    exit /b 1
)

python setup.py
echo.
pause
