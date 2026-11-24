<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { PWV_PRESETS, PwvHemodynamicsEngine } from '../engines/pwvHemodynamicsEngine.js';
import { putRecord, STORES } from '../db/cardioVaultDb.js';

const props = defineProps({ role: String, theme: String });
const emit = defineEmits(['telemetry']);

const engine = new PwvHemodynamicsEngine();
const preset = ref('elastic');
const running = ref(false);
const frame = ref(null);
const statusMsg = ref('Simulator ready');
const heightCm = ref(170);
const mbp0 = ref(93);
const ptt0 = ref(120);

const scgCanvas = ref(null);
const ppgCanvas = ref(null);

function drawTrace(canvasRef, data, color='#38bdf8', markers=[]) {
  const c = canvasRef.value; if (!c || !data?.length) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w=c.clientWidth, h=c.clientHeight;
  c.width=Math.floor(w*dpr); c.height=Math.floor(h*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='rgba(0,0,0,0.15)'; ctx.fillRect(0,0,w,h);
  let minV=Infinity,maxV=-Infinity;
  for(const v of data){ if(v<minV)minV=v; if(v>maxV)maxV=v; }
  const pad=(maxV-minV)*0.1||1; minV-=pad; maxV+=pad;
  ctx.strokeStyle=color; ctx.lineWidth=1.8; ctx.beginPath();
  data.forEach((v,i)=>{ const x=(i/(data.length-1))*w; const y=h-((v-minV)/(maxV-minV))*h; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.stroke();
  ctx.globalAlpha=0.5; ctx.strokeStyle='#f59e0b'; ctx.fillStyle='#f59e0b'; ctx.font='11px sans-serif';
  for(const m of markers){ const x=(m.idx/(data.length-1))*w; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); ctx.globalAlpha=1; ctx.fillText(m.label,x+3,12); ctx.globalAlpha=0.5; }
  ctx.globalAlpha=1;
}

function render() {
  if (!frame.value) return;
  const aoMarkers = (frame.value.pairs||[]).map(p=>({idx:p.aoIdx,label:'AO'}));
  const footMarkers = (frame.value.pairs||[]).map(p=>({idx:p.footIdx,label:'Foot'}));
  drawTrace(scgCanvas, frame.value.scg, '#10b981', aoMarkers);
  drawTrace(ppgCanvas, frame.value.ppg, '#38bdf8', footMarkers);
}

function applyAnthro() {
  engine.setAnthropometrics({ heightCm: Number(heightCm.value), mbp0: Number(mbp0.value), ptt0: Number(ptt0.value), gamma: 0.017 });
}

function startSim() {
  stop(); applyAnthro();
  engine.onFrame = (f) => { frame.value=f; emit('telemetry', { bpm: f.preset?.hr || 72, pwv: f.metrics?.pwvMPerS || 6.5, systolic: 0.6 }); render(); };
  engine.startSimulator(preset.value);
  running.value=true; statusMsg.value=`Simulator: ${PWV_PRESETS[preset.value].label}`;
}

function stop(){ engine.stop(); running.value=false; }

async function saveLog() {
  if (!frame.value) return;
  const f = frame.value;
  await putRecord(STORES.PWV, {
    preset: preset.value, heightCm: Number(heightCm.value),
    pttMs: f.pttMs, ...f.metrics, mbpEst: f.mbpEst, sbpEst: f.sbpEst, dbpEst: f.dbpEst,
  });
  statusMsg.value='Saved to IndexedDB vault.';
}

watch(preset, () => { if (running.value) startSim(); });
onMounted(() => startSim());
onBeforeUnmount(() => stop());
</script>

<template>
  <div>
    <div class="module-header">
      <div>
        <h2>Dual-Site PWV & Moens–Korteweg Arterial Stiffness Lab</h2>
        <p>Synchronized sternum SCG Aortic Opening (AO) + fingertip PPG foot timing for true Pulse Transit Time (PTT), PWV, Young's modulus, and cuffless ΔBP excursion.</p>
      </div>
      <div class="module-controls">
        <button class="btn primary" @click="startSim">1-Tap Simulator</button>
        <button class="btn" @click="saveLog">Save Record</button>
        <button class="btn danger" @click="stop">Stop</button>
      </div>
    </div>

    <div class="grid-3">
      <div class="panel">
        <h3>Dual-Channel Presets</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button v-for="(p,k) in PWV_PRESETS" :key="k" class="btn small" :class="{primary:preset===k}" @click="preset=k">{{ p.label }}</button>
        </div>
        <div class="note" style="margin-top:8px;">{{ PWV_PRESETS[preset].description }}</div>

        <h3 style="margin-top:14px;">Anthropometrics / Calibration</h3>
        <div class="field-row">
          <label class="field">Height (cm)<input class="input" type="number" v-model.number="heightCm" @change="applyAnthro(); startSim();" /></label>
          <label class="field">PTT₀ (ms)<input class="input" type="number" v-model.number="ptt0" @change="applyAnthro()" /></label>
        </div>
        <div class="field-row" style="margin-top:8px;">
          <label class="field">MBP₀ (mmHg)<input class="input" type="number" v-model.number="mbp0" @change="applyAnthro()" /></label>
          <label class="field">Path L (m)<input class="input" type="text" :value="(0.5*heightCm/100).toFixed(3)" disabled /></label>
        </div>
        <div class="note" style="margin-top:8px;">L_eff = 0.50 × H. Adjust height or substitute direct sternal-notch-to-fingertip measurement.</div>
      </div>

      <div class="panel" style="grid-column:span 2;">
        <h3>Stream A — Sternum SCG (Proximal AO Gate)</h3>
        <canvas ref="scgCanvas" class="trace short"></canvas>
        <h3 style="margin-top:10px;">Stream B — Fingertip PPG (Distal Foot Gate)</h3>
        <canvas ref="ppgCanvas" class="trace short"></canvas>
        <div class="legend">
          <span style="color:#10b981">SCG AO</span>
          <span style="color:#38bdf8">PPG</span>
          <span style="color:#f59e0b">AO / Foot markers</span>
        </div>
      </div>
    </div>

    <div class="metric-row" style="margin-top:14px;">
      <div class="metric"><div class="label">PTT</div><div class="value">{{ (frame?.pttMs||0).toFixed(1) }}<span class="unit">ms</span></div></div>
      <div class="metric"><div class="label">PWV</div><div class="value" :class="(frame?.metrics?.pwvMPerS||0)>=10?'bad':(frame?.metrics?.pwvMPerS||0)>=8?'warn':'good'">{{ (frame?.metrics?.pwvMPerS||0).toFixed(2) }}<span class="unit">m/s</span></div></div>
      <div class="metric"><div class="label">Young's Modulus E</div><div class="value">{{ ((frame?.metrics?.youngsModulusKpa||0)).toFixed(0) }}<span class="unit">kPa</span></div></div>
      <div class="metric"><div class="label">Distensibility</div><div class="value">{{ (frame?.metrics?.distensibilityPerKpa||0).toFixed(4) }}<span class="unit">1/kPa</span></div></div>
    </div>
    <div class="metric-row" style="margin-top:10px;">
      <div class="metric"><div class="label">Vascular Age</div><div class="value">{{ (frame?.metrics?.vascularAgeYears||0).toFixed(0) }}<span class="unit">yrs</span></div></div>
      <div class="metric"><div class="label">Est. SBP</div><div class="value">{{ (frame?.sbpEst||0).toFixed(0) }}<span class="unit">mmHg</span></div></div>
      <div class="metric"><div class="label">Est. DBP</div><div class="value">{{ (frame?.dbpEst||0).toFixed(0) }}<span class="unit">mmHg</span></div></div>
      <div class="metric"><div class="label">Stiffness Class</div><div class="value" style="font-size:0.8rem;">{{ frame?.metrics?.stiffnessClass || '—' }}</div><div class="note">{{ statusMsg }}</div></div>
    </div>
  </div>
</template>
