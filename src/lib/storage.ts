import type { EncryptedVault, VaultState } from "../types/vault";
import { decryptVault, encryptVault } from "./cryptoVault";

const STORAGE_KEY = "pandora.encryptedVault.v1";

export function hasStoredVault() {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

export function readEncryptedVault(): EncryptedVault | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as EncryptedVault) : null;
}

export function readRawVaultStorage() {
  return localStorage.getItem(STORAGE_KEY);
}

export function writeRawVaultStorage(raw: string) {
  localStorage.setItem(STORAGE_KEY, raw);
}

export async function saveVault(vault: VaultState, masterPassword: string) {
  const encrypted = await encryptVault(vault, masterPassword);
  const previous = readEncryptedVault();
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...encrypted,
      createdAt: previous?.createdAt ?? encrypted.createdAt,
      updatedAt: new Date().toISOString(),
    }),
  );
}

export async function unlockVault(masterPassword: string) {
  const encrypted = readEncryptedVault();
  if (!encrypted) {
    throw new Error("Vault does not exist");
  }
  return decryptVault(encrypted, masterPassword);
}

export function destroyVault() {
  localStorage.removeItem(STORAGE_KEY);
}
