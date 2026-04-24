/**
 * B2B Repository — Supabase replacement for B2B Buyers + B2B Invoices sheets
 */
const { getClient } = require('./supabaseClient');

class B2BRepository {
  get db() { return getClient(); }

  // ─── Buyers ───

  async getBuyers() {
    const { data, error } = await this.db
      .from('b2b_buyers')
      .select('*')
      .order('buyer_id');
    if (error) throw error;

    // Match existing B2BInvoiceService format
    return (data || []).map(r => ({
      BuyerID: r.buyer_id,
      Name: r.name,
      Contact: r.contact,
      Email: r.email,
      WhatsApp: r.whatsapp,
      Phone: r.phone,
      Address: r.address,
      Country: r.country,
      Currency: r.currency,
      PaymentTerms: r.payment_terms,
      Notes: r.notes,
      TotalOrders: r.total_orders || 0,
      TotalRevenue: parseFloat(r.total_revenue) || 0,
      ExternalIds: r.external_ids || {},
      ShippingRule: r.shipping_rule || {},
    }));
  }

  async getBuyerById(buyerId) {
    const { data, error } = await this.db
      .from('b2b_buyers')
      .select('*')
      .eq('buyer_id', buyerId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;

    return {
      BuyerID: data.buyer_id,
      Name: data.name,
      Contact: data.contact,
      Email: data.email,
      WhatsApp: data.whatsapp,
      Phone: data.phone,
      Address: data.address,
      Country: data.country,
      Currency: data.currency,
      PaymentTerms: data.payment_terms,
      Notes: data.notes,
      TotalOrders: data.total_orders || 0,
      TotalRevenue: parseFloat(data.total_revenue) || 0,
      ExternalIds: data.external_ids || {},
      ShippingRule: data.shipping_rule || {},
    };
  }

  async createBuyer(buyer) {
    const row = {
      buyer_id: buyer.BuyerID || buyer.buyerId,
      name: buyer.Name || buyer.name || '',
      contact: buyer.Contact || buyer.contact || '',
      email: buyer.Email || buyer.email || '',
      whatsapp: buyer.WhatsApp || buyer.whatsapp || '',
      phone: buyer.Phone || buyer.phone || '',
      address: buyer.Address || buyer.address || '',
      country: buyer.Country || buyer.country || '',
      currency: buyer.Currency || buyer.currency || 'USD',
      payment_terms: buyer.PaymentTerms || buyer.paymentTerms || '',
      notes: buyer.Notes || buyer.notes || '',
      total_orders: parseInt(buyer.TotalOrders || buyer.totalOrders) || 0,
      total_revenue: parseFloat(buyer.TotalRevenue || buyer.totalRevenue) || 0,
      external_ids: buyer.ExternalIds || buyer.externalIds || {},
      shipping_rule: buyer.ShippingRule || buyer.shippingRule || {},
    };

    const { data, error } = await this.db
      .from('b2b_buyers')
      .upsert(row, { onConflict: 'buyer_id' })
      .select();
    if (error) throw error;
    return data?.[0];
  }

  async updateBuyer(buyerId, updates) {
    const dbUpdates = {};
    if (updates.Name !== undefined) dbUpdates.name = updates.Name;
    if (updates.Email !== undefined) dbUpdates.email = updates.Email;
    if (updates.Phone !== undefined) dbUpdates.phone = updates.Phone;
    if (updates.Address !== undefined) dbUpdates.address = updates.Address;
    if (updates.Country !== undefined) dbUpdates.country = updates.Country;
    if (updates.Currency !== undefined) dbUpdates.currency = updates.Currency;
    if (updates.PaymentTerms !== undefined) dbUpdates.payment_terms = updates.PaymentTerms;
    if (updates.Notes !== undefined) dbUpdates.notes = updates.Notes;
    if (updates.TotalOrders !== undefined) dbUpdates.total_orders = parseInt(updates.TotalOrders);
    if (updates.TotalRevenue !== undefined) dbUpdates.total_revenue = parseFloat(updates.TotalRevenue);
    if (updates.ExternalIds !== undefined) dbUpdates.external_ids = updates.ExternalIds || {};
    if (updates.ShippingRule !== undefined) dbUpdates.shipping_rule = updates.ShippingRule || {};

    const { error } = await this.db
      .from('b2b_buyers')
      .update(dbUpdates)
      .eq('buyer_id', buyerId);
    if (error) throw error;
  }

  /**
   * 실제 플랫폼 주문 조회 — orders.b2b_buyer_id로 매핑된 주문들.
   * 주문 테이블에 `b2b_buyer_id` 컬럼(018 마이그레이션)이 있어야 함.
   */
  async getBuyerOrders(buyerId, { from, to, limit = 500 } = {}) {
    let q = this.db.from('orders')
      .select('order_no, platform, order_date, buyer_name, email, title, sku, quantity, payment_amount, currency, status, country')
      .eq('b2b_buyer_id', buyerId)
      .order('order_date', { ascending: false })
      .limit(limit);
    if (from) q = q.gte('order_date', from);
    if (to) q = q.lte('order_date', to);
    const { data, error } = await q;
    if (error && error.code !== '42703') throw error;   // column missing = migration not applied
    return data || [];
  }

  async getBuyerRevenue(buyerId, { from, to } = {}) {
    const orders = await this.getBuyerOrders(buyerId, { from, to, limit: 5000 });
    const totals = {};
    for (const o of orders) {
      const ccy = (o.currency || 'USD').toUpperCase();
      totals[ccy] = (totals[ccy] || 0) + (parseFloat(o.payment_amount) || 0);
    }
    return { totals, orderCount: orders.length };
  }

  /** 미매칭 주문 — admin이 수동 지정할 수 있도록 */
  async getUnmappedOrders({ from, to, limit = 200, platform } = {}) {
    let q = this.db.from('orders')
      .select('order_no, platform, order_date, buyer_name, email, title, payment_amount, currency, country')
      .is('b2b_buyer_id', null)
      .order('order_date', { ascending: false })
      .limit(limit);
    if (from) q = q.gte('order_date', from);
    if (to) q = q.lte('order_date', to);
    if (platform) q = q.eq('platform', platform);
    const { data, error } = await q;
    if (error && error.code !== '42703') throw error;
    return data || [];
  }

  async assignOrderToBuyer(orderNo, buyerId) {
    const { error } = await this.db.from('orders')
      .update({ b2b_buyer_id: buyerId })
      .eq('order_no', orderNo);
    if (error) throw error;
  }

  async bulkAssignOrders(orderNos, buyerId) {
    if (!orderNos?.length) return 0;
    const { data, error } = await this.db.from('orders')
      .update({ b2b_buyer_id: buyerId })
      .in('order_no', orderNos)
      .select('order_no');
    if (error) throw error;
    return (data || []).length;
  }

  async getNextBuyerId() {
    const { data } = await this.db
      .from('b2b_buyers')
      .select('buyer_id')
      .order('buyer_id', { ascending: false })
      .limit(1);

    if (!data || data.length === 0) return 'B001';
    const last = parseInt(data[0].buyer_id.replace('B', '')) || 0;
    return `B${String(last + 1).padStart(3, '0')}`;
  }

  // ─── Invoices ───

  async getInvoices({ includeVoided = false } = {}) {
    let q = this.db
      .from('b2b_invoices')
      .select('*')
      .order('invoice_date', { ascending: false });
    if (!includeVoided) q = q.is('voided_at', null);
    const { data, error } = await q;
    if (error && error.code !== '42703') throw error; // column missing = migration not applied
    return (data || []).map(this._toInvoiceFormat);
  }

  async getInvoicesByBuyer(buyerId, { includeVoided = false } = {}) {
    let q = this.db
      .from('b2b_invoices')
      .select('*')
      .eq('buyer_id', buyerId)
      .order('invoice_date', { ascending: false });
    if (!includeVoided) q = q.is('voided_at', null);
    const { data, error } = await q;
    if (error && error.code !== '42703') throw error;
    return (data || []).map(this._toInvoiceFormat);
  }

  async voidInvoice(invoiceNo, { userId, reason }) {
    const { data, error } = await this.db
      .from('b2b_invoices')
      .update({
        voided_at: new Date().toISOString(),
        voided_by: userId || null,
        void_reason: reason || null,
      })
      .eq('invoice_no', invoiceNo)
      .is('voided_at', null)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async createInvoice(invoice) {
    const row = {
      invoice_no: invoice.InvoiceNo || invoice.invoiceNo,
      buyer_id: invoice.BuyerID || invoice.buyerId,
      buyer_name: invoice.BuyerName || invoice.buyerName || '',
      invoice_date: invoice.Date || invoice.date || new Date().toISOString().split('T')[0],
      due_date: invoice.DueDate || invoice.dueDate || null,
      items: typeof invoice.Items === 'string' ? JSON.parse(invoice.Items) : (invoice.Items || invoice.items || []),
      subtotal: parseFloat(invoice.Subtotal || invoice.subtotal) || 0,
      tax: parseFloat(invoice.Tax || invoice.tax) || 0,
      shipping: parseFloat(invoice.Shipping || invoice.shipping) || 0,
      total: parseFloat(invoice.Total || invoice.total) || 0,
      currency: invoice.Currency || invoice.currency || 'USD',
      status: invoice.Status || invoice.status || 'CREATED',
      doc_type: (invoice.DocType || invoice.docType || 'INVOICE').toUpperCase(),
      is_manual: !!(invoice.IsManual || invoice.isManual),
      original_file_path: invoice.OriginalFilePath || invoice.originalFilePath || null,
      original_mime_type: invoice.OriginalMimeType || invoice.originalMimeType || null,
      drive_file_id: invoice.DriveFileId || invoice.driveFileId || '',
      drive_url: invoice.DriveUrl || invoice.driveUrl || '',
      sent_via: invoice.SentVia || invoice.sentVia || '',
      sent_at: invoice.SentAt || invoice.sentAt || null,
    };

    const upsert = async (payload) => this.db
      .from('b2b_invoices')
      .upsert(payload, { onConflict: 'invoice_no' })
      .select();

    let { data, error } = await upsert(row);
    if (error && error.code === '42703') {
      // 구버전 DB 호환 — 신규 컬럼 하나씩 제거해 재시도
      const fallback = { ...row };
      for (const col of ['is_manual', 'original_file_path', 'original_mime_type', 'doc_type']) {
        if (new RegExp(col).test(error.message || '')) delete fallback[col];
      }
      const r2 = await upsert(fallback);
      if (r2.error) throw r2.error;
      return r2.data?.[0];
    }
    if (error) throw error;
    return data?.[0];
  }

  async updateInvoiceStatus(invoiceNo, status) {
    const { error } = await this.db
      .from('b2b_invoices')
      .update({ status })
      .eq('invoice_no', invoiceNo);
    if (error) throw error;
  }

  async getNextInvoiceNo() {
    const year = new Date().getFullYear();
    const { data } = await this.db
      .from('b2b_invoices')
      .select('invoice_no')
      .like('invoice_no', `INV-${year}-%`)
      .order('invoice_no', { ascending: false })
      .limit(1);

    if (!data || data.length === 0) return `INV-${year}-0001`;
    const last = parseInt(data[0].invoice_no.split('-').pop()) || 0;
    return `INV-${year}-${String(last + 1).padStart(4, '0')}`;
  }

  // Revenue summary (for B2B analytics) — voided 제외
  async getRevenueSummary() {
    const { data, error } = await this.db
      .from('b2b_invoices')
      .select('buyer_id, buyer_name, total, currency, status, voided_at, doc_type, invoice_no')
      .is('voided_at', null);
    if (error && error.code !== '42703') throw error;

    let totalUSD = 0, totalKRW = 0;
    const buyerMap = {};

    (data || []).forEach(inv => {
      // 견적서는 매출 집계 제외
      const docType = (inv.doc_type || (inv.invoice_no && inv.invoice_no.startsWith('Q-') ? 'QUOTE' : 'INVOICE')).toUpperCase();
      if (docType === 'QUOTE') return;
      const amount = parseFloat(inv.total) || 0;
      if (inv.currency === 'KRW') totalKRW += amount;
      else totalUSD += amount;

      if (!buyerMap[inv.buyer_id]) {
        buyerMap[inv.buyer_id] = { name: inv.buyer_name, orders: 0, revenue: 0, currency: inv.currency };
      }
      buyerMap[inv.buyer_id].orders++;
      buyerMap[inv.buyer_id].revenue += amount;
    });

    const ranking = Object.values(buyerMap)
      .sort((a, b) => b.revenue - a.revenue);

    return { totalUSD, totalKRW, invoiceCount: data?.length || 0, buyerCount: Object.keys(buyerMap).length, ranking };
  }

  // ─── Payments (Phase C) ───

  async recordPayment({ invoiceNo, paidAt, amount, method, note, userId }) {
    // 1. b2b_payments insert
    const { data: pay, error: payErr } = await this.db
      .from('b2b_payments')
      .insert({
        invoice_no: invoiceNo,
        paid_at: paidAt || new Date().toISOString().slice(0, 10),
        amount,
        method: method || null,
        note: note || null,
        created_by: userId || null,
      })
      .select()
      .single();
    if (payErr) throw payErr;

    // 2. invoice.paid_amount 누적 + payment_status 재계산
    const { data: inv, error: invErr } = await this.db
      .from('b2b_invoices')
      .select('paid_amount, total')
      .eq('invoice_no', invoiceNo)
      .single();
    if (invErr) throw invErr;

    const newPaid = (Number(inv.paid_amount) || 0) + Number(amount);
    const total = Number(inv.total) || 0;
    let paymentStatus = 'UNPAID';
    if (newPaid >= total && total > 0) paymentStatus = 'PAID';
    else if (newPaid > 0) paymentStatus = 'PARTIAL';

    const updates = { paid_amount: newPaid, payment_status: paymentStatus };
    if (paymentStatus === 'PAID') updates.status = 'PAID';
    const { error: updErr } = await this.db
      .from('b2b_invoices')
      .update(updates)
      .eq('invoice_no', invoiceNo);
    if (updErr) throw updErr;

    return { payment: pay, paidAmount: newPaid, paymentStatus };
  }

  async listPayments(invoiceNo) {
    const { data, error } = await this.db
      .from('b2b_payments')
      .select('*')
      .eq('invoice_no', invoiceNo)
      .order('paid_at', { ascending: false })
      .order('id', { ascending: false });
    if (error && error.code !== '42P01') throw error;
    return (data || []).map(r => ({
      id: r.id,
      invoiceNo: r.invoice_no,
      paidAt: r.paid_at,
      amount: parseFloat(r.amount),
      method: r.method,
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  async getInvoicePaymentInfo(invoiceNos) {
    // 여러 인보이스의 payment_status + paid_amount 한 번에 조회
    if (!Array.isArray(invoiceNos) || invoiceNos.length === 0) return {};
    const { data, error } = await this.db
      .from('b2b_invoices')
      .select('invoice_no, paid_amount, payment_status, total, due_date')
      .in('invoice_no', invoiceNos);
    if (error && error.code !== '42703') throw error;
    const out = {};
    for (const r of data || []) {
      out[r.invoice_no] = {
        paidAmount: parseFloat(r.paid_amount) || 0,
        paymentStatus: r.payment_status || 'UNPAID',
        total: parseFloat(r.total) || 0,
        dueDate: r.due_date,
      };
    }
    return out;
  }

  // ─── Shipments (Phase B) ───

  async createShipment({ invoiceNo, shippedAt, carrier, trackingNumber, items, notes, userId }) {
    const { data, error } = await this.db
      .from('b2b_shipments')
      .insert({
        invoice_no: invoiceNo,
        shipped_at: shippedAt || new Date().toISOString().slice(0, 10),
        carrier: carrier || 'FedEx',
        tracking_number: trackingNumber,
        items,
        notes: notes || null,
        created_by: userId || null,
      })
      .select()
      .single();
    if (error) throw error;
    return this._toShipmentFormat(data);
  }

  async listShipmentsByInvoice(invoiceNo) {
    const { data, error } = await this.db
      .from('b2b_shipments')
      .select('*')
      .eq('invoice_no', invoiceNo)
      .order('shipped_at', { ascending: false })
      .order('id', { ascending: false });
    if (error && error.code !== '42P01') throw error;
    return (data || []).map(this._toShipmentFormat);
  }

  async deleteShipment(id) {
    const { error } = await this.db.from('b2b_shipments').delete().eq('id', id);
    if (error) throw error;
  }

  async updateShipment(id, patch) {
    const update = {};
    if (patch.shippedAt !== undefined) update.shipped_at = patch.shippedAt || new Date().toISOString().slice(0, 10);
    if (patch.carrier !== undefined) update.carrier = String(patch.carrier || '').slice(0, 40) || 'FedEx';
    if (patch.trackingNumber !== undefined) update.tracking_number = String(patch.trackingNumber || '').trim().slice(0, 100);
    if (patch.notes !== undefined) update.notes = patch.notes ? String(patch.notes).trim().slice(0, 500) : null;
    if (Array.isArray(patch.items)) update.items = patch.items;
    if (Object.keys(update).length === 0) throw new Error('변경할 내용이 없습니다');
    const { data, error } = await this.db.from('b2b_shipments').update(update).eq('id', id).select().single();
    if (error) throw error;
    return this._toShipmentFormat(data);
  }

  async listShipmentsByDate(date) {
    const { data, error } = await this.db
      .from('b2b_shipments')
      .select('*')
      .eq('shipped_at', date)
      .order('id', { ascending: false });
    if (error && error.code !== '42P01') throw error;
    return (data || []).map(this._toShipmentFormat);
  }

  async listAllShipments() {
    const { data, error } = await this.db
      .from('b2b_shipments')
      .select('*');
    if (error && error.code !== '42P01') throw error;
    return (data || []).map(this._toShipmentFormat);
  }

  _toShipmentFormat(r) {
    return {
      id: r.id,
      invoiceNo: r.invoice_no,
      shippedAt: r.shipped_at,
      carrier: r.carrier,
      trackingNumber: r.tracking_number,
      items: Array.isArray(r.items) ? r.items : [],
      notes: r.notes,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }

  _toInvoiceFormat(r) {
    return {
      InvoiceNo: r.invoice_no,
      BuyerID: r.buyer_id,
      BuyerName: r.buyer_name,
      Date: r.invoice_date,
      DueDate: r.due_date,
      Items: r.items,
      Subtotal: r.subtotal,
      Tax: r.tax,
      Shipping: r.shipping,
      Total: r.total,
      Currency: r.currency,
      Status: r.status,
      DocType: r.doc_type || (r.invoice_no && r.invoice_no.startsWith('Q-') ? 'QUOTE' : 'INVOICE'),
      IsManual: !!r.is_manual,
      OriginalFilePath: r.original_file_path || null,
      OriginalMimeType: r.original_mime_type || null,
      DriveFileId: r.drive_file_id,
      DriveUrl: r.drive_url,
      SentVia: r.sent_via,
      SentAt: r.sent_at,
      VoidedAt: r.voided_at || null,
      VoidedBy: r.voided_by || null,
      VoidReason: r.void_reason || null,
    };
  }
}

module.exports = B2BRepository;
