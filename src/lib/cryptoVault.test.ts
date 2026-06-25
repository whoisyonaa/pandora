import { describe, expect, it } from "vitest";
import { createEmptyVault } from "./vaultFactory";
import { decryptVault, encryptVault } from "./cryptoVault";

describe("encrypted vault", () => {
  it("round-trips data without exposing plaintext in the serialized container", async () => {
    const vault = createEmptyVault();
    vault.entries.push({
      id: "test-entry",
      title: "Test",
      url: "https://example.com",
      username: "user",
      password: "plain-secret-123",
      folderId: vault.folders[0].id,
      tags: [],
      notes: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usedCount: 0,
    });

    const encrypted = await encryptVault(vault, "correct horse battery staple");
    const serialized = JSON.stringify(encrypted);

    expect(serialized).not.toContain("plain-secret-123");
    expect(serialized).not.toContain("Test");

    const decrypted = await decryptVault(encrypted, "correct horse battery staple");
    expect(decrypted.entries[0].password).toBe("plain-secret-123");
  });

  it("rejects an incorrect master password", async () => {
    const encrypted = await encryptVault(createEmptyVault(), "right-password");
    await expect(decryptVault(encrypted, "wrong-password")).rejects.toThrow();
  });
});
