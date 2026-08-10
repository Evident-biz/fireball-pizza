// Sends a customer-facing confirmation email via Resend.
// Fires alongside the existing internal Netlify Forms notification (which only reaches Paul).
// Keeps RESEND_API_KEY safely on the server, never exposed to the browser.

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

  const { type, name, email, eventDate, eventTime, address, guestCount, totalQuote, depositAmount } = payload;

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name || !email || !emailPattern.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid name and email are required' }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('Fireball confirmation email: missing RESEND_API_KEY');
    // Don't fail the customer's booking flow over this. Log it and move on quietly.
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true }) };
  }

  const firstName = String(name).trim().split(/\s+/)[0] || 'there';
  const formattedDate = eventDate
    ? new Date(eventDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  let subject, introLine, statusBlock;

  if (type === 'quote') {
    subject = 'Your Fireball Pizza catering quote';
    introLine = "Here's a copy of the quote you just built for your event.";
    statusBlock = 'This is an estimate, not a confirmed booking yet. Your date isn\'t reserved until a deposit is paid or a reservation is locked in.';
  } else if (type === 'deposit') {
    subject = 'Your Fireball Pizza catering deposit is confirmed';
    introLine = "We've received your deposit and your date is officially reserved.";
    statusBlock = "We'll follow up with any final details before your event. If anything needs adjusting, just reply to this email.";
  } else if (type === 'reservation') {
    subject = 'Your Fireball Pizza catering date is reserved';
    introLine = "Your date is reserved. We'll follow up to confirm payment arrangements.";
    statusBlock = "We'll be in touch within 1 to 2 business days to finalize payment details for your event.";
  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown confirmation type' }) };
  }

  const detailRows = [];
  if (formattedDate) detailRows.push(['Event date', formattedDate]);
  if (eventTime) detailRows.push(['Start time', eventTime]);
  if (address) detailRows.push(['Event address', address]);
  if (guestCount) detailRows.push(['Guest count', String(guestCount)]);
  if (totalQuote) detailRows.push(['Total quote', totalQuote]);
  if (depositAmount) detailRows.push(['Deposit amount', depositAmount]);

  const detailRowsHtml = detailRows
    .map(function (row) {
      return '<tr><td style="padding:6px 0; color:#6E655C; font-size:14px;">' + row[0] + '</td>' +
        '<td style="padding:6px 0; text-align:right; font-weight:600; color:#1B1512; font-size:14px;">' + row[1] + '</td></tr>';
    })
    .join('');

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#1B1512;">' +
    '<h2 style="color:#E23A25; margin-bottom:4px;">Fireball Pizza</h2>' +
    '<p style="font-size:16px;">Hi ' + firstName + ',</p>' +
    '<p style="font-size:15px; line-height:1.5;">' + introLine + '</p>' +
    (detailRowsHtml ? '<table style="width:100%; border-collapse:collapse; margin:20px 0; border-top:1px solid #ECE7DF; border-bottom:1px solid #ECE7DF;">' + detailRowsHtml + '</table>' : '') +
    '<p style="font-size:14px; color:#6E655C; line-height:1.5;">' + statusBlock + '</p>' +
    '<p style="font-size:14px; color:#6E655C; line-height:1.5;">Questions? Just reply to this email or call us at (209) 222-8926.</p>' +
    '<p style="font-size:13px; color:#6E655C; margin-top:32px;">Fireball Pizza &middot; Modesto, CA</p>' +
    '</div>';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Fireball Pizza <eat@fireball.pizza>',
        to: [email],
        reply_to: 'eat@fireball.pizza',
        subject: subject,
        html: html,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Fireball confirmation email: Resend API error', response.status, JSON.stringify(data));
      // Same philosophy: don't block the customer's flow if the email fails to send.
      return { statusCode: 200, headers, body: JSON.stringify({ sent: false, error: data }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ sent: true, id: data.id }) };
  } catch (err) {
    console.error('Fireball confirmation email: function error', err);
    return { statusCode: 200, headers, body: JSON.stringify({ sent: false }) };
  }
};
