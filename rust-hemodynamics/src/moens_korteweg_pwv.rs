//! Seismocardiogram (SCG) fiducial detection, Tei Myocardial Performance Index,
//! PPG intersecting-tangent foot detection, Moens-Korteweg PWV, and Bramwell-Hill distensibility.

use crate::{PwvResult, TeiResult};

#[derive(Debug, Clone, Copy, Default)]
pub struct ScgFiducials {
    pub mc_ms: f64,
    pub ao_ms: f64,
    pub re_ms: f64,
    pub ac_ms: f64,
    pub mo_ms: f64,
    pub confidence: f64,
}

/// Simple moving average smoothing.
pub fn smooth(signal: &[f64], win: usize) -> Vec<f64> {
    if signal.is_empty() || win <= 1 {
        return signal.to_vec();
    }
    let w = win.min(signal.len());
    let mut out = vec![0.0; signal.len()];
    let mut sum = 0.0;
    for i in 0..signal.len() {
        sum += signal[i];
        if i >= w {
            sum -= signal[i - w];
        }
        let denom = (i + 1).min(w) as f64;
        out[i] = sum / denom;
    }
    out
}

/// First derivative (central difference).
pub fn derivative(signal: &[f64], dt: f64) -> Vec<f64> {
    let n = signal.len();
    if n < 2 || dt <= 0.0 {
        return vec![0.0; n];
    }
    let mut d = vec![0.0; n];
    d[0] = (signal[1] - signal[0]) / dt;
    for i in 1..n - 1 {
        d[i] = (signal[i + 1] - signal[i - 1]) / (2.0 * dt);
    }
    d[n - 1] = (signal[n - 1] - signal[n - 2]) / dt;
    d
}

fn local_max(signal: &[f64], start: usize, end: usize) -> Option<usize> {
    if end <= start + 2 || end > signal.len() {
        return None;
    }
    let mut best = start + 1;
    for i in (start + 1)..(end - 1) {
        if signal[i] > signal[best] {
            best = i;
        }
    }
    Some(best)
}

fn local_min(signal: &[f64], start: usize, end: usize) -> Option<usize> {
    if end <= start + 2 || end > signal.len() {
        return None;
    }
    let mut best = start + 1;
    for i in (start + 1)..(end - 1) {
        if signal[i] < signal[best] {
            best = i;
        }
    }
    Some(best)
}

/// Detect SCG fiducials within a single beat window.
/// `scg` is dorsoventral z-axis acceleration (mG or m/s^2, relative scale ok).
/// `fs` sampling rate Hz. `beat_start_ms` offset of this window in the trace.
pub fn detect_scg_fiducials(scg: &[f64], fs: f64, beat_start_ms: f64) -> ScgFiducials {
    let mut f = ScgFiducials::default();
    if scg.len() < 10 || fs <= 0.0 {
        return f;
    }
    let sm = smooth(scg, ((0.01 * fs) as usize).max(1));
    let dt = 1.0 / fs;
    let d1 = derivative(&sm, dt);

    // AO: dominant positive peak in early systole (typically 50-150ms)
    let ao_start = ((0.04 * fs) as usize).min(sm.len());
    let ao_end = ((0.20 * fs) as usize).min(sm.len());
    let ao_i = local_max(&sm, ao_start, ao_end).unwrap_or(ao_start);

    // MC: local minimum/inflection just before AO (20-60ms before AO)
    let mc_start = ao_i.saturating_sub((0.07 * fs) as usize);
    let mc_end = ao_i.saturating_sub((0.01 * fs) as usize).max(mc_start + 1);
    let mc_i = local_min(&sm, mc_start, mc_end.min(sm.len())).unwrap_or(mc_start);

    // RE: peak after AO within 120ms
    let re_start = ao_i + 1;
    let re_end = (ao_i + (0.12 * fs) as usize).min(sm.len());
    let re_i = local_max(&sm, re_start, re_end).unwrap_or(re_start.min(sm.len().saturating_sub(1)));

    // AC: local minimum around end systole (250-400ms)
    let ac_start = ((0.22 * fs) as usize).min(sm.len());
    let ac_end = ((0.45 * fs) as usize).min(sm.len());
    let ac_i = local_min(&sm, ac_start, ac_end).unwrap_or(ac_start.min(sm.len().saturating_sub(1)));

    // MO: local max after AC (50-120ms after AC)
    let mo_start = (ac_i + ((0.04 * fs) as usize)).min(sm.len().saturating_sub(2));
    let mo_end = (ac_i + ((0.14 * fs) as usize)).min(sm.len());
    let mo_i = local_max(&sm, mo_start, mo_end).unwrap_or(mo_start);

    let to_ms = |idx: usize| beat_start_ms + (idx as f64) * 1000.0 / fs;
    f.mc_ms = to_ms(mc_i);
    f.ao_ms = to_ms(ao_i);
    f.re_ms = to_ms(re_i);
    f.ac_ms = to_ms(ac_i);
    f.mo_ms = to_ms(mo_i);

    // Confidence heuristic based on ordering and plausible intervals
    let ivct = f.ao_ms - f.mc_ms;
    let lvet = f.ac_ms - f.ao_ms;
    let ivrt = f.mo_ms - f.ac_ms;
    let mut conf: f64 = 1.0;
    if !(20.0..=120.0).contains(&ivct) { conf *= 0.6; }
    if !(180.0..=420.0).contains(&lvet) { conf *= 0.6; }
    if !(30.0..=160.0).contains(&ivrt) { conf *= 0.6; }
    if f.ao_ms <= f.mc_ms || f.ac_ms <= f.ao_ms || f.mo_ms <= f.ac_ms { conf *= 0.2; }
    f.confidence = conf.clamp(0.0, 1.0);
    f
}

