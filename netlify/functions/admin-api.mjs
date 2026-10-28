// Staff portal API. Every route requires a signed-in Netlify Identity user with the
// admin or staff role (see lib/auth.mjs). Staff management routes require admin.
//
// Order edits send the ETag they loaded. If someone else saved the order in between,
// the save is refused with 409 so nobody's changes get silently overwritten.

import { admin as identityAdmin, getIdentityConfig } from '@netlify/identity';
import { requireStaff, rolesFor, adminEmails } from '../lib/auth.mjs';
import { crmStore, getOrder, createOrder, writeOrder, updateOrder, listOrders, deleteOrder, reindexEmail } from '../lib/store.mjs';
import {
  blankOrder, logActivity, setAddress, summarize, isValidStatus, statusLabel, addPayment, paidTotal, balanceDue,
  amountToCollect, CATERING_STATUSES, INQUIRY_STATUSES, PAYMENT_METHODS, ORDER_TYPES,
} from '../lib/orders.mjs';
import { createLinkForOrder } from '../lib/deposit.mjs';
import { MARKET_DAYS, MARKET_MIN_GUESTS } from '../lib/availability.mjs';
import { SquareConfigError } from '../lib/square.mjs';
import { sendEmail, layout, firstName, formatMoney, formatDate, portalUrl } from '../lib/email.mjs';
import {
  json, errorResponse, readJson, HttpError, str, num, money, isEmail, normalizeEmail, isIsoDate, newOrderId, newToken, newNoteId, siteUrl,
} from '../lib/util.mjs';

export default async (req, context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method;
  try {
    // State-changing requests must come from our own pages (CSRF). Cookies are SameSite=Lax,
    // this is the second lock on the door.
    if (method !== 'GET') {
      const origin = req.headers.get('origin');
      if (!origin || origin !== url.origin) throw new HttpError(403, 'Cross-origin request refused');
    }
    const user = await requireStaff();
    const store = crmStore(context);
    const base = siteUrl(req);
    const [resource, id, sub, subId, action] = parts;

    if (resource === 'me' && method === 'GET') return json({ user, meta: meta() });

    if (resource === 'orders') {
      if (!id && method === 'GET') return json({ orders: (await listOrders(store)).map(summarize) });
      if (!id && method === 'POST') return await createManualOrder(store, req, user);
      if (id && !sub && method === 'GET') return await getOne(store, id, base);
      if (id && !sub && method === 'PATCH') return await patchOrder(store, id, req, user, base);
      if (id && !sub && method === 'DELETE') return await removeOrder(store, id, user);
      if (sub === 'notes' && method === 'POST') return await addNote(store, id, req, user, base);
      if (sub === 'notes' && subId && method === 'DELETE') return await removeNote(store, id, subId, user, base);
      if (sub === 'payments' && !subId && method === 'POST') return await recordPayment(store, id, req, user, base);
      if (sub === 'payments' && subId && action === 'void' && method === 'POST') return await voidPayment(store, id, subId, req, user, base);
      if (sub === 'payment-link' && method === 'POST') return await paymentLink(store, id, req, user);
      if (sub === 'email' && method === 'POST') return await emailCustomer(store, id, req, user, base);
      if (sub === 'portal-link' && method === 'POST') return await resetPortalLink(store, id, user, base);
    }

    if (resource === 'export.csv' && method === 'GET') return await exportCsv(store);

    if (resource === 'staff') {
      if (!id && method === 'GET') return await listStaff(user);
      if (!user.isAdmin) throw new HttpError(403, 'Only admins can manage staff accounts');
      if (id === 'invite' && method === 'POST') return await inviteStaff(req, user);
      if (id && method === 'PATCH') return await changeRole(id, req, user);
      if (id && method === 'DELETE') return await removeStaff(id, user);
    }

    return errorResponse(404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message);
    console.error('Fireball admin API error', method, url.pathname, err);
    return errorResponse(500, 'Something went wrong. Try again, and check the function logs if it keeps happening.');
  }
};

