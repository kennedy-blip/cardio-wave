import { fitQcrt, clamp, mean } from './rustHemodynamicsBridge.js';

export const CRT_PRESETS = {
  normal: {
    id: 'normal', label: 'Normal Euvolemic Perfusion',
    tau: 0.65, base: 0.82, blanch: 0.35, pi: 4.2, description: 't90 < 2.0s, healthy refill',
  },
  borderline: {
    id: 'borderline', label: 'Borderline Delayed Refill',
    tau: 1.05, base: 0.78, blanch: 0.30, pi: 1.8, description: 't90 2.0–3.0s, mild dehydration/cold',
  },
  prolonged: {
    id: 'prolonged', label: 'Significantly Prolonged Refill',
    tau: 1.8, base: 0.72, blanch: 0.28, pi: 0.35, description: 't90 > 3.0s, low perfusion',
  },
  raynaud: {
    id: 'raynaud', label: "Raynaud's Vasospasm Pattern",
    tau: 2.4, base: 0.68, blanch: 0.25, pi: 0.22, description: 'Delayed refill with low PI',
  },
};

export function hemoglobinIndexFromRgb(r, g, b) {
  const rr = Math.max(r, 1e-4);
  const gg = Math.max(g, 1e-4);
  return Math.log10(rr / gg);
}

export function computePiFromSeries(values, fs) {
  if (!values?.length || values.length < fs) return 0;
  // Use last 2 seconds
  const slice = values.slice(-Math.max(10, Math.floor(fs * 2)));
  const dc = mean(slice);
  let minV = Infinity, maxV = -Infinity;
  for (const v of slice) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
  const ac = maxV - minV;
  if (dc <= 1e-9) return 0;
  return clamp((ac / Math.abs(dc)) * 100, 0, 20);
}

export function generateCrtSignal(presetKey = 'normal', durationSec = 12, fs = 30) {
  const preset = CRT_PRESETS[presetKey] || CRT_PRESETS.normal;
  const n = Math.floor(durationSec * fs);
  const t = [];
  const hb = [];
  const releaseSec = 4.0; // compression release at 4s
  const compressSec = 1.5;
  for (let i = 0; i < n; i++) {
    const tt = i / fs;
    t.push(tt);
    let v = preset.base;
    // pulsatile AC component
    v += 0.01 * (preset.pi / 4) * Math.sin(2 * Math.PI * 1.2 * tt);
    if (tt >= compressSec && tt < releaseSec) {
      // blanch
      const p = (tt - compressSec) / (releaseSec - compressSec);
      v = preset.base - (preset.base - preset.blanch) * Math.min(1, p * 2);
    } else if (tt >= releaseSec) {
      const dt = tt - releaseSec;
      v = preset.blanch + (preset.base - preset.blanch) * (1 - Math.exp(-dt / preset.tau));
    }
    v += 0.003 * (Math.random() * 2 - 1);
    hb.push(v);
  }
  return { t, hb, fs, preset, releaseSec, compressSec };
}

export class CapillaryPerfusionEngine {
  constructor() {
    this.running = false;
    this.simInterval = null;
    this.simPreset = 'normal';
    this.onFrame = null;
    this.fs = 30;
    this.hbSeries = [];
    this.tSeries = [];
    this.startTime = 0;
    this.releaseTime = null;
    this.compressTime = null;
    this.phase = 'baseline'; // baseline | compressing | blanched | refilling | complete
    this._video = null;
    this._canvas = null;
    this._ctx = null;
    this._raf = null;
    this._stream = null;
  }

  startSimulator(presetKey = 'normal') {
    this.stop();
    this.simPreset = presetKey;
    this.running = true;
    this.fs = 30;
    this.hbSeries = [];
    this.tSeries = [];
    this.startTime = performance.now();
    this.releaseTime = null;
    this.compressTime = null;
    this.phase = 'baseline';
    const preset = CRT_PRESETS[presetKey] || CRT_PRESETS.normal;

    this.simInterval = setInterval(() => {
      if (!this.running) return;
      const tSec = (performance.now() - this.startTime) / 1000;
      // auto protocol: baseline 1.5s, compress 2.5s, release, refill
      if (tSec >= 1.5 && this.phase === 'baseline') { this.phase = 'compressing'; this.compressTime = tSec; }
      if (tSec >= 4.0 && (this.phase === 'compressing' || this.phase === 'blanched')) { this.phase = 'refilling'; this.releaseTime = tSec; }

      let v = preset.base;
      v += 0.01 * (preset.pi / 4) * Math.sin(2 * Math.PI * 1.2 * tSec);
      if (this.phase === 'compressing' || this.phase === 'blanched') {
        const p = clamp((tSec - (this.compressTime || 1.5)) / 1.0, 0, 1);
        v = preset.base - (preset.base - preset.blanch) * p;
        if (p >= 1) this.phase = 'blanched';
      } else if (this.phase === 'refilling' && this.releaseTime != null) {
        const dt = tSec - this.releaseTime;
        v = preset.blanch + (preset.base - preset.blanch) * (1 - Math.exp(-dt / preset.tau));
        if (dt > 6) this.phase = 'complete';
      }
      v += 0.003 * (Math.random() * 2 - 1);

      this.tSeries.push(tSec);
      this.hbSeries.push(v);
      if (this.tSeries.length > 600) { this.tSeries.shift(); this.hbSeries.shift(); }
      this._emit();
    }, 1000 / this.fs);
  }

