import { clamp, mean } from './rustHemodynamicsBridge.js';

export const ORTHO_PRESETS = {
  normal: {
    id: 'normal', label: 'Normal Baroreflex Response',
    baselineHr: 64, uprightHr: 76, ratio30_15: 1.14, lfHfSupine: 0.8, lfHfUpright: 1.6,
    description: '+12 bpm, 30:15 Ratio 1.14',
  },
  pots: {
    id: 'pots', label: 'Classic Hyperadrenergic POTS',
    baselineHr: 70, uprightHr: 108, ratio30_15: 1.06, lfHfSupine: 1.2, lfHfUpright: 4.8,
    description: '+38 bpm Sustained Tachycardia, LF/HF 4.8',
  },
  neuropathic: {
    id: 'neuropathic', label: 'Neuropathic Autonomic Blunting',
    baselineHr: 72, uprightHr: 84, ratio30_15: 0.99, lfHfSupine: 0.7, lfHfUpright: 1.1,
    description: '30:15 Ratio 0.99, Delayed PTT Shortening',
  },
  presyncope: {
    id: 'presyncope', label: 'Vasovagal Pre-Syncope Biphasic Drop',
    baselineHr: 66, uprightHr: 95, ratio30_15: 1.02, lfHfSupine: 0.9, lfHfUpright: 3.2, biphasic: true,
    description: 'Initial Tachycardia followed by Sudden Bradycardic Dip',
  },
};

export function generateRrSeries(presetKey = 'normal', durationMin = 10) {
  const preset = ORTHO_PRESETS[presetKey] || ORTHO_PRESETS.normal;
  const totalSec = durationMin * 60;
  const rr = [];
  const timeline = []; // {tSec, hr, phase}
  let t = 0;
  const supineSec = 120; // 2 min supine
  const standSec = 120;  // stand at 2 min
  while (t < totalSec) {
    let hr = preset.baselineHr;
    let phase = 'supine';
    if (t >= standSec) {
      phase = 'upright';
      const dtStand = t - standSec;
      if (preset.biphasic && dtStand > 180 && dtStand < 260) {
        // vasovagal dip
        const dip = Math.exp(-Math.pow((dtStand - 220) / 25, 2));
        hr = preset.uprightHr - 35 * dip;
      } else if (dtStand < 15) {
        // immediate rise around beat 15
        hr = preset.baselineHr + (preset.uprightHr - preset.baselineHr) * (dtStand / 15) + 8;
      } else if (dtStand < 35) {
        // around beat 30 vagal rebound
        const rebound = (preset.ratio30_15 - 1.0) * 25;
        hr = preset.uprightHr + 5 - rebound * Math.exp(-Math.pow((dtStand - 25) / 6, 2));
      } else {
        hr = preset.uprightHr + 2 * Math.sin(t * 0.05);
      }
    } else {
      hr = preset.baselineHr + 1.5 * Math.sin(t * 0.08);
    }
    // respiratory sinus arrhythmia modulation
    hr += 2.0 * Math.sin(2 * Math.PI * 0.25 * t);
    hr = clamp(hr, 35, 180);
    const rrMs = 60000 / hr;
    rr.push(rrMs);
    timeline.push({ tSec: t, hr, phase, rrMs });
    t += rrMs / 1000;
  }
  return { rr, timeline, preset, standSec };
}

export function computeRmssd(rrMs) {
  if (rrMs.length < 2) return 0;
  let acc = 0;
  for (let i = 1; i < rrMs.length; i++) { const d = rrMs[i] - rrMs[i - 1]; acc += d * d; }
  return Math.sqrt(acc / (rrMs.length - 1));
}

export function computeSdnn(rrMs) {
  if (rrMs.length < 2) return 0;
  const m = mean(rrMs);
  let acc = 0;
  for (const v of rrMs) { const d = v - m; acc += d * d; }
  return Math.sqrt(acc / rrMs.length);
}

export function lombScargleSimple(rrMs) {
  // Simplified HRV spectral estimate on evenly-resampled RR tachogram
  const n = rrMs.length;
  if (n < 16) return { vlf: 0, lf: 0, hf: 0, lfHf: 0 };
  // Resample at 4 Hz using cumulative time
  const fs = 4;
  const times = [];
  let acc = 0;
  for (let i = 0; i < n; i++) { times.push(acc); acc += rrMs[i] / 1000; }
  const totalT = acc;
  if (totalT < 30) return { vlf: 0, lf: 0, hf: 0, lfHf: 0 };
  const m = Math.floor(totalT * fs);
  const resampled = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    const t = i / fs;
    // find surrounding RR points
    let idx = 0;
    while (idx < times.length - 1 && times[idx + 1] < t) idx++;
    resampled[i] = rrMs[Math.min(idx, rrMs.length - 1)];
  }
  const meanV = mean(resampled);
  for (let i = 0; i < m; i++) resampled[i] -= meanV;

  const powerAt = (f) => {
    let re = 0, im = 0;
    for (let i = 0; i < m; i++) {
      const ang = 2 * Math.PI * f * (i / fs);
      re += resampled[i] * Math.cos(ang);
      im -= resampled[i] * Math.sin(ang);
    }
    return (re * re + im * im) / (m * m);
  };
  const integrate = (fLo, fHi) => {
    let area = 0;
    const step = 0.002;
    let prev = powerAt(fLo);
    for (let f = fLo + step; f <= fHi; f += step) {
      const cur = powerAt(f);
      area += 0.5 * (prev + cur) * step;
      prev = cur;
    }
    return area;
  };
  const vlf = integrate(0.003, 0.04);
  const lf = integrate(0.04, 0.15);
  const hf = integrate(0.15, 0.40);
  return { vlf, lf, hf, lfHf: hf > 1e-12 ? lf / hf : 0 };
}

