import { loadOrders, setQuery } from '../app.js';
import { html, mount, $, money, dateLabel, ago, telHref } from '../ui.js';
import { customersFrom } from '../metrics.js';

const SORTS = {
  value: { label: 'Lifetime value', fn: (a, b) => b.lifetimeValue - a.lifetimeValue || b.orderCount - a.orderCount },
  recent: { label: 'Most recent', fn: (a, b) => b.latest.localeCompare(a.latest) },
  orders: { label: 'Most orders', fn: (a, b) => b.orderCount - a.orderCount },
  name: { label: 'Name A-Z', fn: (a, b) => (a.name || '').localeCompare(b.name || '') },
};

export async function renderCustomers({ main, params, isStale, setTitle }) {
  setTitle('Customers');
  const orders = await loadOrders();
  if (isStale()) return;
  const customers = customersFrom(orders);
  let q = params.get('q') || '';
  let sort = SORTS[params.get('sort')] ? params.get('sort') : 'value';
  let repeatOnly = params.get('repeat') === '1';

  const repeatCount = customers.filter((c) => c.repeat).length;
  const booked = customers.filter((c) => c.bookedCount > 0);

  mount(main, html`
    <div class="page-head">
      <div><h1>Customers</h1><p class="muted">${customers.length} people · ${booked.length} have booked · ${repeatCount} repeat</p></div>
    </div>
    <form class="filters" id="custFilters" role="search">
      <input type="search" name="q" value="${q}" placeholder="Search name, email, phone, company…" class="filter-search" aria-label="Search customers">
      <select name="sort" aria-label="Sort">${Object.entries(SORTS).map(([k, s]) => html`<option value="${k}" ${k === sort ? 'selected' : ''}>${s.label}</option>`)}</select>
      <label class="check"><input type="checkbox" name="repeat" ${repeatOnly ? 'checked' : ''}> Repeat customers only</label>
    </form>
    <div id="custResults"></div>
  `);

  const draw = () => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = customers
      .filter((c) => !repeatOnly || c.repeat)
      .filter((c) => words.every((w) => [c.name, c.email, c.phone, c.company].join(' ').toLowerCase().includes(w)))
      .sort(SORTS[sort].fn);
    mount($('#custResults'), list.length
      ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Customer</th><th>Contact</th><th class="num">Orders</th><th class="num">Booked value</th><th>Last event</th><th>Customer since</th></tr></thead>
          <tbody>${list.map((c) => html`
            <tr>
              <td><a class="row-link" href="#/orders?q=${encodeURIComponent(c.email || c.phone || c.name)}"><strong>${c.name || 'No name'}</strong></a>
                ${c.repeat ? html` <span class="pill pill-green">Repeat</span>` : ''}
                ${c.company ? html`<div class="muted small">${c.company}</div>` : ''}</td>
              <td class="small">${c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : ''}${c.phone ? html`<div><a href="${telHref(c.phone)}">${c.phone}</a></div>` : ''}</td>
              <td class="num">${c.orderCount}${c.bookedCount ? html`<div class="muted small">${c.bookedCount} booked</div>` : ''}</td>
              <td class="num">${c.lifetimeValue ? money(c.lifetimeValue) : html`<span class="muted">-</span>`}</td>
              <td>${c.lastEvent ? dateLabel(c.lastEvent) : html`<span class="muted">-</span>`}</td>
              <td class="muted small">${ago(c.firstSeen)}</td>
            </tr>`)}</tbody></table></div>`
      : html`<div class="empty"><p>No customers match.</p></div>`);
  };
  draw();

  const form = $('#custFilters');
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', () => {
    q = form.q.value.trim();
    sort = form.sort.value;
    repeatOnly = form.repeat.checked;
    setQuery({ q, sort: sort === 'value' ? '' : sort, repeat: repeatOnly ? '1' : '' });
    draw();
  });
}