  _emit() {
    if (!this.onFrame) return;
    const pi = computePiFromSeries(this.hbSeries, this.fs);
    let fit = { tauSeconds: 0, t90Seconds: 0, r2: 0, classification: 'Awaiting refill', aBase: 0, aBlanch: 0 };
    if (this.releaseTime != null) {
      const relIdx = this.tSeries.findIndex((t) => t >= this.releaseTime);
      if (relIdx >= 0 && this.tSeries.length - relIdx > 10) {
        const tRel = this.tSeries.slice(relIdx).map((t) => t - this.releaseTime);
        const vRel = this.hbSeries.slice(relIdx);
        fit = fitQcrt(tRel, vRel);
      }
    }
    const currentHb = this.hbSeries.length ? this.hbSeries[this.hbSeries.length - 1] : 0;
    const base = this.hbSeries.length ? Math.max(...this.hbSeries.slice(0, Math.min(30, this.hbSeries.length))) : 0.8;
    const blanchIntensity = clamp(1 - currentHb / Math.max(0.1, base), 0, 1);
    const refillProgress = fit.t90Seconds > 0 ? clamp(( (this.tSeries[this.tSeries.length-1] - (this.releaseTime||0)) / fit.t90Seconds ), 0, 1) : 0;
    this.onFrame({
      tSeries: this.tSeries.slice(-300),
      hbSeries: this.hbSeries.slice(-300),
      phase: this.phase,
      releaseTime: this.releaseTime,
      piPercent: pi,
      fit,
      currentHb,
      blanchIntensity,
      refillProgress,
      preset: CRT_PRESETS[this.simPreset] || CRT_PRESETS.normal,
    });
  }

  async startCamera() {
    this.stop();
    this.running = true;
    this.fs = 30;
    this.hbSeries = [];
    this.tSeries = [];
    this.startTime = performance.now();
    this.phase = 'baseline';
    this.releaseTime = null;
    this._video = document.createElement('video');
    this._video.playsInline = true;
    this._video.muted = true;
    this._canvas = document.createElement('canvas');
    this._canvas.width = 160; this._canvas.height = 120;
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', frameRate: { ideal: 60 } }, audio: false });
      this._video.srcObject = this._stream;
      await this._video.play();
      const loop = () => {
        if (!this.running) return;
        this._sampleFrame();
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  _sampleFrame() {
    if (!this._ctx || !this._video || this._video.readyState < 2) return;
    const w = this._canvas.width, h = this._canvas.height;
    this._ctx.drawImage(this._video, 0, 0, w, h);
    const img = this._ctx.getImageData(0, 0, w, h).data;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    // sample center ROI
    const x0 = Math.floor(w * 0.3), x1 = Math.floor(w * 0.7);
    const y0 = Math.floor(h * 0.3), y1 = Math.floor(h * 0.7);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * w + x) * 4;
        rSum += img[idx] / 255; gSum += img[idx + 1] / 255; bSum += img[idx + 2] / 255; count++;
      }
    }
    if (!count) return;
    const hb = hemoglobinIndexFromRgb(rSum / count, gSum / count, bSum / count);
    // normalize to ~0-1 range for display
    const hbNorm = clamp((hb + 0.2) / 0.4, 0, 1);
    const tSec = (performance.now() - this.startTime) / 1000;
    this.tSeries.push(tSec);
    this.hbSeries.push(hbNorm);
    if (this.tSeries.length > 600) { this.tSeries.shift(); this.hbSeries.shift(); }
    // simple auto phase detection
    if (this.phase === 'baseline' && this.hbSeries.length > 30) {
      const recent = this.hbSeries.slice(-10);
      const base = mean(this.hbSeries.slice(0, 30));
      if (mean(recent) < base - 0.08) { this.phase = 'compressing'; this.compressTime = tSec; }
    }
    if ((this.phase === 'compressing' || this.phase === 'blanched') && this.hbSeries.length > 30) {
      const recent = this.hbSeries.slice(-5);
      const prev = this.hbSeries.slice(-15, -5);
      if (prev.length && mean(recent) > mean(prev) + 0.02) { this.phase = 'refilling'; this.releaseTime = this.releaseTime || tSec; }
    }
    if (this.hbSeries.length % 3 === 0) this._emit();
  }

  markRelease() { this.releaseTime = (performance.now() - this.startTime) / 1000; this.phase = 'refilling'; }
  markCompress() { this.compressTime = (performance.now() - this.startTime) / 1000; this.phase = 'compressing'; }

  getVideoElement() { return this._video; }

  stop() {
    this.running = false;
    if (this.simInterval) { clearInterval(this.simInterval); this.simInterval = null; }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._stream) { this._stream.getTracks().forEach((t) => t.stop()); this._stream = null; }
    this._video = null; this._canvas = null; this._ctx = null;
  }
}
