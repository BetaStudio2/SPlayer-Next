/**
 * 基于 RMS 的实时响度归一化 AudioWorkletProcessor
 *
 * 算法对齐 native/audio-engine/src/loudness.rs 的 LoudnessAnalyzer：
 * - 实时测量 RMS → 计算目标增益使响度收敛到 -14 dBFS (TARGET_RMS ≈ 0.2)
 * - 初始快速收敛 → 稳态平滑跟踪
 * - 可接收主线程消息设置固定增益（如 ReplayGain）
 *
 * 使用方式：
 *   await registerLoudnessWorklet(audioCtx);
 *   const node = new AudioWorkletNode(audioCtx, 'loudness-normalizer');
 */

// ─── 以下代码以字符串形式注入 AudioWorklet 线程 ─────────────────────────
const PROCESSOR_CODE = `
// 目标 RMS 响度（线性值），约 -14 dBFS
const TARGET_RMS = 0.2;

// 稳态 RMS 窗口时长（秒）
const WINDOW_DURATION_SECS = 0.4;

// 初始快速收敛窗口时长（秒）
const INITIAL_WINDOW_DURATION_SECS = 0.1;

// 初始快速收敛增益平滑因子
const INITIAL_SMOOTHING = 0.4;

// 稳态增益平滑因子
const NORMAL_SMOOTHING = 0.08;

// 最大增益上限（防止静音段放大噪声）
const MAX_GAIN = 3.0;

// 最小增益下限
const MIN_GAIN = 0.1;

// 初始快速收敛阶段的窗口数
const INITIAL_WINDOW_COUNT = 3;

class LoudnessNormalizer extends AudioWorkletProcessor {
  constructor() {
    super();
    this._sumSquares = 0;
    this._sampleCount = 0;
    this._currentGain = 1.0;
    this._windowsCompleted = 0;
    this._hasReplayGain = false;
    this._windowSize = 0;
    this._initialWindowSize = 0;
    this._sampleRate = sampleRate;

    this.port.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'setGain':
          // 固定增益模式（如 ReplayGain），跳过实时分析
          this._hasReplayGain = true;
          this._currentGain = msg.gain;
          break;
        case 'reset':
          // 切歌时重置分析状态
          this._hasReplayGain = false;
          this._currentGain = 1.0;
          this._sumSquares = 0;
          this._sampleCount = 0;
          this._windowsCompleted = 0;
          break;
        case 'setSampleRate':
          // 输出设备采样率变化时重算窗口
          this._sampleRate = msg.sampleRate;
          this._windowSize = 0;
          this._initialWindowSize = 0;
          break;
      }
    };
  }

  process(inputs, outputs) {
    const input = input[0];
    const output = output[0];
    if (!input || !output || input.length === 0 || output.length === 0) return true;

    const numChannels = input.length;
    const numFrames = input[0].length;

    // 首帧延迟初始化窗口大小（此时已知声道数，与 Rust 行为一致）
    if (this._windowSize === 0) {
      const samplesPerSec = this._sampleRate * numChannels;
      this._windowSize = Math.round(samplesPerSec * WINDOW_DURATION_SECS);
      this._initialWindowSize = Math.round(samplesPerSec * INITIAL_WINDOW_DURATION_SECS);
    }

    if (this._hasReplayGain) {
      // ReplayGain 模式：固定增益，不做实时分析
      for (let ch = 0; ch < numChannels; ch++) {
        const src = input[ch];
        const dst = output[ch];
        for (let i = 0; i < numFrames; i++) {
          dst[i] = src[i] * this._currentGain;
        }
      }
      return true;
    }

    for (let i = 0; i < numFrames; i++) {
      // 累加当前帧各声道的平方和（与 loudness.rs 的 interleaved 累加等价）
      for (let ch = 0; ch < numChannels; ch++) {
        const s = input[ch][i];
        this._sumSquares += s * s;
        this._sampleCount++;
      }

      // 应用当前增益到输出
      for (let ch = 0; ch < numChannels; ch++) {
        output[ch][i] = input[ch][i] * this._currentGain;
      }

      // 到达窗口边界时重新计算增益
      const isInitial = this._windowsCompleted < INITIAL_WINDOW_COUNT;
      const windowSize = isInitial ? this._initialWindowSize : this._windowSize;

      if (this._sampleCount >= windowSize) {
        const rms = Math.sqrt(this._sumSquares / this._sampleCount);

        if (rms > 1e-6) {
          const targetGain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, TARGET_RMS / rms));
          const smoothing = isInitial ? INITIAL_SMOOTHING : NORMAL_SMOOTHING;
          this._currentGain += smoothing * (targetGain - this._currentGain);
        }

        this._sumSquares = 0;
        this._sampleCount = 0;
        this._windowsCompleted++;
      }
    }

    return true;
  }
}

registerProcessor('loudness-normalizer', LoudnessNormalizer);
`;

/**
 * 在 AudioContext 上注册响度归一化 AudioWorklet
 * @param ctx - AudioContext 实例
 */
export const registerLoudnessWorklet = async (ctx: AudioContext): Promise<void> => {
  try {
    const blob = new Blob([PROCESSOR_CODE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("[loudness] 注册 AudioWorklet 失败，响度归一化不可用:", err);
    throw err;
  }
};
