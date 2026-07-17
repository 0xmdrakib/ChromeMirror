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
  Network,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Unplug,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

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
  payCurrency: string | null;
  payAmount: string | null;
  payAddress: string | null;
  payinExtraId: string | null;
  network: string | null;
  expiresAt: string | null;
  createdAt: string;
};

type CurrencyOption = {
  code: string;
  asset: "USDT" | "USDC";
  network: string;
  label: string;
};

type EmbeddedPayment = {
  id: string;
  plan: string;
  amountUsdCents: number;
  status: string;
  payCurrency: string | null;
  payAmount: string | null;
  payAddress: string | null;
  payinExtraId: string | null;
  network: string | null;
  expiresAt: string | null;
  createdAt: string;
};

const TERMINAL_PAYMENT_STATUSES = [
  "finished",
  "partially_paid",
  "failed",
  "refunded",
  "expired",
  "cancelled",
  "canceled",
];

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
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [checkoutState, setCheckoutState] = useState<{ plan: "annual" | "lifetime"; payment?: EmbeddedPayment } | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState("");
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState("");

  function showError(error: unknown) {
    setNotice({ message: error instanceof Error ? error.message : "Something went wrong.", error: true });
  }

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

  async function openCheckout(plan: "annual" | "lifetime") {
    setBusy(`currencies-${plan}`);
    setNotice(null);
    try {
      const data = await request("/api/payments/currencies");
      const nextCurrencies = data.currencies as CurrencyOption[];
      setCurrencies(nextCurrencies);
      setSelectedCurrency(nextCurrencies[0]?.code || "");
      setCheckoutState({ plan });
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  function resumeCheckout(payment: Payment) {
    setCheckoutState({ plan: payment.plan as "annual" | "lifetime", payment });
    setNotice(null);
  }

  async function createCheckout() {
    if (!checkoutState || !selectedCurrency) return;
    setBusy("checkout-create");
    setNotice(null);
    try {
      const data = await request("/api/payments/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: checkoutState.plan, payCurrency: selectedCurrency }),
      });
      setCheckoutState({ ...checkoutState, payment: data.payment });
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  function closeCheckout() {
    setCheckoutState(null);
    setCurrencies([]);
    setQr("");
    setCopied("");
  }

  async function copyPaymentValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1800);
    } catch (error) {
      showError(error);
    }
  }

  useEffect(() => {
    const payment = checkoutState?.payment;
    if (!payment?.payAddress) return;
    const qrText = payment.payinExtraId ? `${payment.payAddress}?memo=${payment.payinExtraId}` : payment.payAddress;
    QRCode.toDataURL(qrText, { width: 220, margin: 1, color: { dark: "#17202a", light: "#ffffff" } })
      .then(setQr)
      .catch(() => setQr(""));
  }, [checkoutState?.payment]);

  useEffect(() => {
    const payment = checkoutState?.payment;
    if (!payment || TERMINAL_PAYMENT_STATUSES.includes(payment.status)) return;
    const poll = async () => {
      try {
        const data = await request(`/api/payments/${payment.id}`);
        if (data.payment) {
          setCheckoutState((current) => current ? { ...current, payment: data.payment } : current);
          if (data.payment.status === "finished") {
            setNotice({ message: "Payment confirmed. Your access is now active." });
            router.refresh();
          }
        }
      } catch (error) {
        if (error instanceof Error && !error.message.includes("too soon")) showError(error);
      }
    };
    const timer = window.setInterval(poll, 6000);
    return () => window.clearInterval(timer);
  }, [checkoutState?.payment, router]);

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
          <button className="plan-row" onClick={() => openCheckout("annual")} disabled={busy.startsWith("checkout") || busy.startsWith("currencies")}>
            <span className="plan-mark annual"><RefreshCw size={18} /></span>
            <span>
              <strong>365 days</strong>
              <small>Starts after your current annual expiry</small>
            </span>
            <b>$20</b>
          </button>
          <button className="plan-row featured" onClick={() => openCheckout("lifetime")} disabled={busy.startsWith("checkout") || busy.startsWith("currencies")}>
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
            <span>Date</span><span>Plan</span><span>Amount</span><span>Status</span><span>Action</span>
          </div>
          {payments.length ? payments.map((payment) => (
            <div className="table-row" key={payment.id}>
              <span>{shortDate(payment.createdAt)}</span>
              <span>{payment.plan === "lifetime" ? "Lifetime" : "Annual"}</span>
              <span>${(payment.amountUsdCents / 100).toFixed(2)}</span>
              <span><i className={`status-chip ${payment.status === "finished" ? "success" : payment.status === "failed" || payment.status === "expired" ? "danger" : "pending"}`}>{payment.status.replaceAll("_", " ")}</i></span>
              <span>{payment.payAddress && !TERMINAL_PAYMENT_STATUSES.includes(payment.status) ? <button className="link-button" onClick={() => resumeCheckout(payment)}>Resume</button> : "-"}</span>
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

      {checkoutState ? (
        <div className="checkout-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeCheckout()}>
          <section className="checkout-dialog" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
            <header className="checkout-dialog-header">
              <div>
                <span className="eyebrow">Secure crypto checkout</span>
                <h2 id="checkout-title">{checkoutState.payment ? "Send payment" : "Choose a network"}</h2>
              </div>
              <button className="icon-button" onClick={closeCheckout} title="Close checkout"><X size={18} /></button>
            </header>
            {!checkoutState.payment ? (
              <>
                <p className="checkout-lead">Select the network you will use. Only USDT and USDC networks enabled for this merchant account appear here.</p>
                <div className="currency-grid">
                  {currencies.map((currency) => (
                    <button
                      className={`currency-option${selectedCurrency === currency.code ? " selected" : ""}`}
                      key={currency.code}
                      onClick={() => setSelectedCurrency(currency.code)}
                    >
                      <span className="currency-icon"><Network size={18} /></span>
                      <span><strong>{currency.asset}</strong><small>{currency.network}</small></span>
                      <i aria-hidden="true" />
                    </button>
                  ))}
                </div>
                <button className="button primary checkout-submit" onClick={createCheckout} disabled={!selectedCurrency || busy === "checkout-create"}>
                  {busy === "checkout-create" ? <LoaderCircle className="spin" size={16} /> : <QrCode size={16} />}
                  Show payment details
                </button>
              </>
            ) : (
              <PaymentInstructions payment={checkoutState.payment} qr={qr} copied={copied} onCopy={copyPaymentValue} />
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function PaymentInstructions({
  payment,
  qr,
  copied,
  onCopy,
}: {
  payment: EmbeddedPayment;
  qr: string;
  copied: string;
  onCopy: (value: string, label: string) => void;
}) {
  const terminal = TERMINAL_PAYMENT_STATUSES.includes(payment.status);
  const statusLabel = payment.status === "finished" ? "Payment confirmed" : payment.status.replaceAll("_", " ");
  return (
    <>
      <div className="checkout-summary">
        <span><small>Plan</small><strong>{payment.plan === "lifetime" ? "Lifetime" : "Annual"}</strong></span>
        <span><small>Network</small><strong>{payment.network || payment.payCurrency}</strong></span>
        <i className={`status-chip ${payment.status === "finished" ? "success" : terminal ? "danger" : "pending"}`}>{statusLabel}</i>
      </div>
      <div className="checkout-payment-grid">
        <div className="qr-panel">
          {qr ? <Image src={qr} alt="Payment QR code" width={188} height={188} unoptimized /> : <LoaderCircle className="spin" size={24} />}
          <small>Scan with your wallet</small>
        </div>
        <div className="payment-fields">
          <PaymentField label={`Send exactly (${payment.payCurrency || "crypto"})`} value={payment.payAmount || "Unavailable"} copied={copied === "amount"} onCopy={() => payment.payAmount && onCopy(payment.payAmount, "amount")} />
          <PaymentField label="Payment address" value={payment.payAddress || "Unavailable"} copied={copied === "address"} onCopy={() => payment.payAddress && onCopy(payment.payAddress, "address")} />
          {payment.payinExtraId ? <PaymentField label="Memo / destination tag" value={payment.payinExtraId} copied={copied === "memo"} onCopy={() => onCopy(payment.payinExtraId!, "memo")} /> : null}
          <p className="checkout-warning">Send only {payment.payCurrency} on the {payment.network} network. Sending another asset or network may permanently lose funds.</p>
        </div>
      </div>
      <div className="checkout-status-line">
        <span className={`status-dot ${payment.status === "finished" ? "done" : terminal ? "bad" : "live"}`} />
        <span>{payment.status === "finished" ? "Your license is being updated." : terminal ? `Payment ${statusLabel}.` : "Waiting for blockchain confirmation..."}</span>
        {payment.expiresAt ? <time>Expires {shortDateTime(payment.expiresAt)}</time> : null}
      </div>
    </>
  );
}

function PaymentField({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="payment-field">
      <small>{label}</small>
      <div><code>{value}</code><button className="icon-button" onClick={onCopy} disabled={value === "Unavailable"} title={`Copy ${label.toLowerCase()}`}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div>
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function shortDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
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
