/**
 * Rust Hemodynamics Bridge (JS mirror).
 * Provides deterministic JS implementations mirroring the Rust crate so the app
 * builds and runs on Vercel even without compiled WASM.
 * If a WASM module is later attached to window.__CARDIO_WAVE_WASM__, this bridge
 * can be extended to dispatch to it; by default it uses the JS mirror.
 */

const EPS = 1e-12;

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let v = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    v += d * d;
  }
  return Math.sqrt(v / arr.length);
}

export function movingAverage(signal, win) {
  if (!signal?.length || win <= 1) return signal ? Array.from(signal) : [];
  const w = Math.min(win, signal.length);
  const out = new Array(signal.length);
  let sum = 0;
  for (let i = 0; i < signal.length; i++) {
    sum += signal[i];
    if (i >= w) sum -= signal[i - w];
    out[i] = sum / Math.min(i + 1, w);
  }
  return out;
}

export function derivative(signal, dt = 1) {
  const n = signal.length;
  if (n < 2 || dt <= 0) return new Array(n).fill(0);
  const out = new Array(n).fill(0);
  out[0] = (signal[1] - signal[0]) / dt;
  for (let i = 1; i < n - 1; i++) out[i] = (signal[i + 1] - signal[i - 1]) / (2 * dt);
  out[n - 1] = (signal[n - 1] - signal[n - 2]) / dt;
  return out;
}

// ---- Biquad / Butterworth ----
function biquadCoeffsLowpass(fc, fs) {
  const fcc = clamp(fc, 1, fs * 0.49);
  const k = Math.tan(Math.PI * fcc / fs);
  const sqrt2 = Math.SQRT2;
  const norm = 1 / (1 + sqrt2 * k + k * k);
  return {
    b0: k * k * norm,
    b1: 2 * k * k * norm,
    b2: k * k * norm,
    a1: 2 * (k * k - 1) * norm,
    a2: (1 - sqrt2 * k + k * k) * norm,
  };
}

function biquadCoeffsHighpass(fc, fs) {
  const fcc = clamp(fc, 1, fs * 0.49);
  const k = Math.tan(Math.PI * fcc / fs);
  const sqrt2 = Math.SQRT2;
  const norm = 1 / (1 + sqrt2 * k + k * k);
  return {
    b0: norm,
    b1: -2 * norm,
    b2: norm,
    a1: 2 * (k * k - 1) * norm,
    a2: (1 - sqrt2 * k + k * k) * norm,
  };
}

