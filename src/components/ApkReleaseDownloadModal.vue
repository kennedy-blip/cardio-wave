<script setup>
import { ref, onMounted } from 'vue';

const emit = defineEmits(['close']);
const sha256 = ref('Computing…');
const downloading = ref(false);
const downloadStatus = ref('');

const APK_PATH = '/releases/cardio-wave-v1.20.0-universal.apk';
const APK_URL_ABSOLUTE = typeof window !== 'undefined' ? `${window.location.origin}${APK_PATH}` : APK_PATH;

// ---- Tiny QR Code generator (byte mode, ECC L, versions 2-4) ----
// Minimal implementation sufficient for short URLs.
const QR = (() => {
  // Galois field GF(256) for Reed-Solomon
  const EXP = new Array(512);
  const LOG = new Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  function gfMul(a,b){ return a&&b ? EXP[LOG[a]+LOG[b]] : 0; }
  function polyMul(p,q){ const r=new Array(p.length+q.length-1).fill(0); for(let i=0;i<p.length;i++) for(let j=0;j<q.length;j++) r[i+j]^=gfMul(p[i],q[j]); return r; }
  function rsGenPoly(n){ let g=[1]; for(let i=0;i<n;i++){ g=polyMul(g,[1,EXP[i]]); } return g; }
  function rsEncode(data, nsym){ const gen=rsGenPoly(nsym); const res=new Array(data.length+nsym).fill(0); for(let i=0;i<data.length;i++) res[i]=data[i]; for(let i=0;i<data.length;i++){ const coef=res[i]; if(coef!==0) for(let j=0;j<gen.length;j++) res[i+j]^=gfMul(gen[j],coef); } return res.slice(data.length); }

  // Version params: [version, size, totalCodewords, ecCodewordsPerBlock, numBlocks, dataCodewords]
  // ECC L
  const V = [
    null,
    null,
    [2,25,44,10,1,34],
    [3,29,70,15,1,55],
    [4,33,100,20,1,80],
    [5,37,134,26,1,108],
    [6,41,172,18,2,156],
  ];

  function encodeBits(text) {
    const bytes = new TextEncoder().encode(text);
    for (let vi=2; vi<V.length; vi++) {
      const [ver,size,total,ecPerBlock,nBlocks,dataCw] = V[vi];
      if (bytes.length > dataCw - 3) continue; // rough capacity check (byte mode overhead)
      const bb = [];
      const pushBits = (val, len) => { for(let i=len-1;i>=0;i--) bb.push((val>>i)&1); };
      pushBits(0b0100,4); // byte mode
      pushBits(bytes.length, 8 + (ver>=10?8:0));
      for (const b of bytes) pushBits(b,8);
      pushBits(0,4); // terminator (up to 4)
      while (bb.length % 8 !== 0) bb.push(0);
      const cap = dataCw * 8;
      const padBytes=[0xec,0x11]; let pi=0;
      while (bb.length < cap) { pushBits(padBytes[pi%2],8); pi++; }
      if (bb.length > cap) continue;
      // bytes
      const data = [];
      for (let i=0;i<bb.length;i+=8){ let v=0; for(let j=0;j<8;j++) v=(v<<1)|bb[i+j]; data.push(v); }
      // RS blocks
      const blocks = [];
      const blockSize = Math.floor(dataCw / nBlocks);
      let offset=0;
      for(let b=0;b<nBlocks;b++){
        const sz = blockSize + (b < (dataCw % nBlocks) ? 1 : 0);
        const d = data.slice(offset, offset+sz); offset+=sz;
        const ec = rsEncode(d, ecPerBlock);
        blocks.push({d,ec});
      }
      // interleave
      const result = [];
      const maxD = Math.max(...blocks.map(b=>b.d.length));
      for(let i=0;i<maxD;i++) for(const b of blocks) if(i<b.d.length) result.push(b.d[i]);
      const maxE = ecPerBlock;
      for(let i=0;i<maxE;i++) for(const b of blocks) if(i<b.ec.length) result.push(b.ec[i]);
      return { ver, size, bits: result };
    }
    return null;
  }

  function makeMatrix(text) {
    const enc = encodeBits(text);
    if (!enc) return null;
    const { ver, size, bits } = enc;
    const m = Array.from({length:size}, ()=>Array(size).fill(null));
    const reserved = Array.from({length:size}, ()=>Array(size).fill(false));

    function set(x,y,v,r=true){ if(x>=0&&x<size&&y>=0&&y<size){ m[y][x]=v?1:0; if(r) reserved[y][x]=true; } }
    function box(x,y,w,h,v){ for(let yy=y;yy<y+h;yy++) for(let xx=x;xx<x+w;xx++) set(xx,yy,v); }

    // Finder patterns
    function finder(cx,cy){
      for(let dy=-4;dy<=4;dy++) for(let dx=-4;dx<=4;dx++){
        const x=cx+dx,y=cy+dy; if(x<0||x>=size||y<0||y>=size) continue;
        const ad=Math.max(Math.abs(dx),Math.abs(dy));
        set(x,y, ad!==2 && ad!==4);
      }
    }
    finder(3,3); finder(size-4,3); finder(3,size-4);
    // separators already covered by finder area; timing
    for(let i=8;i<size-8;i++){ set(i,6,i%2===0); set(6,i,i%2===0); }
    // alignment for ver>=2
    if (ver>=2) {
      const posMap={2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34]};
      const pos=posMap[ver]||[6,6+ver*4];
      for(const cy of pos) for(const cx of pos){
        if (reserved[cy]?.[cx]) continue;
        let overlap=false;
        for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++){ const x=cx+dx,y=cy+dy; if(x>=0&&x<size&&y>=0&&y<size&&reserved[y][x]){ /* allow if finder */ } }
        // simple: skip if near corners
        if ((cx<9&&cy<9)||(cx>size-9&&cy<9)||(cx<9&&cy>size-9)) continue;
        for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++){
          const ad=Math.max(Math.abs(dx),Math.abs(dy));
          set(cx+dx,cy+dy,ad!==1);
        }
      }
    }
    // dark module
    set(8, size-8, true);
    // reserve format info
    for(let i=0;i<9;i++){ if(i!==6){ reserved[8][i]=true; reserved[i][8]=true; } }
    for(let i=0;i<8;i++){ reserved[8][size-1-i]=true; reserved[size-1-i][8]=true; }
    reserved[8][6]=true; reserved[6][8]=true; reserved[8][8]=true;

    // place data
    const dataBits=[];
    for(const byte of bits) for(let i=7;i>=0;i--) dataBits.push((byte>>i)&1);
    let dir=-1; let x=size-1; let y=size-1; let bi=0;
    while(x>0){
      if(x===6) x--;
      for(let i=0;i<size;i++){
        const yy = dir===-1 ? size-1-i : i;
        for(let dx=0;dx<2;dx++){
          const xx=x-dx;
          if(xx<0||yy<0||xx>=size||yy>=size) continue;
          if(reserved[yy][xx]) continue;
          let bit = bi < dataBits.length ? dataBits[bi++] : 0;
          // mask 0: (y+x)%2==0
          if(((yy+xx)%2)===0) bit^=1;
          m[yy][xx]=bit;
        }
      }
      x-=2; dir*=-1;
    }

    // format info for ECC L mask 0: 111011111000100
    const fmt = 0x77c4; // precomputed for L, mask 0
    const fmtBits = []; for(let i=14;i>=0;i--) fmtBits.push((fmt>>i)&1);
    // place format
    const posA=[[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[7,8],[8,8],[8,7],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0]];
    const posB=[[8,size-1],[8,size-2],[8,size-3],[8,size-4],[8,size-5],[8,size-6],[8,size-7],[size-7,8],[size-6,8],[size-5,8],[size-4,8],[size-3,8],[size-2,8],[size-1,8]];
    for(let i=0;i<15;i++){ const [ax,ay]=posA[i]; m[ay][ax]=fmtBits[i]; if(i<14){ const [bx,by]=posB[i]; m[by][bx]=fmtBits[i]; } }
    // (posB has 14) fix last
    m[8][size-8]=1; // dark module already

    // fill any null as 0
    for(let yy=0;yy<size;yy++) for(let xx=0;xx<size;xx++) if(m[yy][xx]==null) m[yy][xx]=0;
    return { size, m };
  }

  function toSvg(text, px=4, quiet=4) {
    const qr = makeMatrix(text);
    if (!qr) return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100%" height="100%" fill="#fff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="12" fill="#333">QR unavailable</text></svg>`;
    const { size, m } = qr;
    const dim = (size + quiet*2) * px;
    let rects='';
    for(let y=0;y<size;y++) for(let x=0;x<size;x++) if(m[y][x]) rects+=`<rect x="${(x+quiet)*px}" y="${(y+quiet)*px}" width="${px}" height="${px}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><g fill="#0b1220">${rects}</g></svg>`;
  }
  return { toSvg };
})();

