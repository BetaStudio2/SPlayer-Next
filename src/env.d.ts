/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/vue" />
/// <reference types="pinia-plugin-persistedstate" />

declare const __APP_VERSION__: string;
declare const __APP_REPO_URL__: string;
declare const __APP_REPO_NAME__: string;
declare const __APP_AUTHOR__: string;
declare const __APP_HOMEPAGE__: string;
declare const __APP_AUTHOR_URL__: string;

interface Window {
  __splashStart?: number;
}

// Allow persist option in pinia setup stores
declare module 'pinia' {
  interface DefineSetupStoreOptions<Id extends string, S extends StateTree, G, A> {
    persist?: import('pinia-plugin-persistedstate').Persist<S>;
  }
}
