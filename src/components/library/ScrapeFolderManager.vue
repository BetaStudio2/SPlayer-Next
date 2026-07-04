<script setup lang="ts">
import { useLibraryStore } from "@/stores/library";
import { toast } from "@/composables/useToast";
import SSlider from "@/components/ui/SSlider.vue";
import type { SCheckboxGroupValue } from "@/components/ui/group-context";
import IconLucideFolder from "~icons/lucide/folder";
import IconLucideFolderPlus from "~icons/lucide/folder-plus";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideInfo from "~icons/lucide/info";
import IconLucideAlertCircle from "~icons/lucide/alert-circle";
import IconLucideWand2 from "~icons/lucide/wand-2";
import IconLucideFolderSync from "~icons/lucide/folder-sync";
import IconLucideSquare from "~icons/lucide/square";

const { t } = useI18n();
const libraryStore = useLibraryStore();
const {
  scrapeDirs,
  organizeAfterScrape,
  organizeTargetDir,
  organizePattern,
  skipScraped,
  useMusicBrainz,
  useDeezer,
  useItunes,
  useNetease,
  useQQMusic,
  useKugou,
  useKuwo,
  useMigu,
  concurrentWorkers,
  scraping,
  scrapeProgress,
} = storeToRefs(libraryStore);

const newDirInput = ref("");
const adding = ref(false);

const folderName = (dir: string): string => {
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || dir;
};

const removingDir = ref<string | null>(null);
const removeConfirmOpen = ref(false);

const handleAdd = async (): Promise<void> => {
  if (adding.value) return;
  const dir = newDirInput.value.trim();
  if (!dir) {
    toast.warning(t("library.emptyDirHint", "请输入目录路径"));
    return;
  }
  adding.value = true;
  try {
    const res = await libraryStore.addScrapeDir(dir);
    if (res.success) {
      newDirInput.value = "";
    } else if (res.error === "nested") {
      toast.warning(t("library.nestedHint"));
    } else if (res.error) {
      toast.error(res.error);
    }
  } finally {
    adding.value = false;
  }
};

const confirmRemove = (dir: string): void => {
  removingDir.value = dir;
  removeConfirmOpen.value = true;
};

const handleRemove = async (): Promise<void> => {
  const dir = removingDir.value;
  if (!dir) return;
  await libraryStore.removeScrapeDir(dir);
  removeConfirmOpen.value = false;
};

/** 整理模板预设 */
const patternPresets = computed(() => [
  {
    label: t("library.organizePatternPresets.artistAlbum", "歌手/专辑"),
    value: "{artist}/{album}/{track}. {title}.{ext}",
  },
  {
    label: t("library.organizePatternPresets.artistOnly", "仅歌手"),
    value: "{artist}/{title}.{ext}",
  },
  {
    label: t("library.organizePatternPresets.genreArtistAlbum", "风格/歌手/专辑"),
    value: "{genre}/{artist}/{album}/{track}. {title}.{ext}",
  },
  {
    label: t("library.organizePatternPresets.yearArtistAlbum", "年份/歌手/专辑"),
    value: "{year}/{artist}/{album}/{track}. {title}.{ext}",
  },
]);

/** 合法的模板变量列表 */
const VALID_PATTERN_VARS = [
  "artist",
  "albumArtist",
  "album",
  "genre",
  "year",
  "disc",
  "track",
  "title",
  "ext",
];

/** 模板语法校验 */
const patternError = computed<string | null>(() => {
  const pattern = organizePattern.value;
  if (!pattern.trim()) {
    return t("library.organizePatternEmptyError", "模板不能为空");
  }
  if (!/\{title\}/.test(pattern)) {
    return t("library.organizePatternNoTitleError", "模板必须包含 {title} 变量");
  }
  if (!/\{ext\}/.test(pattern)) {
    return t("library.organizePatternNoExtError", "模板必须包含 {ext} 变量");
  }
  const usedVars = pattern.match(/\{(\w+)\}/g) || [];
  for (const v of usedVars) {
    const name = v.slice(1, -1);
    if (!VALID_PATTERN_VARS.includes(name)) {
      return t("library.organizePatternUnknownVarError", { name });
    }
  }
  return null;
});

