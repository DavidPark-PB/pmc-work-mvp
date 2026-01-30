require('dotenv').config();
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

/**
 * 배치 스크립트를 완료될 때까지 반복 실행
 */

async function completeDashboard() {
  console.log('=== Dashboard 자동 완성 시작 ===\n');

  let iteration = 0;
  const maxIterations = 50; // 최대 50회 (5000개 처리 가능)

  while (iteration < maxIterations) {
    iteration++;
    console.log(`\n🔄 반복 ${iteration}/${maxIterations}\n`);

    try {
      const { stdout, stderr } = await execPromise('node create-dashboard-batch.js', {
        cwd: __dirname
      });

      console.log(stdout);

      if (stderr) {
        console.error('경고:', stderr);
      }

      // COMPLETED 체크
      if (stdout.includes('모든 데이터 처리 완료') || stdout.includes('COMPLETED')) {
        console.log('\n✅ 전체 Dashboard 완성!\n');
        break;
      }

      // 짧은 대기 (API rate limit 방지)
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
      console.error('\n❌ 오류 발생:', error.message);

      // API quota 오류면 1분 대기
      if (error.message.includes('Quota exceeded') || error.message.includes('429')) {
        console.log('\n⏳ API 제한 - 70초 대기 중...\n');
        await new Promise(resolve => setTimeout(resolve, 70000));
      } else {
        throw error;
      }
    }
  }

  if (iteration >= maxIterations) {
    console.log('\n⚠️  최대 반복 횟수 도달. 수동으로 create-dashboard-batch.js를 다시 실행하세요.\n');
  }
}

completeDashboard();
