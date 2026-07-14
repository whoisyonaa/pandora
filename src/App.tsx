import { ChangeEvent, ClipboardEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";
import {
  Check,
  Clock3,
  Command,
  Copy,
  Delete as DeleteKey,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Fingerprint,
  Folder,
  FolderPlus,
  Globe,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Shuffle,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { SortMode, VaultEntry, VaultFolder, VaultState } from "./types/vault";
import { createEmptyVault } from "./lib/vaultFactory";
import { applyTheme, defaultTheme, themes } from "./lib/theme";
import {
  destroyVault,
  hasStoredVault,
  saveVault,
  unlockVault,
} from "./lib/storage";
import { generatePassword, type PasswordOptions } from "./lib/password";
import { importGooglePasswordsCsv } from "./lib/csvImport";
import { downloadWebDavVault, testWebDavConnection, uploadWebDavVault, type WebDavConfig } from "./lib/webdavSync";
import { buildCompatibleSyncPayload, mergeSyncedVaults, readSyncPayload } from "./lib/syncEngine";
import { addDebugLog, clearDebugLogs, formatDebugLogs, readDebugLogs } from "./lib/debugLog";
import { isValidPin, minPinLength, normalizePin, withLayeredAuthentication } from "./lib/pin";
import {
  changeDevicePin,
  clearDeviceAuth,
  getDeviceAuthStatus,
  resetDeviceAuthFailures,
  setupDeviceAuth,
  unlockDeviceWithBiometric,
  unlockDeviceWithPin,
  updateDeviceMasterPassword,
} from "./lib/deviceAuth";

const biometricUnlockKey = "pandora.biometricUnlock.v1";

type LocalSyncSession = {
  code: string;
  urls: string[];
  name?: string;
};

type LocalSyncHost = {
  name: string;
  code: string;
  urls: string[];
};

type VaultSection =
  | "overview"
  | "vault"
  | "favorites"
  | "recent"
  | "security"
  | "trash"
  | "settings";

type MobileDragState = {
  entryId: string;
  targetFolderId: string | null;
};

type PandoraDiscoveryPlugin = {
  scan(options?: { timeoutMs?: number }): Promise<{ hosts: LocalSyncHost[] }>;
};

const PandoraDiscovery = registerPlugin<PandoraDiscoveryPlugin>("PandoraDiscovery");

declare global {
  interface Window {
    pandoraSync?: {
      isAvailable: () => Promise<boolean>;
      start: (rawVault: string) => Promise<LocalSyncSession>;
      stop: () => Promise<void>;
      getReceived: () => Promise<string | null>;
      clearReceived: () => Promise<void>;
      onReceived: (callback: () => void) => () => void;
    };
  }
}

const generatorLabels: Record<keyof PasswordOptions, string> = {
  length: "Длина",
  uppercase: "A-Z",
  lowercase: "a-z",
  numbers: "0-9",
  symbols: "#$%",
  readable: "Читаемый",
};

function now() {
  return new Date().toISOString();
}

function newEntry(folderId: string): VaultEntry {
  return {
    id: crypto.randomUUID(),
    title: "",
    url: "",
    username: "",
    password: "",
    icon: "",
    folderId,
    tags: [],
    notes: "",
    createdAt: now(),
    updatedAt: now(),
    usedCount: 0,
  };
}

function normalizedHttpUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

function faviconFromUrl(value: string) {
  const url = normalizedHttpUrl(value);
  if (!url || (!url.hostname.includes(".") && url.hostname !== "localhost")) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=128`;
}

function isImageIcon(value?: string) {
  if (!value) return false;
  return /^https?:\/\//i.test(value) || value.startsWith("data:image/");
}

function siteIconCandidates(entry: VaultEntry) {
  const candidates: string[] = [];
  if (isImageIcon(entry.icon)) {
    candidates.push(entry.icon!);
  }

  const url = normalizedHttpUrl(entry.url);
  if (url) {
    candidates.push(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=128`,
      `https://icons.duckduckgo.com/ip3/${url.hostname}.ico`,
      `${url.origin}/favicon.ico`,
      `${url.origin}/apple-touch-icon.png`,
    );
  }

  return Array.from(new Set(candidates));
}

function EntryIcon({ entry, size = "normal" }: { entry: VaultEntry; size?: "normal" | "large" }) {
  const label = (entry.title || entry.username || "?").slice(0, 1).toUpperCase();
  const className = size === "large" ? "entry-icon-preview large" : "entry-icon-preview";
  const [iconIndex, setIconIndex] = useState(0);
  const candidates = siteIconCandidates(entry);

  useEffect(() => {
    setIconIndex(0);
  }, [entry.id, entry.icon, entry.url]);

  if (candidates[iconIndex]) {
    return (
      <span className={`${className} has-image`}>
        <img
          src={candidates[iconIndex]}
          alt=""
          onError={(event) => {
            if (iconIndex < candidates.length - 1) {
              setIconIndex((current) => current + 1);
            } else {
              event.currentTarget.style.display = "none";
            }
          }}
        />
        <b>{label}</b>
      </span>
    );
  }

  return <span className={className}>{entry.icon?.slice(0, 2).toUpperCase() || label}</span>;
}

function descendantFolderIds(folderId: string, folders: VaultFolder[]) {
  const ids = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    folders.forEach((folder) => {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    });
  }
  return ids;
}

function saveEntry(vault: VaultState, entry: VaultEntry): VaultState {
  const exists = vault.entries.some((item) => item.id === entry.id);
  const saved = { ...entry, deletedAt: undefined, updatedAt: now() };
  return {
    ...vault,
    entries: exists ? vault.entries.map((item) => (item.id === entry.id ? saved : item)) : [saved, ...vault.entries],
  };
}

function isDeletedEntry(entry: VaultEntry) {
  return Boolean(entry.deletedAt);
}

function activeEntries(entries: VaultEntry[]) {
  return entries.filter((entry) => !isDeletedEntry(entry));
}

function trashEntries(entries: VaultEntry[]) {
  return entries.filter(isDeletedEntry);
}

function entryFolderName(entry: VaultEntry, folders: VaultFolder[]) {
  return folders.find((folder) => folder.id === entry.folderId)?.name ?? "Все";
}

function passwordAgeDays(entry: VaultEntry) {
  const changedAt = new Date(entry.updatedAt || entry.createdAt).getTime();
  if (!Number.isFinite(changedAt)) return 0;
  return Math.max(0, Math.floor((Date.now() - changedAt) / 86400000));
}

function passwordRisk(entry: VaultEntry, entries: VaultEntry[]) {
  const duplicate = Boolean(entry.password) && entries.some((item) => item.id !== entry.id && item.password === entry.password);
  const weak = entry.password.length > 0 && entry.password.length < 10;
  const old = passwordAgeDays(entry) > 180;
  if (duplicate || weak) return "Требует внимания";
  if (old) return "Давно не менялся";
  return entry.password ? "Надёжный" : "Нет пароля";
}

function vaultSecurityStats(entries: VaultEntry[]) {
  const passwordCounts = new Map<string, number>();
  entries.forEach((entry) => {
    if (entry.password) passwordCounts.set(entry.password, (passwordCounts.get(entry.password) ?? 0) + 1);
  });
  const duplicate = entries.filter((entry) => entry.password && (passwordCounts.get(entry.password) ?? 0) > 1).length;
  const weak = entries.filter((entry) => entry.password && entry.password.length < 10).length;
  const old = entries.filter((entry) => entry.password && passwordAgeDays(entry) > 180).length;
  return { duplicate, weak, old };
}

function mergeVaults(localVault: VaultState, remoteVault: VaultState): VaultState {
  const fallbackRoot: VaultFolder = { id: crypto.randomUUID(), name: "Все", parentId: null, createdAt: now() };
  const localFolders = localVault.folders.length > 0 ? localVault.folders : [fallbackRoot];
  const localRoot = localFolders.find((folder) => folder.parentId === null) ?? localFolders[0];
  const folderMap = new Map<string, VaultFolder>();
  const remoteToLocalFolder = new Map<string, string>();

  localFolders.forEach((folder) => {
    folderMap.set(folder.id, folder.id === localRoot.id ? { ...folder, parentId: null } : folder);
  });

  function folderNameKey(name: string) {
    return name.trim().toLocaleLowerCase();
  }

  function resolveRemoteFolderId(remoteFolderId: string): string {
    const cached = remoteToLocalFolder.get(remoteFolderId);
    if (cached) return cached;

    const remoteFolder = remoteVault.folders.find((folder) => folder.id === remoteFolderId);
    if (!remoteFolder) return folderMap.has(remoteFolderId) ? remoteFolderId : localRoot.id;
    if (remoteFolder.parentId === null) {
      remoteToLocalFolder.set(remoteFolder.id, localRoot.id);
      return localRoot.id;
    }

    const localParentId = resolveRemoteFolderId(remoteFolder.parentId);
    const matchingFolder = Array.from(folderMap.values()).find(
      (folder) => folderNameKey(folder.name) === folderNameKey(remoteFolder.name) && (folder.parentId ?? null) === localParentId,
    );

    if (matchingFolder) {
      remoteToLocalFolder.set(remoteFolder.id, matchingFolder.id);
      return matchingFolder.id;
    }

    const mappedFolder = { ...remoteFolder, parentId: localParentId };
    folderMap.set(mappedFolder.id, mappedFolder);
    remoteToLocalFolder.set(remoteFolder.id, mappedFolder.id);
    return mappedFolder.id;
  }

  remoteVault.folders.forEach((folder) => resolveRemoteFolderId(folder.id));

  const entryMap = new Map<string, VaultEntry>();
  localVault.entries.forEach((entry) => entryMap.set(entry.id, entry));
  remoteVault.entries.forEach((remoteEntry) => {
    const mappedRemoteEntry = {
      ...remoteEntry,
      folderId: resolveRemoteFolderId(remoteEntry.folderId),
    };
    const localEntry = entryMap.get(remoteEntry.id);
    if (!localEntry) {
      entryMap.set(remoteEntry.id, mappedRemoteEntry);
      return;
    }

    const localTime = new Date(localEntry.updatedAt).getTime();
    const remoteTime = new Date(mappedRemoteEntry.updatedAt).getTime();
    entryMap.set(remoteEntry.id, remoteTime >= localTime ? mappedRemoteEntry : localEntry);
  });

  const folders = Array.from(folderMap.values());
  folders.sort((first, second) => {
    if (first.id === localRoot.id) return -1;
    if (second.id === localRoot.id) return 1;
    return first.createdAt.localeCompare(second.createdAt);
  });
  const entries = Array.from(entryMap.values()).sort((first, second) => new Date(second.updatedAt).getTime() - new Date(first.updatedAt).getTime());

  return {
    ...localVault,
    folders: folders.length > 0 ? folders : [{ id: crypto.randomUUID(), name: "Все", parentId: null, createdAt: now() }],
    entries,
    settings: {
      ...localVault.settings,
      sync: {
        ...localVault.settings.sync,
        lastSyncAt: new Date().toISOString(),
      },
    },
  };
}

