// KrankDVD booking API, a Cloudflare Worker.
//
// How a booking moves:
//   1. Client sends the form   -> POST /api/bookings      (status: pending)
//      David gets an email and a text with a private review link.
//   2. David opens the link    -> GET  /admin/:id?t=...    and taps Approve or Decline
//      On approve the client gets an email and a text with a card payment link
//      (Stripe) plus Zelle and Cash App details.          (status: approved)
//   3a. Client pays by card    -> Stripe calls POST /api/stripe-webhook
//   3b. Client pays by Zelle or Cash App -> David taps "Mark as paid" on the review page
//      Both send the booking confirmation to the client and to David. (status: paid)

import { STUDIOS, BEATS, SERVICES, MAX_HOURS } from "./catalog.js";

const YEAR = 60 * 60 * 24 * 365;
const CHECKOUT_LIFETIME = 60 * 60 * 23; // Stripe allows up to 24 hours

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/api/bookings") {
        if (request.method === "OPTIONS") return cors(request, env, new Response(null, { status: 204 }));
        if (request.method === "POST") return cors(request, env, await createBooking(request, env, ctx));
      }
      if (path === "/api/stripe-webhook" && request.method === "POST") {
        return await stripeWebhook(request, env, ctx);
      }
      let m = path.match(/^\/admin\/([A-Z0-9-]+)$/);
      if (m) {
        if (request.method === "GET") return await adminPage(m[1], url.searchParams.get("t"), env, url.origin);
        if (request.method === "POST") return await adminAction(m[1], request, env, ctx, url.origin);
      }
      m = path.match(/^\/pay\/([A-Z0-9-]+)$/);
      if (m && request.method === "GET") return await payRedirect(m[1], env, url.origin);
      if (path === "/") return new Response("KrankDVD booking API is running.", { headers: { "content-type": "text/plain" } });
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      return json({ error: "Something went wrong on our side. Text David at " + (env.OWNER_PHONE_DISPLAY || env.OWNER_PHONE) + "." }, 500);
    }
  },
};

/* ---------------------------------------------------------------- bookings */

async function createBooking(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The form data couldn't be read. Refresh the page and try again." }, 400);
  }

  // Bots fill in the hidden "website" field. Pretend it worked and drop it.
  if (body.website) return json({ ok: true, id: "KD-THANKS" });

  const result = validate(body);
  if (result.error) return json({ error: result.error }, 400);
  const booking = result.booking;

  booking.id = await uniqueId(env);
  booking.adminToken = randomToken();
  booking.status = "pending";
  booking.createdAt = new Date().toISOString();
  await save(env, booking);

  const origin = new URL(request.url).origin;
  const adminUrl = `${origin}/admin/${booking.id}?t=${booking.adminToken}`;
  const s = summary(booking);

  const jobs = [
    sendEmail(env, {
      to: env.OWNER_EMAIL,
      replyTo: booking.client.email,
      subject: `New ${booking.kind === "beat" ? "beat order" : "booking request"} ${booking.id}: ${booking.client.name}`,
      html: layout(
        "New request",
        `<p><strong>${esc(booking.client.name)}</strong> wants to book you.</p>
         ${detailsTable(booking)}
         ${button(adminUrl, "Review and approve")}
         <p style="color:#5a5f69;font-size:13px">Reply to this email to write to the client directly.</p>`
      ),
    }),
    sendSms(env, env.OWNER_PHONE, `New request ${booking.id} from ${booking.client.name}: ${s}. Review: ${adminUrl}`),
    sendEmail(env, {
      to: booking.client.email,
      replyTo: env.OWNER_EMAIL,
      subject: `Request received: ${booking.id}`,
      html: layout(
        "Request received",
        `<p>Hi ${esc(firstName(booking.client.name))}, thanks for reaching out. David will look at your request and get back to you by email and text.</p>
         ${detailsTable(booking)}
         <p>Nothing is due yet. Once David approves, you'll get a link to pay, and your session is locked in when payment comes through.</p>`
      ),
    }),
  ];
  ctx.waitUntil(Promise.allSettled(jobs).then(logFailures));

  return json({ ok: true, id: booking.id });
}

