"use client";

import { Moon, Sun } from "lucide-react";

const THEME_STORAGE_KEY = "chrome-mirror-theme";

export function ThemeToggle({ className = "" }: { className?: string }) {
  function toggleTheme() {
    const root = document.documentElement;
    const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";

    root.dataset.theme = nextTheme;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The selected theme still applies when storage is unavailable.
    }
  }

  return (
    <button
      className={`icon-button theme-toggle ${className}`.trim()}
      type="button"
      onClick={toggleTheme}
      title="Toggle light and dark theme"
      aria-label="Toggle light and dark theme"
    >
      <Moon className="theme-icon theme-icon-to-dark" size={17} aria-hidden="true" />
      <Sun className="theme-icon theme-icon-to-light" size={17} aria-hidden="true" />
    </button>
  );
}
