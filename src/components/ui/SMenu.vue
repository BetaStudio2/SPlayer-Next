<script setup lang="ts">
import type { Component, VNode, ComponentPublicInstance } from "vue";

export interface SMenuItem {
  /** 菜单项类型 */
  type?: "item" | "divider" | "group";
  key: string;
  label?: string;
  icon?: Component;
  /** 封面 URL */
  cover?: string;
  /** 是否以封面形式展示 */
  showCover?: boolean;
  disabled?: boolean;
  /** group 类型的自定义渲染内容 */
  render?: () => VNode;
  /** item 类型的行尾自定义内容 */
  trailing?: () => VNode;
}

const props = withDefaults(
  defineProps<{
    items: SMenuItem[];
    modelValue?: string;
    /** 尺寸：small（紧凑）| medium（默认）| large（宽松） */
    size?: "small" | "medium" | "large";
    /** 折叠模式 */
    collapsed?: boolean;
    /** 挂载时把选中项滚动到可视区中间 */
    centerActiveOnMount?: boolean;
    /** 导航高亮动效模式 */
    navStyle?: "default" | "animated";
  }>(),
  { size: "medium", collapsed: false, centerActiveOnMount: false, navStyle: "default" },
);

const emit = defineEmits<{
  "update:modelValue": [key: string];
  select: [key: string];
}>();

const navRef = ref<HTMLElement | null>(null);

/** 各菜单项行元素，按 key 收集，用于定位选中项 */
const itemEls = new Map<string, HTMLElement>();
const setItemEl = (key: string, el: Element | ComponentPublicInstance | null): void => {
  if (el instanceof HTMLElement) itemEls.set(key, el);
  else itemEls.delete(key);
};

/** 滑动高亮条的位置 */
const highlighterStyle = ref<{ top: string; height: string }>({ top: "0", height: "0" });
/** 首次定位前不渲染高亮条，避免从 top:0 过渡动画 */
const highlighterReady = ref(false);
/** 组件是否已挂载，挂载前 watch 不触发高亮计算，避免与 centerActiveOnMount 中的 scrollIntoView 竞争 */
const isMounted = ref(false);

const updateHighlighter = () => {
  if (props.navStyle !== "animated" || !props.modelValue || !navRef.value) {
    highlighterReady.value = false;
    return;
  }
  const activeEl = itemEls.get(props.modelValue);
  if (!activeEl) {
    highlighterReady.value = false;
    return;
  }
  // 用 offsetTop / offsetHeight 而非 getBoundingClientRect，
  // 因为前者不受 CSS transform 影响（对话框打开时有 scale 动画）
  highlighterStyle.value = {
    top: `${activeEl.offsetTop + 8}px`,
    height: `${activeEl.offsetHeight - 16}px`,
  };
  highlighterReady.value = true;
};

/** 当 modelValue / collapsed / items 变化时重新计算高亮位置 */
watch(
  () => [props.modelValue, props.collapsed, props.items] as const,
  () => {
    // 挂载前不计算，让 centerActiveOnMount 的 scrollIntoView + rAF 负责首次定位
    if (!isMounted.value) return;
    nextTick(updateHighlighter);
  },
  { deep: true },
);

/** 切换到 animated 模式时立即定位高亮条，并管理 resize 监听 */
watch(
  () => props.navStyle,
  (style) => {
    window.removeEventListener("resize", updateHighlighter);
    if (style === "animated") {
      window.addEventListener("resize", updateHighlighter);
      nextTick(updateHighlighter);
    }
  },
);

onMounted(() => {
  isMounted.value = true;
  if (!props.centerActiveOnMount) {
    // 不需要滚动居中，直接计算高亮位置
    if (props.navStyle === "animated") {
      nextTick(updateHighlighter);
    }
  } else {
    const key = props.modelValue;
    if (key) {
      nextTick(() => {
        itemEls.get(key)?.scrollIntoView({ block: "center" });
        // scrollIntoView 是异步的，等一帧让浏览器完成滚动布局后再计算高亮位置
        requestAnimationFrame(updateHighlighter);
      });
    }
  }

  // 窗口大小变化时重新定位高亮条（由 navStyle watch 统一管理）
  if (props.navStyle === "animated") {
    window.addEventListener("resize", updateHighlighter);
  }
});

