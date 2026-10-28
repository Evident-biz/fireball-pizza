// Small helpers shared by the portal functions.

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

// No 0/O/1/I/L so order numbers read cleanly over the phone.
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function newOrderId() {
  const bytes = randomBytes(6);
  let out = 'FB-';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

export function newToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export function newNoteId() {
  return randomBytes(6).toString('hex');
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function errorResponse(status, message) {
  return json({ error: message }, status);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJson(req, maxBytes = 64 * 1024) {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid request body');
  }
}

export function str(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

export function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function money(value) {
  const n = num(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value);
}

export function normalizeEmail(value) {
  return str(value, 254).toLowerCase();
}

export function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function siteUrl(req) {
  return process.env.URL || new URL(req.url).origin;
}

// Pulls "Modesto" out of "123 Main St, Modesto, CA 95354, USA" for reporting by city.
export function cityFromAddress(address) {
  if (!address) return '';
  const parts = String(address).split(',').map((p) => p.trim()).filter(Boolean);
  // The city is the part right before "CA 95354" (state, optional zip).
  const stateIndex = parts.findIndex((p, i) => i > 0 && /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(p));
  if (stateIndex > 0) return parts[stateIndex - 1];
  // "Modesto CA 95354" written without a comma before the state.
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const match = last.match(/^(.+?)\s+[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/);
  return match ? match[1] : '';
}
