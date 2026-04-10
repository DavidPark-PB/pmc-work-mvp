/**
 * 상품 설명 템플릿 서비스
 *
 * 플랫폼별 공통 정책 HTML(배송/결제/반품)을 DB에서 관리하고,
 * 리스팅 생성 시 상품 description + 공통 템플릿을 결합
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { descriptionSettings } from '../db/schema.js';

export interface DescriptionSetting {
  templateHtml: string;
}

/** 모든 플랫폼 description 설정 조회 */
export async function getAllDescriptionSettings(): Promise<Record<string, DescriptionSetting>> {
  const rows = await db.select().from(descriptionSettings);
  const result: Record<string, DescriptionSetting> = {};
  for (const row of rows) {
    result[row.platform] = { templateHtml: row.templateHtml };
  }
  return result;
}

/** 특정 플랫폼의 description 템플릿 조회 (플랫폼별 > common 순으로 fallback) */
export async function getDescriptionTemplate(platform: string): Promise<string> {
  // 플랫폼별 템플릿 먼저 시도
  const platformRow = await db.query.descriptionSettings.findFirst({
    where: eq(descriptionSettings.platform, platform),
  });
  if (platformRow?.templateHtml) return platformRow.templateHtml;

  // common 템플릿 fallback
  const commonRow = await db.query.descriptionSettings.findFirst({
    where: eq(descriptionSettings.platform, 'common'),
  });
  return commonRow?.templateHtml || '';
}

/**
 * 상품 description + 공통 템플릿을 결합한 최종 HTML 생성
 * {{PRODUCT_DESCRIPTION}} 플레이스홀더가 있으면 해당 위치에 삽입
 * 없으면 상품 설명 뒤에 템플릿 추가
 */
export function buildFullDescription(productDescription: string, template: string): string {
  if (!template) return productDescription;

  if (template.includes('{{PRODUCT_DESCRIPTION}}')) {
    return template.replace('{{PRODUCT_DESCRIPTION}}', productDescription);
  }

  return `${productDescription}\n${template}`;
}

/** HTML 태그를 제거하고 플레인 텍스트로 변환 (Shopee 등 HTML 미지원 플랫폼용) */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 플랫폼에 맞는 최종 description 생성 (HTML 미지원 플랫폼은 자동 변환) */
const PLAIN_TEXT_PLATFORMS = ['shopee'];

export function buildPlatformDescription(productDescription: string, template: string, platform: string): string {
  const full = buildFullDescription(productDescription, template);
  if (PLAIN_TEXT_PLATFORMS.includes(platform)) {
    return stripHtml(full);
  }
  return full;
}
