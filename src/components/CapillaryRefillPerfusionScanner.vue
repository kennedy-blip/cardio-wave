<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { CRT_PRESETS, CapillaryPerfusionEngine } from '../engines/capillaryPerfusionEngine.js';
import { putRecord, STORES } from '../db/cardioVaultDb.js';

const props = defineProps({ role: String, theme: String });
const emit = defineEmits(['telemetry']);

const engine = new CapillaryPerfusionEngine();
const preset = ref('normal');
const running = ref(false);
const frame = ref(null);
const statusMsg = ref('Simulator ready');
const signalCanvas = ref(null);
const heatCanvas = ref(null);

function drawSignal() {
  const c = signalCanvas.value; if (!c || !frame.value?.hbSeries?.length) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w=c.clientWidth, h=c.clientHeight;
  c.width=Math.floor(w*dpr); c.height=Math.floor(h*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='rgba(0,0,0,0.15)'; ctx.fillRect(0,0,w,h);
  const t = frame.value.tSeries;
  const v = frame.value.hbSeries;
  let minV=Math.min(...v), maxV=Math.max(...v);
  const pad=(maxV-minV)*0.15||0.1; minV-=pad; maxV+=pad;
  const tMin=t[0], tMax=t[t.length-1]||tMin+1;

  // Release marker
  if (frame.value.releaseTime != null) {
    const x=((frame.value.releaseTime-tMin)/(tMax-tMin||1))*w;
    ctx.strokeStyle='rgba(245,158,11,0.8)'; ctx.setLineDash([6,4]);
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle='#f59e0b'; ctx.font='11px sans-serif'; ctx.fillText('Release', x+4, 12);
  }

  ctx.strokeStyle='#f43f5e'; ctx.lineWidth=2; ctx.beginPath();
  v.forEach((val,i)=>{ const x=((t[i]-tMin)/(tMax-tMin||1))*w; const y=h-((val-minV)/(maxV-minV))*h; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.stroke();

  // Fitted curve overlay
  const fit = frame.value.fit;
  if (fit?.tauSeconds > 0 && frame.value.releaseTime != null) {
    ctx.strokeStyle='rgba(16,185,129,0.9)'; ctx.lineWidth=1.5; ctx.setLineDash([4,3]); ctx.beginPath();
    let started=false;
    for (let i=0;i<t.length;i++){
      if (t[i] < frame.value.releaseTime) continue;
      const dt = t[i]-frame.value.releaseTime;
      const pred = fit.aBlanch + (fit.aBase-fit.aBlanch)*(1-Math.exp(-dt/fit.tauSeconds));
      const x=((t[i]-tMin)/(tMax-tMin||1))*w;
      const y=h-((pred-minV)/(maxV-minV))*h;
      if(!started){ctx.moveTo(x,y);started=true;} else ctx.lineTo(x,y);
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
}

function drawHeatmap() {
  const c = heatCanvas.value; if (!c) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w=c.clientWidth, h=c.clientHeight;
  c.width=Math.floor(w*dpr); c.height=Math.floor(h*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);

  // Simulated fingertip heatmap
  const t = performance.now()/1000;
  const img = ctx.createImageData(c.width, c.height);
  const hb = frame.value?.currentHb ?? 0.7;
  const blanch = frame.value?.blanchIntensity ?? 0;
  const refill = frame.value?.refillProgress ?? 0;
  for (let y=0;y<c.height;y++){
    for (let x=0;x<c.width;x++){
      const nx = (x/c.width - 0.5)*2;
      const ny = (y/c.height - 0.5)*2;
      const r = Math.sqrt(nx*nx+ny*ny);
      const mask = Math.max(0, 1-r*r*1.2);
      const pulse = 0.05*Math.sin(t*3 + y*0.05);
      const perf = hb*(1-0.7*blanch) + 0.3*refill + pulse;
      const p = Math.max(0,Math.min(1,perf*mask));
      // heat: cyan/indigo -> gold -> crimson
      let R,G,B;
      if (p < 0.33){ const k=p/0.33; R=0.05+0.05*k; G=0.18+0.60*k; B=0.45+0.37*k; }
      else if (p < 0.66){ const k=(p-0.33)/0.33; R=0.10+0.85*k; G=0.78+0.02*k; B=0.82-0.64*k; }
      else { const k=(p-0.66)/0.34; R=0.95-0.05*k; G=0.80-0.64*k; B=0.18+0.10*k; }
      const idx=(y*c.width+x)*4;
      img.data[idx]=Math.floor(R*255*mask);
      img.data[idx+1]=Math.floor(G*255*mask);
      img.data[idx+2]=Math.floor(B*255*mask);
      img.data[idx+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
  // overlay text
  ctx.fillStyle='rgba(255,255,255,0.8)'; ctx.font='12px sans-serif';
  ctx.fillText(`Phase: ${frame.value?.phase || 'baseline'}`, 10, 20);
}

let raf = null;
function animLoop(){ render(); raf = requestAnimationFrame(animLoop); }
function render(){ drawSignal(); drawHeatmap(); }

function startSim() {
  stop();
  engine.onFrame = (f) => { frame.value=f; emit('telemetry', { bpm: 72, systolic: 0.5 }); };
  engine.startSimulator(preset.value);
  running.value=true; statusMsg.value=`Simulator: ${CRT_PRESETS[preset.value].label}`;
  raf = requestAnimationFrame(animLoop);
}

async function startCamera() {
  stop();
  try {
    engine.onFrame = (f) => { frame.value=f; };
    await engine.startCamera();
    running.value=true; statusMsg.value='Live camera active. Press Compress/Release to mark phases.';
    raf = requestAnimationFrame(animLoop);
  } catch(e) {
    statusMsg.value=`Camera unavailable: ${e.message}. Using simulator.`;
    startSim();
  }
}

function stop(){
  engine.stop(); running.value=false;
  if (raf) { cancelAnimationFrame(raf); raf=null; }
}

async function saveLog() {
  if (!frame.value) return;
  const f = frame.value;
  await putRecord(STORES.CRT, {
    preset: preset.value, phase: f.phase, piPercent: f.piPercent,
    tauSeconds: f.fit?.tauSeconds, t90Seconds: f.fit?.t90Seconds, r2: f.fit?.r2,
    classification: f.fit?.classification,
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
        <h2>Optical Capillary Refill (qCRT) & Sub-Epidermal Perfusion Scanner</h2>
        <p>60 FPS hemoglobin absorption heatmap with automated blanch-release detection, mono-exponential reperfusion curve fit (t90, τ, R²), and Peripheral Perfusion Index (PI%).</p>
      </div>
      <div class="module-controls">
        <button class="btn primary" @click="startSim">1-Tap Simulator</button>
        <button class="btn" @click="startCamera">Live Camera</button>
        <button class="btn" @click="engine.markCompress()">Mark Compress</button>
        <button class="btn" @click="engine.markRelease()">Mark Release</button>
        <button class="btn" @click="saveLog">Save Scan</button>
        <button class="btn danger" @click="stop">Stop</button>
      </div>
    </div>

    <div class="grid-3">
      <div class="panel">
        <h3>Microvascular Presets</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button v-for="(p,k) in CRT_PRESETS" :key="k" class="btn small" :class="{primary:preset===k}" @click="preset=k">{{ p.label }}</button>
        </div>
        <div class="note" style="margin-top:8px;">{{ CRT_PRESETS[preset].description }}</div>

        <h3 style="margin-top:14px;">Protocol</h3>
        <div class="list">
          <div class="list-item"><strong>1. Baseline</strong> — 1.5s steady perfusion</div>
          <div class="list-item"><strong>2. Blanch</strong> — compress fingertip/nail bed</div>
          <div class="list-item"><strong>3. Release</strong> — t₀ for exponential refill fit</div>
          <div class="list-item"><strong>4. Recovery</strong> — track A_Hb(t) to 90%</div>
        </div>
      </div>

      <div class="panel">
        <h3>Sub-Epidermal Hemoglobin Heatmap</h3>
        <canvas ref="heatCanvas" class="trace tall"></canvas>
        <div class="legend">
          <span style="color:#38bdf8">Low perfusion</span>
          <span style="color:#fbbf24">Reperfusion</span>
          <span style="color:#f43f5e">Hyperemic</span>
        </div>
      </div>

      <div class="panel">
        <h3>Hemoglobin Absorption A_Hb(t) + Fit</h3>
        <canvas ref="signalCanvas" class="trace tall"></canvas>
        <div class="legend">
          <span style="color:#f43f5e">A_Hb signal</span>
          <span style="color:#10b981">Exponential fit</span>
          <span style="color:#f59e0b">Release</span>
        </div>
      </div>
    </div>

    <div class="metric-row" style="margin-top:14px;">
      <div class="metric"><div class="label">qCRT t90</div><div class="value" :class="(frame?.fit?.t90Seconds||0)>=3?'bad':(frame?.fit?.t90Seconds||0)>=2?'warn':'good'">{{ (frame?.fit?.t90Seconds||0).toFixed(2) }}<span class="unit">s</span></div></div>
      <div class="metric"><div class="label">τ (tau)</div><div class="value">{{ (frame?.fit?.tauSeconds||0).toFixed(2) }}<span class="unit">s</span></div></div>
      <div class="metric"><div class="label">Fit R²</div><div class="value">{{ (frame?.fit?.r2||0).toFixed(3) }}</div></div>
      <div class="metric"><div class="label">Perfusion Index (PI)</div><div class="value" :class="(frame?.piPercent||0)<0.4?'bad':(frame?.piPercent||0)<1.5?'warn':'good'">{{ (frame?.piPercent||0).toFixed(2) }}<span class="unit">%</span></div></div>
    </div>
    <div class="metric-row" style="margin-top:10px;">
      <div class="metric" style="flex:2;"><div class="label">Classification</div><div class="value" style="font-size:0.85rem;">{{ frame?.fit?.classification || 'Awaiting refill' }}</div></div>
      <div class="metric"><div class="label">Phase</div><div class="value" style="font-size:0.9rem;">{{ frame?.phase || '—' }}</div></div>
      <div class="metric" style="flex:2;"><div class="label">Status</div><div class="value" style="font-size:0.75rem;color:var(--muted);font-weight:500;">{{ statusMsg }}</div></div>
    </div>
  </div>
</template>
