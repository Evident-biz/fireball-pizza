import { state, invalidateOrders, loadStaff, loadOrders } from '../app.js';
import { dateProblems } from '../metrics.js';
import { api } from '../api.js';
import {
  html, mount, $, money, dateLabel, dateTimeLabel, ago, daysUntil, telHref, modal, confirmDialog, formValues, toast, copyText, todayIso,
} from '../ui.js';
import { INQUIRY_CATEGORIES } from './orders.js';

const METHOD_LABELS = { card: 'Card', afterpay: 'Afterpay', cash: 'Cash', check: 'Check', other: 'Other' };

export async function renderOrder({ main, id, isStale, setTitle }) {
  let data = await api('/orders/' + encodeURIComponent(id));
  if (isStale()) return;
  const staff = await loadStaff();
  const allOrders = await loadOrders().catch(() => []);
  const gcal = await api('/google-calendar').catch(() => ({ days: {} }));
  if (isStale()) return;

  // Every change returns the fresh order; re-render in place.
  const refresh = (next) => {
    data = next;
    invalidateOrders();
    draw();
  };

  const run = async (fn, okMessage) => {
    try {
      const next = await fn();
      if (next?.order) refresh(next);
      if (okMessage) toast(okMessage);
      return next;
    } catch (err) {
      if (err.status === 409) {
        toast(err.message, 'error');
        const fresh = await api('/orders/' + encodeURIComponent(id));
        refresh(fresh);
      } else {
        toast(err.message, 'error');
      }
      throw err;
    }
  };

  const patch = (changes, okMessage = 'Saved') =>
    run(() => api('/orders/' + encodeURIComponent(id), { method: 'PATCH', body: { etag: data.etag, changes } }), okMessage);

  function draw() {
    const o = data.order;
    const c = data.computed;
    const meta = state.meta;
    const isCatering = o.type === 'catering';
    const statuses = isCatering ? meta.cateringStatuses : meta.inquiryStatuses;
    const days = daysUntil(o.event.date);
    const problems = dateProblems(
      { id: o.id, type: o.type, status: o.status, eventDate: o.event.date, guestCount: o.event.guestCount, name: o.customer.name },
      allOrders.filter((x) => x.id !== o.id),
      meta
    );
    setTitle((o.customer.name || 'Order') + ' · ' + o.id);

    mount(main, html`
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/orders${isCatering ? '?type=catering' : '?type=inquiry'}">← ${isCatering ? 'Catering' : 'Inquiries'}</a></nav>

      <div class="page-head order-head">
        <div>
          <p class="eyebrow mono">${o.id} · ${isCatering ? 'Catering' : 'Inquiry'} · ${o.source === 'staff' ? 'Added by staff' : 'From website'} · ${ago(o.createdAt)}</p>
          <h1>${o.customer.name || 'No name'}</h1>
          ${o.customer.company ? html`<p class="muted">${o.customer.company}</p>` : ''}
        </div>
        <div class="page-actions">
          <label class="status-select">
            <span class="sr-only">Status</span>
            <select id="statusSelect">${statuses.map((s) => html`<option value="${s.id}" ${s.id === o.status ? 'selected' : ''} title="${s.help || ''}">${s.label}</option>`)}</select>
          </label>
          <button class="btn btn-primary" type="button" id="emailBtn">Email customer</button>
          <details class="menu">
            <summary class="btn btn-ghost" aria-label="More actions">More ▾</summary>
            <div class="menu-list">
              ${c.portalUrl ? html`<button type="button" data-act="copy-portal">Copy customer order link</button>` : ''}
              ${c.portalUrl ? html`<a href="${c.portalUrl}" target="_blank" rel="noopener">Open customer view ↗</a>` : ''}
              ${isCatering ? html`<button type="button" data-act="pay-link">Create payment link</button>` : ''}
              ${isCatering ? html`<button type="button" data-act="record-payment">Record a payment</button>` : ''}
              <button type="button" data-act="reset-portal">Reset customer link</button>
              ${state.user.isAdmin ? html`<button type="button" data-act="delete" class="danger">Delete order</button>` : ''}
            </div>
          </details>
        </div>
      </div>

      ${problems.map((p) => html`
        <div class="banner banner-red"><span><strong>Date problem.</strong> ${p.text}.${p.others ? html` ${p.others.map((x) => html`<a href="#/orders/${x.id}">${x.id}</a> `)}` : ''}</span></div>`)}
      ${o.flags.dateUnavailable && ['lead', 'pending_deposit', 'reserved', 'date_check'].includes(o.status) ? html`
        <div class="banner banner-gold"><span><strong>Date needs confirming.</strong> ${o.flags.dateUnavailable === 'booked' ? 'Another event was already on this date when they booked.' : 'It\u2019s a farmers market day with fewer than ' + meta.marketMinGuests + ' guests.'} The customer was told we'll confirm within 1 to 2 business days. Call them, then set the status to Booked or Reserved, or offer another date.</span></div>` : ''}
      ${o.type === 'catering' && o.event.date && (gcal.days[o.event.date] || []).length ? html`
        <div class="banner banner-gold"><span><strong>On your Google Calendar that day:</strong> ${(gcal.days[o.event.date] || []).join(', ')}</span></div>` : ''}
      ${o.flags.customerMessage ? html`
        <div class="banner banner-gold"><span><strong>New message from the customer.</strong> See the notes below.</span><button class="btn btn-sm btn-ghost" data-act="msg-read">Mark read</button></div>` : ''}
      ${o.flags.callbackRequested ? html`
        <div class="banner banner-gold">
          <span><strong>Wants a callback.</strong> ${o.callbackMessage && o.callbackMessage !== '(none)' ? html`“${o.callbackMessage}”` : ''}
          ${o.customer.phone ? html` <a href="${telHref(o.customer.phone)}">Call ${o.customer.phone}</a>` : ''}</span>
          <button class="btn btn-sm btn-ghost" data-act="callback-done">Mark done</button>
        </div>` : ''}

      <div class="detail-grid">
        <div class="detail-main">
          <section class="card">
            <div class="card-head"><h2>Customer</h2><button class="link-btn" data-act="edit-customer">Edit</button></div>
            <dl class="facts">
              <div><dt>Email</dt><dd>${o.customer.email ? html`<a href="mailto:${o.customer.email}">${o.customer.email}</a>` : html`<span class="muted">None</span>`}</dd></div>
              <div><dt>Phone</dt><dd>${o.customer.phone ? html`<a href="${telHref(o.customer.phone)}">${o.customer.phone}</a>` : html`<span class="muted">None</span>`}</dd></div>
              ${o.customer.email ? html`<div><dt>History</dt><dd><a href="#/orders?q=${encodeURIComponent(o.customer.email)}">All orders from this customer</a></dd></div>` : ''}
            </dl>
          </section>

          ${isCatering ? html`
            <section class="card">
              <div class="card-head"><h2>Event</h2><button class="link-btn" data-act="edit-event">Edit</button></div>
              <dl class="facts">
                <div><dt>Date</dt><dd>${o.event.date ? html`${dateLabel(o.event.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} ${days !== null ? html`<span class="muted small">(${days === 0 ? 'today' : days > 0 ? 'in ' + days + ' days' : -days + ' days ago'})</span>` : ''}` : html`<span class="muted">Not set</span>`}</dd></div>
                <div><dt>Start time</dt><dd>${o.event.time || html`<span class="muted">Not set</span>`}</dd></div>
                <div><dt>Address</dt><dd>${o.event.address ? html`<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.event.address)}" target="_blank" rel="noopener">${o.event.address}</a>` : html`<span class="muted">Not set</span>`}</dd></div>
                <div><dt>Guests</dt><dd>${o.event.guestCount || html`<span class="muted">Not set</span>`}</dd></div>
                ${o.event.serviceStyle ? html`<div><dt>Service</dt><dd>${o.event.serviceStyle}</dd></div>` : ''}
                ${o.quote.serviceTime ? html`<div><dt>Service time</dt><dd>${o.quote.serviceTime}</dd></div>` : ''}
                ${o.quote.distance ? html`<div><dt>Distance</dt><dd class="small">${o.quote.distance}</dd></div>` : ''}
              </dl>
            </section>

            <section class="card">
              <div class="card-head"><h2>Quote</h2><button class="link-btn" data-act="edit-quote">Edit</button></div>
              <div class="money-row">
                <div><span class="muted small">Total</span><strong>${money(o.quote.total) || '-'}</strong></div>
                <div><span class="muted small">Deposit</span><strong>${money(o.quote.deposit) || '-'}</strong></div>
                <div><span class="muted small">Paid</span><strong>${money(c.paid)}</strong></div>
                <div><span class="muted small">Balance</span><strong class="${c.balance > 0 ? 'text-ember' : ''}">${c.balance === null ? '-' : money(c.balance)}</strong></div>
              </div>
              ${o.quote.pricingSummary ? html`
                <details class="breakdown" open>
                  <summary>Price breakdown</summary>
                  <ul>${o.quote.pricingSummary.split('|').map((line) => line.trim()).filter(Boolean).map((line) => {
                    const [label, ...rest] = line.split(':');
                    return rest.length ? html`<li><span>${label}</span><span>${rest.join(':').trim()}</span></li>` : html`<li><span>${line}</span></li>`;
                  })}</ul>
                </details>` : ''}
              ${o.quote.extras ? html`
                <details class="breakdown">
                  <summary>Add-ons and free extras</summary>
                  <ul>${o.quote.extras.split('|').map((x) => x.trim()).filter(Boolean).map((line) => {
                    const [label, ...rest] = line.split(':');
                    return html`<li><span>${label}</span><span>${rest.join(':').trim()}</span></li>`;
                  })}</ul>
                </details>` : ''}
              ${o.quote.driveLabor ? html`<p class="muted small">Drive labor: ${o.quote.driveLabor}</p>` : ''}
            </section>

            <section class="card">
              <div class="card-head">
                <h2>Payments</h2>
                <div class="card-actions">
                  <button class="btn btn-sm btn-ghost" data-act="pay-link">Payment link</button>
                  <button class="btn btn-sm btn-primary" data-act="record-payment">Record payment</button>
                </div>
              </div>
              ${o.payment.payments.length
                ? html`<ul class="list">${[...o.payment.payments].sort((a, b) => a.at.localeCompare(b.at)).map((p) => html`
                    <li class="list-row ${p.refunded ? 'is-void' : ''}">
                      <div class="list-main">
                        <strong>${money(p.amount)} · ${METHOD_LABELS[p.method] || p.method}</strong>
                        <span class="muted small">${dateLabel(p.at.slice(0, 10))} · ${p.recordedBy}${p.note ? ' · ' + p.note : ''}${p.refunded ? ' · Voided' : ''}</span>
                      </div>
                      <button class="link-btn small" data-act="void-payment" data-id="${p.id}">${p.refunded ? 'Restore' : 'Void'}</button>
                    </li>`)}</ul>`
                : html`<p class="empty-inline">No payments yet.${o.payment.depositLinkUrl ? html` A payment link was sent: <button class="link-btn" data-act="copy" data-text="${o.payment.depositLinkUrl}">copy link</button>` : ''}</p>`}
              <p class="muted small">Square card payments made through a payment link from this system are recorded automatically.</p>
            </section>
          ` : html`
            <section class="card">
              <div class="card-head"><h2>Message</h2><button class="link-btn" data-act="edit-inquiry">Change type</button></div>
              <p class="eyebrow">${o.inquiry.category || 'General'}</p>
              <div class="message-body">${o.inquiry.message || html`<span class="muted">No message</span>`}</div>
              <p><button class="btn btn-ghost btn-sm" data-act="convert">Start a catering order for this customer</button></p>
            </section>
          `}
        </div>

        <aside class="detail-side">
          <section class="card">
            <h2 class="card-title">Assignment</h2>
            <label class="block">Assigned to
              <select id="assigneeSelect">
                <option value="">Unassigned</option>
                ${staff.map((s) => html`<option value="${s.name || s.email}" ${(s.name || s.email) === o.assignee ? 'selected' : ''}>${s.name || s.email}</option>`)}
                ${o.assignee && !staff.some((s) => (s.name || s.email) === o.assignee) ? html`<option selected>${o.assignee}</option>` : ''}
              </select>
            </label>
            <label class="block">Tags <span class="muted small">(comma separated)</span>
              <input id="tagsInput" value="${o.tags.join(', ')}" placeholder="wedding, corporate, vip">
            </label>
            ${o.tags.length ? html`<div class="tags">${o.tags.map((t) => html`<a class="tag" href="#/orders?q=${encodeURIComponent(t)}">${t}</a>`)}</div>` : ''}
          </section>

          <section class="card">
            <h2 class="card-title">Notes <span class="count">${o.notes.length}</span></h2>
            <form id="noteForm" class="note-form">
              <label class="sr-only" for="noteText">Add a note</label>
              <textarea id="noteText" name="text" rows="3" placeholder="Add a note for the team. Customers never see these."></textarea>
              <button class="btn btn-sm btn-primary" type="submit">Add note</button>
            </form>
            <ul class="notes">
              ${[...o.notes].reverse().map((n) => html`
                <li class="note ${n.fromCustomer ? 'note-customer' : ''} ${n.emailed ? 'note-email' : ''}">
                  <div class="note-head">
                    <strong>${n.fromCustomer ? '✉ ' + n.by + ' (customer)' : n.by}</strong>
                    <span class="muted small" title="${dateTimeLabel(n.at)}">${ago(n.at)}</span>
                    ${!n.fromCustomer && (n.byEmail === state.user.email || state.user.isAdmin) ? html`<button class="link-btn small" data-act="delete-note" data-id="${n.id}" aria-label="Delete note">Delete</button>` : ''}
                  </div>
                  <div class="note-text">${n.text}</div>
                </li>`)}
            </ul>
          </section>

          <section class="card">
            <h2 class="card-title">Activity</h2>
            <ol class="timeline">
              ${[...o.activity].reverse().slice(0, 40).map((a) => html`
                <li><span class="muted small">${dateTimeLabel(a.at)} · ${a.by}</span><div><strong>${a.action}</strong>${a.detail ? html`<div class="muted small">${a.detail}</div>` : ''}</div></li>`)}
            </ol>
          </section>
        </aside>
      </div>
    `);
    bind();
  }

  function bind() {
    $('#statusSelect').addEventListener('change', (e) => patch({ status: e.target.value }, 'Status updated').catch(() => {}));
    $('#assigneeSelect').addEventListener('change', (e) => patch({ assignee: e.target.value }, 'Assignment saved').catch(() => {}));
    $('#tagsInput').addEventListener('change', (e) => patch({ tags: e.target.value.split(',') }, 'Tags saved').catch(() => {}));
    $('#noteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#noteText').value.trim();
      if (!text) return;
      await run(() => api('/orders/' + encodeURIComponent(id) + '/notes', { method: 'POST', body: { text } }), 'Note added').catch(() => {});
    });
    $('#noteText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#noteForm').requestSubmit();
    });
    $('#emailBtn').addEventListener('click', () => emailModal());
    main.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', (e) => {
      e.preventDefault();
      main.querySelector('details.menu')?.removeAttribute('open');
      actions[el.dataset.act]?.(el);
    }));
  }

  const actions = {
    'copy-portal': () => copyText(data.computed.portalUrl),
    copy: (el) => copyText(el.dataset.text),
    'msg-read': () => patch({ customerMessageRead: true }, 'Marked read').catch(() => {}),
    'callback-done': () => patch({ callbackHandled: true }, 'Callback marked done').catch(() => {}),
    'edit-customer': () => editModal('Edit customer', html`
      <div class="form-grid">
        <label>Name<input name="name" value="${data.order.customer.name}" required></label>
        <label>Company<input name="company" value="${data.order.customer.company}"></label>
        <label>Email<input name="email" type="email" value="${data.order.customer.email}"></label>
        <label>Phone<input name="phone" type="tel" value="${data.order.customer.phone}"></label>
      </div>`, (v) => ({ customer: v })),
    'edit-event': () => editModal('Edit event', html`
      <div class="form-grid">
        <label>Event date<input name="date" type="date" value="${data.order.event.date}"></label>
        <label>Start time<input name="time" value="${data.order.event.time}"></label>
        <label class="span-2">Address<input name="address" value="${data.order.event.address}"></label>
        <label>City <span class="muted small">(for reports)</span><input name="city" value="${data.order.event.city}"></label>
        <label>Guests<input name="guestCount" type="number" min="1" value="${data.order.event.guestCount ?? ''}"></label>
        <label class="span-2">Service style<input name="serviceStyle" value="${data.order.event.serviceStyle}"></label>
      </div>`, (v) => ({ event: v })),
    'edit-quote': () => editModal('Edit quote', html`
      <div class="form-grid">
        <label>Total ($)<input name="total" type="number" step="0.01" min="0" value="${data.order.quote.total ?? ''}"></label>
        <label>Deposit ($)<input name="deposit" type="number" step="0.01" min="0" value="${data.order.quote.deposit ?? ''}"></label>
        <label class="span-2">Price breakdown <span class="muted small">(separate lines with |)</span><textarea name="pricingSummary" rows="5">${data.order.quote.pricingSummary}</textarea></label>
        <label class="span-2">Add-ons <span class="muted small">(separate with |)</span><textarea name="extras" rows="3">${data.order.quote.extras}</textarea></label>
      </div>`, (v) => ({ quote: v })),
    'edit-inquiry': () => editModal('Inquiry type', html`
      <label class="block">Type<select name="category">${INQUIRY_CATEGORIES.map((c) => html`<option ${c === data.order.inquiry.category ? 'selected' : ''}>${c}</option>`)}</select></label>`,
      (v) => ({ inquiry: v })),
    'record-payment': () => {
      const c = data.computed;
      return modal({
        title: 'Record a payment',
        submitLabel: 'Record payment',
        content: html`
          <div class="form-grid">
            <label>Amount ($)<input name="amount" type="number" step="0.01" min="0.01" required value="${c.amountDue?.amount ?? ''}" autofocus></label>
            <label>Method<select name="method">${state.meta.paymentMethods.map((m) => html`<option value="${m}">${METHOD_LABELS[m] || m}</option>`)}</select></label>
            <label>Date received<input name="date" type="date" value="${todayIso()}"></label>
            <label>Note<input name="note" placeholder="Check #, Square receipt…"></label>
          </div>
          ${['lead', 'pending_deposit', 'reserved', 'date_check'].includes(data.order.status) ? html`<label class="check"><input type="checkbox" name="markBooked" checked> Mark this order Booked</label>` : ''}
          <p class="muted small">Card payments through a payment link from this system record themselves. Use this for cash, checks, Afterpay, and anything paid another way.</p>`,
        onSubmit: async (form) => {
          const v = formValues(form);
          await run(() => api('/orders/' + encodeURIComponent(id) + '/payments', { method: 'POST', body: v }), 'Payment recorded');
        },
      });
    },
    'void-payment': async (el) => {
      const p = data.order.payment.payments.find((x) => x.id === el.dataset.id);
      if (!p) return;
      if (!p.refunded && !(await confirmDialog({ title: 'Void this payment?', message: 'Use this for a refund or a payment entered by mistake. ' + money(p.amount) + ' will no longer count toward the balance. This does not refund anything in Square.', confirmLabel: 'Void payment', danger: true }))) return;
      await run(() => api('/orders/' + encodeURIComponent(id) + '/payments/' + p.id + '/void', { method: 'POST', body: {} }), p.refunded ? 'Payment restored' : 'Payment voided').catch(() => {});
    },
    'pay-link': () => {
      const due = data.computed.amountDue;
      return modal({
        title: 'Create a payment link',
        submitLabel: 'Create link',
        content: html`
          <label class="block">Amount ($)<input name="amount" type="number" step="0.01" min="0.01" required value="${due?.amount ?? ''}" autofocus></label>
          <label class="block">This is the
            <select name="kind"><option value="deposit" ${due?.kind !== 'balance' ? 'selected' : ''}>Deposit</option><option value="balance" ${due?.kind === 'balance' ? 'selected' : ''}>Balance</option></select>
          </label>
          <p class="muted small">You'll get a Square link to text or email. When the customer pays, it is recorded here automatically. To email it from here instead, use Email customer → Payment request.</p>`,
        onSubmit: async (form) => {
          const v = formValues(form);
          const res = await api('/orders/' + encodeURIComponent(id) + '/payment-link', { method: 'POST', body: v });
          const fresh = await api('/orders/' + encodeURIComponent(id));
          refresh(fresh);
          await modal({
            title: 'Payment link ready',
            content: html`<p>${money(res.amount)} ${res.kind}:</p><p class="link-box"><a href="${res.url}" target="_blank" rel="noopener">${res.url}</a></p><p><button type="button" class="btn btn-primary" id="copyLinkBtn">Copy link</button></p>`,
          });
        },
      }).then(() => {});
    },
    'reset-portal': async () => {
      if (!(await confirmDialog({ title: 'Reset the customer link?', message: 'The link the customer has now will stop working. Use this if a link was sent to the wrong person. You can send them the new link with Email customer → Order link.', confirmLabel: 'Reset link', danger: true }))) return;
      await run(() => api('/orders/' + encodeURIComponent(id) + '/portal-link', { method: 'POST', body: {} }), 'New customer link created').catch(() => {});
    },
    delete: async () => {
      if (!(await confirmDialog({ title: 'Delete ' + data.order.id + '?', message: 'This permanently removes the order, its notes and payment records. For real orders that fell through, set the status to Lost or Cancelled instead.', confirmLabel: 'Delete forever', danger: true }))) return;
      try {
        await api('/orders/' + encodeURIComponent(id), { method: 'DELETE' });
        invalidateOrders();
        toast('Order deleted');
        location.hash = '#/orders';
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    convert: async () => {
      const o = data.order;
      try {
        const { id: newId } = await api('/orders', {
          method: 'POST',
          body: {
            type: 'catering',
            customer: o.customer,
            note: 'Started from inquiry ' + o.id + (o.inquiry.message ? ':\n\n' + o.inquiry.message : ''),
            sourceDetail: 'From inquiry ' + o.id,
          },
        });
        await api('/orders/' + encodeURIComponent(o.id) + '/notes', { method: 'POST', body: { text: 'Catering order ' + newId + ' started from this inquiry.' } });
        invalidateOrders();
        toast('Catering order ' + newId + ' created');
        location.hash = '#/orders/' + newId;
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  };

  function editModal(title, content, toChanges) {
    return modal({
      title,
      content,
      onSubmit: async (form) => {
        await patch(toChanges(formValues(form)));
      },
    });
  }

  function emailModal() {
    const o = data.order;
    const c = data.computed;
    const templates = o.type === 'catering'
      ? [['custom', 'Write a message'], ['payment_request', 'Payment request (includes a Square link)'], ['booking_confirmed', 'Booking confirmed'], ['order_link', 'Send their order page link']]
      : [['custom', 'Write a message'], ['order_link', 'Send their order page link']];
    return modal({
      title: 'Email ' + (o.customer.name || 'customer'),
      wide: true,
      submitLabel: 'Send email',
      content: html`
        <p class="muted small">To ${o.customer.email || 'no email on file'}. Sent from eat@fireball.pizza; replies come back to that inbox. A copy is saved to the notes.</p>
        <label class="block">Email type
          <select name="template" id="tplSelect">${templates.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
        </label>
        <label class="block" data-tpl="payment_request" hidden>Amount ($)<input name="amount" type="number" step="0.01" min="0.01" value="${c.amountDue?.amount ?? ''}"></label>
        <label class="block">Subject <span class="muted small">(optional)</span><input name="subject" placeholder="Uses a sensible default"></label>
        <label class="block">Message <span class="muted small" id="msgHint">(required)</span><textarea name="message" rows="7" placeholder="Hi ${(o.customer.name || '').split(' ')[0]}, …"></textarea></label>
        <p class="muted small">The email includes the order details and a button to their order page${o.type === 'catering' ? ' (or to pay, for a payment request)' : ''}.</p>`,
      onSubmit: async (form) => {
        const v = formValues(form);
        await run(() => api('/orders/' + encodeURIComponent(id) + '/email', { method: 'POST', body: v }), 'Email sent');
      },
    });
  }

  draw();
}

// Payment-link copy button and template switcher live inside modals.
document.addEventListener('click', (e) => {
  if (e.target.id === 'copyLinkBtn') {
    const link = e.target.closest('.modal').querySelector('.link-box a');
    if (link) copyText(link.href);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'tplSelect') return;
  const modalEl = e.target.closest('.modal');
  modalEl.querySelectorAll('[data-tpl]').forEach((el) => { el.hidden = el.dataset.tpl !== e.target.value; });
  const hint = modalEl.querySelector('#msgHint');
  if (hint) hint.textContent = e.target.value === 'custom' ? '(required)' : '(optional, replaces the standard wording)';
});
