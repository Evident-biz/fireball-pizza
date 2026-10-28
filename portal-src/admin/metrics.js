// Numbers for the dashboard and reports, computed from order summaries in the browser.

import { todayIso, addDaysIso, daysUntil } from './ui.js';

export const OPEN_PIPELINE = ['lead', 'pending_deposit', 'reserved'];
export const WON = ['booked', 'completed'];
export const HOLDING = ['booked', 'reserved'];

// Mirrors netlify/lib/availability.mjs; the values come from the server in state.meta.
export function isMarketDay(date, meta) {
  if (!date) return false;
  return (meta?.marketDays || [4, 6]).includes(new Date(date + 'T00:00:00').getDay());
}

// Problems with an order's date: another Booked/Reserved event that day, or a market day under the guest minimum.
export function dateProblems(order, orders, meta) {
  const problems = [];
  if (order.type !== 'catering' || !order.eventDate || ['cancelled', 'lost', 'completed'].includes(order.status)) return problems;
  const others = orders.filter((o) => o.id !== order.id && o.type === 'catering' && HOLDING.includes(o.status) && o.eventDate === order.eventDate);
  if (others.length && (HOLDING.includes(order.status) || order.status === 'pending_deposit')) {
    problems.push({ code: 'double', text: 'Double booked: ' + others.map((o) => o.name || o.id).join(', ') + ' also has this date', others });
  }
  const min = meta?.marketMinGuests || 40;
  if (isMarketDay(order.eventDate, meta) && order.guestCount && order.guestCount < min) {
    problems.push({ code: 'market', text: 'Farmers market day with ' + order.guestCount + ' guests (minimum is ' + min + ')' });
  }
  return problems;
}

export function catering(orders) {
  return orders.filter((o) => o.type === 'catering');
}

export function sum(list, fn) {
  return Math.round(list.reduce((s, x) => s + (Number(fn(x)) || 0), 0) * 100) / 100;
}

export function monthKey(iso) {
  return iso ? iso.slice(0, 7) : '';
}

export function monthLabel(key, short = true) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', short ? { month: 'short' } : { month: 'long', year: 'numeric' });
}

export function monthsAround(back, forward) {
  const now = new Date();
  const keys = [];
  for (let i = -back; i <= forward; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    keys.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }
  return keys;
}

// Things someone should act on, most urgent first.
export function attentionItems(orders, meta) {
  const today = todayIso();
  const items = [];
  for (const o of orders) {
    if (!o.eventDate || o.eventDate >= today) {
      for (const p of dateProblems(o, orders, meta)) items.push({ order: o, rank: 0, reason: p.text });
    }
    if (o.customerMessage) items.push({ order: o, rank: 0, reason: 'Customer sent a message' });
    if (o.callbackRequested && !['cancelled', 'lost', 'completed'].includes(o.status)) items.push({ order: o, rank: 1, reason: 'Wants a callback' });
    if (o.dateUnavailable && o.status === 'lead') items.push({ order: o, rank: 2, reason: o.dateUnavailable === 'booked' ? 'Wanted a date we already have booked. Offer another day?' : 'Wanted a market day with under 40 guests. Offer another day?' });
    if (o.type === 'inquiry' && o.status === 'new') items.push({ order: o, rank: 2, reason: 'New inquiry: ' + (o.category || 'General') });
    if (o.type !== 'catering') continue;
    const days = daysUntil(o.eventDate);
    if (o.status === 'pending_deposit' && Date.now() - Date.parse(o.updatedAt) > 2 * 86400000 && o.paid === 0) {
      items.push({ order: o, rank: 3, reason: 'Started paying the deposit but never finished' });
    }
    if (o.status === 'reserved' && o.paid === 0 && days !== null && days <= 14 && days >= 0) {
      items.push({ order: o, rank: 3, reason: 'Reserved, no payment yet, event in ' + days + ' days' });
    }
    if (o.status === 'booked' && days !== null && days >= 0 && days <= 7 && o.balance > 0) {
      items.push({ order: o, rank: 4, reason: 'Event in ' + days + ' days, balance due' });
    }
    if (['lead', 'pending_deposit', 'reserved', 'booked'].includes(o.status) && o.eventDate && o.eventDate < today) {
      items.push({ order: o, rank: 5, reason: 'Event date has passed. Mark it completed or lost?' });
    }
  }
  return items.sort((a, b) => a.rank - b.rank || (a.order.eventDate || '9').localeCompare(b.order.eventDate || '9'));
}

export function upcomingEvents(orders, days = 60) {
  const today = todayIso();
  const until = addDaysIso(today, days);
  return catering(orders)
    .filter((o) => ['booked', 'reserved', 'pending_deposit'].includes(o.status) && o.eventDate && o.eventDate >= today && o.eventDate <= until)
    .sort((a, b) => (a.eventDate + (a.eventTime || '')).localeCompare(b.eventDate + (b.eventTime || '')));
}

export function paymentsInMonth(orders, key) {
  let total = 0;
  for (const o of orders) for (const p of o.payments || []) if (monthKey(p.at) === key) total += Number(p.amount) || 0;
  return Math.round(total * 100) / 100;
}

export function inRange(o, from, to, field = 'createdAt') {
  const value = field === 'createdAt' ? o.createdAt.slice(0, 10) : o[field];
  if (!value) return false;
  return (!from || value >= from) && (!to || value <= to);
}

export function groupBy(list, keyFn) {
  const map = new Map();
  for (const x of list) {
    const k = keyFn(x) || 'Unknown';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}

export function customersFrom(orders) {
  const map = new Map();
  for (const o of orders) {
    const key = (o.email || o.phone || o.name || o.id).toLowerCase();
    if (!map.has(key)) map.set(key, { key, name: o.name, email: o.email, phone: o.phone, company: o.company, orders: [], firstSeen: o.createdAt });
    const c = map.get(key);
    c.orders.push(o);
    if (o.createdAt < c.firstSeen) c.firstSeen = o.createdAt;
    // Newest details win.
    if (!c.latest || o.createdAt > c.latest) {
      c.latest = o.createdAt;
      c.name = o.name || c.name;
      c.phone = o.phone || c.phone;
      c.company = o.company || c.company;
    }
  }
  return [...map.values()].map((c) => {
    const won = c.orders.filter((o) => o.type === 'catering' && WON.includes(o.status));
    const eventDates = c.orders.map((o) => o.eventDate).filter(Boolean).sort();
    return {
      ...c,
      orderCount: c.orders.length,
      bookedCount: won.length,
      lifetimeValue: sum(won, (o) => o.total),
      paid: sum(c.orders, (o) => o.paid),
      lastEvent: eventDates[eventDates.length - 1] || '',
      repeat: won.length > 1,
    };
  });
}
