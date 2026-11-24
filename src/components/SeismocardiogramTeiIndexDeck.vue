<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { SCG_PRESETS, ScgMechanocardiogramEngine } from '../engines/scgMechanocardiogramEngine.js';
import { putRecord, STORES } from '../db/cardioVaultDb.js';

const props = defineProps({ role: String, theme: String });
const emit = defineEmits(['telemetry']);

const engine = new ScgMechanocardiogramEngine();
const preset = ref('healthy');
const running = ref(false);
const source = ref('simulator');
const frame = ref(null);
const statusMsg = ref('Simulator ready');
const scgCanvas = ref(null);
const wiggersCanvas = ref(null);
const pvCanvas = ref(null);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function drawSeries(canvas, series, opts = {}) {
  const c = canvas.value; if (!c || !series?.length) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(0,0,w,h);
  const lines = opts.lines || [{ data: series, color: '#38bdf8', lw: 1.5 }];
  let minV = Infinity, maxV = -Infinity;
  for (const l of lines) for (const v of l.data) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
  if (!isFinite(minV) || !isFinite(maxV) || Math.abs(maxV-minV)<1e-6) { minV -= 1; maxV += 1; }
  const pad = (maxV-minV)*0.1; minV-=pad; maxV+=pad;
  for (const l of lines) {
    ctx.strokeStyle = l.color; ctx.lineWidth = l.lw || 1.5; ctx.beginPath();
    l.data.forEach((v,i) => {
      const x = (i/(l.data.length-1))*w;
      const y = h - ((v-minV)/(maxV-minV))*h;
      i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    });
    ctx.stroke();
  }
  if (opts.markers) {
    ctx.font='11px sans-serif';
    for (const m of opts.markers) {
      const x = (m.index/(series.length-1))*w;
      ctx.strokeStyle = m.color || '#fff'; ctx.globalAlpha=0.5;
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke();
      ctx.globalAlpha=1; ctx.fillStyle=m.color||'#fff'; ctx.fillText(m.label, x+3, 12);
    }
  }
}

function render() {
  if (!frame.value) return;
  const f = frame.value;
  // SCG trace
  const sm = f.smoothed || [];
  const markers = [];
  if (f.fiducials?.length) {
    const last = f.fiducials[f.fiducials.length-1];
    const fs = f.fs || 200;
    const baseMs = (sm.length / fs) * 1000;
    const toIdx = (ms) => clamp(Math.round((ms/1000)*fs - (sm.length - 4*fs)), 0, sm.length-1);
    // Approximate markers relative to displayed window
    const offset = Math.max(0, (f.beats?.slice(-1)[0] || 0) - Math.round(0.12*fs));
    const rel = (ms) => clamp(Math.round(((ms - (offset/fs*1000)) / 1000) * fs), 0, sm.length-1);
    markers.push({index: rel(last.mcMs), label:'MC', color:'#f59e0b'});
    markers.push({index: rel(last.aoMs), label:'AO', color:'#f43f5e'});
    markers.push({index: rel(last.acMs), label:'AC', color:'#38bdf8'});
    markers.push({index: rel(last.moMs), label:'MO', color:'#10b981'});
  }
  drawSeries(scgCanvas, sm, { lines:[{data:sm, color:'#10b981', lw:1.5}], markers });

  // Wiggers
  const w = f.wiggers;
  if (w) {
    drawSeries(wiggersCanvas, w.lvp, {
      lines: [
        { data: w.lvp, color:'#f43f5e', lw:1.8 },
        { data: w.aop, color:'#38bdf8', lw:1.8 },
        { data: w.lvVol.map(v=>v*0.8), color:'#10b981', lw:1.2 },
        { data: w.scg.map(v=>50+v*15), color:'#f59e0b', lw:1 },
      ]
    });
  }

  // PV loop
  drawPV();
}

