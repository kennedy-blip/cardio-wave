import { detectScgFiducials, computeTeiMetrics, clamp, movingAverage } from './rustHemodynamicsBridge.js';

export const SCG_PRESETS = {
  healthy: {
    id: 'healthy', label: 'Healthy Athletic Myocardium', hr: 68,
    ivct: 38, lvet: 295, ivrt: 62, aoPeakMg: 14, description: 'Tei 0.34, PEP/LVET 0.31',
  },
  systolic_dysfunction: {
    id: 'systolic_dysfunction', label: 'Reduced Ejection Systolic Dysfunction', hr: 76,
    ivct: 82, lvet: 235, ivrt: 68, aoPeakMg: 8, description: 'Prolonged IVCT 82 ms, Short LVET 235 ms, Tei 0.64',
  },
  diastolic_stiffness: {
    id: 'diastolic_stiffness', label: 'Diastolic Stiffness / Impaired Relaxation', hr: 72,
    ivct: 45, lvet: 285, ivrt: 115, aoPeakMg: 11, description: 'Prolonged IVRT 115 ms, Tei 0.52',
  },
  hyperdynamic: {
    id: 'hyperdynamic', label: 'Hyperdynamic Sympathetic Surge', hr: 110,
    ivct: 28, lvet: 260, ivrt: 55, aoPeakMg: 18, description: 'Short IVCT 28 ms, High AO Peak 18 mG',
  },
};

function synthScgBeat(tInBeat, preset) {
  // tInBeat in seconds from beat start (0..period)
  const ms = tInBeat * 1000;
  const { ivct, lvet, ivrt, aoPeakMg } = preset;
  const mc = 80; // ms
  const ao = mc + ivct;
  const re = ao + Math.min(60, lvet * 0.25);
  const ac = ao + lvet;
  const mo = ac + ivrt;
  let a = 0;
  // MC dip
  a += -0.25 * aoPeakMg * Math.exp(-Math.pow((ms - mc) / 10, 2));
  // AO peak
  a += aoPeakMg * Math.exp(-Math.pow((ms - ao) / 12, 2));
  // RE peak
  a += 0.55 * aoPeakMg * Math.exp(-Math.pow((ms - re) / 14, 2));
  // AC dip
  a += -0.35 * aoPeakMg * Math.exp(-Math.pow((ms - ac) / 10, 2));
  // MO bump
  a += 0.30 * aoPeakMg * Math.exp(-Math.pow((ms - mo) / 12, 2));
  // baseline micro-vibration
  a += 0.15 * Math.sin(2 * Math.PI * 12 * tInBeat) * Math.exp(-tInBeat * 1.5);
  a += 0.03 * (Math.random() * 2 - 1);
  return a;
}

export function generateScgSignal(presetKey = 'healthy', durationSec = 6, fs = 200) {
  const preset = SCG_PRESETS[presetKey] || SCG_PRESETS.healthy;
  const n = Math.floor(durationSec * fs);
  const out = new Float64Array(n);
  const period = 60 / preset.hr;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const tInBeat = t % period;
    out[i] = synthScgBeat(tInBeat, preset);
  }
  return { signal: out, fs, preset };
}

export function analyzeScg(signal, fs, presetHint = null) {
  const sm = movingAverage(Array.from(signal), Math.max(1, Math.round(0.008 * fs)));
  // Find beats by AO peaks using simple energy peaks
  const win = Math.round(0.8 * fs);
  const beats = [];
  let last = -win;
  for (let i = Math.round(0.05 * fs); i < sm.length - Math.round(0.45 * fs); i++) {
    if (i - last < Math.round(0.4 * fs)) continue;
    const v = sm[i];
    let isMax = true;
    for (let j = Math.max(0, i - 5); j <= Math.min(sm.length - 1, i + 5); j++) {
      if (sm[j] > v) { isMax = false; break; }
    }
    if (isMax && v > 0.5) {
      beats.push(i);
      last = i;
    }
  }
  // If we didn't detect enough beats, use preset hint or synthesize fiducials
  const fiducials = [];
  if (beats.length > 0) {
    for (const b of beats.slice(-6)) {
      const start = Math.max(0, b - Math.round(0.12 * fs));
      const end = Math.min(sm.length, b + Math.round(0.45 * fs));
      const seg = sm.slice(start, end);
      const f = detectScgFiducials(seg, fs, (start / fs) * 1000);
      fiducials.push(f);
    }
  }
  // Aggregate
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const ivcts = fiducials.map((f) => f.aoMs - f.mcMs).filter((v) => v > 10 && v < 200);
  const lvets = fiducials.map((f) => f.acMs - f.aoMs).filter((v) => v > 100 && v < 500);
  const ivrts = fiducials.map((f) => f.moMs - f.acMs).filter((v) => v > 20 && v < 250);

  let ivct = avg(ivcts), lvet = avg(lvets), ivrt = avg(ivrts);
  if (presetHint) {
    if (!ivct) ivct = presetHint.ivct;
    if (!lvet) lvet = presetHint.lvet;
    if (!ivrt) ivrt = presetHint.ivrt;
  }
  if (!ivct) ivct = 40; if (!lvet) lvet = 280; if (!ivrt) ivrt = 70;
  const metrics = computeTeiMetrics(ivct, lvet, ivrt);
  const hr = beats.length >= 2 ? 60 / (((beats[beats.length - 1] - beats[0]) / fs) / (beats.length - 1)) : (presetHint?.hr || 72);
  return { smoothed: sm, beats, fiducials, metrics, heartRateBpm: hr };
}

