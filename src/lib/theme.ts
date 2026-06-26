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
  const isLight = theme.id === "paper-key";
  const isTerminal = theme.id === "terminal-green";

  root.style.setProperty("--background-base", theme.background);
  root.style.setProperty("--background-panel", isLight ? "#e7e4d9" : theme.panel);
  root.style.setProperty("--surface-base", theme.panel);
  root.style.setProperty("--surface-raised", isLight ? "#faf7ec" : isTerminal ? "#0a1710" : "#131313");
  root.style.setProperty("--surface-hover", isLight ? "#ede9dc" : isTerminal ? "#0f2118" : "#191919");
  root.style.setProperty("--surface-selected", isLight ? "#ded9ca" : isTerminal ? "#12291e" : "#202020");
  root.style.setProperty("--border-subtle", theme.border);
  root.style.setProperty("--border-default", isLight ? "rgba(5, 5, 5, 0.28)" : isTerminal ? "rgba(215, 255, 241, 0.28)" : "rgba(255, 255, 255, 0.22)");
  root.style.setProperty("--border-strong", isLight ? "rgba(5, 5, 5, 0.48)" : isTerminal ? "rgba(215, 255, 241, 0.44)" : "rgba(255, 255, 255, 0.42)");
  root.style.setProperty("--text-primary", theme.text);
  root.style.setProperty("--text-secondary", theme.muted);
  root.style.setProperty("--text-muted", isLight ? "#7c776c" : theme.muted);
  root.style.setProperty("--text-disabled", isLight ? "#aaa397" : "#454545");
  root.style.setProperty("--accent-primary", theme.accent);
  root.style.setProperty("--accent-inverse", isLight ? "#fffdf5" : theme.background);
  root.style.setProperty("--status-success", theme.success);
  root.style.setProperty("--status-warning", isLight ? "#7c5f15" : "#c6b57f");
  root.style.setProperty("--status-danger", theme.danger);
  root.style.setProperty("--status-sync", isLight ? "#53606a" : isTerminal ? "#83a99b" : "#93a4b0");
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
