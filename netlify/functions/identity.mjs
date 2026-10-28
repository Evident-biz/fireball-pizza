// Netlify Identity event handlers for the staff portal.
//
// Registration should be set to "Invite only" in the Netlify dashboard. This is the second
// lock: anyone who still manages to sign up gets no role, and the admin API refuses users
// without the admin or staff role. Addresses in ADMIN_EMAILS get the admin role on signup.
//
// Roles ride in the login token, so a role set here applies from the user's next login or
// token refresh. The admin API itself re-checks roles with Identity on every request.

const adminEmails = () =>
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export default {
  userSignup(event) {
    const user = event.user;
    const existing = Array.isArray(user.appMetadata?.roles) ? user.appMetadata.roles : [];
    if (!user.email || !adminEmails().includes(user.email.toLowerCase()) || existing.includes('admin')) return;
    return { user: { ...user, appMetadata: { ...user.appMetadata, roles: [...existing, 'admin'] } } };
  },
};
