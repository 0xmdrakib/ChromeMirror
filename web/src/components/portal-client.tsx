"use client";

import {
  CalendarDays,
  Check,
  Clipboard,
  Clock3,
  Code2,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Unplug,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type License = {
  id: string;
  plan: string;
  status: string;
  expires_at: string | null;
  maskedKey: string;
  lease: {
    deviceId: string;
    appVersion: string | null;
    machineInfo: unknown;
    lastHeartbeatAt: string;
    leaseExpiresAt: string;
    online: boolean;
  } | null;
} | null;

type Payment = {
  id: string;
  plan: string;
  amountUsdCents: number;
  status: string;
  createdAt: string;
};

export function PortalClient({
  license,
  payments,
  downloadUrl,
  sourceUrl,
}: {
  license: License;
  payments: Payment[];
  downloadUrl: string;
  sourceUrl: string;
}) {
  const router = useRouter();
  const [revealedKey, setRevealedKey] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [redeemValue, setRedeemValue] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);

  async function request(path: string, init?: RequestInit) {
    const response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  async function revealKey() {
    if (keyVisible) {
      setKeyVisible(false);
      return;
    }
    setBusy("key");
    try {
      if (!revealedKey) {
        const data = await request("/api/portal/license-key");
        setRevealedKey(data.key);
      }
      setKeyVisible(true);
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function copyKey() {
    try {
      let value = revealedKey;
      if (!value) {
        const data = await request("/api/portal/license-key");
        value = data.key;
        setRevealedKey(value);
      }
      await navigator.clipboard.writeText(value);
      setNotice({ message: "License key copied." });
    } catch (error) {
      showError(error);
    }
  }

  async function checkout(plan: "annual" | "lifetime") {
    setBusy(`checkout-${plan}`);
    setNotice(null);
    try {
      const data = await request("/api/payments/checkout", {
        method: "POST",
        body: JSON.stringify({ plan }),
      });
      window.location.assign(data.invoiceUrl);
    } catch (error) {
      showError(error);
      setBusy("");
    }
  }

  async function redeem() {
    setBusy("redeem");
    setNotice(null);
    try {
      await request("/api/portal/redeem", {
        method: "POST",
        body: JSON.stringify({ code: redeemValue }),
      });
      setRedeemValue("");
      setNotice({ message: "Access code applied." });
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function releaseDevice() {
    setBusy("release");
    try {
      await request("/api/portal/release-device", { method: "POST", body: "{}" });
      setNotice({ message: "Active computer released." });
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  function showError(error: unknown) {
    setNotice({ message: error instanceof Error ? error.message : "Something went wrong.", error: true });
  }

  const licenseKey = keyVisible ? revealedKey : license?.maskedKey || "No license assigned";
  const active = license?.status === "active";

  return (
    <div className="portal-stack">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Account overview</span>
          <h1>Chrome Mirror access</h1>
          <p>Your official build, license state, and active computer.</p>
        </div>
        <a className="button primary" href={downloadUrl} target="_blank" rel="noreferrer">
          <Download size={16} />
          Download for Windows
        </a>
      </section>

      {notice ? (
        <div className={`notice-bar${notice.error ? " error" : ""}`}>
          {notice.error ? <LockKeyhole size={16} /> : <Check size={16} />}
          {notice.message}
        </div>
      ) : null}

      <section className="metric-strip">
        <div>
          <span className={`metric-icon ${active ? "green" : "amber"}`}>
            <ShieldCheck size={18} />
          </span>
          <span>
            <small>License</small>
            <strong>{license ? capitalize(license.status) : "Not assigned"}</strong>
          </span>
        </div>
        <div>
          <span className="metric-icon blue">
            <CalendarDays size={18} />
          </span>
          <span>
            <small>Plan</small>
            <strong>{license ? (license.plan === "lifetime" ? "Lifetime" : "Annual") : "None"}</strong>
          </span>
        </div>
        <div>
          <span className="metric-icon coral">
            <Clock3 size={18} />
          </span>
          <span>
            <small>Access until</small>
            <strong>
              {license?.plan === "lifetime"
                ? "Never expires"
                : license?.expires_at
                  ? shortDate(license.expires_at)
                  : "No active term"}
            </strong>
          </span>
        </div>
        <div>
          <span className="metric-icon violet">
            <Laptop size={18} />
          </span>
          <span>
            <small>Computer</small>
            <strong>{license?.lease?.online ? "Online now" : "Available"}</strong>
          </span>
        </div>
      </section>

      <div className="portal-grid">
        <section className="surface license-surface" id="license">
          <div className="surface-heading">
            <div>
              <span className="eyebrow">Desktop activation</span>
              <h2>License key</h2>
            </div>
            <span className={`status-chip ${active ? "success" : "neutral"}`}>
              {license ? capitalize(license.status) : "No access"}
            </span>
          </div>
          <div className="license-key-field">
            <KeyRound size={18} />
            <code>{licenseKey}</code>
            <button className="icon-button" onClick={revealKey} disabled={!license || busy === "key"} title={keyVisible ? "Hide key" : "Reveal key"}>
              {busy === "key" ? <LoaderCircle className="spin" size={16} /> : keyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            <button className="icon-button" onClick={copyKey} disabled={!license} title="Copy key">
              <Copy size={16} />
            </button>
          </div>
          <div className="device-block">
            <div className="device-main">
              <span className={`device-state ${license?.lease?.online ? "online" : ""}`}>
                <Laptop size={20} />
              </span>
              <span>
                <strong>{license?.lease ? deviceName(license.lease.machineInfo) : "No active computer"}</strong>
                <small>
                  {license?.lease
                    ? `${license.lease.appVersion ? `Chrome Mirror ${license.lease.appVersion}` : "Chrome Mirror"} · last seen ${relativeTime(license.lease.lastHeartbeatAt)}`
                    : "This key can be activated on a computer."}
                </small>
              </span>
            </div>
            {license?.lease ? (
              <button className="button secondary danger" onClick={releaseDevice} disabled={busy === "release"}>
                {busy === "release" ? <LoaderCircle className="spin" size={15} /> : <Unplug size={15} />}
                Release
              </button>
            ) : null}
          </div>
        </section>

        <section className="surface plans-surface">
          <div className="surface-heading">
            <div>
              <span className="eyebrow">Hosted access</span>
              <h2>Choose a plan</h2>
            </div>
            <Sparkles size={18} />
          </div>
          <button className="plan-row" onClick={() => checkout("annual")} disabled={busy.startsWith("checkout")}>
            <span className="plan-mark annual"><RefreshCw size={18} /></span>
            <span>
              <strong>365 days</strong>
              <small>Starts after your current annual expiry</small>
            </span>
            <b>$20</b>
          </button>
          <button className="plan-row" onClick={() => checkout("lifetime")} disabled={busy.startsWith("checkout")}>
            <span className="plan-mark lifetime"><Sparkles size={18} /></span>
            <span>
              <strong>Lifetime</strong>
              <small>Permanent hosted access for this account</small>
            </span>
            <b>$30</b>
          </button>
          <div className="redeem-box">
            <label htmlFor="redeemCode">Access code</label>
            <div>
              <Clipboard size={16} />
              <input
                id="redeemCode"
                value={redeemValue}
                onChange={(event) => setRedeemValue(event.target.value.toUpperCase())}
                placeholder="CMRD-YEAR-XXXX-XXXX-XXXX"
              />
              <button onClick={redeem} disabled={!redeemValue || busy === "redeem"}>
                {busy === "redeem" ? <LoaderCircle className="spin" size={15} /> : "Apply"}
              </button>
            </div>
          </div>
        </section>
      </div>

      <section className="surface payment-surface" id="payments">
        <div className="surface-heading">
          <div>
            <span className="eyebrow">Billing activity</span>
            <h2>Payment history</h2>
          </div>
          <span className="record-count">{payments.length} records</span>
        </div>
        <div className="data-table portal-payments">
          <div className="table-head">
            <span>Date</span><span>Plan</span><span>Amount</span><span>Status</span>
          </div>
          {payments.length ? payments.map((payment) => (
            <div className="table-row" key={payment.id}>
              <span>{shortDate(payment.createdAt)}</span>
              <span>{payment.plan === "lifetime" ? "Lifetime" : "Annual"}</span>
              <span>${(payment.amountUsdCents / 100).toFixed(2)}</span>
              <span><i className={`status-chip ${payment.status === "finished" ? "success" : payment.status === "failed" || payment.status === "expired" ? "danger" : "pending"}`}>{payment.status.replaceAll("_", " ")}</i></span>
            </div>
          )) : (
            <div className="table-empty">No hosted-service payments yet.</div>
          )}
        </div>
      </section>

      <section className="source-band">
        <span className="source-icon"><Code2 size={20} /></span>
        <span>
          <strong>Public and self-hostable</strong>
          <small>The source remains available under the MIT license.</small>
        </span>
        <a className="button secondary" href={sourceUrl} target="_blank" rel="noreferrer">
          View repository
        </a>
      </section>
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function deviceName(machineInfo: unknown) {
  if (!machineInfo || typeof machineInfo !== "object") return "Windows computer";
  const info = machineInfo as Record<string, unknown>;
  return String(info.hostname || info.computerName || info.platform || "Windows computer");
}
