// Order record shape, statuses and the rules for how an order moves through them.

import { newNoteId, cityFromAddress, money } from './util.mjs';

export const CATERING_STATUSES = [
  { id: 'lead', label: 'Lead', help: 'Built or viewed a quote, nothing committed yet' },
  { id: 'pending_deposit', label: 'Deposit Pending', help: 'Opened the payment page, payment not confirmed' },
  { id: 'reserved', label: 'Reserved', help: 'Date held, paying by cash or check' },
  { id: 'booked', label: 'Booked', help: 'Deposit paid or confirmed by staff' },
  { id: 'completed', label: 'Completed', help: 'Event is done' },
  { id: 'cancelled', label: 'Cancelled', help: 'Customer cancelled' },
  { id: 'lost', label: 'Lost', help: 'Never booked' },
];

export const INQUIRY_STATUSES = [
  { id: 'new', label: 'New' },
  { id: 'open', label: 'In Progress' },
  { id: 'replied', label: 'Replied' },
  { id: 'closed', label: 'Closed' },
  { id: 'spam', label: 'Spam' },
];

export const PAYMENT_METHODS = ['card', 'afterpay', 'cash', 'check', 'other'];

export const ORDER_TYPES = ['catering', 'inquiry'];

// Stages the public catering builder reports, mapped to the status they move an order to.
// Public submissions can only move an order forward along this ladder, never backward,
// and never once staff have taken it past "reserved".
const STAGE_TO_STATUS = {
  quote_viewed: 'lead',
  quote_built: 'lead',
  callback_requested: 'lead',
  deposit_initiated: 'pending_deposit',
  reserved_no_deposit: 'reserved',
};
const PUBLIC_LADDER = ['lead', 'pending_deposit', 'reserved'];

export function isValidStatus(type, status) {
  const list = type === 'catering' ? CATERING_STATUSES : INQUIRY_STATUSES;
  return list.some((s) => s.id === status);
}

export function statusLabel(type, status) {
  const list = type === 'catering' ? CATERING_STATUSES : INQUIRY_STATUSES;
  return list.find((s) => s.id === status)?.label || status;
}

export function publicStageStatus(stage) {
  return STAGE_TO_STATUS[stage] || 'lead';
}

// Can a public (customer-side) submission still change this order?
export function publicCanUpdate(order) {
  return order.type === 'catering' && PUBLIC_LADDER.includes(order.status);
}

export function advanceFromPublic(order, stage) {
  const target = publicStageStatus(stage);
  if (PUBLIC_LADDER.indexOf(target) > PUBLIC_LADDER.indexOf(order.status)) order.status = target;
  if (stage === 'callback_requested') order.flags.callbackRequested = true;
}

export function blankOrder({ id, type, now, by = 'website' }) {
  return {
    id,
    type,
    status: type === 'catering' ? 'lead' : 'new',
    createdAt: now,
    updatedAt: now,
    source: by === 'website' ? 'website' : 'staff',
    customer: { name: '', email: '', phone: '', company: '' },
    event: { date: '', time: '', address: '', city: '', guestCount: null, serviceStyle: '' },
    quote: { total: null, deposit: null, pricingSummary: '', extras: '', distance: '', driveLabor: '', serviceTime: '' },
    payment: { payments: [], squareOrderIds: [], depositLinkUrl: '' },
    inquiry: { category: '', message: '' },
    callbackMessage: '',
    assignee: '',
    tags: [],
    flags: { callbackRequested: false },
    notes: [],
    activity: [],
    portalToken: '',
    clientRefHash: '',
    stages: [],
  };
}

export function logActivity(order, by, action, detail = '') {
  order.activity.push({ id: newNoteId(), at: new Date().toISOString(), by, action, detail: String(detail).slice(0, 500) });
  if (order.activity.length > 300) order.activity = order.activity.slice(-300);
  order.updatedAt = new Date().toISOString();
}

