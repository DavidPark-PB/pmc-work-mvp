'use strict';
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

require('dotenv').config({ path: path.join(PROJECT_ROOT, 'config', '.env') });

module.exports = {
  PROJECT_ROOT,
  CREDENTIALS_PATH: path.join(PROJECT_ROOT, 'config', 'credentials.json'),
  DATA_DIR: path.join(PROJECT_ROOT, 'data'),
  LOGS_DIR: path.join(PROJECT_ROOT, 'data', 'sync-logs'),
};
