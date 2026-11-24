package com.cardiowave.plugins;

import android.Manifest;
import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * RawAuscultationAudioTorchPlugin
 * - Captures unprocessed 48 kHz mono PCM FLOAT audio for PCG (20-100 Hz preserved).
 * - Controls rear torch for simultaneous fingertip PPG/qCRT illumination.
 */
@CapacitorPlugin(
    name = "RawAuscultationAudioTorch",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class RawAuscultationAudioTorchPlugin extends Plugin {

    private static final String TAG = "CardioWaveAudioTorch";
    private static final int SAMPLE_RATE = 48000;
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_FLOAT;
    private static final int FRAME_SAMPLES = 1024; // ~21ms

    private AudioRecord audioRecord;
    private Thread audioThread;
    private final AtomicBoolean recording = new AtomicBoolean(false);
    private ExecutorService executor;

    private CameraManager cameraManager;
    private String torchCameraId = null;
    private boolean torchOn = false;

    @Override
    public void load() {
        super.load();
        executor = Executors.newSingleThreadExecutor();
        cameraManager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
        resolveTorchCamera();
    }

    private void resolveTorchCamera() {
        if (cameraManager == null) return;
        try {
            for (String id : cameraManager.getCameraIdList()) {
                CameraCharacteristics c = cameraManager.getCameraCharacteristics(id);
                Boolean flash = c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (Boolean.TRUE.equals(flash) && facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    torchCameraId = id;
                    break;
                }
            }
            if (torchCameraId == null) {
                for (String id : cameraManager.getCameraIdList()) {
                    CameraCharacteristics c = cameraManager.getCameraCharacteristics(id);
                    Boolean flash = c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                    if (Boolean.TRUE.equals(flash)) { torchCameraId = id; break; }
                }
            }
        } catch (CameraAccessException e) {
            Log.w(TAG, "Camera access error resolving torch", e);
        }
    }

    @PluginMethod
    public void startAudio(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermCallback");
            return;
        }
        startAudioInternal(call);
    }

    @PermissionCallback
    private void microphonePermCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startAudioInternal(call);
        } else {
            call.reject("Microphone permission denied");
        }
    }

    private void startAudioInternal(PluginCall call) {
        if (recording.get()) {
            JSObject ret = new JSObject();
            ret.put("status", "already_recording");
            ret.put("sampleRate", SAMPLE_RATE);
            call.resolve(ret);
            return;
        }

        int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT);
        if (minBuf <= 0) {
            call.reject("Unsupported audio configuration");
            return;
        }
        int bufferSize = Math.max(minBuf, FRAME_SAMPLES * 4 * 4);

        int audioSource = MediaRecorder.AudioSource.UNPROCESSED;
        try {
            audioRecord = new AudioRecord(audioSource, SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT, bufferSize);
        } catch (Exception e) {
            audioRecord = null;
        }
        if (audioRecord == null || audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            // Fallback to VOICE_RECOGNITION to preserve as much low-frequency content as possible
            try {
                if (audioRecord != null) audioRecord.release();
                audioRecord = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT, bufferSize);
            } catch (Exception e) {
                call.reject("Failed to initialize AudioRecord: " + e.getMessage());
                return;
            }
        }
        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            call.reject("AudioRecord failed to initialize");
            return;
        }

        recording.set(true);
        try {
            audioRecord.startRecording();
        } catch (Exception e) {
            recording.set(false);
            call.reject("Failed to start recording: " + e.getMessage());
            return;
        }

        audioThread = new Thread(this::audioLoop, "CardioWaveAudioLoop");
        audioThread.setPriority(Thread.MAX_PRIORITY);
        audioThread.start();

        JSObject ret = new JSObject();
        ret.put("status", "recording");
        ret.put("sampleRate", SAMPLE_RATE);
        ret.put("encoding", "pcm_float32");
        ret.put("channels", 1);
        ret.put("frameSamples", FRAME_SAMPLES);
        ret.put("audioSource", audioRecord.getAudioSource() == MediaRecorder.AudioSource.UNPROCESSED ? "UNPROCESSED" : "VOICE_RECOGNITION");
        call.resolve(ret);
    }

    private void audioLoop() {
        float[] buffer = new float[FRAME_SAMPLES];
        ByteBuffer byteBuffer = ByteBuffer.allocate(FRAME_SAMPLES * 4).order(ByteOrder.LITTLE_ENDIAN);
        long seq = 0;
        while (recording.get() && audioRecord != null) {
            int read;
            try {
                read = audioRecord.read(buffer, 0, FRAME_SAMPLES, AudioRecord.READ_BLOCKING);
            } catch (Exception e) {
                Log.e(TAG, "Audio read error", e);
                break;
            }
            if (read <= 0) continue;
            byteBuffer.clear();
            for (int i = 0; i < read; i++) byteBuffer.putFloat(buffer[i]);
            byteBuffer.flip();
            byte[] bytes = new byte[read * 4];
            byteBuffer.get(bytes, 0, bytes.length);

            JSObject evt = new JSObject();
            evt.put("seq", seq++);
            evt.put("sampleRate", SAMPLE_RATE);
            evt.put("samples", read);
            evt.put("pcmBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            // Also compute a small RMS for UI metering without decoding
            double sumSq = 0;
            for (int i = 0; i < read; i++) sumSq += buffer[i] * buffer[i];
            evt.put("rms", Math.sqrt(sumSq / read));
            notifyListeners("audioFrame", evt);
        }
    }

    @PluginMethod
    public void stopAudio(PluginCall call) {
        recording.set(false);
        if (audioThread != null) {
            try { audioThread.join(500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            audioThread = null;
        }
        if (audioRecord != null) {
            try { audioRecord.stop(); } catch (Exception ignored) {}
            try { audioRecord.release(); } catch (Exception ignored) {}
            audioRecord = null;
        }
        JSObject ret = new JSObject();
        ret.put("status", "stopped");
        call.resolve(ret);
    }

    @PluginMethod
    public void setTorch(PluginCall call) {
        Boolean enable = call.getBoolean("enabled");
        if (enable == null) {
            call.reject("Missing 'enabled' boolean");
            return;
        }
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            // Torch may work without CAMERA on some devices, but request to be safe
            requestPermissionForAlias("camera", call, "cameraPermCallback");
            return;
        }
        applyTorch(call, enable);
    }

    @PermissionCallback
    private void cameraPermCallback(PluginCall call) {
        Boolean enable = call.getBoolean("enabled", false);
        applyTorch(call, enable);
    }

    private void applyTorch(PluginCall call, boolean enable) {
        if (cameraManager == null) { call.reject("CameraManager unavailable"); return; }
        if (torchCameraId == null) resolveTorchCamera();
        if (torchCameraId == null) { call.reject("No torch-capable camera found"); return; }
        try {
            cameraManager.setTorchMode(torchCameraId, enable);
            torchOn = enable;
            JSObject ret = new JSObject();
            ret.put("enabled", torchOn);
            ret.put("cameraId", torchCameraId);
            call.resolve(ret);
        } catch (CameraAccessException e) {
            call.reject("Torch error: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("recording", recording.get());
        ret.put("sampleRate", SAMPLE_RATE);
        ret.put("torchOn", torchOn);
        ret.put("torchCameraId", torchCameraId);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        recording.set(false);
        try { if (audioRecord != null) { audioRecord.stop(); audioRecord.release(); } } catch (Exception ignored) {}
        try { if (cameraManager != null && torchCameraId != null && torchOn) cameraManager.setTorchMode(torchCameraId, false); } catch (Exception ignored) {}
        if (executor != null) executor.shutdownNow();
        super.handleOnDestroy();
    }
}
