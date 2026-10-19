@echo off
title Sereyromanea Building Dual-Window Launcher
echo ========================================================
echo Starting Sereyromanea Building Parking System...
echo ========================================================
cd /d "%~dp0"

if exist ".venv\Scripts\activate.bat" (
    call .venv\Scripts\activate.bat
)

echo Starting Flask server on http://127.0.0.1:5000...
echo Window 1: Login / Management Console
echo Window 2: Customer Kiosk Screen
echo ========================================================
python backend\app.py
pause
