// Rendering helpers for the staff portal. Views build HTML with the `html` tagged template,
// which escapes every interpolated value unless it is wrapped in raw().

const RAW = Symbol('raw');

export function raw(value) {
  return { [RAW]: true, value: String(value ?? '') };
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (typeof value === 'object' && value[RAW]) return value.value;
  return esc(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return raw(out);
}

export function mount(el, content) {
  el.innerHTML = renderValue(content);
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

// ---------- formatting ----------

export function money(n, { cents = true } = {}) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}

export function dateLabel(iso, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return '';
  const d = iso.length === 10 ? new Date(iso + 'T00:00:00') : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', opts);
}

export function dateTimeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function ago(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + 'h ago';
  const day = Math.round(hr / 24);
  if (day < 30) return day + 'd ago';
  return dateLabel(iso, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function daysUntil(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso + 'T00:00:00') - new Date(todayIso() + 'T00:00:00')) / 86400000);
}

export function telHref(phone) {
  return 'tel:' + String(phone || '').replace(/[^\d+]/g, '');
}

// ---------- status pills ----------

const STATUS_TONE = {
  lead: 'blue', pending_deposit: 'gold', reserved: 'gold', booked: 'green', completed: 'gray', cancelled: 'red', lost: 'gray',
  new: 'blue', open: 'gold', replied: 'green', closed: 'gray', spam: 'red',
};

export function statusPill(type, status, meta) {
  const list = type === 'catering' ? meta.cateringStatuses : meta.inquiryStatuses;
  const label = list.find((s) => s.id === status)?.label || status;
  return html`<span class="pill pill-${STATUS_TONE[status] || 'gray'}">${label}</span>`;
}

export function typeLabel(type) {
  return type === 'catering' ? 'Catering' : 'Inquiry';
}

// ---------- toast ----------

let toastTimer;
export function toast(message, tone = 'ok') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.className = 'toast toast-' + tone + ' show';
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), tone === 'error' ? 6000 : 3000);
}

// ---------- modal ----------

// Opens a modal with `content` (an html`` value). `onSubmit(form)` runs when its form submits;
// return false to keep it open. Resolves when closed.
export function modal({ title, content, submitLabel = 'Save', onSubmit, wide = false, danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = renderValue(html`
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <form class="modal-form" novalidate>
          <div class="modal-head">
            <h2 id="modalTitle">${title}</h2>
            <button type="button" class="icon-btn" data-close aria-label="Close">&times;</button>
          </div>
          <div class="modal-body">${content}</div>
          <div class="modal-foot">
            <p class="modal-error" role="alert"></p>
            <button type="button" class="btn btn-ghost" data-close>Cancel</button>
            ${onSubmit ? html`<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button>` : ''}
          </div>
        </form>
      </div>`);
    document.body.appendChild(overlay);
    const form = overlay.querySelector('form');
    const errorEl = overlay.querySelector('.modal-error');
    const previouslyFocused = document.activeElement;
    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return close(true);
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      errorEl.textContent = '';
      try {
        const result = await onSubmit(form);
        if (result !== false) close(result ?? true);
      } catch (err) {
        errorEl.textContent = err.message || 'Something went wrong';
      } finally {
        submit.disabled = false;
      }
    });
    (overlay.querySelector('[autofocus]') || overlay.querySelector('input, select, textarea, button[type=submit]'))?.focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return modal({ title, content: html`<p>${message}</p>`, submitLabel: confirmLabel, danger, onSubmit: () => true }).then(Boolean);
}

export function formValues(form) {
  const data = {};
  new FormData(form).forEach((value, key) => { data[key] = typeof value === 'string' ? value.trim() : value; });
  form.querySelectorAll('input[type=checkbox]').forEach((c) => { data[c.name] = c.checked; });
  return data;
}

export function downloadText(filename, text, type = 'text/csv') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    window.prompt('Copy this:', text);
  }
}
