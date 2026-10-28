// Talks to /api/admin/*. Keeps the Identity session fresh and sends people to the
// sign-in page when it has run out.

import { getUser, refreshSession, logout } from '@netlify/identity';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function goToLogin() {
  const back = location.hash && location.hash !== '#/' ? '?next=' + encodeURIComponent(location.hash) : '';
  location.href = '/admin/login.html' + back;
}

export async function ensureSession() {
  // getUser() restores the browser session from the nf_jwt cookie and keeps refreshing it while the tab is open.
  const user = await getUser();
  if (!user) {
    goToLogin();
    return null;
  }
  return user;
}

export async function signOut() {
  try {
    await logout();
  } finally {
    location.href = '/admin/login.html';
  }
}

export async function api(path, { method = 'GET', body, raw = false } = {}, retried = false) {
  const res = await fetch('/api/admin' + path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    const token = await refreshSession().catch(() => null);
    if (token) return api(path, { method, body, raw }, true);
    goToLogin();
    throw new ApiError(401, 'Signed out');
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'Request failed (' + res.status + ')');
  return data;
}
