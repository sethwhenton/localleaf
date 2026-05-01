@echo off
cd /d "%~dp0"
echo Starting LocalLeaf Host...
echo.
echo Open http://localhost:4317 in your browser.
echo Keep this window open while hosting.
echo.
node src\server\index.js