function drawPV() {
  const c = pvCanvas.value; const w = frame.value?.wiggers;
  if (!c || !w) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cw = c.clientWidth, ch = c.clientHeight;
  c.width = Math.floor(cw*dpr); c.height = Math.floor(ch*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cw,ch);
  ctx.fillStyle='rgba(0,0,0,0.15)'; ctx.fillRect(0,0,cw,ch);
  const vols = w.lvVol, ps = w.lvp;
  let vMin=Infinity,vMax=-Infinity,pMin=Infinity,pMax=-Infinity;
  for(let i=0;i<vols.length;i++){ vMin=Math.min(vMin,vols[i]); vMax=Math.max(vMax,vols[i]); pMin=Math.min(pMin,ps[i]); pMax=Math.max(pMax,ps[i]); }
  const padV=(vMax-vMin)*0.1||1, padP=(pMax-pMin)*0.1||1;
  vMin-=padV; vMax+=padV; pMin-=padP; pMax+=padP;
  ctx.strokeStyle='#f43f5e'; ctx.lineWidth=2; ctx.beginPath();
  for(let i=0;i<vols.length;i++){
    const x=((vols[i]-vMin)/(vMax-vMin))*cw;
    const y=ch-((ps[i]-pMin)/(pMax-pMin))*ch;
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  }
  ctx.closePath(); ctx.stroke();
  ctx.fillStyle='rgba(244,63,94,0.08)'; ctx.fill();

  // Fiducial points
  const labels = ['MC','AO','AC','MO'];
  const idxs = [0, Math.floor(vols.length*0.15), Math.floor(vols.length*0.45), Math.floor(vols.length*0.55)];
  ctx.fillStyle='#fff'; ctx.font='11px sans-serif';
  idxs.forEach((i, k) => {
    const x=((vols[i]-vMin)/(vMax-vMin))*cw; const y=ch-((ps[i]-pMin)/(pMax-pMin))*ch;
    ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fillStyle=['#f59e0b','#f43f5e','#38bdf8','#10b981'][k]; ctx.fill();
    ctx.fillStyle='#fff'; ctx.fillText(labels[k], x+6, y-6);
  });
  ctx.fillStyle='rgba(255,255,255,0.6)'; ctx.fillText('Volume (mL) →', cw-90, ch-6);
  ctx.save(); ctx.translate(12, ch/2); ctx.rotate(-Math.PI/2); ctx.fillText('LV Pressure (mmHg)', 0,0); ctx.restore();
}

async function startSim() {
  stop(); source.value='simulator';
  engine.onFrame = (f) => { frame.value=f; emit('telemetry', { bpm: f.heartRateBpm||72, pwv: 6.5, systolic: 0.7 }); render(); };
  engine.startSimulator(preset.value);
  running.value=true; statusMsg.value=`Simulator: ${SCG_PRESETS[preset.value].label}`;
}

async function startImu() {
  stop();
  try {
    source.value='imu';
    engine.onFrame = (f) => { frame.value=f; emit('telemetry', { bpm: f.heartRateBpm||72, systolic: 0.7 }); render(); };
    await engine.startDeviceMotion();
    running.value=true; statusMsg.value='Live DeviceMotion IMU active';
  } catch(e) {
    statusMsg.value=`IMU unavailable: ${e.message}. Using simulator.`; await startSim();
  }
}

function stop(){ engine.stop(); running.value=false; }

async function saveLog() {
  if (!frame.value) return;
  const m = frame.value.metrics;
  await putRecord(STORES.SCG, {
    preset: preset.value, source: source.value, hr: frame.value.heartRateBpm,
    ...m, classification: m.teiIndex > 0.5 ? 'Elevated Tei' : m.teiIndex > 0.4 ? 'Borderline' : 'Normal',
  });
  statusMsg.value='Saved to IndexedDB vault.';
}

watch(preset, () => { if (source.value==='simulator' && running.value) startSim(); });
onMounted(() => startSim());
onBeforeUnmount(() => stop());
</script>

