// physics.js — longitudinal model of a standing-start run, calibrated per car.
//
// Each car is reduced to a point mass with a three-term acceleration law:
//
//   a(v, t) = min(A·launch(t), P / v) − k·v² − Crr·g        (and a = 0 at top speed)
//
//   A       traction limit, m/s² (what the tyres can put down off the line)
//   P       specific wheel power, W/kg (power-limited region, a ∝ 1/v)
//   k       aerodynamic drag per unit mass, 1/m: ½·ρ·CdA / m
//   launch  short grip build-up over the first 0.2 s
//
// A and P are not guessed: they are solved so that the model reproduces the
// car's published 0–100 km/h time exactly, plus a second published anchor when
// one exists (0–200 km/h, or a quarter-mile ET from an instrumented test).
// Everything else (60 ft, 1/8 mile, trap speed…) then falls out of the model.

export const G = 9.80665;
export const RHO = 1.2;               // air density, kg/m³
export const CRR = 0.012;             // rolling resistance coefficient
export const QUARTER_MILE = 402.336;  // m
export const EIGHTH_MILE = 201.168;
export const ROLLOUT = 0.3048;        // 1 ft: ET clock starts when the car clears the stage beam
export const TRAP_LENGTH = 20.1168;   // 66 ft speed trap ending at the finish line
export const LAUNCH_RAMP = 0.2;       // s

const KMH = 1 / 3.6;
const DT = 0.001;                     // integration step, s

/** Acceleration for a given state and car parameters. */
export function accel(p, v, t) {
  if (v >= p.vmax) return 0;
  const launch = 0.6 + 0.4 * Math.min(1, t / LAUNCH_RAMP);
  const drive = Math.min(p.A * launch, p.P / Math.max(v, 0.1));
  return Math.max(0, drive - p.k * v * v - CRR * G);
}

/**
 * Integrates the run until `stop(state)` returns true (or tMax).
 * `onSample` gets every step's state; keep it cheap.
 */
function integrate(p, stop, onSample, tMax = 90) {
  let t = 0, v = 0, x = 0;
  while (t < tMax) {
    // Semi-implicit midpoint step: plenty accurate at 1 ms.
    const a1 = accel(p, v, t);
    const vMid = v + a1 * DT / 2;
    const a2 = accel(p, vMid, t + DT / 2);
    const vNext = Math.min(p.vmax, v + a2 * DT);
    x += (v + vNext) / 2 * DT;
    v = vNext;
    t += DT;
    if (onSample) onSample(t, v, x, a2);
    if (stop(t, v, x)) return { t, v, x, done: true };
  }
  return { t, v, x, done: false };
}

/** Time from rest to a speed in km/h (Infinity if never reached). */
export function timeToSpeed(p, kmh) {
  const target = kmh * KMH;
  if (target >= p.vmax) return Infinity;
  let prev = { t: 0, v: 0 };
  const r = integrate(p, (t, v) => {
    if (v >= target) return true;
    prev = { t, v };
    return false;
  });
  if (!r.done) return Infinity;
  // Interpolate inside the last step.
  return prev.t + (target - prev.v) / (r.v - prev.v) * (r.t - prev.t);
}

/** Time from rest to a distance in metres. */
export function timeToDistance(p, metres) {
  let prev = { t: 0, x: 0 };
  const r = integrate(p, (t, v, x) => {
    if (x >= metres) return true;
    prev = { t, x };
    return false;
  });
  if (!r.done) return Infinity;
  return prev.t + (metres - prev.x) / (r.x - prev.x) * (r.t - prev.t);
}

/** Drag-strip elapsed time for a distance: the clock starts after 1 ft of rollout. */
export function elapsedTime(p, metres) {
  return timeToDistance(p, metres + ROLLOUT) - timeToDistance(p, ROLLOUT);
}

/** Average speed through the 66 ft trap before the finish line, km/h. */
export function trapSpeed(p, finish = QUARTER_MILE) {
  const dt = timeToDistance(p, finish + ROLLOUT) - timeToDistance(p, finish + ROLLOUT - TRAP_LENGTH);
  return TRAP_LENGTH / dt * 3.6;
}

