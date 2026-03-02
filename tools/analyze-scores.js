const data = require('../data/sku-scores.json');
const scores = Object.values(data.scores);

// 등급별 분석
console.log('=== 등급별 분석 ===');
['A','B','C','D'].forEach(cls => {
  const group = scores.filter(s => s.classification === cls);
  const withMargin = group.filter(s => s.rawData && s.rawData.netMarginPct > 0);
  const withSales = group.filter(s => s.rawData && s.rawData.sales30d > 0);
  console.log(`${cls}: ${group.length} (마진있음:${withMargin.length} / 판매있음:${withSales.length})`);
});

// A등급 상세
console.log('\n=== A등급 ===');
scores.filter(s => s.classification === 'A').forEach(s => {
  console.log(`${s.sku} | ${(s.title || '').substring(0,50)}`);
  console.log(`  margin:${s.rawData.netMarginPct}% sales:${s.rawData.sales30d} score:${s.normalizedScore}`);
});

// 데이터 소스별 분류
const noData = scores.filter(s => {
  const m = s.rawData ? s.rawData.netMarginPct : 0;
  const sl = s.rawData ? s.rawData.sales30d : 0;
  return !m && !sl;
});
const marginOnly = scores.filter(s => {
  const m = s.rawData ? s.rawData.netMarginPct : 0;
  const sl = s.rawData ? s.rawData.sales30d : 0;
  return m > 0 && !sl;
});
const salesOnly = scores.filter(s => {
  const m = s.rawData ? s.rawData.netMarginPct : 0;
  const sl = s.rawData ? s.rawData.sales30d : 0;
  return !m && sl > 0;
});
const hasBoth = scores.filter(s => {
  const m = s.rawData ? s.rawData.netMarginPct : 0;
  const sl = s.rawData ? s.rawData.sales30d : 0;
  return m > 0 && sl > 0;
});

console.log('\n=== 데이터 소스별 ===');
console.log(`마진+판매 둘다: ${hasBoth.length}`);
console.log(`마진만: ${marginOnly.length}`);
console.log(`판매만: ${salesOnly.length}`);
console.log(`데이터 없음: ${noData.length}`);

// eBay ItemID(12자리) vs 일반 SKU
const longNum = scores.filter(s => /^\d{10,}$/.test(s.sku));
const shortSku = scores.filter(s => !/^\d{10,}$/.test(s.sku));
console.log(`\neBay ItemID형(10+자리 숫자): ${longNum.length}`);
console.log(`일반 SKU: ${shortSku.length}`);

// eBay ItemID형 중 데이터없는 것
const longNumNoData = longNum.filter(s => {
  const m = s.rawData ? s.rawData.netMarginPct : 0;
  const sl = s.rawData ? s.rawData.sales30d : 0;
  return !m && !sl;
});
console.log(`eBay ItemID형 중 데이터없음: ${longNumNoData.length} ← 이것들이 쓰레기`);

// C등급 샘플 (50-64)
console.log('\n=== C등급 샘플 (상위 5개) ===');
scores.filter(s => s.classification === 'C')
  .sort((a, b) => b.normalizedScore - a.normalizedScore)
  .slice(0, 5)
  .forEach(s => {
    console.log(`${s.sku} | ${(s.title || '').substring(0,40)} | score:${s.normalizedScore} margin:${s.rawData.netMarginPct}% sales:${s.rawData.sales30d}`);
  });
