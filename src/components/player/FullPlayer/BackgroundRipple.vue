<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

export interface BackgroundRippleProps {
  album?: string;
  playing?: boolean;
  rippleSpeed?: number;
}

const props = withDefaults(defineProps<BackgroundRippleProps>(), {
  album: "",
  playing: true,
  rippleSpeed: 3,
});

const canvasRef = ref<HTMLCanvasElement | null>(null);
const canvasReady = ref(false);

// ── Ripple simulation (shared by both backends) ──────────────

const MAX_RIPPLES = 48;
const RIPPLE_LIFETIME = 6.0;
const MEAN_INTERVAL = 0.18;
const RENDER_SCALE = 0.55;
const TRANSITION_MS = 700;

interface Ripple {
  x: number;
  y: number;
  birth: number;
  speed: number;
  strength: number;
  seed: number;
}

const ripples: Ripple[] = [];
let nextSpawn = 0;
let randomState = 0x51f15e;

const random = (): number => {
  randomState = (randomState * 1664525 + 1013904223) >>> 0;
  return randomState / 0x100000000;
};

const nextInterval = (): number =>
  -MEAN_INTERVAL * Math.log(1 - Math.min(random(), 0.999999));

const createRipple = (birth: number): Ripple => ({
  x: random(),
  y: random(),
  birth,
  speed: 0.12 + random() * 0.1,
  strength: 0.8 + random() * 0.8,
  seed: random() * Math.PI * 2,
});

const updateRipples = (time: number) => {
  while (time >= nextSpawn) {
    if (ripples.length < MAX_RIPPLES) ripples.push(createRipple(time));
    nextSpawn += nextInterval();
  }
  for (let i = ripples.length - 1; i >= 0; i--) {
    if (time - ripples[i].birth > RIPPLE_LIFETIME) ripples.splice(i, 1);
  }
};

// ── Transition state (shared) ─────────────────────────────────

let transitioning = false;
let transitionStartTime = 0;
let mixFactor = 1;

const beginTransition = () => {
  transitioning = true;
  transitionStartTime = performance.now();
  mixFactor = 0;
};

const tickTransition = () => {
  if (!transitioning) return;
  const elapsed = performance.now() - transitionStartTime;
  mixFactor = Math.min(elapsed / TRANSITION_MS, 1);
  if (mixFactor >= 1) transitioning = false;
};

// ── Image loading (shared) ───────────────────────────────────

let currentImage: HTMLImageElement | null = null;
let pendingAlbumSrc = "";

// ── Render backend interface ─────────────────────────────────

interface RenderBackend {
  start(): void;
  stop(): void;
  loadImage(src: string): void;
  resize(): void;
  destroy(): void;
}

let backend: RenderBackend | null = null;
let resizeObserver: ResizeObserver | null = null;

// ══════════════════════════════════════════════════════════════
//  WebGPU backend
// ══════════════════════════════════════════════════════════════

/* eslint-disable @typescript-eslint/no-explicit-any */
type GPUDeviceT = any;
type GPUCanvasContextT = any;
type GPUBindGroupT = any;
type GPURenderPipelineT = any;
type GPUBufferT = any;
type GPUTextureT = any;
type GPUSamplerT = any;
type GPUShaderModuleT = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const wgslVertex = `
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
  }
  @vertex
  fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    let pos = array(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(1,1));
    var out: VertexOutput;
    out.position = vec4f(pos[idx], 0.0, 1.0);
    out.uv = pos[idx] * 0.5 + 0.5;
    return out;
  }
`;

