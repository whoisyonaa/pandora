import { describe, expect, it } from "vitest";
import { createEmptyVault } from "./vaultFactory";
import { isValidPin, normalizePin, withLayeredAuthentication } from "./pin";
import { decryptVault, encryptVault } from "./cryptoVault";

describe("PIN authentication", () => {
  it("accepts only four or more digits", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("12345678")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
  });

  it("normalizes numeric input and marks the vault as PIN protected", () => {
    expect(normalizePin("12 3a4")).toBe("1234");
    const vault = withLayeredAuthentication(createEmptyVault());
    expect(vault.settings.authMethods.pin).toBe(true);
    expect(vault.settings.authMethods.masterPassword).toBe(true);
  });

  it("keeps the local PIN separate from the master encryption password", async () => {
    const legacyEncrypted = await encryptVault(createEmptyVault(), "legacy-password");
    const migratedVault = withLayeredAuthentication(await decryptVault(legacyEncrypted, "legacy-password"));
    const pinEncrypted = await encryptVault(migratedVault, "new-master-password");

    await expect(decryptVault(pinEncrypted, "2468")).rejects.toThrow();
    await expect(decryptVault(pinEncrypted, "new-master-password")).resolves.toMatchObject({
      settings: { authMethods: { pin: true, masterPassword: true } },
    });
  });
});
