// Square helpers: payment link creation and webhook signature checks.
// SQUARE_ACCESS_TOKEN never leaves the server.

import { createHmac } from 'node:crypto';
import { safeEqual } from './util.mjs';

const SANDBOX_BASE = 'https://connect.squareupsandbox.com';
const PRODUCTION_BASE = 'https://connect.squareup.com';
const SQUARE_API_VERSION = '2026-07-15';

export class SquareConfigError extends Error {}

// Returns { url, id, squareOrderId }. Throws SquareConfigError when Square isn't set up,
// or a plain Error with Square's message when the API refuses.
export async function createPaymentLink({ amount, description, referenceId }) {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  const environment = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
  if (!accessToken || !locationId) {
    console.error('Fireball deposit link: missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID');
    throw new SquareConfigError('Payment system is not configured yet. Please contact us directly to pay your deposit.');
  }

  const baseUrl = environment === 'production' ? PRODUCTION_BASE : SANDBOX_BASE;
  const amountCents = Math.round(Number(amount) * 100);
  const idempotencyKey =
    (referenceId ? String(referenceId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 30) + '-' : '') +
    Date.now() +
    '-' +
    Math.random().toString(36).slice(2, 10);

  const response = await fetch(baseUrl + '/v2/online-checkout/payment-links', {
    method: 'POST',
    headers: {
      'Square-Version': SQUARE_API_VERSION,
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      quick_pay: {
        name: description || 'Fireball Pizza Catering Deposit',
        price_money: { amount: amountCents, currency: 'USD' },
        location_id: locationId,
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.payment_link) {
    console.error('Fireball deposit link: Square API error', response.status, JSON.stringify(data));
    throw new Error((data.errors && data.errors[0] && data.errors[0].detail) || 'Could not create payment link');
  }
  return { url: data.payment_link.url, id: data.payment_link.id, squareOrderId: data.payment_link.order_id || '' };
}

// Square signs base64(HMAC-SHA256(signatureKey, notificationUrl + rawBody)).
export function verifySquareSignature({ signatureKey, notificationUrl, rawBody, signature }) {
  if (!signatureKey || !signature) return false;
  const expected = createHmac('sha256', signatureKey).update(notificationUrl + rawBody).digest('base64');
  return safeEqual(expected, signature);
}
