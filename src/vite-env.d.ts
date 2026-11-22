/// <reference types="vite/client" />

/** App version from package.json, injected by Vite. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Optional GitHub Releases URL shown when the in-app updater isn't configured. */
  readonly VITE_RELEASES_URL?: string;
}
