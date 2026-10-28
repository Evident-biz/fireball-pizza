import { state, loadOrders, setQuery } from '../app.js';
import { html, mount, $, money, todayIso, statusPill, dateLabel } from '../ui.js';
import { catering, isMarketDay } from '../metrics.js';

const SHOWN = ['lead', 'pending_deposit', 'reserved', 'booked', 'completed'];

export async function renderCalendar({ main, params, isStale, setTitle }) {
  setTitle('Calendar');
  const orders = await loadOrders();
  if (isStale()) return;
  const today = todayIso();
  let month = /^\d{4}-\d{2}$/.test(params.get('m') || '') ? params.get('m') : today.slice(0, 7);
  let showLeads = params.get('leads') === '1';

  const draw = () => {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(y, m, 0).getDate();
    const statuses = showLeads ? SHOWN : SHOWN.filter((s) => s !== 'lead');
    const events = catering(orders).filter((o) => o.eventDate && o.eventDate.startsWith(month) && statuses.includes(o.status));
    const byDay = new Map();
    for (const o of events) {
      const d = Number(o.eventDate.slice(8, 10));
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(o);
    }
    for (const list of byDay.values()) list.sort((a, b) => (a.eventTime || '').localeCompare(b.eventTime || ''));
    const booked = events.filter((o) => ['booked', 'completed'].includes(o.status));
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7) cells.push(null);
    const iso = (d) => month + '-' + String(d).padStart(2, '0');

    mount(main, html`
      <div class="page-head">
        <div>
          <h1>${first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h1>
          <p class="muted">${booked.length} booked event${booked.length === 1 ? '' : 's'} · ${money(booked.reduce((s, o) => s + (o.total || 0), 0), { cents: false })} · ${booked.reduce((s, o) => s + (o.guestCount || 0), 0)} guests</p>
        </div>
        <div class="page-actions">
          <label class="check"><input type="checkbox" id="leadsToggle" ${showLeads ? 'checked' : ''}> Show unbooked leads</label>
          <div class="btn-group">
            <button class="btn btn-ghost" id="prevMonth" aria-label="Previous month">‹</button>
            <button class="btn btn-ghost" id="thisMonth">Today</button>
            <button class="btn btn-ghost" id="nextMonth" aria-label="Next month">›</button>
          </div>
        </div>
      </div>

      <div class="calendar" role="grid" aria-label="Events this month">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => html`<div class="cal-dow" role="columnheader">${d}</div>`)}
        ${cells.map((d) => d === null
          ? html`<div class="cal-cell cal-empty" aria-hidden="true"></div>`
          : html`
            <div class="cal-cell ${iso(d) === today ? 'cal-today' : ''} ${iso(d) < today ? 'cal-past' : ''}" role="gridcell" aria-label="${dateLabel(iso(d))}">
              <span class="cal-num">${d}</span>${isMarketDay(iso(d), state.meta) ? html`<span class="cal-market" title="Farmers market day: catering needs ${state.meta.marketMinGuests}+ guests">Market</span>` : ''}
              ${(byDay.get(d) || []).map((o) => html`
                <a class="cal-event cal-${o.status}" href="#/orders/${o.id}" title="${o.name} · ${o.eventTime || ''} · ${o.guestCount || '?'} guests">
                  <span class="cal-time">${o.eventTime || ''}</span> ${o.name}
                </a>`)}
            </div>`)}
      </div>

      <section class="card cal-agenda">
        <h2 class="card-title">This month, in order</h2>
        ${events.length
          ? html`<ul class="list">${[...events].sort((a, b) => (a.eventDate + (a.eventTime || '')).localeCompare(b.eventDate + (b.eventTime || ''))).map((o) => html`
              <li><a class="list-row" href="#/orders/${o.id}">
                <div class="list-main"><strong>${dateLabel(o.eventDate)} · ${o.eventTime || 'Time TBD'}</strong><span class="muted">${o.name} · ${[o.city, o.guestCount ? o.guestCount + ' guests' : ''].filter(Boolean).join(' · ')}</span></div>
                <div class="list-side">${statusPill(o.type, o.status, state.meta)}${o.total ? html`<span class="small muted">${money(o.total)}</span>` : ''}</div>
              </a></li>`)}</ul>`
          : html`<p class="empty-inline">No events this month.</p>`}
      </section>
    `);

    const go = (delta) => {
      const d = new Date(y, m - 1 + delta, 1);
      month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      setQuery({ m: month, leads: showLeads ? '1' : '' });
      draw();
    };
    $('#prevMonth').addEventListener('click', () => go(-1));
    $('#nextMonth').addEventListener('click', () => go(1));
    $('#thisMonth').addEventListener('click', () => { month = today.slice(0, 7); setQuery({ leads: showLeads ? '1' : '' }); draw(); });
    $('#leadsToggle').addEventListener('change', (e) => { showLeads = e.target.checked; setQuery({ m: month, leads: showLeads ? '1' : '' }); draw(); });
  };
  draw();
}
