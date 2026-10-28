// Creates a Square deposit link for an order and records it, so the Square webhook
// can match the payment back to the order and mark the deposit paid.

import { createPaymentLink } from './square.mjs';
import { updateOrder, setRef } from './store.mjs';
import { logActivity } from './orders.mjs';
import { formatMoney } from './email.mjs';

export { amountToCollect } from './orders.mjs';

export async function createLinkForOrder(store, orderId, { amount, kind = 'deposit', by }) {
  const description = (kind === 'balance' ? 'Fireball Pizza Catering Balance ' : 'Fireball Pizza Catering Deposit ') + orderId;
  const link = await createPaymentLink({ amount, description, referenceId: orderId });
  await recordLink(store, orderId, link, { amount, kind, by });
  return link;
}

export async function recordLink(store, orderId, link, { amount, kind = 'deposit', by }) {
  if (link.squareOrderId) await setRef(store, 'sq', link.squareOrderId, orderId);
  await updateOrder(store, orderId, (order) => {
    order.payment.depositLinkUrl = link.url;
    if (link.squareOrderId && !order.payment.squareOrderIds.includes(link.squareOrderId)) order.payment.squareOrderIds.push(link.squareOrderId);
    logActivity(order, by, 'Payment link created', (kind === 'balance' ? 'Balance ' : 'Deposit ') + formatMoney(amount));
  });
}
