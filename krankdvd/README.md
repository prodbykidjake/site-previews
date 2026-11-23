# krankdvdbooking.com

Booking site for KrankDVD (David). Two parts:

| Part | What it is | Where |
|---|---|---|
| Website | One HTML file built on the 8B Cut Short template (MIT): all eight rooms with photos, rates, gear and Book buttons; services; the three studios; custom beats; about David; credits; how booking works; FAQ; the booking form. Photos in `photos/` | `index.html` |
| Version 2 | Same content on the 8B Ostro (boutique hotel) template | `v2/index.html` |
| Version 3 | Same content on the 8B Arcline (fitness) template | `v3/index.html` |
| Version 4 | Same content on the 8B Onda (design studio) template | `v4/index.html` |
| Version 5 | Same content on the 8B Tallyhouse (accountant) template | `v5/index.html` |
| Booking API | Cloudflare Worker that stores requests, texts and emails David, handles approve and decline, sends payment links and confirmations | `worker/` |

The website works without the API: the form writes up the request and opens a pre-filled text or email to David. Once the API is running, set `API_BASE` in `index.html` and the full automatic flow switches on.

## How a booking works (with the API)

1. Client picks a studio and room and sends the form.
2. David gets a **text and an email** with a private review link. The client gets an email saying the request was received.
3. David opens the link and taps **Approve** (he can change the price first, which is how special budget quotes work) or **Decline** (with an optional message).
4. On approve, the client gets a **text and an email** with:
   - a card payment link (Stripe), and
   - Zelle and Cash App details, with the booking ID to put in the payment note.
5. When the client pays:
   - **Card:** Stripe tells the API, and the confirmation goes out on its own.
   - **Zelle or Cash App:** David checks he got the money, opens the same review link and taps **Mark as paid**.
6. The client gets a **booking confirmation** by text and email with the studio address. David gets a "Paid" notice.

## Before going live: fill these in

- [ ] **Zelle details.** `worker/wrangler.toml` currently uses David's phone number as a guess (`ZELLE_HANDLE`). Confirm the phone or email his Zelle is on, and the name it shows (`ZELLE_NAME`).
- [ ] **Credits.** Replace the placeholder cards in `index.html` (search for `jr__card`).
- [ ] **Bio.** Replace the About David text in `index.html` (search for `EDIT:`).
- [ ] **Weddington Studios rates.** The Brick (C) and the Vault (D) show "Ask for rate". When they have rates, set them in both places listed under Changing prices.
- [ ] **Boss Gang gear list.** The room shows "coming soon" until there's a list.
- [ ] Optional: a cancellation and refund policy for the FAQ.

## Setting up the booking API

You need free accounts at **Cloudflare** (hosting), **Resend** (emails), and optionally **Stripe** (cards) and **Twilio** (texts). Each is free or pay-as-you-go at this size.

### 1. Domain

Buy `krankdvdbooking.com` (any registrar) and add it to Cloudflare (free plan). Host the website on Cloudflare Pages, Netlify or GitHub Pages by uploading `index.html`.

### 2. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create BOOKINGS   # paste the id into wrangler.toml
npx wrangler deploy
```

In `wrangler.toml`, uncomment the `routes` line so the API lives at `https://api.krankdvdbooking.com`, then deploy again.

### 3. Email (Resend)

1. Sign up at resend.com and add the domain `krankdvdbooking.com`. Add the DNS records it shows in Cloudflare.
2. Create an API key, then run `npx wrangler secret put RESEND_API_KEY`.

### 4. Card payments (Stripe, optional)

1. In Stripe, copy the secret key, then run `npx wrangler secret put STRIPE_SECRET_KEY`.
2. In Stripe, go to Developers, then Webhooks, and add the endpoint `https://api.krankdvdbooking.com/api/stripe-webhook` with the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
3. Copy the signing secret, then run `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.

Without Stripe, approval messages only show Zelle and Cash App.

### 5. Texts (Twilio, optional)

1. Buy a Twilio phone number. US numbers need A2P 10DLC registration before they can text customers, which takes a few days.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` with `npx wrangler secret put`.

Without Twilio, everything still goes out by email.

### 6. Connect the website

In `index.html`, set:

```js
const API_BASE = "https://api.krankdvdbooking.com";
```

Make sure the site's address is listed in `ALLOWED_ORIGINS` in `wrangler.toml`.

## Changing prices

Rates live in two places. Change both:

- `worker/src/catalog.js`: what clients are actually charged
- `index.html`: the `CATALOG` block in the booking script, plus the rate shown on each room and studio (search for `/hr` and `an hour`)

## Tests

```bash
cd worker && npm test
```

Runs the whole flow (request, approve, Stripe payment, Zelle payment, decline, beat orders, form checks) against fake email, text and Stripe services. No accounts needed.