export function evaluateEwing30_15(rrAfterStand) {
  const n = rrAfterStand.length;
  if (n < 20) return { ratio: 0, rrMax30: 0, rrMin15: 0, classification: 'Insufficient data', normal: false };
  const lo30 = Math.min(25, n - 5), hi30 = Math.min(35, n - 1);
  const lo15 = 10, hi15 = Math.min(20, n - 1);
  let rrMax30 = rrAfterStand[lo30];
  for (let i = lo30; i <= hi30; i++) if (rrAfterStand[i] > rrMax30) rrMax30 = rrAfterStand[i];
  let rrMin15 = rrAfterStand[lo15];
  for (let i = lo15; i <= hi15; i++) if (rrAfterStand[i] < rrMin15) rrMin15 = rrAfterStand[i];
  const ratio = rrMin15 > 0 ? rrMax30 / rrMin15 : 0;
  let classification = 'Impaired Vagal Baroreflex';
  let normal = false;
  if (ratio >= 1.04) { classification = 'Normal Parasympathetic Vagal Rebound'; normal = true; }
  else if (ratio >= 1.01) { classification = 'Borderline Vagal Response'; }
  return { ratio, rrMax30, rrMin15, classification, normal };
}

export function evaluatePots(baselineHr, peakUprightHr, sustainedHr, ageYears = 30) {
  const delta = sustainedHr - baselineHr;
  const threshold = (ageYears > 0 && ageYears <= 19) ? 40 : 30;
  const meets = (delta >= threshold || sustainedHr >= 120) && baselineHr > 0;
  let classification = 'Normal Orthostatic Response';
  if (delta >= threshold || sustainedHr >= 120) classification = meets ? 'Meets POTS Hemodynamic Criteria (screening)' : 'Transient Orthostatic Tachycardia';
  else if (delta >= 20) classification = 'Mild Orthostatic Tachycardia';
  return { baselineHr, peakUprightHr, sustainedHr, deltaHr: delta, threshold, meets, classification };
}

export class OrthostaticAutonomicEngine {
  constructor() {
    this.running = false;
    this.simInterval = null;
    this.simPreset = 'normal';
    this.timeline = [];
    this.rr = [];
    this.onFrame = null;
    this.phase = 'idle'; // idle | supine | upright
    this.standAtSec = 120;
    this.elapsedSec = 0;
    this.tiltDeg = 0;
  }

  startSimulator(presetKey = 'normal') {
    this.stop();
    this.simPreset = presetKey;
    this.running = true;
    const data = generateRrSeries(presetKey, 10);
    this.timeline = data.timeline;
    this.rr = data.rr;
    this.standAtSec = data.standSec;
    this.elapsedSec = 0;
    let idx = 0;
    this.simInterval = setInterval(() => {
      if (!this.running) return;
      // advance ~2 seconds per tick
      const targetT = this.elapsedSec + 2;
      while (idx < this.timeline.length && this.timeline[idx].tSec < targetT) idx++;
      this.elapsedSec = targetT;
      this.phase = this.elapsedSec >= this.standAtSec ? 'upright' : 'supine';
      this.tiltDeg = this.phase === 'upright' ? 90 : 0;
      this._emit(idx);
      if (this.elapsedSec >= 600) this.elapsedSec = 600;
    }, 200);
  }

  _emit(idx) {
    if (!this.onFrame) return;
    const slice = this.timeline.slice(0, Math.max(1, idx));
    const rrSlice = slice.map((p) => p.rrMs);
    const supineSlice = slice.filter((p) => p.tSec < this.standAtSec);
    const uprightSlice = slice.filter((p) => p.tSec >= this.standAtSec);
    const baselineHr = supineSlice.length ? mean(supineSlice.slice(-30).map((p) => p.hr)) : 0;
    const uprightHr = uprightSlice.length ? mean(uprightSlice.slice(-30).map((p) => p.hr)) : baselineHr;
    const peakUprightHr = uprightSlice.length ? Math.max(...uprightSlice.map((p) => p.hr)) : baselineHr;
    const afterStandRr = uprightSlice.slice(0, 45).map((p) => p.rrMs);
    const ewing = evaluateEwing30_15(afterStandRr);
    const pots = evaluatePots(baselineHr, peakUprightHr, uprightHr, 30);
    const hrvSupine = lombScargleSimple(supineSlice.map((p) => p.rrMs));
    const hrvUpright = lombScargleSimple(uprightSlice.map((p) => p.rrMs));
    this.onFrame({
      elapsedSec: this.elapsedSec, phase: this.phase, tiltDeg: this.tiltDeg,
      baselineHr, uprightHr, peakUprightHr, ewing, pots,
      hrvSupine, hrvUpright,
      rmssd: computeRmssd(rrSlice.slice(-60)),
      sdnn: computeSdnn(rrSlice.slice(-60)),
      timeline: slice.slice(-300),
      standAtSec: this.standAtSec,
    });
  }

  triggerStand() {
    this.standAtSec = this.elapsedSec;
    this.phase = 'upright';
    this.tiltDeg = 90;
  }

  stop() {
    this.running = false;
    if (this.simInterval) { clearInterval(this.simInterval); this.simInterval = null; }
  }
}
