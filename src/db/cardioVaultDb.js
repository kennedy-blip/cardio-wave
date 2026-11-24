/**
 * CARDIO-WAVE Offline-first IndexedDB vault.
 * Stores: pcg_auscultation_logs, scg_tei_studies, pwv_arterial_records,
 *         orthostatic_pots_sessions, capillary_refill_scans
 * Plus a mutation sync queue for POST /api/hemodynamic_solver.
 */

const DB_NAME = 'cardio-wave-vault';
const DB_VERSION = 1;

export const STORES = {
  PCG: 'pcg_auscultation_logs',
  SCG: 'scg_tei_studies',
  PWV: 'pwv_arterial_records',
  ORTHO: 'orthostatic_pots_sessions',
  CRT: 'capillary_refill_scans',
  SYNC: 'mutation_sync_queue',
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(store)) {
          const os = db.createObjectStore(store, { keyPath: 'id' });
          os.createIndex('createdAt', 'createdAt', { unique: false });
          os.createIndex('synced', 'synced', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putRecord(store, record) {
  const db = await openDb();
  const entry = {
    ...record,
    id: record.id || `${store}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    createdAt: record.createdAt || new Date().toISOString(),
    synced: record.synced ?? false,
  };
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(entry);
  await txDone(tx);
  return entry;
}

export async function getAllRecords(store, limit = 100) {
  const db = await openDb();
  const tx = db.transaction(store, 'readonly');
  const idx = tx.objectStore(store).index('createdAt');
  const results = [];
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
  return results;
}

export async function clearStore(store) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await txDone(tx);
}

export async function enqueueSyncMutation(payload) {
  return putRecord(STORES.SYNC, {
    payload,
    synced: false,
    attempts: 0,
    lastError: null,
  });
}

export async function getPendingSyncMutations(limit = 50) {
  const all = await getAllRecords(STORES.SYNC, 200);
  return all.filter((r) => !r.synced).slice(0, limit);
}

export async function markSyncMutation(id, patch = {}) {
  const db = await openDb();
  const tx = db.transaction(STORES.SYNC, 'readwrite');
  const os = tx.objectStore(STORES.SYNC);
  const existing = await reqToPromise(os.get(id));
  if (existing) {
    os.put({ ...existing, ...patch });
  }
  await txDone(tx);
}

export async function flushSyncQueue(endpoint = '/api/hemodynamic_solver') {
  const pending = await getPendingSyncMutations(20);
  const results = { attempted: 0, synced: 0, failed: 0, errors: [] };
  for (const item of pending) {
    results.attempted += 1;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await markSyncMutation(item.id, { synced: true, syncedAt: new Date().toISOString(), lastError: null });
      results.synced += 1;
    } catch (err) {
      await markSyncMutation(item.id, {
        attempts: (item.attempts || 0) + 1,
        lastError: err?.message || String(err),
      });
      results.failed += 1;
      results.errors.push({ id: item.id, error: err?.message || String(err) });
    }
  }
  return results;
}

export async function exportClinicalReport() {
  const [pcg, scg, pwv, ortho, crt] = await Promise.all([
    getAllRecords(STORES.PCG, 200),
    getAllRecords(STORES.SCG, 200),
    getAllRecords(STORES.PWV, 200),
    getAllRecords(STORES.ORTHO, 200),
    getAllRecords(STORES.CRT, 200),
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    system: 'CARDIO-WAVE v1.20.0',
    disclaimer: 'Screening-only, non-diagnostic. Not a substitute for clinical evaluation.',
    pcg_auscultation_logs: pcg,
    scg_tei_studies: scg,
    pwv_arterial_records: pwv,
    orthostatic_pots_sessions: ortho,
    capillary_refill_scans: crt,
  };
  return report;
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function openPrintableReport(report) {
  const win = window.open('', '_blank');
  if (!win) return false;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const section = (title, rows) => `
    <h2>${esc(title)} (${rows.length})</h2>
    <pre>${esc(JSON.stringify(rows.slice(0, 20), null, 2))}</pre>`;
  win.document.write(`<!doctype html><html><head><title>CARDIO-WAVE Clinical Report</title>
  <style>body{font-family:ui-sans-serif,system-ui;margin:24px;color:#0b1220;background:#fff}h1{margin:0 0 4px} .meta{color:#475569;margin-bottom:24px} pre{background:#f8fafc;padding:12px;border-radius:8px;overflow:auto;font-size:12px} h2{margin-top:28px}</style>
  </head><body>
  <h1>CARDIO-WAVE Clinical Hemodynamic Report</h1>
  <div class="meta">Generated ${esc(report.generatedAt)} · ${esc(report.disclaimer)}</div>
  ${section('PCG Auscultation Logs', report.pcg_auscultation_logs)}
  ${section('SCG / Tei Studies', report.scg_tei_studies)}
  ${section('PWV Arterial Records', report.pwv_arterial_records)}
  ${section('Orthostatic POTS Sessions', report.orthostatic_pots_sessions)}
  ${section('Capillary Refill Scans', report.capillary_refill_scans)}
  <script>window.print();</script>
  </body></html>`);
  win.document.close();
  return true;
}
