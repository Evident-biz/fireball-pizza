import { state, loadOrders } from '../app.js';
import { html, mount, money, dateLabel, ago, daysUntil, statusPill, todayIso } from '../ui.js';
import { attentionItems, upcomingEvents, catering, sum, OPEN_PIPELINE, WON, monthsAround, monthKey, monthLabel, paymentsInMonth } from '../metrics.js';
import { columnChart } from '../charts.js';

export async function renderDashboard({ main, isStale, setTitle }) {
  setTitle('Dashboard');
  const orders = await loadOrders();
  if (isStale()) return;
  const meta = state.meta;
  const today = todayIso();
  const thisMonth = today.slice(0, 7);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const cat = catering(orders);
  const newThisWeek = orders.filter((o) => o.createdAt >= weekAgo);
  const pipeline = cat.filter((o) => OPEN_PIPELINE.includes(o.status) && (!o.eventDate || o.eventDate >= today));
  const bookedThisMonth = cat.filter((o) => WON.includes(o.status) && monthKey(o.eventDate) === thisMonth);
  const collected = paymentsInMonth(orders, thisMonth);
  const upcoming = upcomingEvents(orders, 60);
  const attention = attentionItems(orders, state.meta);

  const months = monthsAround(5, 6);
  const chartData = months.map((key) => {
    const list = cat.filter((o) => WON.includes(o.status) && monthKey(o.eventDate) === key);
    return { label: monthLabel(key), value: sum(list, (o) => o.total), tooltip: list.length + ' event' + (list.length === 1 ? '' : 's') };
  });

  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';

  mount(main, html`
    <div class="page-head">
      <div>
        <h1>${greeting}, ${(state.user.name || '').split(/[\s@]/)[0]}</h1>
        <p class="muted">${dateLabel(today, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      </div>
      <div class="page-actions">
        <a class="btn btn-primary" href="#/orders?new=1">+ New order</a>
      </div>
    </div>

    <section class="kpis" aria-label="Key numbers">
      <a class="kpi" href="#/orders?since=7d">
        <span class="kpi-label">New this week</span>
        <span class="kpi-value">${newThisWeek.length}</span>
        <span class="kpi-sub">${newThisWeek.filter((o) => o.type === 'catering').length} catering, ${newThisWeek.filter((o) => o.type === 'inquiry').length} inquiries</span>
      </a>
      <a class="kpi" href="#/orders?type=catering&status=open-pipeline">
        <span class="kpi-label">Open pipeline</span>
        <span class="kpi-value">${money(sum(pipeline, (o) => o.total), { cents: false })}</span>
        <span class="kpi-sub">${pipeline.length} quotes not booked yet</span>
      </a>
      <a class="kpi" href="#/calendar">
        <span class="kpi-label">Booked for ${monthLabel(thisMonth, false).split(' ')[0]}</span>
        <span class="kpi-value">${money(sum(bookedThisMonth, (o) => o.total), { cents: false })}</span>
        <span class="kpi-sub">${bookedThisMonth.length} event${bookedThisMonth.length === 1 ? '' : 's'}</span>
      </a>
      <a class="kpi" href="#/reports">
        <span class="kpi-label">Collected this month</span>
        <span class="kpi-value">${money(collected, { cents: false })}</span>
        <span class="kpi-sub">deposits and payments recorded</span>
      </a>
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="card-head">
          <h2>Needs attention</h2>
          <span class="count">${attention.length}</span>
        </div>
        ${attention.length
          ? html`<ul class="list">
              ${attention.slice(0, 12).map(({ order: o, reason }) => html`
                <li>
                  <a class="list-row" href="#/orders/${o.id}">
                    <div class="list-main">
                      <strong>${o.name || 'No name'}</strong>
                      <span class="muted">${reason}</span>
                    </div>
                    <div class="list-side">
                      ${statusPill(o.type, o.status, meta)}
                      <span class="muted small">${ago(o.updatedAt)}</span>
                    </div>
                  </a>
                </li>`)}
            </ul>
            ${attention.length > 12 ? html`<p class="card-foot"><a href="#/orders?attention=1">See all ${attention.length}</a></p>` : ''}`
          : html`<p class="empty-inline">All caught up. Nothing waiting on you.</p>`}
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Upcoming events</h2>
          <a href="#/calendar" class="small">Calendar →</a>
        </div>
        ${upcoming.length
          ? html`<ul class="list">
              ${upcoming.slice(0, 10).map((o) => {
                const d = daysUntil(o.eventDate);
                return html`
                  <li>
                    <a class="list-row" href="#/orders/${o.id}">
                      <div class="date-chip ${d <= 7 ? 'soon' : ''}">
                        <span>${dateLabel(o.eventDate, { month: 'short' })}</span>
                        <strong>${dateLabel(o.eventDate, { day: 'numeric' })}</strong>
                      </div>
                      <div class="list-main">
                        <strong>${o.name}</strong>
                        <span class="muted">${[o.eventTime, o.city, o.guestCount ? o.guestCount + ' guests' : ''].filter(Boolean).join(' · ')}</span>
                      </div>
                      <div class="list-side">
                        ${statusPill(o.type, o.status, meta)}
                        ${o.balance > 0 ? html`<span class="small muted">${money(o.balance)} due</span>` : ''}
                      </div>
                    </a>
                  </li>`;
              })}
            </ul>`
          : html`<p class="empty-inline">No events on the books for the next 60 days.</p>`}
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Booked revenue by event month</h2>
          <p class="muted small">Booked and completed catering, by the month the event happens</p>
        </div>
        <a href="#/reports" class="small">Reports →</a>
      </div>
      ${columnChart(chartData, { title: 'Booked revenue by event month', format: (v) => money(v), axisPrefix: '$', highlight: months.indexOf(thisMonth) })}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Latest activity</h2>
        <a href="#/orders" class="small">All orders →</a>
      </div>
      <ul class="list">
        ${[...orders].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map((o) => html`
          <li>
            <a class="list-row" href="#/orders/${o.id}">
              <div class="list-main">
                <strong>${o.name || 'No name'} <span class="muted small mono">${o.id}</span></strong>
                <span class="muted">${o.type === 'catering' ? [o.eventDate ? dateLabel(o.eventDate) : 'No date yet', o.total ? money(o.total) : ''].filter(Boolean).join(' · ') : o.category + ': ' + o.preview}</span>
              </div>
              <div class="list-side">${statusPill(o.type, o.status, meta)}<span class="muted small">${ago(o.updatedAt)}</span></div>
            </a>
          </li>`)}
      </ul>
      ${orders.length ? '' : html`<p class="empty-inline">No orders yet. New website quotes and contact messages will show up here.</p>`}
    </section>
  `);
}
