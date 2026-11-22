// End-to-end test of the booking flow with fake email, text and Stripe services.
// Run: npm test   (needs Node 20+, no install required)
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { verifyStripeSignature } from "../src/index.js";

function setup({ stripe = true } = {}) {
  const store = new Map();
  const sent = { emails: [], texts: [], stripe: [] };
  const env = {
    BOOKINGS: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
    },
    SITE_URL: "https://krankdvdbooking.com",
    ALLOWED_ORIGINS: "https://krankdvdbooking.com",
    OWNER_EMAIL: "owner@example.com",
    OWNER_PHONE: "+12135550100",
    FROM_EMAIL: "KrankDVD <bookings@example.com>",
    ZELLE_HANDLE: "(213) 555-0100",
    CASHAPP_HANDLE: "$testtag",
    RESEND_API_KEY: "re_test",
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "tok",
    TWILIO_FROM: "+18185550100",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  };
  if (stripe) env.STRIPE_SECRET_KEY = "sk_test";
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.includes("resend.com")) sent.emails.push(JSON.parse(init.body));
    else if (url.includes("twilio.com")) sent.texts.push(Object.fromEntries(new URLSearchParams(init.body)));
    else if (url.includes("stripe.com")) {
      const p = Object.fromEntries(new URLSearchParams(init.body));
      sent.stripe.push(p);
      return Response.json({ id: "cs_test_" + sent.stripe.length, url: "https://checkout.stripe.com/c/pay/cs_test_" + sent.stripe.length });
    } else throw new Error("unexpected fetch " + url);
    return Response.json({ id: "ok" });
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = async (path, init = {}) => {
    const res = await worker.fetch(new Request("https://api.test" + path, init), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { env, store, sent, call };
}

const session = {
  kind: "session",
  studioId: "studio-lyfe",
  roomId: "A",
  date: "2099-01-10",
  start: "19:00",
  hours: 3,
  service: "recording",
  name: "Jane Artist",
  artist: "J.A.",
  email: "jane@example.com",
  phone: "(818) 555-0199",
  notes: "Bringing 2 songs",
};

const post = (body, origin = "https://krankdvdbooking.com") => ({
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify(body),
});

const form = (fields) => ({ method: "POST", body: new URLSearchParams(fields) });

async function sign(payload, secret) {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  return `t=${t},v1=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

test("full card flow: request, approve, Stripe pays, confirmation", async () => {
  const { store, sent, call } = setup();

  const res = await call("/api/bookings", post(session));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://krankdvdbooking.com");
  const { id } = await res.json();
  assert.match(id, /^KD-[A-Z0-9]{6}$/);

  const booking = JSON.parse(store.get("booking:" + id));
  assert.equal(booking.status, "pending");
  assert.equal(booking.estimate, 85 * 3 * 100);

  // David gets an email and a text with the review link; client gets a receipt.
  assert.equal(sent.emails.length, 2);
  assert.equal(sent.emails[0].to[0], "owner@example.com");
  assert.match(sent.emails[0].html, new RegExp(`/admin/${id}\\?t=${booking.adminToken}`));
  assert.equal(sent.emails[1].to[0], "jane@example.com");
  assert.equal(sent.texts[0].To, "+12135550100");
  assert.match(sent.texts[0].Body, /Review: https:\/\/api\.test\/admin\//);

  // Review page needs the right token.
  assert.equal((await call(`/admin/${id}?t=wrong`)).status, 404);
  const page = await call(`/admin/${id}?t=${booking.adminToken}`);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Approve and send payment details/);
  assert.match(pageHtml, /value="255.00"/);

  // Approve with an adjusted price.
  assert.equal((await call(`/admin/${id}`, form({ t: "nope", action: "approve", amount: "200" }))).status, 403);
  const approved = await call(`/admin/${id}`, form({ t: booking.adminToken, action: "approve", amount: "240", note: "Bring stems" }));
  assert.match(await approved.text(), /Approved\. Jane has the payment details/);
  const b2 = JSON.parse(store.get("booking:" + id));
  assert.equal(b2.status, "approved");
  assert.equal(b2.amount, 24000);
  assert.equal(sent.stripe.length, 1);
  assert.equal(sent.stripe[0]["line_items[0][price_data][unit_amount]"], "24000");
  assert.equal(sent.stripe[0]["metadata[booking_id]"], id);
  const approvalEmail = sent.emails.at(-1);
  assert.equal(approvalEmail.to[0], "jane@example.com");
  assert.match(approvalEmail.html, /\$240/);
  assert.match(approvalEmail.html, /Zelle/);
  assert.match(approvalEmail.html, /\$testtag/);
  assert.match(approvalEmail.html, /Bring stems/);
  assert.match(sent.texts.at(-1).Body, /Pay by card: https:\/\/api\.test\/pay\//);
  assert.equal(sent.texts.at(-1).To, "+18185550199");

  // Pay link redirects to Stripe.
  const pay = await call(`/pay/${id}`);
  assert.equal(pay.status, 303);
  assert.match(pay.headers.get("location"), /checkout\.stripe\.com/);

  // Webhook with a bad signature is rejected; a good one confirms the booking.
  const event = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_1", payment_status: "paid", amount_total: 24000, metadata: { booking_id: id } } },
  });
  assert.equal((await call("/api/stripe-webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" }, body: event })).status, 400);
  const before = sent.emails.length;
  const wh = await call("/api/stripe-webhook", { method: "POST", headers: { "stripe-signature": await sign(event, "whsec_test") }, body: event });
  assert.equal(wh.status, 200);
  const b3 = JSON.parse(store.get("booking:" + id));
  assert.equal(b3.status, "paid");
  assert.equal(b3.paidVia, "card");
  const confirmations = sent.emails.slice(before);
  assert.equal(confirmations.length, 2);
  assert.match(confirmations[0].subject, /Booking confirmed/);
  assert.match(confirmations[0].html, /10738 Riverside Dr/);
  assert.match(confirmations[1].subject, /Paid:/);

  // Webhook retries don't send twice.
  await call("/api/stripe-webhook", { method: "POST", headers: { "stripe-signature": await sign(event, "whsec_test") }, body: event });
  assert.equal(sent.emails.length, before + 2);

  // Paid bookings redirect back to the site.
  const after = await call(`/pay/${id}`);
  assert.equal(after.headers.get("location"), `https://krankdvdbooking.com/?paid=${id}`);
});

