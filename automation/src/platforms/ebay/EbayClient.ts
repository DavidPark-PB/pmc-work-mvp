/**
 * eBay Trading API 클라이언트
 *
 * zipzip_mvp의 ebayAPI.js, sync-ebay-price-shipping.js에서 포팅.
 * AddItem(새 리스팅 생성) 추가.
 */
import axios from 'axios';
import { env } from '../../lib/config.js';
import { loadToken, saveToken } from '../../lib/token-store.js';
import { db } from '../../db/index.js';
import { categoryCache } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { PlatformAdapter, ListingInput, ListingResult } from '../index.js';

/**
 * 제목에서 카드게임 Set (확장팩) 이름 추출.
 * eBay 의 Pokemon TCG 카드 카테고리는 Set 필드 필수.
 *
 * 예시:
 *   "Pokémon TCG Sword & Shield Paradigm Trigger Box" → "Sword & Shield: Paradigm Trigger"
 *   "Pokémon TCG Scarlet & Violet Twilight Masquerade" → "Scarlet & Violet: Twilight Masquerade"
 *   "Pokémon Sun & Moon Lost Thunder Booster Box" → "Sun & Moon: Lost Thunder"
 */
function extractSetFromTitle(title: string): string | null {
  if (!title) return null;

  // 시리즈 prefix 패턴들 (Pokemon TCG 시리즈)
  const seriesPatterns = [
    { regex: /Sword\s*&\s*Shield/i, prefix: 'Sword & Shield' },
    { regex: /Scarlet\s*&\s*Violet/i, prefix: 'Scarlet & Violet' },
    { regex: /Sun\s*&\s*Moon/i, prefix: 'Sun & Moon' },
    { regex: /XY[\s:]/i, prefix: 'XY' },
    { regex: /Black\s*&\s*White/i, prefix: 'Black & White' },
    { regex: /Diamond\s*&\s*Pearl/i, prefix: 'Diamond & Pearl' },
    { regex: /HeartGold\s*&?\s*SoulSilver|HGSS/i, prefix: 'HeartGold & SoulSilver' },
  ];

  for (const { regex, prefix } of seriesPatterns) {
    const m = title.match(regex);
    if (!m) continue;
    // prefix 뒤의 expansion 이름 추출
    const after = title.slice((m.index || 0) + m[0].length);
    // 노이즈 단어 제거 (Expansion, Pack, Booster, Box 등)
    const cleaned = after
      .replace(/\b(Expansion|Enhancement|Pack|Booster|Box|Pokémon|Pokemon|TCG|Sealed|\d+\s*Boxes?|\d+\s*Packs?|Includes|Promo|Promotional|with)\b/gi, ' ')
      .replace(/\([^)]*\)/g, ' ')   // 괄호 내용 제거
      .replace(/[&\-:|]/g, ' ')      // 기호 제거
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && cleaned.length >= 3) {
      return `${prefix}: ${cleaned.split(' ').slice(0, 4).join(' ')}`;
    }
    return prefix; // 시리즈만 인식되면 그것만
  }
  return null;
}

export class EbayClient implements PlatformAdapter {
  readonly platform = 'ebay';

  private apiUrl: string;
  private authUrl: string;
  private appId: string;
  private certId: string;
  private devId: string;
  private userToken: string;
  private refreshToken: string;
  private tokenExpiresAt = 0; // Unix ms
  private initialized = false;
  private siteId = '0';     // US
  private version = '1355';
  private paymentProfileId: string;
  private returnProfileId: string;
  private shippingProfileId: string;
  private defaultCategoryId: string;

