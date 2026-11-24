import {
  bandpassFilter,
  shannonEnvelope,
  segmentS1S2,
  clamp,
} from './rustHemodynamicsBridge.js';

export const AUSCULTATION_SITES = [
  { id: 'aortic', label: 'Aortic', pos: '2nd RICS', x: 42, y: 28, note: 'A2 closure, aortic stenosis ejection murmur' },
  { id: 'pulmonic', label: 'Pulmonic', pos: '2nd LICS', x: 58, y: 28, note: 'Physiological respiratory A2-P2 split' },
  { id: 'tricuspid', label: 'Tricuspid', pos: '4th LLSB', x: 52, y: 46, note: 'RV S3/S4, tricuspid flow' },
  { id: 'mitral', label: 'Mitral / Apical', pos: '5th LICS MCL', x: 64, y: 58, note: 'S1 intensity, S3 gallop, pansystolic MR' },
];

export const PCG_MODES = {
  bell: { id: 'bell', label: 'Bell 25–150 Hz', low: 25, high: 150 },
  diaphragm: { id: 'diaphragm', label: 'Diaphragm 80–500 Hz', low: 80, high: 500 },
  wideband: { id: 'wideband', label: 'Wideband 20–600 Hz', low: 20, high: 600 },
};

export const PCG_PRESETS = {
  normal: {
    id: 'normal', label: 'Normal Sinus Rhythm', hr: 72, splitMs: 35,
    murmur: null, s3: false, description: 'S1 + physiological inspiration A2-P2 split 35 ms',
  },
  aortic_stenosis: {
    id: 'aortic_stenosis', label: 'Aortic Stenosis', hr: 78, splitMs: 20,
    murmur: { type: 'systolic_crescendo_decrescendo', freq: 220, amp: 0.35 }, s3: false,
    description: 'Crescendo-decrescendo diamond murmur 120–380 Hz',
  },
  mitral_regurgitation: {
    id: 'mitral_regurgitation', label: 'Mitral Regurgitation', hr: 82, splitMs: 25,
    murmur: { type: 'holosystolic_plateau', freq: 180, amp: 0.28 }, s3: false, softS1: true,
    description: 'Holosystolic blowing plateau + soft S1',
  },
  s3_gallop: {
    id: 's3_gallop', label: 'Ventricular S3 Gallop', hr: 96, splitMs: 30,
    murmur: null, s3: true,
    description: 'S3 "Kentucky" cadence at ~42 Hz',
  },
};

function hann(n, N) { return 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1))); }

function synthPcgSample(t, preset) {
  const hr = preset.hr || 72;
  const period = 60 / hr;
  const phase = (t % period) / period; // 0..1 within beat
  let s = 0;

  // S1 at ~0.0 (60ms burst ~40-60Hz)
  const s1Amp = preset.softS1 ? 0.35 : 0.8;
  s += s1Amp * Math.exp(-Math.pow((phase - 0.02) / 0.018, 2)) * Math.sin(2 * Math.PI * 55 * t);
  s += s1Amp * 0.5 * Math.exp(-Math.pow((phase - 0.025) / 0.015, 2)) * Math.sin(2 * Math.PI * 90 * t);

  // S2 A2 at ~0.35, P2 split
  const s2Base = 0.32;
  const split = (preset.splitMs || 30) / 1000 / period; // in phase units approx
  const p2Phase = s2Base + clamp(split, 0.01, 0.08);
  s += 0.7 * Math.exp(-Math.pow((phase - s2Base) / 0.012, 2)) * Math.sin(2 * Math.PI * 70 * t);
  s += 0.45 * Math.exp(-Math.pow((phase - p2Phase) / 0.012, 2)) * Math.sin(2 * Math.PI * 85 * t);

  // S3 gallop at ~0.55 (low freq 42Hz)
  if (preset.s3) {
    s += 0.28 * Math.exp(-Math.pow((phase - 0.52) / 0.03, 2)) * Math.sin(2 * Math.PI * 42 * t);
  }

  // Murmurs
  if (preset.murmur) {
    const m = preset.murmur;
    if (m.type === 'systolic_crescendo_decrescendo') {
      // between S1 and S2
      if (phase > 0.05 && phase < 0.30) {
        const p = (phase - 0.05) / 0.25;
        const env = Math.sin(Math.PI * p); // diamond
        s += m.amp * env * (Math.sin(2 * Math.PI * m.freq * t) + 0.5 * Math.sin(2 * Math.PI * (m.freq * 1.5) * t));
      }
    } else if (m.type === 'holosystolic_plateau') {
      if (phase > 0.03 && phase < 0.33) {
        s += m.amp * 0.8 * (Math.sin(2 * Math.PI * m.freq * t) + 0.4 * Math.sin(2 * Math.PI * (m.freq + 60) * t));
      }
    }
  }

  // faint background noise
  s += 0.01 * (Math.random() * 2 - 1);
  return s;
}

export function generatePcgSignal(presetKey = 'normal', durationSec = 4, fs = 1000) {
  const preset = PCG_PRESETS[presetKey] || PCG_PRESETS.normal;
  const n = Math.floor(durationSec * fs);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = synthPcgSample(i / fs, preset);
  }
  return { signal: out, fs, preset };
}

