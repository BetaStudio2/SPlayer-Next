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
let animationFrame = 0;
let running = false;
let startedAt = 0;
let gl: WebGLRenderingContext | null = null;
let program: WebGLProgram | null = null;
let texture: WebGLTexture | null = null;
let oldTexture: WebGLTexture | null = null;
let image: HTMLImageElement | null = null;
let canvasReady = ref(false);
let transitioning = false;
let transitionStartTime = 0;
let mixFactor = 1;
let resizeObserver: ResizeObserver | null = null;
let positionBuffer: WebGLBuffer | null = null;
let timeLocation: WebGLUniformLocation | null = null;
let rippleLocation: WebGLUniformLocation | null = null;
let dataLocation: WebGLUniformLocation | null = null;
let resolutionLocation: WebGLUniformLocation | null = null;
let textureSizeLocation: WebGLUniformLocation | null = null;
let textureLocation: WebGLUniformLocation | null = null;
let oldTextureLocation: WebGLUniformLocation | null = null;
let mixFactorLocation: WebGLUniformLocation | null = null;

const vertexShaderSource = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform sampler2D uOldTexture;
  uniform vec2 uResolution;
  uniform vec2 uTextureSize;
  uniform float uTime;
  uniform float uMixFactor;
  uniform vec4 uRipples[${MAX_RIPPLES}];
  uniform vec4 uRippleData[${MAX_RIPPLES}];

  vec2 coverUv(vec2 uv) {
    float canvasAspect = uResolution.x / uResolution.y;
    float imageAspect = uTextureSize.x / uTextureSize.y;
    vec2 result = uv;
    if (canvasAspect > imageAspect) {
      result.y = (uv.y - 0.5) * (imageAspect / canvasAspect) + 0.5;
    } else {
      result.x = (uv.x - 0.5) * (canvasAspect / imageAspect) + 0.5;
    }
    return clamp(result, 0.001, 0.999);
  }

  void main() {
    vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
    vec2 totalOffset = vec2(0.0);
    float light = 0.0;

    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
      vec4 ripple = uRipples[i];
      vec4 data = uRippleData[i];
      float age = uTime - data.x;
      if (age < 0.0 || age > ${RIPPLE_LIFETIME.toFixed(1)}) continue;
      float distanceFromCenter = length((vUv - ripple.xy) * aspect);
      float radius = age * data.y;
      float distanceToWave = distanceFromCenter - radius;
      float band = exp(-abs(distanceToWave) * 48.0);
      float envelope = exp(-age * 0.75) * smoothstep(0.0, 0.12, age);
      float wave = sin(distanceToWave * 115.0 + data.w) * band * envelope * data.z;
      vec2 direction = normalize((vUv - ripple.xy) * aspect + vec2(0.0001));
      totalOffset += direction * wave * 0.006;
      light += wave;
    }

    vec2 uv = coverUv(vUv + totalOffset);
    vec3 newColor = texture2D(uTexture, uv).rgb;
    vec3 oldColor = texture2D(uOldTexture, uv).rgb;
    vec3 color = mix(oldColor, newColor, clamp(uMixFactor, 0.0, 1.0));
    color += vec3(max(light, 0.0) * 0.08);
    color -= vec3(max(-light, 0.0) * 0.05);
    gl_FragColor = vec4(color, 1.0);
  }
