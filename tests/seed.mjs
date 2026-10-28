// Sample orders for the local dev server, so every portal screen has something to show.

const NAMES = ['Maria Lopez', 'Jake Thompson', 'Priya Patel', 'Chris Nguyen', 'Ashley Brooks', 'Daniel Kim', 'Sofia Ramirez', 'Tyler Johnson', 'Emma Wilson', 'Luis Garcia', 'Hannah Lee', 'Marcus Davis', 'Olivia Martinez', 'Ben Carter', 'Grace Hall', 'Noah Allen', 'Ava Young', 'Ethan Scott'];
const CITIES = ['Modesto, CA 95354', 'Turlock, CA 95380', 'Ceres, CA 95307', 'Manteca, CA 95336', 'Oakdale, CA 95361', 'Riverbank, CA 95367', 'Tracy, CA 95376', 'Merced, CA 95340'];
const STYLES = ['Buffet', 'Build Your Own', 'Pizza Workshop'];

function iso(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export async function seed(base) {
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) }).then((r) => r.json());
  const patch = async (id, changes) => {
    const { etag } = await fetch(base + '/api/admin/orders/' + id).then((r) => r.json());
    return fetch(base + '/api/admin/orders/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ etag, changes }) });
  };
  const plan = [
    [-150, 'completed', 2], [-120, 'completed', 2], [-95, 'completed', 2], [-70, 'completed', 2], [-60, 'lost', 0], [-40, 'completed', 2],
    [-20, 'completed', 2], [-6, 'booked', 1], [3, 'booked', 1], [5, 'reserved', 0], [9, 'booked', 1], [12, 'pending_deposit', 0],
    [18, 'booked', 2], [24, 'lead', 0], [31, 'booked', 1], [38, 'lead', 0], [45, 'cancelled', 0], [52, 'booked', 1], [66, 'lead', 0], [80, 'booked', 1],
  ];
  let i = 0;
  for (const [offset, status, payments] of plan) {
    const name = NAMES[i % NAMES.length];
    const guests = 30 + ((i * 17) % 120);
    const style = STYLES[i % STYLES.length];
    const per = style === 'Buffet' ? 19 : 25;
    const total = Math.round(guests * per * 1.08875 * 100) / 100;
    const res = await post('/api/leads', {
      kind: 'catering',
      clientRef: 'seed-visit-' + i + '-abcdefghijkl',
      stage: status === 'pending_deposit' ? 'deposit_initiated' : status === 'reserved' ? 'reserved_no_deposit' : i === 13 ? 'callback_requested' : 'quote_built',
      customer: { name, email: name.toLowerCase().replace(/\s+/g, '.') + '@example.com', phone: '(209) 555-0' + String(100 + i) },
      event: { date: iso(offset), timeLabel: ['11:00 AM', '12:30 PM', '5:00 PM', '6:30 PM'][i % 4], address: (100 + i * 7) + ' Oak St, ' + CITIES[i % CITIES.length] + ', USA', guestCount: guests },
      quote: {
        total, deposit: Math.round(total * 50) / 100, serviceStyle: style,
        pricingSummary: 'Style: ' + style + ' ($' + per + '/guest) | Base: ' + guests + ' guests × $' + per + ' | Travel fee: $0.00 | Sales tax (8.875%): $' + (total - guests * per).toFixed(2) + ' | Grand Total: $' + total.toFixed(2),
        extras: 'Caesar Salad: Yes (free booking bonus) | Cheesy Garlic Breadsticks: Yes (free booking bonus) | Cheese Ravioli: No, declined',
      },
      callbackMessage: i === 13 ? 'Can you do a gluten-free option for 6 people?' : '',
    });
    const id = res.id;
    for (let p = 0; p < payments; p++) {
      await post('/api/admin/orders/' + id + '/payments', { amount: Math.round(total * 50) / 100, method: p === 0 ? 'card' : 'check', date: iso(Math.min(offset - 30 + p * 25, -1)) });
    }
    if (!['lead', 'pending_deposit', 'reserved'].includes(status)) await patch(id, { status, assignee: i % 3 ? 'Paul' : 'Maria', tags: i % 4 === 0 ? ['corporate'] : i % 5 === 0 ? ['wedding'] : [] });
    if (i === 9) await post('/api/portal/order/message', { id, t: new URL(res.portalUrl).searchParams.get('t'), message: 'Hi! Could we push the start time to 6pm?' });
    i++;
  }
  // A repeat corporate customer.
  for (const offset of [-200, -30, 40]) {
    const r = await post('/api/leads', { kind: 'catering', clientRef: 'seed-corp-' + offset + '-abcdefghijk', stage: 'quote_built', customer: { name: 'Valley Tech Inc', email: 'events@valleytech.example', phone: '(209) 555-0999' }, event: { date: iso(offset), timeLabel: '12:00 PM', address: '500 Tech Way, Modesto, CA 95354, USA', guestCount: 120 }, quote: { total: 2482.35, deposit: 1241.18, serviceStyle: 'Buffet' } });
    await post('/api/admin/orders/' + r.id + '/payments', { amount: offset < 0 ? 2482.35 : 1241.18, method: 'card', date: iso(Math.min(offset, -1)), markBooked: true });
    if (offset < 0) await patch(r.id, { status: 'completed', tags: ['corporate', 'repeat'] });
  }
  const inquiries = [
    ['Rachel Green', 'Careers', 'Are you hiring for weekend events this summer?'],
    ['Tom Baker', 'Pricing', 'What would 250 people at a school fundraiser cost? Do you do nonprofit pricing?'],
    ['Linda Park', 'Catering Inquiry', 'Looking at a June wedding in Oakdale, about 140 guests.'],
    ['Steve Ross', 'Review / Feedback', 'You guys were amazing at our block party. Thank you!'],
  ];
  for (const [name, category, message] of inquiries) {
    await post('/api/leads', { kind: 'contact', customer: { name, email: name.toLowerCase().replace(' ', '') + '@example.com' }, inquiry: { category, message } });
  }
  console.log('Seeded sample orders');
}