<template>
  <div>
    <div class="module-header">
      <div>
        <h2>Sternum Seismocardiography (SCG) & Tei Myocardial Performance</h2>
        <p>3-axis thoracic micro-acceleration fiducials (MC, AO, RE, AC, MO), IVCT/LVET/IVRT timing, Tei Index, and synchronized Wiggers + P-V loop.</p>
      </div>
      <div class="module-controls">
        <button class="btn" :class="{primary:source==='simulator'}" @click="startSim">1-Tap Simulator</button>
        <button class="btn" :class="{primary:source==='imu'}" @click="startImu">Live IMU</button>
        <button class="btn" @click="saveLog">Save Study</button>
        <button class="btn danger" @click="stop">Stop</button>
      </div>
    </div>

    <div class="grid-3">
      <div class="panel">
        <h3>Mechanocardiogram Presets</h3>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button v-for="(p,k) in SCG_PRESETS" :key="k" class="btn small" :class="{primary:preset===k}" @click="preset=k">{{ p.label }}</button>
        </div>
        <div class="note" style="margin-top:8px;">{{ SCG_PRESETS[preset].description }}</div>

        <h3 style="margin-top:14px;">Fiducial Landmarks</h3>
        <div class="list">
          <div class="list-item"><strong>MC</strong> — Mitral Valve Closure (IVCT onset)</div>
          <div class="list-item"><strong>AO</strong> — Aortic Valve Opening (ejection onset)</div>
          <div class="list-item"><strong>AC</strong> — Aortic Valve Closure (ejection end)</div>
          <div class="list-item"><strong>MO</strong> — Mitral Valve Opening (filling onset)</div>
        </div>
      </div>

      <div class="panel" style="grid-column:span 2;">
        <h3>Dorsoventral SCG (Z-axis, 1–45 Hz)</h3>
        <canvas ref="scgCanvas" class="trace"></canvas>
        <div class="legend">
          <span style="color:#10b981">SCG</span>
          <span style="color:#f59e0b">MC</span>
          <span style="color:#f43f5e">AO</span>
          <span style="color:#38bdf8">AC</span>
          <span style="color:#10b981">MO</span>
        </div>

        <h3 style="margin-top:14px;">Synchronized Wiggers Stack</h3>
        <canvas ref="wiggersCanvas" class="trace"></canvas>
        <div class="legend">
          <span style="color:#f43f5e">LV Pressure</span>
          <span style="color:#38bdf8">Aortic Pressure</span>
          <span style="color:#10b981">LV Volume (scaled)</span>
          <span style="color:#f59e0b">SCG marker</span>
        </div>
      </div>
    </div>

    <div class="grid-2" style="margin-top:14px;">
      <div class="panel">
        <h3>LV Pressure–Volume Loop</h3>
        <canvas ref="pvCanvas" class="trace tall"></canvas>
      </div>
      <div class="panel">
        <h3>Clinical Intervals & Tei Index</h3>
        <div class="metric-row">
          <div class="metric"><div class="label">IVCT</div><div class="value">{{ (frame?.metrics?.ivctMs||0).toFixed(1) }}<span class="unit">ms</span></div></div>
          <div class="metric"><div class="label">LVET</div><div class="value">{{ (frame?.metrics?.lvetMs||0).toFixed(1) }}<span class="unit">ms</span></div></div>
          <div class="metric"><div class="label">IVRT</div><div class="value">{{ (frame?.metrics?.ivrtMs||0).toFixed(1) }}<span class="unit">ms</span></div></div>
        </div>
        <div class="metric-row" style="margin-top:10px;">
          <div class="metric"><div class="label">Tei Index (MPI)</div><div class="value" :class="(frame?.metrics?.teiIndex||0)>0.5?'bad':(frame?.metrics?.teiIndex||0)>0.4?'warn':'good'">{{ (frame?.metrics?.teiIndex||0).toFixed(3) }}</div><div class="note">Normal 0.35 ± 0.08</div></div>
          <div class="metric"><div class="label">PEP / LVET</div><div class="value" :class="(frame?.metrics?.pepLvetRatio||0)>0.4?'warn':'good'">{{ (frame?.metrics?.pepLvetRatio||0).toFixed(3) }}</div><div class="note">Normal &lt; 0.40</div></div>
          <div class="metric"><div class="label">HR</div><div class="value">{{ (frame?.heartRateBpm||0).toFixed(1) }}<span class="unit">bpm</span></div></div>
        </div>
        <div class="note" style="margin-top:10px;">{{ statusMsg }}</div>
      </div>
    </div>
  </div>
</template>
