/**
 * Admin 비밀번호 재설정
 * 환경변수 ADMIN_PASSWORD 값으로 해시 업데이트
 */
import { db } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/auth.js';
import { env } from '../src/lib/config.js';
import { eq } from 'drizzle-orm';

const password = env.ADMIN_PASSWORD;
const hash = await hashPassword(password);

await db.update(users)
  .set({ passwordHash: hash })
  .where(eq(users.username, env.ADMIN_USERNAME));

console.log(`Admin password reset for '${env.ADMIN_USERNAME}'`);
process.exit(0);
