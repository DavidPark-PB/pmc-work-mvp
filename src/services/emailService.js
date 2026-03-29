/**
 * Email Service — Transactional email via Resend API
 *
 * Setup: Get API key at https://resend.com → config/.env → RESEND_API_KEY
 * Free tier: 100 emails/day, 3000/month
 *
 * Used by: Sales Agent (cold email, follow-up), CS Agent (email replies),
 *          B2B Invoice delivery, Operations Agent (task notifications)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM || 'PMC Corporation <noreply@pmcorp.com>';

function isConfigured() {
  return !!RESEND_API_KEY;
}

/**
 * Send a single email via Resend API
 */
async function sendEmail({ to, subject, html, text, from, replyTo }) {
  if (!isConfigured()) {
    console.log('[Email] Not configured — skipping');
    return null;
  }

  try {
    const { Resend } = require('resend');
    const resend = new Resend(RESEND_API_KEY);

    const result = await resend.emails.send({
      from: from || FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: html || undefined,
      text: text || undefined,
      reply_to: replyTo || undefined,
    });

    if (result.error) {
      console.error('[Email] Send error:', result.error.message);
      return { success: false, error: result.error.message };
    }

    console.log('[Email] Sent to', to, '— ID:', result.data?.id);
    return { success: true, id: result.data?.id };
  } catch (e) {
    console.error('[Email] Error:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Send a CS reply email
 */
async function sendCSReply({ to, subject, body, replyTo }) {
  return sendEmail({
    to,
    subject: subject || 'RE: Your inquiry — PMC Corporation',
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${body.replace(/\n/g, '<br>')}</div>
<br><hr style="border:none;border-top:1px solid #eee">
<p style="font-size:12px;color:#999">PMC Corporation — K-POP, Character & Collectibles<br>www.pmcorp.com</p>`,
    text: body,
    replyTo,
  });
}

/**
 * Send a B2B cold email / follow-up
 */
async function sendB2BEmail({ to, subject, body, contactName }) {
  const greeting = contactName ? `Dear ${contactName},` : 'Hello,';
  return sendEmail({
    to,
    subject,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">
<p>${greeting}</p>
${body.replace(/\n/g, '<br>')}
<br>
<p>Best regards,<br><strong>PMC Corporation</strong><br>K-POP, Pokemon & Character Goods — Global Wholesale</p>
</div>`,
    text: `${greeting}\n\n${body}\n\nBest regards,\nPMC Corporation`,
  });
}

/**
 * Send a B2B invoice email with link
 */
async function sendInvoiceEmail({ to, contactName, invoiceNo, amount, currency, driveLink }) {
  return sendEmail({
    to,
    subject: `Invoice ${invoiceNo} — PMC Corporation`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">
<p>Dear ${contactName || 'Valued Customer'},</p>
<p>Please find attached your invoice <strong>${invoiceNo}</strong> for <strong>${currency} ${amount}</strong>.</p>
${driveLink ? `<p><a href="${driveLink}" style="color:#1a73e8">Download Invoice</a></p>` : ''}
<p>Payment terms: Net 30 days</p>
<br>
<p>Best regards,<br><strong>PMC Corporation</strong></p>
</div>`,
  });
}

module.exports = { sendEmail, sendCSReply, sendB2BEmail, sendInvoiceEmail, isConfigured };
