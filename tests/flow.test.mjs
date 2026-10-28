// End-to-end tests of the order system against a real local Blobs server.
// Run with: npm test

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startBlobs, fakeExternalApis, request, context, cateringPayload, uniqueWeekday, ORIGIN } from './helpers.mjs';

// Identity is faked: tests pick who is "signed in".
let currentUser = null;
mock.module('@netlify/identity', {
  namedExports: {
    getUser: async () => currentUser,
    getIdentityConfig: () => ({ url: 'https://identity.test', token: 'op' }),
    admin: {
      listUsers: async () => [
        { id: 'u1', email: 'owner@fireball.test', confirmedAt: '2026-01-01', roles: [] },
        { id: 'u2', email: 'cook@fireball.test', confirmedAt: '2026-01-01', roles: ['staff'], userMetadata: { full_name: 'Cook' } },
      ],
      getUser: async (id) => ({ id, email: 'cook@fireball.test', appMetadata: { roles: ['staff'] } }),
      updateUser: async () => ({}),
      deleteUser: async () => {},
    },
  },
});

const OWNER = { id: 'u1', email: 'owner@fireball.test', confirmedAt: '2026-01-01', name: 'Owner', roles: [] };
const STAFF = { id: 'u2', email: 'cook@fireball.test', confirmedAt: '2026-01-01', name: 'Cook', roles: ['staff'] };
const NOBODY = { id: 'u3', email: 'rando@else.test', confirmedAt: '2026-01-01', name: 'Rando', roles: [] };

let blobs, apis, leads, portal, adminApi, depositLink, webhook, confirmEmail, availability;

before(async () => {
  blobs = await startBlobs();
  apis = fakeExternalApis();
  process.env.RESEND_API_KEY = 'test';
  process.env.SQUARE_ACCESS_TOKEN = 'test';
  process.env.SQUARE_LOCATION_ID = 'loc';
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'sigkey';
  process.env.ADMIN_EMAILS = 'owner@fireball.test';
  process.env.URL = ORIGIN;
  leads = (await import('../netlify/functions/leads.mjs')).default;
  portal = (await import('../netlify/functions/portal.mjs')).default;
  adminApi = (await import('../netlify/functions/admin-api.mjs')).default;
  depositLink = (await import('../netlify/functions/create-deposit-link.mjs')).default;
  webhook = (await import('../netlify/functions/square-webhook.mjs')).default;
  confirmEmail = (await import('../netlify/functions/send-confirmation-email.mjs')).default;
  availability = (await import('../netlify/functions/availability.mjs')).default;
});

after(async () => {
  apis.restore();
  await blobs.stop();
});

