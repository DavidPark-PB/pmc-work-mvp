/**
 * Sales Agent — B2B Pipeline Engine
 *
 * Detects repeat buyers → creates leads → drafts cold/follow-up emails
 * Manages: lead scoring, pipeline stages, invoice reminders
 *
 * Schedule: Daily at 09:00 KST
 */
const { AgentBase } = require('./core/agent-base');
const { LeadRepository } = require('../db/leadRepository');
const { getClient } = require('../db/supabaseClient');

const AGENT_NAME = 'sales-agent';

const THRESHOLDS = {
  REPEAT_BUYER_MIN_ORDERS: 3,
  REPEAT_BUYER_MIN_SPENT: 500,
  DORMANT_DAYS: 30,
  FOLLOW_UP_DAYS: 7,
  DEDUP_HOURS: 72,
};

class SalesAgent extends AgentBase {
  constructor() {
    super(AGENT_NAME);
    this.leadRepo = new LeadRepository();
  }

  /**
   * Step 1: Identify B2B candidates + load pipeline
   */
  async analyze() {
    const db = getClient();

    // 1. Find repeat buyers from orders table
    const { data: repeatBuyers } = await db.rpc('get_repeat_buyers_raw', {}).catch(() => ({ data: null }));

    // Fallback: manual query if RPC not available
    let candidates = [];
    if (!repeatBuyers) {
      const { data: orders } = await db
        .from('orders')
        .select('buyer_name, email, country_code, platform, total_amount, currency')
        .not('email', 'is', null)
        .neq('email', '');

      // Group by email
      const byEmail = {};
      for (const o of (orders || [])) {
        if (!o.email) continue;
        if (!byEmail[o.email]) byEmail[o.email] = { email: o.email, name: o.buyer_name, country: o.country_code, platform: o.platform, orders: 0, spent: 0 };
        byEmail[o.email].orders++;
        byEmail[o.email].spent += parseFloat(o.total_amount) || 0;
      }

      candidates = Object.values(byEmail).filter(b =>
        b.orders >= THRESHOLDS.REPEAT_BUYER_MIN_ORDERS || b.spent >= THRESHOLDS.REPEAT_BUYER_MIN_SPENT
      );
    } else {
      candidates = repeatBuyers;
    }

    // 2. Load existing leads needing follow-up
    const followUps = await this.leadRepo.getLeadsNeedingFollowUp();

    // 3. Find dormant B2B buyers
    const { data: b2bBuyers } = await db
      .from('b2b_buyers')
      .select('id, company_name, contact_person, email, country, total_revenue, last_order_date');
    const dormant = (b2bBuyers || []).filter(b => {
      if (!b.last_order_date) return true;
      const daysSince = (Date.now() - new Date(b.last_order_date)) / (24 * 60 * 60 * 1000);
      return daysSince > THRESHOLDS.DORMANT_DAYS;
    });

    // 4. Find unpaid invoices
    const { data: unpaidInvoices } = await db
      .from('b2b_invoices')
      .select('id, invoice_no, buyer_id, total_amount, currency, status, created_at')
      .eq('status', 'CREATED')
      .order('created_at', { ascending: true });

    // 5. Pipeline summary
    const pipeline = await this.leadRepo.getPipeline();

    console.log(`[${this.name}] ${candidates.length} repeat buyers, ${followUps.length} follow-ups, ${dormant.length} dormant, ${(unpaidInvoices || []).length} unpaid invoices`);

    return { candidates, followUps, dormant, unpaidInvoices: unpaidInvoices || [], pipeline };
  }

  /**
   * Step 2: Score leads, generate email drafts
   */
  async decide(analysis) {
    const decisions = [];

    // --- New leads from repeat buyers ---
    for (const buyer of analysis.candidates) {
      const score = this.scoreLead(buyer);
      decisions.push({
        type: 'new_lead',
        email: buyer.email,
        contactName: buyer.name || '',
        country: buyer.country || '',
        platform: buyer.platform || 'ebay',
        score,
        orderCount: buyer.orders,
        totalSpent: buyer.spent,
        emailDraft: this.generateColdEmail(buyer),
        subject: 'Wholesale Pricing Available — PMC Corporation',
        priority: score > 70 ? 'high' : 'medium',
        message: `[신규리드] ${buyer.email} — ${buyer.orders}건 주문, $${Math.round(buyer.spent)} 구매. 점수: ${score}`,
      });
    }

    // --- Follow-ups for existing leads ---
    for (const lead of analysis.followUps) {
      decisions.push({
        type: 'follow_up',
        leadId: lead.id,
        email: lead.email,
        contactName: lead.contact_name,
        stage: lead.stage,
        emailDraft: this.generateFollowUp(lead),
        subject: `Following Up — PMC Corporation`,
        priority: 'medium',
        message: `[후속] ${lead.email} — 단계: ${lead.stage}, 마지막 연락: ${lead.last_contacted || '없음'}`,
      });
    }

    // --- Dormant buyer re-engagement ---
    for (const buyer of analysis.dormant.slice(0, 10)) {
      if (!buyer.email) continue;
      decisions.push({
        type: 'reengagement',
        buyerId: buyer.id,
        email: buyer.email,
        contactName: buyer.contact_person || buyer.company_name,
        emailDraft: this.generateReengagement(buyer),
        subject: 'New Arrivals & Updated Price List — PMC Corporation',
        priority: 'low',
        message: `[리인게이지] ${buyer.company_name} — 총매출 $${buyer.total_revenue || 0}`,
      });
    }

    // --- Invoice reminders ---
    for (const inv of analysis.unpaidInvoices.slice(0, 5)) {
      const daysSince = Math.floor((Date.now() - new Date(inv.created_at)) / (24 * 60 * 60 * 1000));
      if (daysSince < 7) continue; // wait at least 7 days
      decisions.push({
        type: 'invoice_reminder',
        invoiceNo: inv.invoice_no,
        buyerId: inv.buyer_id,
        amount: inv.total_amount,
        currency: inv.currency,
        priority: daysSince > 30 ? 'high' : 'medium',
        message: `[인보이스] ${inv.invoice_no} — ${inv.currency} ${inv.total_amount}, ${daysSince}일 경과`,
      });
    }

    console.log(`[${this.name}] ${decisions.length} sales actions`);
    return decisions;
  }

