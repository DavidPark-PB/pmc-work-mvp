/**
 * Admin 계정 시드 스크립트
 */
import { seedAdminUser } from '../src/lib/auth.js';
import { db } from '../src/db/index.js';
import { users } from '../src/db/schema.js';

try {
  await seedAdminUser();

  const allUsers = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    role: users.role,
  }).from(users);

  console.log('Users in DB:', allUsers);
} catch (e) {
  console.error('Error:', e);
}

process.exit(0);
