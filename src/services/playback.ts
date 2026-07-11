/**
 * 非响应式播放时间源
 *
 * 歌词高亮、频谱等高频组件直接读取，不经过 Vue 响应式系统
 * 进度条等低频 UI 仍从 status store 读取
 *
 * 主进程推送位置时调用 setCurrentTime 更新
 * 高频组件在自己的 RAF 循环中调用 getCurrentTime 读取
 */

/** 当前播放位置（毫秒） */
let currentTimeMs = 0;

/** 总时长（毫秒） */
let totalDurationMs = 0;

/** 上次同步的本地时间戳 */
let lastSyncAt = 0;

/** 是否正在播放 */
let playing = false;

/** 是否正在 seek（暂停插值，固定在 seek 目标位置） */
let seeking = false;

/**
 * 播放态切换后，下一帧权威位置强制重锚
 */
let resyncPending = false;

/**
 * 当前播放速度倍率（用于把墙钟插值换算到源时间）
 * 变速时 1ms 墙钟 = speed ms 源时间
 */
let speed = 1.0;

/**
 * 主进程推送位置与本地插值之间的容差（毫秒）
 * 偏差小于此值视作 IPC 延迟 / 解码抖动，保留插值避免可见跳跃；
 * 大于此值视作真实跳变（漏拦截的 seek、跳曲等），直接采用推送值
 */
const SYNC_TOLERANCE_MS = 1000;

/**
 * 小幅偏差时向推送位置收敛的比例
 */
const SYNC_CONVERGE_RATE = 0.2;

/** 获取当前播放位置（毫秒），播放中按 speed 插值，seek 中冻结 */
export const getCurrentTime = (): number => {
  if (!playing || seeking) return currentTimeMs;
  const elapsed = performance.now() - lastSyncAt;
  return Math.min(currentTimeMs + elapsed * speed, totalDurationMs);
};

/** 获取总时长（毫秒） */
export const getDuration = (): number => totalDurationMs;

/** 是否正在播放 */
export const isPlaying = (): boolean => playing;

/**
 * 同步主进程推送的位置
 * @param ms 主进程推送的位置（毫秒）
 * @param options.force 强制采用 ms（如 load 重置、seek 跳转）
 * @returns 实际生效的位置
 */
export const setCurrentTime = (ms: number, options: { force?: boolean } = {}): number => {
  if (!options.force && !resyncPending && !seeking && totalDurationMs > 0) {
    const interpolated = getCurrentTime();
    if (Math.abs(interpolated - ms) < SYNC_TOLERANCE_MS) {
      currentTimeMs = interpolated + (ms - interpolated) * SYNC_CONVERGE_RATE;
      lastSyncAt = performance.now();
      return currentTimeMs;
    }
  }
  resyncPending = false;
  currentTimeMs = ms;
  lastSyncAt = performance.now();
  return ms;
};

/** 进入 seek 状态，冻结插值 */
export const setSeeking = (value: boolean): void => {
  seeking = value;
  if (!value) lastSyncAt = performance.now();
};

/** 同步时长 */
export const setDuration = (ms: number): void => {
  totalDurationMs = ms;
};

/** 同步播放状态 */
export const setPlaying = (value: boolean): void => {
  if (value === playing) return;
  // 暂停：冻结到当前可见位置
  if (!value) currentTimeMs = getCurrentTime();
  lastSyncAt = performance.now();
  playing = value;
  // 切换后用引擎随后上报的真实位置重锚
  resyncPending = true;
};

/**
 * 同步播放速度
 * @param value - 播放速度
 *
 * 切速度瞬间，先按旧 speed 把可见位置推到 now，再切，避免视觉跳变
 */
export const setSpeed = (value: number): void => {
  if (value === speed) return;
  if (playing && !seeking) {
    currentTimeMs = getCurrentTime();
    lastSyncAt = performance.now();
  }
  speed = value;
};

/** 最新 FFT 频谱帧（单声道，L+R 均值） */
let fftFrame: number[] = [];
/** 立体声 FFT 帧（左右声道分离） */
let fftFrameLeft: number[] = [];
let fftFrameRight: number[] = [];

/** 主进程推送 FFT 数据时调用 */
export const setFftFrame = (data: number[]): void => {
  fftFrame = data;
};

/** RAF 循环读取最新频谱帧 */
export const getFftFrame = (): readonly number[] => fftFrame;

/** 主进程推送立体声 FFT 数据时调用 */
export const setFftFrameStereo = (left: number[], right: number[]): void => {
  fftFrameLeft = left;
  fftFrameRight = right;
};

/** RAF 循环读取最新立体声频谱帧 */
export const getFftFrameStereo = (): { left: readonly number[]; right: readonly number[] } => ({
  left: fftFrameLeft,
  right: fftFrameRight,
});

// ---------------------------------------------------------------------------
// Web 端 FFT 桥接：Electron 主进程通过 IPC push 调用 setFftFrame，
// 浏览器 Web 端轮询 WebAudioPlayer.getFftDataStereo() 同时获取 L/R 声道数据
// ---------------------------------------------------------------------------
let _fftPollRaf = 0;
let _fftPollActive = false;

export const startFftPolling = (): void => {
  if (_fftPollActive) return;
  _fftPollActive = true;
  const poll = async () => {
    if (!_fftPollActive) return;
    try {
      const res = await window.api.player.getFftDataStereo();
      if (res.success && res.data && res.data.left.length > 0) {
        // WebAudio getByteFrequencyData 返回 Uint8Array (0-255)，归一化到 0-1
        const { left, right } = res.data;
        const lNorm = new Array(left.length);
        const rNorm = new Array(right.length);
        const mono = new Array(left.length);
        for (let i = 0; i < left.length; i++) {
          lNorm[i] = left[i] / 255;
          rNorm[i] = right[i] / 255;
          mono[i] = (lNorm[i] + rNorm[i]) / 2;
        }
        fftFrameLeft = lNorm;
        fftFrameRight = rNorm;
        fftFrame = mono;
      }
    } catch { /* player 未初始化或 api 不可用 */ }
    _fftPollRaf = requestAnimationFrame(poll);
  };
  poll();
};

export const stopFftPolling = (): void => {
  _fftPollActive = false;
  if (_fftPollRaf) {
    cancelAnimationFrame(_fftPollRaf);
    _fftPollRaf = 0;
  }
  fftFrame = [];
  fftFrameLeft = [];
  fftFrameRight = [];
};

/** 重置位置/时长/播放标志 */
export const reset = (): void => {
  currentTimeMs = 0;
  totalDurationMs = 0;
  lastSyncAt = 0;
  playing = false;
  seeking = false;
  resyncPending = false;
};
