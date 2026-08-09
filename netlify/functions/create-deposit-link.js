// Creates a Square Payment Link for an exact deposit amount, server-side.
// Keeps SQUARE_ACCESS_TOKEN safely on the server — it never reaches the browser.

const SANDBOX_BASE = 'https://connect.squareupsandbox.com';
const PRODUCTION_BASE = 'https://connect.squareup.com';
const SQUARE_API_VERSION = '2026-07-15';

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { amount, description, referenceId } = payload;

  // amount is expected as whole/decimal dollars (e.g. 238.00), converted to cents below.
  const amountNumber = Number(amount);
  if (!amountNumber || amountNumber <= 0 || !isFinite(amountNumber)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid positive amount is required' }) };
  }

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  const environment = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();

  if (!accessToken || !locationId) {
    console.error('Fireball deposit link: missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Payment system is not configured yet. Please contact us directly to pay your deposit.' }),
    };
  }

  const baseUrl = environment === 'production' ? PRODUCTION_BASE : SANDBOX_BASE;
  const amountCents = Math.round(amountNumber * 100);

  const idempotencyKey =
    (referenceId ? String(referenceId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 30) + '-' : '') +
    Date.now() +
    '-' +
    Math.random().toString(36).slice(2, 10);

  const requestBody = {
    idempotency_key: idempotencyKey,
    quick_pay: {
      name: description || 'Fireball Pizza Catering Deposit',
      price_money: {
        amount: amountCents,
        currency: 'USD',
      },
      location_id: locationId,
    },
  };

  try {
    const response = await fetch(baseUrl + '/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Square-Version': SQUARE_API_VERSION,
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    if (!response.ok || !data.payment_link) {
      console.error('Fireball deposit link: Square API error', response.status, JSON.stringify(data));
      const message = (data.errors && data.errors[0] && data.errors[0].detail) || 'Could not create payment link';
      return { statusCode: 502, headers, body: JSON.stringify({ error: message }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        url: data.payment_link.url,
        id: data.payment_link.id,
      }),
    };
  } catch (err) {
    console.error('Fireball deposit link: function error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Something went wrong creating the payment link.' }) };
  }
};
