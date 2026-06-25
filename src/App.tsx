import { ChangeEvent, ClipboardEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileUp,
  FolderPlus,
  KeyRound,
  Lock,
  LogOut,
  Moon,
  Plus,
  Save,
  Search,
  Settings,
  Shuffle,
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

const minMasterPasswordLength = 4;
const optionalLockKey = "pandora.skipLock.v1";
const rememberedPasswordKey = "pandora.rememberedMasterPassword.v1";

type LocalSyncSession = {
  code: string;
  urls: string[];
};

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

function faviconFromUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return "";
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=128`;
  } catch {
    return "";
  }
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

  try {
    const trimmed = entry.url.trim();
    if (trimmed) {
      const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
      candidates.push(
        `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=128`,
        `https://icons.duckduckgo.com/ip3/${url.hostname}.ico`,
        `${url.origin}/favicon.ico`,
        `${url.origin}/apple-touch-icon.png`,
      );
    }
  } catch {
    // Manual text icons are handled by the fallback label.
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
      <span className={className}>
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
  const saved = { ...entry, updatedAt: now() };
  return {
    ...vault,
    entries: exists ? vault.entries.map((item) => (item.id === entry.id ? saved : item)) : [saved, ...vault.entries],
  };
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
        <img src="./pandoralogo.png" alt="" />
      </div>
      <p>PANDORA</p>
    </main>
  );
}

function LockScreen({ onUnlock }: { onUnlock: (vault: VaultState, password: string) => void }) {
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"unlock" | "create">(hasStoredVault() ? "unlock" : "create");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");

    if (password.length < minMasterPasswordLength) {
      setError(`Минимум ${minMasterPasswordLength} символа.`);
      return;
    }

    try {
      if (mode === "create") {
        const vault = createEmptyVault();
        await saveVault(vault, password);
        onUnlock(vault, password);
      } else {
        const vault = normalizeVault(await unlockVault(password));
        onUnlock(vault, password);
      }
    } catch {
      setError("Не удалось открыть Pandora. Проверьте пароль.");
    }
  }

  return (
    <main className="lock-screen">
      <section className="login-panel">
        <div className="login-logo">
          <img src="./pandoralogo.png" alt="Pandora" />
        </div>
        <div className="login-title">
          <span>PANDORA</span>
          <h1>{mode === "create" ? "Создайте пароль" : "Вход"}</h1>
        </div>

        <form onSubmit={submit} className="login-form">
          <label>
            Мастер-пароль
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Минимум 4 символа"
              autoComplete={mode === "create" ? "new-password" : "current-password"}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="primary wide">
            <Lock size={16} />
            {mode === "create" ? "Создать" : "Войти"}
          </button>
        </form>

        {hasStoredVault() && (
          <button type="button" className="ghost-link" onClick={() => setMode(mode === "unlock" ? "create" : "unlock")}>
            {mode === "unlock" ? "Создать новое хранилище" : "Открыть существующее"}
          </button>
        )}
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
}: {
  folders: VaultFolder[];
  entries: VaultEntry[];
  selectedFolder: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="folder-strip" aria-label="Папки">
      {folders.map((folder) => {
        const ids = descendantFolderIds(folder.id, folders);
        return (
          <button
            key={folder.id}
            className={folder.id === selectedFolder ? "folder-chip active" : "folder-chip"}
            onClick={() => onSelect(folder.id)}
          >
            <span>{folder.name}</span>
            <small>{entries.filter((entry) => ids.has(entry.folderId)).length}</small>
          </button>
        );
      })}
      <button className="folder-add" onClick={onCreate} aria-label="Создать папку" title="Создать папку">
        <FolderPlus size={17} />
      </button>
    </div>
  );
}

