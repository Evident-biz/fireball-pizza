// Square webhook: when a payment made through one of our payment links completes,
// record it on the matching order and mark the order booked.
//
// Setup (Square Developer Dashboard > Webhooks > Add subscription):
//   URL:    https://fireball.pizza/api/square/webhook
//   Events: payment.created, payment.updated
// Then copy the subscription's signature key into SQUARE_WEBHOOK_SIGNATURE_KEY.

import { verifySquareSignature } from '../lib/square.mjs';
import { crmStore, updateOrder, lookupRef } from '../lib/store.mjs';
import { addPayment, logActivity, paidTotal, balanceDue } from '../lib/orders.mjs';
import { sendEmail, layout, firstName, formatMoney, formatDate, portalUrl, staffNotifyAddress } from '../lib/email.mjs';
import { checkDate } from '../lib/availability.mjs';
import { json, errorResponse, siteUrl } from '../lib/util.mjs';

const PAYMENT_METHOD_BY_SOURCE = { CARD: 'card', BUY_NOW_PAY_LATER: 'afterpay', CASH: 'cash', WALLET: 'card' };

export default async (req, context) => {
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  const rawBody = await req.text();
  const notificationUrl = process.env.SQUARE_WEBHOOK_URL || siteUrl(req) + '/api/square/webhook';
  const valid = verifySquareSignature({
    signatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
    notificationUrl,
    rawBody,
    signature: req.headers.get('x-square-hmacsha256-signature'),
  });
  if (!valid) {
    console.error('Fireball Square webhook: signature check failed. Check SQUARE_WEBHOOK_SIGNATURE_KEY and SQUARE_WEBHOOK_URL.');
    return errorResponse(403, 'Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, 'Invalid body');
  }

  const payment = event?.data?.object?.payment;
  if (!payment || !['payment.created', 'payment.updated'].includes(event.type)) return json({ ignored: true });
  if (payment.status !== 'COMPLETED') return json({ ignored: 'status ' + payment.status });
  if (!payment.order_id) return json({ ignored: 'no order' });

  const store = crmStore(context);
  const orderId = await lookupRef(store, 'sq', payment.order_id);
  if (!orderId) {
    // A payment for something we didn't create a link for (in-person sale, static link). Not ours to track.
    return json({ ignored: 'unknown order' });
  }

  const amount = ((payment.amount_money?.amount || 0) + (payment.tip_money?.amount || 0)) / 100;
  let recorded = false;
  let wasFirstPayment = false;
  let conflict = '';
  const order = await updateOrder(store, orderId, async (o) => {
    wasFirstPayment = paidTotal(o) === 0;
    recorded = addPayment(o, {
      amount,
      method: PAYMENT_METHOD_BY_SOURCE[payment.source_type] || 'card',
      note: 'Square payment ' + payment.id,
      at: payment.created_at,
      squarePaymentId: payment.id,
      by: 'Square',
    });
    // Square sends created and updated events for the same payment. Only the first one counts.
    if (!recorded) return false;
    logActivity(o, 'Square', 'Payment received', formatMoney(amount) + ' via ' + (payment.source_type || 'card').toLowerCase());
    if (['lead', 'pending_deposit', 'reserved', 'date_check'].includes(o.status)) {
      // A date that breaks a rule waits for staff instead of being booked automatically.
      // Reserved orders already hold their date (and may be on Google Calendar), so they aren't re-checked.
      const check = o.status === 'reserved' ? null : await checkDate(store, o.event.date, o.event.guestCount, o.id).catch(() => null);
      conflict = check && !check.available ? check.message : '';
      if (conflict || o.status === 'date_check') {
        if (check && !check.available) o.flags.dateUnavailable = check.code;
        o.status = 'date_check';
        logActivity(o, 'Square', 'Status changed', 'Date to Confirm (deposit paid, date needs checking)');
      } else {
        o.status = 'booked';
        logActivity(o, 'Square', 'Status changed', 'Booked (deposit paid)');
      }
    }
  });

  if (recorded && order) await notify(order, amount, wasFirstPayment, siteUrl(req), conflict);
  return json({ ok: true, recorded });
};

async function notify(order, amount, wasFirstPayment, base, conflict) {
  const balance = balanceDue(order);
  const needsConfirming = order.status === 'date_check';
  const rows = [
    ['Order', order.id],
    ['Event date', formatDate(order.event.date)],
    ['Start time', order.event.time],
    ['Guest count', order.event.guestCount ? String(order.event.guestCount) : ''],
    ['Amount paid', formatMoney(amount)],
    ['Balance remaining', balance !== null ? formatMoney(balance) : ''],
  ];
  await Promise.all([
    sendEmail({
      to: order.customer.email,
      subject: needsConfirming
        ? 'We received your Fireball Pizza deposit'
        : wasFirstPayment ? 'Your Fireball Pizza catering deposit is confirmed' : 'Payment received for your Fireball Pizza order',
      html: layout({
        greeting: 'Hi ' + firstName(order.customer.name) + ',',
        paragraphs: [
          needsConfirming
            ? "Thanks, we received your deposit. We need to double-check our schedule for your date, and we'll confirm with you within 1 to 2 business days."
            : wasFirstPayment ? 'We received your deposit and your date is officially booked.' : 'Thanks, we received your payment.',
        ],
        rows,
        button: { label: 'View your order', url: portalUrl(base, order) },
        footerNote: "We'll follow up with any final details before your event.",
      }),
    }),
    sendEmail({
      to: staffNotifyAddress(),
      subject: (needsConfirming ? 'CONFIRM DATE, ' : '') + 'Payment received: ' + order.customer.name + ' ' + formatMoney(amount) + ' (' + order.id + ')',
      html: layout({
        paragraphs: [
          'A Square payment was matched to a catering order and recorded automatically.',
          ...(needsConfirming ? ['This date needs confirming before it counts as booked: ' + (conflict || 'it was flagged when the customer booked.') + ' Check the calendar, call the customer, then set the order to Booked or offer another date.'] : []),
        ],
        rows: [['Customer', order.customer.name], ...rows],
        button: { label: 'Open in staff portal', url: base + '/admin/#/orders/' + order.id },
      }),
    }),
  ]);
}

export const config = { path: '/api/square/webhook' };
