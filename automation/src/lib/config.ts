import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Shopify (optional until Phase 2)
  SHOPIFY_STORE_URL: z.string().optional(),
  SHOPIFY_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default('2024-01'),

  // eBay (optional until Phase 2)
  EBAY_DEV_ID: z.string().optional(),
  EBAY_APP_ID: z.string().optional(),
  EBAY_CERT_ID: z.string().optional(),
  EBAY_USER_TOKEN: z.string().optional(),
  EBAY_REFRESH_TOKEN: z.string().optional(),
  EBAY_RUNAME: z.string().optional(),
  EBAY_ENVIRONMENT: z.enum(['SANDBOX', 'PRODUCTION']).default('PRODUCTION'),
  EBAY_PAYMENT_PROFILE_ID: z.string().optional(),
  EBAY_RETURN_PROFILE_ID: z.string().optional(),
  EBAY_SHIPPING_PROFILE_ID: z.string().optional(),
  EBAY_DEFAULT_CATEGORY_ID: z.string().optional(),

  // Google (for migration)
  GOOGLE_SPREADSHEET_ID: z.string().optional(),
  GOOGLE_CREDENTIALS_PATH: z.string().optional(),

  // Coupang (optional until Phase 7)
  COUPANG_ACCESS_KEY: z.string().optional(),
  COUPANG_SECRET_KEY: z.string().optional(),
  COUPANG_VENDOR_ID: z.string().optional(),

  // Naver (Shopping API)
  NAVER_CLIENT_ID: z.string().optional(),
  NAVER_CLIENT_SECRET: z.string().optional(),

  // Alibaba (ICBU Open Platform)
  ALIBABA_APP_KEY: z.string().optional(),
  ALIBABA_APP_SECRET: z.string().optional(),
  ALIBABA_ACCESS_TOKEN: z.string().optional(),
  ALIBABA_REFRESH_TOKEN: z.string().optional(),
  ALIBABA_PLATFORM: z.enum(['international', 'domestic']).default('international'),
  ALIBABA_DEFAULT_CATEGORY_ID: z.string().optional(),

  // Shopee Open Platform
  SHOPEE_PARTNER_ID: z.coerce.number().optional(),
  SHOPEE_PARTNER_KEY: z.string().optional(),
  SHOPEE_SHOP_ID: z.coerce.number().optional(),
  SHOPEE_MERCHANT_ID: z.coerce.number().optional(),
  SHOPEE_ACCESS_TOKEN: z.string().optional(),
  SHOPEE_REFRESH_TOKEN: z.string().optional(),
  SHOPEE_ENV: z.enum(['live', 'test']).default('test'),
  SHOPEE_DEFAULT_CATEGORY_ID: z.coerce.number().optional(),

  // Qoo10 (optional until Phase 7)
  QOO10_API_KEY: z.string().optional(),
  QOO10_USER_ID: z.string().optional(),
  QOO10_PASSWORD: z.string().optional(),

  // Gemini (for product translation)
  GEMINI_API_KEY: z.string().optional(),

  // GitHub (backup management via Actions)
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().default('CCOREA-AUTO/ccorea-auto'),

  // Settings page password
  SETTINGS_PASSWORD: z.string().default('tjdals!1212'),

  // Admin seed account
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default('changeme'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