/** 数据源列表（勾选框模式） */
const dataSources = computed(() => [
  { key: "musicbrainz", label: t("library.useMusicBrainz", "MusicBrainz"), desc: t("library.useMusicBrainzDescription", "权威元数据源，提供 MBID、ISRC、流派等信息") },
  { key: "deezer", label: t("library.useDeezer", "Deezer"), desc: t("library.useDeezerDescription", "补充封面与专辑元数据") },
  { key: "itunes", label: t("library.useItunes", "iTunes Search"), desc: t("library.useItunesDescription", "补充封面、流派与曲目编号") },
  // 中文音乐源：对中文音乐匹配率更高
  { key: "netease", label: t("library.useNetease", "网易云"), desc: t("library.useNeteaseDescription", "中文元数据/歌词/封面") },
  { key: "qqmusic", label: t("library.useQQMusic", "QQ 音乐"), desc: t("library.useQQMusicDescription", "中文元数据/歌词/封面") },
  { key: "kugou", label: t("library.useKugou", "酷狗"), desc: t("library.useKugouDescription", "中文元数据/歌词/封面") },
  { key: "kuwo", label: t("library.useKuwo", "酷我"), desc: t("library.useKuwoDescription", "中文元数据/歌词/封面") },
  { key: "migu", label: t("library.useMigu", "咪咕"), desc: t("library.useMiguDescription", "中文元数据/封面") },
]);

/** 选中的数据源（用于 SCheckboxGroup） */
const selectedSources = computed<SCheckboxGroupValue[]>({
  get: () => {
    const arr: SCheckboxGroupValue[] = [];
    if (useMusicBrainz.value) arr.push("musicbrainz");
    if (useDeezer.value) arr.push("deezer");
    if (useItunes.value) arr.push("itunes");
    if (useNetease.value) arr.push("netease");
    if (useQQMusic.value) arr.push("qqmusic");
    if (useKugou.value) arr.push("kugou");
    if (useKuwo.value) arr.push("kuwo");
    if (useMigu.value) arr.push("migu");
    return arr;
  },
  set: (val: SCheckboxGroupValue[]) => {
    const arr = val.map((v) => String(v));
    const hasMb = arr.includes("musicbrainz");
    const hasDz = arr.includes("deezer");
    const hasIt = arr.includes("itunes");
    const hasNe = arr.includes("netease");
    const hasQQ = arr.includes("qqmusic");
    const hasKg = arr.includes("kugou");
    const hasKw = arr.includes("kuwo");
    const hasMg = arr.includes("migu");
    if (hasMb !== useMusicBrainz.value) libraryStore.setUseMusicBrainz(hasMb);
    if (hasDz !== useDeezer.value) libraryStore.setUseDeezer(hasDz);
    if (hasIt !== useItunes.value) libraryStore.setUseItunes(hasIt);
    if (hasNe !== useNetease.value) libraryStore.setUseNetease(hasNe);
    if (hasQQ !== useQQMusic.value) libraryStore.setUseQQMusic(hasQQ);
    if (hasKg !== useKugou.value) libraryStore.setUseKugou(hasKg);
    if (hasKw !== useKuwo.value) libraryStore.setUseKuwo(hasKw);
    if (hasMg !== useMigu.value) libraryStore.setUseMigu(hasMg);
  },
});

/** 并发线程数变化处理 */
const handleWorkersChange = (val: number): void => {
  libraryStore.setConcurrentWorkers(val);
};

/** 是否可开始刮削 */
const canStartScrape = computed<boolean>(() => {
  if (scraping.value) return false;
  if (selectedSources.value.length === 0) return false;
  return true;
});

/** 刮削进度百分比 */
const scrapePercent = computed<number>(() => {
  if (!scrapeProgress.value || scrapeProgress.value.total === 0) return 0;
  return Math.round((scrapeProgress.value.scraped / scrapeProgress.value.total) * 100);
});

/** 开始刮削 */
const handleStartScrape = async (): Promise<void> => {
  if (!canStartScrape.value) return;
  const ok = await libraryStore.startScrape("once");
  if (!ok) {
    toast.error(t("library.startScrapeFailed", "刮削启动失败"));
  }
};

/** 取消刮削 */
const handleCancelScrape = (): void => {
  libraryStore.cancelScrape();
};

/** 仅整理（不刮削） */
const handleStartOrganize = async (): Promise<void> => {
  await libraryStore.startOrganize();
};

