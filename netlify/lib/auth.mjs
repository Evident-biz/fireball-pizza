// Staff authorization for the admin API.
//
// Roles live in Netlify Identity app_metadata.roles:
//   admin  full access, including managing staff accounts
//   staff  everything except managing staff accounts
//
// getUser() on the server re-checks the session with Identity on every call, so removing
// someone or changing their role takes effect on their next request.
// ADMIN_EMAILS (comma separated) is the bootstrap: those addresses are always treated as
// admins, so the owner can sign in before any roles have been assigned.

import { getUser } from '@netlify/identity';
import { HttpError } from './util.mjs';

export const STAFF_ROLES = ['admin', 'staff'];

export function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function rolesFor(user) {
  const roles = Array.isArray(user.roles) ? [...user.roles] : [];
  // Only a confirmed address counts, so nobody can claim the owner's email by signing up with it.
  const bootstrap = user.email && user.confirmedAt && adminEmails().includes(user.email.toLowerCase());
  if (bootstrap && !roles.includes('admin')) roles.push('admin');
  return roles;
}

export async function requireStaff({ adminOnly = false } = {}) {
  const user = await getUser();
  if (!user) throw new HttpError(401, 'Please sign in');
  const roles = rolesFor(user);
  const allowed = adminOnly ? roles.includes('admin') : roles.some((r) => STAFF_ROLES.includes(r));
  if (!allowed) throw new HttpError(403, adminOnly ? 'Only admins can do that' : 'Your account does not have staff access yet');
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.userMetadata?.full_name || user.email,
    roles,
    isAdmin: roles.includes('admin'),
  };
}
