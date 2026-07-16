# Chrome Mirror

Chrome Mirror is a Windows desktop application that mirrors one leader Chrome
profile to as many as 24 follower profiles. This repository also contains an
optional hosted licensing service, customer portal, and admin dashboard.

The source is MIT licensed and self-hostable. Purchases apply to the hosted
service and official builds, not to the right to read, modify, or self-host the
source.

## Features

### Desktop

- One leader and 1 to 24 simultaneous followers
- Click, typing, scrolling, navigation, and multi-tab fan-out
- Per-follower event queues that preserve order and isolate failures
- Browser launches in batches of three with progress and retry controls
- Minimized, tiled-across-displays, and last-used window layouts
- Compact Session, Profiles, Activity, and Settings views
- System light and dark themes
- License-key-only activation with a releasable one-computer lease
- 60-second heartbeats and a 10-minute offline allowance
- Hardened Windows installer and ZIP builds

### Hosted web application

- Google sign-in using self-hosted Better Auth
- Neon Postgres with Drizzle migrations
- Customer license, device, redemption, checkout, and payment portal
- `$20 USD` annual access for 365 days
- `$30 USD` lifetime upgrade
- Single-use annual and lifetime access codes
- NOWPayments hosted invoices and signed, idempotent IPN processing
- Admin-only users, licenses, payments, devices, revenue, codes, and audit views
- Admin access restricted to the normalized `ADMIN_EMAIL` value

## Repository layout

```text
src/                 Electron main, preload, and renderer source
tests/               Desktop unit tests
scripts/             Build, syntax, and secret checks
web/                 Next.js portal, API routes, and Drizzle schema
web/drizzle/         Committed Postgres migrations
.github/workflows/   CI and tagged Windows release automation
```

The earlier Supabase backend and static admin console have been removed. No
Supabase users, licenses, or activations are imported.

## Requirements

- Windows 10 or 11 for the desktop application
- Google Chrome installed
- Node.js 22 and npm
- A Neon Postgres database for the hosted web application
- Google OAuth credentials
- A Vercel account for the recommended hosted deployment
- NOWPayments credentials only when payment checkout is enabled

## Desktop development

Install dependencies and start Electron:

```powershell
npm ci
$env:LICENSE_API_URL = "http://localhost:3000/api/v1/license"
npm start
```

`LICENSE_API_URL` is the only hosted-service setting used by the desktop app.
Official builds should set it to an HTTPS URL ending in `/api/v1/license`.

Run desktop checks:

```powershell
npm run lint:desktop
npm test
npm run prebuild
```

Create the Windows installer and ZIP:

```powershell
$env:LICENSE_API_URL = "https://portal.example.com/api/v1/license"
npm run dist
```

Build hardening is generated into `build-app/`; tracked source files are not
modified.

## Web application setup

Install dependencies:

```powershell
cd web
npm ci
Copy-Item .env.example .env.local
```

Configure `web/.env.local`:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon pooled Postgres connection string |
| `BETTER_AUTH_SECRET` | Better Auth signing secret |
| `BETTER_AUTH_URL` | Public application origin |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `ADMIN_EMAIL` | The only email allowed to access admin pages and APIs |
| `LICENSE_JWT_SECRET` | Desktop activation-session signing secret |
| `LICENSE_KEY_ENCRYPTION_KEY` | Base64-encoded 32-byte AES key |
| `REDEEM_CODE_PEPPER` | Server-only redemption-code HMAC secret |
| `NOWPAYMENTS_API_KEY` | NOWPayments API key |
| `NOWPAYMENTS_IPN_SECRET` | NOWPayments IPN signature secret |
| `NOWPAYMENTS_API_URL` | Sandbox or production API origin |
| `NEXT_PUBLIC_APP_URL` | Public application origin |
| `NEXT_PUBLIC_GITHUB_REPO` | Public source repository |
| `NEXT_PUBLIC_DOWNLOAD_URL` | Official GitHub release download |

Generate strong values for the local secrets. For example:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Create a fresh Neon project and apply the committed migration:

```powershell
npm run db:migrate
```

Then start the portal:

```powershell
npm run dev
```

The local site is available at `http://localhost:3000`.

## Google OAuth

Create a Google web OAuth client and add these authorized redirect URIs:

```text
http://localhost:3000/api/auth/callback/google
https://your-production-domain.example/api/auth/callback/google
```

Set the matching origins in `BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL`. A user
must sign in with Google before accessing the customer dashboard. Admin access
requires an exact, case-insensitive match with `ADMIN_EMAIL`; every admin API
route performs its own authorization check.

## NOWPayments

The default example uses the NOWPayments sandbox API. Checkout is created
server-side and IPN callbacks are accepted only when their HMAC-SHA512 signature
is valid. Access is granted only for a final `finished` payment whose USD amount
matches the stored order:

- Annual: `$20 USD`, extending from the later of today or the current expiry
- Lifetime: `$30 USD`, upgrading the user's existing license permanently

Failed, expired, partially paid, duplicate, and amount-mismatched callbacks do
not grant access. Configure the IPN URL as:

```text
https://your-production-domain.example/api/payments/nowpayments/ipn
```

## Vercel deployment

1. Import this repository into Vercel.
2. Set the Vercel Root Directory to `web`.
3. Add all variables from `web/.env.example` as project environment variables.
4. Use the production application URL for the Better Auth and public URL values.
5. Apply `web/drizzle/` to the production Neon branch.
6. Add the production Google OAuth callback.
7. Set the GitHub repository variable `LICENSE_API_URL` to the hosted endpoint
   before publishing a tagged desktop release.

Database, OAuth, encryption, signing, admin, and payment values must remain
server-only. Never prefix them with `NEXT_PUBLIC_`.

## License behavior

Each key may hold one active device lease. The lease is renewed every 60 seconds
and expires after 10 minutes without a valid heartbeat. Normal application exit,
the customer portal, and the admin dashboard can release it immediately.

A second computer receives `DEVICE_IN_USE` while the lease is valid. After a
stale takeover, the old activation token is rotated and receives
`SESSION_REPLACED`.

The versioned desktop API is:

```text
POST /api/v1/license/activate
POST /api/v1/license/verify
POST /api/v1/license/heartbeat
POST /api/v1/license/release
```

## Verification

Run the full local verification suite:

```powershell
npm run verify
npm audit
npm --prefix web audit
```

CI separately checks desktop syntax and tests, web linting, type checking, tests,
builds, migration drift, and credential-like values. Tags matching `v*` produce
a Windows installer, ZIP, and `SHA256SUMS.txt` GitHub release.

Before making a fork public, review the complete Git history for old credentials
as well as the current tree.

## Responsible use

Use Chrome Mirror only for browser sessions and websites you are authorized to
control. Follow website terms, account rules, automation limits, and applicable
law.

## License

Chrome Mirror is available under the [MIT License](LICENSE).
