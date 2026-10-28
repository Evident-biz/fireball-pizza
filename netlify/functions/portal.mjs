// Customer portal API. No accounts or passwords:
//   - Every order has a private token. /my-order/?id=FB-XXXX&t=<token> shows that one order.
//   - "Find my orders" emails a sign-in link (valid 24 hours) listing every order for that email.
//
// Routes:
//   GET  /api/portal/order?id=&t=          one order, customer-safe view
//   POST /api/portal/order/message         { id, t, message }  change request / question to staff
//   POST /api/portal/order/pay             { id, t }  Square link for the deposit (or balance)
//   POST /api/portal/lookup                { email }  emails a sign-in link if that email has orders
//   GET  /api/portal/orders?m=<token>      every order for the signed-in email

import { crmStore, getOrder, updateOrder, orderIdsForEmail } from '../lib/store.mjs';
import { customerView, logActivity } from '../lib/orders.mjs';
import { amountToCollect, createLinkForOrder } from '../lib/deposit.mjs';
import { SquareConfigError } from '../lib/square.mjs';
import { sendEmail, layout, firstName, portalUrl, staffNotifyAddress, formatDate } from '../lib/email.mjs';
import { json, errorResponse, readJson, HttpError, str, isEmail, normalizeEmail, newToken, newNoteId, safeEqual, sha256, siteUrl } from '../lib/util.mjs';

const MAGIC_LINK_HOURS = 24;
const LOOKUP_COOLDOWN_MS = 2 * 60 * 1000;

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/portal/, '').replace(/\/$/, '');
  const store = crmStore(context);
  try {
    if (req.method === 'GET' && route === '/order') {
      const order = await authorizedOrder(store, url.searchParams.get('id'), url.searchParams.get('t'));
      return json({ order: customerView(order), portalUrl: portalUrl(siteUrl(req), order) });
    }
    if (req.method === 'POST' && route === '/order/message') return await postMessage(store, req);
    if (req.method === 'POST' && route === '/order/pay') return await payLink(store, req);
    if (req.method === 'POST' && route === '/lookup') return await lookup(store, req);
    if (req.method === 'GET' && route === '/orders') return await ordersForMagicLink(store, url.searchParams.get('m'), siteUrl(req));
    return errorResponse(404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message);
    console.error('Fireball portal error', route, err);
    return errorResponse(500, 'Something went wrong. Please call us at (209) 222-8926.');
  }
};

async function authorizedOrder(store, id, token) {
  const found = await getOrder(store, str(id, 20));
  // Same response for "no such order" and "wrong token" so ids can't be probed.
  if (!found || !found.order.portalToken || !safeEqual(found.order.portalToken, str(token, 100))) {
    throw new HttpError(404, "We couldn't find that order. Check the link in your email, or call us.");
  }
  return found.order;
}

async function postMessage(store, req) {
  const body = await readJson(req);
  const order = await authorizedOrder(store, body.id, body.t);
  const message = str(body.message, 3000);
  if (message.length < 2) throw new HttpError(400, 'Please type a message');
  const recent = order.notes.filter((n) => n.fromCustomer && Date.now() - Date.parse(n.at) < 60 * 60 * 1000);
  if (recent.length >= 5) throw new HttpError(429, "You've sent several messages in the last hour. We'll get back to you soon, or call us at (209) 222-8926.");

  const updated = await updateOrder(store, order.id, (o) => {
    o.notes.push({ id: newNoteId(), at: new Date().toISOString(), by: o.customer.name || 'Customer', text: message, fromCustomer: true });
    o.flags.customerMessage = true;
    logActivity(o, 'Customer', 'Sent a message from the order page');
  });

  await sendEmail({
    to: staffNotifyAddress(),
    replyTo: updated.customer.email,
    subject: 'Customer message: ' + updated.customer.name + ' (' + updated.id + ')',
    html: layout({
      paragraphs: [updated.customer.name + ' sent a message from their order page:', message],
      rows: [
        ['Order', updated.id],
        ['Event date', formatDate(updated.event.date)],
        ['Phone', updated.customer.phone],
        ['Email', updated.customer.email],
      ],
      button: { label: 'Open in staff portal', url: siteUrl(req) + '/admin/#/orders/' + updated.id },
    }),
  });
  return json({ ok: true, order: customerView(updated) });
}

async function payLink(store, req) {
  const body = await readJson(req);
  const order = await authorizedOrder(store, body.id, body.t);
  const due = amountToCollect(order);
  if (!due) {
    throw new HttpError(400, 'There is nothing to pay online for this order right now.');
  }
  try {
    const link = await createLinkForOrder(store, order.id, { amount: due.amount, kind: due.kind, by: 'Customer' });
    return json({ url: link.url, amount: due.amount, kind: due.kind });
  } catch (err) {
    if (err instanceof SquareConfigError) throw new HttpError(503, err.message);
    throw new HttpError(502, 'Could not open the payment page. Please call us at (209) 222-8926.');
  }
}

async function lookup(store, req) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address');

  // Always answer the same way so this can't be used to find out who has ordered from us.
  const answer = json({ ok: true, message: 'If we have orders under that email, a sign-in link is on its way. It works for 24 hours.' });

  const throttleKey = 'throttle/lookup/' + sha256(email);
  const last = await store.get(throttleKey);
  if (last && Date.now() - Number(last) < LOOKUP_COOLDOWN_MS) return answer;
  await store.set(throttleKey, String(Date.now()));

  const ids = await orderIdsForEmail(store, email);
  if (!ids.length) return answer;

  const token = newToken(32);
  await store.setJSON('magic/' + token, { email, expires: Date.now() + MAGIC_LINK_HOURS * 3600 * 1000 });
  const first = await getOrder(store, ids[0]);
  await sendEmail({
    to: email,
    subject: 'Your Fireball Pizza orders',
    html: layout({
      greeting: 'Hi ' + firstName(first?.order.customer.name) + ',',
      paragraphs: ['Here is your link to see all of your Fireball Pizza orders. It works for the next 24 hours.'],
      button: { label: 'View my orders', url: siteUrl(req) + '/my-orders/?m=' + encodeURIComponent(token) },
      footerNote: "Didn't ask for this? You can ignore this email. Nobody can see your orders without this link.",
    }),
  });
  return answer;
}

async function ordersForMagicLink(store, token, base) {
  token = str(token, 100);
  const session = token ? await store.get('magic/' + token, { type: 'json' }) : null;
  if (!session || session.expires < Date.now()) {
    if (session) await store.delete('magic/' + token);
    throw new HttpError(401, 'This link has expired. Enter your email again and we will send a new one.');
  }
  const ids = await orderIdsForEmail(store, session.email);
  const found = await Promise.all(ids.map((id) => getOrder(store, id)));
  const orders = found
    .filter(Boolean)
    .map((f) => f.order)
    // The email index can lag behind an email change; only show orders that still match.
    .filter((o) => o.customer.email.toLowerCase() === session.email)
    .sort((a, b) => (b.event.date || b.createdAt).localeCompare(a.event.date || a.createdAt))
    .map((o) => ({ ...customerView(o), portalUrl: portalUrl(base, o) }));
  return json({ email: session.email, orders });
}

export const config = { path: '/api/portal/*' };
