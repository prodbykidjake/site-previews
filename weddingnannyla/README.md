# Wedding Nanny LA

Website previews for Wedding Nanny LA: childcare at weddings and events in Los Angeles and surrounding Southern California.

| Version | Template | File |
|---|---|---|
| Version 1 | 8B community template (soft pinks, arches, rounded cards) | `index.html` |
| Version 2 | 8B florist template (blush, deep plum, magenta, square edges) | `v2/index.html` |

Both versions have the same content: services, the kids' space, a sample wedding day (version 2), packages, the price calculator, personalized care and group sizes, how booking works, safety, the service area, notes for couples and parents, the guest check-in form, FAQ and the inquiry form.

## How it works today

- **Inquiry form:** the visitor fills it in. The page writes up the inquiry and opens a text or email to 818-282-0492 / jazz1234gomez@yahoo.com that is already filled in. Nothing is stored on a server.
- **Price calculator:** caregivers = number of kids ÷ 4, rounded up. Then caregivers × hours × $50, plus the optional activity setup. Weddings use at least 4 hours and private events at least 3. It also shows the 30% retainer and the balance due 7 days before the event. "Ask for a proposal with these numbers" fills in the inquiry form.
- **Package buttons** fill in the inquiry form with that package.
- **Guest check-in form:** a working preview. Parents can add up to 6 children and see a summary. **It doesn't send or save anything yet.** Making it live needs a secure backend, because it collects children's medical and pickup information.

## Placeholders to replace

| What | Where | Now |
|---|---|---|
| Photos | `photos/*.svg` | Drawn placeholders, labelled "PLACEHOLDER PHOTO" |
| Planning ratio | `RATIO` in the build, `ratio` in the page script | About 4 kids per caregiver, shown as an estimate only |
| Activity setup price | `SETUP` / `setup` | $150 |
| Package sizes and prices | Packages section | Sample packages at $50 per caregiver, per hour |
| Her note to couples | Letter (v1) and notes (v2) sections, marked `<!-- EDIT -->` | Draft text |
| Mileage on the version 2 service-area scale | Service area section | Rough distances from downtown LA |

The settings at the top of the page script (`const WN = { rate, ratio, setup, deposit, balanceDays, minHours }`) control the calculator.

## Safety wording

The safety section lists her launch priorities: CPR/First Aid requirements, background checks, insurance before accepting bookings, age-appropriate ratios and collecting information before each event. It says the business won't advertise specific certifications, completed checks, insurance coverage or guaranteed ratios until they're formally established and verified. Don't change it to a claim until each item is in place.

## Not included yet

- Testimonials (the business is new). Add a section once there's real client feedback.
- Online payments, and a backend for the inquiry and check-in forms.
