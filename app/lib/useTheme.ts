import { useCallback, useEffect, useState } from "react";

const THEME_KEY = "stax_theme";

export type Theme = "light" | "dark";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    return window.localStorage.getItem(THEME_KEY) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // localStorage ใช้งานไม่ได้ไม่ควรทำให้หน้า dashboard พัง
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme };
}