function meta() {
  return {
    cateringStatuses: CATERING_STATUSES, inquiryStatuses: INQUIRY_STATUSES, paymentMethods: PAYMENT_METHODS, types: ORDER_TYPES,
    marketDays: MARKET_DAYS, marketMinGuests: MARKET_MIN_GUESTS,
  };
}

async function loadOrThrow(store, id) {
  const found = await getOrder(store, id);
  if (!found) throw new HttpError(404, 'Order not found');
  return found;
}

function fullView(order, etag, base) {
  return {
    order: { ...order, portalToken: undefined, clientRefHash: undefined },
    etag,
    computed: { paid: paidTotal(order), balance: balanceDue(order), amountDue: amountToCollect(order), portalUrl: order.portalToken ? portalUrl(base, order) : '' },
  };
}

async function getOne(store, id, base) {
  const { order, etag } = await loadOrThrow(store, id);
  return json(fullView(order, etag, base));
}

// Applies staff edits. Returns a list of human-readable changes for the activity log.
function applyChanges(order, changes) {
  const log = [];
  const set = (label, current, next, assign) => {
    if (next === undefined || next === current) return;
    assign(next);
    log.push(label + ': ' + (current === '' || current === null || current === undefined ? '(empty)' : current) + ' -> ' + (next === '' || next === null ? '(empty)' : next));
  };

  if (changes.status !== undefined) {
    if (!isValidStatus(order.type, changes.status)) throw new HttpError(400, 'Unknown status');
    const wasDateCheck = order.status === 'date_check';
    set('Status', statusLabel(order.type, order.status), statusLabel(order.type, changes.status), () => (order.status = changes.status));
    // Moving it out of Date to Confirm is the confirmation; the website can take payment again.
    if (wasDateCheck && changes.status !== 'date_check' && order.flags.dateUnavailable) {
      delete order.flags.dateUnavailable;
      log.push('Date confirmed');
    }
  }
  if (changes.assignee !== undefined) set('Assigned to', order.assignee, str(changes.assignee, 120), (v) => (order.assignee = v));
  if (Array.isArray(changes.tags)) {
    const tags = [...new Set(changes.tags.map((t) => str(t, 30).toLowerCase()).filter(Boolean))].slice(0, 12);
    if (tags.join(',') !== order.tags.join(',')) { order.tags = tags; log.push('Tags: ' + (tags.join(', ') || '(none)')); }
  }
  const c = changes.customer || {};
  if (c.name !== undefined) set('Name', order.customer.name, str(c.name, 120), (v) => (order.customer.name = v));
  if (c.email !== undefined) {
    const email = normalizeEmail(c.email);
    if (email && !isEmail(email)) throw new HttpError(400, 'That email address does not look right');
    set('Email', order.customer.email, email, (v) => (order.customer.email = v));
  }
  if (c.phone !== undefined) set('Phone', order.customer.phone, str(c.phone, 40), (v) => (order.customer.phone = v));
  if (c.company !== undefined) set('Company', order.customer.company, str(c.company, 120), (v) => (order.customer.company = v));
  const e = changes.event || {};
  if (e.date !== undefined) {
    if (e.date && !isIsoDate(e.date)) throw new HttpError(400, 'Event date must be YYYY-MM-DD');
    set('Event date', order.event.date, e.date, (v) => (order.event.date = v));
  }
  if (e.time !== undefined) set('Start time', order.event.time, str(e.time, 40), (v) => (order.event.time = v));
  if (e.address !== undefined) set('Address', order.event.address, str(e.address, 300), (v) => setAddress(order, v));
  if (e.city !== undefined) set('City', order.event.city, str(e.city, 80), (v) => (order.event.city = v));
  if (e.guestCount !== undefined) {
    const g = e.guestCount === '' || e.guestCount === null ? null : Math.round(num(e.guestCount));
    set('Guests', order.event.guestCount, g, (v) => (order.event.guestCount = v));
  }
  if (e.serviceStyle !== undefined) set('Service style', order.event.serviceStyle, str(e.serviceStyle, 80), (v) => (order.event.serviceStyle = v));
  const q = changes.quote || {};
  if (q.total !== undefined) set('Total', order.quote.total, q.total === '' || q.total === null ? null : money(q.total), (v) => (order.quote.total = v));
  if (q.deposit !== undefined) set('Deposit', order.quote.deposit, q.deposit === '' || q.deposit === null ? null : money(q.deposit), (v) => (order.quote.deposit = v));
  if (q.pricingSummary !== undefined && str(q.pricingSummary, 3000) !== order.quote.pricingSummary) { order.quote.pricingSummary = str(q.pricingSummary, 3000); log.push('Pricing summary updated'); }
  if (q.extras !== undefined && str(q.extras, 1000) !== order.quote.extras) { order.quote.extras = str(q.extras, 1000); log.push('Extras updated'); }
  const i = changes.inquiry || {};
  if (i.category !== undefined) set('Inquiry type', order.inquiry.category, str(i.category, 60), (v) => (order.inquiry.category = v));
  if (changes.callbackHandled === true && order.flags.callbackRequested) { order.flags.callbackRequested = false; log.push('Callback marked done'); }
  if (changes.customerMessageRead === true && order.flags.customerMessage) { order.flags.customerMessage = false; log.push('Customer message marked read'); }
  return log;
}

