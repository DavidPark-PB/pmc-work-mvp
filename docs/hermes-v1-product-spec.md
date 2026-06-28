# Hermes v1 Product Spec — eBay Market Intelligence

## Mission

Hermes is an AI Business Operating System for ecommerce operators. It is not a lowest-price repricing bot.

Hermes collects market, competitor, listing, supplier, buyer, inventory, and margin data, then helps the operator make better business decisions.

## Core Philosophy

Hermes should:

- avoid unprofitable competition
- choose only competition that protects profit
- prioritize margin and business context over lowest price
- explain every recommendation
- keep humans in control before any price-changing automation exists

## Automation Principle

All automation must follow this order:

1. Monitoring
2. Analysis
3. Recommendation
4. Human Approval
5. Limited Automation

Hermes v1 stops at Monitoring, Analysis, Recommendation, and reporting. It does not automatically change prices.

## Hermes v1 Scope

Hermes v1 is eBay Market Intelligence.

Included:

- eBay competitor seller monitoring
- competitor price history
- competitor shipping monitoring
- competitor stock/status monitoring
- new competitor listing detection
- ended competitor listing detection
- SKU-to-competitor matching
- Telegram alerts
- daily AI market report
- strategy recommendations with reasons

Excluded from v1:

- automatic price changes
- bulk repricing
- one-click live repricing from Telegram
- autonomous repricing agents
- listing writes triggered by market intelligence

## v1 Safety Policy

Price writes must be disabled by default.

Any market intelligence pipeline should produce:

- observations
- alerts
- recommended actions
- safe price / minimum price / do-not-go-below price
- explanation

It must not directly call marketplace APIs to change prices.

Allowed action labels:

- keep
- watch
- raise_candidate
- drop_candidate
- do_not_follow
- listing_quality_issue
- supplier_risk
- margin_risk

Disallowed v1 behavior:

- calling eBay price update APIs from repricing pipelines
- Telegram buttons that immediately apply repricing recommendations
- scheduled jobs that modify listing prices
- using single-competitor dumping as a price-following signal

## v1 Data Model Direction

Core tables should converge around:

- competitor_sellers
- competitor_listings
- product_matches
- competitor_price_history
- competitor_alerts
- strategy_recommendations
- market_daily_reports

Every material competitor/listing/price change should be stored historically, not overwritten only.

## eBay Monitoring Agent

Target: about 50 competitor sellers.

Collect:

- price
- shipping cost
- inventory/status
- new listings
- ended listings
- promotions if detectable
- best offer flag if detectable
- estimated delivery if detectable
- seller feedback
- store/listing changes

## Matching Engine

A single internal SKU may map to multiple competitor listings:

My SKU → Competitor A / B / C / D

Matches may be:

- auto-approved when confidence is very high
- pending when uncertain
- manually approved/rejected through Telegram or dashboard

## Business Intelligence Calculations

Hermes should calculate:

- product cost
- shipping cost
- marketplace fee
- payment fee
- packaging cost
- exchange rate
- target margin
- safe price
- recommended price
- minimum price
- do-not-go-below price

## Strategy Engine v1

The first strategy engine can be deterministic/rule-based with explanation text.

Examples:

- If one competitor drops sharply while others do not: do_not_follow, likely dumping or clearance.
- If multiple competitors raise prices: raise_candidate.
- If competitor listings end or stock disappears: keep or raise_candidate due to possible supply shortage.
- If our price is lower but sales are weak: listing_quality_issue, not price issue.
- If recommended price would breach margin floor: margin_risk and do_not_follow.

Every recommendation must include a reason.

## CEO Daily Report

Hermes should generate a daily report containing:

- business summary
- today’s market movement
- top price gainers
- top price losers
- competitor activity
- new competitor listings
- ended competitor listings
- inventory warnings
- margin warnings
- suggested actions

Suggested actions should be recommendations only in v1.

## Future Phases

### Phase 2 — AI Recommendation

- deeper market analysis
- inventory analysis
- price suggestions
- listing-quality diagnosis

### Phase 3 — Approval Workflow

- user can approve selected recommendations
- approval flow must be explicit and auditable

### Phase 4 — Limited Auto Repricing

Only after v1/v2/v3 prove reliable.

Possible conditions:

- margin >= 20%
- inventory >= 30
- recent sales signal exists
- at least two competitors moved similarly
- max 3% adjustment
- max one adjustment per SKU per day

Never auto-change:

- rare products
- newly released Pokemon products
- B2B negotiation items
- margin < 15%
- single-competitor dumping
- supply-shortage cases
