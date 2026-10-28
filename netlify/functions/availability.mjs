// Public date check for the catering builder.
//   GET /api/availability?date=YYYY-MM-DD&guests=60
// Says whether the date can be booked, and why not. Never reveals who booked a date.

import { crmStore } from '../lib/store.mjs';
import { checkDate, MARKET_DAYS, MARKET_MIN_GUESTS } from '../lib/availability.mjs';
import { json, errorResponse, num } from '../lib/util.mjs';

export default async (req, context) => {
  if (req.method !== 'GET') return errorResponse(405, 'Method not allowed');
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errorResponse(400, 'Pass a date as YYYY-MM-DD');
  const guests = url.searchParams.has('guests') ? num(url.searchParams.get('guests')) : null;
  try {
    const result = await checkDate(crmStore(context), date, guests);
    return json({ date, available: result.available, code: result.code, message: result.message, marketDays: MARKET_DAYS, marketMinGuests: MARKET_MIN_GUESTS });
  } catch (err) {
    console.error('Fireball availability check failed', err);
    return errorResponse(500, 'Could not check that date');
  }
};

export const config = { path: '/api/availability' };
