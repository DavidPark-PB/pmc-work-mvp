/**
 * Agent System — PMC AI Executive Team
 *
 * v1 (Monitoring):
 * - margin-agent:      eBay repricing recommendations (every 4h)
 * - profit-brain:      Net profit analysis + margin defense (every 4h)
 * - sourcing-agent:    Competitor price battle report (daily 03:00)
 *
 * v2 (Action):
 * - cs-agent:          Read buyer messages → draft replies → send on approve (every 30min)
 * - sales-agent:       B2B pipeline: detect leads, cold email, follow-up (daily 09:00)
 * - operations-agent:  Keywords, inventory, task management (daily 06:00)
 * - marketing-agent:   Title optimization, ads, cross-platform gaps (weekly Mon 07:00)
 * - strategy-agent:    Morning briefing aggregating all agents (daily 08:00)
 */
const { MarginAgent } = require('./margin-agent');
const { ProfitBrainAgent } = require('./profit-brain');
const { SourcingAgent } = require('./sourcing-agent');
const { CSAgent } = require('./cs-agent');
const { SalesAgent } = require('./sales-agent');
const { OperationsAgent } = require('./operations-agent');
const { MarketingAgent } = require('./marketing-agent');
const { StrategyAgent } = require('./strategy-agent');
const { AgentBase } = require('./core/agent-base');
const { AuditLogger } = require('./core/audit-logger');
const { ProfitCalculator } = require('./core/profit-calculator');

const agents = {
  'margin-agent': MarginAgent,
  'profit-brain': ProfitBrainAgent,
  'sourcing-agent': SourcingAgent,
  'cs-agent': CSAgent,
  'sales-agent': SalesAgent,
  'operations-agent': OperationsAgent,
  'marketing-agent': MarketingAgent,
  'strategy-agent': StrategyAgent,
};

async function runAgent(name) {
  const AgentClass = agents[name];
  if (!AgentClass) throw new Error(`Unknown agent: ${name}. Available: ${Object.keys(agents).join(', ')}`);
  return await new AgentClass().run();
}

async function runAll() {
  const results = {};
  for (const [name, AgentClass] of Object.entries(agents)) {
    try { results[name] = await new AgentClass().run(); }
    catch (err) { console.error(`[AgentSystem] ${name} failed:`, err.message); results[name] = { error: err.message }; }
  }
  return results;
}

module.exports = {
  MarginAgent, ProfitBrainAgent, SourcingAgent, CSAgent,
  SalesAgent, OperationsAgent, MarketingAgent, StrategyAgent,
  AgentBase, AuditLogger, ProfitCalculator,
  agents, runAgent, runAll,
};
