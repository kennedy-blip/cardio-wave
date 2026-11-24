<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, defineAsyncComponent } from 'vue';
import HardwarePermissionGatekeeper from './components/HardwarePermissionGatekeeper.vue';
import PhonocardiogramStethoscopeLab from './components/PhonocardiogramStethoscopeLab.vue';
import SeismocardiogramTeiIndexDeck from './components/SeismocardiogramTeiIndexDeck.vue';
import PulseWaveVelocityArterialLab from './components/PulseWaveVelocityArterialLab.vue';
import OrthostaticPotsTiltProtocol from './components/OrthostaticPotsTiltProtocol.vue';
import CapillaryRefillPerfusionScanner from './components/CapillaryRefillPerfusionScanner.vue';
import ApkReleaseDownloadModal from './components/ApkReleaseDownloadModal.vue';
import PolyglotRuntimeInspectorModal from './components/PolyglotRuntimeInspectorModal.vue';
import bgFragSrc from './shaders/hemodynamicPulseBackground.glsl?raw';

const THEMES = [
  { id: 'obsidian', label: 'Cath-Lab Obsidian' },
  { id: 'daylight', label: 'Echo Daylight' },
  { id: 'amber', label: 'ICU Amber' },
  { id: 'eco', label: 'Eco-Glass' },
];

const ROLES = [
  { id: 'patient', label: 'Patient / Self-Screener' },
  { id: 'clinician', label: 'Cardiovascular Clinician' },
  { id: 'admin', label: 'Hemodynamic Systems Architect' },
];

const MODULES = [
  { id: 'pcg', label: 'PCG Stethoscope', icon: '🫀', component: PhonocardiogramStethoscopeLab },
  { id: 'scg', label: 'SCG / Tei Index', icon: '📈', component: SeismocardiogramTeiIndexDeck },
  { id: 'pwv', label: 'PWV / Arterial', icon: '〰️', component: PulseWaveVelocityArterialLab },
  { id: 'ortho', label: 'Orthostatic POTS', icon: '🧍', component: OrthostaticPotsTiltProtocol },
  { id: 'crt', label: 'qCRT Perfusion', icon: '🩸', component: CapillaryRefillPerfusionScanner },
];

const theme = ref('obsidian');
const role = ref('patient');
const viewport = ref('desktop');
const activeModule = ref('pcg');
const showApkModal = ref(false);
const showPolyglotModal = ref(false);
const hemoTelemetry = ref({ bpm: 72, pwv: 6.5, systolic: 0.6 });

const activeModuleDef = computed(() => MODULES.find((m) => m.id === activeModule.value) || MODULES[0]);
const modalOpen = computed(() => showApkModal.value || showPolyglotModal.value);

const themeIndex = computed(() => ({ obsidian: 0, daylight: 1, amber: 2, eco: 3 }[theme.value] ?? 0));

function setTheme(t) {
  theme.value = t;
  document.documentElement.setAttribute('data-theme', t === 'obsidian' ? '' : t);
  if (t === 'obsidian') document.documentElement.removeAttribute('data-theme');
}

function onTelemetry(payload) {
  if (!payload) return;
  if (payload.bpm) hemoTelemetry.value.bpm = payload.bpm;
  if (payload.pwv) hemoTelemetry.value.pwv = payload.pwv;
  if (typeof payload.systolic === 'number') hemoTelemetry.value.systolic = payload.systolic;
}

// ---- WebGL2 background ----
const bgCanvas = ref(null);
let gl = null;
let glProgram = null;
let glRaf = null;
let glStart = 0;
let uRes = null, uTime = null, uBpm = null, uPwv = null, uSys = null, uTheme = null;

