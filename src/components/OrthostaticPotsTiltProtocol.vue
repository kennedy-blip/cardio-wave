<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { ORTHO_PRESETS, OrthostaticAutonomicEngine } from '../engines/orthostaticAutonomicEngine.js';
import { putRecord, STORES } from '../db/cardioVaultDb.js';

const props = defineProps({ role: String, theme: String });
const emit = defineEmits(['telemetry']);

const engine = new OrthostaticAutonomicEngine();
const preset = ref('normal');
const running = ref(false);
const frame = ref(null);
const statusMsg = ref('Simulator ready');
const hrCanvas = ref(null);
const tiltCanvas = ref(null);

function drawHr() {
  const c = hrCanvas.value; if (!c || !frame.value?.timeline?.length) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w=c.clientWidth, h=c.clientHeight;
  c.width=Math.floor(w*dpr); c.height=Math.floor(h*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='rgba(0,0,0,0.15)'; ctx.fillRect(0,0,w,h);
  const data = frame.value.timeline;
  const hrs = data.map(d=>d.hr);
  let minV=40, maxV=140;
  for(const v of hrs){ if(v<minV)minV=v; if(v>maxV)maxV=v; }
  minV=Math.floor(minV-5); maxV=Math.ceil(maxV+5);
  // stand line
  const standAt = frame.value.standAtSec || 120;
  const tMin = data[0].tSec, tMax = data[data.length-1].tSec || (tMin+1);
  const xStand = ((standAt - tMin)/(tMax-tMin||1))*w;
  ctx.strokeStyle='rgba(245,158,11,0.7)'; ctx.setLineDash([6,4]); ctx.beginPath(); ctx.moveTo(xStand,0); ctx.lineTo(xStand,h); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='rgba(245,158,11,0.8)'; ctx.font='11px sans-serif'; ctx.fillText('Stand t₀', xStand+4, 12);

  // HR line
  ctx.strokeStyle='#f43f5e'; ctx.lineWidth=2; ctx.beginPath();
  data.forEach((d,i)=>{ const x=((d.tSec-tMin)/(tMax-tMin||1))*w; const y=h-((d.hr-minV)/(maxV-minV))*h; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.stroke();

  // Baseline reference
  const base = frame.value.baselineHr || 70;
  const yBase = h-((base-minV)/(maxV-minV))*h;
  ctx.strokeStyle='rgba(56,189,248,0.5)'; ctx.setLineDash([4,4]); ctx.beginPath(); ctx.moveTo(0,yBase); ctx.lineTo(w,yBase); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='#38bdf8'; ctx.fillText(`Baseline ${base.toFixed(0)} bpm`, 6, yBase-4);
}

function drawTilt() {
  const c = tiltCanvas.value; if (!c) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w=c.clientWidth, h=c.clientHeight;
  c.width=Math.floor(w*dpr); c.height=Math.floor(h*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='rgba(0,0,0,0.15)'; ctx.fillRect(0,0,w,h);
  const cx=w/2, cy=h*0.75, r=Math.min(w,h*0.8)*0.4;
  // arc
  ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=10; ctx.beginPath(); ctx.arc(cx,cy,r,Math.PI,0); ctx.stroke();
  // ticks
  for(let deg=0;deg<=90;deg+=15){
    const a=Math.PI - (deg/90)*Math.PI;
    const x1=cx+Math.cos(a)*(r-12), y1=cy-Math.sin(a)*(r-12);
    const x2=cx+Math.cos(a)*(r+12), y2=cy-Math.sin(a)*(r+12);
    ctx.strokeStyle='rgba(255,255,255,0.4)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.6)'; ctx.font='10px sans-serif';
    ctx.fillText(`${deg}°`, cx+Math.cos(a)*(r+22)-8, cy-Math.sin(a)*(r+22)+3);
  }
  const tilt = frame.value?.tiltDeg ?? 0;
  const a=Math.PI - (tilt/90)*Math.PI;
  ctx.strokeStyle='#f43f5e'; ctx.lineWidth=4; ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+Math.cos(a)*r, cy-Math.sin(a)*r); ctx.stroke();
  ctx.fillStyle='#fff'; ctx.font='bold 18px sans-serif'; ctx.textAlign='center';
  ctx.fillText(`${tilt.toFixed(0)}°`, cx, cy-10);
  ctx.font='12px sans-serif'; ctx.fillStyle='rgba(255,255,255,0.7)';
  ctx.fillText(frame.value?.phase === 'upright' ? 'UPRIGHT / ACTIVE STAND' : 'SUPINE BASELINE', cx, cy+24);
  ctx.textAlign='start';
}

function render() { drawHr(); drawTilt(); }

function startSim() {
  stop();
  engine.onFrame = (f) => { frame.value=f; emit('telemetry', { bpm: f.uprightHr || f.baselineHr || 72 }); render(); };
  engine.startSimulator(preset.value);
  running.value=true; statusMsg.value=`Simulator: ${ORTHO_PRESETS[preset.value].label}`;
}

function stop(){ engine.stop(); running.value=false; }

async function saveLog() {
  if (!frame.value) return;
  const f = frame.value;
  await putRecord(STORES.ORTHO, {
    preset: preset.value, baselineHr: f.baselineHr, uprightHr: f.uprightHr,
    deltaHr: f.pots?.deltaHr, ratio30_15: f.ewing?.ratio, ewingClass: f.ewing?.classification,
    potsClass: f.pots?.classification, rmssd: f.rmssd, sdnn: f.sdnn,
    lfHfSupine: f.hrvSupine?.lfHf, lfHfUpright: f.hrvUpright?.lfHf,
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
        <h2>Orthostatic Tilt-Table / Active Stand POTS & Ewing Monitor</h2>
        <p>IMU-guided supine→stand protocol with 30:15 vagal ratio, sustained ΔHR POTS criteria, and Lomb-Scargle LF/HF sympathovagal shift.</p>
      </div>
      <div class="module-controls">
        <button class="btn primary" @click="startSim">1-Tap Simulator</button>
        <button class="btn" @click="engine.triggerStand()">Mark Stand (t₀)</button>
        <button class="btn" @click="saveLog">Save Session</button>
        <button class="btn danger" @click="stop">Stop</button>
      </div>
    </div>

    <div class="grid-3">
      <div class="panel">
        <h3>Orthostatic Presets</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button v-for="(p,k) in ORTHO_PRESETS" :key="k" class="btn small" :class="{primary:preset===k}" @click="preset=k">{{ p.label }}</button>
        </div>
        <div class="note" style="margin-top:8px;">{{ ORTHO_PRESETS[preset].description }}</div>

        <h3 style="margin-top:14px;">Tilt Clinometer</h3>
        <canvas ref="tiltCanvas" class="trace short" style="height:180px;"></canvas>
      </div>

      <div class="panel" style="grid-column:span 2;">
        <h3>Heart Rate Tachogram (Supine → Upright)</h3>
        <canvas ref="hrCanvas" class="trace tall"></canvas>
        <div class="legend">
          <span style="color:#f43f5e">Heart Rate</span>
          <span style="color:#38bdf8">Baseline</span>
          <span style="color:#f59e0b">Stand t₀</span>
        </div>
      </div>
    </div>

    <div class="metric-row" style="margin-top:14px;">
      <div class="metric"><div class="label">Baseline HR</div><div class="value">{{ (frame?.baselineHr||0).toFixed(1) }}<span class="unit">bpm</span></div></div>
      <div class="metric"><div class="label">Upright HR</div><div class="value">{{ (frame?.uprightHr||0).toFixed(1) }}<span class="unit">bpm</span></div></div>
      <div class="metric"><div class="label">ΔHR</div><div class="value" :class="(frame?.pots?.deltaHr||0)>=30?'bad':(frame?.pots?.deltaHr||0)>=20?'warn':'good'">{{ (frame?.pots?.deltaHr||0).toFixed(1) }}<span class="unit">bpm</span></div></div>
      <div class="metric"><div class="label">30:15 Ratio</div><div class="value" :class="(frame?.ewing?.ratio||0)>=1.04?'good':(frame?.ewing?.ratio||0)>=1.01?'warn':'bad'">{{ (frame?.ewing?.ratio||0).toFixed(3) }}</div></div>
    </div>
    <div class="metric-row" style="margin-top:10px;">
      <div class="metric"><div class="label">Ewing Class</div><div class="value" style="font-size:0.8rem;">{{ frame?.ewing?.classification || '—' }}</div></div>
      <div class="metric"><div class="label">POTS Screen</div><div class="value" style="font-size:0.8rem;" :class="frame?.pots?.meets?'bad':'good'">{{ frame?.pots?.classification || '—' }}</div></div>
      <div class="metric"><div class="label">LF/HF Supine→Upright</div><div class="value" style="font-size:0.95rem;">{{ (frame?.hrvSupine?.lfHf||0).toFixed(2) }} → {{ (frame?.hrvUpright?.lfHf||0).toFixed(2) }}</div></div>
      <div class="metric"><div class="label">RMSSD / SDNN</div><div class="value" style="font-size:0.95rem;">{{ (frame?.rmssd||0).toFixed(1) }} / {{ (frame?.sdnn||0).toFixed(1) }}<span class="unit">ms</span></div></div>
    </div>
    <div class="note" style="margin-top:8px;">{{ statusMsg }} · Phase: {{ frame?.phase }} · Elapsed: {{ (frame?.elapsedSec||0).toFixed(0) }}s</div>
  </div>
</template>
