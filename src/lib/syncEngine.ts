import type { EncryptedVault, VaultEntry, VaultFolder, VaultState } from "../types/vault";
import { decryptVault, encryptVault } from "./cryptoVault";

const deviceIdKey = "pandora.syncDeviceId.v1";

export type SyncPayload = {
  format: "pandora-sync-vault";
  version: 1;
  deviceId: string;
  exportedAt: string;
  entryCount: number;
  folderCount: number;
  encryptedVault: EncryptedVault;
};

export type ParsedSyncPayload = {
  vault: VaultState;
  entryCount: number;
  folderCount: number;
  exportedAt: string | null;
  deviceId: string | null;
  legacy: boolean;
};

export type SyncMergeResult = {
  vault: VaultState;
  importedEntries: number;
  totalEntries: number;
  addedEntries: number;
  updatedEntries: number;
};

function now() {
  return new Date().toISOString();
}

function getDeviceId() {
  const existing = localStorage.getItem(deviceIdKey);
  if (existing) return existing;
  const next = crypto.randomUUID();
  localStorage.setItem(deviceIdKey, next);
  return next;
}

function isEncryptedVault(value: unknown): value is EncryptedVault {
  const candidate = value as Partial<EncryptedVault> | null;
  return Boolean(candidate?.ciphertext && candidate?.salt && candidate?.iv && candidate?.kdf);
}

function isSyncPayload(value: unknown): value is SyncPayload {
  const candidate = value as Partial<SyncPayload> | null;
  return candidate?.format === "pandora-sync-vault" && candidate.version === 1 && isEncryptedVault(candidate.encryptedVault);
}

export async function buildSyncPayload(vault: VaultState, masterPassword: string) {
  const encryptedVault = await encryptVault(vault, masterPassword);
  const payload: SyncPayload = {
    format: "pandora-sync-vault",
    version: 1,
    deviceId: getDeviceId(),
    exportedAt: now(),
    entryCount: vault.entries.length,
    folderCount: vault.folders.length,
    encryptedVault,
  };
  return JSON.stringify(payload);
}

export async function buildCompatibleSyncPayload(vault: VaultState, masterPassword: string) {
  return JSON.stringify(await encryptVault(vault, masterPassword));
}

export async function readSyncPayload(raw: string, masterPassword: string): Promise<ParsedSyncPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Файл синхронизации поврежден или имеет неверный формат.");
  }

  if (isSyncPayload(parsed)) {
    const vault = await decryptVault(parsed.encryptedVault, masterPassword);
    return {
      vault,
      entryCount: parsed.entryCount,
      folderCount: parsed.folderCount,
      exportedAt: parsed.exportedAt,
      deviceId: parsed.deviceId,
      legacy: false,
    };
  }

  if (isEncryptedVault(parsed)) {
    const vault = await decryptVault(parsed, masterPassword);
    return {
      vault,
      entryCount: vault.entries.length,
      folderCount: vault.folders.length,
      exportedAt: parsed.updatedAt ?? null,
      deviceId: null,
      legacy: true,
    };
  }

  throw new Error("Файл синхронизации не является файлом Pandora.");
}

function rootFolder(folders: VaultFolder[]) {
  return folders.find((folder) => folder.parentId === null) ?? folders[0] ?? null;
}

function fallbackRoot(): VaultFolder {
  return {
    id: crypto.randomUUID(),
    name: "Все",
    parentId: null,
    createdAt: now(),
  };
}

function folderKey(folder: VaultFolder, parentId: string | null) {
  return `${parentId ?? "root"}:${folder.name.trim().toLocaleLowerCase()}`;
}

function entryTime(entry: VaultEntry) {
  const value = new Date(entry.updatedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function mergeSyncedVaults(localVault: VaultState, remoteVault: VaultState): SyncMergeResult {
  const localFolders = localVault.folders.length > 0 ? localVault.folders : [fallbackRoot()];
  const localRoot = rootFolder(localFolders) ?? localFolders[0];
  const remoteFolders = remoteVault.folders.length > 0 ? remoteVault.folders : [fallbackRoot()];
  const remoteRoot = rootFolder(remoteFolders) ?? remoteFolders[0];
  const folderMap = new Map<string, VaultFolder>();
  const folderByKey = new Map<string, VaultFolder>();
  const remoteToLocal = new Map<string, string>();

  localFolders.forEach((folder) => {
    const normalized = folder.id === localRoot.id ? { ...folder, parentId: null } : folder;
    folderMap.set(normalized.id, normalized);
    folderByKey.set(folderKey(normalized, normalized.parentId), normalized);
  });

  remoteToLocal.set(remoteRoot.id, localRoot.id);

  function mapRemoteFolder(remoteId: string): string {
    const mapped = remoteToLocal.get(remoteId);
    if (mapped) return mapped;

    const remoteFolder = remoteFolders.find((folder) => folder.id === remoteId);
    if (!remoteFolder) return localRoot.id;
    if (remoteFolder.parentId === null) {
      remoteToLocal.set(remoteFolder.id, localRoot.id);
      return localRoot.id;
    }

    const mappedParentId = mapRemoteFolder(remoteFolder.parentId);
    const key = folderKey(remoteFolder, mappedParentId);
    const existing = folderByKey.get(key);
    if (existing) {
      remoteToLocal.set(remoteFolder.id, existing.id);
      return existing.id;
    }

    const nextFolder = { ...remoteFolder, parentId: mappedParentId };
    folderMap.set(nextFolder.id, nextFolder);
    folderByKey.set(key, nextFolder);
    remoteToLocal.set(remoteFolder.id, nextFolder.id);
    return nextFolder.id;
  }

  remoteFolders.forEach((folder) => mapRemoteFolder(folder.id));

  const entries = new Map<string, VaultEntry>();
  localVault.entries.forEach((entry) => entries.set(entry.id, entry));

  let addedEntries = 0;
  let updatedEntries = 0;

  remoteVault.entries.forEach((entry) => {
    const mappedEntry = {
      ...entry,
      folderId: mapRemoteFolder(entry.folderId),
    };
    const localEntry = entries.get(mappedEntry.id);
    if (!localEntry) {
      entries.set(mappedEntry.id, mappedEntry);
      addedEntries += 1;
      return;
    }

    if (entryTime(mappedEntry) >= entryTime(localEntry)) {
      entries.set(mappedEntry.id, mappedEntry);
      if (JSON.stringify(mappedEntry) !== JSON.stringify(localEntry)) {
        updatedEntries += 1;
      }
    }
  });

  const folders = Array.from(folderMap.values()).sort((first, second) => {
    if (first.id === localRoot.id) return -1;
    if (second.id === localRoot.id) return 1;
    return first.createdAt.localeCompare(second.createdAt);
  });
  const mergedEntries = Array.from(entries.values()).sort((first, second) => entryTime(second) - entryTime(first));

  return {
    vault: {
      ...localVault,
      folders,
      entries: mergedEntries,
      settings: {
        ...localVault.settings,
        sync: {
          ...localVault.settings.sync,
          lastSyncAt: now(),
        },
      },
    },
    importedEntries: remoteVault.entries.length,
    totalEntries: mergedEntries.length,
    addedEntries,
    updatedEntries,
  };
}
