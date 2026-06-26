import { defineAsyncComponent } from "vue";
import type { SettingCategory } from "@/types/settings-schema";
import StreamingServerList from "@/components/settings/custom/StreamingServerList.vue";
import IconLucideLibrary from "~icons/lucide/library";

/** Web 服务端模式：SPlayer 自身作为 Subsonic 服务器，仅展示服务管理面板；
 *  桌面端：保持原「连接外部流媒体服务器」逻辑（enabled 开关 + 服务器列表）。 */
const isWeb = typeof window !== "undefined" && !window.navigator.userAgent.includes("Electron");

const mediaSourceCategory: SettingCategory = {
  id: "mediaSource",
  icon: IconLucideLibrary,
  sections: [
    {
      id: "streaming",
      items: isWeb
        ? [
            {
              key: "subsonicServicePanel",
              type: "custom",
              component: defineAsyncComponent(
                () => import("@/components/settings/custom/SubsonicServicePanel.vue"),
              ),
              fullWidth: true,
              keywords: ["subsonic.admin", "subsonic.users", "subsonic.shares"],
            },
          ]
        : [
            {
              key: "streamingEnabled",
              type: "switch",
              binding: { store: "settings", path: "system.streaming.enabled" },
              defaultValue: true,
            },
            {
              key: "streamingServerList",
              type: "custom",
              component: StreamingServerList,
              fullWidth: true,
              keywords: ["streaming.server.add", "streaming.server.test", "streaming.server.connect"],
            },
          ],
    },
  ],
};

export default mediaSourceCategory;