async function createManualOrder(store, req, user) {
  const body = await readJson(req);
  const type = ORDER_TYPES.includes(body.type) ? body.type : 'catering';
  const order = blankOrder({ id: newOrderId(), type, now: new Date().toISOString(), by: 'staff' });
  order.portalToken = newToken();
  applyChanges(order, body);
  if (!order.customer.name) throw new HttpError(400, 'Customer name is required');
  if (type === 'inquiry') order.inquiry.message = str(body.inquiry?.message, 5000);
  if (body.note) order.notes.push({ id: newNoteId(), at: order.createdAt, by: user.name, byEmail: user.email, text: str(body.note, 5000) });
  logActivity(order, user.name, 'Order created by staff', body.sourceDetail ? str(body.sourceDetail, 80) : '');
  for (let attempt = 0; attempt < 5; attempt++) {
    const etag = await createOrder(store, order);
    if (etag) return json({ id: order.id }, 201);
    order.id = newOrderId();
  }
  throw new Error('Could not allocate an order id');
}

async function patchOrder(store, id, req, user, base) {
  const body = await readJson(req);
  if (!body.etag) throw new HttpError(400, 'Missing version. Reload the order and try again.');
  const { order, etag } = await loadOrThrow(store, id);
  if (etag !== body.etag) throw new HttpError(409, 'Someone else updated this order while you had it open. Reload to see their changes, then make yours again.');
  const previousEmail = order.customer.email;
  const changes = applyChanges(order, body.changes || {});
  if (!changes.length) return json(fullView(order, etag, base));
  logActivity(order, user.name, 'Updated', changes.join('; '));
  const newEtag = await writeOrder(store, order, etag);
  if (!newEtag) throw new HttpError(409, 'Someone else updated this order while you had it open. Reload to see their changes, then make yours again.');
  if (order.customer.email !== previousEmail) await reindexEmail(store, previousEmail, order.customer.email, order.id);
  return json(fullView(order, newEtag, base));
}

async function removeOrder(store, id, user) {
  if (!user.isAdmin) throw new HttpError(403, 'Only admins can delete orders. Mark it Lost, Closed or Spam instead.');
  const { order } = await loadOrThrow(store, id);
  await deleteOrder(store, order);
  console.log('Fireball admin: order', id, 'deleted by', user.email);
  return json({ ok: true });
}

