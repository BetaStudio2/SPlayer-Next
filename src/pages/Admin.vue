<script setup lang="ts">
/**
 * 服务端监控仪表盘
 *
 * 通过 WebSocket 订阅 admin:stats / admin:logs 展示系统资源与实时日志。
 * 仅在 Web 服务端模式可用，通过导航栏「开发者工具」进入。
 */
import { ref, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { toast } from "@/composables/useToast";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import IconLucideCpu from "~icons/lucide/cpu";
import IconLucideHardDrive from "~icons/lucide/hard-drive";
import IconLucideActivity from "~icons/lucide/activity";
import IconLucideTerminal from "~icons/lucide/terminal";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";
import IconLucideTimer from "~icons/lucide/timer";
import IconLucideCircle from "~icons/lucide/circle";
import IconLucideBox from "~icons/lucide/box";

const { t } = useI18n();
const router = useRouter();

/* ---- 状态 ---- */
interface CPUStats {
  userPct: number;
  systemPct: number;
  idlePct: number;
}

interface MemoryStats {
  totalMB: number;
  availableMB: number;
  usedMB: number;
  usedPct: number;
}

interface ProcessStats {
  pid: number;
  cpuUserSec: number;
  cpuSystemSec: number;
  rssMB: number;
  heapMB: number;
  uptimeSec: number;
}

interface ProcessInfo {
  pid: number;
  name: string;
  cpuUserPct: number;
  cpuSysPct: number;
  rssMB: number;
  uptimeSec: number;
}

interface ContainerStats {
  cpuUserPct: number;
  cpuSystemPct: number;
  cpuCores: number;
  memoryUsedMB: number;
  memoryLimitMB: number;
  memoryUsedPct: number;
}

interface Stats {
  cpu: CPUStats;
  memory: MemoryStats;
  uptimeSec: number;
  process: ProcessStats;
  processes: ProcessInfo[];
  container: ContainerStats;
  ts: number;
}

interface LogEntry {
  time: string;
  message: string;
}

const stats = ref<Stats | null>(null);
const logs = ref<LogEntry[]>([]);
const connected = ref(false);
const polling = ref(false);
const logContainer = ref<HTMLElement | null>(null);
let autoScroll = true;

/* ---- WS Admin 订阅 ---- */
function handleStats(data: Stats): void {
  stats.value = data;
  polling.value = true;
}

function handleLogs(data: LogEntry[]): void {
  if (data.length > 0) {
    const existing = new Set(logs.value.slice(-100).map((l) => l.time + l.message));
    const newLogs = data.filter((l) => !existing.has(l.time + l.message));
    if (newLogs.length > 0) {
      logs.value = [...logs.value, ...newLogs].slice(-500);
      if (autoScroll && logContainer.value) {
        requestAnimationFrame(() => {
          logContainer.value!.scrollTop = logContainer.value!.scrollHeight;
        });
      }
    }
  }
}

/* ---- SSE / 实时推送 ---- */
let eventSource: EventSource | null = null;

onMounted(() => {
  connected.value = true;

  eventSource = new EventSource("/api/admin/stream");
  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "stats") {
        handleStats(payload.data as Stats);
      } else if (payload.type === "logs") {
        handleLogs(payload.data as LogEntry[]);
      }
    } catch {
      // 忽略解析错误
    }
  };
  eventSource.onerror = () => {
    polling.value = false;
    // EventSource 会自动重连
  };

  // 初始加载：通过 REST 拉取一次历史日志
  fetch("/api/admin/logs?tail=100")
    .then((res) => res.ok && res.json())
    .then((data) => { if (data) logs.value = data as LogEntry[]; })
    .catch(() => { /* ignore */ });
});

onUnmounted(() => {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
});

/* ---- 手动刷新 ---- */
async function refresh(): Promise<void> {
  try {
    const [statsRes, logsRes] = await Promise.all([
      fetch("/api/admin/stats"),
      fetch("/api/admin/logs?tail=100"),
    ]);
    if (statsRes.ok) stats.value = await statsRes.json();
    if (logsRes.ok) logs.value = await logsRes.json();
    polling.value = true;
  } catch {
    toast.error("无法连接监控服务");
  }
}

