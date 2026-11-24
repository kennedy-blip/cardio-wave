package com.cardiowave.plugins;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.SystemClock;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * HighRateThoracicImuPlugin
 * Samples TYPE_ACCELEROMETER, TYPE_GYROSCOPE, and TYPE_GAME_ROTATION_VECTOR
 * at SENSOR_DELAY_FASTEST (target ~200 Hz) for sternum SCG and tilt-table clinometry.
 *
 * Emits batched events to JS as "imuBatch" with hardware-nanosecond-aligned timestamps.
 */
@CapacitorPlugin(name = "HighRateThoracicImu")
public class HighRateThoracicImuPlugin extends Plugin implements SensorEventListener {

    private static final String TAG = "CardioWaveIMU";
    private static final int BATCH_SIZE = 20; // ~100ms at 200Hz
    private static final float ALPHA = 0.8f; // gravity high-pass filter coefficient

    private SensorManager sensorManager;
    private Sensor accelerometer;
    private Sensor gyroscope;
    private Sensor rotationVector;

    private final List<JSONObject> batchBuffer = new ArrayList<>(BATCH_SIZE * 2);
    private final float[] gravity = new float[]{0f, 0f, 0f};
    private final float[] linearAccel = new float[]{0f, 0f, 0f};
    private final float[] gyro = new float[]{0f, 0f, 0f};
    private final float[] rotation = new float[]{0f, 0f, 0f, 1f};
    private final float[] rotMatrix = new float[9];
    private final float[] orientations = new float[3];

    private volatile boolean running = false;
    private long startElapsedNs = 0L;
    private long startEventNs = 0L;
    private ExecutorService executor;

    @Override
    public void load() {
        super.load();
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            gyroscope = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
            rotationVector = sensorManager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
            if (rotationVector == null) {
                rotationVector = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            }
        }
        executor = Executors.newSingleThreadExecutor();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (sensorManager == null) {
            call.reject("SensorManager unavailable");
            return;
        }
        if (running) {
            call.resolve(statusObject("already_running"));
            return;
        }

        startElapsedNs = SystemClock.elapsedRealtimeNanos();
        startEventNs = 0L;
        running = true;
        batchBuffer.clear();

        boolean accOk = accelerometer != null && sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_FASTEST);
        boolean gyrOk = gyroscope != null && sensorManager.registerListener(this, gyroscope, SensorManager.SENSOR_DELAY_FASTEST);
        boolean rotOk = rotationVector != null && sensorManager.registerListener(this, rotationVector, SensorManager.SENSOR_DELAY_FASTEST);

        JSObject ret = statusObject("started");
        ret.put("accelerometer", accOk);
        ret.put("gyroscope", gyrOk);
        ret.put("rotationVector", rotOk);
        ret.put("targetHz", 200);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        synchronized (batchBuffer) {
            batchBuffer.clear();
        }
        call.resolve(statusObject("stopped"));
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = statusObject(running ? "running" : "idle");
        ret.put("hasAccelerometer", accelerometer != null);
        ret.put("hasGyroscope", gyroscope != null);
        ret.put("hasRotationVector", rotationVector != null);
        call.resolve(ret);
    }

    private JSObject statusObject(String status) {
        JSObject obj = new JSObject();
        obj.put("status", status);
        obj.put("running", running);
        return obj;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (!running || event == null) return;

        final int type = event.sensor.getType();
        final long eventNs = event.timestamp;
        if (startEventNs == 0L) startEventNs = eventNs;

        // Convert hardware event timestamp (ns, elapsed realtime base) to ms delta
        final double tMs = (eventNs - startEventNs) / 1_000_000.0;

        if (type == Sensor.TYPE_ACCELEROMETER) {
            // High-pass gravity filter: linear = acc - gravity
            gravity[0] = ALPHA * gravity[0] + (1 - ALPHA) * event.values[0];
            gravity[1] = ALPHA * gravity[1] + (1 - ALPHA) * event.values[1];
            gravity[2] = ALPHA * gravity[2] + (1 - ALPHA) * event.values[2];
            linearAccel[0] = event.values[0] - gravity[0];
            linearAccel[1] = event.values[1] - gravity[1];
            linearAccel[2] = event.values[2] - gravity[2];
        } else if (type == Sensor.TYPE_GYROSCOPE) {
            gyro[0] = event.values[0];
            gyro[1] = event.values[1];
            gyro[2] = event.values[2];
        } else if (type == Sensor.TYPE_GAME_ROTATION_VECTOR || type == Sensor.TYPE_ROTATION_VECTOR) {
            float[] rotVec = new float[4];
            SensorManager.getQuaternionFromVector(rotVec, event.values);
            rotation[0] = rotVec[0]; rotation[1] = rotVec[1]; rotation[2] = rotVec[2]; rotation[3] = rotVec[3];
            SensorManager.getRotationMatrixFromVector(rotMatrix, event.values);
            SensorManager.getOrientation(rotMatrix, orientations);
        } else {
            return;
        }

        // m/s^2 to milli-g: 1 m/s^2 = 101.97162129779 mG
        final double zMg = linearAccel[2] * 101.97162129779;
        final double xMg = linearAccel[0] * 101.97162129779;
        final double yMg = linearAccel[1] * 101.97162129779;
        final double pitchDeg = Math.toDegrees(orientations[1]);
        final double rollDeg = Math.toDegrees(orientations[2]);
        final double yawDeg = Math.toDegrees(orientations[0]);

        JSONObject sample = new JSONObject();
        try {
            sample.put("tMs", tMs);
            sample.put("tsNs", eventNs);
            sample.put("axMg", xMg);
            sample.put("ayMg", yMg);
            sample.put("azMg", zMg);
            sample.put("gx", gyro[0]);
            sample.put("gy", gyro[1]);
            sample.put("gz", gyro[2]);
            sample.put("pitchDeg", pitchDeg);
            sample.put("rollDeg", rollDeg);
            sample.put("yawDeg", yawDeg);
        } catch (JSONException e) {
            Log.w(TAG, "JSON sample error", e);
            return;
        }

        List<JSONObject> toSend = null;
        synchronized (batchBuffer) {
            batchBuffer.add(sample);
            if (batchBuffer.size() >= BATCH_SIZE) {
                toSend = new ArrayList<>(batchBuffer);
                batchBuffer.clear();
            }
        }

        if (toSend != null) {
            final List<JSONObject> payload = toSend;
            executor.execute(() -> emitBatch(payload));
        }
    }

    private void emitBatch(List<JSONObject> payload) {
        try {
            JSONArray arr = new JSONArray();
            double minT = Double.MAX_VALUE, maxT = -Double.MAX_VALUE;
            for (JSONObject s : payload) {
                arr.put(s);
                double t = s.optDouble("tMs", 0);
                if (t < minT) minT = t;
                if (t > maxT) maxT = t;
            }
            JSObject ret = new JSObject();
            ret.put("samples", arr);
            ret.put("count", payload.size());
            ret.put("tStartMs", minT == Double.MAX_VALUE ? 0 : minT);
            ret.put("tEndMs", maxT == -Double.MAX_VALUE ? 0 : maxT);
            notifyListeners("imuBatch", ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to emit IMU batch", e);
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // No-op; could notify JS if needed.
    }

    @Override
    protected void handleOnDestroy() {
        running = false;
        if (sensorManager != null) sensorManager.unregisterListener(this);
        if (executor != null) executor.shutdownNow();
        super.handleOnDestroy();
    }
}
