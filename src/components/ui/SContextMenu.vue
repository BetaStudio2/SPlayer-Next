<script setup lang="ts">
import type { DropdownMenuItem } from "./SDropdownMenu.vue";

const props = withDefaults(
  defineProps<{
    /** 菜单项列表 */
    items: DropdownMenuItem[];
    /** 对齐方式 */
    alignOffset?: number;
  }>(),
  {
    alignOffset: 0,
  },
);

/** 选择菜单项事件 */
const emit = defineEmits<{
  select: [key: string];
}>();

/** 显示的项 */
const visibleItems = computed(() => props.items.filter((item) => item.show !== false));
const submenuOpenState = ref<Record<string, boolean>>({});

const getVisibleChildren = (item: DropdownMenuItem): DropdownMenuItem[] =>
  (item.children ?? []).filter((child) => child.show !== false);

const setSubmenuOpen = (key: string, open: boolean): void => {
  if (submenuOpenState.value[key] === open) return;
  submenuOpenState.value = { ...submenuOpenState.value, [key]: open };
};

const resetSubmenus = (): void => {
  submenuOpenState.value = {};
};

/** 选择菜单项 */
const handleSelect = (item: DropdownMenuItem): void => {
  if (item.disabled) return;
  resetSubmenus();
  emit("select", item.key);
};

/** 内容区域样式 */
const contentClass =
  "z-300 min-w-32 max-w-52 rounded-lg bg-surface-bright shadow-lg p-1 text-sm data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out";

/** 菜单项样式 */
const menuItemClass =
  "flex items-center gap-2 px-2 py-1.5 rounded-md text-on-surface outline-none select-none cursor-pointer data-[highlighted]:bg-on-surface/12 data-[disabled]:opacity-40 data-[disabled]:pointer-events-none";
</script>

<template>
  <ContextMenuRoot>
    <ContextMenuTrigger as="div" class="contents">
      <slot />
    </ContextMenuTrigger>

    <ContextMenuPortal>
      <ContextMenuContent
        :align-offset="alignOffset"
        :avoid-collisions="true"
        :collision-padding="12"
        :class="contentClass"
        @close-auto-focus="resetSubmenus"
        @escape-key-down="resetSubmenus"
        @pointer-down-outside="resetSubmenus"
      >
        <slot name="header" />
        <SDivider v-if="$slots.header" class="mx-1.5 my-0.5" />
        <template v-for="item in visibleItems" :key="item.key">
          <SDivider v-if="item.separator" class="mx-1.5 my-0.5" />
          <!-- 子菜单 -->
          <ContextMenuSub
            v-if="getVisibleChildren(item).length"
            :open="submenuOpenState[item.key] ?? false"
            @update:open="setSubmenuOpen(item.key, $event)"
          >
            <ContextMenuSubTrigger
              :disabled="item.disabled"
              :class="menuItemClass"
              :text-value="item.label"
              @pointermove="setSubmenuOpen(item.key, true)"
              @focus="setSubmenuOpen(item.key, true)"
              @click.stop="setSubmenuOpen(item.key, true)"
            >
              <component :is="item.icon" v-if="item.icon" class="size-3.5 opacity-60 shrink-0" />
              <span class="flex-1">{{ item.label }}</span>
              <IconLucideChevronRight class="size-3 opacity-40 shrink-0" />
            </ContextMenuSubTrigger>
            <ContextMenuPortal>
              <ContextMenuSubContent
                :side-offset="4"
                :avoid-collisions="true"
                :collision-padding="12"
                :class="[contentClass, 'max-h-60 overflow-y-auto']"
              >
                <template v-for="child in getVisibleChildren(item)" :key="child.key">
                  <SDivider v-if="child.separator" class="mx-1.5 my-0.5" />
                  <ContextMenuItem
                    v-else
                    :disabled="child.disabled"
                    :class="menuItemClass"
                    :text-value="child.label"
                    @select="handleSelect(child)"
                  >
                    <component
                      :is="child.icon"
                      v-if="child.icon"
                      class="size-3.5 opacity-60 shrink-0"
                    />
                    <span>{{ child.label }}</span>
                  </ContextMenuItem>
                </template>
              </ContextMenuSubContent>
            </ContextMenuPortal>
          </ContextMenuSub>
          <!-- 普通菜单项 -->
          <ContextMenuItem
            v-else
            :disabled="item.disabled"
            :class="menuItemClass"
            @select="handleSelect(item)"
          >
            <component :is="item.icon" v-if="item.icon" class="size-3.5 opacity-60 shrink-0" />
            <span>{{ item.label }}</span>
          </ContextMenuItem>
        </template>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
