// Resend email sending plus the shared Fireball email layout.
// RESEND_API_KEY stays on the server. A missing key logs and skips instead of failing the request.

import { escapeHtml } from './util.mjs';

export const FROM = 'Fireball Pizza <eat@fireball.pizza>';
export const REPLY_TO = 'eat@fireball.pizza';

export function staffNotifyAddress() {
  return process.env.STAFF_NOTIFY_EMAIL || 'eat@fireball.pizza';
}

export async function sendEmail({ to, subject, html, replyTo = REPLY_TO }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('Fireball email: missing RESEND_API_KEY, skipped "' + subject + '"');
    return { sent: false, skipped: true };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], reply_to: replyTo, subject, html }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Fireball email: Resend API error', response.status, JSON.stringify(data));
      return { sent: false, error: data };
    }
    return { sent: true, id: data.id };
  } catch (err) {
    console.error('Fireball email: send failed', err);
    return { sent: false };
  }
}

// rows: [[label, value], ...]  button: { label, url }
export function layout({ greeting, paragraphs = [], rows = [], button, footerNote }) {
  const rowsHtml = rows
    .filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== '')
    .map(
      (r) =>
        '<tr><td style="padding:6px 0; color:#6E655C; font-size:14px;">' + escapeHtml(r[0]) + '</td>' +
        '<td style="padding:6px 0; text-align:right; font-weight:600; color:#1B1512; font-size:14px;">' + escapeHtml(r[1]) + '</td></tr>'
    )
    .join('');
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#1B1512;">' +
    '<h2 style="color:#E23A25; margin-bottom:4px;">Fireball Pizza</h2>' +
    (greeting ? '<p style="font-size:16px;">' + escapeHtml(greeting) + '</p>' : '') +
    paragraphs.map((p) => '<p style="font-size:15px; line-height:1.5;">' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('') +
    (rowsHtml ? '<table style="width:100%; border-collapse:collapse; margin:20px 0; border-top:1px solid #ECE7DF; border-bottom:1px solid #ECE7DF;">' + rowsHtml + '</table>' : '') +
    (button
      ? '<p style="margin:24px 0;"><a href="' + escapeHtml(button.url) + '" style="background:#E23A25; color:#fff; text-decoration:none; padding:12px 20px; border-radius:6px; font-weight:600; display:inline-block;">' + escapeHtml(button.label) + '</a></p>'
      : '') +
    (footerNote ? '<p style="font-size:14px; color:#6E655C; line-height:1.5;">' + escapeHtml(footerNote) + '</p>' : '') +
    '<p style="font-size:14px; color:#6E655C; line-height:1.5;">Questions? Just reply to this email or call us at (209) 222-8926.</p>' +
    '<p style="font-size:13px; color:#6E655C; margin-top:32px;">Fireball Pizza &middot; Modesto, CA</p>' +
    '</div>'
  );
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

export function formatMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function portalUrl(base, order) {
  return base + '/my-order/?id=' + encodeURIComponent(order.id) + '&t=' + encodeURIComponent(order.portalToken);
}
