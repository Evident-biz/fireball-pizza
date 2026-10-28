// Test harness: a real local Netlify Blobs server, plus fakes for Square, Resend and Identity.

import { BlobsServer } from '@netlify/blobs/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const ORIGIN = 'https://fireball.test';

export async function startBlobs() {
  const directory = await mkdtemp(path.join(tmpdir(), 'fireball-blobs-'));
  const token = 'test-token';
  const server = new BlobsServer({ directory, token, port: 0 });
  const { port } = await server.start();
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(
    JSON.stringify({ edgeURL: 'http://localhost:' + port, uncachedEdgeURL: 'http://localhost:' + port, siteID: 'site-test', token })
  ).toString('base64');
  return { stop: async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); } };
}

// Records outgoing Square/Resend calls and answers them; everything else (the blobs server) goes through.
export function fakeExternalApis() {
  const realFetch = globalThis.fetch;
  const calls = { square: [], email: [] };
  let linkCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('squareup')) {
      const body = JSON.parse(init.body);
      calls.square.push(body);
      linkCount++;
      return Response.json({ payment_link: { id: 'pl_' + linkCount, url: 'https://square.link/u/test' + linkCount, order_id: 'sqorder_' + linkCount } });
    }
    if (u.includes('api.resend.com')) {
      calls.email.push(JSON.parse(init.body));
      return Response.json({ id: 'email_' + calls.email.length });
    }
    return realFetch(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

export function request(pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Request(ORIGIN + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? { Origin: ORIGIN } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export const context = { deploy: { context: 'production' } };

// A different Monday-Wednesday date for every order, so test orders never collide on availability.
let dayOffset = 0;
export function uniqueWeekday() {
  for (;;) {
    const d = new Date(Date.UTC(2027, 0, 4) + dayOffset++ * 86400000);
    if ([1, 2, 3].includes(d.getUTCDay())) return d.toISOString().slice(0, 10);
  }
}

export function cateringPayload(overrides = {}) {
  return {
    kind: 'catering',
    clientRef: 'visit-' + Math.random().toString(36).slice(2) + '-0123456789',
    stage: 'quote_built',
    customer: { name: 'Jane Customer', email: 'Jane@Example.com', phone: '209-555-0100' },
    event: { date: uniqueWeekday(), timeLabel: '5:00 PM', address: '123 Main St, Turlock, CA 95380, USA', guestCount: 60 },
    quote: { total: '1,240.50', deposit: '620.25', pricingSummary: 'Style: Buffet ($19/guest) | Grand Total: $1,240.50', serviceStyle: 'Buffet' },
    ...overrides,
  };
}
