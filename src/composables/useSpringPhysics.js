import { ref, onBeforeUnmount } from 'vue';

/**
 * Hooke's Law second-order spring: x'' = -k(x - x_target) - c*x'
 * stiffness k=190, damping c=22 by default.
 * Returns a reactive value and controls.
 */
export function useSpringPhysics(initial = 0, options = {}) {
  const stiffness = options.stiffness ?? 190;
  const damping = options.damping ?? 22;
  const precision = options.precision ?? 0.0005;

  const value = ref(initial);
  let target = initial;
  let velocity = 0;
  let rafId = null;
  let lastT = 0;

  const step = (t) => {
    if (!lastT) lastT = t;
    // clamp dt to avoid instability on tab switches
    const dt = Math.min(0.032, Math.max(0.001, (t - lastT) / 1000));
    lastT = t;

    const displacement = value.value - target;
    const springForce = -stiffness * displacement;
    const dampingForce = -damping * velocity;
    const accel = springForce + dampingForce; // mass = 1
    velocity += accel * dt;
    value.value += velocity * dt;

    if (Math.abs(value.value - target) < precision && Math.abs(velocity) < precision) {
      value.value = target;
      velocity = 0;
      rafId = null;
      lastT = 0;
      return;
    }
    rafId = requestAnimationFrame(step);
  };

  const start = () => {
    if (rafId == null) {
      lastT = 0;
      rafId = requestAnimationFrame(step);
    }
  };

  const setTarget = (next) => {
    target = Number(next);
    start();
  };

  const snap = (next) => {
    target = Number(next);
    value.value = target;
    velocity = 0;
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      lastT = 0;
    }
  };

  onBeforeUnmount(() => {
    if (rafId != null) cancelAnimationFrame(rafId);
  });

  return { value, setTarget, snap, getTarget: () => target };
}

/**
 * Create a small spring map for multiple keyed values (e.g. card scales).
 * Not a composable-per-key overhead; uses a single RAF loop.
 */
export function createSpringGroup(keys = [], initial = 0, options = {}) {
  const stiffness = options.stiffness ?? 190;
  const damping = options.damping ?? 22;
  const precision = options.precision ?? 0.0005;
  const state = {};
  for (const k of keys) {
    state[k] = { value: initial, target: initial, velocity: 0 };
  }
  const listeners = new Set();
  let rafId = null;
  let lastT = 0;

  const notify = () => { for (const fn of listeners) fn(state); };

  const step = (t) => {
    if (!lastT) lastT = t;
    const dt = Math.min(0.032, Math.max(0.001, (t - lastT) / 1000));
    lastT = t;
    let moving = false;
    for (const k of Object.keys(state)) {
      const s = state[k];
      const disp = s.value - s.target;
      const accel = -stiffness * disp - damping * s.velocity;
      s.velocity += accel * dt;
      s.value += s.velocity * dt;
      if (Math.abs(s.value - s.target) < precision && Math.abs(s.velocity) < precision) {
        s.value = s.target;
        s.velocity = 0;
      } else {
        moving = true;
      }
    }
    notify();
    if (moving) {
      rafId = requestAnimationFrame(step);
    } else {
      rafId = null;
      lastT = 0;
    }
  };

  const ensure = (k) => {
    if (!state[k]) state[k] = { value: initial, target: initial, velocity: 0 };
    return state[k];
  };

  const start = () => {
    if (rafId == null) {
      lastT = 0;
      rafId = requestAnimationFrame(step);
    }
  };

  return {
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(k, target) { ensure(k).target = Number(target); start(); },
    snap(k, target) { const s = ensure(k); s.target = Number(target); s.value = s.target; s.velocity = 0; notify(); },
    get(k) { return ensure(k).value; },
    dispose() { if (rafId != null) cancelAnimationFrame(rafId); listeners.clear(); },
  };
}