/* ---- 工具 ---- */
function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

function formatBytes(mb: number): string {
  if (mb > 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

/* ---- 进程颜色：从主题主色动态派生，兼容任意主题 ---- */

interface ProcColor {
  bg: string;
  text: string;
}

let _primaryHSL: { h: number; s: number; l: number } | null = null;

function readPrimaryHSL(): { h: number; s: number; l: number } {
  if (_primaryHSL) return _primaryHSL;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some(isNaN)) {
    // fallback: Material Blue
    _primaryHSL = { h: 212, s: 72, l: 52 };
    return _primaryHSL;
  }
  const r = parts[0] / 255;
  const g = parts[1] / 255;
  const b = parts[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  _primaryHSL = { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  return _primaryHSL;
}

function generateProcColor(index: number): ProcColor {
  const p = readPrimaryHSL();
  // 以主色为中心，±60° 范围均匀分布（类似色方案）
  const hue = (p.h - 60 + (index * 120) / Math.max(1, index + 1)) % 360;
  return {
    bg: `hsla(${hue.toFixed(0)}, ${p.s}%, ${p.l}%, 0.35)`,
    text: `hsl(${hue.toFixed(0)}, ${(p.s * 0.6).toFixed(0)}%, ${Math.min(p.l + 20, 85).toFixed(0)}%)`,
  };
}

const procColorMap = new Map<string, ProcColor>();

function getProcColor(name: string): ProcColor {
  let c = procColorMap.get(name);
  if (!c) {
    c = generateProcColor(procColorMap.size);
    procColorMap.set(name, c);
  }
  return c;
}

function sortedProcesses(processes: ProcessInfo[]): ProcessInfo[] {
  return [...processes].sort((a, b) => (b.cpuUserPct + b.cpuSysPct) - (a.cpuUserPct + a.cpuSysPct));
}

function handleScroll(): void {
  if (!logContainer.value) return;
  const el = logContainer.value;
  autoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
}

/** 解析日志级别与正文 */
function parseLogEntry(msg: string): { level: string; body: string } {
  const match = msg.match(/^\[(DEBUG|INFO|WARN|ERROR|FATAL)\](.*)/);
  if (match) {
    return { level: match[1], body: match[2] };
  }
  return { level: "", body: msg };
}

/** 日志级别对应的文字颜色 */
function logLevelClass(level: string): string {
  switch (level) {
    case "FATAL":
    case "ERROR": return "text-error";
    case "WARN":  return "text-warning";
    case "INFO":  return "text-info";
    case "DEBUG": return "text-on-surface-variant/60";
    default:      return "text-on-surface/80";
  }
}

/* ---- 回到上一页 ---- */
function goBack(): void {
  router.back();
}

/** 进程 CPU% 总和（堆叠条 100% 填充基线） */
function totalProcessCpuPct(stats: Stats): number {
  const sum = stats.processes.reduce((s, p) => s + p.cpuUserPct + p.cpuSysPct, 0);
  return sum > 0 ? sum : 0.01;
}

/** 进程 RSS 总和（堆叠条 100% 填充基线） */
function totalProcessRssMB(stats: Stats): number {
  const sum = stats.processes.reduce((s, p) => s + p.rssMB, 0);
  return sum > 0 ? sum : 0.01;
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 顶栏 -->
    <div class="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-on-surface/8">
      <SButton variant="tertiary" size="small" @click="goBack">
        <template #icon><IconLucideArrowLeft class="size-5" /></template>
      </SButton>
        <div class="flex items-center gap-2">
        <IconLucideTerminal class="size-5 text-primary" />
        <h1 class="text-lg font-bold text-on-surface">{{ t("nav.devtools") }}</h1>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <div class="flex items-center gap-1.5 text-xs">
          <IconLucideCircle class="size-2.5" :class="polling ? 'text-success' : 'text-on-surface/20'" />
          <span class="text-on-surface-variant/60">{{ polling ? "Connected" : "Disconnected" }}</span>
        </div>
        <SButton variant="secondary" size="small" @click="refresh">
          <template #icon><IconLucideRefreshCw class="size-4" /></template>
        </SButton>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="flex-1 overflow-y-auto p-5 space-y-5">
      <div v-if="!stats" class="flex items-center justify-center h-full text-on-surface-variant/50 text-sm">
        <SLoading class="mr-2 size-4" /> 连接监控服务...
      </div>

      <template v-else>
        <!-- 第一行：4 张系统级卡片（保持原有布局） -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <!-- CPU（Host） -->
          <div class="rounded-xl bg-on-surface/4 p-4">
            <div class="flex items-center gap-2 mb-3">
              <IconLucideCpu class="size-4 text-primary" />
              <span class="text-sm font-medium">CPU (Host)</span>
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">User</span>
                <span class="font-mono text-on-surface">{{ stats.cpu.userPct.toFixed(1) }}%</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">System</span>
                <span class="font-mono text-on-surface">{{ stats.cpu.systemPct.toFixed(1) }}%</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">Idle</span>
                <span class="font-mono text-on-surface">{{ stats.cpu.idlePct.toFixed(1) }}%</span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-on-surface/8 overflow-hidden">
                <div
                  class="h-full rounded-full"
                  :style="{ width: (stats.cpu.userPct + stats.cpu.systemPct).toFixed(1) + '%', transition: 'width 0.6s ease-out' }"
                  :class="stats.cpu.userPct + stats.cpu.systemPct > 80 ? 'bg-error' : 'bg-primary'"
                />
              </div>
            </div>
          </div>

          <!-- 内存（Host） -->
          <div class="rounded-xl bg-on-surface/4 p-4">
            <div class="flex items-center gap-2 mb-3">
              <IconLucideHardDrive class="size-4 text-primary" />
              <span class="text-sm font-medium">Memory (Host)</span>
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">Used</span>
                <span class="font-mono text-on-surface">{{ formatBytes(stats.memory.usedMB) }}</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">Available</span>
                <span class="font-mono text-on-surface">{{ formatBytes(stats.memory.availableMB) }}</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">Total</span>
                <span class="font-mono text-on-surface">{{ formatBytes(stats.memory.totalMB) }}</span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-on-surface/8 overflow-hidden">
                <div
                  class="h-full rounded-full"
                  :style="{ width: stats.memory.usedPct.toFixed(1) + '%', transition: 'width 0.6s ease-out' }"
                  :class="stats.memory.usedPct > 80 ? 'bg-error' : 'bg-primary'"
                />
              </div>
            </div>
          </div>

          <!-- 进程（Go sidecar） -->
          <div class="rounded-xl bg-on-surface/4 p-4">
            <div class="flex items-center gap-2 mb-3">
              <IconLucideActivity class="size-4 text-primary" />
              <span class="text-sm font-medium">Process</span>
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">PID</span>
                <span class="font-mono text-on-surface">{{ stats.process.pid }}</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">RSS</span>
                <span class="font-mono text-on-surface">{{ formatBytes(stats.process.rssMB) }}</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">Heap</span>
                <span class="font-mono text-on-surface">{{ formatBytes(stats.process.heapMB) }}</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">CPU Time</span>
                <span class="font-mono text-on-surface">{{ (stats.process.cpuUserSec + stats.process.cpuSystemSec).toFixed(1) }}s</span>
              </div>
            </div>
          </div>

          <!-- 系统运行时间 -->
          <div class="rounded-xl bg-on-surface/4 p-4">
            <div class="flex items-center gap-2 mb-3">
              <IconLucideTimer class="size-4 text-primary" />
              <span class="text-sm font-medium">Uptime</span>
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">System</span>
                <span class="font-mono text-on-surface">{{ formatUptime(stats.uptimeSec) }}</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">Process</span>
                <span class="font-mono text-on-surface">{{ formatUptime(stats.process.uptimeSec) }}</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-on-surface-variant/60">Updated</span>
                <span class="font-mono text-on-surface text-xs">{{ new Date(stats.ts).toLocaleTimeString() }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 第二行：Container 总览 + 组件堆叠条 -->
        <div class="rounded-xl bg-on-surface/4 p-4">
          <div class="flex items-center gap-2 mb-3">
            <IconLucideBox class="size-4 text-primary" />
            <span class="text-sm font-medium">Container</span>
            <span v-if="stats.container.cpuCores > 0" class="ml-auto text-xs text-on-surface-variant/50">
              {{ stats.container.cpuCores.toFixed(1) }} CPU ·
              {{ formatBytes(stats.container.memoryLimitMB) }} limit
            </span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <!-- 容器 CPU — 堆叠条（100% 填充，组件按比例着色） -->
            <div>
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="text-on-surface-variant/60">CPU</span>
                <span class="font-mono text-on-surface">{{ (stats.container.cpuUserPct + stats.container.cpuSystemPct).toFixed(1) }}%</span>
              </div>
              <div class="h-1.5 rounded-full bg-on-surface/8 overflow-hidden flex">
                <TransitionGroup name="stack">
                  <div
                    v-for="p in sortedProcesses(stats.processes)"
                    v-show="p.cpuUserPct + p.cpuSysPct > 0"
                    :key="p.pid"
                    class="h-full transition-all duration-500"
                    :style="{
                      width: ((p.cpuUserPct + p.cpuSysPct) / totalProcessCpuPct(stats) * 100).toFixed(2) + '%',
                      backgroundColor: getProcColor(p.name).bg,
                    }"
                    :title="`${p.name}: ${(p.cpuUserPct + p.cpuSysPct).toFixed(1)}%`"
                  />
                </TransitionGroup>
              </div>
            </div>
            <!-- 容器内存 — 堆叠条（100% 填充，组件 RSS 按比例着色） -->
            <div>
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="text-on-surface-variant/60">Memory</span>
                <span class="font-mono text-on-surface">{{ formatBytes(stats.container.memoryUsedMB) }}
                  <template v-if="stats.container.memoryLimitMB > 0"> / {{ formatBytes(stats.container.memoryLimitMB) }}</template>
                </span>
              </div>
              <div class="h-1.5 rounded-full bg-on-surface/8 overflow-hidden flex">
                <TransitionGroup name="stack">
                  <div
                    v-for="p in sortedProcesses(stats.processes)"
                    v-show="p.rssMB > 0"
                    :key="p.pid"
                    class="h-full transition-all duration-500"
                    :style="{
                      width: (p.rssMB / totalProcessRssMB(stats) * 100).toFixed(2) + '%',
                      backgroundColor: getProcColor(p.name).bg,
                    }"
                    :title="`${p.name}: ${formatBytes(p.rssMB)}`"
                  />
                </TransitionGroup>
              </div>
            </div>
          </div>
        </div>

        <!-- 第三行：组件进程明细（含堆叠条） -->
        <div class="rounded-xl bg-on-surface/4 p-4">
          <div class="flex items-center gap-2 mb-3">
            <IconLucideActivity class="size-4 text-primary" />
            <span class="text-sm font-medium">Processes</span>
            <span class="ml-auto text-xs text-on-surface-variant/50">{{ stats.processes.length }} components</span>
          </div>
          <div v-if="stats.processes.length === 0" class="text-xs text-on-surface-variant/40 italic py-2">
            No SPlayer processes found.
          </div>
          <div v-else class="max-h-[400px] overflow-y-auto pr-1">
            <table class="w-full text-xs font-mono">
              <thead class="sticky top-0 bg-on-surface/4 backdrop-blur-sm z-10">
                <tr class="text-on-surface-variant/50 border-b border-on-surface/8">
                  <th class="text-left py-2 pr-3">Component</th>
                  <th class="text-right px-3">PID</th>
                  <th class="text-right px-3 w-[120px]">CPU</th>
                  <th class="text-right px-3 w-[110px]">RSS</th>
                  <th class="text-right pl-3">Uptime</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in sortedProcesses(stats.processes)"
                  :key="p.pid"
                  class="border-b border-on-surface/4 hover:bg-on-surface/4 transition-colors"
                >
                  <td class="py-2 pr-3 flex items-center gap-2">
                    <span class="size-2.5 rounded-sm shrink-0" :style="{ backgroundColor: getProcColor(p.name).bg }" />
                    <span class="text-on-surface">{{ p.name }}</span>
                  </td>
                  <td class="text-right px-3 text-on-surface-variant/60">{{ p.pid }}</td>
                  <td class="text-right px-3">
                    <div class="flex items-center gap-2">
                      <div class="flex-1 h-1 rounded-full bg-on-surface/8 overflow-hidden">
                        <div
                          class="h-full rounded-full"
                          :style="{ width: Math.min(p.cpuUserPct + p.cpuSysPct, 100).toFixed(1) + '%', backgroundColor: getProcColor(p.name).bg, transition: 'width 0.6s ease-out' }"
                        />
                      </div>
                      <span :class="p.cpuUserPct + p.cpuSysPct > 50 ? 'text-warning' : 'text-on-surface'" class="w-12 text-right tabular-nums">
                        {{ (p.cpuUserPct + p.cpuSysPct).toFixed(1) }}%
                      </span>
                    </div>
                  </td>
                  <td class="text-right px-3">
                    <div class="flex items-center gap-2">
                      <div class="flex-1 h-1 rounded-full bg-on-surface/8 overflow-hidden">
                        <div
                          class="h-full rounded-full"
                          :style="{ width: (stats.container.memoryLimitMB > 0 ? (p.rssMB / stats.container.memoryLimitMB * 100) : 0).toFixed(1) + '%', backgroundColor: getProcColor(p.name).bg, transition: 'width 0.6s ease-out' }"
                        />
                      </div>
                      <span class="text-on-surface w-14 text-right tabular-nums">{{ formatBytes(p.rssMB) }}</span>
                    </div>
                  </td>
                  <td class="text-right pl-3 text-on-surface-variant/60">{{ formatUptime(p.uptimeSec) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 实时日志 -->
        <div class="rounded-xl bg-on-surface/4 p-4">
          <div class="flex items-center gap-2 mb-3">
            <IconLucideTerminal class="size-4 text-primary" />
            <span class="text-sm font-medium">Logs</span>
            <span class="ml-auto text-xs text-on-surface-variant/50">{{ logs.length }} lines</span>
          </div>
          <div
            ref="logContainer"
            class="h-64 overflow-y-auto font-mono text-xs leading-relaxed bg-black/20 rounded-lg p-3"
            @scroll="handleScroll"
          >
            <div v-if="logs.length === 0" class="text-on-surface-variant/40 italic">
              Waiting for logs...
            </div>
            <div v-for="(log, i) in logs" :key="i" class="whitespace-nowrap flex items-center gap-2">
              <span class="text-on-surface-variant/40 shrink-0">{{ log.time.split("T")[1]?.split(".")[0] || log.time }}</span>
              <span
                v-if="parseLogEntry(log.message).level"
                class="text-[10px] font-bold leading-none shrink-0"
                :class="logLevelClass(parseLogEntry(log.message).level)"
              >{{ parseLogEntry(log.message).level }}</span>
              <span class="text-on-surface/80">{{ parseLogEntry(log.message).body || log.message }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* TransitionGroup: 堆叠条色段进场/离场/位移动效 */
.stack-enter-active {
  transition: all 0.5s ease-out;
}
.stack-leave-active {
  transition: all 0.3s ease-in;
  position: absolute;
}
.stack-enter-from,
.stack-leave-to {
  width: 0 !important;
  opacity: 0;
}
.stack-move {
  transition: all 0.5s ease-out;
}
</style>
