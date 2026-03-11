/**
 * CSV 파일 업로드 라우트
 */
import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { parseCsvFile } from '../lib/csv-parser.js';
import { db } from '../db/index.js';
import { csvUploads } from '../db/schema.js';
import { getUser } from '../lib/user-session.js';

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

    // 디렉토리 확보
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    const uploadId = randomUUID();
    const savePath = path.join(UPLOAD_DIR, `${uploadId}.csv`);

    // 파일 저장
    await pipeline(data.file, fs.createWriteStream(savePath));

    // 파싱해서 미리보기 추출
    const rows = parseCsvFile(savePath);
    const preview = rows.slice(0, 5).map(r => ({
      name: r.name,
      price: r.price,
      image: r.image,
      url: r.url,
    }));

    // DB에 업로드 이력 저장
    await db.insert(csvUploads).values({
      uploadId,
      filename: data.filename,
      rowCount: rows.length,
      ownerId: user.id,
      ownerName: user.name,
    });

    return {
      uploadId,
      filename: data.filename,
      rowCount: rows.length,
      preview,
    };
  });
}
