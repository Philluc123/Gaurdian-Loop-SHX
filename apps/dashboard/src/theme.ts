// Light / dark / follow-the-system. The preference sets `data-theme` on <html>, which
// the tokens in styles.css key off; "system" removes it and lets the OS decide.
// index.html applies the stored choice before first paint, so there's no flash.

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const KEY = "gl-theme";
const ORDER: ThemePreference[] = ["system", "light", "dark"];

function read(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage blocked (private mode): just follow the system
  }
}

function apply(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePreference>(read);

  useEffect(() => {
    apply(pref);
    try {
      if (pref === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {
      /* the choice still applies for this visit */
    }
  }, [pref]);

  const cycle = useCallback(() => {
    setPref((p) => ORDER[(ORDER.indexOf(p) + 1) % ORDER.length]);
  }, []);

  return { pref, cycle };
}