function normalizeVault(vault: VaultState): VaultState {
  const demoPasswords = new Set(["change-me-after-unlock", "rotate-this-secret"]);
  const entries = vault.entries.filter((entry) => !demoPasswords.has(entry.password));
  const usedFolderIds = new Set(entries.map((entry) => entry.folderId));
  let folders = vault.folders.filter((folder) => {
    const isOldDemoFolder = ["Личное", "Работа"].includes(folder.name) && !usedFolderIds.has(folder.id);
    return !isOldDemoFolder;
  });

  if (folders.length === 0) {
    folders = [{ id: crypto.randomUUID(), name: "Все", parentId: null, createdAt: now() }];
  }

  folders = folders.map((folder, index) => (index === 0 ? { ...folder, name: folder.name || "Все", parentId: null } : folder));

  return {
    ...vault,
    folders,
    entries,
    settings: {
      ...vault.settings,
      theme: vault.settings.theme ?? defaultTheme,
      sync: {
        ...vault.settings.sync,
        googleDriveEnabled: vault.settings.sync.googleDriveEnabled ?? false,
        webdav: vault.settings.sync.webdav ?? {
          provider: "koofr",
          url: "https://app.koofr.net/dav/Koofr",
          username: "",
          password: "",
          filePath: "pandora-vault.pandora",
        },
        googleDrive: vault.settings.sync.googleDrive ?? { clientId: "" },
      },
    },
  };
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Splash() {
  return (
    <main className="splash-screen">
      <div className="cipher-grid" />
      <div className="splash-mark" aria-label="Pandora запускается">
        <img src="./pandora-mark.svg" alt="" />
      </div>
      <p>PANDORA</p>
    </main>
  );
}

function LockScreen({ onUnlock }: { onUnlock: (vault: VaultState, password: string) => void }) {
  const isAndroid =
    (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") ||
    (import.meta.env.DEV && new URLSearchParams(window.location.search).get("platform") === "android");
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [masterPassword, setMasterPassword] = useState("");
  const [masterConfirmation, setMasterConfirmation] = useState("");
  const [pendingMasterPassword, setPendingMasterPassword] = useState("");
  const [pendingVault, setPendingVault] = useState<VaultState | null>(null);
  const [legacyEncryptionPassword, setLegacyEncryptionPassword] = useState("");
  const [pinSetupStep, setPinSetupStep] = useState<"first" | "confirm">("first");
  const [deviceConfigured, setDeviceConfigured] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [mode, setMode] = useState<"loading" | "pin" | "master" | "create-master" | "create-pin" | "migration-master" | "migration-pin">("loading");
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);

  const settingPin = mode === "create-pin" || mode === "migration-pin";
  const enteringMaster = mode === "master" || mode === "create-master" || mode === "migration-master";
  const credentialsReady = enteringMaster
    ? mode === "master"
      ? masterPassword.length > 0
      : masterPassword.length >= 8 && masterConfirmation.length >= 8
    : settingPin
      ? isAndroid
        ? pinSetupStep === "first"
          ? isValidPin(pin)
          : isValidPin(confirmation)
        : isValidPin(pin) && isValidPin(confirmation)
      : isValidPin(pin);

  useEffect(() => {
    getDeviceAuthStatus()
      .then((status) => {
        setDeviceConfigured(status.configured);
        setFailedAttempts(status.failedAttempts);
        if (!hasStoredVault()) setMode("create-master");
        else if (!status.configured || status.failedAttempts >= 3) setMode("master");
        else setMode("pin");
      })
      .catch(() => setMode(hasStoredVault() ? "master" : "create-master"));
  }, []);

  useEffect(() => {
    if (mode !== "pin" || !isAndroid) {
      setBiometricAvailable(false);
      return;
    }
    if (localStorage.getItem(biometricUnlockKey) !== "1" || !deviceConfigured) {
      setBiometricAvailable(false);
      return;
    }

    BiometricAuth.checkBiometry()
      .then((info) => setBiometricAvailable(Boolean(info.strongBiometryIsAvailable)))
      .catch(() => setBiometricAvailable(false));
  }, [deviceConfigured, isAndroid, mode]);

  function updatePin(value: string, target: "pin" | "confirmation" = "pin") {
    const digits = normalizePin(value);
    if (target === "confirmation") setConfirmation(digits);
    else setPin(digits);
    setError("");
  }

  function pressPinKey(value: string) {
    if (value === "delete") {
      const target = settingPin && pinSetupStep === "confirm" ? "confirmation" : "pin";
      const current = target === "confirmation" ? confirmation : pin;
      updatePin(current.slice(0, -1), target);
      return;
    }
    const target = settingPin && pinSetupStep === "confirm" ? "confirmation" : "pin";
    const current = target === "confirmation" ? confirmation : pin;
    updatePin(`${current}${value}`, target);
  }

  function resetCredential(nextMode: typeof mode) {
    setPin("");
    setConfirmation("");
    setMasterPassword("");
    setMasterConfirmation("");
    setPinSetupStep("first");
    setError("");
    setMode(nextMode);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (mode === "create-master" || mode === "migration-master") {
      if (masterPassword.length < 8) {
        setError("Мастер-пароль должен содержать минимум 8 символов.");
        return;
      }
      if (masterPassword !== masterConfirmation) {
        setError("Мастер-пароли не совпадают.");
        return;
      }
      setPendingMasterPassword(masterPassword);
      setMasterPassword("");
      setMasterConfirmation("");
      setMode(mode === "create-master" ? "create-pin" : "migration-pin");
      return;
    }

    if (mode === "master") {
      if (!masterPassword) {
        setError("Введите мастер-пароль.");
        return;
      }
      try {
        const unlocked = normalizeVault(await unlockVault(masterPassword));
        if (deviceConfigured) {
          await updateDeviceMasterPassword(masterPassword);
          await resetDeviceAuthFailures();
          onUnlock(withLayeredAuthentication(unlocked), masterPassword);
          return;
        }
        setPendingVault(unlocked);
        setLegacyEncryptionPassword(masterPassword);
        if (unlocked.settings.authMethods.masterPassword && !unlocked.settings.authMethods.pin) {
          setPendingMasterPassword(masterPassword);
          setMode("migration-pin");
        } else {
          setMasterPassword("");
          setMasterConfirmation("");
          setMode("migration-master");
        }
      } catch {
        setError("Мастер-пароль не подошёл.");
      }
      return;
    }

    if (!isValidPin(pin)) {
      setError(`PIN должен содержать минимум ${minPinLength} цифры.`);
      return;
    }
    if (settingPin && isAndroid && pinSetupStep === "first") {
      setPinSetupStep("confirm");
      return;
    }
    if (settingPin && !isValidPin(confirmation)) {
      setError("Повторите PIN-код.");
      return;
    }
    if (settingPin && pin !== confirmation) {
      setError("PIN-коды не совпадают.");
      return;
    }

    try {
      if (settingPin) {
        const nextMasterPassword = pendingMasterPassword;
        let vault = withLayeredAuthentication(pendingVault ?? createEmptyVault());
        const legacyWebdav = vault.settings.sync.webdav;
        if (
          legacyEncryptionPassword &&
          legacyEncryptionPassword !== nextMasterPassword &&
          legacyWebdav?.username.trim() &&
          legacyWebdav.password &&
          vault.settings.sync.lastSyncAt
        ) {
          const remoteRaw = await downloadWebDavVault(legacyWebdav);
          const remoteVault = normalizeVault((await readSyncPayload(remoteRaw, legacyEncryptionPassword)).vault);
          vault = withLayeredAuthentication(mergeSyncedVaults(vault, remoteVault).vault);
          await uploadWebDavVault(
            { ...legacyWebdav, filePath: `${legacyWebdav.filePath}.backup-before-master-migration` },
            remoteRaw,
          );
          await uploadWebDavVault(legacyWebdav, await buildCompatibleSyncPayload(vault, nextMasterPassword));
          await readSyncPayload(await downloadWebDavVault(legacyWebdav), nextMasterPassword);
        }
        await saveVault(vault, nextMasterPassword);
        await setupDeviceAuth(nextMasterPassword, pin);
        onUnlock(vault, nextMasterPassword);
      } else {
        const result = await unlockDeviceWithPin(pin);
        setFailedAttempts(result.failedAttempts);
        if (!result.masterPassword) {
          setPin("");
          if (result.requiresMasterPassword) {
            setMode("master");
            setError("Три неверные попытки. Введите мастер-пароль.");
          } else {
            setError(`Неверный PIN. Осталось попыток: ${result.remainingAttempts}.`);
          }
          return;
        }
        const vault = withLayeredAuthentication(normalizeVault(await unlockVault(result.masterPassword)));
        onUnlock(vault, result.masterPassword);
      }
    } catch (failure) {
      if (settingPin) {
        setError(failure instanceof Error ? failure.message : "Не удалось завершить настройку защиты.");
      } else {
        setError("Не удалось открыть хранилище. Введите мастер-пароль.");
        setMode("master");
      }
    }
  }

  async function unlockWithBiometry() {
    setError("");
    setBiometricBusy(true);
    try {
      const storedMasterPassword = await unlockDeviceWithBiometric();
      const vault = withLayeredAuthentication(normalizeVault(await unlockVault(storedMasterPassword)));
      await resetDeviceAuthFailures();
      onUnlock(vault, storedMasterPassword);
    } catch {
      setError("Не удалось войти по отпечатку. Введите PIN.");
    } finally {
      setBiometricBusy(false);
    }
  }

  return (
    <main className="unlock-shell">
      <CipherBackground variant="unlock" />
      <section className={`${error ? "unlock-panel has-error" : "unlock-panel"}${isAndroid ? " mobile-pin-panel" : ""}`}>
        <div className="unlock-brand">
          <div className="login-logo">
            <img src="./pandora-mark.svg" alt="Pandora" />
          </div>
          <div className="login-title">
            <h1>Pandora</h1>
          </div>
        </div>

        <form onSubmit={submit} className={isAndroid && !enteringMaster ? "login-form pin-login-form" : "login-form"}>
          {enteringMaster ? (
            <>
            <label>
              {mode === "master" ? "Мастер-пароль" : "Новый мастер-пароль"}
              <div className="unlock-password-line">
                <input
                  autoFocus
                  type={visible ? "text" : "password"}
                  value={masterPassword}
                  onChange={(event) => setMasterPassword(event.target.value)}
                  onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))}
                  autoComplete="current-password"
                />
                <button type="button" className="icon-button" onClick={() => setVisible((current) => !current)} aria-label={visible ? "Скрыть пароль" : "Показать пароль"}>
                  {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>
            {mode !== "master" && (
              <label>
                Повторите мастер-пароль
                <input type="password" value={masterConfirmation} onChange={(event) => setMasterConfirmation(event.target.value)} autoComplete="new-password" />
              </label>
            )}
            </>
          ) : isAndroid ? (
            <div className="mobile-pin-entry">
              <div className="pin-heading"><h2>{settingPin ? "Создайте PIN" : "Введите PIN"}</h2><p>{settingPin ? "Он защищает вход только на этом устройстве" : "Локальная защита Pandora"}</p></div>
              <div className="pin-indicator" aria-label={`Введено ${settingPin && pinSetupStep === "confirm" ? confirmation.length : pin.length} цифр`}>
                {Array.from({ length: Math.max(4, Math.min(8, (settingPin && pinSetupStep === "confirm" ? confirmation : pin).length || 4)) }).map((_, index) => (
                  <span key={index} className={index < (settingPin && pinSetupStep === "confirm" ? confirmation.length : pin.length) ? "filled" : ""} />
                ))}
              </div>
              {settingPin && <p className="pin-step-label">{pinSetupStep === "first" ? "PIN может отличаться на каждом устройстве" : "Повторите PIN для проверки"}</p>}
              <div className="pin-keypad" aria-label="Цифровая клавиатура">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                  <button type="button" key={digit} onClick={() => pressPinKey(digit)}>{digit}</button>
                ))}
                {biometricAvailable && mode === "pin" ? <button type="button" className="pin-symbol" onClick={unlockWithBiometry} aria-label="Войти по отпечатку"><Fingerprint size={22} /></button> : <span />}
                <button type="button" onClick={() => pressPinKey("0")}>0</button>
                <button type="button" className="pin-symbol" onClick={() => pressPinKey("delete")} aria-label="Удалить последнюю цифру"><DeleteKey size={22} /></button>
              </div>
            </div>
          ) : (
            <div className="pin-fields">
              <label>
                {settingPin ? "Новый PIN-код" : "PIN-код"}
                <input
                  autoFocus
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={pin}
                  onChange={(event) => updatePin(event.target.value, "pin")}
                  placeholder="Минимум 4 цифры"
                  autoComplete={settingPin ? "new-password" : "current-password"}
                />
              </label>
              {settingPin && (
                <label>
                  Повторите PIN-код
                  <input type="password" inputMode="numeric" pattern="[0-9]*" value={confirmation} onChange={(event) => updatePin(event.target.value, "confirmation")} autoComplete="new-password" />
                </label>
              )}
            </div>
          )}
          {enteringMaster && capsLock && <p className="inline-warning">Caps Lock включён.</p>}
          {error && <p className="error">{error}</p>}
          <button type="submit" className="primary wide" disabled={!credentialsReady || biometricBusy}>
            <Lock size={16} />
            {enteringMaster ? "Продолжить" : settingPin && isAndroid && pinSetupStep === "first" ? "Продолжить" : settingPin ? "Сохранить PIN" : "Войти"}
          </button>
          {biometricAvailable && mode === "pin" && !isAndroid && (
            <button type="button" className="wide" onClick={unlockWithBiometry} disabled={biometricBusy}>
              <Fingerprint size={16} />
              {biometricBusy ? "Проверка..." : "Войти по отпечатку"}
            </button>
          )}
        </form>

        {deviceConfigured && mode === "pin" && <button type="button" className="ghost-link" onClick={() => resetCredential("master")}>Войти мастер-паролем</button>}
        {deviceConfigured && mode === "master" && failedAttempts < 3 && <button type="button" className="ghost-link" onClick={() => resetCredential("pin")}>Вернуться к PIN</button>}
        {mode === "create-master" && <p className="pin-hint">Мастер-пароль шифрует хранилище и должен совпадать на всех устройствах.</p>}
      </section>
    </main>
  );
}