function validate(b) {
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const client = {
    name: str(b.name, 100),
    artist: str(b.artist, 100),
    email: str(b.email, 200).toLowerCase(),
    phone: str(b.phone, 30),
  };
  if (!client.name) return { error: "Add your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(client.email)) return { error: "Check your email address. It should look like name@example.com." };
  const digits = client.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return { error: "Add a phone number David can text, including the area code." };
  const notes = str(b.notes, 2000);

  if (b.kind === "beat") {
    const tier = BEATS[b.beatTier];
    if (!tier) return { error: "Pick a beat option." };
    return { booking: { kind: "beat", beatTier: b.beatTier, client, notes, estimate: tier.price * 100 } };
  }

  const studio = STUDIOS[b.studioId];
  if (!studio) return { error: "Pick a studio." };
  const budget = b.roomId === "budget";
  if (!budget && !(b.roomId in studio.rooms)) return { error: "Pick a room at " + studio.name + "." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "") || isNaN(Date.parse(b.date))) return { error: "Pick a date." };
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
  if (b.date < yesterday) return { error: "That date has passed. Pick an upcoming date." };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.start || "")) return { error: "Pick a start time." };
  const hours = Number(b.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) return { error: `Pick between 1 and ${MAX_HOURS} hours.` };
  if (!SERVICES[b.service]) return { error: "Pick what you need: recording, mixing, or both." };
  const budgetNote = str(b.budget, 200);

  return {
    booking: {
      kind: "session",
      studioId: b.studioId,
      roomId: budget ? "budget" : b.roomId,
      date: b.date,
      start: b.start,
      hours,
      service: b.service,
      budgetNote: budget ? budgetNote : "",
      client,
      notes,
      estimate: budget ? null : studio.rooms[b.roomId] * hours * 100,
    },
  };
}

/* ------------------------------------------------------------------- admin */

