<script setup lang="ts">
import type { DropdownMenuItem } from "@/components/ui/SDropdownMenu.vue";
import { useLibraryStore } from "@/stores/library";
import SongList from "@/components/list/SongList.vue";
import FolderManager from "@/components/library/FolderManager.vue";
import ScrapeFolderManager from "@/components/library/ScrapeFolderManager.vue";
import { formatFileSize } from "@/utils/format";
import { isElectron } from "@/utils/config";
import IconFolderOpen from "~icons/lucide/folder-open";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import IconLucideListChecks from "~icons/lucide/list-checks";
import IconLucideWand2 from "~icons/lucide/wand-2";
import * as player from "@/core/player";

const { t } = useI18n();
const libraryStore = useLibraryStore();
const { tracks, scanDirs, scrapeDirs, scanning, scanProgress, scraping, scrapeProgress, initialized } = storeToRefs(libraryStore);

/** 搜索关键词 */
const searchQuery = ref("");

/** 多选模式 */
const songListRef = shallowRef<InstanceType<typeof SongList> | null>(null);

/** 所有歌曲的总文件大小 */
const totalSize = computed(() => {
  const bytes = tracks.value.reduce((sum, track) => sum + (track.fileSize ?? 0), 0);
  return bytes > 0 ? formatFileSize(bytes) : "";
});

/** 新增目录后立即扫描 */
const handleFolderAdded = (): void => {
  libraryStore.startScan(false);
};

const handleQuickAddFolder = async (): Promise<void> => {
  const res = await libraryStore.addScanDir();
  if (res.success) libraryStore.startScan(false);
};

// 播放全部
const handlePlayAll = (): void => {
  if (tracks.value.length === 0) return;
  player.playFrom(tracks.value, 0);
};

// 扫描进度百分比
const scanPercent = computed(() => {
  if (!scanProgress.value || scanProgress.value.total === 0) return 0;
  return Math.round((scanProgress.value.scanned / scanProgress.value.total) * 100);
});

// 刮削进度百分比
const scrapePercent = computed(() => {
  if (!scrapeProgress.value || scrapeProgress.value.total === 0) return 0;
  return Math.round((scrapeProgress.value.scraped / scrapeProgress.value.total) * 100);
});

// 目录管理弹窗
const folderDialogOpen = ref(false);
const scrapeFolderDialogOpen = ref(false);

const moreMenuItems = computed<DropdownMenuItem[]>(() => [
  { key: "batchManage", label: t("songList.batch.manage"), icon: IconLucideListChecks },
  { key: "folders", label: t("library.folders"), icon: IconFolderOpen, separator: true },
  ...(isElectron
    ? []
    : [
        {
          key: "scrapeFolders",
          label: t("library.scrapeFolders"),
          icon: IconLucideWand2,
          separator: true,
        } as DropdownMenuItem,
      ]),
  {
    key: "scan",
    label: scanning.value ? t("library.scanning") : t("library.scanAll"),
    icon: IconRefreshCw,
    disabled: scanning.value || scanDirs.value.length === 0,
  },
]);

// 更多菜单
const handleMoreMenu = (key: string): void => {
  switch (key) {
    // 批量管理
    case "batchManage":
      songListRef.value?.enterBatch();
      break;
    // 目录管理
    case "folders":
      folderDialogOpen.value = true;
      break;
    // 刮削目录管理
    case "scrapeFolders":
      scrapeFolderDialogOpen.value = true;
      break;
    // 全量扫描
    case "scan":
      libraryStore.startScan(false);
      break;
  }
};

// 刮削
const handleScrape = (): void => {
  if (scraping.value) {
    libraryStore.cancelScrape();
  } else {
    libraryStore.startScrape();
  }
};

// 进入页面时初始化
onMounted(async () => {
  libraryStore.subscribeScanProgress();
  if (!isElectron) {
    libraryStore.subscribeScrapeProgress();
  }
  if (!initialized.value) {
    await libraryStore.load();
  }
  // 每次进入页面都触发一次增量扫描，避免因本地缓存状态未就绪误走全量
  if (scanDirs.value.length > 0) {
    libraryStore.startScan(true);
  }
});

