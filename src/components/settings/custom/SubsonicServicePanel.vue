<script setup lang="ts">
/**
 * Subsonic 服务管理面板（web 服务端模式专用）
 *
 * SPlayer 在服务端模式下自身即 Subsonic 流媒体服务器，此面板用于：
 *   - 查看服务端点 / API 版本
 *   - 管理连接用户（增删 / 改密 / 角色）
 *   - 查看与管理分享链接
 *
 * 认证流程：
 *   1. 首次访问（无 admin）→ 引导设置首个管理员
 *   2. 已初始化但未登录 → 登录框
 *   3. 登录后 → 管理界面
 */
import { subsonicAdminApi, type SubsonicServiceUser, type SubsonicServiceShare } from "@/services/subsonic-admin";
import { toast } from "@/composables/useToast";
import IconLucideServer from "~icons/lucide/server";
import IconLucideUsers from "~icons/lucide/users";
import IconLucideShare2 from "~icons/lucide/share-2";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideKey from "~icons/lucide/key";
import IconLucideShieldCheck from "~icons/lucide/shield-check";
import IconLucideShield from "~icons/lucide/shield";
import IconLucideExternalLink from "~icons/lucide/external-link";
import IconLucideLogOut from "~icons/lucide/log-out";
import IconLucideLock from "~icons/lucide/lock";

defineOptions({ inheritAttrs: false });

const { t } = useI18n();

/** 视图模式：loading | setup | login | admin */
const view = ref<"loading" | "setup" | "login" | "admin">("loading");
const status = ref<Awaited<ReturnType<typeof subsonicAdminApi.getStatus>> | null>(null);
const currentUser = ref<string | null>(null);
const users = ref<SubsonicServiceUser[]>([]);
const shares = ref<SubsonicServiceShare[]>([]);

/** 加载管理数据（用户/分享）；失败仅提示，不改变视图 */
const loadAdminData = async (): Promise<void> => {
  try {
    const [u, sh] = await Promise.all([subsonicAdminApi.listUsers(), subsonicAdminApi.listShares()]);
    users.value = u;
    shares.value = sh;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "加载管理数据失败");
  }
};

const refresh = async (): Promise<void> => {
  try {
    const [s, sess] = await Promise.all([subsonicAdminApi.getStatus(), subsonicAdminApi.getSession()]);
    status.value = s;
    currentUser.value = sess.loggedIn ? (sess.username ?? null) : null;
    if (!s.initialized) {
      view.value = "setup";
      return;
    }
    if (!sess.loggedIn) {
      view.value = "login";
      return;
    }
    view.value = "admin";
    await loadAdminData();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "加载失败");
    view.value = "login";
  }
};

onMounted(refresh);

/* ---- 首次设置 ---- */
const setupForm = ref({ username: "admin", password: "", confirm: "" });
const setupBusy = ref(false);
const handleSetup = async (): Promise<void> => {
  if (!setupForm.value.username || !setupForm.value.password) {
    toast.warning(t("subsonic.admin.userRequired", "请填写用户名和密码"));
    return;
  }
  if (setupForm.value.password.length < 6) {
    toast.warning(t("subsonic.admin.passwordTooShort", "密码至少 6 位"));
    return;
  }
  if (setupForm.value.password !== setupForm.value.confirm) {
    toast.warning(t("subsonic.admin.passwordMismatch", "两次输入的密码不一致"));
    return;
  }
  setupBusy.value = true;
  try {
    const res = await subsonicAdminApi.setup({ username: setupForm.value.username, password: setupForm.value.password });
    currentUser.value = res.username;
    view.value = "admin";
    toast.success(t("subsonic.admin.setupDone", "管理员已创建"));
    setupForm.value = { username: "admin", password: "", confirm: "" };
    await loadAdminData();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "设置失败");
  } finally {
    setupBusy.value = false;
  }
};

/* ---- 登录 ---- */
const loginForm = ref({ username: "", password: "" });
const loginBusy = ref(false);
const handleLogin = async (): Promise<void> => {
  if (!loginForm.value.username || !loginForm.value.password) {
    toast.warning(t("subsonic.admin.userRequired", "请填写用户名和密码"));
    return;
  }
  loginBusy.value = true;
  try {
    const res = await subsonicAdminApi.login(loginForm.value);
    currentUser.value = res.username;
    view.value = "admin";
    toast.success(t("subsonic.admin.loginSuccess", "登录成功"));
    loginForm.value = { username: "", password: "" };
    await loadAdminData();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "登录失败");
  } finally {
    loginBusy.value = false;
  }
};

