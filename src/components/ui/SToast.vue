<script setup lang="ts">
import { computed } from "vue";
import { useToast, setMaxToasts, type ToastType } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settings";

const props = withDefaults(defineProps<{ max?: number }>(), { max: 5 });

setMaxToasts(props.max);

const { toasts, remove } = useToast();
const settings = useSettingsStore();
const toastStyle = computed(() => settings.appearance.toastStyle);

/** 图标色（default 风格用） */
const iconStyles: Record<ToastType, string> = {
  default: "text-on-surface-variant",
  loading: "text-on-surface-variant",
  info: "text-blue-500",
  success: "text-green-600",
  warning: "text-amber-500",
  error: "text-red-500",
};

/** classic 风格：类型 → 边框色 */
const classicBorder: Record<ToastType, string> = {
  default: "border-[#2a4a6b]",
  loading: "border-[#2a4a6b]",
  info: "border-[#2a4a6b]",
  success: "border-[#1f5234]",
  warning: "border-[#6b4a1f]",
  error: "border-[#6b2424]",
};

/** classic 风格：类型 → 进度条色 */
const classicBar: Record<ToastType, string> = {
  default: "bg-[#3498db]",
  loading: "bg-[#3498db]",
  info: "bg-[#3498db]",
  success: "bg-[#27ae60]",
  warning: "bg-[#d68910]",
  error: "bg-[#c0392b]",
};

const onBeforeLeave = (el: Element): void => {
  const htmlEl = el as HTMLElement;
  const rect = htmlEl.getBoundingClientRect();
  htmlEl.style.position = "fixed";
  htmlEl.style.top = `${rect.top}px`;
  htmlEl.style.left = `${rect.left}px`;
  htmlEl.style.width = `${rect.width}px`;
  htmlEl.style.margin = "0";
};
</script>

<template>
  <Teleport to="body">
    <!-- 现代风格：底部居中，彩色图标 -->
    <div
      v-if="toastStyle === 'default'"
      class="fixed bottom-24 inset-x-0 z-999 flex flex-col items-center gap-2 pointer-events-none"
    >
      <TransitionGroup
        enter-active-class="transition-[opacity,transform] duration-250 ease-[cubic-bezier(0.4,0,0.2,1)]"
        leave-active-class="transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.4,0,1,1)]"
        enter-from-class="scale-95 opacity-0"
        leave-to-class="scale-95 opacity-0"
        move-class="transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]"
        @before-leave="onBeforeLeave"
      >
        <div
          v-for="item in toasts"
          :key="item.id"
          class="pointer-events-auto border border-solid border-outline-variant/30 rounded-lg px-3.5 py-2.5 flex items-center gap-2.5 text-sm bg-surface-bright text-on-surface shadow-lg whitespace-nowrap will-change-transform"
        >
          <!-- 图标 -->
          <template v-if="item.icon !== false">
            <component
              :is="item.icon"
              v-if="item.icon"
              class="size-5 shrink-0"
              :class="iconStyles[item.type]"
            />
            <template v-else>
              <SLoading v-if="item.type === 'loading'" class="size-5 shrink-0" />
              <IconMaterialSymbolsChatBubbleRounded
                v-else-if="item.type === 'default'"
                class="size-5 shrink-0"
                :class="iconStyles.default"
              />
              <IconMaterialSymbolsInfoRounded
                v-else-if="item.type === 'info'"
                class="size-5 shrink-0"
                :class="iconStyles.info"
              />
              <IconMaterialSymbolsCheckCircleRounded
                v-else-if="item.type === 'success'"
                class="size-5 shrink-0"
                :class="iconStyles.success"
              />
              <IconMaterialSymbolsErrorRounded
                v-else-if="item.type === 'warning'"
                class="size-5 shrink-0"
                :class="iconStyles.warning"
              />
              <IconMaterialSymbolsCancelRounded
                v-else-if="item.type === 'error'"
                class="size-5 shrink-0"
                :class="iconStyles.error"
              />
            </template>
          </template>
          <span>{{ item.message }}</span>
          <button
            v-if="item.closable"
            class="shrink-0 p-0 border-none bg-transparent opacity-40 hover:opacity-100 cursor-pointer text-current leading-0 transition-opacity duration-200"
            @click="remove(item.id)"
          >
            <IconLucideX class="size-3.5" />
          </button>
        </div>
      </TransitionGroup>
    </div>

    <!-- 经典风格：顶部居中，主题背景 + 彩色边框 + 底部进度条 -->
    <div
      v-else
      class="fixed top-6 inset-x-0 z-999 flex flex-col items-center gap-2 pointer-events-none"
    >
      <TransitionGroup
        enter-active-class="transition-all duration-250 ease-out"
        leave-active-class="transition-all duration-200 ease-in"
        enter-from-class="opacity-0 -translate-y-4"
        leave-to-class="opacity-0 -translate-y-4"
        move-class="transition-transform duration-200"
        @before-leave="onBeforeLeave"
      >
        <div
          v-for="item in toasts"
          :key="item.id"
          :class="['pointer-events-auto border border-solid rounded-lg px-4 py-2.5 min-w-[200px] text-sm bg-surface-bright text-on-surface shadow-lg overflow-hidden relative', classicBorder[item.type]]"
        >
          <div class="flex items-center justify-center gap-2.5 whitespace-nowrap">
            <span>{{ item.message }}</span>
            <button
              v-if="item.closable"
              class="shrink-0 p-0 border-none bg-transparent opacity-40 hover:opacity-100 cursor-pointer text-current leading-0 transition-opacity duration-200"
              @click="remove(item.id)"
            >
              <IconLucideX class="size-3.5" />
            </button>
          </div>
          <!-- 底部进度条 -->
          <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-on-surface/10">
            <div
              v-if="item.duration > 0"
              class="h-full rounded-full toast-progress-bar"
              :class="classicBar[item.type]"
              :style="{ animationDuration: item.duration + 'ms' }"
            />
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
@keyframes toast-progress {
  from {
    width: 100%;
  }
  to {
    width: 0%;
  }
}

.toast-progress-bar {
  animation: toast-progress linear forwards;
}
</style>