  /**
   * Step 3: Save leads + email drafts + recommendations
   */
  async recommend(decisions) {
    const saved = [];

    for (const d of decisions) {
      // Create/update lead for new_lead type
      if (d.type === 'new_lead' && d.email) {
        try {
          await this.leadRepo.upsertLead({
            email: d.email,
            source: 'ebay_repeat',
            contact_name: d.contactName,
            country: d.country,
            platform: d.platform,
            score: d.score,
            stage: 'new',
            interest: `${d.orderCount} orders, $${Math.round(d.totalSpent)} spent`,
          });
        } catch (e) { /* duplicate, skip */ }
      }

      // Save email draft
      if (d.emailDraft && d.email) {
        try {
          await this.leadRepo.createEmailDraft({
            lead_id: d.leadId || null,
            buyer_id: d.buyerId || null,
            type: d.type === 'new_lead' ? 'cold_email' : d.type,
            to_email: d.email,
            subject: d.subject || 'PMC Corporation',
            body_text: d.emailDraft,
          });
        } catch (e) { console.log(`[${this.name}] Draft save error:`, e.message); }
      }

      // Create recommendation
      const rec = await this.logger.logRecommendation({
        agent_name: AGENT_NAME,
        type: `b2b_${d.type}`,
        sku: d.email || d.invoiceNo,
        platform: d.platform || null,
        priority: d.priority,
        current_value: {
          email: d.email,
          contactName: d.contactName,
          orderCount: d.orderCount,
          totalSpent: d.totalSpent,
        },
        recommended_value: {
          emailDraft: d.emailDraft?.substring(0, 500),
          subject: d.subject,
          type: d.type,
        },
        reason: d.message,
        confidence: d.type === 'new_lead' ? 0.80 : 0.65,
        status: 'pending',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      if (rec) saved.push(rec);
    }

    // Detailed sales notification
    const newLeadItems = decisions.filter(d => d.type === 'new_lead');
    const followUpItems = decisions.filter(d => d.type === 'follow_up');
    const dormantItems = decisions.filter(d => d.type === 'reengagement');
    const invoiceItems = decisions.filter(d => d.type === 'invoice_reminder');
    try {
      const imessage = require('../services/imessage');
      if (imessage.isConfigured()) {
        await imessage.sendSalesReport({
          newLeads: newLeadItems.length,
          followUps: followUpItems.length,
          dormant: dormantItems.length,
          unpaidInvoices: invoiceItems.length,
          topLeads: newLeadItems.sort((a, b) => b.score - a.score).slice(0, 3),
          emailDrafts: newLeadItems.length + followUpItems.length + dormantItems.length,
        });
      }
      const telegram = require('../services/telegramBot');
      if (telegram.isConfigured()) {
        await telegram.sendMessage(`📈 *Sales 리포트*\n신규 리드: ${newLeadItems.length}\n후속: ${followUpItems.length}\n미결제: ${invoiceItems.length}`);
      }
    } catch (e) { /* skip */ }

    console.log(`[${this.name}] ${saved.length} sales recommendations saved`);
    return saved;
  }

  // ===== Helper methods =====

  scoreLead(buyer) {
    let score = 0;
    score += Math.min(buyer.orders * 5, 30);              // max 30 from order count
    score += Math.min(Math.floor(buyer.spent / 100), 30); // max 30 from spend
    if (buyer.country === 'US') score += 15;               // US market premium
    else if (['GB', 'CA', 'AU', 'DE', 'JP'].includes(buyer.country)) score += 10;
    else score += 5;
    score += buyer.orders >= 5 ? 15 : 0;                  // loyalty bonus
    return Math.min(score, 100);
  }

  generateColdEmail(buyer) {
    return `Thank you for being a valued customer! We noticed you've placed ${buyer.orders} orders with us.

We'd like to offer you exclusive wholesale pricing:
• 10+ units: 10% discount
• 50+ units: 15% discount
• 100+ units: 20% discount + free shipping

We specialize in authentic Korean products:
- K-POP merchandise (BTS, BLACKPINK, NewJeans, etc.)
- Pokemon cards & collectibles
- Character goods (Sanrio, Crayon Shin-chan, etc.)

Would you like us to prepare a custom price list based on your interests?

Looking forward to hearing from you!`;
  }

  generateFollowUp(lead) {
    return `I hope this message finds you well.

I wanted to follow up on our previous conversation about wholesale pricing for Korean products.

We recently added new arrivals that might interest you:
- Latest K-POP comeback merchandise
- New Pokemon TCG releases
- Seasonal character goods

Would you like an updated price list? We're happy to customize it based on your market.

Please don't hesitate to reach out with any questions!`;
  }

  generateReengagement(buyer) {
    return `It's been a while since your last order, and we wanted to share some updates:

🆕 New arrivals this month:
- Latest K-POP group merchandise
- Pokemon Scarlet & Violet new releases
- Trending character collaborations

💰 Special returning customer offer:
- Extra 5% discount on your next order
- Free express shipping on orders over $500

We'd love to have you back! Let us know if you'd like an updated catalog.`;
  }
}

module.exports = { SalesAgent };
