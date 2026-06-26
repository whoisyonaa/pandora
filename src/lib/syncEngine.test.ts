import { describe, expect, it } from "vitest";
import type { VaultEntry, VaultState } from "../types/vault";
import { encryptVault } from "./cryptoVault";
import { buildSyncPayload, mergeSyncedVaults, readSyncPayload } from "./syncEngine";
import { createEmptyVault } from "./vaultFactory";

function entry(overrides: Partial<VaultEntry>): VaultEntry {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "Entry",
    url: "https://example.com",
    username: "user",
    password: "secret",
    icon: "",
    folderId: "",
    tags: [],
    notes: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    usedCount: 0,
    ...overrides,
  };
}

function vaultWithEntry(title: string): VaultState {
  const vault = createEmptyVault();
  vault.entries.push(entry({ title, folderId: vault.folders[0].id }));
  return vault;
}

describe("sync engine", () => {
  it("round-trips the sync payload format", async () => {
    const vault = vaultWithEntry("Phone");
    const raw = await buildSyncPayload(vault, "1234");
    const parsed = await readSyncPayload(raw, "1234");

    expect(parsed.legacy).toBe(false);
    expect(parsed.entryCount).toBe(1);
    expect(parsed.vault.entries[0].title).toBe("Phone");
  });

  it("reads legacy encrypted vault files", async () => {
    const vault = vaultWithEntry("Legacy");
    const raw = JSON.stringify(await encryptVault(vault, "1234"));
    const parsed = await readSyncPayload(raw, "1234");

    expect(parsed.legacy).toBe(true);
    expect(parsed.vault.entries[0].title).toBe("Legacy");
  });

  it("maps remote root folder entries into the local root folder", () => {
    const local = createEmptyVault();
    const remote = vaultWithEntry("Remote");
    const result = mergeSyncedVaults(local, remote);

    expect(result.addedEntries).toBe(1);
    expect(result.totalEntries).toBe(1);
    expect(result.vault.entries[0].folderId).toBe(local.folders[0].id);
  });

  it("imports remote folders and maps their entries into the imported folder", () => {
    const local = createEmptyVault();
    const remote = createEmptyVault();
    const remoteFolder = {
      id: "remote-folder",
      name: "Work",
      parentId: remote.folders[0].id,
      createdAt: new Date().toISOString(),
    };
    remote.folders.push(remoteFolder);
    remote.entries.push(entry({ id: "remote-entry", title: "Remote", folderId: remoteFolder.id }));

    const result = mergeSyncedVaults(local, remote);
    const importedFolder = result.vault.folders.find((folder) => folder.name === "Work");

    expect(importedFolder).toBeDefined();
    expect(importedFolder?.parentId).toBe(local.folders[0].id);
    expect(result.vault.entries.find((item) => item.id === "remote-entry")?.folderId).toBe(importedFolder?.id);
  });

  it("reuses matching local folders by name instead of duplicating them", () => {
    const local = createEmptyVault();
    const remote = createEmptyVault();
    const localFolder = {
      id: "local-work",
      name: "Work",
      parentId: local.folders[0].id,
      createdAt: new Date().toISOString(),
    };
    const remoteFolder = {
      id: "remote-work",
      name: "Work",
      parentId: remote.folders[0].id,
      createdAt: new Date().toISOString(),
    };
    local.folders.push(localFolder);
    remote.folders.push(remoteFolder);
    remote.entries.push(entry({ id: "remote-entry", title: "Remote", folderId: remoteFolder.id }));

    const result = mergeSyncedVaults(local, remote);
    const workFolders = result.vault.folders.filter((folder) => folder.name === "Work");

    expect(workFolders).toHaveLength(1);
    expect(result.vault.entries.find((item) => item.id === "remote-entry")?.folderId).toBe(localFolder.id);
  });

  it("syncs trashed entries by keeping deletedAt on the newest entry version", () => {
    const local = createEmptyVault();
    const remote = createEmptyVault();
    const localEntry = entry({ id: "shared-entry", title: "Local", folderId: local.folders[0].id, updatedAt: "2026-06-25T10:00:00.000Z" });
    const remoteEntry = {
      ...localEntry,
      deletedAt: "2026-06-25T11:00:00.000Z",
      updatedAt: "2026-06-25T11:00:00.000Z",
    };
    local.entries.push(localEntry);
    remote.entries.push(remoteEntry);

    const result = mergeSyncedVaults(local, remote);

    expect(result.vault.entries.find((item) => item.id === "shared-entry")?.deletedAt).toBe("2026-06-25T11:00:00.000Z");
  });

  it("syncs restored entries by clearing deletedAt on the newest entry version", () => {
    const local = createEmptyVault();
    const remote = createEmptyVault();
    const deletedEntry = entry({
      id: "shared-entry",
      title: "Deleted",
      folderId: local.folders[0].id,
      deletedAt: "2026-06-25T11:00:00.000Z",
      updatedAt: "2026-06-25T11:00:00.000Z",
    });
    const restoredEntry = {
      ...deletedEntry,
      deletedAt: undefined,
      updatedAt: "2026-06-25T12:00:00.000Z",
    };
    local.entries.push(deletedEntry);
    remote.entries.push(restoredEntry);

    const result = mergeSyncedVaults(local, remote);

    expect(result.vault.entries.find((item) => item.id === "shared-entry")?.deletedAt).toBeUndefined();
  });
});
