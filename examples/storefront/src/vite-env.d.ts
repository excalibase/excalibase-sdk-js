/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EXCALIBASE_URL?: string;
  readonly VITE_EXCALIBASE_PROJECT_ID?: string;
  readonly VITE_EXCALIBASE_ORG_SLUG?: string;
  readonly VITE_EXCALIBASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
