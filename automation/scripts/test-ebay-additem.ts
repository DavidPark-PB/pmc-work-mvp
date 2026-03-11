import 'dotenv/config';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';

const c = new EbayClient();
c.deleteListing('206119688965').then(() => console.log('삭제 완료')).catch(e => console.error('FAIL:', e.message));