onUnmounted(() => {
  libraryStore.unsubscribeScanProgress();
  if (!isElectron) {
    libraryStore.unsubscribeScrapeProgress();
  }
});
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 顶栏 -->
    <div class="shrink-0 px-5 pb-2">
      <div class="flex items-center justify-between mt-2 mb-4">
        <div class="flex items-baseline gap-4">
          <h1 class="text-3xl font-bold text-on-surface text-balance">{{ t("library.title") }}</h1>
          <!-- 统计或进度 -->
          <Transition name="fade" mode="out-in">
            <div
              v-if="scanning && scanProgress"
              key="scan-progress"
              class="flex items-center gap-2 text-sm text-on-surface-variant/50"
            >
              <SLoading class="size-3.5 text-primary shrink-0" />
              <span class="tabular-nums">
                {{
                  t("library.scanProgress", {
                    scanned: scanProgress.scanned,
                    total: scanProgress.total > 0 ? scanProgress.total : "?",
                  })
                }}
              </span>
              <span v-if="scanProgress.total > 0" class="text-on-surface-variant/40">
                {{ scanPercent }}%
              </span>
            </div>
            <div
              v-else-if="scraping && scrapeProgress"
              key="scrape-progress"
              class="flex items-center gap-2 text-sm text-on-surface-variant/50"
            >
              <SLoading class="size-3.5 text-secondary shrink-0" />
              <span class="tabular-nums">
                {{
                  t("library.scrapeProgress", {
                    scraped: scrapeProgress.scraped,
                    total: scrapeProgress.total > 0 ? scrapeProgress.total : "?",
                  })
                }}
              </span>
              <span v-if="scrapeProgress.total > 0" class="text-on-surface-variant/40">
                {{ scrapePercent }}%
              </span>
            </div>
            <div
              v-else-if="tracks.length > 0"
              key="stats"
              class="flex items-center gap-3 text-sm text-on-surface-variant/50"
            >
              <span class="flex items-center gap-1">
                <IconLucideMusic class="size-3.5" />
                {{ t("common.totalSongs", { count: tracks.length }) }}
              </span>
              <span v-if="totalSize" class="flex items-center gap-1">
                <IconLucideHardDrive class="size-3.5" />
                {{ totalSize }}
              </span>
            </div>
          </Transition>
        </div>
      </div>
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <SButton
            type="primary"
            variant="secondary"
            round
            :disabled="tracks.length === 0"
            @click="handlePlayAll"
          >
            <template #icon>
              <IconLucidePlay />
            </template>
            {{ t("common.playAll") }}
          </SButton>
          <SButton
            variant="secondary"
            circle
            :disabled="scanning || scanDirs.length === 0"
            @click="libraryStore.startScan(true)"
          >
            <template #icon>
              <IconLucideRefreshCw :class="{ 'animate-spin': scanning }" />
            </template>
          </SButton>
          <SButton
            v-if="!isElectron"
            variant="secondary"
            circle
            :disabled="scraping || scrapeDirs.length === 0"
            :title="scraping ? t('library.scraping') : t('library.scrape')"
            @click="handleScrape"
          >
            <template #icon>
              <IconLucideWand2 :class="{ 'animate-pulse': scraping }" />
            </template>
          </SButton>
          <SDropdownMenu :items="moreMenuItems" align="start" @select="handleMoreMenu">
            <template #trigger>
              <SButton variant="secondary" circle>
                <template #icon>
                  <IconLucideEllipsis />
                </template>
              </SButton>
            </template>
          </SDropdownMenu>
        </div>
        <SInput
          v-model="searchQuery"
          :placeholder="t('common.search')"
          clearable
          round
          class="w-40 focus-within:w-56"
        >
          <template #prefix>
            <IconLucideSearch class="size-4 text-on-surface-variant/40 shrink-0" />
          </template>
        </SInput>
      </div>
    </div>
    <!-- 曲目列表 -->
    <div v-if="tracks.length > 0" class="flex-1 min-h-0">
      <SongList
        ref="songListRef"
        :items="tracks"
        :search-query="searchQuery"
        enable-sort
        show-size
      />
    </div>
    <!-- 空状态：无目录或无歌曲 -->
    <div v-else class="flex-1 flex items-center justify-center">
      <div class="text-center text-on-surface-variant/50">
        <IconLucideMusic class="size-12 mx-auto mb-3 opacity-30" />
        <div class="text-sm mb-1">{{ t("library.empty") }}</div>
        <div class="text-xs mb-4 opacity-70">{{ t("library.emptyHint") }}</div>
        <SButton type="primary" variant="secondary" @click="handleQuickAddFolder">
          <template #icon><IconLucideFolderPlus /></template>
          {{ t("library.addFolder") }}
        </SButton>
      </div>
    </div>
    <!-- 文件夹管理 -->
    <SDialog
      v-model:open="folderDialogOpen"
      :title="t('library.folders')"
      :description="t('library.foldersDescription')"
      width="480px"
    >
      <FolderManager @added="handleFolderAdded" />
    </SDialog>

    <!-- 刮削目录管理 -->
    <SDialog
      v-if="!isElectron"
      v-model:open="scrapeFolderDialogOpen"
      :title="t('library.scrapeFolders')"
      :description="t('library.scrapeFoldersDescription')"
      width="480px"
    >
      <ScrapeFolderManager />
    </SDialog>
  </div>
</template>
