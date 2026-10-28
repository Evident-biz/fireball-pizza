// Staff sign-in page. Also handles the links Netlify Identity emails out:
// invites (set a password), password recovery, and email confirmation.

import { login, getUser, handleAuthCallback, acceptInvite, requestPasswordRecovery, updateUser } from '@netlify/identity';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const next = (() => {
  const n = params.get('next') || '';
  return n.startsWith('#/') ? '/admin/' + n : '/admin/';
})();

function show(id) {
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.id !== id; });
  const panel = document.getElementById(id);
  panel.querySelector('input')?.focus();
}

function message(form, text, tone = 'error') {
  const el = form.querySelector('.form-msg');
  el.textContent = text;
  el.className = 'form-msg ' + tone;
}

function busy(form, on) {
  const btn = form.querySelector('[type=submit]');
  btn.disabled = on;
  btn.classList.toggle('is-loading', on);
}

function friendly(err) {
  const text = String(err?.message || err || '');
  if (/invalid|credentials|password/i.test(text) && /grant|login|credentials/i.test(text)) return 'That email and password don’t match. Try again or reset your password.';
  if (/not confirmed|confirm/i.test(text)) return 'Please confirm your email first. Check your inbox for the confirmation link.';
  if (/expired|invalid token|not found/i.test(text)) return 'This link has expired or was already used. Ask an admin for a new invite, or reset your password.';
  if (/Identity/i.test(text) && /not|missing/i.test(text)) return 'Sign-in is not set up on this site yet (Netlify Identity is off).';
  return text || 'Something went wrong. Try again.';
}

let inviteToken = null;

async function start() {
  try {
    const result = await handleAuthCallback();
    if (result?.type === 'invite' && result.token) {
      inviteToken = result.token;
      show('invitePanel');
      return;
    }
    if (result?.type === 'recovery') {
      show('resetPanel');
      return;
    }
    if (result?.type === 'confirmation' || result?.type === 'oauth') {
      location.replace(next);
      return;
    }
  } catch (err) {
    show('loginPanel');
    message($('#loginForm'), friendly(err));
    return;
  }

  // Already signed in (fresh cookie, or a session the library can refresh): go straight in.
  const user = await getUser().catch(() => null);
  if (user) {
    location.replace(next);
    return;
  }
  show('loginPanel');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  busy(form, true);
  message(form, '', '');
  try {
    await login(form.email.value.trim(), form.password.value);
    location.replace(next);
  } catch (err) {
    message(form, friendly(err));
    busy(form, false);
  }
});

$('#forgotLink').addEventListener('click', (e) => {
  e.preventDefault();
  $('#forgotForm').email.value = $('#loginForm').email.value;
  show('forgotPanel');
});
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', (e) => {
  e.preventDefault();
  show('loginPanel');
}));

$('#forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  busy(form, true);
  try {
    await requestPasswordRecovery(form.email.value.trim());
  } catch {
    // Same message either way, so this can't be used to check who has an account.
  }
  message(form, 'If that email has an account, a reset link is on its way.', 'ok');
  busy(form, false);
});

function checkPasswords(form) {
  const a = form.password.value;
  const b = form.confirm.value;
  if (a.length < 10) return 'Use at least 10 characters.';
  if (a !== b) return 'The two passwords don’t match.';
  return '';
}

$('#inviteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const problem = checkPasswords(form);
  if (problem) return message(form, problem);
  busy(form, true);
  try {
    await acceptInvite(inviteToken, form.password.value);
    if (form.fullName.value.trim()) await updateUser({ data: { full_name: form.fullName.value.trim() } }).catch(() => {});
    location.replace('/admin/');
  } catch (err) {
    message(form, friendly(err));
    busy(form, false);
  }
});

$('#resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const problem = checkPasswords(form);
  if (problem) return message(form, problem);
  busy(form, true);
  try {
    await updateUser({ password: form.password.value });
    location.replace('/admin/');
  } catch (err) {
    message(form, friendly(err));
    busy(form, false);
  }
});

start();
