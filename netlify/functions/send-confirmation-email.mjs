// Sends a customer-facing confirmation email via Resend.
// Fires alongside the existing internal Netlify Forms notification (which only reaches Paul).
// Keeps RESEND_API_KEY safely on the server, never exposed to the browser.
//
// When the catering builder passes its order id and portal token, the email includes a
// "View your order" button that opens the customer's order page.
//
// The actual "deposit confirmed" email is sent by square-webhook.mjs once Square reports
// the payment. The 'deposit' type here goes out when the payment page opens, before
// anything has been paid, so it only says the booking is almost done.

import { crmStore, getOrder } from '../lib/store.mjs';
import { sendEmail, layout, firstName, formatDate, portalUrl } from '../lib/email.mjs';
import { json, errorResponse, isEmail, safeEqual, siteUrl } from '../lib/util.mjs';

const COPY = {
  quote: {
    subject: 'Your Fireball Pizza catering quote',
    intro: "Here's a copy of the quote you just built for your event.",
    status: "This is an estimate, not a confirmed booking yet. Your date isn't reserved until a deposit is paid or a reservation is locked in.",
  },
  deposit: {
    subject: 'Your Fireball Pizza catering booking is almost done',
    intro: 'Thanks for booking with us. Once your deposit payment goes through, your date is officially reserved and we will email you a confirmation.',
    status: "If the payment page didn't open or you closed it early, you can pay any time from your order page.",
  },
  reservation: {
    subject: 'Your Fireball Pizza catering date is reserved',
    intro: "Your date is reserved. We'll follow up to confirm payment arrangements.",
    status: "We'll be in touch within 1 to 2 business days to finalize payment details for your event.",
  },
};

export default async (req, context) => {
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let payload;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'Invalid request body');
  }

  const { type, name, email, eventDate, eventTime, address, guestCount, totalQuote, depositAmount, orderId, orderToken } = payload || {};

  if (!name || !isEmail(email)) return errorResponse(400, 'A valid name and email are required');
  const copy = COPY[type];
  if (!copy) return errorResponse(400, 'Unknown confirmation type');

  let button = null;
  let dateNote = '';
  if (orderId && orderToken) {
    try {
      const found = await getOrder(crmStore(context), orderId);
      if (found && safeEqual(found.order.portalToken, orderToken)) {
        button = { label: type === 'deposit' ? 'View or pay for your order' : 'View your order', url: portalUrl(siteUrl(req), found.order) };
        if (found.order.flags?.dateUnavailable && type !== 'quote') {
          dateNote = "We need to double-check our schedule for your date, and we'll confirm with you within 1 to 2 business days.";
        }
      }
    } catch (err) {
      console.error('Fireball confirmation email: order lookup failed', err);
    }
  }

  const html = layout({
    greeting: 'Hi ' + firstName(name) + ',',
    // A flagged reservation hasn't actually reserved anything yet, so don't say it has.
    paragraphs: dateNote
      ? (type === 'reservation'
        ? ['Thanks, we got your booking request.', dateNote + " Once it's confirmed, we'll send you a link for the deposit. Nothing has been charged."]
        : [copy.intro, dateNote])
      : [copy.intro],
    rows: [
      ['Event date', /^\d{4}-\d{2}-\d{2}$/.test(eventDate || '') ? formatDate(eventDate) : ''],
      ['Start time', eventTime],
      ['Event address', address],
      ['Guest count', guestCount ? String(guestCount) : ''],
      ['Total quote', totalQuote],
      ['Deposit amount', depositAmount],
    ],
    button,
    footerNote: copy.status,
  });

  // Don't fail the customer's booking flow over this. Problems are logged and reported as not sent.
  const subject = dateNote && type === 'reservation' ? 'We got your Fireball Pizza catering request' : copy.subject;
  const result = await sendEmail({ to: email, subject, html });
  return json(result.skipped ? { skipped: true } : { sent: !!result.sent, id: result.id });
};
