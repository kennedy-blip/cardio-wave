import { computePwvMetrics, detectPpgFoot, estimateMbp, clamp, movingAverage } from './rustHemodynamicsBridge.js';

export const PWV_PRESETS = {
  elastic: {
    id: 'elastic', label: 'Elastic Young Arteries', hr: 68, pttMs: 135, sbp: 118, dbp: 74,
    description: 'PWV ~6.3 m/s, compliant aorta',
  },
  borderline: {
    id: 'borderline', label: 'Borderline Stiffening', hr: 74, pttMs: 95, sbp: 132, dbp: 82,
    description: 'PWV ~8.9 m/s, early vascular aging',
  },
  stiff: {
    id: 'stiff', label: 'Clinically Stiff Arteries', hr: 78, pttMs: 78, sbp: 148, dbp: 88,
    description: 'PWV ~10.9 m/s, elevated stiffness',
  },
  athletic: {
    id: 'athletic', label: 'Athletic Low-Stiffness', hr: 58, pttMs: 150, sbp: 112, dbp: 68,
    description: 'PWV ~5.7 m/s, high compliance',
  },
};

function synthPpgBeat(tInBeat, period, pttMs) {
  // Simple PPG morphology: systolic upstroke, dicrotic notch
  const ph = tInBeat / period;
  const foot = 0.12;
  let v = 0.3;
  // systolic rise
  v += 0.55 * Math.exp(-Math.pow((ph - 0.22) / 0.06, 2));
  // dicrotic notch and wave
  v += 0.12 * Math.exp(-Math.pow((ph - 0.42) / 0.04, 2));
  v += 0.18 * Math.exp(-Math.pow((ph - 0.52) / 0.07, 2));
  // baseline decay
  v -= 0.05 * ph;
  v += 0.005 * (Math.random() * 2 - 1);
  return v;
}

function synthScgAoBeat(tInBeat, period) {
  const ph = tInBeat / period;
  let a = 0;
  a += 1.0 * Math.exp(-Math.pow((ph - 0.10) / 0.015, 2)); // AO
  a += -0.3 * Math.exp(-Math.pow((ph - 0.07) / 0.01, 2)); // MC
  a += -0.25 * Math.exp(-Math.pow((ph - 0.34) / 0.012, 2)); // AC
  a += 0.03 * (Math.random() * 2 - 1);
  return a;
}

export function generateDualChannel(presetKey = 'elastic', durationSec = 6, fs = 200) {
  const preset = PWV_PRESETS[presetKey] || PWV_PRESETS.elastic;
  const n = Math.floor(durationSec * fs);
  const period = 60 / preset.hr;
  const pttSec = preset.pttMs / 1000;
  const scg = new Float64Array(n);
  const ppg = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const tBeat = t % period;
    scg[i] = synthScgAoBeat(tBeat, period);
    // PPG delayed by PTT
    const tPpg = (t - pttSec);
    const tBeatPpg = ((tPpg % period) + period) % period;
    ppg[i] = synthPpgBeat(tBeatPpg, period, preset.pttMs);
  }
  return { scg, ppg, fs, preset };
}

export function computePttFromChannels(scg, ppg, fs) {
  // Find AO peaks in SCG and foot points in PPG per beat
  const scgSm = movingAverage(Array.from(scg), Math.max(1, Math.round(0.008 * fs)));
  const ppgSm = movingAverage(Array.from(ppg), Math.max(1, Math.round(0.01 * fs)));
  const minBeat = Math.round(0.4 * fs);
  const aoPeaks = [];
  for (let i = Math.round(0.05 * fs); i < scgSm.length - Math.round(0.1 * fs); i++) {
    if (aoPeaks.length && i - aoPeaks[aoPeaks.length - 1] < minBeat) continue;
    const v = scgSm[i];
    let isMax = true;
    for (let j = Math.max(0, i - 4); j <= Math.min(scgSm.length - 1, i + 4); j++) if (scgSm[j] > v) { isMax = false; break; }
    if (isMax && v > 0.4) aoPeaks.push(i);
  }
  const ptts = [];
  const pairs = [];
  for (const ao of aoPeaks) {
    // search for PPG foot in [ao, ao + 300ms]
    const start = ao;
    const end = Math.min(ppgSm.length, ao + Math.round(0.35 * fs));
    if (end - start < 10) continue;
    const seg = ppgSm.slice(start, end);
    const footLocal = detectPpgFoot(seg);
    const footIdx = start + footLocal;
    const pttMs = ((footIdx - ao) / fs) * 1000;
    if (pttMs > 40 && pttMs < 350) {
      ptts.push(pttMs);
      pairs.push({ aoIdx: ao, footIdx, pttMs });
    }
  }
  const meanPtt = ptts.length ? ptts.reduce((a, b) => a + b, 0) / ptts.length : 0;
  return { pttMs: meanPtt, pairs, scgSm, ppgSm };
}

