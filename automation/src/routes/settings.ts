/**
 * 설정 라우트 — 가격 설정 페이지 + API
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pricingSettings } from '../db/schema.js';
import { env } from '../lib/config.js';
import { isSettingsAuthed, setSettingsAuthCookie, clearSettingsAuthCookie } from '../lib/settings-auth.js';
import { getAllPricingSettings } from '../services/pricing.js';
import { getUser, setUser } from '../lib/user-session.js';

export async function settingsRoutes(app: FastifyInstance) {
  // 설정 페이지
  app.get('/settings', async (request, reply) => {
    const authed = isSettingsAuthed(request);

    if (!authed) {
      return reply.viewAsync('settings.eta', { step: 7, authed: false, settings: {} });
    }

    const settings = await getAllPricingSettings();
    return reply.viewAsync('settings.eta', { step: 7, authed: true, settings });
  });

  // 패스워드 인증
  app.post('/api/settings/auth', async (request, reply) => {
    const { password } = request.body as { password?: string };

    if (!password || password !== env.SETTINGS_PASSWORD) {
      return reply.status(401).send({ error: '패스워드가 올바르지 않습니다.' });
    }

    setSettingsAuthCookie(reply);
    return { success: true };
  });

  // 닉네임 설정/변경
  app.post('/api/user/set-name', async (request, reply) => {
    const { name, asAdmin } = request.body as { name?: string; asAdmin?: boolean };
    if (!name || name.trim().length === 0) {
      return reply.status(400).send({ error: '이름을 입력해 주세요.' });
    }
    if (name.trim().length > 20) {
      return reply.status(400).send({ error: '이름은 20자 이내로 입력해 주세요.' });
    }

    // Admin 체크 안 했으면 기존 settings_auth 쿠키 제거 (팀원으로 전환)
    if (!asAdmin) {
      clearSettingsAuthCookie(reply);
    }

    const user = setUser(request, reply, name.trim());
    return { success: true, user };
  });

  // 현재 사용자 정보 조회
  app.get('/api/user/me', async (request) => {
    const user = getUser(request);
    return { user };
  });

  // 현재 설정값 조회
  app.get('/api/settings/pricing', async (request, reply) => {
    if (!isSettingsAuthed(request)) {
      return reply.status(401).send({ error: '인증 필요' });
    }

    const settings = await getAllPricingSettings();
    return settings;
  });

  // 설정값 저장 (upsert)
  app.post('/api/settings/pricing', async (request, reply) => {
    if (!isSettingsAuthed(request)) {
      return reply.status(401).send({ error: '인증 필요' });
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

    return { success: true, updated: results };
  });
}
