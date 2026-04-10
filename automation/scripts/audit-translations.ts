/**
 * DB 기존 상품 번역 품질 감사
 * - titleKo(원문) vs title(번역) 비교
 * - IP/브랜드 오역 감지
 * - productType 누락/부정확 감지
 */
import { db } from '../src/db/index.js';
import { products } from '../src/db/schema.js';

// 한글 IP/브랜드 → 올바른 영문 매핑
const IP_MAP: Record<string, string[]> = {
  '원피스': ['One Piece'],
  '포켓몬': ['Pokemon', 'Pokémon'],
  '유희왕': ['Yu-Gi-Oh', 'Yugioh'],
  '디지몬': ['Digimon'],
  '건담': ['Gundam'],
  '드래곤볼': ['Dragon Ball'],
  '나루토': ['Naruto'],
  '귀멸': ['Demon Slayer', 'Kimetsu'],
  '주술회전': ['Jujutsu Kaisen'],
  '방탄': ['BTS'],
  'BTS': ['BTS'],
  '블랙핑크': ['BLACKPINK', 'Blackpink'],
  '에스파': ['aespa', 'Aespa'],
  '스트레이키즈': ['Stray Kids'],
  '세븐틴': ['SEVENTEEN', 'Seventeen'],
  '엔시티': ['NCT'],
  '뉴진스': ['NewJeans'],
  '아이브': ['IVE'],
  '르세라핌': ['LE SSERAFIM'],
  '카드게임': ['Card Game', 'TCG', 'Trading Card', 'Collectible Card'],
  '부스터': ['Booster'],
  '앨범': ['Album'],
};

async function main() {
  const allProducts = await db.select({
    id: products.id,
    sku: products.sku,
    title: products.title,
    titleKo: products.titleKo,
    productType: products.productType,
    brand: products.brand,
  }).from(products);

  console.log(`총 ${allProducts.length}개 상품 검사\n`);

  const issues: { id: number; sku: string; titleKo: string; title: string; problem: string }[] = [];

  for (const p of allProducts) {
    const ko = p.titleKo || '';
    const en = p.title || '';

    // 1. IP/브랜드 오역 검사
    for (const [koTerm, enTerms] of Object.entries(IP_MAP)) {
      if (ko.includes(koTerm)) {
        const hasCorrectEn = enTerms.some(t => en.toLowerCase().includes(t.toLowerCase()));
        if (!hasCorrectEn) {
          issues.push({
            id: p.id,
            sku: p.sku,
            titleKo: ko,
            title: en,
            problem: `IP 오역: "${koTerm}" → 영문에 ${enTerms.join('/')} 없음`,
          });
        }
      }
    }

    // 2. productType 누락
    if (!p.productType) {
      issues.push({
        id: p.id,
        sku: p.sku,
        titleKo: ko,
        title: en,
        problem: `productType 누락`,
      });
    }

    // 3. productType 부정확 (카드게임인데 Trading Card가 아닌 경우 등)
    if (p.productType) {
      const pt = p.productType.toLowerCase();
      if (/카드게임|카드 게임|tcg|부스터박스|부스터팩/.test(ko) && !/(card|tcg|collectible)/i.test(pt)) {
        issues.push({
          id: p.id,
          sku: p.sku,
          titleKo: ko,
          title: en,
          problem: `productType 불일치: 카드게임 상품인데 "${p.productType}"`,
        });
      }
      if (/앨범|k-?pop|케이팝/.test(ko.toLowerCase()) && !/(music|album|recording)/i.test(pt)) {
        issues.push({
          id: p.id,
          sku: p.sku,
          titleKo: ko,
          title: en,
          problem: `productType 불일치: 음악 상품인데 "${p.productType}"`,
        });
      }
    }

    // 4. 번역 안 된 경우 (영문 title이 한글 그대로)
    if (/[가-힣]/.test(en) && en === ko) {
      issues.push({
        id: p.id,
        sku: p.sku,
        titleKo: ko,
        title: en,
        problem: `번역 안 됨 (한글 그대로)`,
      });
    }

    // 5. IP명이 영문 제목에서 오역된 경우 (예: "One Piece" IP가 "One-Piece" 의류로 해석)
    //    원피스 IP 상품인데 title에 "One Piece"가 없는 경우
    if (/원피스/.test(ko) && !/one.?piece/i.test(en) && !/원피스/.test(en)) {
      issues.push({
        id: p.id,
        sku: p.sku,
        titleKo: ko,
        title: en,
        problem: `IP 오역 가능: "원피스" → 영문에 "One Piece" 없음`,
      });
    }
  }

  if (issues.length === 0) {
    console.log('문제 없음! 모든 번역이 정상입니다.');
  } else {
    console.log(`⚠ ${issues.length}건 문제 발견:\n`);
    for (const issue of issues) {
      console.log(`[${issue.sku}] ${issue.problem}`);
      console.log(`  KO: ${issue.titleKo}`);
      console.log(`  EN: ${issue.title}`);
      console.log('');
    }
  }
}

