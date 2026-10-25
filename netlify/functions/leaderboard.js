// Proxies leaderboard reads/writes to the Google Apps Script Web App, server-side.
// This keeps the browser talking only to fireball.pizza (same-origin), avoiding the
// CORS and Opaque Response Blocking issues that come from calling Apps Script directly
// from client-side JS (Apps Script's redirect-based content serving doesn't play well
// with browser cross-origin protections).

const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxPN3Geg2AQ73vE8xKUZeZHHDr4laLLJiHwGpM8eEezlHWNnUhUlTEFGyY7pg7gDR4o/exec';

const baseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Writes and errors must never be cached.
const noCacheHeaders = {
  ...baseHeaders,
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Netlify-CDN-Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

// Successful reads: the browser always revalidates, but Netlify's edge holds the
// response for 10 seconds so a burst of players doesn't each wait on Apps Script.
const readHeaders = {
  ...baseHeaders,
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, max-age=10',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...noCacheHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  const scriptUrl = process.env.LEADERBOARD_SCRIPT_URL || DEFAULT_SCRIPT_URL;

  try {
    if (event.httpMethod === 'GET') {
      const response = await fetch(scriptUrl);
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error('Fireball leaderboard: non-JSON response from Apps Script', text.slice(0, 300));
        return { statusCode: 502, headers: noCacheHeaders, body: JSON.stringify({ error: 'Leaderboard is temporarily unavailable.' }) };
      }
      return { statusCode: 200, headers: readHeaders, body: JSON.stringify(data) };
    }

    if (event.httpMethod === 'POST') {
      let payload;
      try {
        payload = JSON.parse(event.body || '{}');
      } catch (err) {
        return { statusCode: 400, headers: noCacheHeaders, body: JSON.stringify({ ok: false, error: 'Invalid request body' }) };
      }

      const response = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ initials: payload.initials, score: payload.score }),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error('Fireball leaderboard: non-JSON response on submit', text.slice(0, 300));
        return { statusCode: 502, headers: noCacheHeaders, body: JSON.stringify({ ok: false, error: 'Could not submit score right now.' }) };
      }
      return { statusCode: 200, headers: noCacheHeaders, body: JSON.stringify(data) };
    }

    return { statusCode: 405, headers: noCacheHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error('Fireball leaderboard: function error', err);
    return { statusCode: 500, headers: noCacheHeaders, body: JSON.stringify({ error: 'Something went wrong reaching the leaderboard.' }) };
  }
};