async function adminPage(id, token, env, origin, flash) {
  const booking = await load(env, id);
  if (!booking || !safeEqual(token || "", booking.adminToken)) {
    return html(layout("Link not valid", "<p>This review link isn't valid. Open the latest link from your email or text.</p>"), 404);
  }
  const action = `${origin}/admin/${booking.id}`;
  const hidden = `<input type="hidden" name="t" value="${esc(booking.adminToken)}">`;
  const amount = booking.amount != null ? booking.amount : booking.estimate;
  const amountValue = amount != null ? (amount / 100).toFixed(2) : "";

  let controls = "";
  if (booking.status === "pending" || booking.status === "approved") {
    const again = booking.status === "approved";
    controls += `
      <form method="post" action="${action}" class="card">
        ${hidden}<input type="hidden" name="action" value="approve">
        <h2>${again ? "Change the price and resend" : "Approve"}</h2>
        <label>Amount to charge (USD)
          <input name="amount" inputmode="decimal" required value="${amountValue}" placeholder="e.g. 250">
        </label>
        ${booking.estimate == null ? `<p class="hint">This is a special budget request, so there's no set price. Enter the amount you agreed on.</p>` : `<p class="hint">Website price: ${money(booking.estimate)}. Change it if you agreed on something different.</p>`}
        <label>Note to the client (optional)
          <textarea name="note" rows="3" placeholder="e.g. Bring your stems on a USB drive.">${esc(booking.approvalNote || "")}</textarea>
        </label>
        <button class="primary">${again ? "Resend payment details" : "Approve and send payment details"}</button>
      </form>`;
  }
  if (booking.status === "approved") {
    controls += `
      <form method="post" action="${action}" class="card">
        ${hidden}<input type="hidden" name="action" value="paid">
        <h2>Paid by Zelle or Cash App?</h2>
        <p class="hint">Card payments confirm on their own. If the client paid you directly, check you received it, then mark it here to send their confirmation.</p>
        <label>Paid with
          <select name="via"><option value="zelle">Zelle</option><option value="cashapp">Cash App</option><option value="other">Cash or other</option></select>
        </label>
        <button class="primary">Mark as paid and send confirmation</button>
      </form>`;
  }
  if (booking.status === "pending" || booking.status === "approved") {
    controls += `
      <form method="post" action="${action}" class="card">
        ${hidden}<input type="hidden" name="action" value="decline">
        <h2>Decline</h2>
        <label>Message to the client (optional)
          <textarea name="note" rows="3" placeholder="e.g. I'm booked that night. Can you do Friday instead?"></textarea>
        </label>
        <button class="danger">Decline request</button>
      </form>`;
  }

  const statusText = {
    pending: "Waiting for your approval",
    approved: `Approved for ${money(booking.amount)}. Waiting for payment.`,
    paid: `Paid${booking.paidVia ? " by " + payLabel(booking.paidVia) : ""}. The client has their confirmation.`,
    declined: "Declined. The client was told.",
  }[booking.status];

  const body = `
    ${flash ? `<p class="flash">${esc(flash)}</p>` : ""}
    <p class="status status-${booking.status}">${esc(statusText)}</p>
    ${detailsTable(booking, true)}
    ${controls}`;
  return html(layout(`${booking.id}`, body, ADMIN_CSS));
}

async function adminAction(id, request, env, ctx, origin) {
  const form = await request.formData();
  const token = String(form.get("t") || "");
  const booking = await load(env, id);
  if (!booking || !safeEqual(token, booking.adminToken)) {
    return html(layout("Link not valid", "<p>This review link isn't valid.</p>"), 403);
  }
  const action = String(form.get("action") || "");
  const note = String(form.get("note") || "").trim().slice(0, 1000);
  const name = firstName(booking.client.name);
  let flash;

  if (booking.status === "paid" || booking.status === "declined") {
    return adminPage(id, token, env, origin, "This request is already closed.");
  }

  if (action === "approve") {
    const dollars = Number(String(form.get("amount") || "").replace(/[$,\s]/g, ""));
    if (!isFinite(dollars) || dollars < 1 || dollars > 20000) {
      return adminPage(id, token, env, origin, "Enter an amount between $1 and $20,000.");
    }
    booking.amount = Math.round(dollars * 100);
    booking.approvalNote = note;
    booking.status = "approved";
    booking.approvedAt = new Date().toISOString();
    booking.checkoutUrl = null;
    booking.checkoutCreatedAt = null;
    if (env.STRIPE_SECRET_KEY) await refreshCheckout(booking, env, origin);
    await save(env, booking);

    const payUrl = `${origin}/pay/${booking.id}`;
    const jobs = [
      sendEmail(env, {
        to: booking.client.email,
        replyTo: env.OWNER_EMAIL,
        subject: `Approved: ${booking.id}. Pay ${money(booking.amount)} to lock it in`,
        html: layout(
          "You're approved",
          `<p>Hi ${esc(name)}, David approved your ${booking.kind === "beat" ? "beat order" : "session"}.</p>
           ${note ? `<p style="border-left:3px solid #000;padding-left:12px">${esc(note)}<br><span style="color:#5a5f69">David</span></p>` : ""}
           ${detailsTable(booking)}
           <h2 style="font-size:18px;margin:28px 0 8px">Pay ${money(booking.amount)}</h2>
           ${paymentOptionsHtml(env, booking, payUrl)}
           <p>Your ${booking.kind === "beat" ? "order" : "session"} is confirmed as soon as payment comes through. You'll get a confirmation email.</p>`
        ),
      }),
      sendSms(
        env,
        booking.client.phone,
        `KrankDVD: David approved ${booking.id}. Total ${money(booking.amount)}. ` +
          (env.STRIPE_SECRET_KEY ? `Pay by card: ${payUrl} or ` : "Pay by ") +
          paymentOptionsText(env) + `. Put ${booking.id} in the memo.`
      ),
    ];
    ctx.waitUntil(Promise.allSettled(jobs).then(logFailures));
    flash = `Approved. ${name} has the payment details by email and text.`;
  } else if (action === "decline") {
    booking.status = "declined";
    booking.declineNote = note;
    booking.declinedAt = new Date().toISOString();
    await save(env, booking);
    const jobs = [
      sendEmail(env, {
        to: booking.client.email,
        replyTo: env.OWNER_EMAIL,
        subject: `About your request ${booking.id}`,
        html: layout(
          "David can't take this one",
          `<p>Hi ${esc(name)}, David isn't able to take this request as sent.</p>
           ${note ? `<p style="border-left:3px solid #000;padding-left:12px">${esc(note)}<br><span style="color:#5a5f69">David</span></p>` : ""}
           ${detailsTable(booking)}
           <p>Nothing was charged. Reply to this email or send a new request on the site to try another time.</p>`
        ),
      }),
      sendSms(env, booking.client.phone, `KrankDVD: David can't take request ${booking.id} as sent.${note ? " " + note : ""} Check your email for details.`),
    ];
    ctx.waitUntil(Promise.allSettled(jobs).then(logFailures));
    flash = `Declined. ${name} has been told.`;
  } else if (action === "paid") {
    if (booking.status !== "approved") return adminPage(id, token, env, origin, "Approve the request first.");
    const via = ["zelle", "cashapp", "other"].includes(form.get("via")) ? String(form.get("via")) : "other";
    await markPaid(booking, via, env, ctx, origin);
    flash = `Marked as paid. ${name} has their confirmation.`;
  } else {
    return adminPage(id, token, env, origin, "That action isn't available.");
  }
  return adminPage(id, token, env, origin, flash);
}