function EntryList({
  entries,
  selectedId,
  onSelect,
  onCreate,
}: {
  entries: VaultEntry[];
  selectedId: string | null;
  onSelect: (entry: VaultEntry) => void;
  onCreate: () => void;
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
          <span>ENTRY</span>
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
  skipLock,
  onSkipLockChange,
  onClose,
  onVaultChange,
  onImportVault,
  onReset,
}: {
  vault: VaultState;
  masterPassword: string;
  skipLock: boolean;
  onSkipLockChange: (enabled: boolean) => void;
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

  function downloadDebugLog() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
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
    if (vault.entries.length === 0 && window.confirm("Локальное хранилище пустое. Загрузить данные из облака?")) {
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
          <span>SETTINGS</span>
          <h2>Настройки</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть настройки">
          <X size={18} />
        </button>
      </div>

      <section className="settings-section">
        <h3>Вход</h3>
        <label className="switch">
          <input type="checkbox" checked={skipLock} onChange={(event) => onSkipLockChange(event.target.checked)} />
          Не спрашивать пароль при запуске на этом устройстве
        </label>
        <label>
          Автоблокировка
          <select
            value={vault.settings.lockAfterMinutes}
            onChange={(event) =>
              onVaultChange({
                ...vault,
                settings: { ...vault.settings, lockAfterMinutes: Number(event.target.value) },
              })
            }
          >
            <option value={5}>5 минут</option>
            <option value={15}>15 минут</option>
            <option value={30}>30 минут</option>
            <option value={120}>2 часа</option>
          </select>
        </label>
      </section>

      <section className="settings-section">
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

      <section className="settings-section">
        <h3>Облачная синхронизация</h3>
        <p className="muted">
          Основной вариант: Koofr через WebDAV. Нужен бесплатный аккаунт Koofr и пароль приложения из настроек Koofr.
          В облаке хранится только зашифрованный файл Pandora.
        </p>
        <div className="sync-guide">
          <strong>Koofr, рекомендовано</strong>
          <span>1. Создайте app password в Koofr: Account settings → Preferences → Password.</span>
          <span>2. В Pandora введите email Koofr и этот app password.</span>
          <span>3. Нажмите «Проверить», затем «Сохранить в облако» или «Загрузить из облака».</span>
        </div>
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

      <section className="settings-section">
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

      <section className="settings-section">
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

      <section className="settings-section">
        <h3>Импорт CSV</h3>
        <textarea value={csv} onChange={(event) => setCsv(event.target.value)} placeholder="name,url,username,password" />
        <button onClick={importCsv} disabled={!csv.trim()}>
          <FileUp size={16} />
          Импортировать
        </button>
      </section>

      <section className="settings-section">
        <h3>Диагностика</h3>
        <p className="muted">Журнал не содержит мастер-пароль и содержимое хранилища. После ошибки синхронизации скачайте или скопируйте его и отправьте в чат.</p>
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

      <section className="settings-section danger-zone">
        <h3>Опасная зона</h3>
        <button className="danger" onClick={onReset}>
          <Trash2 size={16} />
          Удалить локальные данные
        </button>
      </section>
    </aside>
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [vault, setVault] = useState<VaultState | null>(null);
  const [masterPassword, setMasterPassword] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<VaultEntry | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("updatedAt");
  const [status, setStatus] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skipLock, setSkipLock] = useState(() => localStorage.getItem(optionalLockKey) === "1");
  const [manualLock, setManualLock] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setBooting(false), 1500);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    applyTheme(vault?.settings.theme ?? defaultTheme);
  }, [vault?.settings.theme]);

  useEffect(() => {
    if (booting || vault || manualLock || !skipLock) return;
    const rememberedPassword = localStorage.getItem(rememberedPasswordKey);
    if (!rememberedPassword || !hasStoredVault()) return;

    unlockVault(rememberedPassword)
      .then((unlocked) => unlock(unlocked, rememberedPassword))
      .catch(() => {
        localStorage.removeItem(optionalLockKey);
        localStorage.removeItem(rememberedPasswordKey);
        setSkipLock(false);
      });
  }, [booting, manualLock, skipLock, vault]);

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
    if (skipLock) {
      localStorage.setItem(rememberedPasswordKey, password);
    }
    setManualLock(false);
    setVault(cleanVault);
    setMasterPassword(password);
    setSelectedFolder(cleanVault.folders[0]?.id ?? "");
    setSelectedEntry(null);
  }

  const filteredEntries = useMemo(() => {
    if (!vault) return [];
    const lower = query.toLowerCase();
    const visibleFolderIds = selectedFolder ? descendantFolderIds(selectedFolder, vault.folders) : null;
    return vault.entries
      .filter((entry) => !visibleFolderIds || visibleFolderIds.has(entry.folderId))
      .filter((entry) => [entry.title, entry.username, entry.url, entry.notes].join(" ").toLowerCase().includes(lower))
      .sort((first, second) => {
        if (sort === "title") return first.title.localeCompare(second.title, "ru");
        if (sort === "usedCount") return second.usedCount - first.usedCount;
        return new Date(second[sort]).getTime() - new Date(first[sort]).getTime();
      });
  }, [query, selectedFolder, sort, vault]);

  if (booting) return <Splash />;

  if (!vault) {
    return <LockScreen onUnlock={unlock} />;
  }

  function createEntry() {
    if (!vault) return;
    setSelectedEntry(newEntry(selectedFolder || vault.folders[0].id));
  }

  return (
    <main className="app-shell">
      <div className="cipher-grid" />
      <section className="app-frame">
        <header className="topbar">
          <div className="brand">
            <img src="./pandoralogo.png" alt="Pandora" />
            <div>
              <span>PANDORA</span>
              <strong>Хранилище</strong>
            </div>
          </div>
          <div className="top-actions">
            {status && (
              <span className="status">
                <Check size={14} />
                {status}
              </span>
            )}
            <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Настройки" title="Настройки">
              <Settings size={18} />
            </button>
            <button
              className="icon-button"
              onClick={() => {
                setManualLock(true);
                setVault(null);
                setMasterPassword("");
                setSelectedEntry(null);
              }}
              aria-label="Заблокировать"
              title="Заблокировать"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <FolderStrip
          folders={vault.folders}
          entries={vault.entries}
          selectedFolder={selectedFolder}
          onSelect={(id) => {
            setSelectedFolder(id);
            setSelectedEntry(null);
          }}
          onCreate={async () => {
            const name = window.prompt("Название папки");
            if (!name?.trim()) return;
            const rootId = vault.folders[0].id;
            const normalizedName = name.trim();
            const duplicate = vault.folders.some(
              (folder) => folder.parentId === rootId && folder.name.trim().toLowerCase() === normalizedName.toLowerCase(),
            );
            if (duplicate) {
              window.alert("\u041f\u0430\u043f\u043a\u0430 \u0441 \u0442\u0430\u043a\u0438\u043c \u0438\u043c\u0435\u043d\u0435\u043c \u0443\u0436\u0435 \u0435\u0441\u0442\u044c");
              return;
            }
            const folder = { id: crypto.randomUUID(), name: normalizedName, parentId: rootId, createdAt: now() };
            await persist(
              { ...vault, folders: [...vault.folders, folder] },
              "Папка создана",
            );
            setSelectedFolder(folder.id);
            setSelectedEntry(null);
          }}
        />

        <section className="search-row">
          <div className="search-box">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по записям" />
          </div>
          <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label="Сортировка">
            <option value="updatedAt">Недавние</option>
            <option value="title">А-Я</option>
            <option value="createdAt">Новые</option>
            <option value="usedCount">Частые</option>
          </select>
          <button className="primary add-button" onClick={createEntry}>
            <Plus size={18} />
            Новая
          </button>
        </section>

        <EntryList entries={filteredEntries} selectedId={selectedEntry?.id ?? null} onSelect={setSelectedEntry} onCreate={createEntry} />
      </section>

      {selectedEntry && (
        <>
          <button className="scrim" aria-label="Закрыть редактор" onClick={() => setSelectedEntry(null)} />
          <EntryEditor
            entry={selectedEntry}
            folders={vault.folders}
            onClose={() => setSelectedEntry(null)}
            onDelete={(id) => {
              if (!vault || !window.confirm("Удалить запись?")) return;
              const nextVault = { ...vault, entries: vault.entries.filter((entry) => entry.id !== id) };
              setSelectedEntry(null);
              persist(nextVault, "Запись удалена");
            }}
            onSave={(entry) => {
              if (!vault) return;
              const nextVault = saveEntry(vault, entry);
              setSelectedEntry(null);
              persist(nextVault, "Запись сохранена");
            }}
          />
        </>
      )}

      {settingsOpen && (
        <>
          <button className="scrim" aria-label="Закрыть настройки" onClick={() => setSettingsOpen(false)} />
          <SettingsPanel
            vault={vault}
            masterPassword={masterPassword}
            skipLock={skipLock}
            onSkipLockChange={(enabled) => {
              setSkipLock(enabled);
              localStorage.setItem(optionalLockKey, enabled ? "1" : "0");
              if (enabled) {
                localStorage.setItem(rememberedPasswordKey, masterPassword);
              } else {
                localStorage.removeItem(rememberedPasswordKey);
              }
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
            onReset={() => {
              if (!window.confirm("Удалить локальное хранилище на этом устройстве?")) return;
              destroyVault();
              localStorage.removeItem(optionalLockKey);
              localStorage.removeItem(rememberedPasswordKey);
              setSkipLock(false);
              setVault(null);
              setMasterPassword("");
              setSelectedEntry(null);
              setSettingsOpen(false);
            }}
          />
        </>
      )}

      <div className="theme-corner" aria-hidden="true">
        <Moon size={14} />
        {vault.entries.length.toString().padStart(2, "0")}
      </div>
    </main>
  );
}
