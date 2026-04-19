/**
 * CSV 파일 업로드 라우트
 *
 * 업로드 → rawFields(원본) DB 저장 → Gemini/키워드 자동 매핑 감지
 * 매핑 확정(confirm-mapping) → applyMapping → parsedRows 저장
 */
import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { parseCsvRawFields, detectMappingByKeyword, applyMapping } from '../lib/csv-parser.js';
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

    // 빠른 키워드 매핑부터 즉시 저장 → 클라이언트 응답을 1~2초 내로 끝낸다.
    // 화면보호기 켜져도 업로드 단계는 이미 완료됨. AI 매핑은 백그라운드.
    const headers = rawFields[0];
    const sampleRows = rawFields.slice(1, 6);
    const keywordMapping = detectMappingByKeyword(rawFields);

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
    void (async () => {
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

    // 필수 필드 검증
    if (!('name' in mapping) || (!('url' in mapping) && !('price' in mapping))) {
      return reply.status(400).send({ error: '상품명 + (상품URL 또는 가격) 매핑이 필요합니다' });
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
}