export function applyBiquad(signal, c) {
  const out = new Array(signal.length).fill(0);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

export function filtfilt(signal, coeffsList) {
  let y = Array.from(signal);
  for (const c of coeffsList) y = applyBiquad(y, c);
  y.reverse();
  for (const c of coeffsList) y = applyBiquad(y, c);
  y.reverse();
  return y;
}

export function butterworthBandpass(lowHz, highHz, fs) {
  return [
    biquadCoeffsLowpass(highHz, fs),
    biquadCoeffsLowpass(highHz, fs),
    biquadCoeffsHighpass(lowHz, fs),
    biquadCoeffsHighpass(lowHz, fs),
  ];
}

export function bandpassFilter(signal, lowHz, highHz, fs) {
  if (!signal?.length) return [];
  const coeffs = butterworthBandpass(lowHz, highHz, fs);
  return filtfilt(signal, coeffs);
}

// ---- Shannon Energy Envelope ----
export function shannonEnergyWindow(samples) {
  if (!samples.length) return 0;
  let maxAbs = EPS;
  for (let i = 0; i < samples.length; i++) maxAbs = Math.max(maxAbs, Math.abs(samples[i]));
  let acc = 0;
  for (let i = 0; i < samples.length; i++) {
    const xh = samples[i] / maxAbs;
    const x2 = xh * xh;
    acc += x2 * Math.log(x2 + EPS);
  }
  return -(acc / samples.length);
}

export function shannonEnvelope(signal, windowSize = 40, hop = 10) {
  if (!signal?.length) return [];
  const w = Math.max(1, Math.min(windowSize, signal.length));
  const h = Math.max(1, hop);
  const env = [];
  for (let i = 0; i < signal.length; i += h) {
    const end = Math.min(signal.length, i + w);
    const slice = signal.subarray ? signal.subarray(i, end) : signal.slice(i, end);
    env.push(shannonEnergyWindow(slice));
    if (end === signal.length) break;
  }
  let maxV = EPS;
  for (let i = 0; i < env.length; i++) if (env[i] > maxV) maxV = env[i];
  for (let i = 0; i < env.length; i++) env[i] = clamp(env[i] / maxV, 0, 1);
  return env;
}

export function detectPeaks(envelope, threshold = 0.35, refractory = 8) {
  const peaks = [];
  for (let i = 1; i < envelope.length - 1; i++) {
    const v = envelope[i];
    if (v >= threshold && v >= envelope[i - 1] && v >= envelope[i + 1]) {
      const last = peaks[peaks.length - 1];
      if (last && i - last.index < refractory) {
        if (v > last.value) { peaks[peaks.length - 1] = { index: i, value: v }; }
        continue;
      }
      peaks.push({ index: i, value: v });
      i += Math.max(1, refractory - 1);
    }
  }
  return peaks;
}

export function segmentS1S2(envelope, envFs) {
  const out = {
    s1: [], s2: [], heartRateBpm: 0, a2p2SplitMs: 0,
    systolicMurmurRatioDb: -120, diastolicMurmurRatioDb: -120,
  };
  if (!envelope?.length || envFs <= 0) return out;
  const m = mean(envelope);
  const sd = stddev(envelope);
  const threshold = clamp(m + 0.6 * sd, 0.15, 0.9);
  const refractory = Math.max(1, Math.round(0.18 * envFs));
  const peaks = detectPeaks(envelope, threshold, refractory);
  if (peaks.length < 2) return out;

  const s1s = [];
  const s2s = [];
  let i = 0;
  while (i < peaks.length) {
    const p = peaks[i];
    if (i + 1 < peaks.length) {
      const dtMs = ((peaks[i + 1].index - p.index) / envFs) * 1000;
      if (dtMs >= 150 && dtMs <= 450) {
        s1s.push(p.index);
        s2s.push(peaks[i + 1].index);
        i += 2;
        continue;
      }
    }
    s1s.push(p.index);
    i += 1;
  }
  const n = Math.min(s1s.length, s2s.length);
  out.s1 = s1s.slice(0, n);
  out.s2 = s2s.slice(0, n);

  if (n >= 2) {
    let rrSum = 0;
    for (let k = 1; k < n; k++) rrSum += (s1s[k] - s1s[k - 1]) / envFs;
    const rrMean = rrSum / (n - 1);
    if (rrMean > 0) out.heartRateBpm = 60 / rrMean;
  }

  // A2-P2 split estimation
  const splits = [];
  for (const s2 of out.s2) {
    const maxOff = Math.max(2, Math.round(0.09 * envFs));
    const start = s2 + 1;
    const end = Math.min(envelope.length - 1, s2 + maxOff);
    let bestI = start;
    let bestV = -Infinity;
    for (let j = start; j < end; j++) {
      if (envelope[j] > bestV) { bestV = envelope[j]; bestI = j; }
    }
    const splitMs = ((bestI - s2) / envFs) * 1000;
    if (splitMs >= 15 && splitMs <= 80 && bestV > threshold * 0.35) splits.push(splitMs);
  }
  if (splits.length) out.a2p2SplitMs = splits.reduce((a, b) => a + b, 0) / splits.length;

  // Murmur ratios
  let sysE = 0, sysN = 0, diaE = 0, diaN = 0, sE = 0, sN = 0;
  for (let k = 0; k < n; k++) {
    const s1 = out.s1[k], s2 = out.s2[k];
    const s1Lo = Math.max(0, s1 - Math.round(0.03 * envFs));
    const s1Hi = Math.min(envelope.length, s1 + Math.round(0.04 * envFs));
    const s2Lo = Math.max(0, s2 - Math.round(0.03 * envFs));
    const s2Hi = Math.min(envelope.length, s2 + Math.round(0.04 * envFs));
    for (let j = s1Lo; j < s1Hi; j++) { sE += envelope[j]; sN++; }
    for (let j = s2Lo; j < s2Hi; j++) { sE += envelope[j]; sN++; }
    for (let j = Math.min(s1Hi, envelope.length); j < Math.min(s2Lo, envelope.length); j++) { sysE += envelope[j]; sysN++; }
    if (k + 1 < n) {
      const nextS1 = out.s1[k + 1];
      const diaLo = Math.min(s2Hi, envelope.length);
      const diaHi = Math.min(envelope.length, Math.max(0, nextS1 - Math.round(0.03 * envFs)));
      for (let j = diaLo; j < diaHi; j++) { diaE += envelope[j]; diaN++; }
    }
  }
  const sAvg = sN ? sE / sN : EPS;
  const sysAvg = sysN ? sysE / sysN : EPS;
  const diaAvg = diaN ? diaE / diaN : EPS;
  out.systolicMurmurRatioDb = 20 * Math.log10(Math.max(EPS, sysAvg / Math.max(EPS, sAvg)));
  out.diastolicMurmurRatioDb = 20 * Math.log10(Math.max(EPS, diaAvg / Math.max(EPS, sAvg)));
  return out;
}

// ---- SCG / Tei ----
export function detectScgFiducials(scg, fs, beatStartMs = 0) {
  if (!scg?.length || fs <= 0) return { mcMs: 0, aoMs: 0, reMs: 0, acMs: 0, moMs: 0, confidence: 0 };
  const sm = movingAverage(scg, Math.max(1, Math.round(0.01 * fs)));
  const toMs = (idx) => beatStartMs + (idx * 1000) / fs;
  const localMax = (start, end) => {
    let s = Math.max(0, start), e = Math.min(sm.length, end);
    if (e <= s + 2) return Math.min(s + 1, sm.length - 1);
    let best = s + 1;
    for (let i = s + 1; i < e - 1; i++) if (sm[i] > sm[best]) best = i;
    return best;
  };
  const localMin = (start, end) => {
    let s = Math.max(0, start), e = Math.min(sm.length, end);
    if (e <= s + 2) return Math.min(s + 1, sm.length - 1);
    let best = s + 1;
    for (let i = s + 1; i < e - 1; i++) if (sm[i] < sm[best]) best = i;
    return best;
  };

  const aoI = localMax(Math.round(0.04 * fs), Math.round(0.20 * fs));
  const mcI = localMin(Math.max(0, aoI - Math.round(0.07 * fs)), Math.max(1, aoI - Math.round(0.01 * fs)));
  const reI = localMax(aoI + 1, Math.min(sm.length, aoI + Math.round(0.12 * fs)));
  const acI = localMin(Math.round(0.22 * fs), Math.round(0.45 * fs));
  const moI = localMax(Math.min(sm.length - 2, acI + Math.round(0.04 * fs)), Math.min(sm.length, acI + Math.round(0.14 * fs)));

  const f = { mcMs: toMs(mcI), aoMs: toMs(aoI), reMs: toMs(reI), acMs: toMs(acI), moMs: toMs(moI), confidence: 1 };
  const ivct = f.aoMs - f.mcMs;
  const lvet = f.acMs - f.aoMs;
  const ivrt = f.moMs - f.acMs;
  let conf = 1;
  if (!(ivct >= 20 && ivct <= 120)) conf *= 0.6;
  if (!(lvet >= 180 && lvet <= 420)) conf *= 0.6;
  if (!(ivrt >= 30 && ivrt <= 160)) conf *= 0.6;
  if (f.aoMs <= f.mcMs || f.acMs <= f.aoMs || f.moMs <= f.acMs) conf *= 0.2;
  f.confidence = clamp(conf, 0, 1);
  return f;
}

export function computeTeiMetrics(ivctMs, lvetMs, ivrtMs) {
  const lvet = Math.abs(lvetMs) < EPS ? EPS : lvetMs;
  return {
    ivctMs, lvetMs, ivrtMs,
    teiIndex: (ivctMs + ivrtMs) / lvet,
    pepLvetRatio: ivctMs / lvet,
  };
}

// ---- PPG foot & PWV ----
export function detectPpgFoot(ppg) {
  if (!ppg?.length || ppg.length < 6) return 0;
  const sm = movingAverage(ppg, 3);
  const d1 = derivative(sm, 1);
  let maxI = 1;
  for (let i = 1; i < d1.length - 1; i++) if (d1[i] > d1[maxI]) maxI = i;
  const slope = d1[maxI];
  if (slope <= EPS) return 0;
  const searchBack = Math.min(100, maxI);
  const baseStart = Math.max(0, maxI - searchBack);
  let minI = baseStart;
  for (let i = baseStart; i <= maxI; i++) if (sm[i] < sm[minI]) minI = i;
  const baseline = sm[minI];
  let footX = maxI + (baseline - sm[maxI]) / slope;
  if (footX < 0 || footX > maxI) footX = minI;
  return clamp(Math.round(footX), 0, ppg.length - 1);
}

export function computePwvMetrics(pathLengthM, pttMs) {
  const ptt = Math.max(1e-6, Math.abs(pttMs));
  const l = Math.max(1e-6, Math.abs(pathLengthM));
  const pwv = l / (ptt / 1000);
  const rho = 1060;
  const hOverD = 0.10;
  const eKPa = (rho * pwv * pwv / hOverD) / 1000;
  const dPerKPa = (1 / (rho * pwv * pwv)) * 1000;
  const vascularAgeYears = clamp(30 + (pwv - 6) * 10, 18, 95);
  let stiffnessClass = 'Normal Elastic Arteries';
  if (pwv >= 10) stiffnessClass = 'Clinically Elevated Arterial Stiffness';
  else if (pwv >= 8) stiffnessClass = 'Borderline Arterial Stiffening';
  return { pttMs: ptt, pwvMPerS: pwv, youngsModulusKpa: eKPa, distensibilityPerKpa: dPerKPa, vascularAgeYears, stiffnessClass };
}

export function estimateMbp(mbp0, ptt0, ptt, gamma = 0.017) {
  const g = Math.abs(gamma) < EPS ? 0.017 : gamma;
  return mbp0 + (2 / g) * Math.log(Math.max(1, ptt0) / Math.max(1, ptt));
}

export function fitQcrt(timesSec, values) {
  const n = timesSec?.length || 0;
  if (n < 5 || values.length !== n) return { tauSeconds: 0, t90Seconds: 0, r2: 0, classification: 'Insufficient data' };
  let ablanch = values[0], abase = values[n - 1];
  for (const v of values) if (v < ablanch) ablanch = v;
  const lateStart = Math.floor(n * 0.7);
  if (lateStart < n - 2) {
    let s = 0, c = 0;
    for (let i = lateStart; i < n; i++) { s += values[i]; c++; }
    abase = s / c;
  }
  const amp = abase - ablanch;
  if (Math.abs(amp) < 1e-9) return { tauSeconds: 0, t90Seconds: 0, r2: 0, classification: 'No reperfusion signal', aBase: abase, aBlanch: ablanch };
  let bestTau = 1.0, bestSSE = Infinity;
  for (let tau = 0.1; tau <= 8.0; tau += 0.05) {
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const pred = ablanch + amp * (1 - Math.exp(-timesSec[i] / tau));
      const d = values[i] - pred; sse += d * d;
    }
    if (sse < bestSSE) { bestSSE = sse; bestTau = tau; }
  }
  for (let step = 0.05; step > 0.001; step *= 0.5) {
    for (const delta of [-step, step]) {
      const cand = bestTau + delta;
      if (cand <= 0.01 || cand > 15) continue;
      let sse = 0;
      for (let i = 0; i < n; i++) { const pred = ablanch + amp * (1 - Math.exp(-timesSec[i] / cand)); const d = values[i] - pred; sse += d * d; }
      if (sse < bestSSE) { bestSSE = sse; bestTau = cand; }
    }
  }
  const meanY = mean(values);
  let sst = 0; for (const v of values) { const d = v - meanY; sst += d * d; }
  let r2 = sst > 1e-12 ? 1 - bestSSE / sst : 0;
  if (r2 < 0) r2 = 0;
  const t90 = 2.302585092994046 * bestTau;
  let classification = 'Normal Euvolemic Microvascular Perfusion';
  if (t90 >= 3.0) classification = 'Significantly Prolonged Refill';
  else if (t90 >= 2.0) classification = 'Borderline Delayed Refill';
  return { tauSeconds: bestTau, t90Seconds: t90, r2, classification, aBase: abase, aBlanch: ablanch };
}
