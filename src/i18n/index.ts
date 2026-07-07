import { createI18n } from "vue-i18n";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import enUS from "./locales/en-US.json";
import jaJP from "./locales/ja-JP.json";
import koKR from "./locales/ko-KR.json";
import frFR from "./locales/fr-FR.json";
import deDE from "./locales/de-DE.json";
import esES from "./locales/es-ES.json";

const i18n = createI18n({
  legacy: false,
  locale: "zh-CN",
  fallbackLocale: "en-US",
  messages: {
    "zh-CN": zhCN,
    "zh-TW": zhTW,
    "en-US": enUS,
    "ja-JP": jaJP,
    "ko-KR": koKR,
    "fr-FR": frFR,
    "de-DE": deDE,
    "es-ES": esES,
  },
});

export default i18n;