/** Bisection on a monotonically decreasing f; returns x with f(x) ≈ target. */
function solveDecreasing(f, target, lo, hi, iterations = 48) {
  for (let i = 0; i < iterations; i++) {
    const mid = Math.sqrt(lo * hi); // geometric: parameters span decades
    if (f(mid) > target) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

const A_MIN = 0.5, A_MAX = 40;
const P_MIN = 2, P_MAX = 3000;

/** Typical traction limits when only a 0–100 time is known. */
const TYPICAL_GRIP = { FWD: 0.75 * G, RWD: 0.85 * G, AWD: 1.0 * G };

/** Second anchor's measured time for given parameters. */
function anchorTime(p, anchor) {
  if (anchor.kmh) return timeToSpeed(p, anchor.kmh);
  return elapsedTime(p, anchor.metres);
}

/**
 * Solves the car's model parameters from its published figures.
 * Returns { A, P, k, vmax, method }.
 */
export function calibrate(car) {
  const k = 0.5 * RHO * car.cda / car.kg;
  const vmax = car.top * KMH;
  const base = { k, vmax };
  const t100 = car.t100;
  const t100With = (A, P) => timeToSpeed({ ...base, A, P }, 100);

  // Traction limit that yields the published 0–100 for a given power.
  const solveA = (P) => solveDecreasing((A) => t100With(A, P), t100, A_MIN, A_MAX, 26);

  if (car.anchor) {
    // Lowest power at which 0–100 is reachable at all (with max traction).
    const pFloor = solveDecreasing((P) => t100With(A_MAX, P), t100, P_MIN, P_MAX, 26) * 1.002;
    const timeAt = (P) => anchorTime({ ...base, A: solveA(P), P }, car.anchor);
    const target = car.anchor.t;
    let P;
    if (timeAt(pFloor) <= target) P = pFloor;
    else if (timeAt(P_MAX) >= target) P = P_MAX;
    else P = solveDecreasing(timeAt, target, pFloor, P_MAX, 24);
    return { ...base, A: solveA(P), P, method: 'two-anchor' };
  }

  // Only 0–100 known: assume a typical traction limit for the layout (raised if
  // the car is quicker than that allows) and solve the power that fits.
  let A = Math.max(TYPICAL_GRIP[car.drive] || G, 1.12 * (100 * KMH) / t100);
  while (t100With(A, P_MAX) > t100 && A < A_MAX) A *= 1.1;
  const P = solveDecreasing((P) => t100With(A, P), t100, P_MIN, P_MAX, 30);
  return { ...base, A, P, method: 'one-anchor' };
}

/**
 * Pre-computes the run as a dense trace for animation and charts:
 * arrays of t (s), v (m/s), x (m), a (m/s²) every `step` seconds, until the
 * car passes `untilMetres` (+ shutdown margin) or `tMax`.
 */
export function trace(p, untilMetres = QUARTER_MILE + 60, step = 0.01, tMax = 40) {
  const out = { t: [0], v: [0], x: [0], a: [accel(p, 0, 0)] };
  let next = step;
  integrate(p, (t, v, x) => x >= untilMetres, (t, v, x, a) => {
    if (t + 1e-9 >= next) {
      out.t.push(t); out.v.push(v); out.x.push(x); out.a.push(a);
      next += step;
    }
  }, tMax);
  return out;
}

/** Linear lookup into a trace at time t. */
export function sample(tr, t) {
  const n = tr.t.length;
  if (t <= 0) return { v: 0, x: 0, a: tr.a[0] };
  const step = tr.t[1] - tr.t[0];
  const i = Math.min(n - 2, Math.floor(t / step));
  if (t >= tr.t[n - 1]) {
    // Beyond the trace: keep rolling at the last speed.
    const dt = t - tr.t[n - 1];
    return { v: tr.v[n - 1], x: tr.x[n - 1] + tr.v[n - 1] * dt, a: 0 };
  }
  const f = (t - tr.t[i]) / (tr.t[i + 1] - tr.t[i]);
  return {
    v: tr.v[i] + (tr.v[i + 1] - tr.v[i]) * f,
    x: tr.x[i] + (tr.x[i + 1] - tr.x[i]) * f,
    a: tr.a[i] + (tr.a[i + 1] - tr.a[i]) * f,
  };
}

/** Full timing slip for a calibrated car. */
export function timeslip(p) {
  return {
    t60ft: elapsedTime(p, 18.288),
    t330ft: elapsedTime(p, 100.584),
    eighthET: elapsedTime(p, EIGHTH_MILE),
    eighthTrap: trapSpeed(p, EIGHTH_MILE),
    t1000ft: elapsedTime(p, 304.8),
    quarterET: elapsedTime(p, QUARTER_MILE),
    quarterTrap: trapSpeed(p, QUARTER_MILE),
    t100: timeToSpeed(p, 100),
    t200: timeToSpeed(p, 200),
  };
}
