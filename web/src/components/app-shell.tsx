"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";

type Props = {
  user: {
    name: string;
    email: string;
    image?: string | null;
  };
  isAdmin: boolean;
  children: React.ReactNode;
};

export function AppShell({ user, isAdmin, children }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [avatarFailed, setAvatarFailed] = useState(false);
  const showAvatar = Boolean(user.image) && !avatarFailed;

  async function signOut() {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <div className="portal-shell">
      <aside className="portal-sidebar">
        <Link className="portal-brand" href="/dashboard" aria-label="Chrome Mirror dashboard">
          <span className="portal-logo">
            <Image src="/brand-icon.png" alt="Chrome Mirror" width={34} height={34} priority />
          </span>
          <span>
            <strong>Chrome Mirror</strong>
            <small>Access console</small>
          </span>
        </Link>

        <nav className="portal-nav" aria-label="Primary navigation">
          <Link className={pathname === "/dashboard" ? "active" : ""} href="/dashboard">
            <LayoutDashboard size={17} />
            Dashboard
          </Link>
          <a href="#license">
            <KeyRound size={17} />
            License
          </a>
          <a href="#payments">
            <Activity size={17} />
            Payments
          </a>
          {isAdmin ? (
            <Link className={pathname.startsWith("/admin") ? "active" : ""} href="/admin">
              <ShieldCheck size={17} />
              Admin
            </Link>
          ) : null}
        </nav>

        <div className="portal-sidebar-foot">
          <a
            href={process.env.NEXT_PUBLIC_GITHUB_REPO}
            target="_blank"
            rel="noreferrer"
          >
            Public source
            <ExternalLink size={14} />
          </a>
          <span>Official service</span>
        </div>
      </aside>

      <div className="portal-main">
        <header className="portal-topbar">
          <div>
            <span className="topbar-kicker">
              {pathname.startsWith("/admin") ? "Administration" : "Customer portal"}
            </span>
            <strong>{pathname.startsWith("/admin") ? "Operations" : "Your access"}</strong>
          </div>
          <div className="account-cluster">
            {showAvatar && user.image ? (
              <Image
                className="account-avatar"
                src={user.image}
                alt={`${user.name} profile photo`}
                width={34}
                height={34}
                sizes="34px"
                referrerPolicy="no-referrer"
                unoptimized
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <span className="account-avatar fallback" aria-label={`${user.name} profile`}>
                {initials(user.name, user.email)}
              </span>
            )}
            <span className="account-copy">
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </span>
            <button className="icon-button" type="button" onClick={signOut} title="Sign out">
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main className="portal-content">{children}</main>
      </div>
    </div>
  );
}

function initials(name: string, email: string) {
  const value = name.trim() || email.split("@")[0] || "User";

  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "U";
}
