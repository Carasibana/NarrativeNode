@echo off
title NarrativeNode (dev)
rem Dev-mode launcher — Vite hot reload + FastAPI auto-restart. Use
rem run.bat (no --dev) for the production-served build.
rem
rem cd into this script's own directory so `python run.py` resolves
rem correctly when launched via Windows file association — Windows
rem invokes the handler with CWD set to the directory of the file
rem being opened, NOT the batch file's location. %~dp0 expands to the
rem drive+path of this script; /d lets cd cross drive letters.
cd /d "%~dp0"
python run.py --dev %*
rem Only pause on a non-zero exit so the user can read the error. A
rem clean exit (0) includes the single-instance handoff case — an
rem existing NarrativeNode was running, we posted the pending file and
rem exited. In that case, auto-closing this console keeps handoff
rem launches from stacking up "press any key" windows when the user
rem double-clicks several files in a row. `errorlevel N` matches
rem N-or-greater, so `if errorlevel 1` triggers pause on any failure.
if errorlevel 1 pause
