const debugLogKey = "pandora.debugLog.v1";
const maxEntries = 700;

export type DebugLogLevel = "info" | "warn" | "error";

export type DebugLogEntry = {
  at: string;
  level: DebugLogLevel;
  scope: string;
  message: string;
  details?: Record<string, unknown>;
};

function platformName() {
  const userAgent = navigator.userAgent || "";
  if (Boolean(window.Capacitor)) return "android-capacitor";
  if (userAgent.toLowerCase().includes("electron")) return "electron-windows";
  return "browser";
}

function readEntries(): DebugLogEntry[] {
  try {
    const raw = localStorage.getItem(debugLogKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DebugLogEntry[]) : [];
  } catch {
    return [];
  }
}

function safeDetails(details?: Record<string, unknown>) {
  if (!details) return undefined;
  const blocked = new Set(["password", "masterPassword", "ciphertext", "rawVault", "raw", "authorization"]);
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      if (blocked.has(key)) return [key, "[redacted]"];
      if (typeof value === "string" && value.length > 220) return [key, `${value.slice(0, 220)}...`];
      return [key, value];
    }),
  );
}

export function addDebugLog(scope: string, message: string, details?: Record<string, unknown>, level: DebugLogLevel = "info") {
  const entry: DebugLogEntry = {
    at: new Date().toISOString(),
    level,
    scope,
    message,
    details: safeDetails({
      platform: platformName(),
      ...details,
    }),
  };

  const entries = [...readEntries(), entry].slice(-maxEntries);
  localStorage.setItem(debugLogKey, JSON.stringify(entries));

  const text = `[${entry.level}] [${entry.scope}] ${entry.message}`;
  if (entry.level === "error") console.error(text, entry.details);
  else if (entry.level === "warn") console.warn(text, entry.details);
  else console.info(text, entry.details);
}

export function readDebugLogs() {
  return readEntries();
}

export function clearDebugLogs() {
  localStorage.removeItem(debugLogKey);
}

export function formatDebugLogs() {
  const entries = readEntries();
  const header = [
    "Pandora debug log",
    `Exported: ${new Date().toISOString()}`,
    `Platform: ${platformName()}`,
    `User agent: ${navigator.userAgent}`,
    `Entries: ${entries.length}`,
    "",
  ];

  return [
    ...header,
    ...entries.map((entry) => {
      const details = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
      return `${entry.at} ${entry.level.toUpperCase()} ${entry.scope}: ${entry.message}${details}`;
    }),
  ].join("\n");
}
