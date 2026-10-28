// Public endpoint the website forms post to. Saves catering quotes/bookings and contact
// inquiries as orders in Netlify Blobs. Runs alongside Netlify Forms, which stays on as
// the email notification and as a backup copy of every submission.
//
// The catering builder submits several times per visit (quote viewed, quote built,
// deposit started...). The browser sends a random clientRef for the visit, so all of those
// land on one order instead of five.

import { crmStore, getOrder, createOrder, updateOrder, lookupRef, setRef } from '../lib/store.mjs';
import { blankOrder, logActivity, setAddress, advanceFromPublic, publicCanUpdate } from '../lib/orders.mjs';
import { portalUrl } from '../lib/email.mjs';
import { checkDate } from '../lib/availability.mjs';
import { json, errorResponse, readJson, HttpError, str, num, money, isEmail, normalizeEmail, isIsoDate, newOrderId, newToken, sha256, siteUrl } from '../lib/util.mjs';

const STAGES = ['quote_viewed', 'quote_built', 'callback_requested', 'deposit_initiated', 'reserved_no_deposit'];
// Stages that would take the date. These are refused (the order stays a lead) when the date is unavailable.
const BOOKING_STAGES = ['deposit_initiated', 'reserved_no_deposit'];

const STAGE_LABELS = {
  quote_viewed: 'Viewed a quote on the website',
  quote_built: 'Built a custom quote on the website',
  callback_requested: 'Asked for a callback from a Pizza Pro',
  deposit_initiated: 'Opened the deposit payment page',
  reserved_no_deposit: 'Reserved the date, paying by cash or check',
};

export default async (req, context) => {
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');
  try {
    const body = await readJson(req);
    // Honeypot: bots fill every field. Pretend it worked.
    if (body.botField) return json({ ok: true });

    const name = str(body.customer?.name, 120);
    const email = normalizeEmail(body.customer?.email);
    if (!name || !isEmail(email)) throw new HttpError(400, 'A valid name and email are required');

    const store = crmStore(context);
    if (body.kind === 'contact') return await saveInquiry(store, body, name, email);
    if (body.kind === 'catering') return await saveCatering(store, body, name, email, siteUrl(req));
    throw new HttpError(400, 'Unknown submission type');
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message);
    console.error('Fireball leads: failed to save submission', err);
    return errorResponse(500, 'Could not save your request');
  }
};

async function saveInquiry(store, body, name, email) {
  const now = new Date().toISOString();
  const order = blankOrder({ id: newOrderId(), type: 'inquiry', now });
  order.customer = { name, email, phone: str(body.customer?.phone, 40), company: '' };
  order.inquiry = { category: str(body.inquiry?.category, 60) || 'General Question', message: str(body.inquiry?.message, 5000) };
  order.portalToken = newToken();
  logActivity(order, 'Website', 'Inquiry received', order.inquiry.category);
  const etag = await createWithFreshId(store, order);
  if (!etag) throw new Error('Could not allocate an order id');
  return json({ ok: true, id: order.id });
}