/** 进入时确保已同步后端目录列表 */
onMounted(() => {
  if (!libraryStore.initialized) libraryStore.load();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 刮削目录列表 -->
    <div class="flex flex-col gap-2">
      <div
        v-for="dir in scrapeDirs"
        :key="dir"
        class="flex items-center gap-3 px-3 py-2 rounded-lg bg-on-surface/4"
      >
        <IconLucideFolder class="size-4 text-on-surface-variant shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="text-sm truncate text-on-surface">{{ folderName(dir) }}</div>
          <div class="text-xs truncate text-on-surface-variant/60">{{ dir }}</div>
        </div>
        <SButton variant="ghost" size="small" @click="confirmRemove(dir)">
          <template #icon><IconLucideTrash2 /></template>
        </SButton>
      </div>

      <div v-if="scrapeDirs.length === 0" class="py-6 text-center text-on-surface-variant/50 text-sm">
        {{ t("library.emptyScrapeHint", "未设置刮削目录，将使用扫描目录") }}
      </div>

      <div class="mt-1 flex items-center gap-2">
        <SInput
          v-model="newDirInput"
          size="small"
          spellcheck="false"
          :placeholder="t('library.addScrapeFolderPlaceholder', '服务端可访问的绝对路径')"
          class="font-mono text-sm"
          @keydown.enter="handleAdd"
        />
        <SButton variant="secondary" :loading="adding" @click="handleAdd">
          <template #icon><IconLucideFolderPlus /></template>
          {{ t("library.addScrapeFolder", "添加目录") }}
        </SButton>
      </div>
    </div>

    <hr class="border-on-surface/10" />

    <!-- 跳过已刮削文件 -->
    <div class="flex items-center justify-between gap-3">
      <div class="flex-1 min-w-0">
        <div class="text-sm text-on-surface">{{ t("library.skipScraped") }}</div>
        <div class="text-xs text-on-surface-variant/70 mt-0.5">
          {{ t("library.skipScrapedDescription") }}
        </div>
      </div>
      <SSwitch
        :model-value="skipScraped"
        @update:model-value="libraryStore.setSkipScraped($event)"
      />
    </div>

    <hr class="border-on-surface/10" />

    <!-- 刮削后自动整理 -->
    <div class="flex items-center justify-between gap-3">
      <div class="flex-1 min-w-0">
        <div class="text-sm text-on-surface">{{ t("library.organizeAfterScrape") }}</div>
        <div class="text-xs text-on-surface-variant/70 mt-0.5">
          {{ t("library.organizeAfterScrapeDescription") }}
        </div>
      </div>
      <SSwitch
        :model-value="organizeAfterScrape"
        @update:model-value="libraryStore.setOrganizeAfterScrape($event)"
      />
    </div>

    <!-- 整理目标目录 -->
    <div v-if="organizeAfterScrape" class="flex flex-col gap-2 pl-1">
      <div class="text-xs text-on-surface-variant">{{ t("library.organizeTargetDir") }}</div>
      <SInput
        :model-value="organizeTargetDir"
        size="small"
        spellcheck="false"
        :placeholder="t('library.organizeTargetDirPlaceholder')"
        class="font-mono text-sm"
        @update:model-value="libraryStore.setOrganizeTargetDir($event)"
      />
    </div>

    <!-- 整理模板 -->
    <div v-if="organizeAfterScrape" class="flex flex-col gap-2 pl-1">
      <div class="flex items-center justify-between">
        <div class="text-xs text-on-surface-variant">{{ t("library.organizePattern") }}</div>
        <div v-if="patternError" class="flex items-center gap-1 text-xs text-error">
          <IconLucideAlertCircle class="size-3" />
          {{ patternError }}
        </div>
      </div>
      <SInput
        :model-value="organizePattern"
        size="small"
        spellcheck="false"
        :class="patternError ? 'border-error' : ''"
        class="font-mono text-sm"
        @update:model-value="libraryStore.setOrganizePattern($event)"
      />
      <div class="flex items-start gap-1.5 text-xs text-on-surface-variant/60">
        <IconLucideInfo class="size-3.5 mt-0.5 shrink-0" />
        <span>
          {{ t("library.organizePatternDescription", "可用变量: {artist} {albumArtist} {album} {genre} {year} {disc} {track} {title} {ext}，用 / 分隔目录层级") }}
        </span>
      </div>
      <!-- 预设模板 -->
      <div class="flex flex-wrap gap-2 mt-1">
        <SButton
          v-for="preset in patternPresets"
          :key="preset.value"
          variant="ghost"
          size="small"
          @click="libraryStore.setOrganizePattern(preset.value)"
        >
          {{ preset.label }}
        </SButton>
      </div>
    </div>

    <hr class="border-on-surface/10" />

    <!-- 数据源（勾选框模式） -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <div class="text-sm text-on-surface">{{ t("library.dataSources") }}</div>
        <div v-if="selectedSources.length === 0" class="flex items-center gap-1 text-xs text-error">
          <IconLucideAlertCircle class="size-3" />
          {{ t("library.noDataSourceError", "至少选择一个数据源") }}
        </div>
      </div>

      <SCheckboxGroup
        :value="selectedSources"
        class="flex flex-col items-stretch gap-2"
        @update:value="selectedSources = $event"
      >
        <div
          v-for="src in dataSources"
          :key="src.key"
          class="flex items-start gap-3 px-3 py-2 rounded-lg bg-on-surface/4"
        >
          <SCheckbox :value="src.key" class="mt-0.5" />
          <div class="flex-1 min-w-0">
            <div class="text-sm text-on-surface">{{ src.label }}</div>
            <div class="text-xs text-on-surface-variant/70 mt-0.5">
              {{ src.desc }}
            </div>
          </div>
        </div>
      </SCheckboxGroup>
    </div>

    <!-- 并发线程数（多源并发查询） -->
    <div class="flex flex-col gap-2">
      <div class="text-sm text-on-surface">{{ t("library.concurrentWorkers") }}</div>
      <div class="text-xs text-on-surface-variant/70">
        {{ t("library.concurrentWorkersDescription", "多源并发查询线程数，越大占用 CPU 越多但查询更快") }}
      </div>
      <SSlider
        :model-value="concurrentWorkers"
        :min="1"
        :max="8"
        :step="1"
        :marks="{ 1: '1', 2: '', 4: '4', 8: '8' }"
        class="w-full mt-1"
        :thumb-size="14"
        :track-height="4"
        always-show-thumb
        show-popover
        @update:model-value="handleWorkersChange"
      >
        <template #popover="{ value }">{{ value }}</template>
      </SSlider>
    </div>

    <hr class="border-on-surface/10" />

    <!-- 刮削操作区 -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex-1 min-w-0">
          <div class="text-sm text-on-surface">{{ t("library.scrapeAction", "刮削元数据") }}</div>
          <div class="text-xs text-on-surface-variant/70 mt-0.5">
            {{ scraping
              ? t("library.scrapeRunningHint", "正在刮削，请稍后")
              : t("library.scrapeActionDescription", "根据上方设置开始刮削目录中的音频文件") }}
          </div>
        </div>
        <SButton
          v-if="!scraping"
          type="primary"
          :disabled="!canStartScrape"
          @click="handleStartScrape"
        >
          <template #icon><IconLucideWand2 /></template>
          {{ t("library.scrape", "开始刮削") }}
        </SButton>
        <SButton
          v-if="!scraping"
          variant="secondary"
          @click="handleStartOrganize"
        >
          <template #icon><IconLucideFolderSync /></template>
          {{ t("library.organizeOnly", "仅整理") }}
        </SButton>
        <SButton
          v-else
          variant="secondary"
          @click="handleCancelScrape"
        >
          <template #icon><IconLucideSquare class="size-4" /></template>
          {{ t("library.cancelScrape", "取消") }}
        </SButton>
      </div>

      <!-- 刮削进度条 -->
      <div v-if="scraping && scrapeProgress" class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between text-xs text-on-surface-variant/70">
          <!-- total>0：正常进度；total=0：C++ 尚未输出文件数，显示扫描中 -->
          <span v-if="scrapeProgress.total > 0" class="tabular-nums">
            {{ t("library.scrapeProgress", {
              scraped: scrapeProgress.scraped,
              total: scrapeProgress.total,
            }) }}
          </span>
          <span v-else class="tabular-nums">
            {{ t("library.scrapeScanning", "正在扫描文件...") }}
          </span>
          <span v-if="scrapeProgress.total > 0" class="tabular-nums">{{ scrapePercent }}%</span>
        </div>
        <div class="h-1.5 w-full rounded-full bg-on-surface/10 overflow-hidden">
          <div
            class="h-full rounded-full bg-secondary transition-all duration-300 ease-out"
            :style="{ width: `${scrapePercent}%` }"
          />
        </div>
        <div v-if="scrapeProgress.organizing" class="text-xs text-on-surface-variant/70">
          {{ t("library.organizing", "正在整理文件") }}
          <span v-if="scrapeProgress.organizeTotal" class="tabular-nums">
            {{ scrapeProgress.organizeDone ?? 0 }}/{{ scrapeProgress.organizeTotal }}
          </span>
        </div>
      </div>

      <!-- 无数据源提示 -->
      <div
        v-if="!scraping && selectedSources.length === 0"
        class="flex items-center gap-1 text-xs text-error"
      >
        <IconLucideAlertCircle class="size-3.5" />
        {{ t("library.noDataSourceError", "至少选择一个数据源才能开始刮削") }}
      </div>
    </div>

    <SDialog v-model:open="removeConfirmOpen" :title="t('library.removeFolder')">
      <template #default>
        <p class="text-sm text-on-surface-variant">{{ t("library.removeFolderConfirm") }}</p>
        <p class="text-xs text-on-surface-variant/60 mt-2 break-all">{{ removingDir }}</p>
      </template>
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">
          {{ t("common.cancel") }}
        </SButton>
        <SButton type="error" @click="handleRemove">
          {{ t("common.confirm") }}
        </SButton>
      </template>
    </SDialog>
  </div>
</template>
