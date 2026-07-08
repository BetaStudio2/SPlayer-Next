<script setup lang="ts">
import type { FormatStat } from "@shared/types/library";
import { formatFileSize } from "@/utils/format";
import { isElectron } from "@/utils/config";
import IconLucideAlertCircle from "~icons/lucide/alert-circle";

const { t } = useI18n();

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const dialogOpen = computed({
  get: () => props.open,
  set: (val: boolean) => emit("update:open", val),
});

type FormatDisplay = FormatStat & {
  label: string;
  color: string;
  countAngle: number;
  sizeAngle: number;
  countPath: string;
  sizePath: string;
  countOffset: { x: number; y: number };
  sizeOffset: { x: number; y: number };
  countPercent: number;
  sizePercent: number;
};

const stats = ref<FormatStat[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const hoveredFormat = ref<string | null>(null);

const COLORS = [
  "#60a5fa",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#22d3ee",
  "#fb923c",
  "#a3e635",
];
const OTHER_COLOR = "#94a3b8";

const FORMAT_LABELS: Record<string, string> = {
  flac: "FLAC",
  alac: "ALAC",
  ape: "APE",
  wav: "WAV",
  wavpack: "WV",
  tta: "TTA",
  aiff: "AIFF",
  mp3: "MP3",
  aac: "AAC",
  m4a: "M4A",
  ogg: "OGG",
  opus: "Opus",
  wma: "WMA",
  dsf: "DSF",
  dff: "DFF",
  unknown: "Unknown",
};

const getFormatLabel = (format: string): string => {
  const lower = format.toLowerCase();
  return FORMAT_LABELS[lower] ?? lower.toUpperCase();
};

const load = async (): Promise<void> => {
  loading.value = true;
  error.value = null;
  try {
    let data: FormatStat[];
    if (isElectron) {
      const res = await window.api.library.getFormatStats();
      if (!res.success || !res.data) {
        throw new Error(res.error ?? "Failed to load stats");
      }
      data = res.data;
    } else {
      const res = await fetch("/api/music/tracks/format-stats");
      if (!res.ok) throw new Error("Failed to load stats");
      const json = await res.json();
      data = json.data as FormatStat[];
    }
    stats.value = data;
  } catch (err) {
    error.value = String(err);
    stats.value = [];
  } finally {
    loading.value = false;
  }
};

const OUTER_R = 72;
const INNER_R = 44;
const CX = 88;
const CY = 88;

function donutSlicePath(
  angleDeg: number,
  startDeg: number,
  totalGapDeg: number,
  sliceCount: number,
): string {
  if (angleDeg <= 0.5) return "";

  const perGap = sliceCount > 1 ? totalGapDeg / sliceCount : 0;
  const halfGap = Math.min(perGap / 2, angleDeg / 6);
  const actualAngle = angleDeg - halfGap * 2;
  const actualStart = startDeg + halfGap;

  if (actualAngle >= 360 - perGap * 2) {
    return [
      `M ${CX - OUTER_R} ${CY}`,
      `A ${OUTER_R} ${OUTER_R} 0 1 1 ${CX + OUTER_R} ${CY}`,
      `A ${OUTER_R} ${OUTER_R} 0 1 1 ${CX - OUTER_R} ${CY}`,
      `M ${CX - INNER_R} ${CY}`,
      `A ${INNER_R} ${INNER_R} 0 1 0 ${CX + INNER_R} ${CY}`,
      `A ${INNER_R} ${INNER_R} 0 1 0 ${CX - INNER_R} ${CY}`,
      "Z",
    ].join(" ");
  }

  const startRad = ((actualStart - 90) * Math.PI) / 180;
  const endRad = ((actualStart + actualAngle - 90) * Math.PI) / 180;

  const x1o = CX + OUTER_R * Math.cos(startRad);
  const y1o = CY + OUTER_R * Math.sin(startRad);
  const x2o = CX + OUTER_R * Math.cos(endRad);
  const y2o = CY + OUTER_R * Math.sin(endRad);

  const x1i = CX + INNER_R * Math.cos(startRad);
  const y1i = CY + INNER_R * Math.sin(startRad);
  const x2i = CX + INNER_R * Math.cos(endRad);
  const y2i = CY + INNER_R * Math.sin(endRad);

  const largeArc = actualAngle > 180 ? 1 : 0;

  return [
    `M ${x1o} ${y1o}`,
    `A ${OUTER_R} ${OUTER_R} 0 ${largeArc} 1 ${x2o} ${y2o}`,
    `L ${x2i} ${y2i}`,
    `A ${INNER_R} ${INNER_R} 0 ${largeArc} 0 ${x1i} ${y1i}`,
    "Z",
  ].join(" ");
}

function sliceOffset(
  angleDeg: number,
  startDeg: number,
  distance = 5,
): { x: number; y: number } {
  const midDeg = startDeg + angleDeg / 2 - 90;
  const midRad = (midDeg * Math.PI) / 180;
  return {
    x: +(distance * Math.cos(midRad)).toFixed(2),
    y: +(distance * Math.sin(midRad)).toFixed(2),
  };
}

const displayStats = computed<FormatDisplay[]>(() => {
  const items = stats.value;
  if (!items.length) return [];

  const totalCount = items.reduce((s, i) => s + i.count, 0);
  const totalSize = items.reduce((s, i) => s + i.totalSize, 0);

  const MAX_SLICES = 8;
  let main = items.slice(0, MAX_SLICES);
  const rest = items.slice(MAX_SLICES);

  if (rest.length > 0) {
    main = main.concat({
      format: "other",
      count: rest.reduce((s, i) => s + i.count, 0),
      totalSize: rest.reduce((s, i) => s + i.totalSize, 0),
    });
  }

  const minAngle = 2;
  let countAcc = 0;
  let sizeAcc = 0;

  const result = main.map((item, idx) => {
    const color = item.format === "other" ? OTHER_COLOR : COLORS[idx % COLORS.length];

    const rawCountAngle = totalCount > 0 ? (item.count / totalCount) * 360 : 0;
    const rawSizeAngle = totalSize > 0 ? (item.totalSize / totalSize) * 360 : 0;
    const countAngle = Math.max(rawCountAngle, minAngle);
    const sizeAngle = Math.max(rawSizeAngle, minAngle);

    return {
      ...item,
      label: getFormatLabel(item.format),
      color,
      countAngle,
      sizeAngle,
      countPercent: totalCount > 0 ? (item.count / totalCount) * 100 : 0,
      sizePercent: totalSize > 0 ? (item.totalSize / totalSize) * 100 : 0,
      countPath: "",
      sizePath: "",
      countOffset: { x: 0, y: 0 },
      sizeOffset: { x: 0, y: 0 },
    };
  });

  const countSum = result.reduce((s, i) => s + i.countAngle, 0);
  const sizeSum = result.reduce((s, i) => s + i.sizeAngle, 0);
  const countScale = countSum > 0 ? 360 / countSum : 1;
  const sizeScale = sizeSum > 0 ? 360 / sizeSum : 1;

  const TOTAL_GAP_DEG = Math.min(8, result.length * 1);

  result.forEach((item) => {
    item.countAngle = item.countAngle * countScale;
    item.sizeAngle = item.sizeAngle * sizeScale;

    item.countPath = donutSlicePath(item.countAngle, countAcc, TOTAL_GAP_DEG, result.length);
    item.sizePath = donutSlicePath(item.sizeAngle, sizeAcc, TOTAL_GAP_DEG, result.length);

    item.countOffset = sliceOffset(item.countAngle, countAcc);
    item.sizeOffset = sliceOffset(item.sizeAngle, sizeAcc);

    countAcc += item.countAngle;
    sizeAcc += item.sizeAngle;
  });

  return result;
});

const countTotal = computed(() => stats.value.reduce((s, i) => s + i.count, 0));
const sizeTotal = computed(() => stats.value.reduce((s, i) => s + i.totalSize, 0));

const hoveredItem = computed(() =>
  hoveredFormat.value
    ? displayStats.value.find((i) => i.format === hoveredFormat.value) ?? null
    : null,
);

const countCenter = computed(() => {
  if (hoveredItem.value) {
    return {
      value: String(hoveredItem.value.count),
      label: hoveredItem.value.label,
      sub: `${hoveredItem.value.countPercent.toFixed(1)}%`,
    };
  }
  return {
    value: String(countTotal.value),
    label: t("mediaStats.tracks"),
    sub: "",
  };
});

const sizeCenter = computed(() => {
  if (hoveredItem.value) {
    return {
      value: formatFileSize(hoveredItem.value.totalSize),
      label: hoveredItem.value.label,
      sub: `${hoveredItem.value.sizePercent.toFixed(1)}%`,
    };
  }
  return {
    value: formatFileSize(sizeTotal.value),
    label: t("mediaStats.totalSize"),
    sub: "",
  };
});

const getTransform = (item: FormatDisplay, mode: "count" | "size"): string => {
  if (hoveredFormat.value !== item.format) return "";
  const offset = mode === "count" ? item.countOffset : item.sizeOffset;
  return `translate(${offset.x}, ${offset.y})`;
};

const getOpacity = (item: FormatDisplay): number => {
  if (hoveredFormat.value === null) return 1;
  return hoveredFormat.value === item.format ? 1 : 0.25;
};

const setHover = (format: string | null): void => {
  hoveredFormat.value = format;
};

watch(
  () => props.open,
  (val) => {
    if (val) load();
  },
);
</script>

<template>
  <SDialog
    v-model:open="dialogOpen"
    :title="t('mediaStats.title')"
    :description="t('mediaStats.description')"
    width="620px"
  >
    <div class="flex flex-col gap-5 py-1" @mouseleave="setHover(null)">
      <div v-if="loading" class="flex items-center justify-center py-12">
        <SLoading class="size-6 text-on-surface-variant/50" />
      </div>

      <div
        v-else-if="error"
        class="flex flex-col items-center justify-center py-8 gap-2 text-sm text-on-surface-variant/60"
      >
        <IconLucideAlertCircle class="size-8 text-on-surface-variant/30" />
        <span>{{ t("mediaStats.loadFailed") }}</span>
        <SButton variant="secondary" size="small" @click="load">
          {{ t("common.retry") }}
        </SButton>
      </div>

      <div
        v-else-if="stats.length === 0"
        class="flex items-center justify-center py-8 text-sm text-on-surface-variant/50"
      >
        {{ t("mediaStats.noData") }}
      </div>

      <template v-else>
        <div class="flex flex-col gap-5">
          <div>
            <div class="flex items-center gap-6">
              <div class="relative shrink-0">
                <svg viewBox="0 0 176 176" class="size-44">
                  <defs>
                    <filter id="countGlow" x="-30%" y="-30%" width="160%" height="160%">
                      <feGaussianBlur stdDeviation="3" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>

                  <circle
                    :cx="CX"
                    :cy="CY"
                    :r="OUTER_R + 3"
                    fill="none"
                    stroke="currentColor"
                    stroke-opacity="0.06"
                    stroke-width="1"
                  />
                  <circle
                    :cx="CX"
                    :cy="CY"
                    :r="INNER_R - 2"
                    fill="none"
                    stroke="currentColor"
                    stroke-opacity="0.04"
                    stroke-width="1"
                  />

                  <g
                    v-for="item in displayStats"
                    :key="'c-' + item.format"
                    :transform="getTransform(item, 'count')"
                    :opacity="getOpacity(item)"
                    class="cursor-pointer transition-all duration-200 ease-out will-change-transform"
                    @mouseenter="setHover(item.format)"
                  >
                    <path
                      :d="item.countPath"
                      :fill="item.color"
                      stroke="none"
                      :filter="hoveredFormat === item.format ? 'url(#countGlow)' : 'none'"
                    />
                  </g>
                </svg>

                <div
                  class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
                >
                  <span
                    class="text-lg font-bold tabular-nums leading-none transition-colors duration-200"
                    :style="{ color: hoveredItem ? hoveredItem.color : '' }"
                    :class="hoveredItem ? '' : 'text-on-surface'"
                  >
                    {{ countCenter.value }}
                  </span>
                  <span class="text-[10px] text-on-surface-variant/50 mt-1 leading-none">
                    {{ countCenter.label }}
                  </span>
                  <span
                    v-if="countCenter.sub"
                    class="text-[10px] text-on-surface-variant/35 mt-0.5 leading-none tabular-nums"
                  >
                    {{ countCenter.sub }}
                  </span>
                </div>
              </div>

              <div class="flex-1 flex flex-col gap-1.5 min-w-0">
                <button
                  v-for="item in displayStats"
                  :key="'cl-' + item.format"
                  type="button"
                  class="flex items-center gap-2.5 text-xs rounded-lg px-3 py-2.5 transition-all duration-150 bg-surface-panel border border-solid border-outline-variant/15"
                  :class="
                    hoveredFormat === item.format
                      ? 'bg-surface-panel border-primary/30'
                      : hoveredFormat !== null
                        ? 'opacity-30'
                        : 'hover:border-primary/20'
                  "
                  @mouseenter="setHover(item.format)"
                >
                  <span
                    class="size-2.5 rounded-full shrink-0 transition-all duration-200"
                    :style="{ backgroundColor: item.color }"
                  />
                  <span class="text-on-surface truncate font-medium">{{ item.label }}</span>
                  <span class="ml-auto flex items-baseline gap-1.5 shrink-0">
                    <span class="text-on-surface tabular-nums font-medium">{{ item.count }}</span>
                    <span class="text-on-surface-variant/40 tabular-nums text-[10px]">
                      {{ item.countPercent.toFixed(1) }}%
                    </span>
                  </span>
                </button>
              </div>
            </div>
          </div>

          <div>
            <div class="flex items-center gap-6">
              <div class="relative shrink-0">
                <svg viewBox="0 0 176 176" class="size-44">
                  <defs>
                    <filter id="sizeGlow" x="-30%" y="-30%" width="160%" height="160%">
                      <feGaussianBlur stdDeviation="3" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>

                  <circle
                    :cx="CX"
                    :cy="CY"
                    :r="OUTER_R + 3"
                    fill="none"
                    stroke="currentColor"
                    stroke-opacity="0.06"
                    stroke-width="1"
                  />
                  <circle
                    :cx="CX"
                    :cy="CY"
                    :r="INNER_R - 2"
                    fill="none"
                    stroke="currentColor"
                    stroke-opacity="0.04"
                    stroke-width="1"
                  />

                  <g
                    v-for="item in displayStats"
                    :key="'s-' + item.format"
                    :transform="getTransform(item, 'size')"
                    :opacity="getOpacity(item)"
                    class="cursor-pointer transition-all duration-200 ease-out will-change-transform"
                    @mouseenter="setHover(item.format)"
                  >
                    <path
                      :d="item.sizePath"
                      :fill="item.color"
                      stroke="none"
                      :filter="hoveredFormat === item.format ? 'url(#sizeGlow)' : 'none'"
                    />
                  </g>
                </svg>

                <div
                  class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
                >
                  <span
                    class="text-base font-bold tabular-nums leading-none transition-colors duration-200"
                    :style="{ color: hoveredItem ? hoveredItem.color : '' }"
                    :class="hoveredItem ? '' : 'text-on-surface'"
                  >
                    {{ sizeCenter.value }}
                  </span>
                  <span class="text-[10px] text-on-surface-variant/50 mt-1 leading-none">
                    {{ sizeCenter.label }}
                  </span>
                  <span
                    v-if="sizeCenter.sub"
                    class="text-[10px] text-on-surface-variant/35 mt-0.5 leading-none tabular-nums"
                  >
                    {{ sizeCenter.sub }}
                  </span>
                </div>
              </div>

              <div class="flex-1 flex flex-col gap-1.5 min-w-0">
                <button
                  v-for="item in displayStats"
                  :key="'sl-' + item.format"
                  type="button"
                  class="flex items-center gap-2.5 text-xs rounded-lg px-3 py-2.5 transition-all duration-150 bg-surface-panel border border-solid border-outline-variant/15"
                  :class="
                    hoveredFormat === item.format
                      ? 'bg-surface-panel border-primary/30'
                      : hoveredFormat !== null
                        ? 'opacity-30'
                        : 'hover:border-primary/20'
                  "
                  @mouseenter="setHover(item.format)"
                >
                  <span
                    class="size-2.5 rounded-full shrink-0 transition-all duration-200"
                    :style="{ backgroundColor: item.color }"
                  />
                  <span class="text-on-surface truncate font-medium">{{ item.label }}</span>
                  <span class="ml-auto flex items-baseline gap-1.5 shrink-0">
                    <span class="text-on-surface tabular-nums font-medium">{{
                      formatFileSize(item.totalSize)
                    }}</span>
                    <span class="text-on-surface-variant/40 tabular-nums text-[10px]">
                      {{ item.sizePercent.toFixed(1) }}%
                    </span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <template #footer="{ close }">
      <SButton variant="secondary" @click="close">
        {{ t("common.close") }}
      </SButton>
    </template>
  </SDialog>
</template>