// ============================================================
// Shopify 기존 상품 카테고리 현황 조회
// ============================================================
async function checkShopifyCategories() {
  console.log('\n========================================');
  console.log('=== Shopify 기존 상품 카테고리 현황 ===');
  console.log('========================================\n');

  let ShopifyClient: any;
  try {
    const mod = await import('../src/platforms/shopify/ShopifyClient.js');
    ShopifyClient = mod.ShopifyClient;
  } catch {
    console.log('ShopifyClient 로드 실패 — 건너뜀');
    return;
  }

  let shopify: any;
  try {
    shopify = new ShopifyClient();
  } catch (e: any) {
    console.log(`Shopify 초기화 실패: ${e.message}`);
    return;
  }

  try {
    const products = await shopify.getAllProducts();
    console.log(`Shopify 상품 ${products.length}개 조회\n`);

    const categoryMap = new Map<string, string[]>();
    let noCategory = 0;

    for (const p of products) {
      const cat = p.product_type || '(카테고리 없음)';
      if (!p.product_type) noCategory++;
      if (!categoryMap.has(cat)) categoryMap.set(cat, []);
      categoryMap.get(cat)!.push(p.title);
    }

    // 카테고리별 상품 수 정렬
    const sorted = [...categoryMap.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [cat, titles] of sorted) {
      console.log(`[${cat}] ${titles.length}개`);
      for (const t of titles.slice(0, 3)) {
        console.log(`  - ${t}`);
      }
      if (titles.length > 3) console.log(`  ... 외 ${titles.length - 3}개`);
      console.log('');
    }

    if (noCategory > 0) {
      console.log(`⚠ 카테고리 미설정 상품: ${noCategory}개`);
    }

    // IP 상품 카테고리 교차검사 — 잘못된 카테고리에 들어간 상품 찾기
    console.log('\n========================================');
    console.log('=== IP 상품 카테고리 오매핑 검사 ===');
    console.log('========================================\n');

    const ipChecks = [
      { pattern: /one.?piece/i, ip: 'One Piece', badCats: /one-piece|clothing|apparel/i, goodCat: 'character card / Collectible Card Game / Toy' },
      { pattern: /pokemon|pokémon/i, ip: 'Pokemon', badCats: /^$/,  goodCat: 'character card / Toy / figure' },
      { pattern: /yu-?gi-?oh|yugioh/i, ip: 'Yu-Gi-Oh', badCats: /^$/, goodCat: 'character card / Collectible Card Game' },
      { pattern: /dragon.?ball/i, ip: 'Dragon Ball', badCats: /ball|sport/i, goodCat: 'character card / Toy / figure' },
      { pattern: /gundam/i, ip: 'Gundam', badCats: /^$/, goodCat: 'Toy / figure' },
      { pattern: /\b(bts|blackpink|twice|stray kids|aespa|seventeen|nct|newjeans|ive|le sserafim)\b/i, ip: 'K-Pop', badCats: /^$/, goodCat: 'music cd / Music Recording' },
    ];

    let ipIssueCount = 0;
    for (const check of ipChecks) {
      const matched = products.filter((p: any) => check.pattern.test(p.title));
      if (matched.length === 0) continue;

      const byCat = new Map<string, number>();
      for (const p of matched) {
        const cat = p.product_type || '(없음)';
        byCat.set(cat, (byCat.get(cat) || 0) + 1);
      }

      console.log(`[${check.ip}] ${matched.length}개 상품`);
      const sortedCats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
      for (const [cat, count] of sortedCats) {
        const isBad = check.badCats.test(cat);
        const marker = isBad ? ' ← ⚠ 오매핑!' : (cat === '(없음)' ? ' ← 미설정' : '');
        if (isBad) ipIssueCount++;
        console.log(`  ${cat}: ${count}개${marker}`);
      }
      console.log(`  → 올바른 카테고리: ${check.goodCat}`);
      console.log('');
    }

    if (ipIssueCount === 0) {
      console.log('IP 카테고리 오매핑 없음');
    }
  } catch (e: any) {
    console.error(`Shopify 상품 조회 실패: ${e.message}`);
  }
}

main()
  .then(() => checkShopifyCategories())
  .then(() => process.exit(0))
  .catch(e => { console.error('에러:', e); process.exit(1); });
