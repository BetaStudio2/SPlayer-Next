import type { SettingCategory } from "@/types/settings-schema";
import { useSettingsStore } from "@/stores/settings";
import DeviceSelector from "@/components/settings/custom/DeviceSelector.vue";
import IconLucidePlay from "~icons/lucide/play";
import { isElectron } from "@/utils/config";

/** 是否为 Web 服务端模式 */
const isWeb = !isElectron;

/** 当前是否为流体背景 */
const isAnimationBg = () => useSettingsStore().player.playerBgType === "animation";

/** 当前是否为水纹背景 */
const isRippleBg = () => useSettingsStore().player.playerBgType === "ripple";

/** 当前是否为流体或水纹背景（需要显示子设置的动态效果） */
const isEffectBg = () => isAnimationBg() || isRippleBg();

const playerCategory: SettingCategory = {
  id: "player",
  icon: IconLucidePlay,
  sections: [
    {
      id: "playControl",
      items: [
        {
          key: "autoPlay",
          type: "switch",
          binding: { store: "settings", path: "system.player.autoPlay" },
          defaultValue: true,
        },
        {
          key: "rememberLastTrack",
          type: "switch",
          binding: { store: "settings", path: "system.player.rememberLastTrack" },
          defaultValue: false,
        },
        {
          key: "showLyricInBar",
          type: "switch",
          binding: { store: "settings", path: "player.showLyricInBar" },
          defaultValue: true,
        },
        {
          key: "fadeEnabled",
          type: "switch",
          binding: { store: "settings", path: "system.player.fadeEnabled" },
          defaultValue: true,
          children: [
            {
              key: "fadeDuration",
              type: "slider",
              binding: { store: "settings", path: "system.player.fadeDuration" },
              min: 100,
              max: 600,
              step: 100,
              defaultValue: 200,
              marks: { 100: "100", 200: "200", 600: "600" },
            },
          ],
        },
        {
          key: "loudnessNormalization",
          type: "switch",
          binding: { store: "settings", path: "system.player.loudnessNormalization" },
          defaultValue: false,
          tag: { text: "Beta" },
        },
        {
          key: "songLevel",
          type: "select",
          binding: { store: "settings", path: "player.songLevel" },
          options: [
            { value: "lq", labelKey: "settings.songLevel.lq" },
            { value: "sq", labelKey: "settings.songLevel.sq" },
            { value: "hq", labelKey: "settings.songLevel.hq" },
            { value: "lossless", labelKey: "settings.songLevel.lossless" },
            { value: "hi-res", labelKey: "settings.songLevel.hi-res" },
          ],
          defaultValue: "hq",
        },
        {
          key: "allowTrialPlay",
          type: "switch",
          binding: { store: "settings", path: "player.allowTrialPlay" },
          defaultValue: false,
        },
        {
          key: "serverTranscode",
          type: "switch",
          binding: { store: "settings", path: "player.serverTranscode" },
          defaultValue: false,
          visible: () => isWeb,
        },
      ],
    },
    {
      id: "scrobble",
      tag: { text: "Beta" },
      items: [
        {
          key: "neteaseScrobbleEnabled",
          type: "switch",
          binding: { store: "settings", path: "system.system.neteaseScrobbleEnabled" },
          defaultValue: false,
          children: [
            {
              key: "neteaseScrobbleMode",
              type: "select",
              binding: { store: "settings", path: "system.system.neteaseScrobbleMode" },
              options: [
                { value: "legacy", labelKey: "settings.neteaseScrobbleMode.legacy" },
                { value: "ncbl", labelKey: "settings.neteaseScrobbleMode.ncbl" },
              ],
              defaultValue: "ncbl",
            },
          ],
        },
      ],
    },
    {
      id: "playback",
      items: [
        {
          key: "playerBgType",
          type: "select",
          binding: { store: "settings", path: "player.playerBgType" },
          options: [
            { value: "blur", labelKey: "settings.playerBgType.blur" },
            { value: "solid", labelKey: "settings.playerBgType.solid" },
            { value: "animation", labelKey: "settings.playerBgType.animation" },
            { value: "ripple", labelKey: "settings.playerBgType.ripple" },
          ],
          defaultValue: "blur",
          confirm: {
            when: (next) => next === "animation" || next === "ripple",
            titleKey: "settings.confirm.highResourceTitle",
            contentKey: "settings.confirm.highResourceContent",
            type: "warning",
          },
          childrenCondition: isEffectBg,
          hideChildren: true,
          children: [
            {
              key: "playerBgFlowSpeed",
              type: "slider",
              binding: { store: "settings", path: "player.playerBgFlowSpeed" },
              min: 0.1,
              max: 10,
              step: 0.1,
              defaultValue: 4,
              marks: { 0.1: "0.1", 4: "4", 10: "10" },
              visible: isAnimationBg,
            },
            {
              key: "playerBgRenderScale",
              type: "slider",
              binding: { store: "settings", path: "player.playerBgRenderScale" },
              min: 0.5,
              max: 2,
              step: 0.1,
              defaultValue: 0.5,
              marks: { 0.5: "0.5", 1: "1", 2: "2" },
              visible: isAnimationBg,
            },
            {
              key: "playerBgFps",
              type: "slider",
              binding: { store: "settings", path: "player.playerBgFps" },
              min: 24,
              max: 120,
              step: 2,
              defaultValue: 30,
              marks: { 24: "24", 60: "60", 120: "120" },
              visible: isAnimationBg,
            },
            {
              key: "playerBgFreezeOnPause",
              type: "switch",
              binding: { store: "settings", path: "player.playerBgFreezeOnPause" },
              defaultValue: false,
              visible: isAnimationBg,
            },
            {
              key: "playerBgBeat",
              type: "switch",
              binding: { store: "settings", path: "player.playerBgBeat" },
              defaultValue: false,
              visible: isAnimationBg,
            },
            {
              key: "playerBgRippleSpeed",
              type: "slider",
              binding: { store: "settings", path: "player.playerBgRippleSpeed" },
              min: 0.1,
              max: 10,
              step: 0.1,
              defaultValue: 3,
              marks: { 0.1: "0.1", 3: "3", 10: "10" },
              visible: isRippleBg,
            },
          ],
        },
        {
          key: "coverLayout",
          type: "select",
          binding: { store: "settings", path: "player.coverLayout" },
          options: [
            { value: "default", labelKey: "settings.coverLayout.default" },
            { value: "fullscreen", labelKey: "settings.coverLayout.fullscreen" },
          ],
          defaultValue: "default",
        },
        {
          key: "autoCenterCover",
          type: "switch",
          binding: { store: "settings", path: "player.autoCenterCover" },
          defaultValue: true,
        },
        {
          key: "followCoverColor",
          type: "switch",
          binding: { store: "settings", path: "player.followCoverColor" },
          defaultValue: true,
        },
        {
          key: "timeFormat",
          type: "select",
          binding: { store: "settings", path: "player.timeFormat" },
          options: [
            { value: "current-total", labelKey: "settings.timeFormat.currentTotal" },
            { value: "remaining-total", labelKey: "settings.timeFormat.remainingTotal" },
            { value: "current-remaining", labelKey: "settings.timeFormat.currentRemaining" },
          ],
          defaultValue: "current-total",
          descriptionKey: "settings.timeFormat.description",
        },
        {
          key: "autoImmersive",
          type: "switch",
          binding: { store: "settings", path: "player.autoImmersive" },
          defaultValue: false,
        },
        {
          key: "showProgressTooltip",
          type: "switch",
          binding: { store: "settings", path: "player.showProgressTooltip" },
          defaultValue: true,
          children: [
            {
              key: "showProgressLyric",
              type: "switch",
              binding: { store: "settings", path: "player.showProgressLyric" },
              defaultValue: false,
            },
          ],
        },
        {
          key: "snapToLyric",
          type: "switch",
          binding: { store: "settings", path: "player.snapToLyric" },
          defaultValue: false,
        },
        {
          key: "transitionStyle",
          type: "select",
          binding: { store: "settings", path: "player.transitionStyle" },
          options: [
            { value: "scale", labelKey: "settings.transitionStyle.scale" },
            { value: "slide", labelKey: "settings.transitionStyle.slide" },
          ],
          defaultValue: "scale",
        },
      ],
    },
    {
      id: "musicSpectrum",
      tag: { text: "Beta" },
      items: [
        {
          key: "enableSpectrum",
          type: "switch",
          binding: { store: "settings", path: "player.enableSpectrum" },
          defaultValue: false,
          children: [
            {
              key: "spectrumBarWidth",
              type: "slider",
              binding: { store: "settings", path: "player.spectrumBarWidth" },
              min: 1,
              max: 12,
              step: 1,
              defaultValue: 4,
              marks: { 1: "1", 4: "4", 8: "8", 12: "12" },
            },
            {
              key: "spectrumDisplayMode",
              type: "select",
              binding: { store: "settings", path: "player.spectrumDisplayMode" },
              options: [
                { value: "mirror", labelKey: "settings.spectrumDisplayMode.mirror" },
                { value: "split", labelKey: "settings.spectrumDisplayMode.split" },
              ],
              defaultValue: "mirror",
            },
          ],
        },
      ],
    },

    {
      id: "device",
      items: [
        {
          key: "outputDevice",
          type: "custom",
          component: DeviceSelector,
        },
        {
          key: "pauseOnDeviceSwitch",
          type: "switch",
          binding: { store: "settings", path: "player.pauseOnDeviceSwitch" },
          defaultValue: false,
        },
      ],
    },
  ],
};

export default playerCategory;
