import type { VaultState } from "../types/vault";

export const minPinLength = 4;

export function normalizePin(value: string) {
  return value.replace(/\D/g, "");
}

export function isValidPin(value: string) {
  return new RegExp(`^\\d{${minPinLength},}$`).test(value);
}

export function withLayeredAuthentication(vault: VaultState): VaultState {
  return {
    ...vault,
    settings: {
      ...vault.settings,
      authMethods: {
        ...vault.settings.authMethods,
        masterPassword: true,
        pin: true,
        pattern: false,
      },
    },
  };
}

// Kept for vaults created by the short-lived PIN-only builds.
export const withPinAuthentication = withLayeredAuthentication;