async function markPaid(booking, via, env, ctx, origin) {
  booking.status = "paid";
  booking.paidVia = via;
  booking.paidAt = new Date().toISOString();
  await save(env, booking);
  const adminUrl = `${origin}/admin/${booking.id}?t=${booking.adminToken}`;
  const s = summary(booking);
  const where =
    booking.kind === "session"
      ? `<p><strong>Where:</strong> ${esc(STUDIOS[booking.studioId].name)}, ${esc(STUDIOS[booking.studioId].address)}<br>
         <a href="https://maps.google.com/?q=${encodeURIComponent(STUDIOS[booking.studioId].address)}">Open in Maps</a></p>`
      : "";
  const jobs = [
    sendEmail(env, {
      to: booking.client.email,
      replyTo: env.OWNER_EMAIL,
      subject: `Booking confirmed: ${booking.id}`,
      html: layout(
        "You're booked",
        `<p>Hi ${esc(firstName(booking.client.name))}, payment received. Your ${booking.kind === "beat" ? "beat order" : "session"} with KrankDVD is confirmed.</p>
         ${detailsTable(booking)}
         ${where}
         <p>Questions or running late? Text David at ${esc(env.OWNER_PHONE_DISPLAY || env.OWNER_PHONE)}.</p>`
      ),
    }),
    sendSms(env, booking.client.phone, `KrankDVD: You're booked. ${booking.id}: ${s}. Paid ${money(booking.amount)}. See you there.`),
    sendEmail(env, {
      to: env.OWNER_EMAIL,
      replyTo: booking.client.email,
      subject: `Paid: ${booking.id}, ${booking.client.name}, ${money(booking.amount)}`,
      html: layout("Booking paid", `<p>${esc(booking.client.name)} paid ${money(booking.amount)} by ${payLabel(via)}.</p>${detailsTable(booking)}${button(adminUrl, "Open booking")}`),
    }),
    sendSms(env, env.OWNER_PHONE, `Paid: ${booking.id} ${booking.client.name}, ${money(booking.amount)} by ${payLabel(via)}. ${s}`),
  ];
  ctx.waitUntil(Promise.allSettled(jobs).then(logFailures));
}

/* ------------------------------------------------------------------ stripe */

async function payRedirect(id, env, origin) {
  const booking = await load(env, id);
  const site = env.SITE_URL || origin;
  if (!booking) return html(layout("Booking not found", "<p>We couldn't find that booking. Check the link in your text or email.</p>"), 404);
  if (booking.status === "paid") return Response.redirect(`${site}/?paid=${booking.id}`, 303);
  if (booking.status !== "approved") {
    return html(layout("Not ready for payment", "<p>This booking isn't waiting for payment. If you think that's wrong, text David.</p>"), 409);
  }
  if (!env.STRIPE_SECRET_KEY) {
    return html(layout(`Pay ${money(booking.amount)}`, paymentOptionsHtml(env, booking, null)));
  }
  const age = booking.checkoutCreatedAt ? (Date.now() - Date.parse(booking.checkoutCreatedAt)) / 1000 : Infinity;
  if (!booking.checkoutUrl || age > CHECKOUT_LIFETIME - 600) {
    await refreshCheckout(booking, env, origin);
    await save(env, booking);
  }
  return Response.redirect(booking.checkoutUrl, 303);
}

async function refreshCheckout(booking, env, origin) {
  const site = env.SITE_URL || origin;
  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(booking.amount),
    "line_items[0][price_data][product_data][name]": `KrankDVD ${booking.kind === "beat" ? "beat order" : "session"} ${booking.id}`,
    "line_items[0][price_data][product_data][description]": summary(booking).slice(0, 300),
    customer_email: booking.client.email,
    client_reference_id: booking.id,
    "metadata[booking_id]": booking.id,
    "payment_intent_data[metadata][booking_id]": booking.id,
    success_url: `${site}/?paid=${booking.id}`,
    cancel_url: `${site}/?unpaid=${booking.id}`,
    expires_at: String(Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME),
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `${booking.id}-${booking.amount}-${Date.now()}`,
    },
    body: params,
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Stripe checkout failed: " + JSON.stringify(data.error || data));
  booking.checkoutUrl = data.url;
  booking.checkoutId = data.id;
  booking.checkoutCreatedAt = new Date().toISOString();
}

