import { state } from '../app.js';
import { api } from '../api.js';
import { html, mount, $, ago, modal, confirmDialog, formValues, toast } from '../ui.js';

const ROLE_HELP = {
  admin: 'Everything, including inviting and removing staff',
  staff: 'Orders, customers, calendar and reports. Cannot manage staff.',
  none: 'Can sign in but sees nothing',
};

export async function renderStaff({ main, isStale, setTitle }) {
  setTitle('Staff');
  const { staff } = await api('/staff');
  if (isStale()) return;
  state.staff = null;
  const isAdmin = state.user.isAdmin;

  mount(main, html`
    <div class="page-head">
      <div><h1>Staff</h1><p class="muted">${isAdmin ? 'People who can sign in to this portal.' : 'Your team. Only admins can add or remove people.'}</p></div>
      ${isAdmin ? html`<div class="page-actions"><button class="btn btn-primary" id="inviteBtn">+ Invite someone</button></div>` : ''}
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Person</th><th>Access</th>${isAdmin ? html`<th>Last sign in</th><th></th>` : ''}</tr></thead>
      <tbody>${staff.map((s) => html`
        <tr>
          <td><strong>${s.name || s.email}</strong>${s.id === state.user.id ? html` <span class="pill pill-blue">You</span>` : ''}${s.name ? html`<div class="muted small">${s.email}</div>` : ''}
            ${isAdmin && !s.confirmed ? html`<div class="muted small">Invite sent ${s.invitedAt ? ago(s.invitedAt) : ''}, not accepted yet</div>` : ''}</td>
          <td>${isAdmin && s.id !== state.user.id && !s.owner
            ? html`<select data-role="${s.id}" aria-label="Access for ${s.email}">${['admin', 'staff', 'none'].map((r) => html`<option value="${r}" ${s.role === r ? 'selected' : ''}>${r === 'none' ? 'No access' : r[0].toUpperCase() + r.slice(1)}</option>`)}</select>`
            : html`<span>${s.role === 'admin' ? 'Admin' : s.role === 'staff' ? 'Staff' : 'No access'}${s.owner ? ' (owner)' : ''}</span>`}
            ${isAdmin ? html`<div class="muted small">${ROLE_HELP[s.role]}</div>` : ''}</td>
          ${isAdmin ? html`
            <td class="muted small">${s.lastSignInAt ? ago(s.lastSignInAt) : 'Never'}</td>
            <td>${s.id !== state.user.id && !s.owner ? html`<button class="link-btn danger small" data-remove="${s.id}" data-email="${s.email}">Remove</button>` : ''}</td>` : ''}
        </tr>`)}</tbody>
    </table></div>
    ${isAdmin ? html`<p class="muted small">Owners are set with the ADMIN_EMAILS setting in Netlify and always keep admin access. Role changes apply on that person's next action.</p>` : ''}
  `);

  if (!isAdmin) return;
  const reload = () => renderStaff({ main, isStale, setTitle });

  $('#inviteBtn').addEventListener('click', () => modal({
    title: 'Invite someone',
    submitLabel: 'Send invite',
    content: html`
      <label class="block">Email<input name="email" type="email" required autofocus></label>
      <label class="block">Access<select name="role"><option value="staff">Staff: ${ROLE_HELP.staff}</option><option value="admin">Admin: ${ROLE_HELP.admin}</option></select></label>
      <p class="muted small">They'll get an email from Netlify with a link to set their password.</p>`,
    onSubmit: async (form) => {
      await api('/staff/invite', { method: 'POST', body: formValues(form) });
      toast('Invite sent');
      reload();
    },
  }));

  main.querySelectorAll('[data-role]').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      await api('/staff/' + sel.dataset.role, { method: 'PATCH', body: { role: sel.value } });
      toast('Access updated');
      reload();
    } catch (err) {
      toast(err.message, 'error');
      reload();
    }
  }));

  main.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Remove ' + btn.dataset.email + '?', message: 'Their account is deleted and they are signed out right away. Notes they wrote stay on the orders.', confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api('/staff/' + btn.dataset.remove, { method: 'DELETE' });
      toast('Removed');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }));
}