const wgslFragment = (
  maxRipples: number,
  lifetime: number,
) => `
  const MAX_RIPPLES: u32 = ${maxRipples}u;
  const RIPPLE_LT: f32 = ${lifetime.toFixed(1)};

  struct Params {
    time: f32,
    mixFactor: f32,
    resX: f32,
    resY: f32,
    texW: f32,
    texH: f32,
  }

  @group(0) @binding(0) var<uniform> params: Params;
  @group(0) @binding(1) var<storage, read> positions: array<vec4f>;
  @group(0) @binding(2) var<storage, read> spawnData: array<vec4f>;
  @group(1) @binding(0) var currentTex: texture_2d<f32>;
  @group(1) @binding(1) var oldTex: texture_2d<f32>;
  @group(1) @binding(2) var samp: sampler;

  fn coverFit(uv: vec2f) -> vec2f {
    let ca = params.resX / params.resY;
    let ia = params.texW / params.texH;
    var r = uv;
    if (ca > ia) { r.y = (uv.y - 0.5) * (ia / ca) + 0.5; }
    else         { r.x = (uv.x - 0.5) * (ca / ia) + 0.5; }
    return clamp(r, vec2f(0.001), vec2f(0.999));
  }

  @fragment
  fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let aspect = vec2f(params.resX / params.resY, 1.0);
    var totalOffset: vec2f = vec2f(0.0);
    var light: f32 = 0.0;

    for (var i: u32 = 0u; i < MAX_RIPPLES; i = i + 1u) {
      let pos = positions[i];
      let dat = spawnData[i];
      let age = params.time - dat.x;
      if (age <= 0.0 || age > RIPPLE_LT) { continue; }
      let dc = length((uv - pos.xy) * aspect);
      let r = age * dat.y;
      let dw = dc - r;
      let band = exp(-abs(dw) * 48.0);
      let env = exp(-age * 0.75) * smoothstep(0.0, 0.12, age);
      let wave = sin(dw * 115.0 + dat.w) * band * env * dat.z;
      let dir = normalize((uv - pos.xy) * aspect + vec2f(0.0001));
      totalOffset += dir * wave * 0.015;
      light += wave;
    }

    let dstUv = coverFit(uv + totalOffset);
    let nc = textureSample(currentTex, samp, dstUv).rgb;
    let oc = textureSample(oldTex, samp, dstUv).rgb;
    var col = mix(oc, nc, clamp(params.mixFactor, 0.0, 1.0));
    col += vec3f(max(light, 0.0) * 0.14);
    col -= vec3f(max(-light, 0.0) * 0.09);
    return vec4f(col, 1.0);
  }
`;

