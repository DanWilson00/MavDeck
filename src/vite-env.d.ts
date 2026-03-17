/// <reference types="vite/client" />

declare module 'solid-js' {
  namespace JSX {
    interface ExplicitProperties {
      value?: string | number;
    }
  }
}

declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean;
    onOfflineReady?: () => void;
    onRegisterError?: (error: unknown) => void;
  }

  export function registerSW(options?: RegisterSWOptions): () => void;
}
