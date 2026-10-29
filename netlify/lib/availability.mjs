// Catering date availability.
//
// Nothing is ever refused. A date that breaks a rule is still accepted, the customer is told
// we'll confirm it, and the order is flagged (status "Date to Confirm") for staff to check.
//
// Rules:
//   1. One catering event per day. A date is taken once any catering order on it is
//      Booked or Reserved. Leads and abandoned deposit pages don't hold a date.
//   2. Thursdays and Saturdays we're at the Modesto Farmers Market, so catering on those
//      days is only accepted for 40 or more guests.
//
// A day with an event on the private Google Calendar (see gcal.mjs) also counts as taken.
//
// Taken dates are tracked with marker keys (hold/<date>/<orderId>) that store.mjs keeps in
// sync on every order write, so checking a date is one small list call.

import { busyDates } from './gcal.mjs';

export const HOLDING_STATUSES = ['booked', 'reserved'];
export const MARKET_DAYS = [4, 6]; // Thursday, Saturday (0 = Sunday)
export const MARKET_MIN_GUESTS = 40;
export const MARKET_NAME = 'the Modesto Farmers Market';

export function holdKey(order) {
  if (order.type !== 'catering' || !HOLDING_STATUSES.includes(order.status) || !/^\d{4}-\d{2}-\d{2}$/.test(order.event?.date || '')) return '';
  return 'hold/' + order.event.date + '/' + order.id;
}

export function isMarketDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  return MARKET_DAYS.includes(new Date(date + 'T00:00:00Z').getUTCDay());
}

export async function holdsOn(store, date) {
  const prefix = 'hold/' + date + '/';
  const { blobs } = await store.list({ prefix });
  return blobs.map((b) => b.key.slice(prefix.length));
}

// Returns { available, code, message }. `excludeId` lets an order check its own date
// without being blocked by itself. Pass `guests` as null when the count isn't known yet.
export async function checkDate(store, date, guests, excludeId = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { available: true, code: 'no_date', message: '' };
  const taken = (await holdsOn(store, date)).filter((id) => id !== excludeId);
  const calendarEvents = (await busyDates(store)).get(date) || [];
  if (taken.length || calendarEvents.length) {
    return {
      available: false,
      code: 'booked',
      message: "Heads up: we may already have an event that day. You can still book, and we'll confirm your date within 1 to 2 business days.",
      // Internal only (order ids and calendar titles); never sent to customers.
      conflicts: taken,
      calendarEvents,
    };
  }
  if (isMarketDay(date)) {
    const rule = "Thursdays and Saturdays we're at " + MARKET_NAME + ', so on those days we usually cater events of ' + MARKET_MIN_GUESTS + ' guests or more.';
    const confirm = rule + " You can still book, and we'll confirm your date within 1 to 2 business days.";
    if (guests === null || guests === undefined || guests === '') {
      // Guest count not chosen yet: the date is fine, but tell them the rule up front.
      return { available: true, code: 'market_day', marketDay: true, message: rule };
    }
    const ok = Number(guests) >= MARKET_MIN_GUESTS;
    return { available: ok, code: ok ? 'market_ok' : 'market_min', marketDay: true, message: ok ? '' : confirm };
  }
  return { available: true, code: 'open', message: '' };
}
