import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/chrome_mirror";
process.env.BETTER_AUTH_SECRET ||= "test-better-auth-secret-32-characters";
process.env.BETTER_AUTH_URL ||= "http://localhost:3000";
process.env.LICENSE_JWT_SECRET ||= "test-license-jwt-secret-32-characters";
process.env.LICENSE_KEY_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
process.env.REDEEM_CODE_PEPPER ||= "test-redeem-code-pepper-32-characters";
process.env.NOWPAYMENTS_IPN_SECRET ||= "test-nowpayments-secret";
process.env.NEXT_PUBLIC_APP_URL ||= "http://localhost:3000";
process.env.NEXT_PUBLIC_GITHUB_REPO ||= "https://github.com/0xmdrakib/ChromeMirror";
process.env.NEXT_PUBLIC_DOWNLOAD_URL ||= "https://github.com/0xmdrakib/ChromeMirror/releases/latest";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "server-only",
        replacement: fileURLToPath(new URL("./src/test/server-only.ts", import.meta.url)),
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
