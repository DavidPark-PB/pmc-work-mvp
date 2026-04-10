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

    // 자동 매핑 감지: Gemini → 키워드 폴백
    const headers = rawFields[0];
    const sampleRows = rawFields.slice(1, 6);
    let autoMapping = await detectMappingWithAI(headers, sampleRows);
    if (!autoMapping || Object.keys(autoMapping).length === 0) {
      autoMapping = detectMappingByKeyword(rawFields);
    }

    // DB에 저장: rawFields + autoMapping (parsedRows는 매핑 확정 후)
    await db.insert(csvUploads).values({
      uploadId,
      filename: data.filename,
      rowCount: rawFields.length - 1,  // 헤더 제외
      rawFields,
      columnMapping: autoMapping,
      ownerId: user.id,
      ownerName: user.name,
    });

    logAction(user, 'import.csv', { targetType: 'csv_upload', targetId: uploadId, details: { filename: data.filename, rowCount: rawFields.length - 1 } });
    return {
      uploadId,
      filename: data.filename,
      rowCount: rawFields.length - 1,
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
