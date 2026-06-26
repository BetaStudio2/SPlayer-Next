<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
import IconLucideFolderOpen from "~icons/lucide/folder-open";
import IconLucideRotateCcw from "~icons/lucide/rotate-ccw";
import IconLucideCheck from "~icons/lucide/check";
import IconLucidePencil from "~icons/lucide/pencil";

defineOptions({ inheritAttrs: false });

const { t } = useI18n();
const settings = useSettingsStore();

const dir = ref("");
/** Web 服务端模式：内联编辑状态 */
const isWeb = !window.navigator.userAgent.includes("Electron");
const editing = ref(false);
const editValue = ref("");
const saving = ref(false);
const target = computed(() => settings.system.download.target);

const setTarget = async (value: "browser" | "server"): Promise<void> => {
  if (!isWeb || target.value === value) return;
  await settings.setSystem("download.target", value);
};

const load = async (): Promise<void> => {
  dir.value = await window.api.download.getDir();
};

const change = async (): Promise<void> => {
  if (isWeb) {
    // Web 模式：进入内联编辑
    editValue.value = dir.value;
    editing.value = true;
    return;
  }
  // 桌面端：原生目录选择器
  const result = await window.api.download.pickDir();
  if (result.ok) dir.value = result.dir;
};

const saveEdit = async (): Promise<void> => {
  if (!editValue.value.trim()) return;
  saving.value = true;
  try {
    if (window.api.download.setDir) {
      dir.value = await window.api.download.setDir(editValue.value.trim());
      editing.value = false;
    }
  } finally {
    saving.value = false;
  }
};

const cancelEdit = (): void => {
  editing.value = false;
  editValue.value = "";
};

const reset = async (): Promise<void> => {
  dir.value = await window.api.download.resetDir();
  if (editing.value) editValue.value = dir.value;
};

const openDir = (): void => {
  if (dir.value && !isWeb) void window.api.system.showInExplorer(dir.value);
};

onMounted(load);
</script>

<template>
  <div
    class="flex items-center justify-between gap-4 rounded-xl border border-solid border-outline-variant/15 bg-surface-panel px-4 py-3.5"
  >
    <div class="min-w-0 flex-1">
      <div class="text-base">{{ t("settings.downloadDir.label") }}</div>
      <div v-if="isWeb" class="mt-2 inline-flex rounded-lg bg-on-surface/6 p-1">
        <button
          class="px-3 py-1.5 rounded-md text-sm transition-colors"
          :class="
            target === 'browser'
              ? 'bg-primary text-on-primary'
              : 'text-on-surface-variant hover:text-on-surface'
          "
          @click="setTarget('browser')"
        >
          {{ t("settings.downloadTarget.browser", "浏览器保存") }}
        </button>
        <button
          class="px-3 py-1.5 rounded-md text-sm transition-colors"
          :class="
            target === 'server'
              ? 'bg-primary text-on-primary'
              : 'text-on-surface-variant hover:text-on-surface'
          "
          @click="setTarget('server')"
        >
          {{ t("settings.downloadTarget.server", "保存到服务器") }}
        </button>
      </div>
      <!-- Web 模式：内联编辑 -->
      <div v-if="isWeb && target === 'server' && editing" class="mt-1.5 flex items-center gap-2">
        <SInput
          v-model="editValue"
          size="small"
          spellcheck="false"
          :placeholder="t('settings.downloadDir.placeholder', '服务端可访问的绝对路径')"
          class="font-mono text-sm"
          @keydown.enter="saveEdit"
          @keydown.escape="cancelEdit"
        />
        <SButton variant="ghost" circle size="small" :loading="saving" @click="saveEdit">
          <template #icon><IconLucideCheck /></template>
        </SButton>
        <SButton variant="ghost" circle size="small" @click="cancelEdit">
          {{ t("common.cancel") }}
        </SButton>
      </div>
      <!-- 显示模式 -->
      <div
        v-else-if="!isWeb || target === 'server'"
        class="mt-0.5 truncate font-mono text-sm text-on-surface-variant/70"
        :title="dir"
      >
        {{ dir || "—" }}
        <span v-if="isWeb" class="ml-2 text-xs text-on-surface-variant/40">
          ({{ t("settings.downloadDir.serverPathHint", "服务端路径") }})
        </span>
      </div>
      <div v-else class="mt-1 text-sm text-on-surface-variant/70">
        {{ t("settings.downloadTarget.browserHint", "下载时直接交给浏览器保存，不占用服务器磁盘") }}
      </div>
    </div>
    <div class="shrink-0 flex items-center gap-2">
      <SButton
        v-if="!isWeb"
        variant="ghost"
        circle
        :title="t('settings.cacheDir.open')"
        @click="openDir"
      >
        <template #icon><IconLucideFolderOpen /></template>
      </SButton>
      <SButton
        v-if="!isWeb || target === 'server'"
        variant="ghost"
        circle
        :title="t('common.reset')"
        @click="reset"
      >
        <template #icon><IconLucideRotateCcw /></template>
      </SButton>
      <SButton v-if="!isWeb || target === 'server'" variant="secondary" @click="change">
        <template #icon>
          <IconLucidePencil v-if="isWeb" />
        </template>
        {{ t("settings.downloadDir.change") }}
      </SButton>
    </div>
  </div>
</template>
