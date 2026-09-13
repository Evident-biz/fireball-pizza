// Proxies leaderboard reads/writes to the Google Apps Script Web App, server-side.
// This keeps the browser talking only to fireball.pizza (same-origin), avoiding the
// CORS and Opaque Response Blocking issues that come from calling Apps Script directly
// from client-side JS (Apps Script's redirect-based content serving doesn't play well
// with browser cross-origin protections).

const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxO7oDTLRb8BWkAdXmcsYIkKj9LToGX2Gx3DBQDX7nX_qdg4RV7ptHN98nh3NQYB9tp/exec';

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Netlify-CDN-Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...headers,
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
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Leaderboard is temporarily unavailable.' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (event.httpMethod === 'POST') {
      let payload;
      try {
        payload = JSON.parse(event.body || '{}');
      } catch (err) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid request body' }) };
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
        return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'Could not submit score right now.' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error('Fireball leaderboard: function error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Something went wrong reaching the leaderboard.' }) };
  }
};