onUnmounted(() => {
  if (props.navStyle === "animated") {
    window.removeEventListener("resize", updateHighlighter);
  }
});

const sizeClass = computed(() => {
  const collapsed = props.collapsed;
  switch (props.size) {
    case "small":
      return {
        item: "h-9 px-2.5 text-sm gap-2.5",
        coverItem: "h-11 px-2.5 text-sm gap-2.5",
        icon: collapsed ? "size-5" : "size-4.5",
        cover: collapsed ? "size-6" : "size-8",
      };
    case "large":
      return {
        item: "h-11 px-3.5 text-[15px] gap-3.5",
        coverItem: collapsed
          ? "h-14 px-2.5 text-[15px] gap-3.5"
          : "h-14 px-3.5 text-[15px] gap-3.5",
        icon: collapsed ? "size-6" : "size-5.5",
        cover: collapsed ? "size-7" : "size-10",
      };
    default:
      return {
        item: "h-10.5 px-3 text-sm gap-3",
        coverItem: collapsed ? "h-13 px-2.5 text-sm gap-3" : "h-13 px-3 text-sm gap-3",
        icon: collapsed ? "size-5.5" : "size-5",
        cover: collapsed ? "size-7" : "size-9",
      };
  }
});

const handleSelect = (item: SMenuItem) => {
  if (item.disabled) return;
  emit("update:modelValue", item.key);
  emit("select", item.key);
};
</script>

<template>
  <nav
    ref="navRef"
    class="flex flex-col gap-1"
    :class="{ 'relative': navStyle === 'animated' }"
  >
    <!-- 滑动高亮条（animated 模式） -->
    <div
      v-if="navStyle === 'animated' && !collapsed && highlighterReady"
      class="absolute left-0 w-0.75 rounded-full bg-primary pointer-events-none z-1 transition-[top,height] duration-250"
      :style="{ top: highlighterStyle.top, height: highlighterStyle.height }"
    />
    <template v-for="item in items" :key="item.key">
      <!-- 分隔线 -->
      <SDivider v-if="item.type === 'divider'" class="mx-1" />
      <!-- 分类标题 -->
      <div
        v-else-if="item.type === 'group' && item.render"
        class="overflow-hidden transition-[max-height,opacity] duration-300"
        :class="collapsed ? 'max-h-0 opacity-0' : 'max-h-11 opacity-100'"
      >
        <component :is="item.render" />
      </div>
      <!-- 菜单项 -->
      <STooltip
        v-else-if="!item.type || item.type === 'item'"
        :content="item.label ?? ''"
        :disabled="!collapsed"
        :side-offset="12"
        side="right"
      >
        <div
          :ref="(el) => setItemEl(item.key, el)"
          class="relative flex items-center rounded-lg cursor-pointer select-none overflow-hidden whitespace-nowrap transition-[background-color,color,height,padding] duration-250"
          :class="[
            item.showCover ? sizeClass.coverItem : sizeClass.item,
            modelValue === item.key
              ? 'bg-primary/10 text-primary'
              : 'text-on-surface/80 hover:bg-on-surface/5',
            item.disabled ? 'opacity-40 pointer-events-none' : '',
          ]"
          @click="handleSelect(item)"
        >
          <SImg
            v-if="item.showCover"
            :src="item.cover"
            :class="[
              sizeClass.cover,
              'shrink-0 rounded-md object-cover transition-[width,height] duration-300',
            ]"
          />
          <component
            :is="item.icon"
            v-else-if="item.icon"
            :class="[sizeClass.icon, 'shrink-0 transition-[width,height] duration-300']"
          />
          <span
            class="flex-1 min-w-0 truncate transition-opacity duration-300"
            :class="collapsed ? 'opacity-0' : 'opacity-100'"
          >
            {{ item.label }}
          </span>
          <!-- 行尾自定义 -->
          <div
            v-if="!collapsed && item.trailing"
            class="shrink-0 transition-opacity duration-300"
            @click.stop
          >
            <component :is="item.trailing" />
          </div>
          <!-- 默认模式：静态高亮指示器 -->
          <Transition v-if="navStyle === 'default'" name="fade">
            <span
              v-if="modelValue === item.key"
              class="absolute left-0 top-2 bottom-2 w-0.75 rounded-full bg-primary"
            />
          </Transition>
        </div>
      </STooltip>
    </template>
  </nav>
</template>
