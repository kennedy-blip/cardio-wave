<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { AUSCULTATION_SITES, PCG_MODES, PCG_PRESETS, PcgAuscultationEngine } from '../engines/pcgAuscultationEngine.js';
import { putRecord, STORES } from '../db/cardioVaultDb.js';

const props = defineProps({ role: String, theme: String });
const emit = defineEmits(['telemetry']);

const engine = new PcgAuscultationEngine();
const mode = ref('wideband');
const site = ref('aortic');
const preset = ref('normal');
const running = ref(false);
const source = ref('simulator'); // simulator | mic
const analysis = ref(null);
const statusMsg = ref('Simulator ready');

const pcgCanvas = ref(null);
const specCanvas = ref(null);

function setMode(m) { mode.value = m; engine.setMode(m); }
function selectSite(s) { site.value = s; }

function drawPcg() {
  const c = pcgCanvas.value; if (!c || !analysis.value) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(0,0,w,h);

  const sig = analysis.value.filtered || [];
  const env = analysis.value.envelope || [];
  if (sig.length < 2) return;

  // PCG waveform
  const mid = h * 0.55;
  const amp = h * 0.35;
  let maxA = 0.001;
  for (let i = 0; i < sig.length; i++) maxA = Math.max(maxA, Math.abs(sig[i]));
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.2; ctx.beginPath();
  for (let i = 0; i < sig.length; i++) {
    const x = (i / (sig.length - 1)) * w;
    const y = mid - (sig[i] / maxA) * amp;
    i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  }
  ctx.stroke();

  // Shannon envelope
  ctx.strokeStyle = '#f43f5e'; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let i = 0; i < env.length; i++) {
    const x = (i / Math.max(1, env.length - 1)) * w;
    const y = mid - env[i] * amp;
    i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  }
  ctx.stroke();

  // S1/S2 markers
  const hop = analysis.value.envHop || 5;
  const drawMarkers = (arr, color, label) => {
    ctx.fillStyle = color; ctx.strokeStyle = color; ctx.font = '11px sans-serif';
    for (const s of arr) {
      const x = (s / (sig.length - 1)) * w;
      ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, h - 10); ctx.stroke();
      ctx.fillText(label, x + 3, 14);
    }
  };
  ctx.globalAlpha = 0.35;
  drawMarkers(analysis.value.s1Samples || [], '#10b981', 'S1');
  drawMarkers(analysis.value.s2Samples || [], '#f59e0b', 'S2');
  ctx.globalAlpha = 1;
}

