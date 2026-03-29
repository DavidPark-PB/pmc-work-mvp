/**
 * CS Agent v2 — Active Customer Service Agent
 *
 * Reads buyer messages from eBay + Alibaba,
 * generates contextual replies using Claude,
 * queues for human approval, then sends via platform API.
 *
 * Schedule: Every 30 minutes
 */
const { AgentBase } = require('./core/agent-base');
const { MessageRepository } = require('../db/messageRepository');
const { getClient } = require('../db/supabaseClient');

const AGENT_NAME = 'cs-agent';

class CSAgent extends AgentBase {
  constructor() {
    super(AGENT_NAME);
    this.messageRepo = new MessageRepository();
  }

  /**
   * Step 1: Fetch new messages from eBay + Alibaba, store in DB
   */
  async analyze() {
    const db = getClient();
    const newMessages = [];

    // --- eBay Messages ---
    try {
      const EbayAPI = require('../api/ebayAPI');
      const ebay = new EbayAPI();
      const messages = await ebay.getMyMessages();

      for (const msg of messages) {
        if (msg.read) continue; // skip already read

        // Get full content
        let content = null;
        try {
          content = await ebay.getMessageContent(msg.messageId);
        } catch (e) {
          console.log(`[${this.name}] Failed to get eBay message ${msg.messageId}:`, e.message);
          continue;
        }
        if (!content || !content.body) continue;

        // Store in DB
        const stored = await this.messageRepo.upsertMessage({
          platform: 'ebay',
          message_id: msg.messageId,
          direction: 'inbound',
          sender: content.sender || msg.sender,
          recipient: content.recipientUserId || '',
          subject: content.subject,
          body: content.body,
          item_id: content.itemId || msg.itemId,
          language: 'en', // eBay messages are mostly English
        });
        if (stored) newMessages.push(stored);
      }
      console.log(`[${this.name}] eBay: ${messages.length} fetched, ${newMessages.length} new`);
    } catch (e) {
      console.log(`[${this.name}] eBay messages unavailable:`, e.message);
    }

    // --- Alibaba Inquiries ---
    try {
      const AlibabaAPI = require('../api/alibabaAPI');
      const alibaba = new AlibabaAPI();
      const inquiries = await alibaba.getInquiries();

      for (const inq of inquiries) {
        const msgId = inq.message_id || inq.id || '';
        if (!msgId) continue;

        const stored = await this.messageRepo.upsertMessage({
          platform: 'alibaba',
          message_id: String(msgId),
          direction: 'inbound',
          sender: inq.sender_name || inq.buyer_name || '',
          subject: inq.subject || 'Inquiry',
          body: inq.content || inq.message || '',
          item_id: inq.product_id || '',
        });
        if (stored) newMessages.push(stored);
      }
      console.log(`[${this.name}] Alibaba: ${inquiries.length} fetched`);
    } catch (e) {
      console.log(`[${this.name}] Alibaba inquiries unavailable:`, e.message);
    }

    // Also load any unprocessed messages from DB
    const pending = await this.messageRepo.getNewMessages();
    const allNew = [...new Map([...newMessages, ...pending].map(m => [m.id, m])).values()];

    console.log(`[${this.name}] ${allNew.length} messages to process`);
    return allNew;
  }

  /**
   * Step 2: Classify each message and generate draft reply
   */
  async decide(analysis) {
    const decisions = [];
    const db = getClient();

    for (const msg of analysis) {
      // Look up related order info
      let orderContext = '';
      if (msg.item_id) {
        const { data: orders } = await db
          .from('orders')
          .select('order_id, status, carrier, tracking_number, created_at, buyer_name')
          .or(`sku.eq.${msg.item_id},order_id.eq.${msg.item_id}`)
          .order('created_at', { ascending: false })
          .limit(1);

        if (orders?.length) {
          const o = orders[0];
          orderContext = `Order: ${o.order_id}, Status: ${o.status}, Carrier: ${o.carrier || 'N/A'}, Tracking: ${o.tracking_number || 'N/A'}, Date: ${o.created_at}`;
        }
      }

      // Generate AI draft reply using simple prompt
      const draftReply = this.generateDraftReply(msg, orderContext);
      const category = this.classifyMessage(msg.body, msg.subject);
      const priority = ['return_request', 'complaint', 'refund'].includes(category) ? 'high' : 'medium';

      decisions.push({
        messageId: msg.id,
        platform: msg.platform,
        sender: msg.sender,
        subject: msg.subject,
        body: msg.body,
        category,
        priority,
        draftReply,
        orderContext,
        itemId: msg.item_id,
      });
    }

    console.log(`[${this.name}] Generated ${decisions.length} draft replies`);
    return decisions;
  }

