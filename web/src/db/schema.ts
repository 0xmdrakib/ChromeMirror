import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, (table) => [index("session_user_idx").on(table.userId)]);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("account_user_idx").on(table.userId),
  uniqueIndex("account_provider_idx").on(table.providerId, table.accountId),
]);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [index("verification_identifier_idx").on(table.identifier)]);

export const licenses = pgTable("licenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  keyHash: text("key_hash").notNull().unique(),
  keyCiphertext: text("key_ciphertext").notNull(),
  keyIv: text("key_iv").notNull(),
  keyTag: text("key_tag").notNull(),
  plan: text("plan").notNull(),
  status: text("status").notNull().default("active"),
  source: text("source").notNull().default("admin"),
  tokenVersion: integer("token_version").notNull().default(0),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("licenses_user_idx").on(table.userId),
  index("licenses_status_idx").on(table.status),
]);

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  licenseId: uuid("license_id").notNull().references(() => licenses.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),
  machineInfo: jsonb("machine_info"),
  appVersion: text("app_version"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("devices_license_device_idx").on(table.licenseId, table.deviceId),
  index("devices_last_seen_idx").on(table.lastSeenAt),
]);

export const deviceLeases = pgTable("device_leases", {
  licenseId: uuid("license_id").primaryKey().references(() => licenses.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  machineInfo: jsonb("machine_info"),
  appVersion: text("app_version"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("device_leases_expiry_idx").on(table.leaseExpiresAt)]);

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  orderId: text("order_id").notNull().unique(),
  providerInvoiceId: text("provider_invoice_id").unique(),
  providerPaymentId: text("provider_payment_id").unique(),
  invoiceUrl: text("invoice_url"),
  plan: text("plan").notNull(),
  amountUsdCents: integer("amount_usd_cents").notNull(),
  status: text("status").notNull().default("creating"),
  payCurrency: text("pay_currency"),
  payAmount: numeric("pay_amount", { precision: 30, scale: 12 }),
  payAddress: text("pay_address"),
  payinExtraId: text("payin_extra_id"),
  network: text("network"),
  paymentExpiresAt: timestamp("payment_expires_at", { withTimezone: true }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  grantAppliedAt: timestamp("grant_applied_at", { withTimezone: true }),
}, (table) => [
  index("payments_user_idx").on(table.userId, table.createdAt),
  index("payments_status_idx").on(table.status),
]);

export const redeemCodes = pgTable("redeem_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: text("code_hash").notNull().unique(),
  codePrefix: text("code_prefix").notNull(),
  plan: text("plan").notNull(),
  durationDays: integer("duration_days"),
  maxRedemptions: integer("max_redemptions").notNull().default(1),
  redemptionCount: integer("redemption_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("redeem_codes_status_idx").on(table.revokedAt, table.expiresAt)]);

export const redeemUses = pgTable("redeem_uses", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeId: uuid("code_id").notNull().references(() => redeemCodes.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  licenseId: uuid("license_id").notNull().references(() => licenses.id, { onDelete: "cascade" }),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("redeem_uses_code_user_idx").on(table.codeId, table.userId),
  index("redeem_uses_user_idx").on(table.userId),
]);

export const licenseEvents = pgTable("license_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  licenseId: uuid("license_id").references(() => licenses.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  event: text("event").notNull(),
  actor: text("actor").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("license_events_timeline_idx").on(table.createdAt)]);
