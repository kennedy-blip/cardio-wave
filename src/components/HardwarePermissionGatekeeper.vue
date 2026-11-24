<script setup>
import { ref, onMounted } from 'vue';

const props = defineProps({
  activeModule: { type: String, default: 'pcg' },
});

const caps = ref([
  { id: 'mic', label: 'Unprocessed Mic (48kHz)', status: 'unknown', detail: 'echoCancellation/noiseSuppression/AGC off' },
  { id: 'imu', label: 'High-Rate IMU (60–200Hz)', status: 'unknown', detail: 'SCG + tilt clinometer' },
  { id: 'camera', label: 'Rear Camera + Torch', status: 'unknown', detail: 'PPG + qCRT 60 FPS' },
  { id: 'haptics', label: 'Haptics / Storage', status: 'unknown', detail: 'vibrate + persist()' },
]);

async function probe() {
  const next = caps.value.map((c) => ({ ...c }));
  // Mic
  try {
    const hasMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    next.find((c) => c.id === 'mic').status = hasMic ? 'sim' : 'restricted';
    if (hasMic) next.find((c) => c.id === 'mic').detail = 'Available; unprocessed constraints requested on start';
  } catch { next.find((c) => c.id === 'mic').status = 'restricted'; }
  // IMU
  const hasMotion = typeof window.DeviceMotionEvent !== 'undefined';
  next.find((c) => c.id === 'imu').status = hasMotion ? 'sim' : 'restricted';
  next.find((c) => c.id === 'imu').detail = hasMotion ? 'DeviceMotionEvent available; permission on start' : 'No DeviceMotionEvent';
  // Camera
  const hasCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  next.find((c) => c.id === 'camera').status = hasCam ? 'sim' : 'restricted';
  // Haptics/storage
  const hasVib = typeof navigator.vibrate === 'function';
  const hasPersist = !!(navigator.storage && navigator.storage.persist);
  next.find((c) => c.id === 'haptics').status = (hasVib || hasPersist) ? 'active' : 'restricted';
  next.find((c) => c.id === 'haptics').detail = `vibrate:${hasVib ? 'yes' : 'no'} · persist:${hasPersist ? 'yes' : 'no'}`;
  caps.value = next;

  if (navigator.storage?.persist) {
    try { await navigator.storage.persist(); } catch {}
  }
}

onMounted(probe);

function statusClass(s) {
  if (s === 'active') return 'active';
  if (s === 'sim') return 'sim';
  if (s === 'restricted') return 'warn';
  return '';
}
function statusLabel(s) {
  if (s === 'active') return 'ACTIVE';
  if (s === 'sim') return 'READY / SIMULATOR';
  if (s === 'restricted') return 'RESTRICTED';
  return 'UNKNOWN';
}
</script>

<template>
  <div class="status-ribbon glass" aria-label="Hardware permissions">
    <span style="font-size:0.72rem;color:var(--muted);margin-right:4px;">Sensor Gatekeeper:</span>
    <span v-for="c in caps" :key="c.id" class="badge" :class="statusClass(c.status)" :title="c.detail">
      <span class="dot"></span>
      {{ c.label }} · {{ statusLabel(c.status) }}
    </span>
  </div>
</template>
