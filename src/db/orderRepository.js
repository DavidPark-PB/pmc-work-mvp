/**
 * Order Repository — Supabase replacement for 주문 배송 sheet operations
 */
const { getClient } = require('./supabaseClient');

class OrderRepository {
  get db() { return getClient(); }

  // Insert new orders (ON CONFLICT skip duplicates)
  async batchInsert(orders) {
    if (!orders.length) return { inserted: 0 };

    const rows = orders.map(o => ({
      order_date: o.orderDate || o.order_date || null,
      platform: o.platform || '',
      order_no: o.orderNo || o.order_no || '',
      sku: o.sku || '',
      title: o.title || '',
      quantity: parseInt(o.quantity) || 1,
      payment_amount: parseFloat(o.paymentAmount || o.payment_amount) || 0,
      currency: o.currency || 'USD',
      buyer_name: o.buyerName || o.buyer_name || '',
      country: o.country || '',
      carrier: o.carrier || '',
      tracking_no: o.trackingNo || o.tracking_no || '',
      status: o.status || 'NEW',
      street: o.street || '',
      city: o.city || '',
      province: o.province || '',
      zip_code: o.zipCode || o.zip_code || '',
      phone: o.phone || '',
      country_code: o.countryCode || o.country_code || '',
      email: o.email || '',
    }));

    const { data, error } = await this.db
      .from('orders')
      .upsert(rows, { onConflict: 'order_no', ignoreDuplicates: true })
      .select();
    if (error) throw error;
    return { inserted: data?.length || 0 };
  }

  // Get existing order numbers (for deduplication)
  async getExistingOrderNos() {
    const { data, error } = await this.db
      .from('orders')
      .select('order_no');
    if (error) throw error;
    return new Set((data || []).map(r => r.order_no));
  }

  // Recent orders (status: 'NEW' for awaiting shipment, null for all)
  async getRecent(limit = 50, status = null) {
    let query = this.db
      .from('orders')
      .select('*')
      .not('status', 'in', '("SHIPPED","COMPLETED","CANCELLED")')
      .order('order_date', { ascending: false })
      .limit(limit);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  // Get orders by status
  async getByStatus(status) {
    const { data, error } = await this.db
      .from('orders')
      .select('*')
      .eq('status', status)
      .order('order_date', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // Get order by order_no
  async getByOrderNo(orderNo) {
    const { data, error } = await this.db
      .from('orders')
      .select('*')
      .eq('order_no', orderNo)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  // Update carrier info
  async setCarrier(orderNo, carrier, trackingNo) {
    const updates = { carrier };
    if (trackingNo) updates.tracking_no = trackingNo;

    const { error } = await this.db
      .from('orders')
      .update(updates)
      .eq('order_no', orderNo);
    if (error) throw error;
  }

  // Update order status
  async updateStatus(orderNo, status) {
    const { error } = await this.db
      .from('orders')
      .update({ status })
      .eq('order_no', orderNo);
    if (error) throw error;
  }

  // Backfill shipping addresses
  async backfillAddress(orderNo, address) {
    const updates = {};
    if (address.street) updates.street = address.street;
    if (address.city) updates.city = address.city;
    if (address.province) updates.province = address.province;
    if (address.zipCode) updates.zip_code = address.zipCode;
    if (address.phone) updates.phone = address.phone;
    if (address.countryCode) updates.country_code = address.countryCode;
    if (address.email) updates.email = address.email;

    if (Object.keys(updates).length === 0) return;

    const { error } = await this.db
      .from('orders')
      .update(updates)
      .eq('order_no', orderNo);
    if (error) throw error;
  }

  // Orders needing address backfill
  async getOrdersWithoutAddress() {
    const { data, error } = await this.db
      .from('orders')
      .select('*')
      .or('street.is.null,street.eq.')
      .order('order_date', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // Count by platform (for dashboard)
  async countByPlatform(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await this.db
      .from('orders')
      .select('platform, quantity, payment_amount, currency')
      .gte('order_date', since.toISOString().split('T')[0]);
    if (error) throw error;

    const summary = {};
    (data || []).forEach(o => {
      if (!summary[o.platform]) summary[o.platform] = { count: 0, revenue: 0 };
      summary[o.platform].count += o.quantity || 1;
      summary[o.platform].revenue += parseFloat(o.payment_amount) || 0;
    });
    return summary;
  }
}

module.exports = OrderRepository;
