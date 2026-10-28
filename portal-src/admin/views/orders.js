import { state, loadOrders, invalidateOrders, setQuery } from '../app.js';
import { api } from '../api.js';
import { html, mount, $, $$, money, dateLabel, ago, statusPill, todayIso, modal, formValues, toast, downloadText } from '../ui.js';
import { attentionItems, OPEN_PIPELINE } from '../metrics.js';

const SORTS = {
  updated: { label: 'Recently updated', fn: (a, b) => b.updatedAt.localeCompare(a.updatedAt) },
  created: { label: 'Newest first', fn: (a, b) => b.createdAt.localeCompare(a.createdAt) },
  event: { label: 'Event date (soonest)', fn: (a, b) => (a.eventDate || '9999').localeCompare(b.eventDate || '9999') },
  total: { label: 'Biggest total', fn: (a, b) => (b.total || 0) - (a.total || 0) },
};

export const INQUIRY_CATEGORIES = ['Catering Inquiry', 'Event Booking', 'General Question', 'Pricing', 'Careers', 'Complaint', 'Media / Press', 'Partnership / Vendor', 'Review / Feedback', 'Phone call', 'Other'];

function filterOrders(orders, f) {
  const today = todayIso();
  const q = f.q.toLowerCase();
  const attentionIds = f.attention ? new Set(attentionItems(orders).map((i) => i.order.id)) : null;
  const since = f.since === '7d' ? new Date(Date.now() - 7 * 86400000).toISOString() : f.since === '30d' ? new Date(Date.now() - 30 * 86400000).toISOString() : '';
  return orders.filter((o) => {
    if (f.type && o.type !== f.type) return false;
    if (f.status === 'open-pipeline' && !(o.type === 'catering' && OPEN_PIPELINE.includes(o.status))) return false;
    if (f.status === 'active' && ['completed', 'cancelled', 'lost', 'closed', 'spam'].includes(o.status)) return false;
    if (f.status && !['open-pipeline', 'active'].includes(f.status) && o.status !== f.status) return false;
    if (f.when === 'upcoming' && !(o.eventDate && o.eventDate >= today)) return false;
    if (f.when === 'past' && !(o.eventDate && o.eventDate < today)) return false;
    if (f.when === 'nodate' && o.eventDate) return false;
    if (since && o.createdAt < since) return false;
    if (attentionIds && !attentionIds.has(o.id)) return false;
    if (f.assignee === 'me' && o.assignee !== state.user.name) return false;
    if (f.assignee === 'none' && o.assignee) return false;
    if (q) {
      const hay = [o.id, o.name, o.email, o.phone, o.company, o.city, o.address, o.category, o.preview, ...(o.tags || [])].join(' ').toLowerCase();
      if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
    }
    return true;
  });
}

