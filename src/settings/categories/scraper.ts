import { defineAsyncComponent } from "vue";
import type { SettingCategory } from "@/types/settings-schema";
import IconLucideWand2 from "~icons/lucide/wand-2";

const isWeb = typeof window !== "undefined" && !window.navigator.userAgent.includes("Electron");

const scraperCategory: SettingCategory = {
  id: "scraper",
  icon: IconLucideWand2,
  sections: [
    {
      id: "scanner",
      items: [
        {
          key: "scannerParallelism",
          type: "slider",
          visible: () => isWeb,
          binding: { store: "settings", path: "system.library.scannerMaxParallelism" },
          min: 0,
          max: 64,
          step: 1,
          defaultValue: 0,
          marks: {
            0: "auto",
            2: "",
            4: "",
            8: "",
            16: "16",
            32: "32",
            64: "64",
          },
          confirm: {
            when: (next) => typeof next === "number" && next >= 32,
            titleKey: "settings.confirm.highParallelismTitle",
            contentKey: "settings.confirm.highParallelismContent",
            type: "warning",
          },
        },
      ],
    },
    {
      id: "scraper",
      items: [
        {
          key: "scrapeSettings",
          type: "custom",
          visible: () => isWeb,
          component: defineAsyncComponent(
            () => import("@/components/library/ScrapeFolderManager.vue"),
          ),
          fullWidth: true,
          keywords: [
            "scrape.folder", "scrape.datasource", "scrape.organize",
            "scrape.skipScraped", "scrape.concurrentWorkers",
          ],
        },
      ],
    },
  ],
};

export default scraperCategory;