  constructor() {
    this.appId = env.EBAY_APP_ID || '';
    this.certId = env.EBAY_CERT_ID || '';
    this.devId = env.EBAY_DEV_ID || '';
    this.userToken = env.EBAY_USER_TOKEN || '';
    this.refreshToken = env.EBAY_REFRESH_TOKEN || '';
    this.paymentProfileId = env.EBAY_PAYMENT_PROFILE_ID || '266278202014';
    this.returnProfileId = env.EBAY_RETURN_PROFILE_ID || '266278678014';
    this.shippingProfileId = env.EBAY_SHIPPING_PROFILE_ID || '282951685014';
    this.defaultCategoryId = env.EBAY_DEFAULT_CATEGORY_ID || '75576';
    const isProduction = (env.EBAY_ENVIRONMENT || 'PRODUCTION') === 'PRODUCTION';
    this.apiUrl = isProduction
      ? 'https://api.ebay.com/ws/api.dll'
      : 'https://api.sandbox.ebay.com/ws/api.dll';
    this.authUrl = isProduction
      ? 'https://api.ebay.com/identity/v1/oauth2/token'
      : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
  }

  // ─── OAuth 토큰 자동 갱신 ────────────────────────────────

  private isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) return false; // 최초 토큰은 만료 시점 모름 → API 에러로 감지
    return Date.now() >= this.tokenExpiresAt - 5 * 60 * 1000; // 만료 5분 전부터 갱신
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error('eBay: EBAY_REFRESH_TOKEN 미설정 — 토큰 갱신 불가');
    }

    const auth = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');
    const response = await axios.post(
      this.authUrl,
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}`,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      },
    );

    this.userToken = response.data.access_token;
    this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
    console.log(`eBay: 토큰 갱신 완료 (만료: ${new Date(this.tokenExpiresAt).toLocaleTimeString()})`);

    // DB에 갱신된 토큰 저장
    await saveToken('ebay', {
      accessToken: this.userToken,
      refreshToken: this.refreshToken,
      expiresAt: new Date(this.tokenExpiresAt),
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const saved = await loadToken('ebay');
    if (saved) {
      this.userToken = saved.accessToken;
      if (saved.refreshToken) this.refreshToken = saved.refreshToken;
      this.tokenExpiresAt = saved.expiresAt?.getTime() || 0;
      console.log('eBay: DB에서 토큰 로드 완료');
    }
  }

  private async ensureValidToken(): Promise<void> {
    await this.ensureInitialized();
    if (this.isTokenExpired()) {
      await this.refreshAccessToken();
    }
  }

  // ─── 핵심: Trading API 호출 ───────────────────────────────

  private async callTradingAPI(callName: string, requestBody = ''): Promise<string> {
    await this.ensureValidToken();
    const result = await this._callTradingAPIOnce(callName, requestBody);

    // 토큰 만료 에러 감지 → 갱신 후 1회 재시도
    if (result.includes('IAF token supplied is expired') || result.includes('Invalid IAF token') || result.includes('Validation of the auth')) {
      console.log('eBay: 토큰 만료 감지, 갱신 후 재시도...');
      await this.refreshAccessToken();
      return this._callTradingAPIOnce(callName, requestBody);
    }

    return result;
  }

  private async _callTradingAPIOnce(callName: string, requestBody = ''): Promise<string> {
    const headers: Record<string, string> = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': this.version,
      'X-EBAY-API-DEV-NAME': this.devId,
      'X-EBAY-API-APP-NAME': this.appId,
      'X-EBAY-API-CERT-NAME': this.certId,
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': this.siteId,
      'Content-Type': 'text/xml',
    };

    // OAuth 토큰 감지 (v^1.1로 시작하는 긴 토큰)
    const isOAuth = this.userToken.length > 200;

    let xml: string;
    if (isOAuth) {
      headers['X-EBAY-API-IAF-TOKEN'] = this.userToken;
      xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  ${requestBody}
</${callName}Request>`;
    } else {
      xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${this.userToken}</eBayAuthToken>
  </RequesterCredentials>
  ${requestBody}
</${callName}Request>`;
    }

    const response = await axios.post(this.apiUrl, xml, { headers, timeout: 30000 });
    return response.data as string;
  }

  private extractXmlValue(xml: string, tag: string): string {
    const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    return match ? match[1] : '';
  }

  // ─── PlatformAdapter 구현 ─────────────────────────────────

  async testConnection(): Promise<boolean> {
    try {
      if (!this.userToken) {
        console.log('eBay: User Token 미설정');
        return false;
      }
      const response = await this.callTradingAPI('GetUser');
      const userId = this.extractXmlValue(response, 'UserID');
      console.log(`eBay 연결 성공: ${userId}`);
      return true;
    } catch (e) {
      console.error('eBay 연결 실패:', (e as Error).message);
      return false;
    }
  }

  async createListing(input: ListingInput): Promise<ListingResult> {
    const pictureXml = input.imageUrls
      .map(url => `<PictureURL>${this.escapeXml(url)}</PictureURL>`)
      .join('\n      ');

    // 동적 카테고리 매핑: productType 또는 title 기반
    const categoryKeyword = input.productType || input.title;
    const categoryId = await this.suggestCategoryId(categoryKeyword);

    // 카드 카테고리 자동 감지
    const CARD_CATEGORIES = ['183454', '183456', '261328', '183050'];
    const isCardCategory = CARD_CATEGORIES.includes(categoryId);

    // Sealed 상품 (박스/팩/덱/틴/번들) 감지 — 제목 키워드 기반.
    // 개별 카드 (낱장) vs Sealed (박스 등) 는 condition 이 다름:
    //   - 개별 카드: 4000 (Ungraded) + ConditionDescriptors
    //   - Sealed: 1000 (New) — Ungraded 코드 거부됨
    const isSealedProduct = isCardCategory && /\b(box|case|pack|deck|tin|bundle|collection|booster|elite trainer|premium|portfolio)\b/i.test(input.title);
    const isIndividualCard = isCardCategory && !isSealedProduct;

    // Condition: 중고 3000 / 개별카드 4000 (Ungraded) / 그 외(Sealed 포함) 1000 (New)
    const conditionId = input.condition === 'used' ? '3000'
      : isIndividualCard ? '4000'
      : '1000';

    // ItemSpecifics: 카테고리 기반 템플릿 로드 (DB)
    let specs: Record<string, string> = {};
    if (input.itemSpecifics && Object.keys(input.itemSpecifics).length > 0) {
      specs = { ...input.itemSpecifics };
    } else {
      // DB에서 카테고리 매칭 템플릿 로드
      try {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const tmplResult = await pool.query(
          'SELECT specifics FROM item_specifics_templates WHERE category_id = $1 LIMIT 1',
          [categoryId]
        );
        if (tmplResult.rows[0]) {
          specs = typeof tmplResult.rows[0].specifics === 'string'
            ? JSON.parse(tmplResult.rows[0].specifics)
            : tmplResult.rows[0].specifics;
          console.log(`[eBay] 카테고리 ${categoryId} 템플릿 적용: ${Object.keys(specs).length}개 속성`);
        }
        await pool.end();
      } catch (e) { /* template not found — use fallback */ }
      if (Object.keys(specs).length === 0) {
        specs = { Brand: input.brand || 'Unbranded', Type: input.productType || 'See Description' };
      }
    }
    // Card Condition은 ConditionDescriptors로 처리 — ItemSpecifics에서 제거
    delete specs['Card Condition'];

    // ── 필수 항목 자동 채움 (eBay 카테고리별 required fields) ──
    // 카드 카테고리 (Pokémon/YGO/MTG/Sports 등): Set + Game 필수
    if (isCardCategory) {
      // Game 자동 감지 (제목 키워드 기반)
      if (!specs['Game']) {
        const t = input.title.toLowerCase();
        if (/pokémon|pokemon/i.test(input.title)) specs['Game'] = 'Pokémon TCG';
        else if (/yu-?gi-?oh/i.test(input.title)) specs['Game'] = 'Yu-Gi-Oh! TCG';
        else if (/magic.*gathering|\bmtg\b/i.test(input.title)) specs['Game'] = 'Magic: The Gathering';
        else if (/digimon/i.test(input.title)) specs['Game'] = 'Digimon TCG';
        else if (/one piece/i.test(input.title)) specs['Game'] = 'One Piece TCG';
        else if (/dragon ball/i.test(input.title)) specs['Game'] = 'Dragon Ball Super TCG';
        else specs['Game'] = 'Other';
      }
      // Set 자동 감지 (제목에서 시리즈/expansion 이름 추출)
      if (!specs['Set']) {
        specs['Set'] = extractSetFromTitle(input.title) || 'Various';
      }
      // Brand: 대부분 Game 과 같은 발행사
      if (!specs['Brand']) {
        if (/pokémon|pokemon/i.test(input.title)) specs['Brand'] = 'Pokémon';
        else if (/yu-?gi-?oh/i.test(input.title)) specs['Brand'] = 'Konami';
        else if (/magic.*gathering|\bmtg\b/i.test(input.title)) specs['Brand'] = 'Wizards of the Coast';
        else specs['Brand'] = input.brand || 'Unbranded';
      }
      // Manufacturer: 일부 카드 카테고리 (sealed) 가 Brand 와 별개로 요구. 같은 값으로.
      if (!specs['Manufacturer']) {
        specs['Manufacturer'] = specs['Brand'];
      }
      // Type 도 sealed/booster 자동 감지
      if (!specs['Type']) {
        if (/booster box/i.test(input.title)) specs['Type'] = 'Booster Box';
        else if (/booster pack/i.test(input.title)) specs['Type'] = 'Booster Pack';
        else if (/elite trainer/i.test(input.title)) specs['Type'] = 'Elite Trainer Box';
        else if (/starter/i.test(input.title)) specs['Type'] = 'Starter Deck';
        else specs['Type'] = 'See Description';
      }
    }
    // 비디오게임 카테고리 — Platform 필수
    if (!specs['Platform'] && /(playstation|xbox|nintendo|switch|ps[1-5]|video game)/i.test(input.title)) {
      const t = input.title.toLowerCase();
      if (/ps5|playstation 5/i.test(input.title)) specs['Platform'] = 'Sony PlayStation 5';
      else if (/ps4|playstation 4/i.test(input.title)) specs['Platform'] = 'Sony PlayStation 4';
      else if (/nintendo switch/i.test(input.title)) specs['Platform'] = 'Nintendo Switch';
      else if (/xbox series/i.test(input.title)) specs['Platform'] = 'Microsoft Xbox Series X';
      else if (/xbox one/i.test(input.title)) specs['Platform'] = 'Microsoft Xbox One';
      else specs['Platform'] = 'See Description';
    }
    const itemSpecificsXml = `
    <ItemSpecifics>${Object.entries(specs).map(([k, v]) =>
      `\n      <NameValueList><Name>${this.escapeXml(k)}</Name><Value>${this.escapeXml(String(v))}</Value></NameValueList>`
    ).join('')}
    </ItemSpecifics>`;

    const requestBody = `
  <Item>
    <Title>${this.escapeXml(input.title.substring(0, 80))}</Title>
    <Description><![CDATA[${input.description}]]></Description>
    <PrimaryCategory>
      <CategoryID>${categoryId}</CategoryID>
    </PrimaryCategory>
    <StartPrice currencyID="USD">${input.price.toFixed(2)}</StartPrice>
    <ConditionID>${conditionId}</ConditionID>${isIndividualCard ? `
    <ConditionDescriptors>
      <ConditionDescriptor>
        <Name>40001</Name>
        <Value>400010</Value>
      </ConditionDescriptor>
    </ConditionDescriptors>` : ''}
    <Country>KR</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>5</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>South Korea</Location>
    <Quantity>${input.quantity}</Quantity>
    <SKU>${this.escapeXml(input.sku)}</SKU>
    <PictureDetails>
      ${pictureXml}
    </PictureDetails>${itemSpecificsXml}
    <SellerProfiles>
      <SellerShippingProfile>
        <ShippingProfileID>${this.shippingProfileId}</ShippingProfileID>
      </SellerShippingProfile>
      <SellerReturnProfile>
        <ReturnProfileID>${this.returnProfileId}</ReturnProfileID>
      </SellerReturnProfile>
      <SellerPaymentProfile>
        <PaymentProfileID>${this.paymentProfileId}</PaymentProfileID>
      </SellerPaymentProfile>
    </SellerProfiles>
    <Site>US</Site>
  </Item>`;

    const response = await this.callTradingAPI('AddItem', requestBody);
    const ack = this.extractXmlValue(response, 'Ack');

    // Extract ALL errors/warnings from response
    const allErrors: string[] = [];
    const errorMatches = response.matchAll(/<LongMessage>([\s\S]*?)<\/LongMessage>/g);
    for (const m of errorMatches) allErrors.push(m[1]);

    if (ack !== 'Success' && ack !== 'Warning') {
      // Filter out "renamed" warnings — check if there are real errors
      const realErrors = allErrors.filter(msg => !msg.includes('renamed as per eBay recommendations'));
      if (realErrors.length > 0) {
        console.error(`[eBay] AddItem failed (Ack=${ack}):`, realErrors.join(' | '));
        throw new Error(`eBay AddItem 실패: ${realErrors[0]}`);
      }
      // Only "renamed" warnings — log and continue
      console.log(`[eBay] Item specifics renamed (non-fatal warning), Ack=${ack}`);
    }

    const itemId = this.extractXmlValue(response, 'ItemID');
    if (!itemId) {
      console.error(`[eBay] AddItem: no ItemID returned. Ack=${ack}. Errors:`, allErrors.join(' | '));
      console.error(`[eBay] Response snippet:`, response.slice(0, 500));
      throw new Error(`eBay AddItem 실패: ItemID 없음 (${allErrors[0] || 'unknown'})`);
    }
    return {
      itemId,
      url: `https://www.ebay.com/itm/${itemId}`,
    };
  }

  async updateListing(itemId: string, updates: Partial<ListingInput>): Promise<void> {
    let itemFields = `<ItemID>${itemId}</ItemID>`;

    if (updates.title) {
      itemFields += `\n      <Title>${this.escapeXml(updates.title.substring(0, 80))}</Title>`;
    }
    if (updates.price !== undefined) {
      itemFields += `\n      <StartPrice currencyID="USD">${updates.price.toFixed(2)}</StartPrice>`;
    }
    if (updates.quantity !== undefined) {
      itemFields += `\n      <Quantity>${updates.quantity}</Quantity>`;
    }
    if (updates.description) {
      itemFields += `\n      <Description><![CDATA[${updates.description}]]></Description>`;
    }
    if (updates.shippingCost !== undefined) {
      itemFields += `
      <ShippingDetails>
        <ShippingType>Flat</ShippingType>
        <ShippingServiceOptions>
          <ShippingServicePriority>1</ShippingServicePriority>
          <ShippingService>USPSPriority</ShippingService>
          <ShippingServiceCost currencyID="USD">${updates.shippingCost.toFixed(2)}</ShippingServiceCost>
          <ShippingServiceAdditionalCost currencyID="USD">0.00</ShippingServiceAdditionalCost>
        </ShippingServiceOptions>
      </ShippingDetails>`;
    }

    const requestBody = `<Item>${itemFields}</Item>`;
    const response = await this.callTradingAPI('ReviseItem', requestBody);
    const ack = this.extractXmlValue(response, 'Ack');

    if (ack !== 'Success' && ack !== 'Warning') {
      const errorMsg = this.extractXmlValue(response, 'LongMessage') || 'Unknown error';
      throw new Error(`eBay ReviseItem 실패: ${errorMsg}`);
    }
  }

  async deleteListing(itemId: string): Promise<void> {
    const requestBody = `
  <ItemID>${itemId}</ItemID>
  <EndingReason>NotAvailable</EndingReason>`;

    const response = await this.callTradingAPI('EndItem', requestBody);
    const ack = this.extractXmlValue(response, 'Ack');

    if (ack !== 'Success' && ack !== 'Warning') {
      const errorMsg = this.extractXmlValue(response, 'LongMessage') || 'Unknown error';
      throw new Error(`eBay EndItem 실패: ${errorMsg}`);
    }
  }

  async updateInventory(itemId: string, price: number, quantity: number): Promise<void> {
    const requestBody = `
  <InventoryStatus>
    <ItemID>${itemId}</ItemID>
    <StartPrice>${price.toFixed(2)}</StartPrice>
    <Quantity>${quantity}</Quantity>
  </InventoryStatus>`;

    const response = await this.callTradingAPI('ReviseInventoryStatus', requestBody);
    const ack = this.extractXmlValue(response, 'Ack');

    if (ack !== 'Success' && ack !== 'Warning') {
      const errorMsg = this.extractXmlValue(response, 'LongMessage') || 'Unknown error';
      throw new Error(`eBay ReviseInventoryStatus 실패: ${errorMsg}`);
    }
  }

  // ─── 추가 메서드 ──────────────────────────────────────────

  /** 활성 리스팅 조회 (전체 페이지) */
  async getActiveListings(): Promise<{ itemId: string; sku: string; title: string; price: string; quantity: string }[]> {
    const allItems: { itemId: string; sku: string; title: string; price: string; quantity: string }[] = [];
    let pageNumber = 1;
    let hasMore = true;

    while (hasMore) {
      const requestBody = `
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>`;

      const response = await this.callTradingAPI('GetMyeBaySelling', requestBody);

      // 아이템 파싱
      const itemRegex = /<Item>([\s\S]*?)<\/Item>/g;
      let match;
      while ((match = itemRegex.exec(response)) !== null) {
        const itemXml = match[1];
        allItems.push({
          itemId: this.extractXmlValue(itemXml, 'ItemID'),
          sku: this.extractXmlValue(itemXml, 'SKU'),
          title: this.extractXmlValue(itemXml, 'Title'),
          price: this.extractXmlValue(itemXml, 'CurrentPrice'),
          quantity: this.extractXmlValue(itemXml, 'Quantity'),
        });
      }

      const totalPages = parseInt(this.extractXmlValue(response, 'TotalNumberOfPages') || '1');
      hasMore = pageNumber < totalPages;
      pageNumber++;

      if (hasMore) await new Promise(r => setTimeout(r, 500));
    }

    return allItems;
  }

  // ─── REST API 호출 (Taxonomy API 등) ─────────────────────

  private async callRestApi(url: string): Promise<any> {
    await this.ensureValidToken();
    try {
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${this.userToken}` },
        timeout: 15000,
      });
      return response.data;
    } catch (e: any) {
      // 토큰 만료 시 1회 갱신 후 재시도
      if (e.response?.status === 401) {
        await this.refreshAccessToken();
        const response = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${this.userToken}` },
          timeout: 15000,
        });
        return response.data;
      }
      throw e;
    }
  }

  /** eBay Taxonomy API로 키워드 기반 카테고리 추천 (캐시 포함) */
  async suggestCategoryId(keyword: string): Promise<string> {
    if (!keyword) return this.defaultCategoryId;

    // 1. DB 캐시 확인 (30일 TTL)
    try {
      const cached = await db.query.categoryCache.findFirst({
        where: and(
          eq(categoryCache.platform, 'ebay'),
          eq(categoryCache.keyword, keyword.substring(0, 500)),
        ),
      });

      if (cached) {
        const age = Date.now() - cached.cachedAt.getTime();
        if (age < 30 * 24 * 60 * 60 * 1000) {
          return cached.categoryId;
        }
      }
    } catch {
      // 캐시 조회 실패는 무시
    }

    // 2. eBay Taxonomy API 호출
    try {
      const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(keyword)}`;
      const data = await this.callRestApi(url);
      const suggestions = data?.categorySuggestions;

      if (suggestions?.length > 0) {
        const best = suggestions[0].category;
        const categoryId = best.categoryId;
        const categoryName = best.categoryName || '';

        // 캐시 저장 (upsert)
        try {
          await db.insert(categoryCache).values({
            platform: 'ebay',
            keyword: keyword.substring(0, 500),
            categoryId,
            categoryName,
          }).onConflictDoUpdate({
            target: [categoryCache.platform, categoryCache.keyword],
            set: { categoryId, categoryName, cachedAt: new Date() },
          });
        } catch {
          // 캐시 저장 실패는 무시
        }

        console.log(`eBay 카테고리 매핑: "${keyword}" → ${categoryId} (${categoryName})`);
        return categoryId;
      }
    } catch (e) {
      console.warn(`eBay getCategorySuggestions 실패: ${(e as Error).message} — 기본 카테고리 사용`);
    }

    return this.defaultCategoryId;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