const call = async (fn, path, opts) => {
  const res = await fn(request(path, opts), context);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
const asAdmin = (path, opts) => { currentUser = OWNER; return call(adminApi, '/api/admin' + path, opts); };
const tokenFrom = (portalUrl) => new URL(portalUrl).searchParams.get('t');

test('catering builder submissions from one visit become one order that moves forward', async () => {
  const payload = cateringPayload();
  const first = await call(leads, '/api/leads', { method: 'POST', body: { ...payload, stage: 'quote_viewed' } });
  assert.equal(first.status, 200);
  assert.match(first.body.id, /^FB-[A-Z0-9]{6}$/);
  const second = await call(leads, '/api/leads', { method: 'POST', body: { ...payload, stage: 'deposit_initiated' } });
  assert.equal(second.body.id, first.body.id);
  // Going "back" a stage never downgrades the status.
  await call(leads, '/api/leads', { method: 'POST', body: { ...payload, stage: 'quote_built' } });

  const { body } = await asAdmin('/orders/' + first.body.id);
  assert.equal(body.order.status, 'pending_deposit');
  assert.equal(body.order.customer.email, 'jane@example.com');
  assert.equal(body.order.event.city, 'Turlock');
  assert.equal(body.order.quote.total, 1240.5);
  assert.equal(body.order.quote.deposit, 620.25);
  assert.equal(body.order.stages.length, 3);
  assert.equal(body.order.portalToken, undefined, 'portal token is not sent to the staff UI');
});

// Parallel submissions from one visit rely on Netlify Blobs' atomic onlyIfNew write to claim the
// visit reference. The local test server's conditional writes aren't atomic, so that race can't be
// exercised here; the catering page also sends its saves one at a time.

test('honeypot submissions are accepted but not saved', async () => {
  const before = (await asAdmin('/orders')).body.orders.length;
  const res = await call(leads, '/api/leads', { method: 'POST', body: { ...cateringPayload(), botField: 'spam' } });
  assert.equal(res.status, 200);
  assert.equal((await asAdmin('/orders')).body.orders.length, before);
});

test('bad submissions are rejected', async () => {
  assert.equal((await call(leads, '/api/leads', { method: 'POST', body: { kind: 'contact', customer: { name: 'x', email: 'nope' } } })).status, 400);
  assert.equal((await call(leads, '/api/leads', { method: 'POST', body: '{bad json' })).status, 400);
  assert.equal((await call(leads, '/api/leads', { method: 'GET' })).status, 405);
});

test('contact form messages land in the inbox as new inquiries', async () => {
  const res = await call(leads, '/api/leads', {
    method: 'POST',
    body: { kind: 'contact', customer: { name: 'Pat', email: 'pat@example.com' }, inquiry: { category: 'Pricing', message: 'How much for 200?' } },
  });
  assert.equal(res.status, 200);
  const { body } = await asAdmin('/orders/' + res.body.id);
  assert.equal(body.order.type, 'inquiry');
  assert.equal(body.order.status, 'new');
  assert.equal(body.order.inquiry.message, 'How much for 200?');
});

test('customer order page needs the right token and hides staff notes', async () => {
  const created = await call(leads, '/api/leads', { method: 'POST', body: cateringPayload() });
  const { id, portalUrl } = created.body;
  const t = tokenFrom(portalUrl);
  await asAdmin('/orders/' + id + '/notes', { method: 'POST', body: { text: 'Secret staff note' } });

  const ok = await call(portal, '/api/portal/order?id=' + id + '&t=' + t);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.id, id);
  assert.ok(!JSON.stringify(ok.body).includes('Secret staff note'));
  assert.equal(ok.body.order.amountDue.amount, 620.25);
  assert.equal(ok.body.order.amountDue.kind, 'deposit');

  assert.equal((await call(portal, '/api/portal/order?id=' + id + '&t=wrong')).status, 404);
  assert.equal((await call(portal, '/api/portal/order?id=FB-NOPE22&t=' + t)).status, 404);
});

function signedWebhook(event) {
  const raw = JSON.stringify(event);
  const sig = createHmac('sha256', 'sigkey').update(ORIGIN + '/api/square/webhook' + raw).digest('base64');
  return { method: 'POST', body: raw, headers: { 'x-square-hmacsha256-signature': sig } };
}

test('Square deposit: link is tied to the order, webhook records the payment once and books the order', async () => {
  const created = await call(leads, '/api/leads', { method: 'POST', body: { ...cateringPayload(), stage: 'deposit_initiated' } });
  const { id, portalUrl } = created.body;

  const link = await call(depositLink, '/.netlify/functions/create-deposit-link', {
    method: 'POST',
    body: { amount: '620.25', description: 'Deposit', referenceId: id, orderId: id, orderToken: tokenFrom(portalUrl) },
  });
  assert.equal(link.status, 200);
  assert.match(link.body.url, /square\.link/);
  const squareOrderId = 'sqorder_' + apis.calls.square.length;
  assert.equal(apis.calls.square.at(-1).quick_pay.price_money.amount, 62025);

  const event = {
    type: 'payment.updated',
    data: { object: { payment: { id: 'pay_1', order_id: squareOrderId, status: 'COMPLETED', amount_money: { amount: 62025 }, source_type: 'CARD', created_at: '2026-10-28T18:00:00Z' } } },
  };
  const emailsBefore = apis.calls.email.length;
  const first = await call(webhook, '/api/square/webhook', signedWebhook(event));
  assert.equal(first.status, 200);
  assert.equal(first.body.recorded, true);
  const again = await call(webhook, '/api/square/webhook', signedWebhook({ ...event, type: 'payment.created' }));
  assert.equal(again.body.recorded, false, 'same payment is not counted twice');

  const { body } = await asAdmin('/orders/' + id);
  assert.equal(body.order.status, 'booked');
  assert.equal(body.computed.paid, 620.25);
  assert.equal(body.computed.balance, 620.25);
  assert.equal(body.computed.amountDue.kind, 'balance');
  const sent = apis.calls.email.slice(emailsBefore);
  assert.equal(sent.length, 2, 'customer confirmation and staff alert');
  assert.ok(sent.some((e) => e.to[0] === 'jane@example.com' && /deposit is confirmed/.test(e.subject)));

});