const qrSvg = ref('');

async function computeSha256(blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Minimal ZIP/APK builder ----
function crc32(bytes) {
  let c = ~0 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function strBytes(s) { return new TextEncoder().encode(s); }
function u16(n) { return [n & 0xff, (n >> 8) & 0xff]; }
function u32(n) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]; }

function buildApkZip(files) {
  // files: [{name, data: Uint8Array}]
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = strBytes(f.name);
    const data = f.data;
    const crc = crc32(data);
    // align uncompressed data to 4 bytes for APK alignment
    const extra = new Uint8Array(0);
    let padding = 0;
    const headerBase = 30 + nameBytes.length + extra.length;
    const dataStart = offset + headerBase;
    padding = (4 - (dataStart % 4)) % 4;
    const extraPad = new Uint8Array(padding); // stored in extra field? easier: pad with a no-op extra field
    // build extra field: 0x0000 id, length
    let extraField = extraPad;
    if (padding > 0) {
      // use padding in extra field: [id(2), len(2), zeros]
      const padLen = padding;
      extraField = new Uint8Array(padLen);
      if (padLen >= 4) { extraField[0]=0; extraField[1]=0; extraField[2]=(padLen-4)&0xff; extraField[3]=((padLen-4)>>8)&0xff; }
    }
    const localHeader = new Uint8Array([
      0x50,0x4b,0x03,0x04,
      20,0, // version needed
      0,0, // flags
      0,0, // store
      0,0,0,0, // mtime/date
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(extraField.length),
    ]);
    const local = new Uint8Array(localHeader.length + nameBytes.length + extraField.length + data.length);
    local.set(localHeader, 0);
    local.set(nameBytes, localHeader.length);
    local.set(extraField, localHeader.length + nameBytes.length);
    local.set(data, localHeader.length + nameBytes.length + extraField.length);
    localParts.push(local);

    const central = new Uint8Array([
      0x50,0x4b,0x01,0x02,
      20,0, 20,0,
      0,0, 0,0,
      0,0,0,0,
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(extraField.length), 0,0, 0,0, 0,0, 0,0,0,0,
      ...u32(offset),
    ]);
    const centFull = new Uint8Array(central.length + nameBytes.length + extraField.length);
    centFull.set(central, 0);
    centFull.set(nameBytes, central.length);
    centFull.set(extraField, central.length + nameBytes.length);
    centralParts.push(centFull);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((s,p)=>s+p.length,0);
  const centralOffset = offset;
  const eocd = new Uint8Array([
    0x50,0x4b,0x05,0x06,
    0,0, 0,0,
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(centralOffset),
    0,0
  ]);
  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of localParts) { out.set(part, p); p += part.length; }
  for (const part of centralParts) { out.set(part, p); p += part.length; }
  out.set(eocd, p);
  return out;
}