async function addNote(store, id, req, user, base) {
  const body = await readJson(req);
  const text = str(body.text, 5000);
  if (!text) throw new HttpError(400, 'Note is empty');
  const order = await updateOrder(store, id, (o) => {
    o.notes.push({ id: newNoteId(), at: new Date().toISOString(), by: user.name, byEmail: user.email, text, pinned: !!body.pinned });
    o.updatedAt = new Date().toISOString();
  });
  if (!order) throw new HttpError(404, 'Order not found');
  return getOne(store, id, base);
}

async function removeNote(store, id, noteId, user, base) {
  let denied = false;
  const order = await updateOrder(store, id, (o) => {
    const note = o.notes.find((n) => n.id === noteId);
    if (!note) return false;
    if (note.byEmail !== user.email && !user.isAdmin) { denied = true; return false; }
    o.notes = o.notes.filter((n) => n.id !== noteId);
    logActivity(o, user.name, 'Deleted a note');
  });
  if (!order) throw new HttpError(404, 'Order not found');
  if (denied) throw new HttpError(403, 'You can only delete your own notes');
  return getOne(store, id, base);
}

async function recordPayment(store, id, req, user, base) {
  const body = await readJson(req);
  const amount = money(body.amount);
  if (!amount || amount <= 0) throw new HttpError(400, 'Enter a payment amount');
  const method = PAYMENT_METHODS.includes(body.method) ? body.method : 'other';
  const at = isIsoDate(body.date) ? body.date + 'T12:00:00.000Z' : new Date().toISOString();
  const order = await updateOrder(store, id, (o) => {
    addPayment(o, { amount, method, note: str(body.note, 300), at, by: user.name });
    logActivity(o, user.name, 'Payment recorded', formatMoney(amount) + ' ' + method);
    if (body.markBooked && ['lead', 'pending_deposit', 'reserved', 'date_check'].includes(o.status)) {
      o.status = 'booked';
      logActivity(o, user.name, 'Status changed', 'Booked');
    }
  });
  if (!order) throw new HttpError(404, 'Order not found');
  return getOne(store, id, base);
}

async function voidPayment(store, id, paymentId, req, user, base) {
  const body = await readJson(req);
  const order = await updateOrder(store, id, (o) => {
    const p = o.payment.payments.find((x) => x.id === paymentId);
    if (!p) return false;
    p.refunded = !p.refunded;
    logActivity(o, user.name, p.refunded ? 'Payment voided or refunded' : 'Payment restored', formatMoney(p.amount) + (body.reason ? ' (' + str(body.reason, 200) + ')' : ''));
  });
  if (!order) throw new HttpError(404, 'Order not found');
  return getOne(store, id, base);
}

async function paymentLink(store, id, req, user) {
  const body = await readJson(req);
  const { order } = await loadOrThrow(store, id);
  const due = amountToCollect(order);
  const amount = body.amount ? money(body.amount) : due?.amount;
  if (!amount || amount <= 0) throw new HttpError(400, 'Nothing is owed on this order. Enter an amount to charge.');
  const kind = body.kind === 'balance' || (!body.kind && due?.kind === 'balance') ? 'balance' : 'deposit';
  try {
    const link = await createLinkForOrder(store, id, { amount, kind, by: user.name });
    return json({ url: link.url, amount, kind });
  } catch (err) {
    if (err instanceof SquareConfigError) throw new HttpError(503, err.message);
    throw new HttpError(502, 'Square refused the payment link: ' + err.message);
  }
}

const EMAIL_TEMPLATES = {
  custom: { subject: 'About your Fireball Pizza order' },
  payment_request: { subject: 'Your Fireball Pizza payment link' },
  booking_confirmed: { subject: 'Your Fireball Pizza catering is booked' },
  order_link: { subject: 'Your Fireball Pizza order page' },
};

