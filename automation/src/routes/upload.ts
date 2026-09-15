/**
 * CSV 파일 업로드 라우트
 *
 * 업로드 → rawFields(원본) DB 저장 → 고정 헤더/Gemini/키워드 자동 매핑 감지
 * 매핑 확정(confirm-mapping) → applyMapping → parsedRows 저장
 */
import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { parseCsvRawFields, detectMappingByKeyword, detectFixedHeaderMapping, validateColumnMapping, applyMapping, describeRowShipping, isQuoteRowUnfinished, summarizeQuoteRows, type CsvRow } from '../lib/csv-parser.js';
import { getShippingPricingConfig } from '../lib/shipping-config.js';
import { applyShippingPolicyToImportedRows, buildShippingPolicySnapshot, getShippingPolicies } from '../services/ebay-shipping-policies.js';
import {
  alternativeReadyIndices,
  applyShippingAlternatives,
  findRunningQuoteJob,
  getQuoteJob,
  mergeRowsByIndex,
  parseQuoteSelections,
  quoteUploadRows,
  startQuoteJob,
  unfinishedQuoteSelections,
  type QuoteRunProgress,
  type ShippingQuoteSelection,
} from '../services/shipping-quote-service.js';
import { detectMappingWithAI } from '../lib/csv-mapping-ai.js';
import { db } from '../db/index.js';
import { csvUploads } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getUser } from '../lib/user-session.js';
import { logAction } from '../lib/audit-log.js';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');

