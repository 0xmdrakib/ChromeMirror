# Chrome Mirror Web

This Next.js application provides the hosted Chrome Mirror customer portal,
admin dashboard, Better Auth Google login, Neon-backed licensing API, redemption
codes, and NOWPayments checkout.

Vercel should import the repository with `web/` selected as the project root.
The production function region is configured as `iad1` in `vercel.json`.

## Local setup

```bash
npm ci
copy .env.example .env.local
npm run db:migrate
npm run dev
```

Fill every required value in `.env.local` before running the application. Google
OAuth uses this callback URL:

```text
http://localhost:3000/api/auth/callback/google
```

Use the deployed application origin instead of `http://localhost:3000` for the
production callback.

## Commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run db:generate
npm run db:migrate
```

Database credentials, auth secrets, encryption keys, signing keys, the admin
email, and NOWPayments credentials are server-only. Only `NEXT_PUBLIC_*` values
are exposed to browser code.

See the repository root `README.md` for the full self-hosting and deployment
guide.