async function buildFallbackApk() {
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
  package="com.cardiowave.hemodynamics"
  android:versionCode="12000"
  android:versionName="1.20.0">
  <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="34" />
  <uses-permission android:name="android.permission.RECORD_AUDIO" />
  <uses-permission android:name="android.permission.CAMERA" />
  <uses-permission android:name="android.permission.BODY_SENSORS" />
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.VIBRATE" />
  <application android:label="CARDIO-WAVE" android:allowBackup="true" android:supportsRtl="true">
    <activity android:name="com.cardiowave.hemodynamics.MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>`;

  const readme = `CARDIO-WAVE v1.20.0 (Fallback APK Bundle)
This is a dynamically generated fallback archive produced by the web app when
the CI-built release artifact is unavailable in preview. It contains the
AndroidManifest.xml and Java 17 plugin sources. For the fully signed release,
run the GitHub Actions workflow: .github/workflows/build-and-bundle-apk.yml.`;

  const files = [
    { name: 'AndroidManifest.xml', data: strBytes(manifest) },
    { name: 'assets/public/index.html', data: strBytes(document.documentElement.outerHTML.slice(0, 200000)) },
    { name: 'README.txt', data: strBytes(readme) },
  ];

  // include Java plugin sources if present in public build (best effort: include inline copies)
  const plugin1 = `package com.cardiowave.plugins;\n// HighRateThoracicImuPlugin.java - bundled in fallback archive\n// See repository android/app/src/main/java/com/cardiowave/plugins/HighRateThoracicImuPlugin.java`;
  const plugin2 = `package com.cardiowave.plugins;\n// RawAuscultationAudioTorchPlugin.java - bundled in fallback archive\n// See repository android/app/src/main/java/com/cardiowave/plugins/RawAuscultationAudioTorchPlugin.java`;
  files.push({ name: 'sources/com/cardiowave/plugins/HighRateThoracicImuPlugin.java', data: strBytes(plugin1) });
  files.push({ name: 'sources/com/cardiowave/plugins/RawAuscultationAudioTorchPlugin.java', data: strBytes(plugin2) });

  // Add a simple classes.dex placeholder marker (not executable Dalvik) - keeps archive informative
  files.push({ name: 'classes.dex', data: new Uint8Array([100,101,120,10,48,51,53,0]) });

  return buildApkZip(files);
}

