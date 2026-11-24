//! PCG Shannon Energy Envelope, zero-phase Butterworth filtering,
//! S1/S2 segmentation, A2-P2 split estimation, and murmur energy ratios.

use std::f64::consts::PI;

/// Biquad section coefficients (Direct Form II Transposed friendly representation).
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Biquad {
    pub fn new(b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) -> Self {
        Self { b0, b1, b2, a1, a2 }
    }

    /// Apply biquad filter forward (Direct Form I) to a signal.
    pub fn filter_forward(&self, input: &[f64]) -> Vec<f64> {
        let mut y = vec![0.0; input.len()];
        let mut x1 = 0.0;
        let mut x2 = 0.0;
        let mut y1 = 0.0;
        let mut y2 = 0.0;
        for (i, &x0) in input.iter().enumerate() {
            let out = self.b0 * x0 + self.b1 * x1 + self.b2 * x2 - self.a1 * y1 - self.a2 * y2;
            y[i] = out;
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = out;
        }
        y
    }
}

/// Design a 2nd-order Butterworth low-pass biquad using bilinear transform.
pub fn butterworth_lowpass(fc: f64, fs: f64) -> Biquad {
    let fc = fc.clamp(1.0, fs * 0.49);
    let k = (PI * fc / fs).tan();
    let norm = 1.0 / (1.0 + 2f64.sqrt() * k + k * k);
    let b0 = k * k * norm;
    let b1 = 2.0 * b0;
    let b2 = b0;
    let a1 = 2.0 * (k * k - 1.0) * norm;
    let a2 = (1.0 - 2f64.sqrt() * k + k * k) * norm;
    Biquad::new(b0, b1, b2, a1, a2)
}

/// Design a 2nd-order Butterworth high-pass biquad using bilinear transform.
pub fn butterworth_highpass(fc: f64, fs: f64) -> Biquad {
    let fc = fc.clamp(1.0, fs * 0.49);
    let k = (PI * fc / fs).tan();
    let norm = 1.0 / (1.0 + 2f64.sqrt() * k + k * k);
    let b0 = norm;
    let b1 = -2.0 * norm;
    let b2 = norm;
    let a1 = 2.0 * (k * k - 1.0) * norm;
    let a2 = (1.0 - 2f64.sqrt() * k + k * k) * norm;
    Biquad::new(b0, b1, b2, a1, a2)
}

/// Zero-phase filter: forward then reverse-filter to cancel phase delay.
pub fn filtfilt(sections: &[Biquad], input: &[f64]) -> Vec<f64> {
    let mut signal = input.to_vec();
    for sec in sections {
        signal = sec.filter_forward(&signal);
    }
    signal.reverse();
    for sec in sections {
        signal = sec.filter_forward(&signal);
    }
    signal.reverse();
    signal
}

/// Build a 4th-order Butterworth bandpass as two cascaded lowpass + two highpass sections.
pub fn butterworth_bandpass(low_hz: f64, high_hz: f64, fs: f64) -> Vec<Biquad> {
    let lp1 = butterworth_lowpass(high_hz, fs);
    let lp2 = butterworth_lowpass(high_hz, fs);
    let hp1 = butterworth_highpass(low_hz, fs);
    let hp2 = butterworth_highpass(low_hz, fs);
    vec![lp1, lp2, hp1, hp2]
}

/// Normalized Shannon energy for a window.
/// E = -1/N * sum(x_hat^2 * ln(x_hat^2 + eps))
pub fn shannon_energy_window(samples: &[f64]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let max_abs = samples
        .iter()
        .fold(0.0_f64, |m, &v| m.max(v.abs()))
        .max(1e-12);
    let eps = 1e-12;
    let mut acc = 0.0;
    for &s in samples {
        let xh = s / max_abs;
        let x2 = xh * xh;
        acc += x2 * (x2 + eps).ln();
    }
    -(acc / samples.len() as f64)
}

/// Mean Shannon energy over sliding windows of size `window`.
pub fn mean_shannon_energy(signal: &[f64], window: usize) -> f64 {
    if signal.is_empty() || window == 0 {
        return 0.0;
    }
    let w = window.max(1).min(signal.len());
    let mut sum = 0.0;
    let mut count = 0usize;
    let mut i = 0usize;
    while i + w <= signal.len() {
        sum += shannon_energy_window(&signal[i..i + w]);
        count += 1;
        i += w / 2 + 1;
    }
    if count == 0 {
        shannon_energy_window(signal)
    } else {
        sum / count as f64
    }
}