function drawSpectrogram() {
  const c = specCanvas.value; if (!c || !analysis.value?.spectrogram) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(0,0,w,h);

  const spec = analysis.value.spectrogram;
  const frames = spec.frames || [];
  if (!frames.length) return;
  const maxBin = spec.maxBin || frames[0].length;
  const fw = w / frames.length;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    for (let b = 0; b < maxBin; b++) {
      const db = f[b]; // -160..0ish
      const norm = clamp((db + 100) / 60, 0, 1);
      const y = h - (b / maxBin) * h;
      const bh = Math.max(1, h / maxBin);
      const r = Math.floor(255 * norm);
      const g = Math.floor(120 * (1 - Math.abs(norm - 0.5) * 2));
      const bl = Math.floor(255 * (1 - norm));
      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.fillRect(i * fw, y - bh, fw + 1, bh + 1);
    }
  }
  // freq labels
  ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '10px sans-serif';
  for (const hz of [50,100,150,200,300,400,500]) {
    const y = h - (hz / 600) * h;
    ctx.fillText(`${hz}Hz`, 4, y - 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function render() { drawPcg(); drawSpectrogram(); }

async function startSim() {
  stop();
  source.value = 'simulator';
  engine.setPreset(preset.value);
  engine.setMode(mode.value);
  engine.onFrame = (f) => { analysis.value = f; emit('telemetry', { bpm: f.heartRateBpm || 72, systolic: 0.6 }); render(); };
  engine.startSimulator(preset.value);
  running.value = true;
  statusMsg.value = `Simulator: ${PCG_PRESETS[preset.value]?.label || preset.value}`;
}

async function startMic() {
  stop();
  try {
    source.value = 'mic';
    engine.setMode(mode.value);
    engine.onFrame = (f) => { analysis.value = f; emit('telemetry', { bpm: f.heartRateBpm || 72, systolic: 0.6 }); render(); };
    await engine.startMicrophone();
    running.value = true;
    statusMsg.value = 'Live microphone (unprocessed) active';
  } catch (e) {
    statusMsg.value = `Mic unavailable: ${e.message}. Using simulator.`;
    await startSim();
  }
}

function stop() {
  engine.stop();
  running.value = false;
}

async function saveLog() {
  if (!analysis.value) return;
  await putRecord(STORES.PCG, {
    site: site.value, mode: mode.value, preset: preset.value, source: source.value,
    heartRateBpm: analysis.value.heartRateBpm,
    a2p2SplitMs: analysis.value.a2p2SplitMs,
    systolicMurmurRatioDb: analysis.value.systolicMurmurRatioDb,
    diastolicMurmurRatioDb: analysis.value.diastolicMurmurRatioDb,
  });
  statusMsg.value = 'Saved to IndexedDB vault.';
}

watch(preset, (p) => { engine.setPreset(p); if (source.value === 'simulator' && running.value) startSim(); });

onMounted(() => { startSim(); });
onBeforeUnmount(() => stop());
</script>

<template>
  <div>
    <div class="module-header">
      <div>
        <h2>Digital Phonocardiogram (PCG) Stethoscope</h2>
        <p>Unprocessed low-frequency auscultation with Bell/Diaphragm filtering, Shannon Energy Envelope segmentation, A2–P2 split timing, and murmur spectral analysis.</p>
      </div>
      <div class="module-controls">
        <button class="btn" :class="{primary: source==='simulator'}" @click="startSim">1-Tap Simulator</button>
        <button class="btn" :class="{primary: source==='mic'}" @click="startMic">Live Mic</button>
        <button class="btn" @click="saveLog">Save Log</button>
        <button class="btn danger" @click="stop">Stop</button>
      </div>
    </div>

    <div class="grid-3">
      <div class="panel">
        <h3>Auscultation Site</h3>
        <div style="position:relative;width:100%;max-width:260px;margin:0 auto;">
          <svg viewBox="0 0 100 100" style="width:100%;height:auto;">
            <defs>
              <linearGradient id="torso" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(56,189,248,0.12)"/><stop offset="100%" stop-color="rgba(244,63,94,0.08)"/></linearGradient>
            </defs>
            <path d="M20,15 C30,10 70,10 80,15 L85,30 L78,55 L72,90 L28,90 L22,55 L15,30 Z" fill="url(#torso)" stroke="rgba(255,255,255,0.2)" />
            <circle cx="50" cy="38" r="16" fill="none" stroke="rgba(255,255,255,0.08)" />
            <g v-for="s in AUSCULTATION_SITES" :key="s.id" @click="selectSite(s.id)" style="cursor:pointer;">
              <circle :cx="s.x" :cy="s.y" r="6" :fill="site===s.id ? '#f43f5e' : 'rgba(56,189,248,0.35)'" :stroke="site===s.id ? '#fff' : 'rgba(255,255,255,0.4)'" stroke-width="1.2" />
              <text :x="s.x" :y="s.y+2.5" text-anchor="middle" font-size="5" fill="#fff" font-weight="700">{{ s.label[0] }}</text>
            </g>
          </svg>
        </div>
        <div class="note" style="margin-top:8px;">
          <strong>{{AUSCULTATION_SITES.find(s=>s.id===site)?.label}}</strong> — {{AUSCULTATION_SITES.find(s=>s.id===site)?.pos}}<br/>
          {{AUSCULTATION_SITES.find(s=>s.id===site)?.note}}
        </div>

        <h3 style="margin-top:14px;">Acoustic Mode</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button v-for="(m,k) in PCG_MODES" :key="k" class="btn small" :class="{primary: mode===k}" @click="setMode(k)">{{ m.label }}</button>
        </div>

        <h3 style="margin-top:14px;">1-Tap Presets</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button v-for="(p,k) in PCG_PRESETS" :key="k" class="btn small" :class="{primary: preset===k}" @click="preset=k">{{ p.label }}</button>
        </div>
        <div class="note" style="margin-top:8px;">{{ PCG_PRESETS[preset]?.description }}</div>
      </div>

      <div class="panel" style="grid-column: span 2;">
        <h3>PCG Waveform + Shannon Energy Envelope</h3>
        <canvas ref="pcgCanvas" class="trace tall"></canvas>
        <div class="legend">
          <span style="color:#38bdf8">PCG</span>
          <span style="color:#f43f5e">Shannon Envelope</span>
          <span style="color:#10b981">S1</span>
          <span style="color:#f59e0b">S2</span>
        </div>

        <h3 style="margin-top:14px;">Real-Time Spectrogram (20–600 Hz)</h3>
        <canvas ref="specCanvas" class="trace"></canvas>
      </div>
    </div>

    <div class="metric-row" style="margin-top:14px;">
      <div class="metric"><div class="label">Heart Rate</div><div class="value">{{ (analysis?.heartRateBpm||0).toFixed(1) }}<span class="unit">bpm</span></div></div>
      <div class="metric"><div class="label">A2–P2 Split</div><div class="value">{{ (analysis?.a2p2SplitMs||0).toFixed(1) }}<span class="unit">ms</span></div></div>
      <div class="metric"><div class="label">Systolic Murmur Ratio</div><div class="value" :class="(analysis?.systolicMurmurRatioDb||-120)> -12 ? 'warn':'good'">{{ (analysis?.systolicMurmurRatioDb||-120).toFixed(1) }}<span class="unit">dB</span></div></div>
      <div class="metric"><div class="label">Diastolic Murmur Ratio</div><div class="value" :class="(analysis?.diastolicMurmurRatioDb||-120)> -12 ? 'warn':'good'">{{ (analysis?.diastolicMurmurRatioDb||-120).toFixed(1) }}<span class="unit">dB</span></div></div>
      <div class="metric"><div class="label">Mode / Source</div><div class="value" style="font-size:0.85rem;">{{ PCG_MODES[mode]?.label }}</div><div class="note">{{ statusMsg }}</div></div>
    </div>
  </div>
</template>
