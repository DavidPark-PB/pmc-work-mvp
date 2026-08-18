'use strict';

/**
 * src/services/oms/financialMetricsOrchestratorDefaults.js — Phase 8O.
 *
 * DB factory for the default orchestrator wiring. Kept in a separate
 * module so the route source stays db-agnostic (I17-I20 / J11 static
 * guard: router source MUST NOT contain getClient()).
 */

function defaultDb() {
  return require('../../db/supabaseClient').getClient();
}

module.exports = { defaultDb };
