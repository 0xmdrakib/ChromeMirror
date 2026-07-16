"use client";

import Image from "next/image";
import { LoaderCircle, LogIn } from "lucide-react";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignInPanel({ googleConfigured }: { googleConfigured: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    setLoading(true);
    setError("");
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
    });
    if (result?.error) {
      setError(result.error.message || "Google sign-in could not be started.");
      setLoading(false);
    }
  }

  return (
    <main className="sign-in-page">
      <section className="sign-in-panel">
        <div className="sign-in-brand">
          <Image src="/brand-icon.png" alt="" width={46} height={46} priority />
          <span>
            <strong>Chrome Mirror</strong>
            <small>Hosted access console</small>
          </span>
        </div>
        <div className="sign-in-copy">
          <span className="eyebrow">Secure account access</span>
          <h1>Sign in to your console</h1>
          <p>Manage your license, active computer, purchases, and access codes.</p>
        </div>
        <button
          className="google-button"
          type="button"
          onClick={signIn}
          disabled={!googleConfigured || loading}
        >
          {loading ? <LoaderCircle className="spin" size={19} /> : <LogIn size={19} />}
          Continue with Google
        </button>
        {!googleConfigured ? (
          <p className="inline-alert">Google OAuth is awaiting production configuration.</p>
        ) : null}
        {error ? <p className="inline-alert error">{error}</p> : null}
        <footer>
          <span>One active computer per license</span>
          <span>Up to 25 Chrome profiles</span>
        </footer>
      </section>
      <aside className="sign-in-aside" aria-label="Chrome Mirror product preview">
        <div className="preview-window">
          <div className="preview-titlebar">
            <span />
            <span />
            <span />
            <strong>Chrome Mirror</strong>
          </div>
          <div className="preview-body">
            <nav>
              <span className="selected">Session</span>
              <span>Profiles</span>
              <span>Activity</span>
            </nav>
            <div className="preview-workspace">
              <header>
                <span>
                  <small>Live session</small>
                  <strong>24 followers connected</strong>
                </span>
                <i>Broadcasting</i>
              </header>
              {["Store East", "Store Central", "Store West", "Backup"].map((name, index) => (
                <div className="preview-row" key={name}>
                  <b className={index === 3 ? "warning" : ""} />
                  <span>
                    <strong>{name}</strong>
                    <small>{index === 3 ? "Retry available" : "Queue clear"}</small>
                  </span>
                  <em>{index === 3 ? "Offline" : "Ready"}</em>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </main>
  );
}