export function buildWiggersSeries(metrics, hr = 72, durationSec = 2) {
  const fs = 200;
  const n = Math.floor(durationSec * fs);
  const period = 60 / clamp(hr, 35, 180);
  const { ivctMs, lvetMs, ivrtMs } = metrics;
  const mc = 0.08;
  const ao = mc + ivctMs / 1000;
  const ac = ao + lvetMs / 1000;
  const mo = ac + ivrtMs / 1000;
  const t = [], lvp = [], aop = [], lvVol = [], pcg = [], scg = [];
  for (let i = 0; i < n; i++) {
    const tt = i / fs;
    const ph = tt % period;
    t.push(tt);
    // Simplified Wiggers pressures (mmHg)
    let lv = 10, aoP = 80;
    if (ph < mc) { lv = 10 + 5 * (ph / mc); aoP = 78 - 5 * (ph / period); }
    else if (ph < ao) { const p = (ph - mc) / Math.max(0.001, ao - mc); lv = 15 + 65 * p; aoP = 75 + 5 * p; }
    else if (ph < ac) { const p = (ph - ao) / Math.max(0.001, ac - ao); lv = 80 + 40 * Math.sin(Math.PI * p); aoP = 80 + 40 * Math.sin(Math.PI * Math.pow(p, 0.8)); }
    else if (ph < mo) { const p = (ph - ac) / Math.max(0.001, mo - ac); lv = 80 - 70 * p; aoP = 95 - 20 * p + 5 * Math.exp(-Math.pow((p - 0.3) / 0.15, 2)); }
    else { const p = (ph - mo) / Math.max(0.001, period - mo); lv = 10 + 8 * (1 - Math.exp(-3 * p)); aoP = 75 - 5 * p; }
    lvp.push(lv); aop.push(aoP);
    // LV volume (mL) stylized
    let vol = 120;
    if (ph < ac) { const p = clamp((ph - ao) / Math.max(0.001, ac - ao), 0, 1); vol = 120 - 70 * Math.sin(Math.PI * p * 0.9); }
    else { const p = clamp((ph - ac) / Math.max(0.001, period - ac), 0, 1); vol = 50 + 70 * (1 - Math.exp(-4 * p)); }
    lvVol.push(vol);
    // PCG marker
    let s = 0;
    s += 0.8 * Math.exp(-Math.pow((ph - 0.02) / 0.015, 2));
    s += 0.7 * Math.exp(-Math.pow((ph - ac / period) / 0.012, 2));
    pcg.push(s);
    // SCG marker
    let sc = 0;
    sc += -0.3 * Math.exp(-Math.pow((ph - mc / period) / 0.01, 2));
    sc += 1.0 * Math.exp(-Math.pow((ph - ao / period) / 0.012, 2));
    sc += -0.35 * Math.exp(-Math.pow((ph - ac / period) / 0.01, 2));
    sc += 0.3 * Math.exp(-Math.pow((ph - mo / period) / 0.012, 2));
    scg.push(sc);
  }
  return { t, lvp, aop, lvVol, pcg, scg, fs };
}

export class ScgMechanocardiogramEngine {
  constructor() {
    this.running = false;
    this.fs = 100; // effective sampling
    this.buffer = [];
    this.maxSec = 8;
    this.simInterval = null;
    this.simPreset = 'healthy';
    this.onFrame = null;
    this._motionHandler = null;
  }

  startSimulator(presetKey = 'healthy') {
    this.stop();
    this.simPreset = presetKey;
    this.fs = 200;
    this.running = true;
    let t = 0;
    const dt = 1 / this.fs;
    this.simInterval = setInterval(() => {
      if (!this.running) return;
      const preset = SCG_PRESETS[this.simPreset] || SCG_PRESETS.healthy;
      const period = 60 / preset.hr;
      for (let i = 0; i < 20; i++) {
        const tInBeat = t % period;
        this.buffer.push(synthScgBeat(tInBeat, preset));
        t += dt;
      }
      const maxLen = this.maxSec * this.fs;
      if (this.buffer.length > maxLen) this.buffer.splice(0, this.buffer.length - maxLen);
      this._emit();
    }, 100);
  }

  async startDeviceMotion() {
    this.stop();
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm !== 'granted') throw new Error('Motion permission denied');
    }
    this.fs = 60;
    this.running = true;
    let lastTs = 0;
    this._motionHandler = (e) => {
      if (!this.running) return;
      const now = performance.now();
      if (now - lastTs < 8) return; // ~125Hz cap
      lastTs = now;
      const az = e.acceleration?.z ?? e.accelerationIncludingGravity?.z ?? 0;
      // convert m/s^2 to mG approx for display consistency
      this.buffer.push(az * 101.9716);
      const maxLen = this.maxSec * this.fs;
      if (this.buffer.length > maxLen) this.buffer.splice(0, this.buffer.length - maxLen);
      if (this.buffer.length % 10 === 0) this._emit();
    };
    window.addEventListener('devicemotion', this._motionHandler, true);
  }

  _emit() {
    if (!this.onFrame) return;
    const preset = SCG_PRESETS[this.simPreset] || SCG_PRESETS.healthy;
    const signal = this.buffer.slice(-this.fs * 4);
    if (signal.length < this.fs) return;
    const analysis = analyzeScg(signal, this.fs, preset);
    const wiggers = buildWiggersSeries(analysis.metrics, analysis.heartRateBpm, 2);
    this.onFrame({ ...analysis, wiggers, fs: this.fs, preset });
  }

  stop() {
    this.running = false;
    if (this.simInterval) { clearInterval(this.simInterval); this.simInterval = null; }
    if (this._motionHandler) { window.removeEventListener('devicemotion', this._motionHandler, true); this._motionHandler = null; }
    this.buffer = [];
  }
}
