// Creates a Square Payment Link for an exact deposit amount, server-side.
// Keeps SQUARE_ACCESS_TOKEN safely on the server. It never reaches the browser.
//
// When the catering builder passes its order id and portal token, the link is recorded on
// that order so the Square webhook can mark the deposit paid automatically.

import { createPaymentLink, SquareConfigError } from '../lib/square.mjs';
import { crmStore, getOrder } from '../lib/store.mjs';
import { recordLink } from '../lib/deposit.mjs';
import { json, errorResponse, safeEqual } from '../lib/util.mjs';

export default async (req, context) => {
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let payload;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'Invalid request body');
  }

  const { amount, description, referenceId, orderId, orderToken } = payload || {};

  // amount is expected as whole/decimal dollars (e.g. 238.00), converted to cents in createPaymentLink.
  const amountNumber = Number(amount);
  if (!amountNumber || amountNumber <= 0 || !isFinite(amountNumber)) {
    return errorResponse(400, 'A valid positive amount is required');
  }

  try {
    const link = await createPaymentLink({ amount: amountNumber, description, referenceId });

    // Linking to the order is best effort. The customer gets their payment page either way.
    if (orderId && orderToken) {
      try {
        const store = crmStore(context);
        const found = await getOrder(store, orderId);
        if (found && safeEqual(found.order.portalToken, orderToken)) {
          await recordLink(store, orderId, link, { amount: amountNumber, kind: 'deposit', by: 'Website' });
        }
      } catch (err) {
        console.error('Fireball deposit link: could not record link on order', orderId, err);
      }
    }

    return json({ url: link.url, id: link.id });
  } catch (err) {
    if (err instanceof SquareConfigError) return errorResponse(500, err.message);
    console.error('Fireball deposit link: function error', err);
    return errorResponse(502, err.message || 'Something went wrong creating the payment link.');
  }
};
