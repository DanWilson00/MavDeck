/// <reference types="vite/client" />

declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegisterError?: (error: unknown) => void;
    onRegisteredSW?: (swUrl: string, registration?: ServiceWorkerRegistration) => Promise<void> | void;
  }

  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
