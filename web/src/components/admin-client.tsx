"use client";

import {
  Activity,
  Ban,
  Check,
  CircleDollarSign,
  ClipboardCopy,
  Clock3,
  CreditCard,
  KeyRound,
  Laptop,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  Unplug,
  Users,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type LicenseRow = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  maskedKey: string;
  plan: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  lease: {
    deviceId: string;
    appVersion: string | null;
    leaseExpiresAt: string;
    lastHeartbeatAt: string;
  } | null;
};

type UserRow = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  licenseId: string | null;
  plan: string | null;
  status: string | null;
};

type PaymentRow = {
  id: string;
  userName: string;
  userEmail: string;
  plan: string;
  amountUsdCents: number;
  status: string;
  providerPaymentId: string | null;
  createdAt: string;
};

type DeviceRow = {
  licenseId: string;
  userName: string;
  userEmail: string;
  deviceId: string;
  appVersion: string | null;
  lastHeartbeatAt: string;
  leaseExpiresAt: string;
};

type EventRow = {
  id: number;
  event: string;
  actor: string;
  createdAt: string;
  detail: unknown;
  userEmail: string | null;
};

export function AdminClient({
  kpis,
  revenue,
  users,
  licenses,
  payments,
  devices,
  events,
}: {
  kpis: { users: number; activeLicenses: number; onlineDevices: number; revenueCents: number };
  revenue: { month: string; revenue: number }[];
  users: UserRow[];
  licenses: LicenseRow[];
  payments: PaymentRow[];
  devices: DeviceRow[];
  events: EventRow[];
}) {
  const router = useRouter();
  const [view, setView] = useState<"licenses" | "users" | "payments" | "devices" | "audit">("licenses");
  const [search, setSearch] = useState("");
  const [selectedLicense, setSelectedLicense] = useState<LicenseRow | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const [codePlan, setCodePlan] = useState<"annual" | "lifetime">("annual");
  const [codeCount, setCodeCount] = useState(5);
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
  const [extendDays, setExtendDays] = useState(365);

  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return { users, licenses, payments, devices, events };
    return {
      users: users.filter((row) => includesQuery(query, row.name, row.email, row.plan, row.status)),
      licenses: licenses.filter((row) => includesQuery(query, row.userName, row.userEmail, row.maskedKey, row.plan, row.status)),
      payments: payments.filter((row) => includesQuery(query, row.userName, row.userEmail, row.plan, row.status, row.providerPaymentId)),
      devices: devices.filter((row) => includesQuery(query, row.userName, row.userEmail, row.deviceId, row.appVersion)),
      events: events.filter((row) => includesQuery(query, row.event, row.actor, row.userEmail)),
    };
  }, [devices, events, licenses, payments, query, users]);

  async function request(path: string, body?: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  async function licenseAction(action: string, extra?: Record<string, unknown>) {
    if (!selectedLicense) return;
    setBusy(action);
    try {
      await request(`/api/admin/licenses/${selectedLicense.id}`, { action, ...extra });
      setNotice({ message: "License updated." });
      setSelectedLicense(null);
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function issueLicense(userId: string, plan: "annual" | "lifetime") {
    setBusy(`issue-${userId}`);
    try {
      await request("/api/admin/licenses", { user_id: userId, plan });
      setNotice({ message: "License issued." });
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function generateCodes() {
    setBusy("codes");
    try {
      const data = await request("/api/admin/codes", { plan: codePlan, count: codeCount });
      setGeneratedCodes(data.codes);
      setNotice({ message: `${data.codes.length} access codes generated.` });
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function copyCodes() {
    await navigator.clipboard.writeText(generatedCodes.join("\n"));
    setNotice({ message: "Generated codes copied." });
  }

  async function reconcile(paymentId: string) {
    setBusy(`payment-${paymentId}`);
    try {
      await request(`/api/admin/payments/${paymentId}/reconcile`);
      setNotice({ message: "Payment reconciled." });
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

  return (
    <div className="admin-stack">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Service operations</span>
          <h1>Admin dashboard</h1>
          <p>Licenses, active computers, payments, and access events.</p>
        </div>
        <span className="admin-badge"><ShieldCheck size={16} /> Email protected</span>
      </section>

      {notice ? (
        <div className={`notice-bar${notice.error ? " error" : ""}`}>
          {notice.error ? <ShieldAlert size={16} /> : <Check size={16} />}
          {notice.message}
          <button onClick={() => setNotice(null)} title="Dismiss"><X size={14} /></button>
        </div>
      ) : null}

      <section className="admin-metrics">
        <Metric icon={<Users size={18} />} tone="blue" label="Google users" value={kpis.users.toLocaleString()} />
        <Metric icon={<KeyRound size={18} />} tone="green" label="Active licenses" value={kpis.activeLicenses.toLocaleString()} />
        <Metric icon={<Laptop size={18} />} tone="violet" label="Online computers" value={kpis.onlineDevices.toLocaleString()} />
        <Metric icon={<CircleDollarSign size={18} />} tone="coral" label="Finished revenue" value={`$${(kpis.revenueCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} />
      </section>

      <div className="admin-overview-grid">
        <section className="surface chart-surface">
          <div className="surface-heading">
            <div><span className="eyebrow">Finished payments</span><h2>Revenue</h2></div>
            <CreditCard size={18} />
          </div>
          <div className="revenue-chart">
            {revenue.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={revenue} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} />
                  <YAxis tickFormatter={(value) => `$${value}`} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} />
                  <Tooltip cursor={{ fill: "var(--surface-2)" }} formatter={(value) => [`$${Number(value).toFixed(2)}`, "Revenue"]} />
                  <Bar dataKey="revenue" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="chart-empty">Revenue appears after the first finished payment.</div>}
          </div>
        </section>

        <section className="surface code-surface">
          <div className="surface-heading">
            <div><span className="eyebrow">Manual access</span><h2>Generate codes</h2></div>
            <TicketCheck size={18} />
          </div>
          <div className="code-controls">
            <label>
              Plan
              <select value={codePlan} onChange={(event) => setCodePlan(event.target.value as "annual" | "lifetime")}>
                <option value="annual">Annual · 365 days</option>
                <option value="lifetime">Lifetime</option>
              </select>
            </label>
            <label>
              Quantity
              <input type="number" min={1} max={100} value={codeCount} onChange={(event) => setCodeCount(Math.max(1, Math.min(100, Number(event.target.value))))} />
            </label>
            <button className="button primary" onClick={generateCodes} disabled={busy === "codes"}>
              {busy === "codes" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
              Generate
            </button>
          </div>
          {generatedCodes.length ? (
            <div className="generated-codes">
              <div><strong>Reveal once</strong><button onClick={copyCodes}><ClipboardCopy size={14} /> Copy all</button></div>
              <pre>{generatedCodes.join("\n")}</pre>
            </div>
          ) : (
            <div className="codes-empty">Generated codes are revealed in this panel once.</div>
          )}
        </section>
      </div>

      <section className="surface admin-data-surface">
        <div className="admin-data-toolbar">
          <div className="admin-tabs">
            {([
              ["licenses", "Licenses", licenses.length],
              ["users", "Users", users.length],
              ["payments", "Payments", payments.length],
              ["devices", "Online", devices.length],
              ["audit", "Audit", events.length],
            ] as const).map(([id, label, count]) => (
              <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
                {label}<span>{count}</span>
              </button>
            ))}
          </div>
          <label className="search-field">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search records" />
          </label>
        </div>

        {view === "licenses" ? (
          <div className="data-table admin-table licenses-table">
            <div className="table-head"><span>Owner</span><span>Key</span><span>Plan</span><span>Status</span><span>Expiry</span></div>
            {filtered.licenses.map((row) => (
              <button className="table-row" key={row.id} onClick={() => setSelectedLicense(row)}>
                <span className="identity-cell"><strong>{row.userName}</strong><small>{row.userEmail}</small></span>
                <code>{row.maskedKey}</code>
                <span>{capitalize(row.plan)}</span>
                <span><i className={`status-chip ${row.status === "active" ? "success" : row.status === "suspended" ? "pending" : "danger"}`}>{row.status}</i></span>
                <span>{row.plan === "lifetime" ? "Never" : row.expiresAt ? shortDate(row.expiresAt) : "Expired"}</span>
              </button>
            ))}
            {!filtered.licenses.length ? <div className="table-empty">No matching licenses.</div> : null}
          </div>
        ) : null}

        {view === "users" ? (
          <div className="data-table admin-table users-table">
            <div className="table-head"><span>User</span><span>Joined</span><span>Access</span><span>Action</span></div>
            {filtered.users.map((row) => (
              <div className="table-row" key={row.id}>
                <span className="identity-cell"><strong>{row.name}</strong><small>{row.email}</small></span>
                <span>{shortDate(row.createdAt)}</span>
                <span>{row.licenseId ? `${capitalize(row.plan || "")} · ${row.status}` : "No license"}</span>
                <span>
                  {row.licenseId ? (
                    <button className="link-button" onClick={() => setSelectedLicense(licenses.find((item) => item.id === row.licenseId) || null)}>Open</button>
                  ) : (
                    <span className="inline-actions">
                      <button onClick={() => issueLicense(row.id, "annual")} disabled={busy === `issue-${row.id}`}>Annual</button>
                      <button onClick={() => issueLicense(row.id, "lifetime")} disabled={busy === `issue-${row.id}`}>Lifetime</button>
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {view === "payments" ? (
          <div className="data-table admin-table payments-table">
            <div className="table-head"><span>Customer</span><span>Plan</span><span>Amount</span><span>Status</span><span>Date</span><span></span></div>
            {filtered.payments.map((row) => (
              <div className="table-row" key={row.id}>
                <span className="identity-cell"><strong>{row.userName}</strong><small>{row.userEmail}</small></span>
                <span>{capitalize(row.plan)}</span>
                <span>${(row.amountUsdCents / 100).toFixed(2)}</span>
                <span><i className={`status-chip ${row.status === "finished" ? "success" : row.status === "failed" || row.status === "expired" ? "danger" : "pending"}`}>{row.status}</i></span>
                <span>{shortDate(row.createdAt)}</span>
                <span><button className="icon-button" onClick={() => reconcile(row.id)} disabled={!row.providerPaymentId || busy === `payment-${row.id}`} title="Reconcile payment">{busy === `payment-${row.id}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button></span>
              </div>
            ))}
          </div>
        ) : null}

        {view === "devices" ? (
          <div className="data-table admin-table devices-table">
            <div className="table-head"><span>Owner</span><span>Device</span><span>Version</span><span>Heartbeat</span><span>Lease</span></div>
            {filtered.devices.map((row) => (
              <div className="table-row" key={row.licenseId}>
                <span className="identity-cell"><strong>{row.userName}</strong><small>{row.userEmail}</small></span>
                <code>{row.deviceId.slice(0, 18)}…</code>
                <span>{row.appVersion || "Unknown"}</span>
                <span>{relativeTime(row.lastHeartbeatAt)}</span>
                <span><i className="status-chip success">Online</i></span>
              </div>
            ))}
            {!filtered.devices.length ? <div className="table-empty">No computers currently hold a valid lease.</div> : null}
          </div>
        ) : null}

        {view === "audit" ? (
          <div className="audit-list">
            {filtered.events.map((row) => (
              <div className="audit-row" key={row.id}>
                <span className="audit-icon"><Activity size={15} /></span>
                <span><strong>{row.event.replaceAll(".", " ")}</strong><small>{row.userEmail || "System"} · {row.actor}</small></span>
                <time>{relativeTime(row.createdAt)}</time>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {selectedLicense ? (
        <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelectedLicense(null)}>
          <aside className="license-drawer">
            <header>
              <span><small>License detail</small><strong>{selectedLicense.userName}</strong></span>
              <button className="icon-button" onClick={() => setSelectedLicense(null)} title="Close"><X size={17} /></button>
            </header>
            <div className="drawer-owner">
              <span className="metric-icon blue"><Users size={18} /></span>
              <span><strong>{selectedLicense.userEmail}</strong><small>{selectedLicense.maskedKey}</small></span>
            </div>
            <dl>
              <div><dt>Plan</dt><dd>{capitalize(selectedLicense.plan)}</dd></div>
              <div><dt>Status</dt><dd><i className={`status-chip ${selectedLicense.status === "active" ? "success" : "pending"}`}>{selectedLicense.status}</i></dd></div>
              <div><dt>Expires</dt><dd>{selectedLicense.plan === "lifetime" ? "Never" : selectedLicense.expiresAt ? shortDate(selectedLicense.expiresAt) : "Expired"}</dd></div>
              <div><dt>Created</dt><dd>{shortDate(selectedLicense.createdAt)}</dd></div>
            </dl>
            <section>
              <h3>Active computer</h3>
              {selectedLicense.lease ? (
                <div className="drawer-device">
                  <Laptop size={18} />
                  <span><strong>{selectedLicense.lease.deviceId.slice(0, 22)}…</strong><small>Heartbeat {relativeTime(selectedLicense.lease.lastHeartbeatAt)}</small></span>
                  <button className="icon-button" onClick={() => licenseAction("release_device")} title="Release computer"><Unplug size={15} /></button>
                </div>
              ) : <p className="drawer-empty">No current device lease.</p>}
            </section>
            <section>
              <h3>Access term</h3>
              <div className="extend-control">
                <input type="number" min={1} max={3650} value={extendDays} onChange={(event) => setExtendDays(Number(event.target.value))} />
                <button className="button secondary" onClick={() => licenseAction("extend", { days: extendDays })}><Clock3 size={15} /> Extend days</button>
              </div>
              <button className="button primary wide" onClick={() => licenseAction("upgrade_lifetime")}><Sparkles size={15} /> Upgrade to lifetime</button>
            </section>
            <footer>
              {selectedLicense.status === "active" ? (
                <button className="button secondary warning" onClick={() => licenseAction("suspend")}><Ban size={15} /> Suspend</button>
              ) : (
                <button className="button secondary" onClick={() => licenseAction("activate")}><ShieldCheck size={15} /> Activate</button>
              )}
              <button className="button secondary danger" onClick={() => licenseAction("cancel")}><X size={15} /> Cancel license</button>
            </footer>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ icon, tone, label, value }: { icon: React.ReactNode; tone: string; label: string; value: string }) {
  return <div><span className={`metric-icon ${tone}`}>{icon}</span><span><small>{label}</small><strong>{value}</strong></span></div>;
}

function includesQuery(query: string, ...values: unknown[]) {
  return values.some((value) => String(value || "").toLowerCase().includes(query));
}

function capitalize(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