async function saveCatering(store, body, name, email, base) {
  const clientRef = str(body.clientRef, 100);
  if (clientRef.length < 16) throw new HttpError(400, 'Missing visit reference');
  const stage = STAGES.includes(body.stage) ? body.stage : 'quote_viewed';
  const refHash = sha256(clientRef);

  let id = await lookupRef(store, 'ref', refHash);
  if (!id) {
    const fresh = blankOrder({ id: newOrderId(), type: 'catering', now: new Date().toISOString() });
    fresh.portalToken = newToken();
    fresh.clientRefHash = refHash;
    applyCateringFields(fresh, body, name, email);
    const check = await availabilityFor(store, fresh, stage);
    applyStage(fresh, stage, check);
    fresh.stages.push({ stage, at: fresh.createdAt });

    // Claim the visit reference first. If a parallel request from the same visit won, update its order instead.
    const etag = await createWithFreshId(store, fresh, async (candidateId) => setRef(store, 'ref', refHash, candidateId, true));
    if (etag) return json({ ok: true, id: fresh.id, portalUrl: portalUrl(base, fresh), ...availabilityReply(check) });
    id = await lookupRef(store, 'ref', refHash);
    if (!id) throw new Error('Visit reference vanished');
  }

  // The order may not be readable for a moment if a parallel request is still creating it.
  let updated = null;
  let check = null;
  for (let attempt = 0; attempt < 3 && !updated; attempt++) {
    updated = await updateOrder(store, id, async (order) => {
      order.stages.push({ stage, at: new Date().toISOString() });
      if (order.stages.length > 50) order.stages = order.stages.slice(-50);
      if (!publicCanUpdate(order)) {
        // Staff already moved this order on (booked, cancelled...). Note it, but don't overwrite their work.
        logActivity(order, 'Website', 'Customer resubmitted from the website', STAGE_LABELS[stage]);
        return;
      }
      applyCateringFields(order, body, name, email);
      check = await availabilityFor(store, order, stage);
      applyStage(order, stage, check);
    });
    if (!updated) await new Promise((r) => setTimeout(r, 300));
  }
  if (!updated) throw new Error('Order ' + id + ' for visit reference not found');
  return json({ ok: true, id: updated.id, portalUrl: portalUrl(base, updated), ...availabilityReply(check) });
}

async function availabilityFor(store, order, stage) {
  if (!BOOKING_STAGES.includes(stage)) return null;
  return checkDate(store, order.event.date, order.event.guestCount, order.id);
}

function applyStage(order, stage, check) {
  if (check && !check.available) {
    // Keep it as a lead so staff can follow up, but don't let it take the date.
    order.flags.dateUnavailable = check.code;
    logActivity(order, 'Website', 'Tried to book an unavailable date', check.message);
    return;
  }
  if (BOOKING_STAGES.includes(stage)) delete order.flags.dateUnavailable;
  advanceFromPublic(order, stage);
  logActivity(order, 'Website', STAGE_LABELS[stage]);
}

function availabilityReply(check) {
  return check && !check.available ? { available: false, code: check.code, message: check.message } : { available: true };
}

function applyCateringFields(order, body, name, email) {
  const e = body.event || {};
  const q = body.quote || {};
  order.customer.name = name;
  order.customer.email = email;
  order.customer.phone = str(body.customer?.phone, 40);
  if (isIsoDate(e.date)) order.event.date = e.date;
  order.event.time = str(e.timeLabel || e.time, 40);
  if (e.address) setAddress(order, str(e.address, 300));
  const guests = num(e.guestCount);
  if (guests !== null && guests > 0 && guests < 5000) order.event.guestCount = Math.round(guests);
  order.event.serviceStyle = str(q.serviceStyle, 80) || order.event.serviceStyle;
  const total = money(q.total);
  const deposit = money(q.deposit);
  if (total !== null && total > 0) order.quote.total = total;
  if (deposit !== null && deposit > 0) order.quote.deposit = deposit;
  order.quote.pricingSummary = str(q.pricingSummary, 3000) || order.quote.pricingSummary;
  order.quote.extras = str(q.extras, 1000) || order.quote.extras;
  order.quote.distance = str(q.distance, 500) || order.quote.distance;
  order.quote.driveLabor = str(q.driveLabor, 500) || order.quote.driveLabor;
  order.quote.serviceTime = str(q.serviceTime, 200) || order.quote.serviceTime;
  if (body.callbackMessage) order.callbackMessage = str(body.callbackMessage, 2000);
}

// Order ids are random; on the rare collision, roll a new one. `beforeCreate` runs once per
// candidate id and can veto creation (returns false), which is how the visit reference is claimed.
async function createWithFreshId(store, order, beforeCreate) {
  for (let i = 0; i < 5; i++) {
    if (i > 0) order.id = newOrderId();
    if (await getOrder(store, order.id)) continue;
    if (beforeCreate && !(await beforeCreate(order.id))) return null;
    const etag = await createOrder(store, order);
    if (etag) return etag;
  }
  return null;
}

export const config = { path: '/api/leads' };
