/**
 * FFT 频谱推送的引用计数
 *
 * 频谱可视化与流体背景都依赖 FFT 数据。
 * 首个消费者申请时开启推送，最后一个释放时才关闭，
 * 避免一个组件卸载时误关掉另一个仍在使用的推送。
 *
 * Electron 模式：主进程 IPC push → setFftFrame
 * Web 模式：WebAudioPlayer 本地 RAF 读取 AnalyserNode → setFftFrame
 * 两种模式均通过 window.api.player.setFftEnabled 控制后端推送开关。
 */

/** 当前持有 FFT 推送的消费者数量 */
let refCount = 0;

/** 申请 FFT 推送；首个消费者负责开启后端推送 */
export const acquireFft = (): void => {
  refCount++;
  if (refCount === 1) {
    window.api.player.setFftEnabled(true);
  }
};

/** 释放 FFT 推送；最后一个消费者关闭后端推送 */
export const releaseFft = (): void => {
  if (refCount === 0) return;
  refCount--;
  if (refCount === 0) {
    window.api.player.setFftEnabled(false);
  }
};