test("Zelle flow without Stripe: approve, mark paid manually", async () => {
  const { store, sent, call } = setup({ stripe: false });
  const { id } = await (await call("/api/bookings", post({ ...session, studioId: "the-watche", roomId: "budget", budget: "$150 for 2 songs" }))).json();
  const b = JSON.parse(store.get("booking:" + id));
  assert.equal(b.estimate, null);
  const page = await (await call(`/admin/${id}?t=${b.adminToken}`)).text();
  assert.match(page, /special budget request/);

  await call(`/admin/${id}`, form({ t: b.adminToken, action: "approve", amount: "$150" }));
  assert.equal(sent.stripe.length, 0);
  const email = sent.emails.at(-1);
  assert.doesNotMatch(email.html, /by card/);
  assert.match(email.html, /Pay directly/);
  assert.match(sent.texts.at(-1).Body, /Pay by Zelle/);

  const marked = await call(`/admin/${id}`, form({ t: b.adminToken, action: "paid", via: "zelle" }));
  assert.match(await marked.text(), /Marked as paid/);
  const b2 = JSON.parse(store.get("booking:" + id));
  assert.equal(b2.status, "paid");
  assert.equal(b2.paidVia, "zelle");
  assert.match(sent.emails.at(-2).subject, /Booking confirmed/);

  // Closed bookings can't be changed.
  const again = await call(`/admin/${id}`, form({ t: b.adminToken, action: "decline" }));
  assert.match(await again.text(), /already closed/);
});

test("beat order and decline", async () => {
  const { store, sent, call } = setup();
  const { id } = await (await call("/api/bookings", post({ kind: "beat", beatTier: "sameday", name: "Mo", email: "mo@example.com", phone: "2135550123", notes: "Dark trap" }))).json();
  const b = JSON.parse(store.get("booking:" + id));
  assert.equal(b.estimate, 20000);
  await call(`/admin/${id}`, form({ t: b.adminToken, action: "decline", note: "Full this week" }));
  assert.equal(JSON.parse(store.get("booking:" + id)).status, "declined");
  assert.match(sent.emails.at(-1).html, /Full this week/);
  assert.match(sent.texts.at(-1).Body, /Full this week/);
});

test("validation and spam handling", async () => {
  const { store, call } = setup();
  const bad = async (patch, msg) => {
    const res = await call("/api/bookings", post({ ...session, ...patch }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, msg);
  };
  await bad({ name: "" }, /Add your name/);
  await bad({ email: "nope" }, /email/);
  await bad({ phone: "123" }, /phone/);
  await bad({ studioId: "x" }, /Pick a studio/);
  await bad({ studioId: "boss-gang", roomId: "B" }, /Pick a room/);
  await bad({ date: "2001-01-01" }, /date has passed/);
  await bad({ hours: 0 }, /hours/);
  await bad({ hours: 2.5 }, /hours/);
  await bad({ service: "dj" }, /Pick what you need/);

  // A client can't set their own price.
  const { id } = await (await call("/api/bookings", post({ ...session, estimate: 1, amount: 1 }))).json();
  assert.equal(JSON.parse(store.get("booking:" + id)).estimate, 25500);

  // Honeypot submissions are dropped quietly.
  const size = store.size;
  const res = await call("/api/bookings", post({ ...session, website: "http://spam" }));
  assert.equal(res.status, 200);
  assert.equal(store.size, size);

  // Other websites get no CORS permission.
  const other = await call("/api/bookings", post(session, "https://evil.example"));
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("user text is escaped in emails and review page", async () => {
  const { store, sent, call } = setup();
  const { id } = await (await call("/api/bookings", post({ ...session, name: "<script>x</script>", notes: '"><img src=x>' }))).json();
  assert.doesNotMatch(sent.emails[0].html, /<script>x/);
  assert.doesNotMatch(sent.emails[0].html, /<img src=x>/);
  const b = JSON.parse(store.get("booking:" + id));
  const page = await (await call(`/admin/${id}?t=${b.adminToken}`)).text();
  assert.doesNotMatch(page, /<script>x/);
});

test("stripe signature check rejects stale timestamps", async () => {
  const old = Math.floor(Date.now() / 1000) - 1000;
  assert.equal(await verifyStripeSignature("{}", `t=${old},v1=abc`, "whsec"), false);
  assert.equal(await verifyStripeSignature("{}", "", "whsec"), false);
});
