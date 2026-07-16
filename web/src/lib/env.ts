import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(24),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  ADMIN_EMAIL: z.string().default(""),
  LICENSE_JWT_SECRET: z.string().min(24),
  LICENSE_KEY_ENCRYPTION_KEY: z.string().min(1),
  REDEEM_CODE_PEPPER: z.string().min(16),
  NOWPAYMENTS_API_KEY: z.string().default(""),
  NOWPAYMENTS_IPN_SECRET: z.string().default(""),
  NOWPAYMENTS_API_URL: z.string().url().default("https://api-sandbox.nowpayments.io/v1"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_GITHUB_REPO: z.string().url(),
  NEXT_PUBLIC_DOWNLOAD_URL: z.string().url(),
});

export const env = schema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  LICENSE_JWT_SECRET: process.env.LICENSE_JWT_SECRET,
  LICENSE_KEY_ENCRYPTION_KEY: process.env.LICENSE_KEY_ENCRYPTION_KEY,
  REDEEM_CODE_PEPPER: process.env.REDEEM_CODE_PEPPER,
  NOWPAYMENTS_API_KEY: process.env.NOWPAYMENTS_API_KEY,
  NOWPAYMENTS_IPN_SECRET: process.env.NOWPAYMENTS_IPN_SECRET,
  NOWPAYMENTS_API_URL: process.env.NOWPAYMENTS_API_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_GITHUB_REPO: process.env.NEXT_PUBLIC_GITHUB_REPO,
  NEXT_PUBLIC_DOWNLOAD_URL: process.env.NEXT_PUBLIC_DOWNLOAD_URL,
});