export async function uploadRoutes(app: FastifyInstance) {
  // POST /api/upload/csv — CSV 파일 업로드 (Admin 전용)
  app.post('/upload/csv', async (request, reply) => {
    const user = getUser(request);
    if (!user) {
      return reply.status(401).send({ error: '이름을 먼저 설정해 주세요.' });
    }
    if (!user.isAdmin) {
      return reply.status(403).send({ error: 'CSV 업로드는 관리자만 이용하실 수 있습니다.' });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: '파일이 없습니다' });
    }

    // 임시 디렉토리에 파일 저장 (파싱 후 삭제)
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    const uploadId = randomUUID();
    const savePath = path.join(UPLOAD_DIR, `${uploadId}.csv`);

    // 파일 저장 → raw 파싱 → 임시 파일 삭제
    await pipeline(data.file, fs.createWriteStream(savePath));

    let rawFields: string[][];
    try {
      rawFields = parseCsvRawFields(savePath);
    } finally {
      try { fs.unlinkSync(savePath); } catch {}
    }

    if (rawFields.length < 2) {
      return reply.status(400).send({ error: 'CSV 파일에 데이터가 없습니다' });
    }

    // 고정 헤더(toybox) → 결정적 매핑을 즉시 저장, 아니면 빠른 키워드 매핑 → 클라이언트 응답을 1~2초 내로 끝낸다.
    // 화면보호기 켜져도 업로드 단계는 이미 완료됨. AI 매핑은 고정 헤더가 아닐 때만 백그라운드.
    const headers = rawFields[0];
    const sampleRows = rawFields.slice(1, 6);
    const fixedMapping = detectFixedHeaderMapping(headers);
    const keywordMapping = fixedMapping ?? detectMappingByKeyword(rawFields);

    await db.insert(csvUploads).values({
      uploadId,
      filename: data.filename,
      rowCount: rawFields.length - 1,
      rawFields,
      columnMapping: keywordMapping,
      ownerId: user.id,
      ownerName: user.name,
    });

    logAction(user, 'import.csv', { targetType: 'csv_upload', targetId: uploadId, details: { filename: data.filename, rowCount: rawFields.length - 1 } });

    // 백그라운드 AI 매핑 — 실패해도 키워드 매핑이 이미 저장되어 있으므로 안전.
    // 클라이언트는 즉시 /mapping으로 이동하고, AI 결과가 도착하면 새로고침으로 반영됨.
    // 고정 헤더(toybox) CSV는 결정적 매핑을 AI 결과로 덮어쓰지 않도록 실행하지 않는다.
    if (!fixedMapping) void (async () => {
      try {
        const aiMapping = await detectMappingWithAI(headers, sampleRows);
        if (aiMapping && Object.keys(aiMapping).length > 0) {
          await db.update(csvUploads)
            .set({ columnMapping: aiMapping })
            .where(eq(csvUploads.uploadId, uploadId));
        }
      } catch (e) {
        request.log.warn({ err: e, uploadId }, 'AI 매핑 백그라운드 실패 (키워드 매핑은 유지됨)');
      }
    })();

    return {
      uploadId,
      filename: data.filename,
      rowCount: rawFields.length - 1,
    };
  });

  // GET /api/upload/:uploadId/status — 매핑 페이지가 AI 완료를 폴링할 때 사용
  app.get<{ Params: { uploadId: string } }>('/upload/:uploadId/status', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 이용하실 수 있습니다.' });
    }
    const upload = await db.query.csvUploads.findFirst({
      where: eq(csvUploads.uploadId, request.params.uploadId),
    });
    if (!upload) return reply.status(404).send({ error: '업로드를 찾을 수 없습니다' });
    return {
      uploadId: upload.uploadId,
      status: upload.status,
      columnMapping: upload.columnMapping || {},
    };
  });

  // POST /api/upload/confirm-mapping — 매핑 확정
  app.post('/upload/confirm-mapping', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 이용하실 수 있습니다.' });
    }

    const { uploadId, mapping } = request.body as {
      uploadId: string;
      mapping: Record<string, number>;
    };

    if (!uploadId || !mapping) {
      return reply.status(400).send({ error: 'uploadId와 mapping이 필요합니다' });
    }

    // 필수 필드 + 충돌 검증 (가격 KRW/USD, 무게/적용무게 동시 매핑 금지)
    const mappingError = validateColumnMapping(mapping);
    if (mappingError) {
      return reply.status(400).send({ error: mappingError });
    }

    const upload = await db.query.csvUploads.findFirst({
      where: eq(csvUploads.uploadId, uploadId),
    });

    if (!upload?.rawFields) {
      return reply.status(404).send({ error: '업로드 데이터를 찾을 수 없습니다' });
    }

    // 매핑 적용
    const parsedRows = applyMapping(upload.rawFields, mapping);

    const preview = parsedRows.slice(0, 5).map(r => ({
      name: r.name,
      price: r.price,
      priceCurrency: r.priceCurrency,
      chargeableWeightG: r.chargeableWeightG,
      image: r.image,
      url: r.url,
    }));

    // DB 업데이트: parsedRows 저장, rawFields 클리어
    await db.update(csvUploads)
      .set({
        parsedRows,
        columnMapping: mapping,
        rawFields: null,     // 공간 절약
        rowCount: parsedRows.length,
        status: 'mapped',
      })
      .where(eq(csvUploads.uploadId, uploadId));

    logAction(user, 'import.mapping', { targetType: 'csv_upload', targetId: uploadId, details: { mapping, rowCount: parsedRows.length } });
    return {
      uploadId,
      rowCount: parsedRows.length,
      preview,
    };
  });

  // POST /api/upload/shipping-quotes — 선택 상품 배송사 저장 + 국제배송비 견적 (서버 → main service), 완료까지 대기
  app.post('/upload/shipping-quotes', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 이용하실 수 있습니다.' });
    }
    const prepared = await prepareQuoteRun(request.body);
    if ('error' in prepared) return reply.status(prepared.status).send({ error: prepared.error });
    if (findRunningQuoteJob(prepared.uploadId)) {
      return reply.status(409).send({ error: '이 업로드의 배송비 계산이 이미 진행 중입니다.' });
    }
    return runUploadQuote(user, prepared.uploadId, prepared.rows, prepared.selections);
  });

  // POST /api/upload/shipping-quotes/jobs — 배송비 계산 시작 (진행상태 폴링용). 같은 upload 실행 중이면 그 job 반환
  //   mode 'unfinished': 서버가 최신 parsed_rows에서 미완료 행(실패·대체 미확인·복구 후 미계산·견적 없음)을 직접 판정
  app.post('/upload/shipping-quotes/jobs', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 이용하실 수 있습니다.' });
    }
    const body = (request.body ?? {}) as { uploadId?: string; mode?: string; providerOverrides?: Record<string, unknown> };
    if (body.mode === 'unfinished') {
      if (!body.uploadId) return reply.status(400).send({ error: 'uploadId가 필요합니다' });
      const running = findRunningQuoteJob(body.uploadId);
      if (running) return { jobId: running.id, alreadyRunning: true, status: running.status, progress: running.progress };
      const upload = await db.query.csvUploads.findFirst({ where: eq(csvUploads.uploadId, body.uploadId) });
      const rows = upload?.parsedRows;
      if (!rows || rows.length === 0) return reply.status(404).send({ error: '업로드 데이터를 찾을 수 없습니다' });
      const overrides = body.providerOverrides && typeof body.providerOverrides === 'object' ? body.providerOverrides : {};
      const unfinished = unfinishedQuoteSelections(rows, overrides);
      if (unfinished.selections.length === 0) {
        return { jobId: null, alreadyRunning: false, status: 'done', unfinished: 0, summary: summarizeQuoteRows(unfinished.rows) };
      }
      const uploadId = body.uploadId;
      const { job, alreadyRunning } = startQuoteJob(uploadId, onProgress =>
        runUploadQuote(user, uploadId, unfinished.rows, unfinished.selections, onProgress, { reuseProviderFailures: true }));
      return { jobId: job.id, alreadyRunning, status: job.status, progress: job.progress, unfinished: unfinished.selections.length };
    }
    const prepared = await prepareQuoteRun(request.body);
    if ('error' in prepared) return reply.status(prepared.status).send({ error: prepared.error });
    const { job, alreadyRunning } = startQuoteJob(prepared.uploadId, onProgress =>
      runUploadQuote(user, prepared.uploadId, prepared.rows, prepared.selections, onProgress));
    return { jobId: job.id, alreadyRunning, status: job.status, progress: job.progress };
  });

  // GET /api/upload/shipping-quotes/jobs/:jobId — 진행상태 / 완료 결과
  app.get('/upload/shipping-quotes/jobs/:jobId', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 이용하실 수 있습니다.' });
    }
    const job = getQuoteJob((request.params as { jobId: string }).jobId);
    if (!job) return reply.status(404).send({ error: '배송비 계산 작업을 찾을 수 없습니다.' });
    return { jobId: job.id, uploadId: job.uploadId, status: job.status, progress: job.progress, result: job.result ?? null, error: job.error ?? null };
  });

  // GET /api/ebay/shipping-policies — eBay 배송정책 목록 (READ-ONLY, 서버 10분 캐시). 토큰·원본 응답은 내보내지 않음
  app.get('/ebay/shipping-policies', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 이용하실 수 있습니다.' });
    }
    const refresh = (request.query as { refresh?: string }).refresh === '1';
    try {
      const list = await getShippingPolicies({ refresh });
      return { ok: true, policies: list.policies, fetchedAt: list.fetchedAt, stale: list.stale };
    } catch (e) {
      return reply.status(502).send({ ok: false, error: 'SHIPPING_POLICIES_UNAVAILABLE', message: (e as Error).message });
    }
  });

  // POST /api/upload/shipping-policy — CSV upload 하나에 eBay 배송정책 하나 선택 (선택 당시 snapshot을 USD 행 전체에 저장)
  //   같은 upload에서 이미 가져온 미등록 상품에도 반영 (eBay 등록/진행 중·수동 정책·다른 upload 상품은 변경하지 않음)
  app.post('/upload/shipping-policy', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 이용하실 수 있습니다.' });
    }
    const { uploadId, policyId } = (request.body ?? {}) as { uploadId?: string; policyId?: unknown };
    if (!uploadId) return reply.status(400).send({ error: 'uploadId가 필요합니다' });
    if (typeof policyId !== 'string' || !policyId) return reply.status(400).send({ error: '배송정책을 선택하세요.' });
    if (findRunningQuoteJob(uploadId)) {
      return reply.status(409).send({ error: '배송비 계산이 끝난 뒤 배송정책을 선택하세요.' });
    }
    const upload = await db.query.csvUploads.findFirst({ where: eq(csvUploads.uploadId, uploadId) });
    const rows = upload?.parsedRows;
    if (!rows || rows.length === 0) return reply.status(404).send({ error: '업로드 데이터를 찾을 수 없습니다' });

    let list;
    try {
      list = await getShippingPolicies();
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message });
    }
    const view = list.policies.find(p => p.policyId === policyId);
    if (!view) return reply.status(404).send({ error: '선택한 eBay 배송정책을 찾을 수 없습니다. 목록을 다시 불러오세요.' });
    if (!view.supported) return reply.status(400).send({ error: view.unsupportedMessage || '자동 리스팅에서 사용할 수 없는 배송정책입니다.' });

    const snapshot = buildShippingPolicySnapshot(view, list.fetchedAt);
    const nextRows = rows.map(row => (row.priceCurrency === 'USD' ? { ...row, shippingPolicy: snapshot } : row));
    await db.update(csvUploads).set({ parsedRows: nextRows }).where(eq(csvUploads.uploadId, uploadId));
    const applied = await applyShippingPolicyToImportedRows(uploadId, nextRows, snapshot);
    logAction(user, 'import.shipping-policy', {
      targetType: 'csv_upload',
      targetId: uploadId,
      details: { policyId: snapshot.policyId, shippingType: snapshot.shippingType, buyerShippingUsd: snapshot.buyerShippingUsd, ...applied },
    });
    return { ok: true, uploadId, policy: snapshot, stale: list.stale, applied };
  });

  // POST /api/upload/shipping-alternatives/apply — 대체 배송사 적용 (개별 indices 또는 all: 대체 가능 전체)
  app.post('/upload/shipping-alternatives/apply', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '관리자만 이용하실 수 있습니다.' });
    }
    const { uploadId, indices, all } = (request.body ?? {}) as { uploadId?: string; indices?: unknown; all?: boolean };
    if (!uploadId) return reply.status(400).send({ error: 'uploadId가 필요합니다' });
    if (findRunningQuoteJob(uploadId)) {
      return reply.status(409).send({ error: '배송비 계산이 끝난 뒤 대체 배송사를 적용하세요.' });
    }
    const upload = await db.query.csvUploads.findFirst({ where: eq(csvUploads.uploadId, uploadId) });
    const rows = upload?.parsedRows;
    if (!rows || rows.length === 0) return reply.status(404).send({ error: '업로드 데이터를 찾을 수 없습니다' });

    let targets: number[];
    if (all === true) {
      targets = alternativeReadyIndices(rows);
    } else if (Array.isArray(indices) && indices.length > 0 && indices.every(i => Number.isInteger(i) && i >= 0 && i < rows.length)) {
      targets = indices as number[];
    } else {
      return reply.status(400).send({ error: '적용할 상품을 선택하세요.' });
    }

    const result = applyShippingAlternatives(rows, targets);
    if (result.applied.length > 0) {
      await db.update(csvUploads).set({ parsedRows: result.rows }).where(eq(csvUploads.uploadId, uploadId));
    }
    logAction(user, 'import.shipping-alternatives', {
      targetType: 'csv_upload',
      targetId: uploadId,
      details: { requested: targets.length, applied: result.applied.length, skipped: result.skipped.length },
    });
    return {
      uploadId,
      applied: result.applied,
      skipped: result.skipped,
      rows: result.applied.map(index => ({ index, ...describeRowShipping(result.rows[index]), quoteUnfinished: isQuoteRowUnfinished(result.rows[index]) })),
      summary: summarizeQuoteRows(result.rows),
    };
  });
}