export function setAddress(order, address) {
  order.event.address = address;
  order.event.city = cityFromAddress(address);
}

export function paidTotal(order) {
  return money(order.payment.payments.filter((p) => !p.refunded).reduce((sum, p) => sum + (Number(p.amount) || 0), 0)) || 0;
}

export function balanceDue(order) {
  if (order.quote.total === null || order.quote.total === undefined) return null;
  return money(Math.max(0, order.quote.total - paidTotal(order)));
}

// Deposit if nothing has been paid yet, otherwise the remaining balance.
export function amountToCollect(order) {
  if (order.type !== 'catering' || ['cancelled', 'lost'].includes(order.status)) return null;
  if (paidTotal(order) === 0 && order.quote.deposit > 0) return { amount: order.quote.deposit, kind: 'deposit' };
  const balance = balanceDue(order);
  if (balance > 0) return { amount: balance, kind: 'balance' };
  return null;
}

export function addPayment(order, { amount, method, note = '', at, squarePaymentId = '', by }) {
  if (squarePaymentId && order.payment.payments.some((p) => p.squarePaymentId === squarePaymentId)) return false;
  order.payment.payments.push({
    id: newNoteId(),
    amount: money(amount),
    method,
    note,
    at: at || new Date().toISOString(),
    squarePaymentId,
    recordedBy: by,
    refunded: false,
  });
  return true;
}

// What staff see in list views. Keeps list payloads small.
export function summarize(order) {
  return {
    id: order.id,
    type: order.type,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    name: order.customer.name,
    email: order.customer.email,
    phone: order.customer.phone,
    company: order.customer.company,
    eventDate: order.event.date,
    eventTime: order.event.time,
    city: order.event.city,
    address: order.event.address,
    guestCount: order.event.guestCount,
    total: order.quote.total,
    deposit: order.quote.deposit,
    paid: paidTotal(order),
    balance: balanceDue(order),
    category: order.inquiry.category,
    preview: (order.inquiry.message || order.callbackMessage || '').slice(0, 140),
    assignee: order.assignee,
    tags: order.tags,
    callbackRequested: !!order.flags.callbackRequested,
    customerMessage: !!order.flags.customerMessage,
    serviceStyle: order.event.serviceStyle,
    payments: order.payment.payments.filter((p) => !p.refunded).map((p) => ({ amount: p.amount, at: p.at, method: p.method })),
    source: order.source,
    noteCount: order.notes.length,
  };
}

// What the customer sees on their status page. No internal notes, no staff activity.
export function customerView(order) {
  const timeline = [];
  timeline.push({ label: 'Request received', done: true, at: order.createdAt });
  const depositPaid = order.payment.payments.some((p) => !p.refunded);
  timeline.push({ label: 'Deposit paid', done: depositPaid });
  timeline.push({ label: 'Booking confirmed', done: ['booked', 'completed'].includes(order.status) });
  timeline.push({ label: 'Event day', done: order.status === 'completed', at: order.event.date || null });

  return {
    id: order.id,
    type: order.type,
    status: order.status,
    statusLabel: statusLabel(order.type, order.status),
    createdAt: order.createdAt,
    customer: { name: order.customer.name, email: order.customer.email, phone: order.customer.phone },
    event: order.event,
    quote: {
      total: order.quote.total,
      deposit: order.quote.deposit,
      pricingSummary: order.quote.pricingSummary,
      extras: order.quote.extras,
    },
    paid: paidTotal(order),
    balance: balanceDue(order),
    payments: order.payment.payments.filter((p) => !p.refunded).map((p) => ({ amount: p.amount, method: p.method, at: p.at })),
    amountDue: amountToCollect(order),
    canRequestChange: !['completed', 'cancelled', 'lost'].includes(order.status),
    customerMessages: order.notes.filter((n) => n.fromCustomer).map((n) => ({ at: n.at, text: n.text })),
    timeline: order.type === 'catering' ? timeline : [],
  };
}
