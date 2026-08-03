/**
 * window.api.player mock：HTML5 <audio> + Web Audio API
 *
 * 对齐 Rust AudioPlayer 事件协议：
 *   stateChanged → play/pause/ended
 *   position     → timeupdate（5Hz 轮询）
 *   fftData      → AnalyserNode.getByteFrequencyData
 *   outputStalled→ stalled/waiting
 */
import type {
  PlayerApi,
  PlayerEvent,
  PlayerStatus,
  LoadOptions,
  LoadResult,
  IpcResponse,
  AudioDevice,
  FftData,
} from "@shared/types/player";
import { registerLoudnessWorklet } from "./loudnessWorklet";
import { subscribeServerEvent, type ServerEvent } from "./ws";
import { setFftFrame } from "@/services/playback";

const ok = <T>(data?: T): IpcResponse<T> => ({ success: true, data });
const fail = (error: string): IpcResponse<never> => ({ success: false, error });

/** 服务端转码模式：启用后用 /api/audio/stream 替代 /api/music/stream */
let serverTranscodeMode = false;

/** 本地路径 → 流媒体 URL（依赖 load 时下发的 meta.id） */
const toStreamUrl = (id: string): string =>
  serverTranscodeMode
    ? `/api/audio/stream/${encodeURIComponent(id)}`
    : `/api/music/stream/${encodeURIComponent(id)}`;