/// Compute Tei index metrics from intervals (ms).
pub fn compute_tei_metrics(ivct_ms: f64, lvet_ms: f64, ivrt_ms: f64) -> TeiResult {
    let lvet = if lvet_ms.abs() < 1e-9 { 1e-9 } else { lvet_ms };
    let tei = (ivct_ms + ivrt_ms) / lvet;
    // PEP approximation: IVCT used as PEP proxy when true PEP not provided
    let pep_lvet = ivct_ms / lvet;
    TeiResult {
        ivct_ms,
        lvet_ms,
        ivrt_ms,
        tei_index: tei,
        pep_lvet_ratio: pep_lvet,
    }
}

/// Intersecting-tangent PPG foot detection.
/// Returns foot index in the provided ppg slice.
pub fn detect_ppg_foot(ppg: &[f64]) -> Option<usize> {
    if ppg.len() < 6 {
        return None;
    }
    let sm = smooth(ppg, 3);
    let dt = 1.0_f64; // sample units; caller converts to time
    let d1 = derivative(&sm, dt);

    // max upstroke slope
    let mut max_i = 1usize;
    for i in 1..d1.len() - 1 {
        if d1[i] > d1[max_i] {
            max_i = i;
        }
    }
    let slope = d1[max_i];
    if slope <= 1e-9 {
        return Some(0);
    }
    // baseline: minimum in 100 samples before max slope (or start)
    let search_back = 100usize.min(max_i);
    let base_start = max_i.saturating_sub(search_back);
    let mut min_i = base_start;
    for i in base_start..=max_i {
        if sm[i] < sm[min_i] {
            min_i = i;
        }
    }
    let baseline = sm[min_i];

    // tangent line at max slope: y = sm[max_i] + slope*(x-max_i)
    // intersect with y = baseline => x = max_i + (baseline - sm[max_i]) / slope
    let mut foot_x = max_i as f64 + (baseline - sm[max_i]) / slope;
    if foot_x < 0.0 {
        foot_x = min_i as f64;
    }
    if foot_x > max_i as f64 {
        foot_x = min_i as f64;
    }
    Some((foot_x.round() as usize).min(ppg.len() - 1))
}

/// Compute PWV and stiffness metrics.
/// Moens-Korteweg: PWV = sqrt(E*h/(rho*d)), assume h/d = 0.10, rho = 1060 kg/m^3
/// Bramwell-Hill: D = 1/(rho*PWV^2)  (1/kPa after unit conversion)
pub fn compute_pwv_metrics(path_length_m: f64, ptt_ms: f64) -> PwvResult {
    let ptt = if ptt_ms.abs() < 1e-6 { 1e-6 } else { ptt_ms.abs() };
    let l = path_length_m.abs().max(1e-6);
    let pwv = l / (ptt / 1000.0); // m/s

    let rho: f64 = 1060.0; // kg/m^3
    let h_over_d: f64 = 0.10;
    // E = rho * PWV^2 / (h/d) in Pascals; convert to kPa
    let e_pa = rho * pwv * pwv / h_over_d;
    let e_kpa = e_pa / 1000.0;

    // Bramwell-Hill distensibility: D = 1/(rho*PWV^2) in 1/Pa -> 1/kPa
    let d_per_pa = 1.0 / (rho * pwv * pwv).max(1e-12);
    let d_per_kpa = d_per_pa * 1000.0;

    // Empirical vascular age estimate (simple linearized model around reference)
    // Reference: PWV ~ 6.0 m/s at age 30, ~0.1 m/s per year rough heuristic
    let vascular_age = 30.0 + (pwv - 6.0) * 10.0;
    let vascular_age_clamped = vascular_age.clamp(18.0, 95.0);

    PwvResult {
        ptt_ms: ptt,
        pwv_m_per_s: pwv,
        youngs_modulus_kpa: e_kpa,
        distensibility_per_kpa: d_per_kpa,
        vascular_age_years: vascular_age_clamped,
    }
}

/// Cuffless BP excursion estimator (Hughes/log model).
/// MBP_est = MBP0 + (2/gamma)*ln(PTT0/PTT)
pub fn estimate_bp_excursion(mbp0: f64, ptt0_ms: f64, ptt_ms: f64, gamma: f64) -> f64 {
    let g = if gamma.abs() < 1e-6 { 0.017 } else { gamma };
    let p0 = ptt0_ms.max(1.0);
    let p = ptt_ms.max(1.0);
    mbp0 + (2.0 / g) * (p0 / p).ln()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pwv() {
        let r = compute_pwv_metrics(0.85, 120.0);
        assert!(r.pwv_m_per_s > 5.0 && r.pwv_m_per_s < 10.0);
        assert!(r.youngs_modulus_kpa > 0.0);
    }

    #[test]
    fn test_tei() {
        let t = compute_tei_metrics(40.0, 280.0, 70.0);
        assert!((t.tei_index - (110.0 / 280.0)).abs() < 1e-6);
    }
}
