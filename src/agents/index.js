/**
 * Agent System — PMC
 *
 * 유지 중인 에이전트 (3개):
 * - margin-agent:     eBay 가격 자동 조정 (4h)
 * - sourcing-agent:   경쟁사 배틀 리포트 (일 03:00, 텔레그램 알림)
 * - operations-agent: 재고/단종 탐지 + team_tasks 자동 생성 (일 06:00)
 *
 * 제거됨: profit-brain, strategy-agent, marketing-agent, cs-agent, sales-agent
 * (중복·비실행·LLM 미사용으로 실질 가치 낮아 2026-04 정리)
 */
const { MarginAgent } = require('./margin-agent');
const { SourcingAgent } = require('./sourcing-agent');
const { OperationsAgent } = require('./operations-agent');
const { AgentBase } = require('./core/agent-base');
const { AuditLogger } = require('./core/audit-logger');
const { ProfitCalculator } = require('./core/profit-calculator');

const agents = {
  'margin-agent': MarginAgent,
  'sourcing-agent': SourcingAgent,
  'operations-agent': OperationsAgent,
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
  MarginAgent, SourcingAgent, OperationsAgent,
  AgentBase, AuditLogger, ProfitCalculator,
  agents, runAgent, runAll,
};