async function emailCustomer(store, id, req, user, base) {
  const body = await readJson(req);
  const template = EMAIL_TEMPLATES[body.template] ? body.template : 'custom';
  const { order } = await loadOrThrow(store, id);
  if (!isEmail(order.customer.email)) throw new HttpError(400, 'This order has no valid customer email');
  const message = str(body.message, 5000);
  const subject = str(body.subject, 150) || EMAIL_TEMPLATES[template].subject;
  if (template === 'custom' && !message) throw new HttpError(400, 'Write a message first');

  let button = { label: 'View your order', url: portalUrl(base, order) };
  let payLink = '';
  if (template === 'payment_request') {
    const due = amountToCollect(order);
    const amount = body.amount ? money(body.amount) : due?.amount;
    if (!amount) throw new HttpError(400, 'Nothing is owed on this order. Enter an amount to request.');
    try {
      const link = await createLinkForOrder(store, id, { amount, kind: due?.kind || 'deposit', by: user.name });
      payLink = link.url;
      button = { label: 'Pay ' + formatMoney(amount), url: link.url };
    } catch (err) {
      if (err instanceof SquareConfigError) throw new HttpError(503, err.message);
      throw new HttpError(502, 'Square refused the payment link: ' + err.message);
    }
  }

  const defaults = {
    custom: [],
    payment_request: ['Here is a secure link to make your payment.'],
    booking_confirmed: ['Your catering is booked. We are looking forward to it.'],
    order_link: ['Here is the link to your order page. You can see your event details, payments, and send us changes there.'],
  };
  const html = layout({
    greeting: 'Hi ' + firstName(order.customer.name) + ',',
    paragraphs: [...(message ? [message] : defaults[template])],
    rows: order.type === 'catering'
      ? [
          ['Order', order.id],
          ['Event date', formatDate(order.event.date)],
          ['Start time', order.event.time],
          ['Guest count', order.event.guestCount ? String(order.event.guestCount) : ''],
          ['Total', formatMoney(order.quote.total)],
          ['Paid so far', paidTotal(order) ? formatMoney(paidTotal(order)) : ''],
          ['Balance', balanceDue(order) !== null ? formatMoney(balanceDue(order)) : ''],
        ]
      : [['Reference', order.id]],
    button,
  });

  const result = await sendEmail({ to: order.customer.email, subject, html });
  if (!result.sent) throw new HttpError(502, result.skipped ? 'Email is not set up (RESEND_API_KEY is missing).' : 'The email service refused the message. Check the function logs.');

  await updateOrder(store, id, (o) => {
    logActivity(o, user.name, 'Emailed customer', subject);
    o.notes.push({ id: newNoteId(), at: new Date().toISOString(), by: user.name, byEmail: user.email, text: 'Emailed customer: "' + subject + '"' + (message ? '\n\n' + message : '') + (payLink ? '\n\nPayment link: ' + payLink : ''), emailed: true });
    if (o.type === 'inquiry' && ['new', 'open'].includes(o.status)) o.status = 'replied';
  });
  return getOne(store, id, base);
}

async function resetPortalLink(store, id, user, base) {
  await updateOrder(store, id, (o) => {
    o.portalToken = newToken();
    logActivity(o, user.name, 'Customer link reset', 'The old link no longer works');
  });
  return getOne(store, id, base);
}

