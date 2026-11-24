# CARDIO-WAVE

Non-invasive cardiovascular hemodynamics, mechano-acoustic auscultation, autonomic dysautonomia screening, and peripheral microvascular perfusion workstation.

## Stack
- Vue 3.5 (pure ES2024 JavaScript, no TypeScript)
- Vite
- Rust hemodynamics DSP crate (`rust-hemodynamics/`) with JS mirror bridge for Vercel build resilience
- Java 17 Capacitor Android plugins (200 Hz IMU, 48 kHz UNPROCESSED audio + torch)
- Go 1.22 serverless solver (`api/hemodynamic_solver.go`) + `go_hemodynamics/autonomic_baroreflex.go`
- WebGL2 GLSL shaders for hemodynamic background and capillary perfusion heatmap
- IndexedDB offline-first vault with sync queue

## Modules
1. Digital Phonocardiogram (PCG) Stethoscope & Murmur Analyzer
2. Sternum Seismocardiography (SCG) & Tei Myocardial Performance Lab
3. Dual-Site PWV & Moens-Korteweg Arterial Stiffness Lab
4. Orthostatic POTS Tilt-Table / Active Stand Monitor
5. Optical Capillary Refill (qCRT) & Perfusion Scanner

## Development
```bash
npm install
npm run dev
npm run build
```

## Disclaimer
CARDIO-WAVE is a screening and educational workstation. It is **not** a diagnostic medical device.