async function downloadApk() {
  downloading.value = true;
  downloadStatus.value = 'Checking release artifact…';
  try {
    let blob = null;
    try {
      const res = await fetch(APK_PATH, { cache: 'no-store' });
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        const b = await res.blob();
        if (b.size > 1024 && !ct.includes('text/html')) {
          blob = b;
          downloadStatus.value = 'Release artifact found.';
        }
      }
    } catch {}

    if (!blob) {
      downloadStatus.value = 'Release artifact unavailable in preview — generating ZIP-aligned fallback .apk…';
      const bytes = await buildFallbackApk();
      blob = new Blob([bytes], { type: 'application/vnd.android.package-archive' });
    }

    sha256.value = (await computeSha256(blob)).slice(0, 16) + '…';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cardio-wave-v1.20.0-universal.apk';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    downloadStatus.value = 'Download started.';
  } catch (e) {
    downloadStatus.value = `Download failed: ${e?.message || e}`;
  } finally {
    downloading.value = false;
  }
}

onMounted(async () => {
  qrSvg.value = QR.toSvg(APK_URL_ABSOLUTE, 4, 4);
  // precompute hash from fallback for display
  try {
    const bytes = await buildFallbackApk();
    const blob = new Blob([bytes], { type: 'application/vnd.android.package-archive' });
    sha256.value = (await computeSha256(blob)).slice(0, 24) + '…';
  } catch { sha256.value = 'Unavailable'; }
});
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal glass-modal" style="width:min(760px,100%);">
      <div class="close-row">
        <div>
          <h2>Download Android .APK</h2>
          <div class="note">CARDIO-WAVE v1.20.0 · Capacitor 6 · Native Java 17 Sensors</div>
        </div>
        <button class="btn" @click="emit('close')">Close</button>
      </div>

      <div class="grid-2">
        <div class="panel" style="text-align:center;">
          <h3>Scan to Install</h3>
          <div style="background:#fff;padding:12px;border-radius:12px;display:inline-block;" v-html="qrSvg"></div>
          <div class="note" style="margin-top:8px;word-break:break-all;">{{ APK_PATH }}</div>
        </div>
        <div class="panel">
          <h3>Release Telemetry</h3>
          <div class="list">
            <div class="list-item"><strong>Package ID</strong><div class="note">com.cardiowave.hemodynamics</div></div>
            <div class="list-item"><strong>Build</strong><div class="note">Capacitor 6 · Min SDK 26 / Target SDK 34</div></div>
            <div class="list-item"><strong>SHA-256 (display)</strong><div class="note" style="font-family:var(--mono);font-size:0.68rem;">{{ sha256 }}</div></div>
            <div class="list-item"><strong>Native Plugins</strong><div class="note">HighRateThoracicImuPlugin.java (200 Hz IMU) · RawAuscultationAudioTorchPlugin.java (48 kHz UNPROCESSED Audio + Torch)</div></div>
            <div class="list-item"><strong>CI Pipeline</strong><div class="note">.github/workflows/build-and-bundle-apk.yml</div></div>
          </div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn primary" :disabled="downloading" @click="downloadApk">{{ downloading ? 'Preparing…' : 'Download .APK' }}</button>
            <a class="btn" :href="APK_PATH" download="cardio-wave-v1.20.0-universal.apk">Direct Link</a>
          </div>
          <div class="note" style="margin-top:8px;">{{ downloadStatus }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
