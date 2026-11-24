//! CARDIO-WAVE Rust Hemodynamics DSP crate
//! Exposes PCG Shannon envelope segmentation, SCG fiducial/Tei index extraction,
//! and Moens-Korteweg / Bramwell-Hill arterial stiffness solvers via C ABI / WASM.

pub mod moens_korteweg_pwv;
pub mod pcg_shannon_envelope;

pub use moens_korteweg_pwv::*;
pub use pcg_shannon_envelope::*;

/// Simple FFI-safe result for PWV computation.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct PwvResult {
    pub ptt_ms: f64,
    pub pwv_m_per_s: f64,
    pub youngs_modulus_kpa: f64,
    pub distensibility_per_kpa: f64,
    pub vascular_age_years: f64,
}

/// FFI-safe Tei index / interval result.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct TeiResult {
    pub ivct_ms: f64,
    pub lvet_ms: f64,
    pub ivrt_ms: f64,
    pub tei_index: f64,
    pub pep_lvet_ratio: f64,
}

/// Compute PWV and derived arterial stiffness metrics.
/// `path_length_m` in meters, `ptt_ms` in milliseconds.
#[no_mangle]
pub extern "C" fn compute_pwv(path_length_m: f64, ptt_ms: f64) -> PwvResult {
    moens_korteweg_pwv::compute_pwv_metrics(path_length_m, ptt_ms)
}

/// Compute Tei index from cardiac intervals in milliseconds.
#[no_mangle]
pub extern "C" fn compute_tei(ivct_ms: f64, lvet_ms: f64, ivrt_ms: f64) -> TeiResult {
    moens_korteweg_pwv::compute_tei_metrics(ivct_ms, lvet_ms, ivrt_ms)
}

/// Shannon energy envelope for a normalized signal slice.
/// Returns the mean envelope value over the window; caller manages buffers for full series.
/// `signal_ptr` points to `len` f64 samples, `window` is samples per window.
#[no_mangle]
pub extern "C" fn shannon_energy_window(signal_ptr: *const f64, len: usize, window: usize) -> f64 {
    if signal_ptr.is_null() || len == 0 || window == 0 {
        return 0.0;
    }
    let signal = unsafe { std::slice::from_raw_parts(signal_ptr, len) };
    pcg_shannon_envelope::mean_shannon_energy(signal, window)
}