async function stripeWebhook(request, env, ctx) {
  const payload = await request.text();
  const ok = await verifyStripeSignature(payload, request.headers.get("stripe-signature") || "", env.STRIPE_WEBHOOK_SECRET || "");
  if (!ok) return new Response("Bad signature", { status: 400 });
  const event = JSON.parse(payload);
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object;
    const id = (session.metadata && session.metadata.booking_id) || session.client_reference_id;
    if (session.payment_status === "paid" && id) {
      const booking = await load(env, id);
      if (booking && booking.status !== "paid") {
        booking.stripeSessionId = session.id;
        if (typeof session.amount_total === "number") booking.amount = session.amount_total;
        await markPaid(booking, "card", env, ctx, new URL(request.url).origin);
      }
    }
  }
  return json({ received: true });
}

export async function verifyStripeSignature(payload, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  const signatures = header
    .split(",")
    .filter((kv) => kv.trim().startsWith("v1="))
    .map((kv) => kv.trim().slice(3));
  const t = parts.t;
  if (!t || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return signatures.some((sig) => safeEqual(sig, expected));
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------------------------------------------- email and text (SMS) */

async function sendEmail(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY) {
    console.log(`[email skipped, no RESEND_API_KEY] to=${to} subject=${subject}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html, reply_to: replyTo || undefined }),
  });
  if (!res.ok) throw new Error(`Email to ${to} failed: ${res.status} ${await res.text()}`);
}

async function sendSms(env, to, body) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
    console.log(`[text skipped, Twilio not set up] to=${to} body=${body}`);
    return;
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toE164(to), From: env.TWILIO_FROM, Body: body.slice(0, 1500) }),
  });
  if (!res.ok) throw new Error(`Text to ${to} failed: ${res.status} ${await res.text()}`);
}

function logFailures(results) {
  for (const r of results) if (r.status === "rejected") console.error(String(r.reason));
}

/* ---------------------------------------------------------------- helpers */

function paymentOptionsHtml(env, booking, payUrl) {
  const rows = [];
  if (payUrl && env.STRIPE_SECRET_KEY) rows.push(button(payUrl, `Pay ${money(booking.amount)} by card`));
  const direct = [];
  if (env.ZELLE_HANDLE) direct.push(`<li><strong>Zelle:</strong> ${esc(env.ZELLE_HANDLE)}${env.ZELLE_NAME ? ` (${esc(env.ZELLE_NAME)})` : ""}</li>`);
  if (env.CASHAPP_HANDLE) direct.push(`<li><strong>Cash App:</strong> ${esc(env.CASHAPP_HANDLE)}</li>`);
  if (direct.length) {
    rows.push(
      `<p>${payUrl && env.STRIPE_SECRET_KEY ? "Or pay directly:" : "Pay directly:"}</p><ul>${direct.join("")}</ul>
       <p>Put <strong>${esc(booking.id)}</strong> in the payment note so David can match it to your booking.</p>`
    );
  }
  return rows.join("");
}

function paymentOptionsText(env) {
  const opts = [];
  if (env.ZELLE_HANDLE) opts.push(`Zelle ${env.ZELLE_HANDLE}`);
  if (env.CASHAPP_HANDLE) opts.push(`Cash App ${env.CASHAPP_HANDLE}`);
  return opts.join(" or ");
}

function summary(b) {
  if (b.kind === "beat") return BEATS[b.beatTier].name;
  const studio = STUDIOS[b.studioId];
  const room = b.roomId === "budget" ? "special budget" : `Room ${b.roomId}`;
  return `${SERVICES[b.service]} at ${studio.name}, ${room}, ${fmtDate(b.date)} at ${fmtTime(b.start)}, ${b.hours} hr${b.hours > 1 ? "s" : ""}`;
}

function detailsTable(b, forOwner = false) {
  const rows = [["Booking", b.id]];
  if (b.kind === "beat") {
    rows.push(["Order", BEATS[b.beatTier].name]);
  } else {
    const studio = STUDIOS[b.studioId];
    rows.push(["Service", SERVICES[b.service]]);
    rows.push(["Studio", studio.name]);
    rows.push(["Room", b.roomId === "budget" ? "Special budget (custom quote)" : `Room ${b.roomId}, $${studio.rooms[b.roomId]}/hr`]);
    rows.push(["When", `${fmtDate(b.date)} at ${fmtTime(b.start)}`]);
    rows.push(["Length", `${b.hours} hour${b.hours > 1 ? "s" : ""}`]);
    if (b.budgetNote) rows.push(["Budget", b.budgetNote]);
  }
  if (b.amount != null) rows.push(["Total", money(b.amount)]);
  else if (b.estimate != null) rows.push(["Estimate", money(b.estimate)]);
  if (forOwner) {
    rows.push(["Name", b.client.name]);
    if (b.client.artist) rows.push(["Artist name", b.client.artist]);
    rows.push(["Email", b.client.email]);
    rows.push(["Phone", b.client.phone]);
  } else if (b.client.artist) {
    rows.push(["Artist name", b.client.artist]);
  }
  if (b.notes) rows.push(["Notes", b.notes]);
  return `<table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:15px">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 12px 8px 0;color:#5a5f69;vertical-align:top;white-space:nowrap;border-bottom:1px solid #d5d8dd">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #d5d8dd;white-space:pre-wrap">${esc(v)}</td></tr>`
    )
    .join("")}</table>`;
}

function button(href, label) {
  return `<p style="margin:24px 0"><a href="${esc(href)}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:14px 22px;border-radius:999px;font-weight:700">${esc(label)}</a></p>`;
}

function layout(title, body, extraCss = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | KrankDVD</title>
<style>body{margin:0;background:#e3e5e9;color:#000;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.wrap{max-width:560px;margin:0 auto;padding:32px 16px}.brand{font-weight:900;letter-spacing:.02em;font-size:20px;margin:0 0 24px}.sheet{background:#fff;border-radius:18px;padding:28px 24px}h1{font-size:26px;line-height:1.15;margin:0 0 12px}${extraCss}</style></head>
<body><div class="wrap"><p class="brand">KrankDVD</p><div class="sheet"><h1>${esc(title)}</h1>${body}</div></div></body></html>`;
}

const ADMIN_CSS = `.card{border:1px solid #d5d8dd;border-radius:14px;padding:18px;margin:18px 0}.card h2{font-size:18px;margin:0 0 12px}label{display:block;font-weight:600;font-size:14px;margin:12px 0}input,select,textarea{display:block;width:100%;box-sizing:border-box;margin-top:6px;font:inherit;padding:12px;border:1px solid #b9bdc4;border-radius:10px;background:#fff}button{font:inherit;font-weight:700;border:0;border-radius:999px;padding:14px 20px;width:100%;cursor:pointer;margin-top:8px}.primary{background:#000;color:#fff}.danger{background:#fff;color:#b3160d;border:1.5px solid #b3160d}.hint{color:#5a5f69;font-size:14px;margin:4px 0}.flash{background:#000;color:#fff;border-radius:10px;padding:12px 14px}.status{font-weight:700}.status-paid{color:#0a7a3d}.status-declined{color:#b3160d}`;

function money(cents) {
  if (cents == null) return "Quote";
  const d = cents / 100;
  return "$" + (Number.isInteger(d) ? d.toLocaleString("en-US") : d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

function payLabel(via) {
  return { card: "card", zelle: "Zelle", cashapp: "Cash App", other: "cash or other" }[via] || via;
}

function fmtDate(d) {
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  const hr = h % 12 || 12;
  return `${hr}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
}

function firstName(name) {
  return String(name).trim().split(/\s+/)[0];
}

function toE164(phone) {
  const d = String(phone).replace(/\D/g, "");
  if (String(phone).trim().startsWith("+")) return "+" + d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "+" + d;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function uniqueId(env) {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O or 1/I
  for (let tries = 0; tries < 5; tries++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = "KD-" + [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    if (!(await env.BOOKINGS.get("booking:" + id))) return id;
  }
  throw new Error("Couldn't create a booking ID");
}

async function load(env, id) {
  const raw = await env.BOOKINGS.get("booking:" + id);
  return raw ? JSON.parse(raw) : null;
}

async function save(env, booking) {
  await env.BOOKINGS.put("booking:" + booking.id, JSON.stringify(booking), { expirationTtl: YEAR });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" } });
}

function cors(request, env, response) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const headers = new Headers(response.headers);
  if (allowed.includes(origin) || allowed.includes("*")) {
    headers.set("access-control-allow-origin", origin || "*");
    headers.set("vary", "origin");
    headers.set("access-control-allow-methods", "POST, OPTIONS");
    headers.set("access-control-allow-headers", "content-type");
    headers.set("access-control-max-age", "86400");
  }
  return new Response(response.body, { status: response.status, headers });
}
