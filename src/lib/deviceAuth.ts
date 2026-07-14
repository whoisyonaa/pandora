import { Capacitor, registerPlugin } from "@capacitor/core";
import { isValidPin } from "./pin";

type AuthStatus = {
  configured: boolean;
  failedAttempts: number;
};

type PinUnlockResult = {
  masterPassword?: string;
  failedAttempts: number;
  remainingAttempts: number;
  requiresMasterPassword: boolean;
};

type NativeAuthPlugin = {
  status(): Promise<AuthStatus>;
  setup(options: { masterPassword: string; pin: string }): Promise<void>;
  unlockWithPin(options: { pin: string }): Promise<PinUnlockResult>;
  unlockWithBiometric(): Promise<{ masterPassword: string }>;
  updatePin(options: { masterPassword: string; pin: string }): Promise<void>;
  updateMasterPassword(options: { masterPassword: string }): Promise<void>;
  resetFailures(): Promise<void>;
  clear(): Promise<void>;
};

const NativeAuth = registerPlugin<NativeAuthPlugin>("PandoraAuth");

function electronAuth() {
  return window.pandoraAuth;
}

export async function getDeviceAuthStatus(): Promise<AuthStatus> {
  if (Capacitor.isNativePlatform()) return NativeAuth.status();
  const auth = electronAuth();
  return auth ? auth.status() : { configured: false, failedAttempts: 0 };
}

export async function setupDeviceAuth(masterPassword: string, pin: string) {
  if (masterPassword.length < 8) throw new Error("Мастер-пароль должен содержать минимум 8 символов.");
  if (!isValidPin(pin)) throw new Error("PIN должен содержать минимум 4 цифры.");
  if (Capacitor.isNativePlatform()) return NativeAuth.setup({ masterPassword, pin });
  const auth = electronAuth();
  if (!auth) throw new Error("Безопасное хранилище устройства недоступно.");
  return auth.setup(masterPassword, pin);
}

export async function unlockDeviceWithPin(pin: string): Promise<PinUnlockResult> {
  if (Capacitor.isNativePlatform()) return NativeAuth.unlockWithPin({ pin });
  const auth = electronAuth();
  if (!auth) throw new Error("Безопасное хранилище устройства недоступно.");
  return auth.unlockWithPin(pin);
}

export async function unlockDeviceWithBiometric() {
  if (Capacitor.isNativePlatform()) return (await NativeAuth.unlockWithBiometric()).masterPassword;
  throw new Error("Биометрический вход доступен только в Android.");
}

export async function changeDevicePin(masterPassword: string, pin: string) {
  if (!isValidPin(pin)) throw new Error("PIN должен содержать минимум 4 цифры.");
  if (Capacitor.isNativePlatform()) return NativeAuth.updatePin({ masterPassword, pin });
  const auth = electronAuth();
  if (!auth) throw new Error("Безопасное хранилище устройства недоступно.");
  return auth.updatePin(masterPassword, pin);
}

export async function updateDeviceMasterPassword(masterPassword: string) {
  if (masterPassword.length < 8) throw new Error("Мастер-пароль должен содержать минимум 8 символов.");
  if (Capacitor.isNativePlatform()) return NativeAuth.updateMasterPassword({ masterPassword });
  const auth = electronAuth();
  if (!auth) throw new Error("Безопасное хранилище устройства недоступно.");
  return auth.updateMasterPassword(masterPassword);
}

export async function resetDeviceAuthFailures() {
  if (Capacitor.isNativePlatform()) return NativeAuth.resetFailures();
  return electronAuth()?.resetFailures();
}

export async function clearDeviceAuth() {
  if (Capacitor.isNativePlatform()) return NativeAuth.clear();
  return electronAuth()?.clear();
}
