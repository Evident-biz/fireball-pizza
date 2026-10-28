// Staff portal shell: session check, navigation, hash router and the shared order cache.

import { ensureSession, signOut, api } from './api.js';
import { html, mount, $, toast } from './ui.js';
import { renderDashboard } from './views/dashboard.js';
import { renderOrders } from './views/orders.js';
import { renderOrder } from './views/order.js';
import { renderCalendar } from './views/calendar.js';
import { renderCustomers } from './views/customers.js';
import { renderReports } from './views/reports.js';
import { renderStaff } from './views/staff.js';

export const state = {
  user: null,
  meta: null,
  orders: null,
  ordersLoadedAt: 0,
  staff: null,
};

// Order summaries are shared by every list view. Reloaded when older than 30 seconds or on demand.
export async function loadOrders(force = false) {
  if (!force && state.orders && Date.now() - state.ordersLoadedAt < 30000) return state.orders;
  const { orders } = await api('/orders');
  state.orders = orders;
  state.ordersLoadedAt = Date.now();
  updateBadges();
  return orders;
}

export function invalidateOrders() {
  state.ordersLoadedAt = 0;
}

export async function loadStaff() {
  if (state.staff) return state.staff;
  try {
    const { staff } = await api('/staff');
    state.staff = staff;
  } catch {
    state.staff = [];
  }
  return state.staff;
}

const NAV = [
  { path: '/', label: 'Dashboard', icon: '◧' },
  { path: '/orders', label: 'Orders & Inquiries', icon: '☰', badge: 'inbox' },
  { path: '/calendar', label: 'Calendar', icon: '▦' },
  { path: '/customers', label: 'Customers', icon: '☺' },
  { path: '/reports', label: 'Reports', icon: '▲' },
  { path: '/staff', label: 'Staff', icon: '⚑' },
];

function needsAttentionCount(orders) {
  return orders.filter((o) => o.callbackRequested || o.customerMessage || (o.type === 'inquiry' && o.status === 'new')).length;
}

function updateBadges() {
  const badge = document.querySelector('[data-badge="inbox"]');
  if (!badge || !state.orders) return;
  const count = needsAttentionCount(state.orders);
  badge.textContent = count ? String(count) : '';
  badge.hidden = !count;
}

function renderShell() {
  const initials = (state.user.name || state.user.email || '?').split(/[\s@]+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  mount(document.getElementById('app'), html`
    <a class="skip-link" href="#main">Skip to content</a>
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <img src="/assets/images/logo.png" alt="" width="36" height="36">
        <div><strong>Fireball</strong><span>Staff Portal</span></div>
      </div>
      <nav aria-label="Main">
        ${NAV.map((n) => html`
          <a href="#${n.path}" class="nav-link" data-path="${n.path}">
            <span class="nav-icon" aria-hidden="true">${n.icon}</span>${n.label}
            ${n.badge ? html`<span class="nav-badge" data-badge="${n.badge}" hidden></span>` : ''}
          </a>`)}
      </nav>
      <div class="sidebar-foot">
        <a href="/" target="_blank" rel="noopener" class="nav-link small">View website ↗</a>
        <div class="me">
          <span class="avatar" aria-hidden="true">${initials}</span>
          <div class="me-text"><strong>${state.user.name}</strong><span>${state.user.isAdmin ? 'Admin' : 'Staff'}</span></div>
          <button type="button" class="btn btn-ghost btn-sm" id="signOutBtn">Sign out</button>
        </div>
      </div>
    </aside>
    <div class="sidebar-scrim" id="sidebarScrim"></div>
    <div class="main-col">
      <header class="topbar">
        <button type="button" class="icon-btn menu-btn" id="menuBtn" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false">☰</button>
        <span class="topbar-title" id="topbarTitle"></span>
        <button type="button" class="btn btn-ghost btn-sm" id="refreshBtn" title="Reload data">↻ Refresh</button>
      </header>
      <main id="main" tabindex="-1"></main>
    </div>`);

  $('#signOutBtn').addEventListener('click', signOut);
  $('#refreshBtn').addEventListener('click', () => {
    invalidateOrders();
    route();
  });
  const sidebar = $('#sidebar');
  const setMenu = (open) => {
    sidebar.classList.toggle('open', open);
    document.body.classList.toggle('menu-open', open);
    $('#menuBtn').setAttribute('aria-expanded', String(open));
  };
  $('#menuBtn').addEventListener('click', () => setMenu(!sidebar.classList.contains('open')));
  $('#sidebarScrim').addEventListener('click', () => setMenu(false));
  sidebar.addEventListener('click', (e) => { if (e.target.closest('.nav-link')) setMenu(false); });
}

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path, params: new URLSearchParams(query) };
}

export function setQuery(params) {
  const { path } = parseHash();
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== null && v !== undefined && v !== false) q.set(k, v);
  const next = '#' + path + (q.toString() ? '?' + q.toString() : '');
  history.replaceState(null, '', next);
}

let routeToken = 0;
async function route() {
  const token = ++routeToken;
  const { path, params } = parseHash();
  const main = $('#main');
  document.querySelectorAll('.nav-link[data-path]').forEach((a) => {
    const p = a.dataset.path;
    const active = p === '/' ? path === '/' : path === p || path.startsWith(p + '/');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  mount(main, html`<div class="loading" aria-live="polite">Loading…</div>`);

  const ctx = { main, params, isStale: () => token !== routeToken, setTitle };
  try {
    if (path === '/') await renderDashboard(ctx);
    else if (path === '/orders') await renderOrders(ctx);
    else if (path.startsWith('/orders/')) await renderOrder({ ...ctx, id: decodeURIComponent(path.slice('/orders/'.length)) });
    else if (path === '/calendar') await renderCalendar(ctx);
    else if (path === '/customers') await renderCustomers(ctx);
    else if (path === '/reports') await renderReports(ctx);
    else if (path === '/staff') await renderStaff(ctx);
    else mount(main, html`<div class="empty"><h2>Page not found</h2><p><a href="#/">Back to the dashboard</a></p></div>`);
  } catch (err) {
    if (token !== routeToken) return;
    console.error(err);
    mount(main, html`<div class="empty"><h2>Couldn't load this page</h2><p>${err.message}</p><p><button class="btn btn-primary" onclick="location.reload()">Try again</button></p></div>`);
  }
  if (token === routeToken && !params.has('keepScroll')) main.focus({ preventScroll: true });
}

function setTitle(title) {
  document.title = title + ' | Fireball Staff';
  const el = $('#topbarTitle');
  if (el) el.textContent = title;
}

async function start() {
  const identityUser = await ensureSession();
  if (!identityUser) return;
  try {
    const { user, meta } = await api('/me');
    state.user = user;
    state.meta = meta;
  } catch (err) {
    if (err.status === 403) {
      mount(document.getElementById('app'), html`
        <div class="center-card">
          <h1>No staff access yet</h1>
          <p>You're signed in as <strong>${identityUser.email}</strong>, but this account hasn't been given staff access. Ask an admin to set your role on the Staff page.</p>
          <button class="btn btn-primary" id="signOutBtn">Sign out</button>
        </div>`);
      $('#signOutBtn').addEventListener('click', signOut);
      return;
    }
    if (err.status !== 401) toast(err.message, 'error');
    return;
  }
  renderShell();
  window.addEventListener('hashchange', route);
  route();
  loadOrders().catch(() => {});
}

start();