const tryWebGPU = async (
  canvas: HTMLCanvasElement,
): Promise<RenderBackend | null> => {
  const gpu = (navigator as any).gpu;
  if (!gpu) return null;

  let adapter: any;
  let device: GPUDeviceT;
  try {
    adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    device = await adapter.requestDevice();
  } catch {
    return null;
  }

  const context = canvas.getContext("webgpu") as GPUCanvasContextT;
  if (!context) return null;

  const fmt = gpu.getPreferredCanvasFormat();
  context.configure({ device, format: fmt, alphaMode: "opaque" });

  // Shader modules
  const vertMod: GPUShaderModuleT = device.createShaderModule({
    code: wgslVertex,
  });
  const fragMod: GPUShaderModuleT = device.createShaderModule({
    code: wgslFragment(MAX_RIPPLES, RIPPLE_LIFETIME),
  });

  // Pipeline
  const pipeline: GPURenderPipelineT = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: vertMod, entryPoint: "vs_main" },
    fragment: {
      module: fragMod,
      entryPoint: "fs_main",
      targets: [{ format: fmt }],
    },
    primitive: { topology: "triangle-strip" },
  });

  // Buffers
  const uniformBuf: GPUBufferT = device.createBuffer({
    size: 64,
    usage: /* Uniform */ 0x0040 | /* CopyDst */ 0x0008,
  });
  const posBuf: GPUBufferT = device.createBuffer({
    size: MAX_RIPPLES * 16,
    usage: /* Storage */ 0x0080 | /* CopyDst */ 0x0008,
  });
  const dataBuf: GPUBufferT = device.createBuffer({
    size: MAX_RIPPLES * 16,
    usage: /* Storage */ 0x0080 | /* CopyDst */ 0x0008,
  });

  // Sampler
  const sampler: GPUSamplerT = device.createSampler({
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  // Helper: create a 1x1 dark fallback texture
  const makeFallbackTex = (): GPUTextureT => {
    const tex: GPUTextureT = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: /* TextureBinding */ 0x0002 | /* CopyDst */ 0x0008,
    });
    device.queue.writeTexture(
      { texture: tex, mipLevel: 0 },
      new Uint8Array([20, 20, 28, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );
    return tex;
  };

  let currentTex: GPUTextureT | null = makeFallbackTex();
  let oldTex: GPUTextureT | null = makeFallbackTex();

  // Bind group 0 (uniforms + storage)
  const bindGroup0Layout = pipeline.getBindGroupLayout(0);
  const bg0: GPUBindGroupT = device.createBindGroup({
    layout: bindGroup0Layout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuf } },
      { binding: 1, resource: { buffer: posBuf } },
      { binding: 2, resource: { buffer: dataBuf } },
    ],
  });

  // Bind group 1 (textures + sampler)
  const makeBg1 = (tex: GPUTextureT, old: GPUTextureT): GPUBindGroupT => {
    const bg1Layout = pipeline.getBindGroupLayout(1);
    return device.createBindGroup({
      layout: bg1Layout,
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: old.createView() },
        { binding: 2, resource: sampler },
      ],
    });
  };

  let bg1 = makeBg1(currentTex, oldTex);
  let animFrame = 0;
  let running = false;
  let startedAt = 0;

  const uploadTexture = async (img: HTMLImageElement) => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < 2 || h < 2) return;

    // Create new texture
    const newTex: GPUTextureT = device.createTexture({
      size: [w, h],
      format: "rgba8unorm",
      usage: /* TextureBinding */ 0x0002 | /* CopyDst */ 0x0008 | /* RenderAttachment */ 0x0010,
    });

    // Copy image data
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.canvas.width = w;
    ctx.canvas.height = h;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    device.queue.writeTexture(
      { texture: newTex, mipLevel: 0 },
      imageData.data,
      { bytesPerRow: w * 4, rowsPerImage: h },
      [w, h],
    );

    // Transition: old texture rotates
    if (canvasReady.value && currentTex) {
      if (oldTex) {
        // We could destroy oldTex here but the GPU might still use it this frame
        // Schedule destroy for later or keep it as the "old" during transition
      }
      oldTex = currentTex;
    }
    currentTex = newTex;
    bg1 = makeBg1(currentTex, oldTex);

    if (!canvasReady.value) {
      canvasReady.value = true;
    }
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * RENDER_SCALE));
    const h = Math.max(1, Math.round(rect.height * RENDER_SCALE));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    context.configure({ device, format: fmt, alphaMode: "opaque" });
  };

  const render = (timestamp: number) => {
    if (!running) return;

    const speed = props.playing ? Math.max(props.rippleSpeed, 0.1) / 3 : 0.04;
    const time = ((timestamp - startedAt) / 1000) * speed;
    updateRipples(time);
    tickTransition();

    // Write buffers
    const posArr = new Float32Array(MAX_RIPPLES * 4);
    const dataArr = new Float32Array(MAX_RIPPLES * 4);
    ripples.forEach((r, i) => {
      posArr[i * 4] = r.x;
      posArr[i * 4 + 1] = r.y;
      dataArr[i * 4] = r.birth;
      dataArr[i * 4 + 1] = r.speed;
      dataArr[i * 4 + 2] = r.strength;
      dataArr[i * 4 + 3] = r.seed;
    });
    device.queue.writeBuffer(posBuf, 0, posArr);
    device.queue.writeBuffer(dataBuf, 0, dataArr);

    const texW = currentImage?.naturalWidth || currentImage?.width || 1;
    const texH = currentImage?.naturalHeight || currentImage?.height || 1;
    const uniArr = new Float32Array([
      time,
      transitioning ? mixFactor : 1,
      canvas.width,
      canvas.height,
      texW,
      texH,
      0,
      0,
    ]);
    device.queue.writeBuffer(uniformBuf, 0, uniArr);

    // Render pass
    const view = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.08, g: 0.08, b: 0.11, a: 1.0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg0);
    pass.setBindGroup(1, bg1);
    pass.draw(4);
    pass.end();
    device.queue.submit([encoder.finish()]);

    animFrame = requestAnimationFrame(render);
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      startedAt = performance.now();
      randomState = 0x51f15e;
      ripples.length = 0;
      nextSpawn = random() * MEAN_INTERVAL;
      animFrame = requestAnimationFrame(render);
    },
    stop: () => {
      running = false;
      if (animFrame) cancelAnimationFrame(animFrame);
      animFrame = 0;
    },
    loadImage: (src: string) => {
      if (!src) return;
      pendingAlbumSrc = src;
      if (currentImage && canvasReady.value && !transitioning) {
        beginTransition();
      }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (pendingAlbumSrc !== src) return;
        currentImage = img;
        uploadTexture(img);
      };
      img.src = src;
    },
    resize,
    destroy: () => {
      running = false;
      if (animFrame) cancelAnimationFrame(animFrame);
      try {
        if (currentTex) currentTex.destroy();
        if (oldTex) oldTex.destroy();
        uniformBuf.destroy();
        posBuf.destroy();
        dataBuf.destroy();
        device.destroy();
      } catch {
        // ignore destroy errors
      }
    },
  };
};