/// Compute full Shannon energy envelope series at hop size.
pub fn shannon_envelope(signal: &[f64], window: usize, hop: usize) -> Vec<f64> {
    if signal.is_empty() || window == 0 {
        return vec![];
    }
    let hop = hop.max(1);
    let mut env = Vec::new();
    let mut i = 0usize;
    while i < signal.len() {
        let end = (i + window).min(signal.len());
        env.push(shannon_energy_window(&signal[i..end]));
        if end == signal.len() {
            break;
        }
        i += hop;
    }
    // Normalize to [0,1]
    let max_v = env.iter().cloned().fold(0.0_f64, f64::max).max(1e-12);
    env.into_iter().map(|v| (v / max_v).clamp(0.0, 1.0)).collect()
}

#[derive(Debug, Clone, Copy)]
pub struct Peak {
    pub index: usize,
    pub value: f64,
}

/// Simple local-maxima peak detector with refractory period and threshold.
pub fn detect_peaks(envelope: &[f64], threshold: f64, refractory: usize) -> Vec<Peak> {
    let mut peaks: Vec<Peak> = Vec::new();
    if envelope.len() < 3 {
        return peaks;
    }
    let mut i = 1usize;
    while i + 1 < envelope.len() {
        let v = envelope[i];
        if v >= threshold && v >= envelope[i - 1] && v >= envelope[i + 1] {
            if let Some(last) = peaks.last() {
                if i - last.index < refractory {
                    if v > last.index.checked_sub(0).map(|_| last.value).unwrap_or(0.0) {
                        // replace last if stronger and within refractory - rare; keep stronger
                        if v > last.value {
                            peaks.pop();
                            peaks.push(Peak { index: i, value: v });
                        }
                    }
                    i += 1;
                    continue;
                }
            }
            peaks.push(Peak { index: i, value: v });
            i += refractory.max(1);
            continue;
        }
        i += 1;
    }
    peaks
}

#[derive(Debug, Clone, Copy)]
pub struct HeartSoundMarkers {
    pub s1_indices: [usize; 8],
    pub s2_indices: [usize; 8],
    pub count: usize,
    pub a2_p2_split_ms: f64,
    pub systolic_murmur_ratio_db: f64,
    pub diastolic_murmur_ratio_db: f64,
    pub heart_rate_bpm: f64,
}

