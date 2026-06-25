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
});