test('a booked order is not overwritten when the same visit submits again', async () => {
  const payload = cateringPayload();
  const { id } = (await call(leads, '/api/leads', { method: 'POST', body: payload })).body;
  const loaded = await asAdmin('/orders/' + id);
  await asAdmin('/orders/' + id, { method: 'PATCH', body: { etag: loaded.body.etag, changes: { status: 'booked', quote: { total: 2000 } } } });
  await call(leads, '/api/leads', { method: 'POST', body: { ...payload, stage: 'deposit_initiated', quote: { ...payload.quote, total: '50' } } });
  const after = (await asAdmin('/orders/' + id)).body.order;
  assert.equal(after.status, 'booked');
  assert.equal(after.quote.total, 2000);
  assert.ok(after.activity.some((a) => a.action === 'Customer resubmitted from the website'));
});

test('webhook rejects bad signatures and ignores unknown payments', async () => {
  const bad = await call(webhook, '/api/square/webhook', { method: 'POST', body: '{}', headers: { 'x-square-hmacsha256-signature': 'nope' } });
  assert.equal(bad.status, 403);
  const unknown = await call(webhook, '/api/square/webhook', signedWebhook({
    type: 'payment.updated', data: { object: { payment: { id: 'p', order_id: 'not-ours', status: 'COMPLETED', amount_money: { amount: 100 } } } },
  }));
  assert.equal(unknown.body.ignored, 'unknown order');
});

test('customer can message staff and pay from their order page', async () => {
  const { id, portalUrl } = (await call(leads, '/api/leads', { method: 'POST', body: cateringPayload() })).body;
  const t = tokenFrom(portalUrl);
  const msg = await call(portal, '/api/portal/order/message', { method: 'POST', body: { id, t, message: 'Can we add 10 guests?' } });
  assert.equal(msg.status, 200);
  assert.equal(msg.body.order.customerMessages[0].text, 'Can we add 10 guests?');
  assert.equal(apis.calls.email.at(-1).reply_to, 'jane@example.com', 'staff can reply straight to the customer');
  const staffView = (await asAdmin('/orders/' + id)).body.order;
  assert.equal(staffView.flags.customerMessage, true);

  const pay = await call(portal, '/api/portal/order/pay', { method: 'POST', body: { id, t } });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.amount, 620.25);
  assert.equal((await call(portal, '/api/portal/order/pay', { method: 'POST', body: { id, t: 'bad' } })).status, 404);
});