export function analyzePcg(signal, fs, mode = 'wideband') {
  const m = PCG_MODES[mode] || PCG_MODES.wideband;
  const filtered = bandpassFilter(Array.from(signal), m.low, m.high, fs);
  const envWindow = Math.max(8, Math.round(fs * 0.02));
  const envHop = Math.max(2, Math.round(fs * 0.005));
  const env = shannonEnvelope(filtered, envWindow, envHop);
  const envFs = fs / envHop;
  const seg = segmentS1S2(env, envFs);
  // Map indices back to signal sample indices for plotting
  const s1Samples = seg.s1.map((i) => i * envHop);
  const s2Samples = seg.s2.map((i) => i * envHop);
  return {
    filtered,
    envelope: env,
    envFs,
    envHop,
    heartRateBpm: seg.heartRateBpm,
    a2p2SplitMs: seg.a2p2SplitMs,
    systolicMurmurRatioDb: seg.systolicMurmurRatioDb,
    diastolicMurmurRatioDb: seg.diastolicMurmurRatioDb,
    s1Samples,
    s2Samples,
  };
}

export function computeSpectrogram(signal, fs, fftSize = 256, hop = 128, maxFreq = 600) {
  // Simple DFT-based spectrogram for portability (small FFT size keeps it fast enough)
  const n = signal.length;
  if (n < fftSize) return { frames: [], freqBins: [], hop, fftSize };
  const bins = Math.floor(fftSize / 2);
  const freqBins = new Array(bins);
  for (let i = 0; i < bins; i++) freqBins[i] = (i * fs) / fftSize;
  const maxBin = Math.min(bins, Math.floor((maxFreq / fs) * fftSize) + 1);
  const frames = [];
  for (let start = 0; start + fftSize <= n; start += hop) {
    const re = new Array(maxBin).fill(0);
    const im = new Array(maxBin).fill(0);
    for (let k = 0; k < maxBin; k++) {
      let r = 0, ii = 0;
      const w = -2 * Math.PI * k / fftSize;
      for (let t = 0; t < fftSize; t++) {
        const sample = (signal[start + t] || 0) * hann(t, fftSize);
        const angle = w * t;
        r += sample * Math.cos(angle);
        ii += sample * Math.sin(angle);
      }
      re[k] = r; im[k] = ii;
    }
    const mags = new Float32Array(maxBin);
    for (let k = 0; k < maxBin; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / fftSize;
      mags[k] = 20 * Math.log10(mag + 1e-8);
    }
    frames.push(mags);
  }
  return { frames, freqBins: freqBins.slice(0, maxBin), hop, fftSize, maxBin };
}

export class PcgAuscultationEngine {
  constructor() {
    this.audioCtx = null;
    this.analyser = null;
    this.sourceNode = null;
    this.micStream = null;
    this.running = false;
    this.mode = 'wideband';
    this.sampleBuffer = [];
    this.maxBufferSec = 6;
    this.fs = 48000;
    this.onFrame = null;
    this._raf = null;
    this.simInterval = null;
    this.simPreset = 'normal';
  }

  async startMicrophone() {
    this.stop();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx({ sampleRate: 48000 });
    this.fs = this.audioCtx.sampleRate;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.micStream = stream;
    this.sourceNode = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.25;
    this.sourceNode.connect(this.analyser);
    this.running = true;
    this._pump();
  }

  startSimulator(presetKey = 'normal') {
    this.stop();
    this.simPreset = presetKey;
    this.fs = 1000;
    this.running = true;
    let t = 0;
    const dt = 1 / this.fs;
    const chunk = 50; // 50ms
    this.simInterval = setInterval(() => {
      if (!this.running) return;
      const preset = PCG_PRESETS[this.simPreset] || PCG_PRESETS.normal;
      for (let i = 0; i < chunk; i++) {
        this.sampleBuffer.push(synthPcgSample(t, preset));
        t += dt;
      }
      const maxLen = this.maxBufferSec * this.fs;
      if (this.sampleBuffer.length > maxLen) this.sampleBuffer.splice(0, this.sampleBuffer.length - maxLen);
      this._emitAnalysis();
    }, 50);
  }

  _pump() {
    if (!this.running || !this.analyser) return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    // Downsample to ~1000Hz for DSP efficiency
    const dsFactor = Math.max(1, Math.round(this.fs / 1000));
    for (let i = 0; i < buf.length; i += dsFactor) this.sampleBuffer.push(buf[i]);
    const dsFs = this.fs / dsFactor;
    const maxLen = this.maxBufferSec * dsFs;
    if (this.sampleBuffer.length > maxLen) this.sampleBuffer.splice(0, this.sampleBuffer.length - maxLen);
    this._lastDsFs = dsFs;
    this._emitAnalysis();
    this._raf = requestAnimationFrame(() => this._pump());
  }

  _emitAnalysis() {
    if (!this.onFrame) return;
    const fs = this._lastDsFs || this.fs;
    const signal = this.sampleBuffer.slice(-Math.min(this.sampleBuffer.length, fs * 4));
    if (signal.length < fs * 0.5) return;
    const analysis = analyzePcg(signal, fs, this.mode);
    const spec = computeSpectrogram(analysis.filtered, fs, 256, 64, 600);
    this.onFrame({ ...analysis, spectrogram: spec, fs, mode: this.mode, raw: signal });
  }

  setMode(mode) { this.mode = PCG_MODES[mode] ? mode : 'wideband'; }
  setPreset(preset) { this.simPreset = preset; }

  stop() {
    this.running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this.simInterval) { clearInterval(this.simInterval); this.simInterval = null; }
    if (this.micStream) { this.micStream.getTracks().forEach((t) => t.stop()); this.micStream = null; }
    if (this.sourceNode) { try { this.sourceNode.disconnect(); } catch {} this.sourceNode = null; }
    if (this.analyser) { try { this.analyser.disconnect(); } catch {} this.analyser = null; }
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    this.sampleBuffer = [];
  }
}