// ══════════════════════════════════════════════════════════════
//  WebGL backend (fallback)
// ══════════════════════════════════════════════════════════════

const glslVertex = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const glslFragment = (maxRipples: number, lifetime: number) => `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform sampler2D uOldTexture;
  uniform vec2 uResolution;
  uniform vec2 uTextureSize;
  uniform float uTime;
  uniform float uMixFactor;
  uniform vec4 uRipples[${maxRipples}];
  uniform vec4 uRippleData[${maxRipples}];

  vec2 coverUv(vec2 uv) {
    float ca = uResolution.x / uResolution.y;
    float ia = uTextureSize.x / uTextureSize.y;
    vec2 r = uv;
    if (ca > ia) { r.y = (uv.y - 0.5) * (ia / ca) + 0.5; }
    else         { r.x = (uv.x - 0.5) * (ca / ia) + 0.5; }
    return clamp(r, 0.001, 0.999);
  }

  void main() {
    vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
    vec2 totalOffset = vec2(0.0);
    float light = 0.0;
    for (int i = 0; i < ${maxRipples}; i++) {
      vec4 pos = uRipples[i];
      vec4 dat = uRippleData[i];
      float age = uTime - dat.x;
      if (age <= 0.0 || age > ${lifetime.toFixed(1)}) continue;
      float dc = length((vUv - pos.xy) * aspect);
      float r = age * dat.y;
      float dw = dc - r;
      float band = exp(-abs(dw) * 48.0);
      float env = exp(-age * 0.75) * smoothstep(0.0, 0.12, age);
      float wave = sin(dw * 115.0 + dat.w) * band * env * dat.z;
      vec2 dir = normalize((vUv - pos.xy) * aspect + vec2(0.0001));
      totalOffset += dir * wave * 0.015;
      light += wave;
    }
    vec2 dstUv = coverUv(vUv + totalOffset);
    vec3 nc = texture2D(uTexture, dstUv).rgb;
    vec3 oc = texture2D(uOldTexture, dstUv).rgb;
    vec3 col = mix(oc, nc, clamp(uMixFactor, 0.0, 1.0));
    col += vec3(max(light, 0.0) * 0.14);
    col -= vec3(max(-light, 0.0) * 0.09);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const tryWebGL = (canvas: HTMLCanvasElement): RenderBackend | null => {
  const gl: any = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  const compileShader = (type: number, src: string) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s);
      return null;
    }
    return s;
  };

  const vs = compileShader(gl.VERTEX_SHADER, glslVertex);
  const fs = compileShader(gl.FRAGMENT_SHADER, glslFragment(MAX_RIPPLES, RIPPLE_LIFETIME));
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

  // Fallback texture helper
  const writeDarkTex = (tex: any) => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([20, 20, 28]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  };

  let texture: any = gl.createTexture();
  let oldTexture: any = gl.createTexture();
  writeDarkTex(texture);
  writeDarkTex(oldTexture);

  const posBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const posLoc = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(program, "uTime");
  const uRipple = gl.getUniformLocation(program, "uRipples[0]");
  const uData = gl.getUniformLocation(program, "uRippleData[0]");
  const uRes = gl.getUniformLocation(program, "uResolution");
  const uTexSize = gl.getUniformLocation(program, "uTextureSize");
  const uTex = gl.getUniformLocation(program, "uTexture");
  const uOldTex = gl.getUniformLocation(program, "uOldTexture");
  const uMix = gl.getUniformLocation(program, "uMixFactor");

  let animFrame = 0;
  let running = false;
  let startedAt = 0;

  const uploadTexture = (img: HTMLImageElement) => {
    if (!texture) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!canvasReady.value) {
      canvasReady.value = true;
    }
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * RENDER_SCALE));
    const h = Math.max(1, Math.round(rect.height * RENDER_SCALE));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  };

  const render = (timestamp: number) => {
    if (!running) return;
    const speed = props.playing ? Math.max(props.rippleSpeed, 0.1) / 3 : 0.04;
    const time = ((timestamp - startedAt) / 1000) * speed;
    updateRipples(time);
    tickTransition();

    if (transitioning && oldTexture) {
      if (mixFactor >= 1) {
        if (oldTexture) gl.deleteTexture(oldTexture);
        oldTexture = null;
      }
    }

    const rippleValues = new Float32Array(MAX_RIPPLES * 4);
    const dataValues = new Float32Array(MAX_RIPPLES * 4);
    ripples.forEach((r, i) => {
      rippleValues[i * 4] = r.x;
      rippleValues[i * 4 + 1] = r.y;
      dataValues[i * 4] = r.birth;
      dataValues[i * 4 + 1] = r.speed;
      dataValues[i * 4 + 2] = r.strength;
      dataValues[i * 4 + 3] = r.seed;
    });

    const texW = currentImage?.naturalWidth || currentImage?.width || 1;
    const texH = currentImage?.naturalHeight || currentImage?.height || 1;

    gl.useProgram(program);
    gl.uniform1f(uTime, time);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform2f(uTexSize, texW, texH);
    gl.uniform1f(uMix, transitioning ? mixFactor : 1);
    gl.uniform4fv(uRipple, rippleValues);
    gl.uniform4fv(uData, dataValues);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, oldTexture || texture);
    gl.uniform1i(uOldTex, 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    animFrame = requestAnimationFrame(render);
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      startedAt = performance.now();
      randomState = 0x51f15e;
      ripples.length = 0;
      nextSpawn = random() * MEAN_INTERVAL;
      animFrame = requestAnimationFrame(render);
    },
    stop: () => {
      running = false;
      if (animFrame) cancelAnimationFrame(animFrame);
      animFrame = 0;
    },
    loadImage: (src: string) => {
      if (!src) return;
      pendingAlbumSrc = src;
      if (currentImage && canvasReady.value) {
        oldTexture = texture;
        texture = gl.createTexture();
        writeDarkTex(texture);
        writeDarkTex(oldTexture);
        beginTransition();
      }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (pendingAlbumSrc !== src) return;
        currentImage = img;
        uploadTexture(img);
      };
      img.src = src;
    },
    resize,
    destroy: () => {
      running = false;
      if (animFrame) cancelAnimationFrame(animFrame);
      if (oldTexture) gl.deleteTexture(oldTexture);
      if (texture) gl.deleteTexture(texture);
      if (posBuffer) gl.deleteBuffer(posBuffer);
      if (program) gl.deleteProgram(program);
    },
  };
};

// ══════════════════════════════════════════════════════════════
//  Init & lifecycle
// ══════════════════════════════════════════════════════════════

const init = async () => {
  const canvas = canvasRef.value;
  if (!canvas) return;

  // Try WebGPU first
  const gpuBackend = await tryWebGPU(canvas);
  if (gpuBackend) {
    backend = gpuBackend;
  } else {
    const glBackend = tryWebGL(canvas);
    if (glBackend) {
      backend = glBackend;
    } else {
      return;
    }
  }

  backend.resize();
  backend.loadImage(props.album);
  backend.start();
};

const resize = () => backend?.resize();

watch(
  () => props.album,
  (album) => backend?.loadImage(album),
);

watch(
  () => props.playing,
  (playing) => {
    if (playing) backend?.start();
    else backend?.stop();
  },
);

onMounted(() => {
  nextTick(() => {
    init();
    if (canvasRef.value) {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvasRef.value);
    }
  });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  backend?.destroy();
  backend = null;
  currentImage = null;
});
</script>

<template>
  <canvas
    ref="canvasRef"
    class="ripple-canvas"
    :class="{ 'canvas-ready': canvasReady }"
    aria-hidden="true"
  />
</template>

<style scoped>
.ripple-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s ease;
  filter: blur(10px) saturate(1.3);
}

.ripple-canvas.canvas-ready {
  opacity: 1;
}
</style>