export async function renderOrders({ main, params, isStale, setTitle }) {
  setTitle('Orders & Inquiries');
  const orders = await loadOrders();
  if (isStale()) return;
  const meta = state.meta;
  const f = {
    type: params.get('type') || '',
    status: params.get('status') || '',
    when: params.get('when') || '',
    since: params.get('since') || '',
    attention: params.get('attention') === '1',
    assignee: params.get('assignee') || '',
    q: params.get('q') || '',
    sort: SORTS[params.get('sort')] ? params.get('sort') : 'updated',
  };

  const statusOptions = f.type === 'inquiry' ? meta.inquiryStatuses : f.type === 'catering' ? meta.cateringStatuses : [...meta.cateringStatuses, ...meta.inquiryStatuses.filter((s) => !meta.cateringStatuses.some((c) => c.id === s.id))];
  const counts = { all: orders.length, catering: orders.filter((o) => o.type === 'catering').length, inquiry: orders.filter((o) => o.type === 'inquiry').length };

  mount(main, html`
    <div class="page-head">
      <div><h1>Orders &amp; Inquiries</h1><p class="muted" id="resultCount"></p></div>
      <div class="page-actions">
        <button class="btn btn-ghost" id="exportBtn" type="button">Export CSV</button>
        <button class="btn btn-primary" id="newOrderBtn" type="button">+ New order</button>
      </div>
    </div>

    <div class="tabs" role="tablist" aria-label="Order type">
      ${[['', 'All', counts.all], ['catering', 'Catering', counts.catering], ['inquiry', 'Inquiries', counts.inquiry]].map(([value, label, count]) => html`
        <button type="button" role="tab" class="tab ${f.type === value ? 'active' : ''}" aria-selected="${f.type === value}" data-type="${value}">${label} <span class="tab-count">${count}</span></button>`)}
    </div>

    <form class="filters" id="filters" role="search">
      <input type="search" name="q" value="${f.q}" placeholder="Search name, email, phone, order #, city…" aria-label="Search orders" class="filter-search">
      <select name="status" aria-label="Status">
        <option value="">Any status</option>
        <option value="active" ${f.status === 'active' ? 'selected' : ''}>Active (not closed)</option>
        ${f.type !== 'inquiry' ? html`<option value="open-pipeline" ${f.status === 'open-pipeline' ? 'selected' : ''}>Open pipeline</option>` : ''}
        ${statusOptions.map((s) => html`<option value="${s.id}" ${f.status === s.id ? 'selected' : ''}>${s.label}</option>`)}
      </select>
      <select name="when" aria-label="Event date">
        <option value="">Any event date</option>
        <option value="upcoming" ${f.when === 'upcoming' ? 'selected' : ''}>Upcoming events</option>
        <option value="past" ${f.when === 'past' ? 'selected' : ''}>Past events</option>
        <option value="nodate" ${f.when === 'nodate' ? 'selected' : ''}>No event date</option>
      </select>
      <select name="assignee" aria-label="Assigned to">
        <option value="">Anyone</option>
        <option value="me" ${f.assignee === 'me' ? 'selected' : ''}>Assigned to me</option>
        <option value="none" ${f.assignee === 'none' ? 'selected' : ''}>Unassigned</option>
      </select>
      <select name="sort" aria-label="Sort">
        ${Object.entries(SORTS).map(([k, s]) => html`<option value="${k}" ${f.sort === k ? 'selected' : ''}>${s.label}</option>`)}
      </select>
      ${f.attention || f.since ? html`<button type="button" class="chip" id="clearSpecial">${f.attention ? 'Needs attention' : 'Created in last ' + f.since} ×</button>` : ''}
    </form>

    <div id="results"></div>
  `);

  const renderResults = () => {
    const list = filterOrders(orders, f).sort(SORTS[f.sort].fn);
    $('#resultCount').textContent = list.length === orders.length ? orders.length + ' total' : list.length + ' of ' + orders.length;
    mount($('#results'), list.length
      ? html`
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Customer</th><th>Status</th><th>Event</th><th class="num">Total</th><th class="num">Balance</th><th>Updated</th></tr></thead>
            <tbody>
              ${list.map((o) => html`
                <tr data-href="#/orders/${o.id}" tabindex="0">
                  <td>
                    <a href="#/orders/${o.id}" class="row-link"><strong>${o.name || 'No name'}</strong></a>
                    <div class="muted small">
                      <span class="mono">${o.id}</span> · ${o.type === 'catering' ? 'Catering' : o.category || 'Inquiry'}
                      ${o.callbackRequested ? html` · <span class="flag">Callback</span>` : ''}
                      ${o.customerMessage ? html` · <span class="flag">Message</span>` : ''}
                      ${o.source === 'staff' ? ' · Added by staff' : ''}
                    </div>
                  </td>
                  <td>${statusPill(o.type, o.status, meta)}${o.assignee ? html`<div class="muted small">${o.assignee}</div>` : ''}</td>
                  <td>${o.type === 'catering'
                    ? html`${o.eventDate ? dateLabel(o.eventDate) : html`<span class="muted">No date</span>`}<div class="muted small">${[o.city, o.guestCount ? o.guestCount + ' guests' : ''].filter(Boolean).join(' · ')}</div>`
                    : html`<span class="muted small clamp">${o.preview}</span>`}</td>
                  <td class="num">${money(o.total)}</td>
                  <td class="num">${o.balance > 0 ? money(o.balance) : o.total ? html`<span class="muted">Paid</span>` : ''}</td>
                  <td class="muted small">${ago(o.updatedAt)}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>`
      : html`<div class="empty"><p>No orders match these filters.</p><p><a href="#/orders">Clear filters</a></p></div>`);
  };
  renderResults();

  const sync = () => {
    setQuery({ type: f.type, status: f.status, when: f.when, since: f.since, attention: f.attention ? '1' : '', assignee: f.assignee, q: f.q, sort: f.sort === 'updated' ? '' : f.sort });
    renderResults();
  };
  const form = $('#filters');
  form.addEventListener('submit', (e) => e.preventDefault());
  let debounce;
  form.addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const v = formValues(form);
      Object.assign(f, { q: v.q, status: v.status, when: v.when, assignee: v.assignee, sort: v.sort });
      sync();
    }, e.target.name === 'q' ? 200 : 0);
  });
  $('#clearSpecial')?.addEventListener('click', () => {
    f.attention = false;
    f.since = '';
    sync();
    $('#clearSpecial').remove();
  });
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    location.hash = '#/orders' + (t.dataset.type ? '?type=' + t.dataset.type : '');
  }));
  $('#results').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a')) location.hash = row.dataset.href;
  });
  $('#results').addEventListener('keydown', (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row && e.key === 'Enter') location.hash = row.dataset.href;
  });
  $('#newOrderBtn').addEventListener('click', () => newOrderModal());
  $('#exportBtn').addEventListener('click', async () => {
    try {
      const res = await api('/export.csv', { raw: true });
      downloadText('fireball-orders-' + todayIso() + '.csv', await res.text());
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  if (params.get('new') === '1') {
    setQuery({});
    newOrderModal();
  }
}

export function newOrderModal() {
  const meta = state.meta;
  return modal({
    title: 'New order',
    wide: true,
    submitLabel: 'Create order',
    content: html`
      <p class="muted small">For phone, email, walk-up, or repeat orders that didn't come through the website.</p>
      <div class="seg" role="radiogroup" aria-label="Order type">
        <label><input type="radio" name="type" value="catering" checked> Catering order</label>
        <label><input type="radio" name="type" value="inquiry"> Inquiry / message</label>
      </div>
      <fieldset class="form-grid">
        <legend>Customer</legend>
        <label>Name<input name="name" required autofocus></label>
        <label>Company <span class="muted">(optional)</span><input name="company"></label>
        <label>Email<input name="email" type="email"></label>
        <label>Phone<input name="phone" type="tel"></label>
      </fieldset>
      <fieldset class="form-grid" data-for="catering">
        <legend>Event</legend>
        <label>Event date<input name="date" type="date"></label>
        <label>Start time<input name="time" placeholder="e.g. 5:30 PM"></label>
        <label class="span-2">Event address<input name="address" placeholder="Street, City, CA ZIP"></label>
        <label>Guests<input name="guestCount" type="number" min="1" inputmode="numeric"></label>
        <label>Service style<input name="serviceStyle" placeholder="Buffet, BYO pizza bar…"></label>
        <label>Total quote ($)<input name="total" type="number" min="0" step="0.01" inputmode="decimal"></label>
        <label>Deposit ($)<input name="deposit" type="number" min="0" step="0.01" inputmode="decimal"></label>
        <label>Status
          <select name="status">${meta.cateringStatuses.map((s) => html`<option value="${s.id}" ${s.id === 'lead' ? 'selected' : ''}>${s.label}</option>`)}</select>
        </label>
        <label>How did it come in?
          <select name="sourceDetail"><option>Phone call</option><option>Email</option><option>In person</option><option>Repeat customer</option><option>Referral</option><option>Social media</option><option>Other</option></select>
        </label>
      </fieldset>
      <fieldset class="form-grid" data-for="inquiry" hidden>
        <legend>Inquiry</legend>
        <label>Type<select name="category">${INQUIRY_CATEGORIES.map((c) => html`<option>${c}</option>`)}</select></label>
        <label class="span-2">Message<textarea name="message" rows="4"></textarea></label>
      </fieldset>
      <label class="block">Internal note <span class="muted">(optional, staff only)</span><textarea name="note" rows="2"></textarea></label>
    `,
    onSubmit: async (form) => {
      const v = formValues(form);
      if (!v.name) throw new Error('Customer name is required');
      const isCatering = v.type === 'catering';
      const body = {
        type: v.type,
        customer: { name: v.name, email: v.email, phone: v.phone, company: v.company },
        note: v.note,
        sourceDetail: isCatering ? v.sourceDetail : '',
      };
      if (isCatering) {
        body.status = v.status;
        body.event = { date: v.date, time: v.time, address: v.address, guestCount: v.guestCount, serviceStyle: v.serviceStyle };
        body.quote = { total: v.total, deposit: v.deposit };
      } else {
        body.inquiry = { category: v.category, message: v.message };
      }
      const { id } = await api('/orders', { method: 'POST', body });
      invalidateOrders();
      toast('Order ' + id + ' created');
      location.hash = '#/orders/' + id;
    },
  }).then((result) => result);
}

// Show the catering or inquiry fields depending on the chosen type.
document.addEventListener('change', (e) => {
  if (e.target.name !== 'type' || !e.target.closest('.modal')) return;
  const modalEl = e.target.closest('.modal');
  modalEl.querySelectorAll('[data-for]').forEach((fs) => { fs.hidden = fs.dataset.for !== e.target.value; });
});
