import 'dotenv/config';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';

class EbayTest extends EbayClient {
  async getPolicies() {
    const result = await (this as any).callTradingAPI('GetUserPreferences', `
      <ShowSellerProfilePreferences>true</ShowSellerProfilePreferences>
    `);
    // 모든 프로필 추출
    const profileRegex = /<SupportedSellerProfile>([\s\S]*?)<\/SupportedSellerProfile>/g;
    let match;
    while ((match = profileRegex.exec(result)) !== null) {
      const xml = match[1];
      const id = xml.match(/<ProfileID>(.*?)<\/ProfileID>/)?.[1];
      const type = xml.match(/<ProfileType>(.*?)<\/ProfileType>/)?.[1];
      const name = xml.match(/<ProfileName>(.*?)<\/ProfileName>/)?.[1];
      const isDefault = xml.match(/<IsDefault>(.*?)<\/IsDefault>/)?.[1];
      console.log(`${type}\t${id}\t${isDefault}\t${name}`);
    }
  }
}

const c = new EbayTest();
c.getPolicies().catch(e => console.error('FAIL:', e.message));