const handleLogout = async (): Promise<void> => {
  try {
    await subsonicAdminApi.logout();
    toast.success(t("subsonic.admin.loggedOut", "已注销"));
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "注销失败");
  }
};

/* ---- 用户管理 ---- */
const addDialogOpen = ref(false);
const newUser = ref({ username: "", password: "", isAdmin: false });
const adding = ref(false);

const handleAddUser = async (): Promise<void> => {
  if (!newUser.value.username || !newUser.value.password) {
    toast.warning(t("subsonic.admin.userRequired", "请填写用户名和密码"));
    return;
  }
  if (newUser.value.password.length < 6) {
    toast.warning(t("subsonic.admin.passwordTooShort", "密码至少 6 位"));
    return;
  }
  adding.value = true;
  try {
    await subsonicAdminApi.createUser(newUser.value);
    toast.success(t("subsonic.admin.userCreated", "用户已创建"));
    addDialogOpen.value = false;
    newUser.value = { username: "", password: "", isAdmin: false };
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "创建失败");
  } finally {
    adding.value = false;
  }
};

const removingId = ref<string | null>(null);
const removeDialogOpen = ref(false);
const confirmRemoveUser = (id: string): void => {
  removingId.value = id;
  removeDialogOpen.value = true;
};
const handleRemoveUser = async (): Promise<void> => {
  if (!removingId.value) return;
  try {
    await subsonicAdminApi.deleteUser(removingId.value);
    toast.success(t("subsonic.admin.userDeleted", "用户已删除"));
    removeDialogOpen.value = false;
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "删除失败");
  }
};

/* ---- 改密 ---- */
const pwdDialogOpen = ref(false);
const pwdTarget = ref<SubsonicServiceUser | null>(null);
const newPwd = ref("");
const changingPwd = ref(false);
const openPwdDialog = (u: SubsonicServiceUser): void => {
  pwdTarget.value = u;
  newPwd.value = "";
  pwdDialogOpen.value = true;
};
const handleChangePwd = async (): Promise<void> => {
  if (!pwdTarget.value || !newPwd.value) return;
  if (newPwd.value.length < 6) {
    toast.warning(t("subsonic.admin.passwordTooShort", "密码至少 6 位"));
    return;
  }
  changingPwd.value = true;
  try {
    await subsonicAdminApi.updateUser(pwdTarget.value.id, { password: newPwd.value });
    toast.success(t("subsonic.admin.passwordChanged", "密码已更新"));
    pwdDialogOpen.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "更新失败");
  } finally {
    changingPwd.value = false;
  }
};

/* ---- 切换管理员 ---- */
const toggleAdmin = async (u: SubsonicServiceUser): Promise<void> => {
  try {
    await subsonicAdminApi.updateUser(u.id, { isAdmin: !u.isAdmin });
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "更新失败");
  }
};

/* ---- 分享删除 ---- */
const removingShareId = ref<string | null>(null);
const removeShareOpen = ref(false);
const confirmRemoveShare = (id: string): void => {
  removingShareId.value = id;
  removeShareOpen.value = true;
};
const handleRemoveShare = async (): Promise<void> => {
  if (!removingShareId.value) return;
  try {
    await subsonicAdminApi.deleteShare(removingShareId.value);
    toast.success(t("subsonic.admin.shareDeleted", "分享已删除"));
    removeShareOpen.value = false;
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "删除失败");
  }
};

/* ---- 复制端点 ---- */
const copyEndpoint = async (): Promise<void> => {
  if (!status.value) return;
  try {
    await navigator.clipboard.writeText(status.value.endpoint);
    toast.success(t("common.copied", "已复制"));
  } catch {
    toast.warning(t("common.copyFailed", "复制失败"));
  }
};

const formatDate = (ts: number): string => new Date(ts).toLocaleString();

