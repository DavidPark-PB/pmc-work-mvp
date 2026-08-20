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
      payment_terms: buyer.PaymentTerms || buyer.paymentTerms || 'Net 30',
      notes: buyer.Notes || buyer.notes || '',
      total_orders: parseInt(buyer.TotalOrders || buyer.totalOrders) || 0,
      total_revenue: parseFloat(buyer.TotalRevenue || buyer.totalRevenue) || 0,
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

    const { error } = await this.db
      .from('b2b_buyers')
      .update(dbUpdates)
      .eq('buyer_id', buyerId);
    if (error) throw error;
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

  async getInvoices() {
    const { data, error } = await this.db
      .from('b2b_invoices')
      .select('*')
      .order('invoice_date', { ascending: false });
    if (error) throw error;

    return (data || []).map(this._toInvoiceFormat);
  }

  async getInvoicesByBuyer(buyerId) {
    const { data, error } = await this.db
      .from('b2b_invoices')
      .select('*')
      .eq('buyer_id', buyerId)
      .order('invoice_date', { ascending: false });
    if (error) throw error;
    return (data || []).map(this._toInvoiceFormat);
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
      drive_file_id: invoice.DriveFileId || invoice.driveFileId || '',
      drive_url: invoice.DriveUrl || invoice.driveUrl || '',
      sent_via: invoice.SentVia || invoice.sentVia || '',
      sent_at: invoice.SentAt || invoice.sentAt || null,
    };

    const { data, error } = await this.db
      .from('b2b_invoices')
      .upsert(row, { onConflict: 'invoice_no' })
      .select();
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

  // Revenue summary (for B2B analytics)
  async getRevenueSummary() {
    const { data, error } = await this.db
      .from('b2b_invoices')
      .select('buyer_id, buyer_name, total, currency, status');
    if (error) throw error;

    let totalUSD = 0, totalKRW = 0;
    const buyerMap = {};

    (data || []).forEach(inv => {
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
      DriveFileId: r.drive_file_id,
      DriveUrl: r.drive_url,
      SentVia: r.sent_via,
      SentAt: r.sent_at,
    };
  }
}

module.exports = B2BRepository;