function FolderStrip({
  folders,
  entries,
  selectedFolder,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onDropEntry,
}: {
  folders: VaultFolder[];
  entries: VaultEntry[];
  selectedFolder: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void | Promise<void>;
  onRename: (folderId: string, name: string) => void | Promise<void>;
  onDelete: (folderId: string) => void | Promise<void>;
  onDropEntry: (entryId: string, folderId: string) => void | Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [menuFolderId, setMenuFolderId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const folderEntryCounts = useMemo(() => {
    const directCounts = new Map<string, number>();
    const children = new Map<string, string[]>();

    for (const entry of entries) {
      directCounts.set(entry.folderId, (directCounts.get(entry.folderId) ?? 0) + 1);
    }
    for (const folder of folders) {
      if (!folder.parentId) continue;
      const siblings = children.get(folder.parentId) ?? [];
      siblings.push(folder.id);
      children.set(folder.parentId, siblings);
    }

    const totals = new Map<string, number>();
    const countFolder = (folderId: string, visiting = new Set<string>()): number => {
      if (totals.has(folderId)) return totals.get(folderId) ?? 0;
      if (visiting.has(folderId)) return directCounts.get(folderId) ?? 0;
      const nextVisiting = new Set(visiting).add(folderId);
      const total = (directCounts.get(folderId) ?? 0) + (children.get(folderId) ?? []).reduce((sum, childId) => sum + countFolder(childId, nextVisiting), 0);
      totals.set(folderId, total);
      return total;
    };

    for (const folder of folders) countFolder(folder.id);
    return totals;
  }, [entries, folders]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  useEffect(() => {
    if (!menuFolderId) return;

    const closeMenu = (event: PointerEvent) => {
      if (!stripRef.current?.contains(event.target as Node)) setMenuFolderId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuFolderId(null);
    };

    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuFolderId]);

  async function submitFolder(event: FormEvent) {
    event.preventDefault();
    const normalizedName = folderName.trim();
    if (!normalizedName) return;
    await onCreate(normalizedName);
    setFolderName("");
    setCreating(false);
  }

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!editingId) return;
    const normalizedName = editingName.trim();
    if (!normalizedName) return;
    await onRename(editingId, normalizedName);
    setEditingId(null);
    setEditingName("");
  }

  const menuFolder = folders.find((folder) => folder.id === menuFolderId) ?? null;
  const deleteFolder = folders.find((folder) => folder.id === deleteFolderId) ?? null;

  return (
    <div className="folder-strip-shell" ref={stripRef}>
      <div className="folder-strip" aria-label="Папки">
      {folders.map((folder) => {
        return (
          <div
            key={folder.id}
            className={folder.id === selectedFolder ? "folder-chip active" : "folder-chip"}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const entryId = event.dataTransfer.getData("application/x-pandora-entry");
              if (entryId) onDropEntry(entryId, folder.id);
            }}
          >
            {editingId === folder.id ? (
              <form className="folder-rename" onSubmit={submitRename}>
                <input
                  ref={editInputRef}
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setEditingId(null);
                      setEditingName("");
                    }
                  }}
                  aria-label="Новое имя папки"
                />
                <button type="submit" className="folder-mini-action" aria-label="Сохранить имя папки" title="Сохранить">
                  <Check size={14} />
                </button>
                <button type="button" className="folder-mini-action" onClick={() => { setEditingId(null); setEditingName(""); }} aria-label="Отменить переименование" title="Отменить">
                  <X size={14} />
                </button>
              </form>
            ) : (
              <>
                <button
                  className="folder-chip-main"
                  type="button"
                  onClick={() => {
                    onSelect(folder.id);
                    setMenuFolderId(null);
                  }}
                >
                  <span>{folder.name}</span>
                  <small>{folderEntryCounts.get(folder.id) ?? 0}</small>
                </button>
                {folder.parentId !== null && (
                  <span className="folder-actions">
                    <button
                      type="button"
                      className="folder-more"
                      onClick={() => setMenuFolderId((current) => (current === folder.id ? null : folder.id))}
                      aria-label={`Действия с папкой ${folder.name}`}
                      aria-expanded={menuFolderId === folder.id}
                      title="Действия с папкой"
                    >
                      <MoreHorizontal size={17} />
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
      {creating ? (
        <form className="folder-create" onSubmit={submitFolder}>
          <input
            ref={inputRef}
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setFolderName("");
                setCreating(false);
              }
            }}
            placeholder="Новая папка"
          />
          <button type="submit" className="folder-add" aria-label="Сохранить папку" title="Сохранить папку">
            <Check size={17} />
          </button>
          <button
            type="button"
            className="folder-add"
            onClick={() => {
              setFolderName("");
              setCreating(false);
            }}
            aria-label="Отменить"
            title="Отменить"
          >
            <X size={17} />
          </button>
        </form>
      ) : (
        <button className="folder-add" type="button" onClick={() => { setCreating(true); setMenuFolderId(null); }} aria-label="Создать папку" title="Создать папку">
          <FolderPlus size={17} />
        </button>
      )}
      </div>
      {menuFolder && (
        <div className="folder-menu" role="menu" aria-label={`Действия с папкой ${menuFolder.name}`}>
          <div className="folder-menu-label">
            <Folder size={16} />
            <span>{menuFolder.name}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEditingId(menuFolder.id);
              setEditingName(menuFolder.name);
              setMenuFolderId(null);
            }}
          >
            <Pencil size={16} />
            Переименовать
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenuFolderId(null);
              setDeleteFolderId(menuFolder.id);
            }}
          >
            <Trash2 size={16} />
            Удалить папку
          </button>
        </div>
      )}
      {deleteFolder && (
        <div className="folder-confirm-scrim" role="presentation" onPointerDown={() => setDeleteFolderId(null)}>
          <section
            className="folder-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="folder-delete-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="folder-confirm-icon"><Trash2 size={20} /></div>
            <div>
              <h3 id="folder-delete-title">Удалить «{deleteFolder.name}»?</h3>
              <p>Сами записи не удалятся. Они будут перемещены в раздел «Все записи».</p>
            </div>
            <div className="folder-confirm-actions">
              <button type="button" onClick={() => setDeleteFolderId(null)}>Отмена</button>
              <button
                type="button"
                className="danger primary-danger"
                onClick={async () => {
                  const folderId = deleteFolder.id;
                  setDeleteFolderId(null);
                  await onDelete(folderId);
                }}
              >
                Удалить папку
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function EntryList({
  entries,
  selectedId,
  onSelect,
  onCreate,
  onDragStart,
}: {
  entries: VaultEntry[];
  selectedId: string | null;
  onSelect: (entry: VaultEntry) => void;
  onCreate: () => void;
  onDragStart: (entryId: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <section className="empty-state">
        <KeyRound size={34} />
        <h2>Записей пока нет</h2>
        <p>Нажмите плюс, чтобы добавить первый пароль.</p>
        <button className="primary" onClick={onCreate}>
          <Plus size={17} />
          Создать запись
        </button>
      </section>
    );
  }

  return (
    <section className="notes-list">
      {entries.map((entry) => (
        <button
          key={entry.id}
          className={entry.id === selectedId ? "note-row active" : "note-row"}
          onClick={() => onSelect(entry)}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-pandora-entry", entry.id);
            event.dataTransfer.setData("text/plain", entry.id);
            onDragStart(entry.id);
          }}
        >
          <EntryIcon entry={entry} />
          <span className="note-copy">
            <strong>{entry.title || "Новая запись"}</strong>
            <small>{entry.username || entry.url || "Логин не указан"}</small>
          </span>
          <span className="note-meta">{new Date(entry.updatedAt).toLocaleDateString("ru-RU")}</span>
        </button>
      ))}
    </section>
  );
}

