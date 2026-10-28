# Fireball Pizza Website

Static HTML/CSS site for Fireball Pizza (fireball.pizza), replacing the previous Google Sites version.

## Structure

```
fireball/
├── index.html          Home
├── catering.html        Catering + inquiry form
├── events.html          Calendar / event schedule
├── contact.html         Contact form
├── admin/              Staff portal pages (sign-in and app shell)
├── my-order/           Customer order page
├── my-orders/          Customer "find my orders" page
├── netlify/functions/  Server code: forms, portals, Square, email
├── netlify/lib/        Shared server code (orders, storage, auth, email)
├── portal-src/admin/   Staff portal source, bundled at deploy time
├── tests/              Backend tests and the local preview server
├── netlify.toml        Netlify config
└── assets/
    ├── style.css
    ├── portal/          Customer portal script and styles
    └── images/          Photos referenced by the pages (see images/README.txt)
```

## Local preview

The public pages still need no build: open `index.html` in a browser.

To try the staff portal and customer pages locally with sample data:

```
npm install
npm run dev:preview      # http://localhost:8888/admin/  (signed in as a fake owner)
npm test                 # backend tests against a local Netlify Blobs server
```

## Deploying

Netlify builds with `npm run build`, which copies the site into `dist/` and bundles the staff portal. Every push to `main` auto-deploys.

## Order system (staff portal + customer portal)

Every catering quote, booking and contact message is saved as an order in **Netlify Blobs**. Netlify Forms stays on as the email notification and as a backup copy of every submission.

- **Staff portal** at `/admin/`: dashboard, orders and inquiries inbox, order detail (status, assignment, tags, notes, payments, emailing the customer, Square payment links), calendar, customers, reports, CSV export, staff management. Sign-in is **Netlify Identity**.
- **Customer portal**: every order has a private page at `/my-order/?id=FB-XXXXXX&t=<token>`, linked from the confirmation emails. Customers can see status and payments, pay the deposit or balance, and send a change request. `/my-orders/` emails a 24-hour sign-in link that lists every order for that email. No customer passwords.
- **Square webhook** at `/api/square/webhook` records card payments made through payment links this system creates, and marks the order Booked.

### One-time setup in Netlify

1. **Identity:** Project configuration > Identity > Enable Identity. Set **Registration** to **Invite only**.
2. **Environment variables** (Project configuration > Environment variables):
   - `ADMIN_EMAILS`: comma-separated owner emails. These always have admin access once their email is confirmed.
   - `STAFF_NOTIFY_EMAIL`: where customer messages and payment alerts go (defaults to eat@fireball.pizza).
   - `SQUARE_WEBHOOK_SIGNATURE_KEY`: from step 4.
   - Already set: `RESEND_API_KEY`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENVIRONMENT`.
3. **First login:** in Identity > Users, invite the owner email. Accept the invite (the link lands on the home page and forwards to `/admin/login.html`). After that, invite staff from the portal's Staff page.
4. **Square webhook:** Square Developer Dashboard > Webhooks > Add subscription. URL `https://fireball.pizza/api/square/webhook`, events `payment.created` and `payment.updated`. Copy the signature key into `SQUARE_WEBHOOK_SIGNATURE_KEY`. If the site is served from another domain, set `SQUARE_WEBHOOK_URL` to the exact URL registered in Square.

### Things to know

- Deploy previews and branch deploys use their own Blobs store, so testing never touches real orders. Staff logins are shared across all deploys.
- Afterpay goes through a fixed Square link that isn't tied to an order, so record those payments by hand (Record payment).
- Order data lives in Netlify. Use **Export CSV** on the Orders page for backups.
