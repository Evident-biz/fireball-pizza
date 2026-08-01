# Fireball Pizza — Website

Static HTML/CSS site for Fireball Pizza (fireball.pizza), replacing the previous Google Sites version.

## Structure

```
fireball/
├── index.html          Home
├── catering.html        Catering + inquiry form
├── events.html          Calendar / event schedule
├── contact.html         Contact form
├── netlify.toml          Netlify config
└── assets/
    ├── style.css
    └── images/           Photos referenced by the pages (see images/README.txt)
```

## Local preview

Just open `index.html` in a browser. No build step, no dependencies.

## Deploying

This repo is set up to deploy straight to Netlify:

1. Push this repo to GitHub (see below if not done yet).
2. In Netlify: **Add new site → Import an existing project → connect to GitHub → select this repo.**
3. Build settings: leave build command blank, publish directory = `.` (already set in `netlify.toml`).
4. Deploy. Every push to `main` auto-deploys.
5. Once ready, point the `fireball.pizza` domain's DNS at the Netlify site (Netlify gives you the exact A/CNAME records under Domain settings).

## Enabling the catering form

The form on `catering.html` currently shows a success message but doesn't send anywhere. To wire it to Netlify Forms:

1. Add `data-netlify="true"` and `name="catering-inquiry"` to the `<form id="cateringForm">` tag.
2. Add a hidden input: `<input type="hidden" name="form-name" value="catering-inquiry">`
3. Redeploy. Submissions will show up in Netlify's dashboard under Forms, with email notifications configurable there.

Same steps apply to `contact.html`'s form (`name="contact-message"`).

## Images

All real photography is in place under `assets/images/` (logo) and `assets/images/menu/` (dish photos). Nothing left to swap in — DoorDash watermarks were cropped off the source photos before adding them.

## Next up

- Catering cost calculator (planned, not yet built)
- Netlify Forms wiring (see above)
