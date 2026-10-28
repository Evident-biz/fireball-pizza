import { loadOrders, setQuery } from '../app.js';
import { html, mount, money, todayIso, addDaysIso } from '../ui.js';
import { catering, sum, WON, groupBy, monthKey, monthLabel, monthsAround, inRange } from '../metrics.js';
import { columnChart, barList } from '../charts.js';

const RANGES = {
  '30': { label: 'Last 30 days', from: () => addDaysIso(todayIso(), -30) },
  '90': { label: 'Last 90 days', from: () => addDaysIso(todayIso(), -90) },
  ytd: { label: 'This year', from: () => todayIso().slice(0, 4) + '-01-01' },
  '365': { label: 'Last 12 months', from: () => addDaysIso(todayIso(), -365) },
  all: { label: 'All time', from: () => '' },
};

const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');

export async function renderReports({ main, params, isStale, setTitle }) {
  setTitle('Reports');
  const orders = await loadOrders();
  if (isStale()) return;
  let range = RANGES[params.get('range')] ? params.get('range') : '365';

  const draw = () => {
    const from = RANGES[range].from();
    // Everything here is by the date the order came in, so "conversion" compares like with like.
    const inPeriod = orders.filter((o) => inRange(o, from, ''));
    const cat = catering(inPeriod);
    const won = cat.filter((o) => WON.includes(o.status));
    const lost = cat.filter((o) => ['lost', 'cancelled'].includes(o.status));
    const open = cat.filter((o) => ['lead', 'pending_deposit', 'reserved', 'date_check'].includes(o.status));
    const inquiries = inPeriod.filter((o) => o.type === 'inquiry');
    const revenue = sum(won, (o) => o.total);
    const guests = sum(won, (o) => o.guestCount);
    const leadDays = won.filter((o) => o.eventDate).map((o) => (new Date(o.eventDate + 'T00:00:00') - new Date(o.createdAt)) / 86400000).filter((d) => d >= 0);
    const avgLead = leadDays.length ? Math.round(leadDays.reduce((a, b) => a + b, 0) / leadDays.length) : null;

    // Funnel: how far each catering lead got.
    const reachedDeposit = cat.filter((o) => ['pending_deposit', 'reserved', 'date_check', 'booked', 'completed'].includes(o.status) || o.paid > 0).length;
    const funnel = [
      { label: 'Quotes started', value: cat.length },
      { label: 'Started booking (deposit or reservation)', value: reachedDeposit, sub: pct(reachedDeposit, cat.length) + ' of quotes' },
      { label: 'Booked', value: won.length, sub: pct(won.length, cat.length) + ' of quotes' },
      { label: 'Completed', value: cat.filter((o) => o.status === 'completed').length },
    ];

    // Revenue by event month across the period (or the last 12 months for "all").
    const months = [];
    const start = from ? from.slice(0, 7) : (won.map((o) => monthKey(o.eventDate)).filter(Boolean).sort()[0] || todayIso().slice(0, 7));
    const end = [todayIso().slice(0, 7), ...won.map((o) => monthKey(o.eventDate)).filter(Boolean)].sort().pop();
    for (let d = new Date(start + '-01T00:00:00'); months.length < 36; d.setMonth(d.getMonth() + 1)) {
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (key > end) break;
      months.push(key);
    }
    const revenueByMonth = months.map((key) => {
      const list = won.filter((o) => monthKey(o.eventDate) === key);
      return { label: monthLabel(key) + (key.endsWith('-01') || key === months[0] ? ' \u2019' + key.slice(2, 4) : ''), value: sum(list, (o) => o.total), tooltip: list.length + ' events' };
    });

    const byCity = [...groupBy(won, (o) => o.city).entries()]
      .map(([city, list]) => ({ label: city, value: sum(list, (o) => o.total), sub: list.length + ' event' + (list.length === 1 ? '' : 's') }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
    const byStyle = [...groupBy(won, (o) => o.serviceStyle).entries()]
      .map(([style, list]) => ({ label: style, value: list.length, sub: money(sum(list, (o) => o.total), { cents: false }) }))
      .sort((a, b) => b.value - a.value);
    const byCategory = [...groupBy(inquiries, (o) => o.category).entries()]
      .map(([cat, list]) => ({ label: cat, value: list.length }))
      .sort((a, b) => b.value - a.value);
    // Past months only: quotes and payments can't come from the future.
    const pastMonths = monthsAround(11, 0);
    const leadsByMonth = pastMonths.map((key) => ({ label: monthLabel(key), value: cat.filter((o) => monthKey(o.createdAt) === key).length }));

    mount(main, html`
      <div class="page-head">
        <div><h1>Reports</h1><p class="muted">Orders received ${RANGES[range].label.toLowerCase()}. Revenue counts booked and completed catering.</p></div>
        <div class="page-actions">
          <div class="btn-group" role="group" aria-label="Date range">
            ${Object.entries(RANGES).map(([k, r]) => html`<button type="button" class="btn btn-ghost ${k === range ? 'active' : ''}" data-range="${k}" aria-pressed="${k === range}">${r.label}</button>`)}
          </div>
        </div>
      </div>

      <section class="kpis">
        <div class="kpi"><span class="kpi-label">Booked revenue</span><span class="kpi-value">${money(revenue, { cents: false })}</span><span class="kpi-sub">${won.length} events · ${guests} guests</span></div>
        <div class="kpi"><span class="kpi-label">Quote to booking</span><span class="kpi-value">${pct(won.length, won.length + lost.length + open.length)}</span><span class="kpi-sub">${open.length} still open, ${lost.length} lost or cancelled</span></div>
        <div class="kpi"><span class="kpi-label">Average event</span><span class="kpi-value">${won.length ? money(revenue / won.length, { cents: false }) : '-'}</span><span class="kpi-sub">${won.length ? Math.round(guests / won.length) + ' guests on average' : 'no bookings yet'}</span></div>
        <div class="kpi"><span class="kpi-label">Booked ahead</span><span class="kpi-value">${avgLead === null ? '-' : avgLead + ' days'}</span><span class="kpi-sub">average from first quote to event</span></div>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Booked revenue by event month</h2><p class="muted small">Months where the event takes place</p></div></div>
        ${revenueByMonth.length ? columnChart(revenueByMonth, { title: 'Booked revenue by event month', format: (v) => money(v), axisPrefix: '$', highlight: months.indexOf(todayIso().slice(0, 7)) }) : html`<p class="empty-inline">No booked events yet.</p>`}
      </section>

      <div class="grid-2">
        <section class="card">
          <h2 class="card-title">Catering funnel</h2>
          ${barList(funnel, { max: Math.max(1, cat.length) })}
        </section>
        <section class="card">
          <h2 class="card-title">New catering quotes per month</h2>
          ${columnChart(leadsByMonth, { title: 'New catering quotes per month', format: (v) => v + ' quotes', height: 140, highlight: leadsByMonth.length - 1 })}
        </section>
        <section class="card">
          <h2 class="card-title">Top cities by booked revenue</h2>
          ${byCity.length ? barList(byCity, { format: (v) => money(v, { cents: false }) }) : html`<p class="empty-inline">No booked events yet.</p>`}
        </section>
        <section class="card">
          <h2 class="card-title">Bookings by service style</h2>
          ${byStyle.length ? barList(byStyle, { format: (v) => v + ' booked' }) : html`<p class="empty-inline">No booked events yet.</p>`}
        </section>
        <section class="card">
          <h2 class="card-title">Inquiries by type</h2>
          ${byCategory.length ? barList(byCategory, { format: (v) => String(v) }) : html`<p class="empty-inline">No inquiries in this period.</p>`}
        </section>
        <section class="card">
          <h2 class="card-title">Money collected by month</h2>
          ${barList(pastMonths.slice(-6).reverse().map((key) => {
            let total = 0;
            for (const o of orders) for (const p of o.payments || []) if (monthKey(p.at) === key) total += Number(p.amount) || 0;
            return { label: monthLabel(key, false), value: total };
          }), { format: (v) => money(v) })}
        </section>
      </div>
    `);

    main.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
      range = b.dataset.range;
      setQuery({ range: range === '365' ? '' : range });
      draw();
    }));
  };
  draw();
}