async function prepareQuoteRun(body: unknown): Promise<
  { uploadId: string; rows: CsvRow[]; selections: ShippingQuoteSelection[] } | { status: number; error: string }
> {
  const { uploadId, selections } = (body ?? {}) as { uploadId?: string; selections?: unknown };
  if (!uploadId) return { status: 400, error: 'uploadId가 필요합니다' };
  const upload = await db.query.csvUploads.findFirst({ where: eq(csvUploads.uploadId, uploadId) });
  const rows = upload?.parsedRows;
  if (!rows || rows.length === 0) return { status: 404, error: '업로드 데이터를 찾을 수 없습니다' };
  try {
    return { uploadId, rows, selections: parseQuoteSelections(selections, rows.length) };
  } catch (e) {
    return { status: 400, error: (e as Error).message };
  }
}

/** 견적 실행 → 최신 parsed_rows에 선택 행만 upsert (다른 행·이전 정상 결과 유지) */
async function runUploadQuote(
  user: Parameters<typeof logAction>[0],
  uploadId: string,
  rows: CsvRow[],
  selections: ShippingQuoteSelection[],
  onProgress?: (p: QuoteRunProgress) => void,
  options: { reuseProviderFailures?: boolean } = {},
) {
  const result = await quoteUploadRows(rows, selections, { config: getShippingPricingConfig(), onProgress, reuseProviderFailures: options.reuseProviderFailures });
  const indices = selections.map(s => s.index);

  const latest = await db.query.csvUploads.findFirst({ where: eq(csvUploads.uploadId, uploadId) });
  const merged = mergeRowsByIndex(latest?.parsedRows, result.rows, indices);
  await db.update(csvUploads)
    .set({ parsedRows: merged })
    .where(eq(csvUploads.uploadId, uploadId));

  const views = indices.map(index => ({ index, ...describeRowShipping(merged[index]), quoteUnfinished: isQuoteRowUnfinished(merged[index]) }));
  const summary = summarizeQuoteRows(merged);
  logAction(user, 'import.shipping-quotes', {
    targetType: 'csv_upload',
    targetId: uploadId,
    details: {
      selected: selections.length,
      uniqueRequests: result.uniqueRequests,
      reused: result.progress.reused,
      retried: result.progress.retried,
      ok: views.filter(v => v.quoteStatus === 'OK').length,
      blocked: views.filter(v => v.quoteStatus !== 'OK').length,
      alternative: views.filter(v => v.quoteCategory === 'ALTERNATIVE').length,
    },
  });

  return {
    uploadId,
    uniqueRequests: result.uniqueRequests,
    progress: result.progress,
    summary,
    rows: views,
  };
}