/** cache:// 协议 → HTTP 静态路径 */
const normalizeSource = (source: string, meta?: { source?: string; id?: string }): string => {
  if (source.startsWith("cache://")) return source.replace(/^cache:\/\//, "/api/cache/");
  if (/^https?:\/\//i.test(source) || source.startsWith("blob:") || source.startsWith("data:")) {
    return source;
  }
  // 本地文件路径：浏览器无法直访，改走服务端流媒体端点
  if (meta?.source === "local" && meta?.id) return toStreamUrl(meta.id);
  return source;
};

class WebAudioPlayer implements PlayerApi {
  private audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private merger: ChannelMergerNode | null = null;
  private normalizerNode: AudioWorkletNode | null = null;
  private normalizerReady = false;
  private preamp: GainNode | null = null;
  private volumeGain: GainNode | null = null;
  private eqNodes: BiquadFilterNode[] = [];
  private eqEnabled = false;
  private fftEnabled = false;

  /** 服务端转码模式下 WebSocket FFT 推送的取消订阅函数 */
  private unsubServerFft: (() => void) | null = null;
  /** 非转码模式下本地 AnalyserNode FFT 推送的 RAF id */
  private _fftRafId = 0;

  private fadeMs = 0;
  private normalization = false;
  private pitchSync = true;
  private speed = 1;
  private pitch = 0;
  private volume = 1;
  private selectedDevice: string | null = null;
  private listeners = new Set<(e: PlayerEvent) => void>();
  private rafId = 0;
  private lastPosEmit = 0;
  private fadeTimer = 0;

  /** 当前曲目已知时长（ms），从 load 元数据获取，用于流式播放时 audio.duration=Infinity 的降级 */
  private trackDurationMs = 0;

  /** 最近一次 load 的 source + options，用于热切换 serverTranscode 模式 */
  private lastSource = "";
  private lastOptions: LoadOptions | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.crossOrigin = "anonymous";
    this.bindAudioEvents();
  }

  /** 懒创建 AudioContext + 节点图（首次 load/play 时） */
  private ensureGraph(): void {
    if (this.ctx) return;
    // 服务端转码模式下不做任何浏览器端 DSP：纯 <audio> 播放，O(1) 开销
    if (serverTranscodeMode) return;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctor();
    this.sourceNode = this.ctx.createMediaElementSource(this.audio);
    this.preamp = this.ctx.createGain();
    this.volumeGain = this.ctx.createGain();
    this.volumeGain.gain.value = this.volume;
    // 立体声 FFT：splitter 分出左右声道各接一个 AnalyserNode，merger 合回立体声输出
    this.analyserL = this.ctx.createAnalyser();
    this.analyserL.fftSize = 1024;
    this.analyserR = this.ctx.createAnalyser();
    this.analyserR.fftSize = 1024;
    this.splitter = this.ctx.createChannelSplitter(2);
    this.merger = this.ctx.createChannelMerger(2);
    // 10 频段 EQ 链
    const freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    this.eqNodes = freqs.map((f) => {
      const n = this.ctx!.createBiquadFilter();
      n.type = "peaking";
      n.frequency.value = f;
      n.Q.value = 1;
      n.gain.value = 0;
      return n;
    });
    // 连接：source → preamp → [eq / normalization] → volume → splitter → [L/R analyser] → merger → destination
    const node: AudioNode = this.sourceNode;
    node.connect(this.preamp);
    this.volumeGain.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this.analyserL.connect(this.merger, 0, 0);
    this.analyserR.connect(this.merger, 0, 1);
    this.merger.connect(this.ctx.destination);
    this.applyProcessingChain();
    // 异步加载响度归一化 worklet（不阻塞播放路径）
    if (this.normalization && !this.normalizerReady) {
      this.ensureNormalizer().catch((err) =>
        console.warn("[WebAudioPlayer] 响度归一化 worklet 加载失败:", err),
      );
    }
  }

  /** 根据 EQ / 响度归一化状态重建处理链 */
  private applyProcessingChain(): void {
    if (
      !this.ctx ||
      !this.preamp ||
      !this.volumeGain ||
      this.eqNodes.length === 0
    ) {
      return;
    }
    this.preamp.disconnect();
    for (const eq of this.eqNodes) eq.disconnect();
    if (this.normalizerNode) {
      try { this.normalizerNode.disconnect(); } catch { /* 未连接时忽略 */ }
    }
    let node: AudioNode = this.preamp;
    if (this.eqEnabled) {
      node.connect(this.eqNodes[0]);
      for (let i = 0; i < this.eqNodes.length - 1; i++) {
        this.eqNodes[i].connect(this.eqNodes[i + 1]);
      }
      node = this.eqNodes[this.eqNodes.length - 1];
    }
    if (this.normalization && this.normalizerNode) {
      node.connect(this.normalizerNode);
      node = this.normalizerNode;
    }
    node.connect(this.volumeGain);
  }

  /** 异步初始化响度归一化 AudioWorklet */
  private async ensureNormalizer(): Promise<void> {
    if (this.normalizerReady || !this.ctx) return;
    try {
      await registerLoudnessWorklet(this.ctx);
      this.normalizerNode = new AudioWorkletNode(this.ctx, "loudness-normalizer");
      this.normalizerReady = true;
      // 切歌时发 reset
      this.normalizerNode.port.onmessage = (e) => {
        if (e.data?.type === "gainUpdate") {
          // 保留将来用于向 UI 报告当前增益
        }
      };
      // 将新节点接入已有链
      this.applyProcessingChain();
    } catch (err) {
      this.normalizerReady = false;
      throw err;
    }
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = 0;
    }
  }

  private applyGain(target: number, rampMs = 0): void {
    const safe = Math.max(0, Math.min(1.5, target));
    if (this.volumeGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.volumeGain.gain.cancelScheduledValues(now);
      if (rampMs > 0) {
        this.volumeGain.gain.setValueAtTime(this.volumeGain.gain.value, now);
        this.volumeGain.gain.linearRampToValueAtTime(safe, now + rampMs / 1000);
      } else {
        this.volumeGain.gain.setTargetAtTime(safe, now, 0.01);
      }
    } else {
      this.audio.volume = Math.max(0, Math.min(1, safe));
    }
  }

  private emit = (e: PlayerEvent): void => {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        console.error("[player mock] onEvent callback error", err);
      }
    }
  };

  private bindAudioEvents(): void {
    const a = this.audio;
    // 不 emit play/pause 事件：events.ts handleEvent 的 case "play"/"pause"
    // 会调用 play()/pause() → window.api.player.play()/pause() 导致无限递归。
    // 播放状态由 events.ts 中显式调用 play()/pause() 时管理。
    a.addEventListener("ended", () => this.emit({ type: "ended" }));
    a.addEventListener("error", () => this.emit({ type: "sourceError" }));
    a.addEventListener("stalled", () => this.emit({ type: "status", data: this.snapshot() }));
    a.addEventListener("waiting", () => this.emit({ type: "status", data: this.snapshot() }));
    a.addEventListener("canplay", () => this.emit({ type: "status", data: this.snapshot() }));
    // 位置推送：raf 轮询，约 5Hz
    const tick = (): void => {
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - this.lastPosEmit < 200) return;
      this.lastPosEmit = now;
      if (!a.paused && !a.ended) {
        this.emit({
          type: "position",
          data: { position: this.safePosition(), duration: this.safeDuration() },
        });
      }
    };
    tick();
  }

  private snapshot(): PlayerStatus {
    return {
      state: this.audio.paused
        ? this.audio.ended
          ? "stopped"
          : "idle"
        : "playing",
      position: this.safePosition(),
      duration: this.safeDuration(),
      volume: this.volume,
      isFinished: this.audio.ended,
    };
  }

  /** 安全获取当前进度（ms），流式场景下 currentTime 可能为 NaN */
  private safePosition(): number {
    const t = this.audio.currentTime;
    return Number.isFinite(t) && t >= 0 ? t * 1000 : this.audio.ended ? this.trackDurationMs : 0;
  }

  /** 安全获取时长（ms），流式场景下 duration 可能为 Infinity/NaN */
  private safeDuration(): number {
    const d = this.audio.duration;
    return Number.isFinite(d) && d > 0 ? d * 1000 : this.trackDurationMs;
  }

  async load(source: string, options?: LoadOptions): Promise<IpcResponse<LoadResult>> {
    try {
      this.lastSource = source;
      this.lastOptions = options ?? null;
      // 卸载上一首的解码缓存
      this.unloadSource();
      const url = normalizeSource(source, options?.meta);
      // 服务端转码 + FFT 启用时，在流 URL 中追加 fft=1 参数，
      // 使服务端为 C 引擎开启 --fft --fft-fd 4，FFT 数据通过 WebSocket 推送
      const fftUrl =
        serverTranscodeMode && this.fftEnabled
          ? url + (url.includes("?") ? "&" : "?") + "fft=1"
          : url;
      this.ensureGraph();
      if (this.ctx?.state === "suspended") void this.ctx.resume();
      // 切歌：重置响度归一化分析器
      if (this.normalizerNode?.port) {
        this.normalizerNode.port.postMessage({ type: "reset" });
      }
      this.audio.src = fftUrl;
      this.audio.dataset.coverUrl = options?.meta?.cover ?? "";
      // unloadSource() 断开了 sourceNode；先断开再重连保证幂等
      if (this.sourceNode && this.preamp) {
        this.sourceNode.disconnect();
        this.sourceNode.connect(this.preamp);
      }
      this.audio.load();
      // 从元数据获取已知时长（OGG/Opus 流式场景下 audio.duration=Infinity）
      this.trackDurationMs = options?.meta?.duration ?? 0;
      // 等待 metadata 就绪
      await new Promise<void>((resolve, reject) => {
        const onMeta = (): void => {
          a.removeEventListener("loadedmetadata", onMeta);
          a.removeEventListener("error", onErr);
          resolve();
        };
        const onErr = (): void => {
          a.removeEventListener("loadedmetadata", onMeta);
          a.removeEventListener("error", onErr);
          reject(new Error("audio load failed"));
        };
        const a = this.audio;
        a.addEventListener("loadedmetadata", onMeta, { once: true });
        a.addEventListener("error", onErr, { once: true });
      });
      const meta = options?.meta;
      const duration = this.audio.duration * 1000;
      const result: LoadResult = {
        detail: {
          quality: meta?.quality ?? {
            sampleRate: 44100,
            channels: 2,
            bitsPerSample: 16,
            bitRate: 128000,
            codec: "unknown",
          },
          externalLyrics: [],
        },
        mediaInfo: {
          duration: Number.isFinite(duration) ? duration : meta?.duration ?? 0,
          cover: meta?.cover,
          quality: meta?.quality,
        },
      };
      if (options?.autoPlay) void this.play();
      return ok(result);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "load failed");
    }
  }

  async play(): Promise<IpcResponse> {
    try {
      this.ensureGraph();
      if (this.ctx?.state === "suspended") await this.ctx.resume();
      this.clearFadeTimer();
      if (this.fadeMs > 0) this.applyGain(0);
      await this.audio.play();
      this.applyGain(this.volume, this.fadeMs);
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : "play failed");
    }
  }

  async pause(): Promise<IpcResponse> {
    this.clearFadeTimer();
    if (this.fadeMs > 0 && !this.audio.paused) {
      this.applyGain(0, this.fadeMs);
      this.fadeTimer = window.setTimeout(() => {
        this.audio.pause();
        this.fadeTimer = 0;
      }, this.fadeMs);
      return ok();
    }
    this.audio.pause();
    return ok();
  }

  async stop(): Promise<IpcResponse> {
    this.clearFadeTimer();
    if (this.fadeMs > 0 && !this.audio.paused) {
      this.applyGain(0, this.fadeMs);
      this.fadeTimer = window.setTimeout(() => {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.unloadSource();
        this.fadeTimer = 0;
      }, this.fadeMs);
      return ok();
    }
    this.audio.pause();
    this.audio.currentTime = 0;
    this.unloadSource();
    return ok();
  }

  /** 卸载音频源以释放浏览器端解码缓存并取消 HTTP 请求 */
  private unloadSource(): void {
    // 断开 Web Audio 图中 MediaElementSourceNode 的输出连接。
    // 仅 src="" 不够：sourceNode 通过内部连接锚住了 <audio>
    // 的解码缓冲，disconnect() 才能让 V8 回收这部分内存。
    this.sourceNode?.disconnect();
    // 设置 src="" 取消正在进行的网络请求（触发服务端 abort → SIGTERM）
    this.audio.src = "";
    this.audio.load();
  }

  async seek(positionMs: number): Promise<IpcResponse> {
    this.audio.currentTime = positionMs / 1000;
    this.emit({ type: "seek", data: { position: positionMs } });
    return ok();
  }

  async setVolume(volume: number): Promise<IpcResponse> {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyGain(this.volume);
    return ok();
  }

  async getVolume(): Promise<IpcResponse<number>> {
    return ok(this.volume);
  }

  async getStatus(): Promise<IpcResponse<PlayerStatus>> {
    return ok(this.snapshot());
  }

  async setFftEnabled(enabled: boolean): Promise<IpcResponse> {
    this.fftEnabled = enabled;
    if (serverTranscodeMode) {
      if (enabled) {
        this.subscribeServerFft();
      } else {
        this.unsubscribeServerFft();
      }
    } else {
      if (enabled) {
        this.startLocalFft();
      } else {
        this.stopLocalFft();
      }
    }
    return ok();
  }

  /** 非转码模式：RAF 循环读取 AnalyserNode，直接推送到 playback（无 IPC 轮询） */
  private startLocalFft(): void {
    if (this._fftRafId) return;
    const tick = (): void => {
      if (!this._fftRafId) return;
      this._fftRafId = requestAnimationFrame(tick);
      if (!this.fftEnabled || !this.analyserL || !this.analyserR) return;
      const arrL = new Uint8Array(this.analyserL.frequencyBinCount);
      const arrR = new Uint8Array(this.analyserR.frequencyBinCount);
      this.analyserL.getByteFrequencyData(arrL);
      this.analyserR.getByteFrequencyData(arrR);
      // getByteFrequencyData 返回 0-255，归一化到 0-1
      const left = new Array(arrL.length);
      const right = new Array(arrR.length);
      for (let i = 0; i < arrL.length; i++) {
        left[i] = arrL[i] / 255;
        right[i] = arrR[i] / 255;
      }
      setFftFrame(left, right);
    };
    this._fftRafId = requestAnimationFrame(tick);
  }

  private stopLocalFft(): void {
    if (this._fftRafId) {
      cancelAnimationFrame(this._fftRafId);
      this._fftRafId = 0;
    }
    setFftFrame([], []);
  }

  /** 服务端转码模式下订阅 WebSocket FFT 事件，直接推送到 playback */
  private subscribeServerFft(): void {
    if (this.unsubServerFft) return;
    this.unsubServerFft = subscribeServerEvent((event: ServerEvent) => {
      if (event.type !== "audio:fft" || !event.data) return;
      // C 引擎发送的 JSON: {"type":"fft","bins":128,"ldata":[-60,...],"rdata":[-55,...]}
      const payload = event.data as { bins: number; ldata: number[]; rdata: number[] };
      // 兼容旧格式（data 字段单声道回退）
      const legacy = event.data as { bins: number; data: number[] };
      if (payload.ldata && payload.rdata && payload.ldata.length > 0 && payload.rdata.length > 0) {
        // C 引擎 FFT 数据已是 dB 值（-60~0），但前端期望 0~1 幅度值
        // dB 转线性: mag = 10^(dB/20)
        const bins = Math.min(payload.ldata.length, payload.rdata.length);
        const ldata = new Array(bins);
        const rdata = new Array(bins);
        for (let i = 0; i < bins; i++) {
          ldata[i] = Math.pow(10, payload.ldata[i] / 20);
          rdata[i] = Math.pow(10, payload.rdata[i] / 20);
        }
        setFftFrame(ldata, rdata);
      } else if (legacy.data && legacy.data.length > 0) {
        const fftArr = Array.from(legacy.data);
        setFftFrame(fftArr, fftArr);
      }
    });
  }

  private unsubscribeServerFft(): void {
    if (this.unsubServerFft) {
      this.unsubServerFft();
      this.unsubServerFft = null;
    }
  }

  async getFftData(): Promise<IpcResponse<FftData>> {
    if (!this.fftEnabled || !this.analyserL || !this.analyserR) return ok({ ldata: [], rdata: [] });
    const arrL = new Uint8Array(this.analyserL.frequencyBinCount);
    const arrR = new Uint8Array(this.analyserR.frequencyBinCount);
    this.analyserL.getByteFrequencyData(arrL);
    this.analyserR.getByteFrequencyData(arrR);
    const ldata = new Array(arrL.length);
    const rdata = new Array(arrR.length);
    for (let i = 0; i < arrL.length; i++) {
      ldata[i] = arrL[i] / 255;
      rdata[i] = arrR[i] / 255;
    }
    return ok({ ldata, rdata });
  }

  async setFadeDuration(ms: number): Promise<IpcResponse> {
    this.fadeMs = ms;
    return ok();
  }

  async getFadeDuration(): Promise<IpcResponse<number>> {
    return ok(this.fadeMs);
  }

  async getCoverRaw(): Promise<IpcResponse<string | null>> {
    // 封面已在 meta.cover（/api/music/cover/:id），fetch 转 dataURL
    const coverUrl = this.audio.dataset.coverUrl;
    if (!coverUrl) return ok(null);
    try {
      const res = await fetch(coverUrl);
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(new Error("read failed"));
        fr.readAsDataURL(blob);
      });
      return ok(dataUrl);
    } catch {
      return ok(null);
    }
  }

  async readLyricFile(filePath: string): Promise<IpcResponse<string>> {
    try {
      const url = filePath.startsWith("http")
        ? filePath
        : filePath.replace(/^cache:\/\//, "/api/cache/");
      const res = await fetch(url);
      const text = await res.text();
      return ok(text);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "read failed");
    }
  }

  async reinit(): Promise<IpcResponse> {
    // 释放旧图重建（切换输出设备等场景）
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {}
      this.ctx = null;
      this.sourceNode = null;
      this.analyserL = null;
      this.analyserR = null;
      this.splitter = null;
      this.merger = null;
      this.preamp = null;
      this.volumeGain = null;
      this.eqNodes = [];
      this.normalizerNode = null;
      this.normalizerReady = false;
      this.ensureGraph();
    }
    return ok();
  }

  async setNormalizationEnabled(enabled: boolean): Promise<IpcResponse> {
    this.normalization = enabled;
    if (enabled && !this.normalizerReady) {
      try {
        await this.ensureNormalizer();
      } catch (err) {
        console.warn("[WebAudioPlayer] 响度归一化 worklet 加载失败:", err);
        this.normalization = false;
      }
    }
    this.applyProcessingChain();
    return ok();
  }

  async setServerTranscode(enabled: boolean): Promise<IpcResponse> {
    const changed = serverTranscodeMode !== enabled;
    serverTranscodeMode = enabled;
    console.log(`[WebAudioPlayer] 服务端转码 ${enabled ? "启用" : "禁用"}`);
    // 切换到纯音频播放模式时，释放已有的 Web Audio 图
    // 下次播放时将自动重建（enabled=false）或跳过（enabled=true）
    if (enabled && this.ctx) {
      // 先暂停音频，再关闭 AudioContext
      // createMediaElementSource 会永久捕获 <audio> 输出，
      // ctx.close() 后必须强制重置 src="" 让浏览器释放路由
      this.audio.pause();
      try { await this.ctx.close(); } catch { /* 忽略 */ }
      this.ctx = null;
      this.sourceNode = null;
      this.analyserL = null;
      this.analyserR = null;
      this.splitter = null;
      this.merger = null;
      this.preamp = null;
      this.volumeGain = null;
      this.eqNodes = [];
      this.normalizerNode = null;
      this.normalizerReady = false;
      // 强制重置 <audio> 释放 MediaElementAudioSourceNode 路由
      this.audio.src = "";
      this.audio.load();
      // 等待重置生效后再加载新源
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 热切换时同步 FFT 推送源
    if (changed) {
      if (enabled) {
        // 切换到转码模式：本地 RAF → WebSocket
        this.stopLocalFft();
        if (this.fftEnabled) this.subscribeServerFft();
      } else {
        // 切换到非转码模式：WebSocket → 本地 RAF
        this.unsubscribeServerFft();
        if (this.fftEnabled) this.startLocalFft();
      }
    }
    // 热切换：如果有正在播放的曲目，用新模式重新加载
    if (changed && this.lastSource) {
      const wasPlaying = !this.audio.paused;
      const pos = this.audio.currentTime;
      try {
        await this.load(this.lastSource, this.lastOptions ?? undefined);
        if (wasPlaying && Number.isFinite(pos) && pos > 0) {
          this.audio.currentTime = pos;
          void this.play();
        }
      } catch (err) {
        console.warn("[WebAudioPlayer] 切换转码模式重载失败:", err);
      }
    }
    return ok();
  }

  async setEqualizerEnabled(enabled: boolean): Promise<IpcResponse> {
    this.eqEnabled = enabled;
    this.applyProcessingChain();
    return ok();
  }

  async setEqualizerBands(gainsDb: number[]): Promise<IpcResponse> {
    if (this.ctx) {
      gainsDb.forEach((g, i) => {
        if (this.eqNodes[i]) {
          this.eqNodes[i].gain.setTargetAtTime(g, this.ctx!.currentTime, 0.01);
        }
      });
    }
    return ok();
  }

  async setPreampGain(preampDb: number): Promise<IpcResponse> {
    if (this.preamp && this.ctx) {
      this.preamp.gain.setTargetAtTime(Math.pow(10, preampDb / 20), this.ctx.currentTime, 0.01);
    }
    return ok();
  }

  async setSpeed(speed: number): Promise<IpcResponse> {
    this.speed = Math.max(0.5, Math.min(2, speed));
    this.audio.playbackRate = this.speed;
    this.audio.preservesPitch = this.pitchSync;
    return ok();
  }

  async setPitch(semitones: number): Promise<IpcResponse> {
    this.pitch = Math.max(-12, Math.min(12, semitones));
    // HTMLAudio 无原生音调偏移，近似用 detune（MediaElementSource 不支持 detune），
    // 这里仅记录，实际音调变化需 Playable 接口；保留接口对齐
    return ok();
  }

  async setPitchSync(sync: boolean): Promise<IpcResponse> {
    this.pitchSync = sync;
    this.audio.preservesPitch = sync;
    return ok();
  }

  async getOutputDevices(): Promise<IpcResponse<AudioDevice[]>> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return ok(
        devices
          .filter((d) => d.kind === "audiooutput")
          .map((d) => ({ name: d.label || d.deviceId, isDefault: d.deviceId === "default" })),
      );
    } catch {
      return ok([]);
    }
  }

  async getDefaultDeviceName(): Promise<IpcResponse<string | null>> {
    return ok(null);
  }

  async setOutputDevice(deviceName: string | null): Promise<IpcResponse> {
    this.selectedDevice = deviceName;
    const sink = deviceName ?? "";
    if (typeof this.audio.setSinkId === "function") {
      try {
        await (this.audio as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(
          sink,
        );
      } catch {
        /* 部分浏览器不支持 */
      }
    }
    return ok();
  }

  async getSelectedDeviceName(): Promise<IpcResponse<string | null>> {
    return ok(this.selectedDevice);
  }

  syncPlayMode(): void {
    /* Web 版无托盘，no-op */
  }

  dispatch(): void {
    /* 广播事件无外部消费者，no-op */
  }

  syncLikeState(): void {
    /* Web 版无托盘菜单，no-op */
  }

  onEvent(callback: (event: PlayerEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}

export const playerApi: PlayerApi = new WebAudioPlayer();