`;

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
  strength: 0.55 + random() * 0.55,
  seed: random() * Math.PI * 2,
});

const createShader = (type: number, source: string): WebGLShader | null => {
  if (!gl) return null;
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

const createProgram = (): WebGLProgram | null => {
  if (!gl) return null;
  const vertex = createShader(gl.VERTEX_SHADER, vertexShaderSource);
  const fragment = createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertex || !fragment) return null;
  const nextProgram = gl.createProgram();
  if (!nextProgram) return null;
  gl.attachShader(nextProgram, vertex);
  gl.attachShader(nextProgram, fragment);
  gl.linkProgram(nextProgram);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(nextProgram, gl.LINK_STATUS)) {
    gl.deleteProgram(nextProgram);
    return null;
  }
  return nextProgram;
};

const writeFallbackTexture = (target: WebGLTexture | null) => {
  if (!gl || !target) return;
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGB,
    1,
    1,
    0,
    gl.RGB,
    gl.UNSIGNED_BYTE,
    new Uint8Array([20, 20, 28]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
};

const uploadTexture = () => {
  if (!gl || !texture || !image || !image.complete) return;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (canvasReady.value) {
    transitioning = true;
    transitionStartTime = performance.now();
    mixFactor = 0;
  } else {
    canvasReady.value = true;
    mixFactor = 1;
  }
};

const loadImage = (src: string) => {
  if (!src || !gl) return;
  if (image && canvasReady.value) {
    oldTexture = texture;
    writeFallbackTexture(oldTexture);
  }
  texture = gl.createTexture();
  writeFallbackTexture(texture);
  const nextImage = new Image();
  nextImage.onload = () => {
    if (image !== nextImage) return;
    uploadTexture();
  };
  nextImage.src = src;
  image = nextImage;
};

const resize = () => {
  const canvas = canvasRef.value;
  if (!canvas || !gl) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * RENDER_SCALE));
  const height = Math.max(1, Math.round(rect.height * RENDER_SCALE));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  gl.viewport(0, 0, width, height);
};

const render = (timestamp: number) => {
  if (!running || !gl || !program) return;
  const speed = props.playing ? Math.max(props.rippleSpeed, 0.1) / 3 : 0.04;
  const time = ((timestamp - startedAt) / 1000) * speed;

  while (time >= nextSpawn) {
    if (ripples.length < MAX_RIPPLES) ripples.push(createRipple(time));
    nextSpawn += nextInterval();
  }

  for (let i = ripples.length - 1; i >= 0; i--) {
    if (time - ripples[i].birth > RIPPLE_LIFETIME) ripples.splice(i, 1);
  }

  if (transitioning && oldTexture) {
    const elapsed = performance.now() - transitionStartTime;
    mixFactor = Math.min(elapsed / TRANSITION_MS, 1);
    if (mixFactor >= 1) {
      transitioning = false;
      if (oldTexture) gl.deleteTexture(oldTexture);
      oldTexture = null;
    }
  }

  const rippleValues = new Float32Array(MAX_RIPPLES * 4);
  const dataValues = new Float32Array(MAX_RIPPLES * 4);
  ripples.forEach((ripple, index) => {
    const offset = index * 4;
    rippleValues[offset] = ripple.x;
    rippleValues[offset + 1] = ripple.y;
    dataValues[offset] = ripple.birth;
    dataValues[offset + 1] = ripple.speed;
    dataValues[offset + 2] = ripple.strength;
    dataValues[offset + 3] = ripple.seed;
  });

  const texW = image?.naturalWidth || image?.width || 1;
  const texH = image?.naturalHeight || image?.height || 1;

  gl.useProgram(program);
  gl.uniform1f(timeLocation, time);
  gl.uniform2f(
    resolutionLocation,
    canvasRef.value?.width || 1,
    canvasRef.value?.height || 1,
  );
  gl.uniform2f(textureSizeLocation, texW, texH);
  gl.uniform1f(mixFactorLocation, mixFactor);
  gl.uniform4fv(rippleLocation, rippleValues);
  gl.uniform4fv(dataLocation, dataValues);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(textureLocation, 0);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, oldTexture || texture);
  gl.uniform1i(oldTextureLocation, 1);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  animationFrame = requestAnimationFrame(render);
};

const start = () => {
  if (running || !gl || !program) return;
  running = true;
  startedAt = performance.now();
  randomState = 0x51f15e;
  ripples.length = 0;
  nextSpawn = random() * MEAN_INTERVAL;
  animationFrame = requestAnimationFrame(render);
};

const stop = () => {
  running = false;
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
};

const init = () => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
  });
  if (!gl) return;
  program = createProgram();
  texture = gl.createTexture();
  oldTexture = gl.createTexture();
  positionBuffer = gl.createBuffer();
  if (!program || !texture || !oldTexture || !positionBuffer) return;

  writeFallbackTexture(texture);
  writeFallbackTexture(oldTexture);

  gl.useProgram(program);
  const positionLocation = gl.getAttribLocation(program, "aPosition");
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  timeLocation = gl.getUniformLocation(program, "uTime");
  rippleLocation = gl.getUniformLocation(program, "uRipples[0]");
  dataLocation = gl.getUniformLocation(program, "uRippleData[0]");
  resolutionLocation = gl.getUniformLocation(program, "uResolution");
  textureSizeLocation = gl.getUniformLocation(program, "uTextureSize");
  textureLocation = gl.getUniformLocation(program, "uTexture");
  oldTextureLocation = gl.getUniformLocation(program, "uOldTexture");
  mixFactorLocation = gl.getUniformLocation(program, "uMixFactor");
  resize();
  loadImage(props.album);
  start();
};

watch(
  () => props.album,
  (album) => loadImage(album),
);

watch(
  () => props.playing,
  (playing) => {
    if (playing) start();
    else stop();
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
  stop();
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (gl) {
    if (oldTexture) gl.deleteTexture(oldTexture);
    if (texture) gl.deleteTexture(texture);
    if (positionBuffer) gl.deleteBuffer(positionBuffer);
    if (program) gl.deleteProgram(program);
  }
  image = null;
  gl = null;
  texture = null;
  oldTexture = null;
  positionBuffer = null;
  program = null;
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