/* ---- Go 后端开关 ---- */
const goBusy = ref(false);
const toggleGoBackend = async (): Promise<void> => {
  goBusy.value = true;
  try {
    if (status.value?.goBackend.running) {
      await subsonicAdminApi.stopGoBackend();
      toast.success("Go 后端已停止");
    } else {
      await subsonicAdminApi.startGoBackend();
      toast.success("Go 后端已启动");
    }
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "操作失败");
  } finally {
    goBusy.value = false;
  }
};
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- 加载中 -->
    <div v-if="view === 'loading'" class="py-8 text-center text-on-surface-variant/60 text-sm">
      <SLoading class="mx-auto mb-2" />
      {{ t("common.loading", "加载中...") }}
    </div>

    <!-- 首次设置 -->
    <div v-else-if="view === 'setup'" class="rounded-xl bg-on-surface/4 p-5 max-w-md mx-auto w-full">
      <div class="flex items-center gap-2 mb-1">
        <IconLucideShieldCheck class="size-5 text-primary" />
        <span class="text-base font-medium">{{ t("subsonic.admin.setupTitle", "初始化管理员") }}</span>
      </div>
      <p class="text-xs text-on-surface-variant/70 mb-4 leading-relaxed">
        {{ t("subsonic.admin.setupHint", "首次使用需设置一个管理员账户，用于管理 Subsonic 流媒体服务。此账户同时可用于 Subsonic 客户端登录。") }}
      </p>
      <div class="flex flex-col gap-3">
        <SInput
          v-model="setupForm.username"
          :placeholder="t('subsonic.admin.username', '用户名')"
          spellcheck="false"
        />
        <SInput
          v-model="setupForm.password"
          type="password"
          :placeholder="t('subsonic.admin.password', '密码（至少 6 位）')"
          spellcheck="false"
        />
        <SInput
          v-model="setupForm.confirm"
          type="password"
          :placeholder="t('subsonic.admin.confirmPassword', '确认密码')"
          spellcheck="false"
        />
        <SButton variant="secondary" type="primary" :loading="setupBusy" block @click="handleSetup">
          {{ t("subsonic.admin.setupAction", "创建管理员") }}
        </SButton>
      </div>
    </div>

    <!-- 登录 -->
    <div v-else-if="view === 'login'" class="rounded-xl bg-on-surface/4 p-5 max-w-md mx-auto w-full">
      <div class="flex items-center gap-2 mb-1">
        <IconLucideLock class="size-5 text-primary" />
        <span class="text-base font-medium">{{ t("subsonic.admin.loginTitle", "管理员登录") }}</span>
      </div>
      <p class="text-xs text-on-surface-variant/70 mb-4 leading-relaxed">
        {{ t("subsonic.admin.loginHint", "使用管理员账户登录以管理 Subsonic 服务。") }}
      </p>
      <div class="flex flex-col gap-3">
        <SInput
          v-model="loginForm.username"
          :placeholder="t('subsonic.admin.username', '用户名')"
          spellcheck="false"
          @keyup.enter="handleLogin"
        />
        <SInput
          v-model="loginForm.password"
          type="password"
          :placeholder="t('subsonic.admin.password', '密码')"
          spellcheck="false"
          @keyup.enter="handleLogin"
        />
        <SButton variant="secondary" type="primary" :loading="loginBusy" block @click="handleLogin">
          {{ t("common.login", "登录") }}
        </SButton>
      </div>
    </div>

    <!-- 管理界面 -->
    <template v-else>
      <!-- 服务状态卡片 -->
      <div class="rounded-xl bg-on-surface/4 p-4">
        <div class="flex items-center gap-2 mb-3">
          <IconLucideServer class="size-5 text-primary" />
          <span class="text-base font-medium">{{ t("subsonic.admin.serviceTitle", "Subsonic 流媒体服务") }}</span>
          <span class="ml-auto text-xs text-on-surface-variant/50">{{ t("common.version", "版本") }} {{ status?.apiVersion }}</span>
          <SButton variant="ghost" size="small" :title="t('common.logout', '注销')" @click="handleLogout">
            <template #icon><IconLucideLogOut class="size-4" /></template>
          </SButton>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <div class="text-on-surface-variant text-xs mb-1">{{ t("subsonic.admin.endpoint", "服务器地址") }}</div>
            <div class="flex items-center gap-1.5 font-mono text-xs break-all">
              <span class="text-on-surface">{{ status?.endpoint ?? "—" }}</span>
              <SButton v-if="status" variant="ghost" size="small" :title="t('common.copy', '复制')" @click="copyEndpoint">
                <template #icon><IconLucideCopy class="size-3.5" /></template>
              </SButton>
            </div>
          </div>
          <div>
            <div class="text-on-surface-variant text-xs mb-1">{{ t("subsonic.admin.apiVersion", "API 版本") }}</div>
            <div class="text-on-surface">{{ status?.apiVersion ?? "—" }}</div>
          </div>
          <div>
            <div class="text-on-surface-variant text-xs mb-1">{{ t("subsonic.admin.userCount", "用户数") }}</div>
            <div class="text-on-surface">{{ status?.userCount ?? 0 }}</div>
          </div>
        </div>
        <div class="mt-3 pt-3 border-t border-on-surface/8 text-xs text-on-surface-variant/70 leading-relaxed">
          {{ t("subsonic.admin.connectHint", "在 Subsonic 客户端（Ultrasonic / playSub 等）的「服务器地址」字段填入上方地址（无需追加 /rest），再输入用户名密码即可连接。") }}
        </div>
      </div>

      <!-- Go 后端 -->
      <div>
        <div class="flex items-center gap-2 mb-2">
          <IconLucideServer class="size-4 text-on-surface-variant" />
          <span class="text-sm font-medium">Go Subsonic 后端</span>
          <div class="ml-auto flex items-center gap-2">
            <div v-if="status?.goBackend" class="flex items-center gap-1.5 text-xs">
              <span
                class="size-2 rounded-full"
                :class="status.goBackend.running ? 'bg-success' : 'bg-on-surface/20'"
              />
              <span
                class="text-on-surface-variant/70"
                :class="status.goBackend.running ? 'text-success' : ''"
              >
                {{ status.goBackend.running ? t("common.running", "运行中") : t("common.stopped", "已停止") }}
              </span>
            </div>
            <SButton
              variant="secondary"
              size="small"
              :loading="goBusy"
              :type="status?.goBackend?.running ? 'error' : 'primary'"
              @click="toggleGoBackend"
            >
              {{ status?.goBackend?.running ? t("common.stop", "停止") : t("common.start", "启动") }}
            </SButton>
          </div>
        </div>
        <div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-on-surface/4">
          <div class="flex-1 min-w-0">
            <div class="text-sm text-on-surface">Go Subsonic 提供完整 Subsonic 协议实现</div>
            <div class="text-xs text-on-surface-variant/60 mt-0.5">
              {{ status?.goBackend?.running
                ? `PID ${status.goBackend.pid} · ${formatDate(status.goBackend.startTime)} 启动`
                : "未运行，点击上方按钮启动" }}
            </div>
          </div>
        </div>
      </div>

      <!-- 用户管理 -->
      <div>
        <div class="flex items-center gap-2 mb-2">
          <IconLucideUsers class="size-4 text-on-surface-variant" />
          <span class="text-sm font-medium">{{ t("subsonic.admin.users", "用户管理") }}</span>
          <SButton class="ml-auto" variant="secondary" size="small" @click="addDialogOpen = true">
            <template #icon><IconLucidePlus class="size-4" /></template>
            {{ t("common.add", "添加") }}
          </SButton>
        </div>
        <div class="flex flex-col gap-1.5">
          <div
            v-for="u in users"
            :key="u.id"
            class="flex items-center gap-3 px-3 py-2 rounded-lg bg-on-surface/4"
          >
            <component
              :is="u.isAdmin ? IconLucideShieldCheck : IconLucideShield"
              class="size-4 shrink-0"
              :class="u.isAdmin ? 'text-primary' : 'text-on-surface-variant'"
            />
            <div class="flex-1 min-w-0">
              <div class="text-sm text-on-surface truncate">{{ u.username }}</div>
              <div class="text-xs text-on-surface-variant/60">{{ formatDate(u.createdAt) }}</div>
            </div>
            <SButton
              variant="secondary"
              size="small"
              :type="u.isAdmin ? 'primary' : 'default'"
              @click="toggleAdmin(u)"
            >
              {{ u.isAdmin ? t("subsonic.admin.admin", "管理员") : t("subsonic.admin.user", "普通用户") }}
            </SButton>
            <SButton variant="secondary" size="small" @click="openPwdDialog(u)">
              <template #icon><IconLucideKey class="size-4" /></template>
            </SButton>
            <SButton variant="secondary" size="small" type="error" @click="confirmRemoveUser(u.id)">
              <template #icon><IconLucideTrash2 class="size-4" /></template>
            </SButton>
          </div>
          <div v-if="users.length === 0" class="py-4 text-center text-on-surface-variant/50 text-sm">
            {{ t("subsonic.admin.noUsers", "暂无用户，请添加") }}
          </div>
        </div>
      </div>

      <!-- 分享管理 -->
      <div>
        <div class="flex items-center gap-2 mb-2">
          <IconLucideShare2 class="size-4 text-on-surface-variant" />
          <span class="text-sm font-medium">{{ t("subsonic.admin.shares", "分享管理") }}</span>
        </div>
        <div class="flex flex-col gap-1.5">
          <div
            v-for="s in shares"
            :key="s.id"
            class="flex items-center gap-3 px-3 py-2 rounded-lg bg-on-surface/4"
          >
            <IconLucideShare2 class="size-4 text-on-surface-variant shrink-0" />
            <div class="flex-1 min-w-0">
              <div class="text-sm text-on-surface truncate">{{ s.name }}</div>
              <div class="text-xs text-on-surface-variant/60 truncate font-mono">{{ s.url }}</div>
              <div class="text-xs text-on-surface-variant/50 mt-0.5">
                {{ s.owner }} · {{ s.trackCount }} {{ t("subsonic.admin.tracks", "首") }} · {{ t("subsonic.admin.visits", "访问") }} {{ s.visitCount }}
              </div>
            </div>
            <a :href="s.url" target="_blank" class="shrink-0 text-primary hover:opacity-70">
              <IconLucideExternalLink class="size-4" />
            </a>
            <SButton variant="secondary" size="small" type="error" @click="confirmRemoveShare(s.id)">
              <template #icon><IconLucideTrash2 class="size-4" /></template>
            </SButton>
          </div>
          <div v-if="shares.length === 0" class="py-4 text-center text-on-surface-variant/50 text-sm">
            {{ t("subsonic.admin.noShares", "暂无分享") }}
          </div>
        </div>
      </div>
    </template>

    <!-- 添加用户对话框 -->
    <SDialog v-model:open="addDialogOpen" :title="t('subsonic.admin.addUser', '添加用户')">
      <div class="flex flex-col gap-3">
        <SInput
          v-model="newUser.username"
          :placeholder="t('subsonic.admin.username', '用户名')"
          spellcheck="false"
        />
        <SInput
          v-model="newUser.password"
          type="password"
          :placeholder="t('subsonic.admin.password', '密码（至少 6 位）')"
          spellcheck="false"
        />
        <div class="flex items-center justify-between">
          <span class="text-sm text-on-surface-variant">{{ t("subsonic.admin.isAdmin", "管理员") }}</span>
          <SSwitch v-model="newUser.isAdmin" />
        </div>
      </div>
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">{{ t("common.cancel", "取消") }}</SButton>
        <SButton variant="secondary" type="primary" :loading="adding" @click="handleAddUser">{{ t("common.confirm", "确定") }}</SButton>
      </template>
    </SDialog>

    <!-- 改密对话框 -->
    <SDialog v-model:open="pwdDialogOpen" :title="t('subsonic.admin.changePassword', '修改密码')">
      <div class="text-sm text-on-surface-variant mb-2">{{ pwdTarget?.username }}</div>
      <SInput
        v-model="newPwd"
        type="password"
        :placeholder="t('subsonic.admin.newPassword', '新密码（至少 6 位）')"
        spellcheck="false"
      />
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">{{ t("common.cancel", "取消") }}</SButton>
        <SButton variant="secondary" type="primary" :loading="changingPwd" @click="handleChangePwd">{{ t("common.confirm", "确定") }}</SButton>
      </template>
    </SDialog>

    <!-- 删除用户确认 -->
    <SDialog v-model:open="removeDialogOpen" :title="t('subsonic.admin.removeUser', '删除用户')">
      <p class="text-sm text-on-surface-variant">{{ t("subsonic.admin.removeUserConfirm", "确认删除该用户？相关收藏与播放列表将一并清除。") }}</p>
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">{{ t("common.cancel", "取消") }}</SButton>
        <SButton variant="secondary" type="error" @click="handleRemoveUser">{{ t("common.confirm", "确定") }}</SButton>
      </template>
    </SDialog>

    <!-- 删除分享确认 -->
    <SDialog v-model:open="removeShareOpen" :title="t('subsonic.admin.removeShare', '删除分享')">
      <p class="text-sm text-on-surface-variant">{{ t("subsonic.admin.removeShareConfirm", "确认删除该分享链接？") }}</p>
      <template #footer="{ close }">
        <SButton variant="secondary" @click="close">{{ t("common.cancel", "取消") }}</SButton>
        <SButton variant="secondary" type="error" @click="handleRemoveShare">{{ t("common.confirm", "确定") }}</SButton>
      </template>
    </SDialog>
  </div>
</template>
