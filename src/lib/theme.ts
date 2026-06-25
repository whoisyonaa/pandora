import type { ThemeTokens } from "../types/vault";

export const defaultTheme: ThemeTokens = {
  id: "pandora-cipher",
  name: "Pandora Cipher",
  background: "#050505",
  panel: "#0d0d0d",
  border: "rgba(255, 255, 255, 0.16)",
  text: "#f4f4f1",
  muted: "#8d8d89",
  accent: "#f4f4f1",
  danger: "#ff4d5e",
  success: "#d7fff1",
};

export const lightTheme: ThemeTokens = {
  id: "paper-key",
  name: "Paper Key",
  background: "#f2f0e8",
  panel: "#fffdf5",
  border: "rgba(5, 5, 5, 0.18)",
  text: "#111111",
  muted: "#6b6861",
  accent: "#111111",
  danger: "#b42336",
  success: "#0f766e",
};

export const terminalTheme: ThemeTokens = {
  id: "terminal-green",
  name: "Terminal Green",
  background: "#030604",
  panel: "#07110b",
  border: "rgba(215, 255, 241, 0.18)",
  text: "#e9fff7",
  muted: "#83a99b",
  accent: "#d7fff1",
  danger: "#ff4d5e",
  success: "#59ffc8",
};

export const themes = [defaultTheme, terminalTheme, lightTheme];

export function applyTheme(theme: ThemeTokens) {
  const root = document.documentElement;
  root.style.setProperty("--bg", theme.background);
  root.style.setProperty("--panel", theme.panel);
  root.style.setProperty("--border", theme.border);
  root.style.setProperty("--text", theme.text);
  root.style.setProperty("--muted", theme.muted);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--danger", theme.danger);
  root.style.setProperty("--success", theme.success);
}

export function parseThemeJson(input: string, fallback: ThemeTokens): ThemeTokens {
  const parsed = JSON.parse(input) as Partial<ThemeTokens>;
  return {
    ...fallback,
    ...parsed,
    id: parsed.id || fallback.id,
    name: parsed.name || fallback.name,
  };
}