function EntryEditor({
  entry,
  folders,
  onClose,
  onDelete,
  onSave,
}: {
  entry: VaultEntry;
  folders: VaultFolder[];
  onClose: () => void;
  onDelete: (id: string) => void;
  onSave: (entry: VaultEntry) => void;
}) {
  const [draft, setDraft] = useState(entry);
  const [visible, setVisible] = useState(false);
  const [showGenerator, setShowGenerator] = useState(!entry.password);
  const iconFileInputRef = useRef<HTMLInputElement | null>(null);
  const [options, setOptions] = useState<PasswordOptions>({
    length: 18,
    uppercase: true,
    lowercase: true,
    numbers: true,
    symbols: true,
    readable: false,
  });

  useEffect(() => {
    setDraft(entry);
    setShowGenerator(!entry.password);
  }, [entry]);

  function patch<K extends keyof VaultEntry>(key: K, value: VaultEntry[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function applySiteIcon() {
    const icon = faviconFromUrl(draft.url);
    if (icon) patch("icon", icon);
  }

  function readIconFile(file?: File | null) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        patch("icon", reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  function applyIconText(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      patch("icon", "");
      return;
    }
    patch("icon", isImageIcon(trimmed) ? trimmed : faviconFromUrl(trimmed) || trimmed);
  }

  function handleIconPaste(event: ClipboardEvent<HTMLDivElement>) {
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"));
    if (imageItem) {
      event.preventDefault();
      readIconFile(imageItem.getAsFile());
      return;
    }

    const text = event.clipboardData.getData("text");
    if (text.trim()) {
      event.preventDefault();
      applyIconText(text);
    }
  }

  function saveDraft() {
    onSave({ ...draft, icon: draft.icon || faviconFromUrl(draft.url) });
  }

  return (
    <aside className="editor-sheet" aria-label="Редактор записи">
      <div className="sheet-head">
        <EntryIcon entry={draft} size="large" />
        <div className="sheet-title">
          <h2>{draft.title || "Новая запись"}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть">
          <X size={18} />
        </button>
      </div>

      <div className="form-grid">
        <label>
          Название
          <input value={draft.title} onChange={(event) => patch("title", event.target.value)} placeholder="Например: Почта" />
        </label>
        <label>
          Логин
          <input value={draft.username} onChange={(event) => patch("username", event.target.value)} placeholder="email или username" />
        </label>
        <label>
          Сайт
          <input
            value={draft.url}
            onChange={(event) => patch("url", event.target.value)}
            onBlur={() => {
              if (!draft.icon) applySiteIcon();
            }}
            placeholder="https://example.com"
          />
        </label>
        <label>
          Папка
          <select value={draft.folderId} onChange={(event) => patch("folderId", event.target.value)}>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </label>
        <label className="span-2">
          Иконка записи
          <div className="icon-line" onPaste={handleIconPaste}>
            <input
              value={draft.icon || ""}
              onChange={(event) => patch("icon", event.target.value)}
              onBlur={(event) => applyIconText(event.target.value)}
              placeholder="Авто с сайта, ссылка на картинку или 1-2 буквы"
            />
            <button type="button" onClick={applySiteIcon} disabled={!draft.url.trim()}>
              <Shuffle size={16} />
              С сайта
            </button>
            <button type="button" onClick={() => iconFileInputRef.current?.click()}>
              <Upload size={16} />
              {"\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c"}
            </button>
            <input
              ref={iconFileInputRef}
              className="hidden-input"
              type="file"
              accept="image/*"
              onChange={(event) => {
                readIconFile(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </div>
          <small className="field-hint">{"\u0414\u043e\u043c\u0435\u043d, URL \u043a\u0430\u0440\u0442\u0438\u043d\u043a\u0438, \u0444\u0430\u0439\u043b \u0438\u043b\u0438 Ctrl+V."}</small>
        </label>
        <label className="span-2">
          Пароль
          <div className="password-line">
            <input
              type={visible ? "text" : "password"}
              value={draft.password}
              onChange={(event) => patch("password", event.target.value)}
              placeholder="Введите или сгенерируйте"
            />
            <button type="button" className="icon-button" onClick={() => setVisible((current) => !current)} aria-label="Показать пароль">
              {visible ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
            <button type="button" className="icon-button" onClick={() => navigator.clipboard.writeText(draft.password)} aria-label="Скопировать пароль">
              <Copy size={17} />
            </button>
          </div>
        </label>

        <button type="button" className="plain-action span-2" onClick={() => setShowGenerator((current) => !current)}>
          <Shuffle size={16} />
          {showGenerator ? "Скрыть генератор" : "Сгенерировать пароль"}
        </button>

        {showGenerator && (
          <section className="generator-box span-2">
            <label>
              {generatorLabels.length}: {options.length}
              <input
                type="range"
                min={8}
                max={48}
                value={options.length}
                onChange={(event) => setOptions({ ...options, length: Number(event.target.value) })}
              />
            </label>
            <div className="mini-toggles">
              {(["uppercase", "lowercase", "numbers", "symbols", "readable"] as const).map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={options[key]}
                    onChange={(event) => setOptions({ ...options, [key]: event.target.checked })}
                  />
                  {generatorLabels[key]}
                </label>
              ))}
            </div>
            <button type="button" onClick={() => patch("password", generatePassword(options))}>
              <Shuffle size={16} />
              Вставить пароль
            </button>
          </section>
        )}

        <label className="span-2">
          Заметка
          <textarea value={draft.notes} onChange={(event) => patch("notes", event.target.value)} placeholder="Короткая заметка" />
        </label>
      </div>

      <div className="sheet-actions">
        <button className="danger" onClick={() => onDelete(draft.id)}>
          <Trash2 size={16} />
          Удалить
        </button>
        <button className="primary" onClick={saveDraft}>
          <Save size={16} />
          Сохранить
        </button>
      </div>
    </aside>
  );
}

function SettingsPanel({
  vault,
  masterPassword,
  biometricUnlock,
  onBiometricUnlockChange,
  onPinChange,
  onMasterPasswordChange,
  onClose,
  onVaultChange,
  onImportVault,
  onReset,
}: {
  vault: VaultState;
  masterPassword: string;
  biometricUnlock: boolean;
  onBiometricUnlockChange: (enabled: boolean) => void;
  onPinChange: (nextPin: string) => void | Promise<void>;
  onMasterPasswordChange: (nextMasterPassword: string, nextVault: VaultState) => void | Promise<void>;
  onClose: () => void;
  onVaultChange: (vault: VaultState, message?: string) => void | Promise<void>;
  onImportVault: (vault: VaultState, raw: string) => void | Promise<void>;
  onReset: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [localSession, setLocalSession] = useState<LocalSyncSession | null>(null);
  const [remoteAddress, setRemoteAddress] = useState("");
  const [remoteCode, setRemoteCode] = useState("");
  const [incomingReady, setIncomingReady] = useState(false);
  const [debugLogVersion, setDebugLogVersion] = useState(0);
  const [discoveredHosts, setDiscoveredHosts] = useState<LocalSyncHost[]>([]);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [nextPin, setNextPin] = useState("");
  const [nextPinConfirmation, setNextPinConfirmation] = useState("");
  const [pinMessage, setPinMessage] = useState("");
  const [currentMaster, setCurrentMaster] = useState("");
  const [nextMaster, setNextMaster] = useState("");
  const [nextMasterConfirmation, setNextMasterConfirmation] = useState("");
  const [masterMessage, setMasterMessage] = useState("");
  const [webdav, setWebdav] = useState<WebDavConfig>(
    vault.settings.sync.webdav ?? {
      url: "https://app.koofr.net/dav/Koofr",
      username: "",
      password: "",
      filePath: "pandora-vault.pandora",
    },
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const debugLogs = useMemo(() => readDebugLogs(), [debugLogVersion]);
  const debugPreview = debugLogs
    .slice(-8)
    .map((entry) => `${new Date(entry.at).toLocaleTimeString("ru-RU")} ${entry.level.toUpperCase()} ${entry.scope}: ${entry.message}`)
    .join("\n");
  const [settingsTab, setSettingsTab] = useState<"general" | "appearance" | "cloud" | "wifi" | "files" | "debug" | "danger">("general");
  const settingsTabs: Array<{ id: typeof settingsTab; label: string }> = [
    { id: "general", label: "Основные" },
    { id: "appearance", label: "Внешний вид" },
    { id: "cloud", label: "Облако" },
    { id: "files", label: "Импорт" },
    { id: "debug", label: "Логи" },
    { id: "danger", label: "Сброс" },
  ];

  useEffect(() => window.pandoraSync?.onReceived(() => setIncomingReady(true)), []);

  function refreshDebugLog() {
    setDebugLogVersion((current) => current + 1);
  }

  function logDebug(scope: string, message: string, details?: Record<string, unknown>, level: "info" | "warn" | "error" = "info") {
    addDebugLog(scope, message, details, level);
    refreshDebugLog();
  }

  function setWebdavField<K extends keyof WebDavConfig>(key: K, value: WebDavConfig[K]) {
    setWebdav((current) => ({ ...current, [key]: value }));
  }

  async function changePin(event: FormEvent) {
    event.preventDefault();
    setPinMessage("");
    if (currentPin !== masterPassword) {
      setPinMessage("Мастер-пароль указан неверно.");
      return;
    }
    if (!isValidPin(nextPin)) {
      setPinMessage(`Новый PIN должен содержать минимум ${minPinLength} цифры.`);
      return;
    }
    if (nextPin !== nextPinConfirmation) {
      setPinMessage("Новые PIN-коды не совпадают.");
      return;
    }
    await onPinChange(nextPin);
    setCurrentPin("");
    setNextPin("");
    setNextPinConfirmation("");
    setPinMessage("PIN-код изменён.");
  }

  async function changeMasterPassword(event: FormEvent) {
    event.preventDefault();
    setMasterMessage("");
    if (currentMaster !== masterPassword) {
      setMasterMessage("Текущий мастер-пароль указан неверно.");
      return;
    }
    if (nextMaster.length < 8) {
      setMasterMessage("Новый мастер-пароль должен содержать минимум 8 символов.");
      return;
    }
    if (nextMaster !== nextMasterConfirmation) {
      setMasterMessage("Новые мастер-пароли не совпадают.");
      return;
    }

    setSyncBusy(true);
    try {
      let nextVault = vault;
      if (webdav.username.trim() && webdav.password && vault.settings.sync.lastSyncAt) {
        const remoteRaw = await downloadWebDavVault(webdav);
        let remoteVault: VaultState;
        let remoteAlreadyUsesNextMaster = false;
        try {
          remoteVault = normalizeVault((await readSyncPayload(remoteRaw, masterPassword)).vault);
        } catch {
          // Another device may already have re-encrypted the shared vault.
          remoteVault = normalizeVault((await readSyncPayload(remoteRaw, nextMaster)).vault);
          remoteAlreadyUsesNextMaster = true;
        }
        nextVault = mergeSyncedVaults(vault, remoteVault).vault;

        if (!remoteAlreadyUsesNextMaster) {
          const backupConfig = {
            ...webdav,
            filePath: `${webdav.filePath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
          };
          await uploadWebDavVault(backupConfig, remoteRaw);
          const nextRaw = await buildCompatibleSyncPayload(nextVault, nextMaster);
          await uploadWebDavVault(webdav, nextRaw);
          await readSyncPayload(await downloadWebDavVault(webdav), nextMaster);
        }
      }
      await onMasterPasswordChange(nextMaster, nextVault);
      setCurrentMaster("");
      setNextMaster("");
      setNextMasterConfirmation("");
      setMasterMessage("Мастер-пароль изменён. Используйте его на остальных устройствах.");
    } catch (error) {
      setMasterMessage(error instanceof Error ? error.message : "Не удалось изменить мастер-пароль.");
    } finally {
      setSyncBusy(false);
    }
  }

  function vaultWithWebdav(message?: string) {
    return onVaultChange(
      {
        ...vault,
        settings: {
          ...vault.settings,
          sync: {
            ...vault.settings.sync,
            webdav: {
              provider: webdav.url.includes("koofr.net") ? "koofr" : "custom",
              ...webdav,
            },
          },
        },
      },
      message,
    );
  }

  function importCsv() {
    const imported = importGooglePasswordsCsv(csv, vault.folders[0].id);
    onVaultChange({ ...vault, entries: [...imported, ...vault.entries] }, "CSV импортирован");
    setCsv("");
  }

  async function importSyncFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const raw = await file.text();
    try {
      const imported = await readSyncPayload(raw, masterPassword);
      const merged = mergeSyncedVaults(vault, normalizeVault(imported.vault));
      await onImportVault(merged.vault, raw);
    } catch {
      window.alert("Не удалось открыть файл синхронизации. Проверьте мастер-пароль.");
    } finally {
      event.target.value = "";
    }
  }

  async function exportSyncFile() {
    const raw = await encryptedRawForVault(vault);
    downloadText(`pandora-${new Date().toISOString().slice(0, 10)}.pandora`, raw);
  }

  async function copyDebugLog() {
    await navigator.clipboard.writeText(formatDebugLogs());
    logDebug("debug", "log copied", { entries: debugLogs.length });
  }

  async function downloadDebugLog() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (Capacitor.isNativePlatform()) {
      await Share.share({
        title: "Pandora debug log",
        text: formatDebugLogs(),
        dialogTitle: "Отправить лог Pandora",
      });
      logDebug("debug", "log shared", { entries: debugLogs.length });
      setDebugLogVersion((version) => version + 1);
      return;
    }
    downloadText(`pandora-debug-${stamp}.log`, formatDebugLogs());
    logDebug("debug", "log downloaded", { entries: debugLogs.length });
  }

  function resetDebugLog() {
    clearDebugLogs();
    refreshDebugLog();
    addDebugLog("debug", "log cleared");
    refreshDebugLog();
  }

  async function withSyncBusy(action: () => Promise<void>, label = "sync") {
    setSyncBusy(true);
    setSyncMessage("");
    logDebug("ui", `${label} start`, { localEntries: vault.entries.length, folders: vault.folders.length });
    try {
      await action();
      logDebug("ui", `${label} success`, { localEntries: vault.entries.length });
    } catch (error) {
      logDebug("ui", `${label} failed`, { error: error instanceof Error ? error.message : String(error) }, "error");
      setSyncMessage(error instanceof Error ? error.message : "Ошибка синхронизации");
    } finally {
      setSyncBusy(false);
      refreshDebugLog();
    }
  }

  async function encryptedRawForVault(nextVault: VaultState) {
    return buildCompatibleSyncPayload(nextVault, masterPassword);
  }

  async function testCloudSync() {
    await withSyncBusy(async () => {
      await testWebDavConnection(webdav);
      await vaultWithWebdav();
      setSyncMessage("Koofr/WebDAV подключён.");
    });
  }

  async function uploadToCloud() {
    await withSyncBusy(async () => {
      await vaultWithWebdav();
      const nextVault: VaultState = {
        ...vault,
        settings: {
          ...vault.settings,
          sync: {
            ...vault.settings.sync,
            webdav: {
              provider: webdav.url.includes("koofr.net") ? "koofr" : "custom",
              ...webdav,
            },
          },
        },
      };
      const raw = await encryptedRawForVault(nextVault);
      if (!raw) throw new Error("Нет локального зашифрованного хранилища");
      await uploadWebDavVault(webdav, raw);
      const verifyRaw = await downloadWebDavVault(webdav);
      const verifyVault = normalizeVault((await readSyncPayload(verifyRaw, masterPassword)).vault);
      if (verifyVault.entries.length !== nextVault.entries.length) {
        throw new Error(`В облако ушло ${verifyVault.entries.length} записей из ${nextVault.entries.length}. Синхронизация остановлена.`);
      }
      await onVaultChange(
        {
          ...nextVault,
          settings: {
            ...nextVault.settings,
            sync: {
              ...nextVault.settings.sync,
              lastSyncAt: new Date().toISOString(),
              webdav: {
                provider: webdav.url.includes("koofr.net") ? "koofr" : "custom",
                ...webdav,
                remoteModifiedAt: new Date().toISOString(),
              },
            },
          },
        },
        "Сохранено в облако",
      );
      setSyncMessage(`Пароли сохранены в Koofr/WebDAV. Записей: ${nextVault.entries.length}.`);
    });
  }

  async function downloadFromCloud() {
    await withSyncBusy(async () => {
      await vaultWithWebdav();
      const raw = await downloadWebDavVault(webdav);
      const imported = await readSyncPayload(raw, masterPassword);
      const importedVault = normalizeVault(imported.vault);
      const mergedVault = mergeSyncedVaults(vault, importedVault).vault;
      await onImportVault(
        {
          ...mergedVault,
          settings: {
            ...mergedVault.settings,
            sync: {
              ...mergedVault.settings.sync,
              lastSyncAt: new Date().toISOString(),
              webdav: {
                provider: webdav.url.includes("koofr.net") ? "koofr" : "custom",
                ...webdav,
                remoteModifiedAt: new Date().toISOString(),
              },
            },
          },
        },
        raw,
      );
      setSyncMessage(`Загружено из облака: ${importedVault.entries.length}. Всего записей после слияния: ${mergedVault.entries.length}.`);
    });
  }

  async function syncCloud() {
    if (activeEntries(vault.entries).length === 0 && window.confirm("Локальное хранилище пустое. Загрузить данные из облака?")) {
      await downloadFromCloud();
      return;
    }
    if (window.confirm("Сохранить текущие пароли в облако? Нажмите «Отмена», если хотите загрузить из облака.")) {
      await uploadToCloud();
    } else {
      await downloadFromCloud();
    }
  }

  async function twoWayCloudSync() {
    await withSyncBusy(async () => {
      await vaultWithWebdav();
      let mergedVault = vault;
      let importedEntries = 0;
      let addedEntries = 0;

      try {
        const remoteRaw = await downloadWebDavVault(webdav);
        const imported = await readSyncPayload(remoteRaw, masterPassword);
        const result = mergeSyncedVaults(vault, normalizeVault(imported.vault));
        mergedVault = result.vault;
        importedEntries = result.importedEntries;
        addedEntries = result.addedEntries;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!message.includes("ещё нет файла") && !message.includes("еще нет файла")) {
          throw error;
        }
      }

      const nextVault: VaultState = {
        ...mergedVault,
        settings: {
          ...mergedVault.settings,
          sync: {
            ...mergedVault.settings.sync,
            lastSyncAt: new Date().toISOString(),
            webdav: {
              provider: webdav.url.includes("koofr.net") ? "koofr" : "custom",
              ...webdav,
              remoteModifiedAt: new Date().toISOString(),
            },
          },
        },
      };
      const raw = await encryptedRawForVault(nextVault);
      await uploadWebDavVault(webdav, raw);
      const verifyVault = normalizeVault((await readSyncPayload(await downloadWebDavVault(webdav), masterPassword)).vault);
      if (verifyVault.entries.length !== nextVault.entries.length) {
        throw new Error(`После синхронизации в облаке ${verifyVault.entries.length} записей из ${nextVault.entries.length}.`);
      }
      await onImportVault(nextVault, raw);
      setSyncMessage(`Синхронизация завершена. В облаке было: ${importedEntries}. Добавлено: ${addedEntries}. Всего: ${nextVault.entries.length}.`);
    });
  }

  async function startLocalSync() {
    await withSyncBusy(async () => {
      if (!window.pandoraSync) throw new Error("Локальная Wi-Fi синхронизация запускается на Windows-версии Pandora");
      const raw = await encryptedRawForVault(vault);
      if (!raw) throw new Error("Нет локального зашифрованного хранилища");
      const session = await window.pandoraSync.start(raw);
      setLocalSession(session);
      setRemoteAddress(session.urls[0] || "");
      setRemoteCode(session.code);
      setSyncMessage("Синхронизация запущена. Откройте Pandora на телефоне и введите адрес и код.");
    });
  }

  async function stopLocalSync() {
    await withSyncBusy(async () => {
      await window.pandoraSync?.stop();
      setLocalSession(null);
      setIncomingReady(false);
      setSyncMessage("Локальная синхронизация остановлена.");
    });
  }

  async function scanLocalHosts() {
    setDiscoveryBusy(true);
    try {
      const result = await PandoraDiscovery.scan({ timeoutMs: 4500 });
      setDiscoveredHosts(result.hosts);
      if (result.hosts.length === 1) {
        selectLocalHost(result.hosts[0]);
      }
      setSyncMessage(
        result.hosts.length > 0
          ? `Найдено ПК: ${result.hosts.length}. Выберите устройство ниже.`
          : "ПК не найден. Убедитесь, что на Windows нажато «Открыть связь», а устройства в одной Wi‑Fi сети.",
      );
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Не удалось найти ПК в сети.");
    } finally {
      setDiscoveryBusy(false);
    }
  }

  function selectLocalHost(host: LocalSyncHost) {
    setRemoteAddress(host.urls[0] || "");
    setRemoteCode(host.code);
    setSyncMessage(`Выбрано: ${host.name}. Теперь можно получить или отправить записи.`);
  }

  function remoteUrl() {
    const address = remoteAddress.trim().replace(/\/+$/, "");
    if (!address) throw new Error("Введите адрес ПК");
    if (!remoteCode.trim()) throw new Error("Введите код синхронизации");
    return `${address}/vault?code=${encodeURIComponent(remoteCode.trim())}`;
  }

  async function pullFromComputer() {
    await withSyncBusy(async () => {
      const response = await fetch(remoteUrl());
      if (!response.ok) throw new Error("Не удалось получить данные. Проверьте адрес, код и Wi‑Fi.");
      const raw = await response.text();
      const imported = await readSyncPayload(raw, masterPassword);
      const importedVault = normalizeVault(imported.vault);
      const mergedVault = mergeSyncedVaults(vault, importedVault).vault;
      await onImportVault(
        {
          ...mergedVault,
          settings: {
            ...mergedVault.settings,
            sync: {
              ...mergedVault.settings.sync,
              lastSyncAt: new Date().toISOString(),
            },
          },
        },
        raw,
      );
      setSyncMessage(`Получено с ПК: ${importedVault.entries.length}. Всего записей: ${mergedVault.entries.length}.`);
    });
  }

  async function pushToComputer() {
    await withSyncBusy(async () => {
      const raw = await encryptedRawForVault(vault);
      if (!raw) throw new Error("Нет локального зашифрованного хранилища");
      const response = await fetch(remoteUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      if (!response.ok) throw new Error("Не удалось отправить данные. Проверьте адрес, код и Wi‑Fi.");
      setSyncMessage("Пароли отправлены на ПК. На ПК нажмите «Принять с телефона».");
    });
  }

  async function acceptIncomingVault() {
    await withSyncBusy(async () => {
      if (!window.pandoraSync) throw new Error("Приём доступен на Windows-версии Pandora");
      const raw = await window.pandoraSync.getReceived();
      if (!raw) throw new Error("Входящих данных пока нет");
      const imported = await readSyncPayload(raw, masterPassword);
      const importedVault = normalizeVault(imported.vault);
      const mergedVault = mergeSyncedVaults(vault, importedVault).vault;
      await onImportVault(
        {
          ...mergedVault,
          settings: {
            ...mergedVault.settings,
            sync: {
              ...mergedVault.settings.sync,
              lastSyncAt: new Date().toISOString(),
            },
          },
        },
        raw,
      );
      await window.pandoraSync.clearReceived();
      setIncomingReady(false);
      setSyncMessage(`Принято с телефона: ${importedVault.entries.length}. Всего записей: ${mergedVault.entries.length}.`);
    });
  }

  return (
    <aside className="settings-drawer" aria-label="Настройки">
      <div className="sheet-head">
        <div>
          <h2>Настройки</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть настройки">
          <X size={18} />
        </button>
      </div>

      <nav className="settings-tabs" aria-label="Разделы настроек">
        {settingsTabs.map((tab) => (
          <button key={tab.id} className={settingsTab === tab.id ? "settings-tab active" : "settings-tab"} onClick={() => setSettingsTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="settings-content">
      <section className="settings-section" hidden={settingsTab !== "general"}>
        <h3>Безопасность входа</h3>
        <p className="muted">Мастер-пароль шифрует хранилище и синхронизацию. PIN защищает вход только на этом устройстве.</p>

        {Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android" && (
          <label className="switch">
            <input type="checkbox" checked={biometricUnlock} onChange={(event) => onBiometricUnlockChange(event.target.checked)} />
            Вход по отпечатку пальца
          </label>
        )}

        <div className="credential-settings">
          <form className="pin-change-form" onSubmit={changePin}>
            <h4>Изменить PIN</h4>
            <p className="muted">Смена PIN не влияет на Koofr и другие устройства.</p>
            <label>
              Мастер-пароль
              <input type="password" value={currentPin} onChange={(event) => setCurrentPin(event.target.value)} autoComplete="current-password" />
            </label>
            <div className="pin-change-grid">
              <label>
                Новый PIN
                <input type="password" inputMode="numeric" pattern="[0-9]*" value={nextPin} onChange={(event) => setNextPin(normalizePin(event.target.value))} autoComplete="new-password" />
              </label>
              <label>
                Повторите PIN
                <input type="password" inputMode="numeric" pattern="[0-9]*" value={nextPinConfirmation} onChange={(event) => setNextPinConfirmation(normalizePin(event.target.value))} autoComplete="new-password" />
              </label>
            </div>
            {pinMessage && <p className={pinMessage.endsWith("изменён.") ? "sync-message" : "error"}>{pinMessage}</p>}
            <button type="submit" disabled={!currentPin || !nextPin || !nextPinConfirmation}><KeyRound size={16} />Изменить PIN</button>
          </form>

          <form className="pin-change-form" onSubmit={changeMasterPassword}>
            <h4>Изменить мастер-пароль</h4>
            <p className="muted">После смены введите новый мастер-пароль на каждом устройстве. Koofr-файл будет перешифрован автоматически.</p>
            <label>
              Текущий мастер-пароль
              <input type="password" value={currentMaster} onChange={(event) => setCurrentMaster(event.target.value)} autoComplete="current-password" />
            </label>
            <label>
              Новый мастер-пароль
              <input type="password" value={nextMaster} onChange={(event) => setNextMaster(event.target.value)} autoComplete="new-password" />
            </label>
            <label>
              Повторите мастер-пароль
              <input type="password" value={nextMasterConfirmation} onChange={(event) => setNextMasterConfirmation(event.target.value)} autoComplete="new-password" />
            </label>
            {masterMessage && <p className={masterMessage.startsWith("Мастер-пароль изменён") ? "sync-message" : "error"}>{masterMessage}</p>}
            <button type="submit" disabled={syncBusy || !currentMaster || !nextMaster || !nextMasterConfirmation}><Lock size={16} />Изменить мастер-пароль</button>
          </form>
        </div>

        <label>
          Автоблокировка
          <select value={vault.settings.lockAfterMinutes} onChange={(event) => onVaultChange({ ...vault, settings: { ...vault.settings, lockAfterMinutes: Number(event.target.value) } })}>
            <option value={5}>5 минут</option>
            <option value={15}>15 минут</option>
            <option value={30}>30 минут</option>
            <option value={120}>2 часа</option>
          </select>
        </label>
      </section>

      <section className="settings-section" hidden={settingsTab !== "appearance"}>
        <h3>Тема и язык</h3>
        <div className="theme-grid">
          {themes.map((theme) => (
            <button
              key={theme.id}
              className={vault.settings.theme.id === theme.id ? "theme-swatch active" : "theme-swatch"}
              onClick={() => onVaultChange({ ...vault, settings: { ...vault.settings, theme } }, "Тема изменена")}
            >
              <span style={{ background: theme.background, borderColor: theme.border }} />
              {theme.name}
            </button>
          ))}
        </div>
        <label>
          Язык
          <select defaultValue="ru" disabled>
            <option value="ru">Русский</option>
          </select>
        </label>
      </section>

      <section className="settings-section" hidden={settingsTab !== "cloud"}>
        <h3>Облачная синхронизация</h3>
        <p className="muted">
          Основной вариант: Koofr через WebDAV. Нужен бесплатный аккаунт Koofr и пароль приложения из настроек Koofr.
          В облаке хранится только зашифрованный файл Pandora.
        </p>
        <details className="koofr-guide">
          <summary>
            <span><strong>Как подключить Koofr</strong><small>Полная инструкция и решение частых ошибок</small></span>
            <span className="guide-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div className="koofr-guide-content">
            <section>
              <h4>1. Подготовьте Koofr</h4>
              <ol>
                <li>Создайте бесплатный аккаунт на <a href="https://app.koofr.net" target="_blank" rel="noreferrer">app.koofr.net</a> и подтвердите email.</li>
                <li>Откройте настройки аккаунта Koofr, затем <b>Preferences → Password</b>.</li>
                <li>Создайте отдельный <b>app password</b> для Pandora. Обычный пароль аккаунта здесь не работает.</li>
                <li>Сохраните app password в надёжном месте: Koofr может показать его только один раз.</li>
              </ol>
            </section>
            <section>
              <h4>2. Настройте первое устройство</h4>
              <ol>
                <li>Оставьте адрес <code>https://app.koofr.net/dav/Koofr</code>.</li>
                <li>В поле «Логин» укажите email аккаунта Koofr, а в поле пароля — созданный app password.</li>
                <li>Нажмите «Проверить». После успешной проверки нажмите «Сохранить в облако».</li>
                <li>В Koofr появится файл <code>pandora-vault.pandora</code>. В нём нет открытых паролей — это зашифрованное хранилище.</li>
              </ol>
            </section>
            <section>
              <h4>3. Подключите второе устройство</h4>
              <ol>
                <li>Создайте локальный PIN. Он может отличаться от PIN первого устройства.</li>
                <li>Введите <b>тот же мастер-пароль</b>, который используется на первом устройстве.</li>
                <li>Укажите тот же email Koofr, app password, адрес и путь файла.</li>
                <li>Нажмите «Загрузить из облака». После первой загрузки используйте кнопку «Синхронизировать».</li>
              </ol>
            </section>
            <section className="guide-warning">
              <h4>Важно</h4>
              <ul>
                <li>Мастер-пароль должен совпадать на всех устройствах. Иначе файл нельзя расшифровать.</li>
                <li>PIN — только локальная защита входа. Он не участвует в шифровании Koofr и может быть разным.</li>
                <li>После смены мастер-пароля откройте этот раздел на остальных устройствах и укажите старый пароль как текущий, а новый — как новый. Pandora примет уже перешифрованное облако.</li>
                <li>Не удаляйте облачный файл вручную и не редактируйте его содержимое.</li>
              </ul>
            </section>
            <section>
              <h4>Если не работает</h4>
              <dl>
                <dt>401 или 403</dt><dd>Проверьте email и app password. Не используйте обычный пароль Koofr.</dd>
                <dt>404</dt><dd>На первом устройстве сначала нажмите «Сохранить в облако» и проверьте одинаковый путь файла.</dd>
                <dt>Ошибка расшифровки</dt><dd>На устройствах введены разные мастер-пароли либо облачный файл создан старой сборкой.</dd>
                <dt>Записи не появились</dt><dd>Нажмите «Синхронизировать» и проверьте количество записей в сообщении результата.</dd>
              </dl>
            </section>
          </div>
        </details>
        <label>
          Провайдер
          <select
            value={webdav.url.includes("koofr.net") ? "koofr" : "custom"}
            onChange={(event) => {
              if (event.target.value === "koofr") {
                setWebdavField("url", "https://app.koofr.net/dav/Koofr");
                setWebdavField("filePath", "pandora-vault.pandora");
              }
            }}
          >
            <option value="koofr">Koofr</option>
            <option value="custom">Другой WebDAV</option>
          </select>
        </label>
        <label>
          WebDAV адрес
          <input value={webdav.url} onChange={(event) => setWebdavField("url", event.target.value)} placeholder="https://app.koofr.net/dav/Koofr" />
        </label>
        <label>
          Логин
          <input value={webdav.username} onChange={(event) => setWebdavField("username", event.target.value)} placeholder="email Koofr" />
        </label>
        <label>
          Пароль приложения
          <input
            type="password"
            value={webdav.password}
            onChange={(event) => setWebdavField("password", event.target.value)}
            placeholder="Не основной пароль, а app password"
          />
        </label>
        <details className="advanced-sync">
          <summary>Дополнительно</summary>
          <label>
            Путь файла
            <input value={webdav.filePath} onChange={(event) => setWebdavField("filePath", event.target.value)} />
          </label>
        </details>
        {vault.settings.sync.lastSyncAt && <p className="muted">Последняя синхронизация: {new Date(vault.settings.sync.lastSyncAt).toLocaleString("ru-RU")}</p>}
        {syncMessage && <p className="sync-message">{syncMessage}</p>}
        <div className="button-row">
          <button onClick={testCloudSync} disabled={syncBusy}>
            <Check size={16} />
            Проверить
          </button>
          <button onClick={twoWayCloudSync} disabled={syncBusy}>
            <Shuffle size={16} />
            Синхронизировать
          </button>
        </div>
        <div className="button-row">
          <button onClick={uploadToCloud} disabled={syncBusy}>
            <Upload size={16} />
            Сохранить в облако
          </button>
          <button onClick={downloadFromCloud} disabled={syncBusy}>
            <Download size={16} />
            Загрузить из облака
          </button>
        </div>
      </section>

      <section className="settings-section" hidden={settingsTab !== "wifi"}>
        <h3>Синхронизация по Wi-Fi</h3>
        <p className="muted">
          Дополнительный вариант без аккаунтов: устройства должны быть в одной Wi-Fi сети. Это не замена облачной
          синхронизации, а быстрый локальный обмен между ПК и телефоном.
        </p>
        <div className="sync-guide">
          <strong>С ПК на телефон</strong>
          <span>1. На ПК нажмите «Запустить на ПК».</span>
          <span>2. На телефоне введите адрес и код с экрана ПК.</span>
          <span>3. На телефоне нажмите «Получить с ПК».</span>
        </div>
        <div className="sync-guide">
          <strong>С телефона на ПК</strong>
          <span>1. На ПК нажмите «Запустить на ПК».</span>
          <span>2. На телефоне введите адрес и код с экрана ПК.</span>
          <span>3. На телефоне нажмите «Отправить на ПК».</span>
          <span>4. На ПК нажмите «Принять с телефона».</span>
        </div>
        {localSession && (
          <div className="device-code-box">
            <small>Адрес ПК</small>
            <strong>{localSession.urls[0] || "Адрес не найден"}</strong>
            <button onClick={() => navigator.clipboard.writeText(localSession.urls[0] || "")}>
              <Copy size={16} />
              Скопировать адрес
            </button>
            <small>Код</small>
            <strong>{localSession.code}</strong>
            <button onClick={() => navigator.clipboard.writeText(localSession.code)}>
              <Copy size={16} />
              Скопировать код
            </button>
          </div>
        )}
        {syncMessage && <p className="sync-message">{syncMessage}</p>}
        <div className="button-row">
          {Capacitor.isNativePlatform() && (
            <button onClick={scanLocalHosts} disabled={syncBusy || discoveryBusy}>
              <Search size={16} />
              {discoveryBusy ? "Поиск..." : "Найти ПК"}
            </button>
          )}
          <button onClick={startLocalSync} disabled={syncBusy || !window.pandoraSync}>
            <Upload size={16} />
            Запустить на ПК
          </button>
          <button onClick={acceptIncomingVault} disabled={syncBusy || !incomingReady}>
            <Check size={16} />
            Принять с телефона
          </button>
          <button onClick={stopLocalSync} disabled={syncBusy || !localSession}>
            <X size={16} />
            Остановить
          </button>
        </div>
        {discoveredHosts.length > 0 && (
          <div className="host-list">
            {discoveredHosts.map((host) => (
              <button key={`${host.code}-${host.urls.join("|")}`} onClick={() => selectLocalHost(host)}>
                <span>{host.name}</span>
                <small>{host.urls[0]}</small>
              </button>
            ))}
          </div>
        )}
        <label>
          Адрес ПК
          <input value={remoteAddress} onChange={(event) => setRemoteAddress(event.target.value)} placeholder="http://192.168.1.10:12345" />
        </label>
        <label>
          Код
          <input value={remoteCode} onChange={(event) => setRemoteCode(event.target.value)} placeholder="6 цифр" />
        </label>
        <div className="button-row">
          <button onClick={pullFromComputer} disabled={syncBusy || !remoteAddress.trim() || !remoteCode.trim()}>
            <Download size={16} />
            Получить с ПК
          </button>
          <button onClick={pushToComputer} disabled={syncBusy || !remoteAddress.trim() || !remoteCode.trim()}>
            <Upload size={16} />
            Отправить на ПК
          </button>
        </div>
      </section>

      <section className="settings-section" hidden={settingsTab !== "files"}>
        <h3>Файл вручную</h3>
        <p className="muted">Резервный способ: экспортируйте файл на одном устройстве и импортируйте на другом.</p>
        <div className="button-row">
          <button onClick={exportSyncFile}>
            <Download size={16} />
            Экспорт
          </button>
          <button onClick={() => fileInputRef.current?.click()}>
            <Upload size={16} />
            Импорт
          </button>
        </div>
        <input ref={fileInputRef} className="hidden-input" type="file" accept=".pandora,application/json" onChange={importSyncFile} />
      </section>

      <section className="settings-section" hidden={settingsTab !== "files"}>
        <h3>Импорт CSV</h3>
        <textarea value={csv} onChange={(event) => setCsv(event.target.value)} placeholder="name,url,username,password" />
        <button onClick={importCsv} disabled={!csv.trim()}>
          <FileUp size={16} />
          Импортировать
        </button>
      </section>

      <section className="settings-section" hidden={settingsTab !== "debug"}>
        <h3>Диагностика</h3>
        <p className="muted">Журнал не содержит PIN-код и содержимое хранилища. После ошибки синхронизации скачайте или скопируйте его и отправьте в чат.</p>
        <div className="debug-console">
          <span>Записей в журнале: {debugLogs.length}</span>
          <pre>{debugPreview || "Пока нет записей. Запустите проверку или синхронизацию."}</pre>
        </div>
        <div className="button-row">
          <button onClick={copyDebugLog} disabled={debugLogs.length === 0}>
            <Copy size={16} />
            Скопировать
          </button>
          <button onClick={downloadDebugLog} disabled={debugLogs.length === 0}>
            <Download size={16} />
            Скачать лог
          </button>
          <button onClick={resetDebugLog} disabled={debugLogs.length === 0}>
            <Trash2 size={16} />
            Очистить
          </button>
        </div>
      </section>

      <section className="settings-section danger-zone" hidden={settingsTab !== "danger"}>
        <h3>Опасная зона</h3>
        <button className="danger" onClick={onReset}>
          <Trash2 size={16} />
          Удалить локальные данные
        </button>
      </section>
      </div>
    </aside>
  );
}

function CipherBackground({ variant = "surface" }: { variant?: "surface" | "unlock" | "empty" }) {
  const packets = ["A7 F2 9C 18", "BLOCK 0038", "KEY SLOT 04", "SYNC 7A:20", "AES-256-GCM", "SHA-256", "DEVICE 02", "LOCAL VAULT", "PACKET 18/24"];
  return (
    <div className={`cipher-background ${variant}`} aria-hidden="true">
      {packets.map((packet, index) => (
        <span key={`${packet}-${index}`}>{packet}</span>
      ))}
    </div>
  );
}

function CopyButton({ value, label, onCopied }: { value: string; label: string; onCopied: (message: string) => void }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={done ? "copy-action copied" : "copy-action"}
      type="button"
      disabled={!value}
      onClick={async () => {
        if (!value) return;
        await navigator.clipboard.writeText(value);
        setDone(true);
        onCopied(`${label} скопирован`);
        window.setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
      {label}
    </button>
  );
}

function NavigationRail({
  active,
  onSelect,
  onLock,
}: {
  active: VaultSection;
  onSelect: (section: VaultSection) => void;
  onLock: () => void;
}) {
  const sections: Array<{ id: VaultSection; label: string; icon: JSX.Element }> = [
    { id: "overview", label: "Обзор", icon: <LayoutDashboard size={18} /> },
    { id: "vault", label: "Хранилище", icon: <KeyRound size={18} /> },
    { id: "favorites", label: "Избранное", icon: <Star size={18} /> },
    { id: "recent", label: "Недавние", icon: <Clock3 size={18} /> },
    { id: "security", label: "Безопасность", icon: <ShieldCheck size={18} /> },
    { id: "trash", label: "Корзина", icon: <Trash2 size={18} /> },
    { id: "settings", label: "Настройки", icon: <Settings size={18} /> },
  ];

  return (
    <aside className="navigation-rail" aria-label="Навигация Pandora">
      <div className="rail-brand">
        <img src="./pandora-mark.svg" alt="" />
        <div>
          <strong>Pandora</strong>
          <small>Хранилище открыто</small>
        </div>
        <button className="rail-lock-icon" onClick={onLock} aria-label="Заблокировать">
          <LogOut size={16} />
        </button>
      </div>
      <nav>
        {sections.map((section) => (
          <button key={section.id} className={active === section.id ? "rail-item active" : "rail-item"} onClick={() => onSelect(section.id)}>
            {section.icon}
            <span>{section.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function CommandBar({
  active,
  query,
  onQuery,
  onCreate,
  onPalette,
}: {
  active: VaultSection;
  query: string;
  onQuery: (value: string) => void;
  onCreate: () => void;
  onPalette: () => void;
}) {
  const titles: Record<VaultSection, string> = {
    overview: "Обзор",
    vault: "Хранилище",
    favorites: "Избранное",
    recent: "Недавние",
    security: "Безопасность",
    trash: "Корзина",
    settings: "Настройки",
  };

  return (
    <header className="command-bar">
      <div>
        <h1>{titles[active]}</h1>
      </div>
      <label className="command-search">
        <Search size={17} />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Поиск по записям" />
      </label>
      <button className="secondary-command" onClick={onPalette}>
        <Command size={16} />
        Команды
        <small>Ctrl+K</small>
      </button>
      <button className="primary command-create" onClick={onCreate}>
        <Plus size={17} />
        Новая запись
      </button>
    </header>
  );
}

function CommandPalette({
  open,
  entries,
  folders,
  onClose,
  onCreate,
  onSelectEntry,
  onSelectFolder,
  onSection,
  onLock,
}: {
  open: boolean;
  entries: VaultEntry[];
  folders: VaultFolder[];
  onClose: () => void;
  onCreate: () => void;
  onSelectEntry: (entry: VaultEntry) => void;
  onSelectFolder: (folderId: string) => void;
  onSection: (section: VaultSection) => void;
  onLock: () => void;
}) {
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  if (!open) return null;

  const lower = search.trim().toLocaleLowerCase("ru-RU");
  const matchedEntries = entries
    .filter((entry) => !lower || [entry.title, entry.username, entry.url].join(" ").toLocaleLowerCase("ru-RU").includes(lower))
    .slice(0, 6);

  return (
    <div className="palette-layer" role="dialog" aria-modal="true" aria-label="Команды Pandora">
      <button className="palette-scrim" onClick={onClose} aria-label="Закрыть команды" />
      <section className="command-palette">
        <label className="palette-input">
          <Command size={18} />
          <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Команда или запись" />
        </label>
        <div className="palette-list">
          <button onClick={() => { onCreate(); onClose(); }}><Plus size={16} />Создать запись</button>
          <button onClick={() => { onSection("settings"); onClose(); }}><Settings size={16} />Настройки</button>
          <button onClick={() => { onLock(); onClose(); }}><Lock size={16} />Заблокировать</button>
          {folders.slice(0, 5).map((folder) => (
            <button key={folder.id} onClick={() => { onSelectFolder(folder.id); onClose(); }}><Folder size={16} />{folder.name}</button>
          ))}
          {matchedEntries.map((entry) => (
            <button key={entry.id} onClick={() => { onSelectEntry(entry); onClose(); }}><KeyRound size={16} />{entry.title || "Новая запись"}</button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function VaultEntryRow({
  entry,
  folders,
  selected,
  dragEnabled,
  mobileDragEnabled,
  onSelect,
  onDragStart,
  onMobileDragStart,
  onMobileDragMove,
  onMobileDragEnd,
  onMobileDragCancel,
}: {
  entry: VaultEntry;
  folders: VaultFolder[];
  selected: boolean;
  dragEnabled: boolean;
  mobileDragEnabled: boolean;
  onSelect: (entry: VaultEntry) => void;
  onDragStart: (entryId: string) => void;
  onMobileDragStart: (entryId: string, x: number, y: number) => void;
  onMobileDragMove: (x: number, y: number) => void;
  onMobileDragEnd: () => void;
  onMobileDragCancel: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const scrollStartRef = useRef(0);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const touchScrollingRef = useRef(false);
  const lastTouchRef = useRef({ y: 0, time: 0 });
  const scrollVelocityRef = useRef(0);
  const momentumFrameRef = useRef<number | null>(null);
  const mobileDraggingRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const [mobileDragging, setMobileDragging] = useState(false);

  useEffect(() => {
    const row = rowRef.current;
    if (!row || !mobileDragEnabled) return;

    const clearHoldTimer = () => {
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
    const cancelMomentum = () => {
      if (momentumFrameRef.current !== null) {
        window.cancelAnimationFrame(momentumFrameRef.current);
        momentumFrameRef.current = null;
      }
    };
    const startMomentum = (container: HTMLElement, initialVelocity: number) => {
      let velocity = Math.max(-2.4, Math.min(2.4, initialVelocity));
      if (Math.abs(velocity) < 0.08) return;
      let previousTime = performance.now();
      const step = (time: number) => {
        const elapsed = Math.min(32, time - previousTime);
        previousTime = time;
        const previousScrollTop = container.scrollTop;
        container.scrollTop += velocity * elapsed;
        velocity *= Math.pow(0.94, elapsed / 16.67);
        if (Math.abs(velocity) < 0.025 || container.scrollTop === previousScrollTop) {
          momentumFrameRef.current = null;
          return;
        }
        momentumFrameRef.current = window.requestAnimationFrame(step);
      };
      momentumFrameRef.current = window.requestAnimationFrame(step);
    };
    const resetDrag = () => {
      clearHoldTimer();
      mobileDraggingRef.current = false;
      setMobileDragging(false);
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      cancelMomentum();
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      lastTouchRef.current = { y: touch.clientY, time: performance.now() };
      scrollVelocityRef.current = 0;
      scrollContainerRef.current = row.closest<HTMLElement>(".cipher-workspace");
      scrollStartRef.current = scrollContainerRef.current?.scrollTop ?? 0;
      touchScrollingRef.current = false;
      clearHoldTimer();
      holdTimerRef.current = window.setTimeout(() => {
        mobileDraggingRef.current = true;
        setMobileDragging(true);
        suppressClickUntilRef.current = Date.now() + 700;
        navigator.vibrate?.(24);
        onMobileDragStart(entry.id, touch.clientX, touch.clientY);
      }, 420);
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const distance = Math.hypot(touch.clientX - touchStartRef.current.x, touch.clientY - touchStartRef.current.y);
      if (!mobileDraggingRef.current) {
        if (distance > 8) {
          clearHoldTimer();
          touchScrollingRef.current = true;
          suppressClickUntilRef.current = Date.now() + 300;
          event.preventDefault();
          if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = scrollStartRef.current + touchStartRef.current.y - touch.clientY;
          }
          const currentTime = performance.now();
          const elapsed = Math.max(8, currentTime - lastTouchRef.current.time);
          const instantVelocity = (lastTouchRef.current.y - touch.clientY) / elapsed;
          scrollVelocityRef.current = scrollVelocityRef.current * 0.25 + instantVelocity * 0.75;
          lastTouchRef.current = { y: touch.clientY, time: currentTime };
        }
        return;
      }
      event.preventDefault();
      onMobileDragMove(touch.clientX, touch.clientY);
    };
    const handleTouchEnd = (event: TouchEvent) => {
      clearHoldTimer();
      if (touchScrollingRef.current) {
        event.preventDefault();
        const container = scrollContainerRef.current;
        touchScrollingRef.current = false;
        scrollContainerRef.current = null;
        if (container) startMomentum(container, scrollVelocityRef.current);
        return;
      }
      if (!mobileDraggingRef.current) return;
      event.preventDefault();
      const touch = event.changedTouches[0];
      if (touch) onMobileDragMove(touch.clientX, touch.clientY);
      onMobileDragEnd();
      resetDrag();
    };
    const handleTouchCancel = () => {
      const wasDragging = mobileDraggingRef.current;
      touchScrollingRef.current = false;
      scrollContainerRef.current = null;
      resetDrag();
      if (wasDragging) onMobileDragCancel();
    };

    row.addEventListener("touchstart", handleTouchStart, { passive: false });
    row.addEventListener("touchmove", handleTouchMove, { passive: false });
    row.addEventListener("touchend", handleTouchEnd, { passive: false });
    row.addEventListener("touchcancel", handleTouchCancel, { passive: true });
    return () => {
      clearHoldTimer();
      cancelMomentum();
      row.removeEventListener("touchstart", handleTouchStart);
      row.removeEventListener("touchmove", handleTouchMove);
      row.removeEventListener("touchend", handleTouchEnd);
      row.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, [entry.id, mobileDragEnabled, onMobileDragCancel, onMobileDragEnd, onMobileDragMove, onMobileDragStart]);

  return (
    <button
      ref={rowRef}
      className={`${selected ? "vault-entry-row selected" : "vault-entry-row"}${mobileDragging ? " mobile-dragging" : ""}`}
      onClick={(event) => {
        if (Date.now() < suppressClickUntilRef.current) {
          event.preventDefault();
          return;
        }
        onSelect(entry);
      }}
      draggable={dragEnabled}
      onDragStart={(event) => {
        if (!dragEnabled) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-pandora-entry", entry.id);
        event.dataTransfer.setData("text/plain", entry.id);
        onDragStart(entry.id);
      }}
    >
      <EntryIcon entry={entry} />
      <span className="entry-main">
        <strong>{entry.title || "Новая запись"}</strong>
        <small>{entry.username || entry.url || "Логин не указан"}</small>
      </span>
      <span className="entry-folder">{entryFolderName(entry, folders)}</span>
      <span className="entry-date">{new Date(entry.updatedAt).toLocaleDateString("ru-RU")}</span>
    </button>
  );
}

function VaultList({
  entries,
  folders,
  selectedId,
  sort,
  dragEnabled,
  mobileDragEnabled,
  onSort,
  onSelect,
  onCreate,
  onDragStart,
  onMobileDragStart,
  onMobileDragMove,
  onMobileDragEnd,
  onMobileDragCancel,
}: {
  entries: VaultEntry[];
  folders: VaultFolder[];
  selectedId: string | null;
  sort: SortMode;
  dragEnabled: boolean;
  mobileDragEnabled: boolean;
  onSort: (mode: SortMode) => void;
  onSelect: (entry: VaultEntry) => void;
  onCreate: () => void;
  onDragStart: (entryId: string) => void;
  onMobileDragStart: (entryId: string, x: number, y: number) => void;
  onMobileDragMove: (x: number, y: number) => void;
  onMobileDragEnd: () => void;
  onMobileDragCancel: () => void;
}) {
  return (
    <section className="vault-list-panel" aria-label="Список записей">
      <div className="list-toolbar">
        <div>
          <strong>{entries.length}</strong>
          <span>записей</span>
        </div>
        <select value={sort} onChange={(event) => onSort(event.target.value as SortMode)} aria-label="Сортировка">
          <option value="updatedAt">Недавние</option>
          <option value="title">А-Я</option>
          <option value="createdAt">Новые</option>
          <option value="usedCount">Частые</option>
        </select>
      </div>
      {entries.length === 0 ? (
        <section className="vault-empty-state">
          <CipherBackground variant="empty" />
          <KeyRound size={34} />
          <h2>Записей пока нет</h2>
          <p>Создайте первую запись или импортируйте данные в настройках.</p>
          <button className="primary" onClick={onCreate}><Plus size={17} />Создать запись</button>
        </section>
      ) : (
        <div className="vault-entry-list">
          {entries.map((entry) => (
            <VaultEntryRow
              key={entry.id}
              entry={entry}
              folders={folders}
              selected={entry.id === selectedId}
              dragEnabled={dragEnabled}
              mobileDragEnabled={mobileDragEnabled}
              onSelect={onSelect}
              onDragStart={onDragStart}
              onMobileDragStart={onMobileDragStart}
              onMobileDragMove={onMobileDragMove}
              onMobileDragEnd={onMobileDragEnd}
              onMobileDragCancel={onMobileDragCancel}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MobileFolderDropTray({
  folders,
  targetFolderId,
}: {
  folders: VaultFolder[];
  targetFolderId: string | null;
}) {
  return (
    <aside className="mobile-folder-drop-tray" aria-label="Выбор папки для переноса">
      <div className="mobile-folder-drop-title">
        <Folder size={18} />
        <span>Перетащите в папку</span>
      </div>
      <div className="mobile-folder-drop-targets">
        {folders.map((folder) => (
          <div
            key={folder.id}
            className={folder.id === targetFolderId ? "mobile-folder-drop-target active" : "mobile-folder-drop-target"}
            data-mobile-folder-drop={folder.id}
          >
            <Folder size={17} />
            <span>{folder.name}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function EntryDetailsPanel({
  entry,
  vault,
  onEdit,
  onDelete,
  onCreate,
  onCopy,
  onClose,
}: {
  entry: VaultEntry | null;
  vault: VaultState;
  onEdit: (entry: VaultEntry) => void;
  onDelete: (entryId: string) => void;
  onCreate: () => void;
  onCopy: (message: string) => void;
  onClose?: () => void;
}) {
  const visibleEntries = activeEntries(vault.entries);
  const stats = vaultSecurityStats(visibleEntries);
  const [passwordVisible, setPasswordVisible] = useState(false);
  useEffect(() => {
    setPasswordVisible(false);
  }, [entry?.id]);
  if (!entry) {
    return (
      <aside className="entry-details-panel empty" aria-label="Обзор безопасности">
        <CipherBackground variant="empty" />
        <ShieldCheck size={34} />
        <h2>Выберите запись</h2>
        <p>Справа появятся логин, пароль, сайт, заметки и быстрые действия.</p>
        <div className="security-grid">
          <div><span>Записи</span><strong>{visibleEntries.length}</strong></div>
          <div><span>Слабые</span><strong>{stats.weak}</strong></div>
          <div><span>Повторы</span><strong>{stats.duplicate}</strong></div>
          <div><span>Старые</span><strong>{stats.old}</strong></div>
        </div>
        <button className="primary" onClick={onCreate}><Plus size={17} />Новая запись</button>
      </aside>
    );
  }

  return (
    <aside className="entry-details-panel" aria-label="Просмотр записи">
      <div className="entry-details-head">
        <EntryIcon entry={entry} size="large" />
        <div>
          <span>{entryFolderName(entry, vault.folders)}</span>
          <h2>{entry.title || "Новая запись"}</h2>
          <p>{entry.url || "Сайт не указан"}</p>
        </div>
        {onClose && (
          <button className="details-close" type="button" onClick={onClose} aria-label="Закрыть просмотр">
            <X size={18} />
          </button>
        )}
      </div>

      <div className="details-fields">
        <div className="detail-field">
          <span>Логин</span>
          <strong>{entry.username || "Не указан"}</strong>
          <CopyButton value={entry.username} label="Логин" onCopied={onCopy} />
        </div>
        <div className="detail-field">
          <span>Пароль</span>
          <strong className={passwordVisible ? "password-value" : "password-dots"}>{entry.password ? (passwordVisible ? entry.password : "•".repeat(Math.min(Math.max(entry.password.length, 8), 24))) : "Не указан"}</strong>
          <button className="copy-action" type="button" disabled={!entry.password} onClick={() => setPasswordVisible((current) => !current)}>
            {passwordVisible ? <EyeOff size={15} /> : <Eye size={15} />}
            {passwordVisible ? "Скрыть" : "Показать"}
          </button>
          <CopyButton value={entry.password} label="Пароль" onCopied={onCopy} />
        </div>
        <div className="detail-field">
          <span>Сайт</span>
          <strong>{entry.url || "Не указан"}</strong>
          <button
            className="copy-action"
            disabled={!normalizedHttpUrl(entry.url)}
            onClick={() => {
              const url = normalizedHttpUrl(entry.url);
              if (url) window.open(url.toString(), "_blank", "noopener,noreferrer");
            }}
          >
            <Globe size={15} />
            Открыть
          </button>
        </div>
        {entry.notes && (
          <div className="detail-field note">
            <span>Заметки</span>
            <p>{entry.notes}</p>
          </div>
        )}
      </div>

      <div className="entry-metadata">
        <div><span>Изменено</span><strong>{new Date(entry.updatedAt).toLocaleString("ru-RU")}</strong></div>
        <div><span>Создано</span><strong>{new Date(entry.createdAt).toLocaleDateString("ru-RU")}</strong></div>
        <div><span>Возраст пароля</span><strong>{passwordAgeDays(entry)} дн.</strong></div>
        <div><span>Безопасность</span><strong>{passwordRisk(entry, visibleEntries)}</strong></div>
      </div>

      <div className="details-actions">
        <button className="primary" onClick={() => onEdit(entry)}><PanelRight size={16} />Редактировать</button>
        <button className="danger" onClick={() => onDelete(entry.id)}><Trash2 size={16} />Удалить</button>
      </div>
    </aside>
  );
}

function TrashPanel({
  entries,
  folders,
  onRestore,
  onDeletePermanently,
}: {
  entries: VaultEntry[];
  folders: VaultFolder[];
  onRestore: (entryId: string) => void;
  onDeletePermanently: (entryId: string) => void;
}) {
  return (
    <section className="section-workspace trash-workspace">
      <div className="trash-head">
        <div>
          <h2>Удалённые записи</h2>
          <p className="muted">Удалённые записи хранятся здесь и синхронизируются между устройствами, пока вы не удалите их навсегда.</p>
        </div>
        <strong>{entries.length}</strong>
      </div>
      {entries.length === 0 ? (
        <div className="vault-empty-state">
          <Trash2 size={34} />
          <h2>Корзина пуста</h2>
          <p>Удалённые записи появятся здесь.</p>
        </div>
      ) : (
        <div className="trash-list">
          {entries.map((entry) => (
            <div className="trash-row" key={entry.id}>
              <EntryIcon entry={entry} />
              <span className="entry-main">
                <strong>{entry.title || "Новая запись"}</strong>
                <small>{entry.username || entry.url || entryFolderName(entry, folders)}</small>
              </span>
              <small>{entry.deletedAt ? new Date(entry.deletedAt).toLocaleDateString("ru-RU") : ""}</small>
              <button onClick={() => onRestore(entry.id)}><RefreshCcw size={15} />Восстановить</button>
              <button className="danger" onClick={() => onDeletePermanently(entry.id)}><Trash2 size={15} />Удалить навсегда</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SecurityOverview({ vault }: { vault: VaultState }) {
  const visibleEntries = activeEntries(vault.entries);
  const stats = vaultSecurityStats(visibleEntries);
  const total = Math.max(visibleEntries.length, 1);
  const score = Math.max(0, Math.round(100 - ((stats.weak + stats.duplicate + stats.old) / total) * 35));
  return (
    <section className="security-overview">
      <div className="overview-meter">
        <span>Уровень безопасности</span>
        <strong>{score}%</strong>
        <div><i style={{ width: `${score}%` }} /></div>
      </div>
      <div className="overview-segments">
        <div><span>Всего</span><strong>{visibleEntries.length}</strong></div>
        <div><span>Слабые</span><strong>{stats.weak}</strong></div>
        <div><span>Повторы</span><strong>{stats.duplicate}</strong></div>
        <div><span>Старые</span><strong>{stats.old}</strong></div>
        <div><span>Устройства</span><strong>{Capacitor.isNativePlatform() ? 1 : 1}</strong></div>
        <div><span>Синхронизация</span><strong>{vault.settings.sync.lastSyncAt ? "Готово" : "Локально"}</strong></div>
      </div>
    </section>
  );
}

function DashboardPanel({ vault }: { vault: VaultState }) {
  const recent = activeEntries(vault.entries).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5);
  return (
    <section className="dashboard-panel">
      <SecurityOverview vault={vault} />
      <div className="dashboard-grid">
        <section>
          <h2>Недавно изменены</h2>
          {recent.length === 0 ? <p className="muted">Пока нет записей.</p> : recent.map((entry) => <div className="recent-line" key={entry.id}><EntryIcon entry={entry} /><span>{entry.title || "Новая запись"}</span><small>{new Date(entry.updatedAt).toLocaleDateString("ru-RU")}</small></div>)}
        </section>
      </div>
    </section>
  );
}


export default function App() {
  const isNativeMobile =
    Capacitor.getPlatform() === "android" ||
    Capacitor.getPlatform() === "ios" ||
    (import.meta.env.DEV && new URLSearchParams(window.location.search).get("platform") === "android");
  const [booting, setBooting] = useState(true);
  const [vault, setVault] = useState<VaultState | null>(null);
  const [masterPassword, setMasterPassword] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<VaultEntry | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("updatedAt");
  const [status, setStatus] = useState("");
  const [activeSection, setActiveSection] = useState<VaultSection>(isNativeMobile ? "vault" : "overview");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<VaultEntry | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileDrag, setMobileDrag] = useState<MobileDragState | null>(null);
  const mobileDragRef = useRef<MobileDragState | null>(null);
  const [biometricUnlock, setBiometricUnlock] = useState(() => localStorage.getItem(biometricUnlockKey) === "1");
  const [manualLock, setManualLock] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setBooting(false), 520);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    applyTheme(vault?.settings.theme ?? defaultTheme);
  }, [vault?.settings.theme]);

  useEffect(() => {
    if (!vault || !masterPassword) return;
    const timeout = window.setTimeout(() => {
      setVault(null);
      setMasterPassword("");
      setSelectedEntry(null);
    }, vault.settings.lockAfterMinutes * 60 * 1000);
    return () => window.clearTimeout(timeout);
  }, [vault, masterPassword]);

  async function persist(nextVault: VaultState, message = "Сохранено") {
    setVault(nextVault);
    await saveVault(nextVault, masterPassword);
    setStatus(message);
    window.setTimeout(() => setStatus(""), 2200);
  }

  function unlock(unlocked: VaultState, password: string) {
    const cleanVault = normalizeVault(unlocked);
    setManualLock(false);
    setVault(cleanVault);
    setMasterPassword(password);
    setSelectedFolder(cleanVault.folders[0]?.id ?? "");
    setSelectedEntry(null);
  }

  const filteredEntries = useMemo(() => {
    if (!vault) return [];
    const lower = query.trim().toLocaleLowerCase("ru-RU");
    const visibleFolderIds = selectedFolder ? descendantFolderIds(selectedFolder, vault.folders) : null;
    return activeEntries(vault.entries)
      .filter((entry) => !visibleFolderIds || visibleFolderIds.has(entry.folderId))
      .filter((entry) => !lower || [entry.title, entry.username, entry.url, entry.notes].join(" ").toLocaleLowerCase("ru-RU").includes(lower))
      .sort((first, second) => {
        if (sort === "title") return first.title.localeCompare(second.title, "ru");
        if (sort === "usedCount") return second.usedCount - first.usedCount;
        return new Date(second[sort]).getTime() - new Date(first[sort]).getTime();
      });
  }, [query, selectedFolder, sort, vault]);

  const deletedEntries = useMemo(() => (vault ? trashEntries(vault.entries).sort((first, second) => new Date(second.deletedAt || second.updatedAt).getTime() - new Date(first.deletedAt || first.updatedAt).getTime()) : []), [vault]);

  useEffect(() => {
    function handleShortcuts(event: KeyboardEvent) {
      if (!vault) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
      if ((event.ctrlKey || event.metaKey) && key === "n") {
        event.preventDefault();
        createEntry();
      }
      if ((event.ctrlKey || event.metaKey) && key === "l") {
        event.preventDefault();
        lockVault();
      }
      if ((event.ctrlKey || event.metaKey) && key === "f") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".command-search input")?.focus();
      }
      if (event.key === "Escape") {
        setCommandPaletteOpen(false);
        setEditingEntry(null);
        setSettingsOpen(false);
      }
      if (event.key === "Enter" && !selectedEntry && filteredEntries[0]) {
        setSelectedEntry(filteredEntries[0]);
      }
    }

    window.addEventListener("keydown", handleShortcuts);
    return () => window.removeEventListener("keydown", handleShortcuts);
  }, [filteredEntries, selectedEntry, vault]);

  if (booting) return <Splash />;

  if (!vault) {
    return <LockScreen onUnlock={unlock} />;
  }

  function createEntry() {
    if (!vault) return;
    const entry = newEntry(selectedFolder || vault.folders[0].id);
    setEditingEntry(entry);
    setActiveSection("vault");
  }

  function lockVault() {
    setManualLock(true);
    setVault(null);
    setMasterPassword("");
    setSelectedEntry(null);
    setEditingEntry(null);
    setCommandPaletteOpen(false);
  }

  function moveEntryToFolder(entryId: string, folderId: string) {
    if (!vault) return;
    const entry = vault.entries.find((item) => item.id === entryId);
    if (!entry || entry.folderId === folderId || isDeletedEntry(entry)) return;
    const nextEntry = { ...entry, folderId, updatedAt: now() };
    const nextVault = {
      ...vault,
      entries: vault.entries.map((item) => (item.id === entryId ? nextEntry : item)),
    };
    if (selectedEntry?.id === entryId) {
      setSelectedEntry(nextEntry);
    }
    persist(nextVault, "Запись перемещена");
  }

  function startMobileEntryDrag(entryId: string, x: number, y: number) {
    const next = { entryId, targetFolderId: null };
    mobileDragRef.current = next;
    setMobileDrag(next);
    updateMobileEntryDrag(x, y);
  }

  function updateMobileEntryDrag(x: number, y: number) {
    const current = mobileDragRef.current;
    if (!current) return;
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-mobile-folder-drop]");
    const targetFolderId = target?.dataset.mobileFolderDrop ?? null;
    if (targetFolderId === current.targetFolderId) return;
    const next = { ...current, targetFolderId };
    mobileDragRef.current = next;
    setMobileDrag(next);
  }

  function finishMobileEntryDrag() {
    const current = mobileDragRef.current;
    mobileDragRef.current = null;
    setMobileDrag(null);
    if (current?.targetFolderId) moveEntryToFolder(current.entryId, current.targetFolderId);
  }

  function cancelMobileEntryDrag() {
    mobileDragRef.current = null;
    setMobileDrag(null);
  }

  function moveEntryToTrash(entryId: string) {
    if (!vault) return;
    const entry = vault.entries.find((item) => item.id === entryId);
    if (!entry || isDeletedEntry(entry)) return;
    const deleted = { ...entry, deletedAt: now(), updatedAt: now() };
    const nextVault = {
      ...vault,
      entries: vault.entries.map((item) => (item.id === entryId ? deleted : item)),
    };
    setSelectedEntry(null);
    setEditingEntry(null);
    persist(nextVault, "Запись перемещена в корзину");
  }

  function restoreEntry(entryId: string) {
    if (!vault) return;
    const entry = vault.entries.find((item) => item.id === entryId);
    if (!entry) return;
    const restored = { ...entry, deletedAt: undefined, updatedAt: now() };
    const nextVault = {
      ...vault,
      entries: vault.entries.map((item) => (item.id === entryId ? restored : item)),
    };
    setSelectedEntry(restored);
    setActiveSection("vault");
    persist(nextVault, "Запись восстановлена");
  }

  function deleteEntryPermanently(entryId: string) {
    if (!vault || !window.confirm("Удалить запись навсегда? Это действие нельзя отменить.")) return;
    const nextVault = { ...vault, entries: vault.entries.filter((entry) => entry.id !== entryId) };
    if (selectedEntry?.id === entryId) setSelectedEntry(null);
    persist(nextVault, "Запись удалена навсегда");
  }

  const selectSection = (section: VaultSection) => {
    setSelectedEntry(null);
    setEditingEntry(null);
    if (section === "settings") {
      setSettingsOpen(true);
      return;
    }
    setActiveSection(section);
  };

  const createFolder = async (name: string) => {
    if (!name.trim()) return;
    const rootId = vault.folders[0].id;
    const normalizedName = name.trim();
    const duplicate = vault.folders.some((folder) => folder.parentId === rootId && folder.name.trim().toLowerCase() === normalizedName.toLowerCase());
    if (duplicate) {
      window.alert("Папка с таким именем уже есть");
      return;
    }
    const folder = { id: crypto.randomUUID(), name: normalizedName, parentId: rootId, createdAt: now() };
    await persist({ ...vault, folders: [...vault.folders, folder] }, "Папка создана");
    setSelectedFolder(folder.id);
    setSelectedEntry(null);
    setActiveSection("vault");
  };

  const renameFolder = async (folderId: string, name: string) => {
    const rootId = vault.folders[0].id;
    if (folderId === rootId) return;
    const normalizedName = name.trim();
    if (!normalizedName) return;
    const folder = vault.folders.find((item) => item.id === folderId);
    if (!folder) return;
    const duplicate = vault.folders.some(
      (item) =>
        item.id !== folderId &&
        item.parentId === folder.parentId &&
        item.name.trim().toLowerCase() === normalizedName.toLowerCase(),
    );
    if (duplicate) {
      window.alert("Папка с таким именем уже есть");
      return;
    }
    const folders = vault.folders.map((item) => (item.id === folderId ? { ...item, name: normalizedName } : item));
    await persist({ ...vault, folders }, "Папка переименована");
  };

  const deleteFolder = async (folderId: string) => {
    const rootId = vault.folders[0].id;
    if (folderId === rootId) return;
    const folder = vault.folders.find((item) => item.id === folderId);
    if (!folder) return;
    const idsToDelete = descendantFolderIds(folderId, vault.folders);
    const folders = vault.folders.filter((item) => !idsToDelete.has(item.id));
    const entries = vault.entries.map((entry) => (idsToDelete.has(entry.folderId) ? { ...entry, folderId: rootId, updatedAt: now() } : entry));
    if (idsToDelete.has(selectedFolder)) {
      setSelectedFolder(rootId);
      setSelectedEntry(null);
    }
    await persist({ ...vault, folders, entries }, "Папка удалена");
  };

  const mainContent =
    activeSection === "overview" ? (
      <DashboardPanel vault={vault} />
    ) : activeSection === "security" ? (
      <section className="section-workspace"><SecurityOverview vault={vault} /><p className="muted">Проверка выполняется локально. Пароли не отправляются во внешние сервисы.</p></section>
    ) : activeSection === "trash" ? (
      <TrashPanel entries={deletedEntries} folders={vault.folders} onRestore={restoreEntry} onDeletePermanently={deleteEntryPermanently} />
    ) : (
      <>
        <div className="folder-panel">
          <FolderStrip
            folders={vault.folders}
            entries={activeEntries(vault.entries)}
            selectedFolder={selectedFolder}
            onSelect={(id) => {
              setSelectedFolder(id);
              setSelectedEntry(null);
              setActiveSection("vault");
            }}
            onDropEntry={moveEntryToFolder}
            onCreate={createFolder}
            onRename={renameFolder}
            onDelete={deleteFolder}
          />
        </div>
        <VaultList
          entries={filteredEntries}
          folders={vault.folders}
          selectedId={selectedEntry?.id ?? null}
          sort={sort}
          dragEnabled={!isNativeMobile}
          mobileDragEnabled={isNativeMobile}
          onSort={setSort}
          onSelect={setSelectedEntry}
          onCreate={createEntry}
          onDragStart={() => setSelectedEntry(null)}
          onMobileDragStart={startMobileEntryDrag}
          onMobileDragMove={updateMobileEntryDrag}
          onMobileDragEnd={finishMobileEntryDrag}
          onMobileDragCancel={cancelMobileEntryDrag}
        />
      </>
    );

  return (
    <main className={isNativeMobile ? "cipher-app-shell mobile-native" : "cipher-app-shell"}>
      <CipherBackground />
      <NavigationRail active={activeSection} onSelect={selectSection} onLock={lockVault} />
      <section className="cipher-workspace">
        <CommandBar active={activeSection} query={query} onQuery={setQuery} onCreate={createEntry} onPalette={() => setCommandPaletteOpen(true)} />
        <div
          className={
            activeSection === "overview"
              ? "workspace-grid overview-mode"
              : selectedEntry && activeSection === "vault"
                ? "workspace-grid details-open"
                : "workspace-grid list-only"
          }
        >
          <div className="workspace-primary">{mainContent}</div>
          {selectedEntry && activeSection === "vault" && (
            <EntryDetailsPanel
              entry={selectedEntry}
              vault={vault}
              onEdit={setEditingEntry}
              onDelete={(entryId) => {
                if (!window.confirm("Переместить запись в корзину?")) return;
                moveEntryToTrash(entryId);
              }}
              onCreate={createEntry}
              onCopy={setStatus}
              onClose={() => setSelectedEntry(null)}
            />
          )}
        </div>
      </section>
      {isNativeMobile && mobileDrag && (
        <MobileFolderDropTray folders={vault.folders} targetFolderId={mobileDrag.targetFolderId} />
      )}
      <nav className="mobile-bottom-nav" aria-label="Мобильная навигация">
        <button className={activeSection === "vault" ? "active" : ""} onClick={() => selectSection("vault")}><KeyRound size={18} /><span>Хранилище</span></button>
        <button className={activeSection === "favorites" ? "active" : ""} onClick={() => selectSection("favorites")}><Star size={18} /><span>Избранное</span></button>
        <button className={activeSection === "trash" ? "active" : ""} onClick={() => selectSection("trash")}><Trash2 size={18} /><span>Корзина</span></button>
        <button className={activeSection === "security" ? "active" : ""} onClick={() => selectSection("security")}><ShieldCheck size={18} /><span>Защита</span></button>
        <button onClick={() => setSettingsOpen(true)}><Settings size={18} /><span>Настройки</span></button>
      </nav>

      <CommandPalette
        open={commandPaletteOpen}
        entries={activeEntries(vault.entries)}
        folders={vault.folders}
        onClose={() => setCommandPaletteOpen(false)}
        onCreate={createEntry}
        onSelectEntry={(entry) => {
          setSelectedEntry(entry);
          setActiveSection("vault");
        }}
        onSelectFolder={(folderId) => {
          setSelectedFolder(folderId);
          setActiveSection("vault");
        }}
        onSection={selectSection}
        onLock={lockVault}
      />

      {editingEntry && (
        <>
          <button
            className="scrim"
            aria-label="Закрыть редактор"
            onClick={() => {
              if (editingEntry && !vault.entries.some((item) => item.id === editingEntry.id) && selectedEntry?.id === editingEntry.id) {
                setSelectedEntry(null);
              }
              setEditingEntry(null);
            }}
          />
          <EntryEditor
            entry={editingEntry}
            folders={vault.folders}
            onClose={() => {
              if (editingEntry && !vault.entries.some((item) => item.id === editingEntry.id) && selectedEntry?.id === editingEntry.id) {
                setSelectedEntry(null);
              }
              setEditingEntry(null);
            }}
            onDelete={(id) => {
              if (!vault) return;
              const persisted = vault.entries.some((item) => item.id === id);
              if (!persisted) {
                if (selectedEntry?.id === id) setSelectedEntry(null);
                setEditingEntry(null);
                return;
              }
              if (!window.confirm("Переместить запись в корзину?")) return;
              moveEntryToTrash(id);
            }}
            onSave={(entry) => {
              if (!vault) return;
              const nextVault = saveEntry(vault, entry);
              const saved = nextVault.entries.find((item) => item.id === entry.id) ?? entry;
              setSelectedEntry(saved);
              setEditingEntry(null);
              persist(nextVault, "Запись сохранена");
            }}
          />
        </>
      )}

      {settingsOpen && (
        <>
          <button className="scrim" aria-label="Закрыть настройки по фону" onClick={() => setSettingsOpen(false)} />
          <SettingsPanel
            vault={vault}
            masterPassword={masterPassword}
            biometricUnlock={biometricUnlock}
            onBiometricUnlockChange={(enabled) => {
              setBiometricUnlock(enabled);
              localStorage.setItem(biometricUnlockKey, enabled ? "1" : "0");
            }}
            onPinChange={async (nextPin) => {
              await changeDevicePin(masterPassword, nextPin);
              setStatus("PIN-код изменён");
              window.setTimeout(() => setStatus(""), 2200);
            }}
            onMasterPasswordChange={async (nextMasterPassword, nextVault) => {
              const cleanVault = withLayeredAuthentication(normalizeVault(nextVault));
              await saveVault(cleanVault, nextMasterPassword);
              try {
                await updateDeviceMasterPassword(nextMasterPassword);
              } catch (error) {
                await saveVault(vault, masterPassword);
                throw error;
              }
              setVault(cleanVault);
              setMasterPassword(nextMasterPassword);
              setStatus("Мастер-пароль изменён");
              window.setTimeout(() => setStatus(""), 2200);
            }}
            onClose={() => setSettingsOpen(false)}
            onVaultChange={persist}
            onImportVault={async (nextVault) => {
              const cleanVault = normalizeVault(nextVault);
              const visibleFolderId = cleanVault.entries[0]?.folderId ?? cleanVault.folders[0]?.id ?? "";
              addDebugLog("import", "apply imported vault", {
                entries: cleanVault.entries.length,
                folders: cleanVault.folders.length,
                selectedFolder: visibleFolderId,
              });
              setVault(cleanVault);
              await saveVault(cleanVault, masterPassword);
              addDebugLog("import", "imported vault saved", { entries: cleanVault.entries.length });
              setSelectedFolder(visibleFolderId);
              setSelectedEntry(null);
              setQuery("");
              setSettingsOpen(false);
              setStatus(`Импортировано: ${nextVault.entries.length}`);
              window.setTimeout(() => setStatus(""), 2200);
            }}
            onReset={async () => {
              if (!window.confirm("Удалить локальное хранилище на этом устройстве?")) return;
              destroyVault();
              localStorage.removeItem(biometricUnlockKey);
              await clearDeviceAuth();
              setBiometricUnlock(false);
              setVault(null);
              setMasterPassword("");
              setSelectedEntry(null);
              setSettingsOpen(false);
            }}
          />
        </>
      )}

    </main>
  );
}