const VS = `#version 300 es
layout(location=0) in vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('Shader compile error', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function initBg() {
  const canvas = bgCanvas.value;
  if (!canvas) return;
  gl = canvas.getWebGL2Context ? canvas.getWebGL2Context({ antialias: false, alpha: false }) : canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) return;
  const vs = compileShader(gl.VERTEX_SHADER, VS);
  const fs = compileShader(gl.FRAGMENT_SHADER, bgFragSrc);
  if (!vs || !fs) return;
  glProgram = gl.createProgram();
  gl.attachShader(glProgram, vs);
  gl.attachShader(glProgram, fs);
  gl.linkProgram(glProgram);
  if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
    console.warn('Program link error', gl.getProgramInfoLog(glProgram));
    return;
  }
  gl.useProgram(glProgram);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  uRes = gl.getUniformLocation(glProgram, 'u_resolution');
  uTime = gl.getUniformLocation(glProgram, 'u_time');
  uBpm = gl.getUniformLocation(glProgram, 'u_bpm');
  uPwv = gl.getUniformLocation(glProgram, 'u_pwv');
  uSys = gl.getUniformLocation(glProgram, 'u_systolic');
  uTheme = gl.getUniformLocation(glProgram, 'u_theme');
  glStart = performance.now();
  renderBg();
}

function resizeBg() {
  if (!gl || !bgCanvas.value) return;
  const eco = theme.value === 'eco';
  const dpr = eco ? 0.75 : Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (bgCanvas.value.width !== w || bgCanvas.value.height !== h) {
    bgCanvas.value.width = w;
    bgCanvas.value.height = h;
  }
  gl.viewport(0, 0, w, h);
}

let lastBgFrame = 0;
function renderBg(ts = 0) {
  if (!gl || !glProgram) return;
  const eco = theme.value === 'eco';
  const minFrame = eco ? 1000 / 30 : 1000 / 60;
  if (ts - lastBgFrame < minFrame) { glRaf = requestAnimationFrame(renderBg); return; }
  lastBgFrame = ts;
  resizeBg();
  gl.useProgram(glProgram);
  gl.uniform2f(uRes, bgCanvas.value.width, bgCanvas.value.height);
  gl.uniform1f(uTime, (performance.now() - glStart) / 1000);
  gl.uniform1f(uBpm, hemoTelemetry.value.bpm || 72);
  gl.uniform1f(uPwv, hemoTelemetry.value.pwv || 6.5);
  gl.uniform1f(uSys, hemoTelemetry.value.systolic ?? 0.6);
  gl.uniform1f(uTheme, themeIndex.value);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  glRaf = requestAnimationFrame(renderBg);
}

function onResize() { resizeBg(); }

onMounted(() => {
  setTheme(theme.value);
  initBg();
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  if (glRaf) cancelAnimationFrame(glRaf);
});

watch(theme, () => { resizeBg(); });
</script>

<template>
  <div class="app-shell">
    <canvas ref="bgCanvas" class="bg-canvas"></canvas>
    <svg class="grain-overlay" width="100%" height="100%" aria-hidden="true">
      <filter id="cardio-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#cardio-grain)"></rect>
    </svg>

    <!-- Gooey filter definition -->
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
      <defs>
        <filter id="cardio-gooey-dock">
          <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
          <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" result="goo" />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    </svg>

    <div class="workspace" :class="{ 'modal-pushed': modalOpen }">
      <header class="topbar glass">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path d="M3 12h3l2-5 4 10 3-7 2 2h4" stroke="url(#g1)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
              <defs><linearGradient id="g1" x1="3" y1="12" x2="21" y2="12"><stop stop-color="#F43F5E"/><stop offset="1" stop-color="#38BDF8"/></linearGradient></defs>
            </svg>
          </div>
          <div>
            <h1>CARDIO-WAVE</h1>
            <div class="sub">Hemodynamics · Auscultation · PWV · POTS · qCRT</div>
          </div>
        </div>

        <div class="topbar-controls">
          <div class="btn-group" role="group" aria-label="Viewport">
            <button class="pill" :class="{active: viewport==='desktop'}" @click="viewport='desktop'">Desktop</button>
            <button class="pill" :class="{active: viewport==='mobile'}" @click="viewport='mobile'">Mobile APK</button>
          </div>
          <select class="pill" :value="theme" @change="setTheme($event.target.value)" aria-label="Theme">
            <option v-for="t in THEMES" :key="t.id" :value="t.id">{{ t.label }}</option>
          </select>
          <select class="pill" :value="role" @change="role = $event.target.value" aria-label="Role">
            <option v-for="r in ROLES" :key="r.id" :value="r.id">{{ r.label }}</option>
          </select>
        </div>

        <div class="topbar-controls">
          <button class="btn small" v-if="role==='admin'" @click="showPolyglotModal = true">Polyglot Inspector</button>
          <button class="btn primary" @click="showApkModal = true">Download Android .APK v1.20.0</button>
        </div>
      </header>

      <HardwarePermissionGatekeeper :active-module="activeModule" />

      <div class="viewport-frame" :class="{ mobile: viewport === 'mobile' }">
        <main class="module-shell glass">
          <component
            :is="activeModuleDef.component"
            :role="role"
            :theme="theme"
            @telemetry="onTelemetry"
          />
          <div class="disclaimer">
            CARDIO-WAVE is a screening and educational hemodynamics workstation. It is <strong>not</strong> a diagnostic medical device and does not replace clinical examination, echocardiography, ECG, cuff blood pressure measurement, or emergency care.
          </div>
        </main>
      </div>

      <div class="dock-wrap">
        <nav class="dock" aria-label="Clinical modules">
          <div class="dock-goo" aria-hidden="true">
            <div v-for="m in MODULES" :key="m.id" class="goo-pill" :class="{active: activeModule===m.id}"></div>
          </div>
          <button
            v-for="m in MODULES"
            :key="m.id"
            class="dock-btn"
            :class="{ active: activeModule === m.id }"
            @click="activeModule = m.id"
          >
            <span class="icon">{{ m.icon }}</span>
            <span class="lbl">{{ m.label }}</span>
          </button>
        </nav>
      </div>
    </div>

    <ApkReleaseDownloadModal v-if="showApkModal" @close="showApkModal = false" />
    <PolyglotRuntimeInspectorModal v-if="showPolyglotModal" @close="showPolyglotModal = false" />
  </div>
</template>
