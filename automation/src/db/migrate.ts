import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './index.js';
import { logger } from '../lib/logger.js';

async function runMigrations() {
  logger.info('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  logger.info('Migrations complete.');
  process.exit(0);
}

runMigrations().catch((err) => {
  logger.error(err, 'Migration failed');
  process.exit(1);
});