/// Segment S1/S2 from an envelope sampled at `env_fs` Hz.
/// Heuristic: pair peaks by alternating short (systole) / long (diastole) intervals.
pub fn segment_s1_s2(envelope: &[f64], env_fs: f64) -> HeartSoundMarkers {
    let mut out = HeartSoundMarkers {
        s1_indices: [0; 8],
        s2_indices: [0; 8],
        count: 0,
        a2_p2_split_ms: 0.0,
        systolic_murmur_ratio_db: -120.0,
        diastolic_murmur_ratio_db: -120.0,
        heart_rate_bpm: 0.0,
    };
    if envelope.len() < 4 || env_fs <= 0.0 {
        return out;
    }
    let mean = envelope.iter().sum::<f64>() / envelope.len() as f64;
    let var = envelope.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / envelope.len() as f64;
    let std = var.sqrt();
    let threshold = (mean + 0.6 * std).clamp(0.15, 0.9);
    let refractory = ((0.18 * env_fs) as usize).max(1); // 180 ms refractory
    let peaks = detect_peaks(envelope, threshold, refractory);
    if peaks.len() < 2 {
        return out;
    }

    // Build intervals and classify: assume first peak is S1, next S2 if interval < 450ms, else S1
    let mut s1s: Vec<usize> = Vec::new();
    let mut s2s: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while i < peaks.len() {
        let p = peaks[i];
        // look ahead
        if i + 1 < peaks.len() {
            let dt = (peaks[i + 1].index as f64 - p.index as f64) / env_fs * 1000.0;
            if dt >= 150.0 && dt <= 450.0 {
                // S1 -> S2 (systole)
                s1s.push(p.index);
                s2s.push(peaks[i + 1].index);
                i += 2;
                continue;
            }
        }
        // fallback: treat as S1 if isolated
        s1s.push(p.index);
        i += 1;
    }

    let n = s1s.len().min(s2s.len()).min(8);
    for k in 0..n {
        out.s1_indices[k] = s1s[k];
        out.s2_indices[k] = s2s[k];
    }
    out.count = n;

    if n >= 2 {
        let mut rr_sum = 0.0;
        for k in 1..n {
            rr_sum += (s1s[k] as f64 - s1s[k - 1] as f64) / env_fs;
        }
        let rr_mean = rr_sum / (n as f64 - 1.0);
        if rr_mean > 0.0 {
            out.heart_rate_bpm = 60.0 / rr_mean;
        }
    } else if n == 1 && !s1s.is_empty() {
        out.heart_rate_bpm = 0.0;
    }

    // A2-P2 split estimation: look for a secondary bump within 80ms after S2
    let mut splits: Vec<f64> = Vec::new();
    for &s2 in &s2s {
        let max_off = ((0.09 * env_fs) as usize).max(2);
        let start = s2.saturating_add(1);
        let end = (s2 + max_off).min(envelope.len().saturating_sub(1));
        if end <= start + 1 {
            continue;
        }
        // find local max after S2
        let mut best_i = start;
        let mut best_v = envelope[start];
        for j in start..end {
            if envelope[j] > best_v {
                best_v = envelope[j];
                best_i = j;
            }
        }
        let split_ms = (best_i as f64 - s2 as f64) / env_fs * 1000.0;
        if split_ms >= 15.0 && split_ms <= 80.0 && best_v > threshold * 0.35 {
            splits.push(split_ms);
        }
    }
    if !splits.is_empty() {
        out.a2_p2_split_ms = splits.iter().sum::<f64>() / splits.len() as f64;
    }

    // Murmur ratios: energy in systolic (S1->S2) vs S1+S2 peaks, and diastolic (S2->next S1)
    let mut sys_e = 0.0;
    let mut sys_n = 0usize;
    let mut dia_e = 0.0;
    let mut dia_n = 0usize;
    let mut s_e = 0.0;
    let mut s_n = 0usize;
    for k in 0..n {
        let s1 = s1s[k];
        let s2 = s2s[k];
        let s1_lo = s1.saturating_sub((0.03 * env_fs) as usize);
        let s1_hi = (s1 + (0.04 * env_fs) as usize).min(envelope.len());
        let s2_lo = s2.saturating_sub((0.03 * env_fs) as usize);
        let s2_hi = (s2 + (0.04 * env_fs) as usize).min(envelope.len());
        for j in s1_lo..s1_hi { s_e += envelope[j]; s_n += 1; }
        for j in s2_lo..s2_hi { s_e += envelope[j]; s_n += 1; }
        let sys_lo = s1_hi.min(envelope.len());
        let sys_hi = s2_lo.min(envelope.len());
        for j in sys_lo..sys_hi { sys_e += envelope[j]; sys_n += 1; }
        if k + 1 < n {
            let next_s1 = s1s[k + 1];
            let dia_lo = s2_hi.min(envelope.len());
            let dia_hi = next_s1.saturating_sub((0.03 * env_fs) as usize).min(envelope.len());
            for j in dia_lo..dia_hi { dia_e += envelope[j]; dia_n += 1; }
        }
    }
    let s_avg = if s_n > 0 { s_e / s_n as f64 } else { 1e-9 };
    let sys_avg = if sys_n > 0 { sys_e / sys_n as f64 } else { 1e-9 };
    let dia_avg = if dia_n > 0 { dia_e / dia_n as f64 } else { 1e-9 };
    out.systolic_murmur_ratio_db = 20.0 * (sys_avg / s_avg.max(1e-9)).log10();
    out.diastolic_murmur_ratio_db = 20.0 * (dia_avg / s_avg.max(1e-9)).log10();

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bandpass_and_envelope() {
        let fs = 1000.0;
        let mut sig = vec![0.0; 2000];
        for i in 0..sig.len() {
            let t = i as f64 / fs;
            sig[i] = (2.0 * PI * 50.0 * t).sin() * 0.5 + (2.0 * PI * 200.0 * t).sin() * 0.2;
        }
        let filt = butterworth_bandpass(25.0, 150.0, fs);
        let out = filtfilt(&filt, &sig);
        assert_eq!(out.len(), sig.len());
        let env = shannon_envelope(&out, 40, 10);
        assert!(!env.is_empty());
    }
}
