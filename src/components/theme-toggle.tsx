"use client";

import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

type Theme = "light" | "dark";

// Mirrors the inline blocking script in layout.tsx so the toggle's initial
// render matches whatever theme was already applied to <html> pre-hydration.
function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" ? "light" : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    setTheme(readInitialTheme());
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage can throw in private-browsing/blocked-storage contexts;
      // the toggle still works for the current tab, it just won't persist.
    }
  };

  return (
    <button
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--card)] border border-[var(--border)] hover:border-[var(--accent)] transition"
    >
      {theme === "dark" ? (
        <Sun className="w-4 h-4 text-[var(--text-muted)]" />
      ) : (
        <Moon className="w-4 h-4 text-[var(--text-muted)]" />
      )}
    </button>
  );
}