test('"find my orders" emails a sign-in link that lists every order for that email', async () => {
  const email = 'repeat@example.com';
  for (const date of ['2026-11-01', '2027-02-14']) {
    await call(leads, '/api/leads', { method: 'POST', body: cateringPayload({ customer: { name: 'Repeat Co', email, phone: '2095550000' }, event: { date } }) });
  }
  const before = apis.calls.email.length;
  const res = await call(portal, '/api/portal/lookup', { method: 'POST', body: { email: 'REPEAT@example.com' } });
  assert.equal(res.status, 200);
  const sent = apis.calls.email.slice(before);
  assert.equal(sent.length, 1);
  const magic = sent[0].html.match(/my-orders\/\?m=([^"&]+)/)[1];

  // A second request right away is throttled (no second email), same answer.
  await call(portal, '/api/portal/lookup', { method: 'POST', body: { email } });
  assert.equal(apis.calls.email.length, before + 1);

  const list = await call(portal, '/api/portal/orders?m=' + decodeURIComponent(magic));
  assert.equal(list.status, 200);
  assert.equal(list.body.orders.length, 2);
  assert.equal(list.body.orders[0].event.date, '2027-02-14');

  // Unknown emails get the same response and no email.
  const n = apis.calls.email.length;
  const unknown = await call(portal, '/api/portal/lookup', { method: 'POST', body: { email: 'nobody@example.com' } });
  assert.equal(unknown.body.message, res.body.message);
  assert.equal(apis.calls.email.length, n);
  assert.equal((await call(portal, '/api/portal/orders?m=forged')).status, 401);
});

test('confirmation email includes the order link only with a valid token', async () => {
  const { id, portalUrl } = (await call(leads, '/api/leads', { method: 'POST', body: cateringPayload() })).body;
  const base = { type: 'quote', name: 'Jane <b>', email: 'jane@example.com', eventDate: '2026-12-12' };
  await call(confirmEmail, '/.netlify/functions/send-confirmation-email', { method: 'POST', body: { ...base, orderId: id, orderToken: tokenFrom(portalUrl) } });
  const good = apis.calls.email.at(-1).html;
  assert.ok(good.includes('/my-order/?id=' + id));
  assert.ok(good.includes('Jane &lt;b&gt;') || !good.includes('<b>'), 'customer text is escaped');
  await call(confirmEmail, '/.netlify/functions/send-confirmation-email', { method: 'POST', body: { ...base, orderId: id, orderToken: 'wrong' } });
  assert.ok(!apis.calls.email.at(-1).html.includes('/my-order/'));
});

test('admin API requires a staff role and same-origin writes', async () => {
  currentUser = null;
  assert.equal((await call(adminApi, '/api/admin/orders')).status, 401);
  currentUser = NOBODY;
  assert.equal((await call(adminApi, '/api/admin/orders')).status, 403);
  currentUser = STAFF;
  assert.equal((await call(adminApi, '/api/admin/orders')).status, 200);
  const crossSite = await adminApi(new Request(ORIGIN + '/api/admin/orders', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' }), context);
  assert.equal(crossSite.status, 403);
  // The owner from ADMIN_EMAILS is an admin even with no role assigned yet.
  const me = await asAdmin('/me');
  assert.equal(me.body.user.isAdmin, true);
  // Unconfirmed accounts don't get the owner bootstrap.
  currentUser = { ...OWNER, confirmedAt: undefined };
  assert.equal((await call(adminApi, '/api/admin/me')).status, 403);
});

test('staff edits detect conflicts instead of overwriting each other', async () => {
  const { id } = (await call(leads, '/api/leads', { method: 'POST', body: cateringPayload() })).body;
  const a = await asAdmin('/orders/' + id);
  const b = await asAdmin('/orders/' + id);
  const first = await asAdmin('/orders/' + id, { method: 'PATCH', body: { etag: a.body.etag, changes: { assignee: 'Cook' } } });
  assert.equal(first.status, 200);
  const stale = await asAdmin('/orders/' + id, { method: 'PATCH', body: { etag: b.body.etag, changes: { assignee: 'Owner' } } });
  assert.equal(stale.status, 409);
  assert.equal((await asAdmin('/orders/' + id)).body.order.assignee, 'Cook');
  const bad = await asAdmin('/orders/' + id, { method: 'PATCH', body: { etag: first.body.etag, changes: { status: 'not-a-status' } } });
  assert.equal(bad.status, 400);
});

test('staff can create phone orders, record payments, change emails, and export', async () => {
  const created = await asAdmin('/orders', {
    method: 'POST',
    body: { type: 'catering', customer: { name: '=HYPERLINK("x")', email: 'phone@example.com', phone: '209' }, event: { date: '2026-11-20', guestCount: 40 }, quote: { total: 900, deposit: 450 }, note: 'Called in' },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const paid = await asAdmin('/orders/' + id + '/payments', { method: 'POST', body: { amount: 450, method: 'check', markBooked: true } });
  assert.equal(paid.body.order.status, 'booked');
  assert.equal(paid.body.computed.balance, 450);

  const voided = await asAdmin('/orders/' + id + '/payments/' + paid.body.order.payment.payments[0].id + '/void', { method: 'POST', body: {} });
  assert.equal(voided.body.computed.paid, 0);

  // Changing the email moves the order to the new customer's "my orders" list.
  const loaded = await asAdmin('/orders/' + id);
  await asAdmin('/orders/' + id, { method: 'PATCH', body: { etag: loaded.body.etag, changes: { customer: { email: 'new@example.com' } } } });
  await call(portal, '/api/portal/lookup', { method: 'POST', body: { email: 'new@example.com' } });
  const magic = apis.calls.email.at(-1).html.match(/my-orders\/\?m=([^"&]+)/)[1];
  const list = await call(portal, '/api/portal/orders?m=' + decodeURIComponent(magic));
  assert.deepEqual(list.body.orders.map((o) => o.id), [id]);

  const csv = await asAdmin('/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.body.includes(`"'=HYPERLINK(""x"")"`), 'formulas are neutralized');

  currentUser = STAFF;
  assert.equal((await call(adminApi, '/api/admin/orders/' + id, { method: 'DELETE' })).status, 403);
  assert.equal((await asAdmin('/orders/' + id, { method: 'DELETE' })).status, 200);
  assert.equal((await asAdmin('/orders/' + id)).status, 404);
});

test('staff emails and payment requests go out and are logged', async () => {
  const { id } = (await call(leads, '/api/leads', { method: 'POST', body: cateringPayload() })).body;
  const res = await asAdmin('/orders/' + id + '/email', { method: 'POST', body: { template: 'payment_request' } });
  assert.equal(res.status, 200);
  const email = apis.calls.email.at(-1);
  assert.match(email.html, /square\.link/);
  assert.ok(res.body.order.notes.some((n) => n.emailed));
  assert.equal((await asAdmin('/orders/' + id + '/email', { method: 'POST', body: { template: 'custom' } })).status, 400);
});

test('staff list: admins see roles, staff only see names', async () => {
  const adminView = await asAdmin('/staff');
  assert.equal(adminView.body.staff.find((s) => s.email === 'owner@fireball.test').role, 'admin');
  currentUser = STAFF;
  const staffView = await call(adminApi, '/api/admin/staff');
  assert.equal(staffView.body.staff[0].role, undefined);
  assert.equal((await call(adminApi, '/api/admin/staff/u1', { method: 'DELETE' })).status, 403);
});

// ---------- availability: nobody is turned away; rule-breaking dates are flagged "Date to Confirm" ----------

const THURSDAY = '2027-06-03';
const SATURDAY = '2027-06-05';
const avail = (date, guests) => call(availability, '/api/availability?date=' + date + (guests === undefined ? '' : '&guests=' + guests));

test('farmers market days (Thu/Sat) under 40 guests are accepted but flagged for confirmation', async () => {
  assert.equal(new Date(THURSDAY + 'T00:00:00Z').getUTCDay(), 4);
  assert.equal(new Date(SATURDAY + 'T00:00:00Z').getUTCDay(), 6);
  const unknown = await avail(THURSDAY);
  assert.equal(unknown.body.available, true, 'date alone is fine before guests are chosen');
  assert.equal(unknown.body.code, 'market_day');
  assert.match(unknown.body.message, /40 guests or more/);
  const small = await avail(SATURDAY, 39);
  assert.equal(small.body.available, false);
  assert.equal(small.body.code, 'market_min');
  assert.match(small.body.message, /You can still book, and we'll confirm/);
  assert.equal((await avail(SATURDAY, 40)).body.available, true);
  assert.equal((await avail('2027-06-07', 20)).body.available, true, 'a Monday has no minimum');
  assert.equal((await avail('not-a-date')).status, 400);

  // A 30-guest request on a market day is accepted as Date to Confirm, with no payment taken.
  const res = await call(leads, '/api/leads', { method: 'POST', body: cateringPayload({ stage: 'date_requested', event: { date: THURSDAY, guestCount: 30 } }) });
  assert.equal(res.status, 200);
  assert.equal(res.body.available, false);
  const order = (await asAdmin('/orders/' + res.body.id)).body.order;
  assert.equal(order.status, 'date_check');
  assert.equal(order.flags.dateUnavailable, 'market_min');
  const link = await call(depositLink, '/.netlify/functions/create-deposit-link', {
    method: 'POST', body: { amount: 100, orderId: res.body.id, orderToken: tokenFrom(res.body.portalUrl) },
  });
  assert.equal(link.status, 409, 'no deposit until the date is confirmed');
  assert.equal(link.body.needsConfirmation, true);
});

test('a second booking on a taken date is accepted as "Date to Confirm" and does not take the date', async () => {
  const date = uniqueWeekday();
  const first = await call(leads, '/api/leads', { method: 'POST', body: cateringPayload({ stage: 'reserved_no_deposit', event: { date, guestCount: 60 } }) });
  assert.equal(first.body.available, true);
  assert.equal((await asAdmin('/orders/' + first.body.id)).body.order.status, 'reserved');
  assert.equal((await avail(date, 50)).body.code, 'booked');

  const before = apis.calls.email.length;
  const second = await call(leads, '/api/leads', { method: 'POST', body: cateringPayload({ stage: 'reserved_no_deposit', event: { date, guestCount: 50 } }) });
  assert.equal(second.status, 200);
  assert.equal(second.body.available, false);
  assert.match(second.body.message, /we'll confirm your date/);
  const order = (await asAdmin('/orders/' + second.body.id)).body.order;
  assert.equal(order.status, 'date_check');
  assert.equal(order.flags.dateUnavailable, 'booked');
  assert.equal(order.holdKey, '', 'a Date to Confirm order does not hold the date');

  // Their email says we'll confirm, not "your date is reserved".
  await call(confirmEmail, '/.netlify/functions/send-confirmation-email', {
    method: 'POST', body: { type: 'reservation', name: 'Jane', email: 'jane@example.com', orderId: second.body.id, orderToken: tokenFrom(second.body.portalUrl) },
  });
  const email = apis.calls.email.slice(before).at(-1);
  assert.equal(email.subject, 'We got your Fireball Pizza catering request');
  assert.match(email.html, /confirm with you within 1 to 2 business days/);
  assert.ok(!/date is reserved/.test(email.html));

  // Customer page says so too, with no Pay button until it's confirmed.
  const t = tokenFrom(second.body.portalUrl);
  const page = await call(portal, '/api/portal/order?id=' + second.body.id + '&t=' + t);
  assert.equal(page.body.order.statusLabel, 'Confirming your date');
  assert.equal(page.body.order.amountDue, null);
  assert.equal((await call(portal, '/api/portal/order/pay', { method: 'POST', body: { id: second.body.id, t } })).status, 400);

  // Staff confirm it (Reserved): the flag clears and the customer can pay the deposit.
  const loaded = await asAdmin('/orders/' + second.body.id);
  const ok = await asAdmin('/orders/' + second.body.id, { method: 'PATCH', body: { etag: loaded.body.etag, changes: { status: 'reserved' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.flags.dateUnavailable, undefined);
  assert.ok(ok.body.order.activity.at(-1).detail.includes('Date confirmed'));
  assert.equal(ok.body.computed.amountDue.kind, 'deposit');
  assert.equal((await call(portal, '/api/portal/order/pay', { method: 'POST', body: { id: second.body.id, t } })).status, 200);
});

test('"Request This Date" on a flagged date: no payment, and the email says nothing was charged', async () => {
  const date = uniqueWeekday();
  await asAdmin('/orders', { method: 'POST', body: { type: 'catering', status: 'booked', customer: { name: 'Already here' }, event: { date, guestCount: 80 } } });
  const res = await call(leads, '/api/leads', { method: 'POST', body: cateringPayload({ stage: 'date_requested', event: { date, guestCount: 50 } }) });
  const order = (await asAdmin('/orders/' + res.body.id)).body.order;
  assert.equal(order.status, 'date_check');
  assert.equal(order.payment.depositLinkUrl, '');
  await call(confirmEmail, '/.netlify/functions/send-confirmation-email', {
    method: 'POST', body: { type: 'reservation', name: 'Jane', email: 'jane@example.com', orderId: res.body.id, orderToken: tokenFrom(res.body.portalUrl) },
  });
  assert.match(apis.calls.email.at(-1).html, /Nothing has been charged/);

  // On a clear date the same request just reserves it.
  const clear = await call(leads, '/api/leads', { method: 'POST', body: cateringPayload({ stage: 'date_requested', event: { date: uniqueWeekday(), guestCount: 50 } }) });
  assert.equal((await asAdmin('/orders/' + clear.body.id)).body.order.status, 'reserved');
});

test('changing, cancelling or deleting a booking frees its date', async () => {
  const date = uniqueWeekday();
  const moved = uniqueWeekday();
  const { id } = (await asAdmin('/orders', { method: 'POST', body: { type: 'catering', status: 'booked', customer: { name: 'Hold Test' }, event: { date, guestCount: 50 } } })).body;
  assert.equal((await avail(date)).body.available, false);

  let loaded = await asAdmin('/orders/' + id);
  await asAdmin('/orders/' + id, { method: 'PATCH', body: { etag: loaded.body.etag, changes: { event: { date: moved } } } });
  assert.equal((await avail(date)).body.available, true, 'old date freed');
  assert.equal((await avail(moved)).body.available, false, 'new date held');

  loaded = await asAdmin('/orders/' + id);
  await asAdmin('/orders/' + id, { method: 'PATCH', body: { etag: loaded.body.etag, changes: { status: 'cancelled' } } });
  assert.equal((await avail(moved)).body.available, true, 'cancelled frees the date');

  loaded = await asAdmin('/orders/' + id);
  await asAdmin('/orders/' + id, { method: 'PATCH', body: { etag: loaded.body.etag, changes: { status: 'booked' } } });
  assert.equal((await avail(moved)).body.available, false);
  await asAdmin('/orders/' + id, { method: 'DELETE' });
  assert.equal((await avail(moved)).body.available, true, 'deleting frees the date');
});

test('a paid deposit on a taken date goes to "Date to Confirm", not Booked, and both emails say so', async () => {
  const date = uniqueWeekday();
  const late = await call(leads, '/api/leads', { method: 'POST', body: cateringPayload({ stage: 'deposit_initiated', event: { date, guestCount: 50 } }) });
  const link = await call(depositLink, '/.netlify/functions/create-deposit-link', {
    method: 'POST', body: { amount: 100, orderId: late.body.id, orderToken: tokenFrom(late.body.portalUrl) },
  });
  assert.equal(link.status, 200);
  await asAdmin('/orders', { method: 'POST', body: { type: 'catering', status: 'booked', customer: { name: 'Got there first' }, event: { date, guestCount: 80 } } });
  const before = apis.calls.email.length;
  const event = {
    type: 'payment.updated',
    data: { object: { payment: { id: 'pay_conflict', order_id: 'sqorder_' + apis.calls.square.length, status: 'COMPLETED', amount_money: { amount: 10000 }, source_type: 'CARD' } } },
  };
  const res = await call(webhook, '/api/square/webhook', signedWebhook(event));
  assert.equal(res.body.recorded, true);
  const order = (await asAdmin('/orders/' + late.body.id)).body;
  assert.equal(order.order.status, 'date_check');
  assert.equal(order.computed.paid, 100);
  const sent = apis.calls.email.slice(before);
  assert.ok(sent.some((e) => /^CONFIRM DATE/.test(e.subject)), 'staff alert');
  const customer = sent.find((e) => e.to[0] === 'jane@example.com');
  assert.equal(customer.subject, 'We received your Fireball Pizza deposit');
  assert.ok(!/officially booked/.test(customer.html));
});
