/**
 * 설정 라우트 — 가격 설정 페이지 + API
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pricingSettings, descriptionSettings } from '../db/schema.js';
import { getAllPricingSettings } from '../services/pricing.js';
import { getAllDescriptionSettings } from '../services/description.js';
import { getUser } from '../lib/user-session.js';
import { logAction } from '../lib/audit-log.js';

export async function settingsRoutes(app: FastifyInstance) {
  // 설정 페이지 — Admin만 접근 가능
  app.get('/settings', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.viewAsync('settings.eta', { step: 7, authed: false, settings: {} }, { layout: 'layout.eta' });
    }

    const settings = await getAllPricingSettings();
    const descSettings = await getAllDescriptionSettings();
    return reply.viewAsync('settings.eta', { step: 7, authed: true, settings, descSettings }, { layout: 'layout.eta' });
  });

  // 현재 사용자 정보 조회
  app.get('/api/user/me', async (request) => {
    const user = getUser(request);
    return { user };
  });

  // 현재 설정값 조회
  app.get('/api/settings/pricing', async (request, reply) => {
    if (!request.user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 접근할 수 있습니다.' });
    }

    const settings = await getAllPricingSettings();
    return settings;
  });

  // 설정값 저장 (upsert)
  app.post('/api/settings/pricing', async (request, reply) => {
    if (!request.user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 접근할 수 있습니다.' });
    }

    const body = request.body as Record<string, {
      marginRate: number;
      exchangeRate: number;
      platformFeeRate: number;
      defaultShippingKrw: number;
    }>;

    const results: string[] = [];

    for (const [platform, values] of Object.entries(body)) {
      if (!['ebay', 'shopify', 'alibaba', 'shopee'].includes(platform)) continue;

      // 유효성 검증
      if (values.marginRate < 0 || values.marginRate > 1) continue;
      if (values.exchangeRate <= 0) continue;
      if (values.platformFeeRate < 0 || values.platformFeeRate > 1) continue;
      if (values.defaultShippingKrw < 0) continue;

      const existing = await db.query.pricingSettings.findFirst({
        where: eq(pricingSettings.platform, platform),
      });

      if (existing) {
        await db.update(pricingSettings)
          .set({
            marginRate: String(values.marginRate),
            exchangeRate: String(values.exchangeRate),
            platformFeeRate: String(values.platformFeeRate),
            defaultShippingKrw: String(values.defaultShippingKrw),
            updatedAt: new Date(),
          })
          .where(eq(pricingSettings.platform, platform));
      } else {
        await db.insert(pricingSettings).values({
          platform,
          marginRate: String(values.marginRate),
          exchangeRate: String(values.exchangeRate),
          platformFeeRate: String(values.platformFeeRate),
          defaultShippingKrw: String(values.defaultShippingKrw),
        });
      }

      results.push(platform);
    }

    const user = request.user ?? null;
    logAction(user, 'setting.pricing', { targetType: 'setting', details: { platforms: results } });
    return { success: true, updated: results };
  });

  // 상품 설명 템플릿 조회
  app.get('/api/settings/description', async (request, reply) => {
    if (!request.user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 접근할 수 있습니다.' });
    }
    const settings = await getAllDescriptionSettings();
    return settings;
  });

  // 상품 설명 템플릿 저장 (upsert)
  app.post('/api/settings/description', async (request, reply) => {
    if (!request.user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 접근할 수 있습니다.' });
    }

    const body = request.body as Record<string, { templateHtml: string }>;
    const validPlatforms = ['common', 'ebay', 'shopify', 'alibaba', 'shopee'];
    const results: string[] = [];

    for (const [platform, values] of Object.entries(body)) {
      if (!validPlatforms.includes(platform)) continue;

      const existing = await db.query.descriptionSettings.findFirst({
        where: eq(descriptionSettings.platform, platform),
      });

      if (existing) {
        await db.update(descriptionSettings)
          .set({ templateHtml: values.templateHtml, updatedAt: new Date() })
          .where(eq(descriptionSettings.platform, platform));
      } else {
        await db.insert(descriptionSettings).values({
          platform,
          templateHtml: values.templateHtml,
        });
      }

      results.push(platform);
    }

    const user = request.user ?? null;
    logAction(user, 'setting.description', { targetType: 'setting', details: { platforms: results } });
    return { success: true, updated: results };
  });
}