  /**
   * Step 3: Save drafts and create recommendations
   */
  async recommend(decisions) {
    const saved = [];

    for (const d of decisions) {
      // Update message with draft
      await this.messageRepo.updateMessage(d.messageId, {
        draft_reply: d.draftReply,
        category: d.category,
        status: 'draft_ready',
      });

      // Create recommendation for human review
      const rec = await this.logger.logRecommendation({
        agent_name: AGENT_NAME,
        type: 'cs_message_reply',
        sku: d.itemId || d.sender,
        platform: d.platform,
        priority: d.priority,
        current_value: {
          sender: d.sender,
          subject: d.subject,
          body: d.body.substring(0, 500),
          category: d.category,
          messageId: d.messageId,
        },
        recommended_value: {
          draftReply: d.draftReply,
          orderContext: d.orderContext,
        },
        reason: `[CS] ${d.platform} ${d.category}: "${d.subject}" from ${d.sender}`,
        confidence: 0.80,
        status: 'pending',
        expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      });

      if (rec) saved.push(rec);

      // High priority → immediate notification
      if (d.priority === 'high') {
        await this.logger.logAlert({
          agent_name: AGENT_NAME,
          type: d.category,
          severity: 'warning',
          title: `CS 긴급: ${d.sender} — ${d.category}`,
          message: `${d.subject}\n\n${d.body.substring(0, 200)}`,
          sku: d.itemId,
          platform: d.platform,
          context_data: { draftReply: d.draftReply.substring(0, 300) },
        });

        // Push to iMessage/Telegram
        try {
          const notify = require('../services/notify');
          await notify.send(`🔔 CS ${d.category}\nFrom: ${d.sender}\n"${d.subject}"\n\n초안 준비됨 — 대시보드에서 승인하세요`);
        } catch (e) { /* skip */ }
      }
    }

    console.log(`[${this.name}] ${saved.length} CS drafts ready for review`);
    return saved;
  }

  /**
   * Classify message into category based on keywords
   */
  classifyMessage(body, subject) {
    const text = `${subject} ${body}`.toLowerCase();

    if (/return|refund|money back|send back/.test(text)) return 'return_request';
    if (/complain|unhappy|terrible|worst|scam|fraud/.test(text)) return 'complaint';
    if (/where.*(my|is|order|item|package)|track|shipping|deliver|when.*arrive|not received/.test(text)) return 'shipping_inquiry';
    if (/customs|duty|tax|held|seized/.test(text)) return 'customs_delay';
    if (/size|color|authentic|genuine|real|original|compatible|fit/.test(text)) return 'product_question';
    if (/wholesale|bulk|quantity|discount|business/.test(text)) return 'wholesale_inquiry';
    if (/thank|great|love|perfect|excellent|happy/.test(text)) return 'positive_feedback';
    return 'general';
  }

  /**
   * Generate a draft reply based on message category and context
   */
  generateDraftReply(msg, orderContext) {
    const category = this.classifyMessage(msg.body, msg.subject);
    const sender = msg.sender || 'there';

    switch (category) {
      case 'shipping_inquiry':
        return `Hi ${sender},\n\nThank you for your message about your order.\n\n${orderContext ? `Here is your order status:\n${orderContext}\n\n` : ''}International shipping from South Korea typically takes 10-15 business days. If your package hasn't arrived within 21 business days, please let us know and we'll investigate with the carrier.\n\nBest regards,\nPMC Corporation`;

      case 'return_request':
        return `Hi ${sender},\n\nWe're sorry to hear you'd like to return your item.\n\nWe accept returns within 30 days of delivery:\n1. Please ship the item back to our address (we'll provide details)\n2. Return shipping is the buyer's responsibility for change-of-mind returns\n3. Refund will be processed within 3 business days of receiving the item\n\nWould you like to proceed?\n\nBest regards,\nPMC Corporation`;

      case 'complaint':
        return `Hi ${sender},\n\nWe sincerely apologize for the inconvenience. Your satisfaction is our top priority.\n\nCould you please share more details about the issue? We'd like to make this right for you.\n\n${orderContext ? `Order info: ${orderContext}\n\n` : ''}We'll respond as quickly as possible with a resolution.\n\nBest regards,\nPMC Corporation`;

      case 'customs_delay':
        return `Hi ${sender},\n\nInternational shipments from South Korea may occasionally experience customs processing delays. This is normal and typically resolves within 3-5 business days.\n\n${orderContext ? `Your order: ${orderContext}\n\n` : ''}If the package hasn't cleared customs within 7 business days, please contact us and we'll assist with any documentation needed.\n\nBest regards,\nPMC Corporation`;

      case 'product_question':
        return `Hi ${sender},\n\nThank you for your interest!\n\nAll our products are 100% authentic, sourced directly from authorized Korean distributors. We guarantee genuineness.\n\nPlease let us know if you have any other questions!\n\nBest regards,\nPMC Corporation`;

      case 'wholesale_inquiry':
        return `Hi ${sender},\n\nThank you for your interest in wholesale!\n\nWe offer competitive bulk pricing for businesses. Could you tell us:\n1. Which products are you interested in?\n2. Approximate quantities?\n3. Your target market/country?\n\nWe'll prepare a custom quotation for you.\n\nBest regards,\nPMC Corporation — Wholesale Division`;

      case 'positive_feedback':
        return `Hi ${sender},\n\nThank you so much for your kind words! We're glad you're happy with your purchase.\n\nIf you'd like to see more Korean products, check out our store for new arrivals!\n\nBest regards,\nPMC Corporation`;

      default:
        return `Hi ${sender},\n\nThank you for reaching out.\n\n${orderContext ? `Regarding your order:\n${orderContext}\n\n` : ''}We'll review your message and get back to you shortly.\n\nBest regards,\nPMC Corporation`;
    }
  }
}

module.exports = { CSAgent };
