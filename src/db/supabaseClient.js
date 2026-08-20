/**
 * Supabase Client Singleton
 * Service-role key for server-side full access
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getClient() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in config/.env');
    }

    _client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

function isSupabaseEnabled() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

// Kept for backward compatibility — always returns 'supabase'
function getDbSource() {
  return 'supabase';
}

// Kept for backward compatibility — always returns false
function isDualWrite() {
  return false;
}

module.exports = { getClient, isSupabaseEnabled, getDbSource, isDualWrite };
