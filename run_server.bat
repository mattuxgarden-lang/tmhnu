@echo off
title QuizGuider - Educational Platform Server
color 0b
echo ==============================================================
echo     QuizGuider - Interactive Learning & Assessment Ecosystem
echo     Created by Thaswin Kaarthi.A
echo     Dedicated to T.M.H.N.U. Vidhyalaya Mat. Hr. Sec. School
echo ==============================================================
echo.
echo Starting QuizGuider Platform Server on Port 3000...
echo.

start "" "http://localhost:3000"

python server.py
if errorlevel 1 (
    echo Python not found, trying node server.js...
    node server.js
)

pause