const CSV_COLUMNS = [
  ['Order', (o) => o.id], ['Type', (o) => o.type], ['Status', (o) => statusLabel(o.type, o.status)],
  ['Created', (o) => o.createdAt], ['Name', (o) => o.customer.name], ['Email', (o) => o.customer.email],
  ['Phone', (o) => o.customer.phone], ['Company', (o) => o.customer.company], ['Event date', (o) => o.event.date],
  ['Start time', (o) => o.event.time], ['Address', (o) => o.event.address], ['City', (o) => o.event.city],
  ['Guests', (o) => o.event.guestCount], ['Service style', (o) => o.event.serviceStyle], ['Total', (o) => o.quote.total],
  ['Deposit', (o) => o.quote.deposit], ['Paid', (o) => paidTotal(o)], ['Balance', (o) => balanceDue(o)],
  ['Assigned to', (o) => o.assignee], ['Tags', (o) => o.tags.join(' ')], ['Inquiry type', (o) => o.inquiry.category],
  ['Message', (o) => o.inquiry.message || o.callbackMessage], ['Pricing summary', (o) => o.quote.pricingSummary],
  ['Extras', (o) => o.quote.extras], ['Notes', (o) => o.notes.map((n) => n.at.slice(0, 10) + ' ' + n.by + ': ' + n.text).join(' | ')],
];

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // Stop spreadsheet apps from running customer-typed text as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportCsv(store) {
  const orders = (await listOrders(store)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lines = [CSV_COLUMNS.map((c) => csvCell(c[0])).join(',')];
  for (const o of orders) lines.push(CSV_COLUMNS.map((c) => csvCell(c[1](o))).join(','));
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="fireball-orders-' + new Date().toISOString().slice(0, 10) + '.csv"',
      'Cache-Control': 'no-store',
    },
  });
}

function staffView(u) {
  const roles = rolesFor(u);
  return {
    id: u.id,
    email: u.email,
    name: u.name || u.userMetadata?.full_name || '',
    role: roles.includes('admin') ? 'admin' : roles.includes('staff') ? 'staff' : 'none',
    owner: !!u.email && adminEmails().includes(u.email.toLowerCase()),
    confirmed: !!u.confirmedAt,
    invitedAt: u.invitedAt || '',
    lastSignInAt: u.lastSignInAt || '',
  };
}

async function listStaff(user) {
  const users = await identityAdmin.listUsers({ perPage: 200 });
  const staff = users.map(staffView);
  // Regular staff only need names for the "assigned to" picker.
  if (!user.isAdmin) return json({ staff: staff.filter((s) => s.role !== 'none').map((s) => ({ id: s.id, name: s.name, email: s.email })) });
  return json({ staff });
}

async function inviteStaff(req, user) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const role = body.role === 'admin' ? 'admin' : 'staff';
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  const config = getIdentityConfig();
  if (!config?.token) throw new HttpError(503, 'Netlify Identity is not enabled on this site yet.');
  // GoTrue's admin invite endpoint sends the standard Netlify Identity invite email.
  const response = await fetch(config.url + '/invite', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Fireball admin: invite failed', response.status, JSON.stringify(data));
    throw new HttpError(response.status === 422 ? 400 : 502, data.msg || data.error_description || 'Invite failed. That email may already have an account.');
  }
  if (data.id) await identityAdmin.updateUser(data.id, { app_metadata: { ...(data.app_metadata || {}), roles: [role] } });
  console.log('Fireball admin:', user.email, 'invited', email, 'as', role);
  return json({ ok: true });
}

async function changeRole(id, req, user) {
  const body = await readJson(req);
  if (!['admin', 'staff', 'none'].includes(body.role)) throw new HttpError(400, 'Unknown role');
  if (id === user.id && body.role !== 'admin') throw new HttpError(400, "You can't remove your own admin access");
  const target = await identityAdmin.getUser(id);
  const others = (Array.isArray(target.appMetadata?.roles) ? target.appMetadata.roles : []).filter((r) => !['admin', 'staff'].includes(r));
  await identityAdmin.updateUser(id, { app_metadata: { ...(target.appMetadata || {}), roles: body.role === 'none' ? others : [...others, body.role] } });
  console.log('Fireball admin:', user.email, 'set role of', target.email, 'to', body.role);
  return json({ ok: true });
}

async function removeStaff(id, user) {
  if (id === user.id) throw new HttpError(400, "You can't delete your own account");
  const target = await identityAdmin.getUser(id);
  await identityAdmin.deleteUser(id);
  console.log('Fireball admin:', user.email, 'removed', target.email);
  return json({ ok: true });
}

export const config = { path: '/api/admin/*' };
