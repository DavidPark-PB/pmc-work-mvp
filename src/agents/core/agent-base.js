/**
 * Agent Base — Template method pattern for all agents
 * Lifecycle: run() → analyze() → decide() → recommend()
 * Automatically logs to audit_logs via AuditLogger
 */
const { AuditLogger } = require('./audit-logger');

class AgentBase {
  constructor(name) {
    this.name = name;
    this.logger = new AuditLogger();
  }

  /**
   * Main entry point. Runs the full agent lifecycle.
   * Returns array of recommendations created.
   */
  async run() {
    const start = Date.now();
    console.log(`[${this.name}] Starting run...`);

    try {
      await this.logger.logAction(this.name, 'run_start', {
        result: 'success',
      });

      const analysis = await this.analyze();
      const decisions = await this.decide(analysis);
      const recommendations = await this.recommend(decisions);

      const duration = Date.now() - start;
      console.log(`[${this.name}] Completed in ${duration}ms — ${recommendations.length} recommendations`);

      await this.logger.logAction(this.name, 'run_complete', {
        output: {
          totalAnalyzed: analysis.length || 0,
          totalDecisions: decisions.length || 0,
          totalRecommendations: recommendations.length,
        },
        duration_ms: duration,
      });

      return recommendations;
    } catch (err) {
      const duration = Date.now() - start;
      console.error(`[${this.name}] Error:`, err.message);

      await this.logger.logAction(this.name, 'run_error', {
        result: 'error',
        reason: err.message,
        duration_ms: duration,
      });

      throw err;
    }
  }

  /**
   * Step 1: Gather and process data
   * Override in subclass. Return analysis results.
   */
  async analyze() {
    throw new Error(`${this.name}: analyze() not implemented`);
  }

  /**
   * Step 2: Make decisions based on analysis
   * Override in subclass. Return array of decision objects.
   */
  async decide(analysis) {
    throw new Error(`${this.name}: decide() not implemented`);
  }

  /**
   * Step 3: Create recommendations from decisions
   * Override in subclass. Return array of saved recommendations.
   */
  async recommend(decisions) {
    throw new Error(`${this.name}: recommend() not implemented`);
  }
}

module.exports = { AgentBase };
