import 'dotenv/config';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';

class EbayTest extends EbayClient {
  async suggestCategory(query: string) {
    const result = await (this as any).callTradingAPI('GetSuggestedCategories', `
      <Query>${query}</Query>
    `);
    const catRegex = /<SuggestedCategory>([\s\S]*?)<\/SuggestedCategory>/g;
    let match;
    let count = 0;
    while ((match = catRegex.exec(result)) !== null && count < 5) {
      const xml = match[1];
      const catId = xml.match(/<CategoryID>(.*?)<\/CategoryID>/)?.[1];
      const catName = xml.match(/<CategoryName>(.*?)<\/CategoryName>/)?.[1];
      const percent = xml.match(/<PercentItemFound>(.*?)<\/PercentItemFound>/)?.[1];
      console.log(`${catId}\t${percent}%\t${catName}`);
      count++;
    }
  }
}

const c = new EbayTest();
c.suggestCategory('crayon art supplies').catch(e => console.error('FAIL:', e.message));
