/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/vue" />
/// <reference types="pinia-plugin-persistedstate" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare const __APP_VERSION__: string;
declare const __APP_REPO_URL__: string;
declare const __APP_REPO_NAME__: string;
declare const __APP_AUTHOR__: string;
declare const __APP_HOMEPAGE__: string;
declare const __APP_AUTHOR_URL__: string;
declare const __IS_ELECTRON__: boolean;

interface Window {
  __splashStart?: number;
}