export class PwvHemodynamicsEngine {
  constructor() {
    this.running = false;
    this.fs = 200;
    this.scgBuf = [];
    this.ppgBuf = [];
    this.maxSec = 8;
    this.simInterval = null;
    this.simPreset = 'elastic';
    this.onFrame = null;
    this.heightCm = 170;
    this.mbp0 = 93;
    this.ptt0 = 120;
    this.gamma = 0.017;
    this._cameraStream = null;
    this._video = null;
    this._canvas = null;
    this._raf = null;
  }

  setAnthropometrics({ heightCm, mbp0, ptt0, gamma }) {
    if (heightCm) this.heightCm = heightCm;
    if (mbp0) this.mbp0 = mbp0;
    if (ptt0) this.ptt0 = ptt0;
    if (gamma) this.gamma = gamma;
  }

  startSimulator(presetKey = 'elastic') {
    this.stop();
    this.simPreset = presetKey;
    this.fs = 200;
    this.running = true;
    let t = 0;
    const dt = 1 / this.fs;
    this.simInterval = setInterval(() => {
      if (!this.running) return;
      const preset = PWV_PRESETS[this.simPreset] || PWV_PRESETS.elastic;
      const period = 60 / preset.hr;
      const pttSec = preset.pttMs / 1000;
      for (let i = 0; i < 20; i++) {
        const tBeat = t % period;
        this.scgBuf.push(synthScgAoBeat(tBeat, period));
        const tPpg = t - pttSec;
        const tBeatPpg = ((tPpg % period) + period) % period;
        this.ppgBuf.push(synthPpgBeat(tBeatPpg, period, preset.pttMs));
        t += dt;
      }
      const maxLen = this.maxSec * this.fs;
      if (this.scgBuf.length > maxLen) { this.scgBuf.splice(0, this.scgBuf.length - maxLen); this.ppgBuf.splice(0, this.ppgBuf.length - maxLen); }
      this._emit();
    }, 100);
  }

  _emit() {
    if (!this.onFrame) return;
    const n = Math.min(this.scgBuf.length, this.ppgBuf.length);
    if (n < this.fs) return;
    const scg = this.scgBuf.slice(-this.fs * 4);
    const ppg = this.ppgBuf.slice(-this.fs * 4);
    const { pttMs, pairs, scgSm, ppgSm } = computePttFromChannels(scg, ppg, this.fs);
    const preset = PWV_PRESETS[this.simPreset] || PWV_PRESETS.elastic;
    const effectivePtt = pttMs > 0 ? pttMs : preset.pttMs;
    const pathLengthM = 0.50 * (this.heightCm / 100);
    const metrics = computePwvMetrics(pathLengthM, effectivePtt);
    const mbpEst = estimateMbp(this.mbp0, this.ptt0, effectivePtt, this.gamma);
    // crude SBP/DBP excursion split
    const sbpEst = mbpEst + 0.55 * (preset.sbp - preset.dbp);
    const dbpEst = mbpEst - 0.45 * (preset.sbp - preset.dbp);
    this.onFrame({
      scg: scgSm, ppg: ppgSm, pairs, pttMs: effectivePtt, metrics,
      mbpEst, sbpEst, dbpEst, pathLengthM, fs: this.fs, preset,
    });
  }

  stop() {
    this.running = false;
    if (this.simInterval) { clearInterval(this.simInterval); this.simInterval = null; }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._cameraStream) { this._cameraStream.getTracks().forEach((t) => t.stop()); this._cameraStream = null; }
    this.scgBuf = []; this.ppgBuf = [];
  }
}
