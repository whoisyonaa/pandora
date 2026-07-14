/// <reference types="vite/client" />

type PandoraAuthStatus = { configured: boolean; failedAttempts: number };
type PandoraPinUnlock = {
  masterPassword?: string;
  failedAttempts: number;
  remainingAttempts: number;
  requiresMasterPassword: boolean;
};

interface Window {
  pandoraAuth?: {
    status: () => Promise<PandoraAuthStatus>;
    setup: (masterPassword: string, pin: string) => Promise<void>;
    unlockWithPin: (pin: string) => Promise<PandoraPinUnlock>;
    updatePin: (masterPassword: string, pin: string) => Promise<void>;
    updateMasterPassword: (masterPassword: string) => Promise<void>;
    resetFailures: () => Promise<void>;
    clear: () => Promise<void>;
  };
}
