@echo off
REM ====================================
REM 자동 동기화 배치 파일
REM 12시간마다 실행되도록 설정
REM ====================================

echo ====================================
echo 자동 동기화 시작
echo ====================================
echo.

REM 작업 디렉토리로 이동
cd /d "%~dp0.."

REM 현재 시각 기록
echo 실행 시각: %date% %time%
echo.

REM Node.js 스크립트 실행
node scripts/auto-sync-scheduler.js

REM 종료 코드 확인
if %errorlevel% neq 0 (
    echo.
    echo ====================================
    echo 오류 발생! 종료 코드: %errorlevel%
    echo ====================================
    exit /b %errorlevel%
)

echo.
echo ====================================
echo 자동 동기화 완료
echo ====================================
