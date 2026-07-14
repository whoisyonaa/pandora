import type { EncryptedVault, VaultState } from "../types/vault";

const ITERATIONS = 600_000;
const MIN_SUPPORTED_ITERATIONS = 100_000;
const MAX_SUPPORTED_ITERATIONS = 2_000_000;
const MAX_CIPHERTEXT_BYTES = 16 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deriveKey(masterPassword: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVault(vault: VaultState, masterPassword: string): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(masterPassword, salt, ITERATIONS);
  const encoded = new TextEncoder().encode(JSON.stringify(vault));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const timestamp = new Date().toISOString();

  return {
    version: 1,
    kdf: "PBKDF2-SHA-256",
    iterations: ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function decryptVault(encrypted: EncryptedVault, masterPassword: string): Promise<VaultState> {
  if (encrypted.version !== 1 || encrypted.kdf !== "PBKDF2-SHA-256") {
    throw new Error("Unsupported encrypted vault format");
  }
  if (!Number.isSafeInteger(encrypted.iterations) || encrypted.iterations < MIN_SUPPORTED_ITERATIONS || encrypted.iterations > MAX_SUPPORTED_ITERATIONS) {
    throw new Error("Invalid vault KDF parameters");
  }
  const salt = base64ToBytes(encrypted.salt);
  const iv = base64ToBytes(encrypted.iv);
  const ciphertext = base64ToBytes(encrypted.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Invalid encrypted vault payload");
  }
  const key = await deriveKey(masterPassword, salt, encrypted.iterations);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const decoded = new TextDecoder().decode(decrypted);
  return JSON.parse(decoded) as VaultState;
}
