// Netlify Blobs access for the order system.
//
// Layout inside the store:
//   order/<id>                      full order record (JSON)
//   ref/<sha256(clientRef)>         -> order id, so the catering builder's repeat submissions update one order
//   email/<sha256(email)>/<id>      empty marker, lets the customer portal find a customer's orders
//   sq/<squareOrderId>              -> order id, lets the Square webhook find the order a payment belongs to
//   magic/<token>                   one-time "my orders" sign-in link for customers
//   hold/<date>/<id>                empty marker: this order (Booked or Reserved) holds that date
//
// Blobs is last-write-wins. Every order write goes through an ETag check (onlyIfMatch),
// so two people saving the same order at once get a conflict instead of silently
// overwriting each other.

import { getStore } from '@netlify/blobs';
import { sha256 } from './util.mjs';
import { holdKey } from './availability.mjs';

// Deploy previews and branch deploys get their own store so testing never touches real orders.
export function crmStore(context) {
  const deployContext = context?.deploy?.context || 'production';
  const name = deployContext === 'production' ? 'fireball-crm' : 'fireball-crm-' + deployContext.replace(/[^a-z0-9-]/gi, '');
  return getStore({ name, consistency: 'strong' });
}

export async function getOrder(store, id) {
  if (!id || !/^FB-[A-Z0-9]{4,12}$/.test(id)) return null;
  const key = 'order/' + id;
  const result = await store.getWithMetadata(key, { type: 'json' });
  if (!result || !result.data) return null;
  let etag = result.etag;
  if (!etag) {
    // Some environments (the local Blobs server) leave the ETag off reads; listing always has it.
    const { blobs } = await store.list({ prefix: key });
    etag = blobs.find((b) => b.key === key)?.etag;
  }
  return { order: result.data, etag };
}

export async function createOrder(store, order) {
  const previousHold = order.holdKey || '';
  order.holdKey = holdKey(order);
  const result = await store.setJSON('order/' + order.id, order, { onlyIfNew: true });
  if (!result.modified) {
    order.holdKey = previousHold;
    return null;
  }
  if (order.customer?.email) await indexEmail(store, order.customer.email, order.id);
  if (order.holdKey) await store.set(order.holdKey, '');
  return result.etag;
}

// Returns the new ETag, or null when someone else changed the order since `etag` was read.
// Also moves the order's date marker when its status or date changed.
export async function writeOrder(store, order, etag) {
  // Never fall back to an unconditional write: without an ETag there is no conflict check.
  if (!etag) return null;
  const previousHold = order.holdKey || '';
  order.holdKey = holdKey(order);
  const result = await store.setJSON('order/' + order.id, order, { onlyIfMatch: etag });
  if (!result.modified) {
    order.holdKey = previousHold;
    return null;
  }
  if (order.holdKey !== previousHold) {
    if (order.holdKey) await store.set(order.holdKey, '');
    if (previousHold) await store.delete(previousHold);
  }
  return result.etag;
}

// Read-modify-write with retries, for server-side updates (webhooks, customer requests)
// where there is no person to show a conflict to. `mutate` may return false to skip the write.
export async function updateOrder(store, id, mutate, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const current = await getOrder(store, id);
    if (!current) return null;
    const previousEmail = current.order.customer?.email;
    const next = structuredClone(current.order);
    const keep = await mutate(next);
    if (keep === false) return current.order;
    const etag = await writeOrder(store, next, current.etag);
    if (etag) {
      if (next.customer?.email !== previousEmail) await reindexEmail(store, previousEmail, next.customer?.email, id);
      return next;
    }
  }
  throw new Error('Could not save order ' + id + ' after ' + attempts + ' attempts');
}

export async function listOrders(store) {
  const { blobs } = await store.list({ prefix: 'order/' });
  const keys = blobs.map((b) => b.key);
  const orders = [];
  // Parallel reads in batches. Fine for thousands of orders; well past what catering volume needs.
  const BATCH = 25;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = await Promise.all(keys.slice(i, i + BATCH).map((key) => store.get(key, { type: 'json' })));
    for (const order of batch) if (order) orders.push(order);
  }
  return orders;
}

export async function deleteOrder(store, order) {
  await store.delete('order/' + order.id);
  if (order.customer?.email) await store.delete('email/' + sha256(order.customer.email.toLowerCase()) + '/' + order.id);
  if (order.clientRefHash) await store.delete('ref/' + order.clientRefHash);
  for (const sq of order.payment?.squareOrderIds || []) await store.delete('sq/' + sq);
  if (order.holdKey) await store.delete(order.holdKey);
}

export async function indexEmail(store, email, id) {
  if (!email) return;
  await store.set('email/' + sha256(email.toLowerCase()) + '/' + id, '');
}

export async function reindexEmail(store, oldEmail, newEmail, id) {
  if (oldEmail) await store.delete('email/' + sha256(oldEmail.toLowerCase()) + '/' + id);
  if (newEmail) await indexEmail(store, newEmail, id);
}

export async function orderIdsForEmail(store, email) {
  const prefix = 'email/' + sha256(email.toLowerCase()) + '/';
  const { blobs } = await store.list({ prefix });
  return blobs.map((b) => b.key.slice(prefix.length));
}

export async function lookupRef(store, kind, value) {
  const id = await store.get(kind + '/' + value);
  return id || null;
}

export async function setRef(store, kind, value, id, onlyIfNew = false) {
  const result = await store.set(kind + '/' + value, id, onlyIfNew ? { onlyIfNew: true } : {});
  return result.modified;
}
