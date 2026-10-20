// Точка входа: камера → MediaPipe Face Landmarker → детектор моргания → звук.

import { BlinkDetector, blinkScore } from './detector.js';
import { playSound, unlockAudio } from './sound.js';

const MEDIAPIPE_VERSION = '0.10.14';
const MEDIAPIPE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const RATE_WINDOW_MS = 60_000;

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'),
  video: $('video'),
  overlay: $('overlay'),
  flash: $('flash'),
  start: $('start'),
  status: $('status'),
  count: $('count'),
  rate: $('rate'),
  meterFill: $('meterFill'),
  meterMark: $('meterMark'),
  sound: $('sound'),
  volume: $('volume'),
  threshold: $('threshold'),
  thresholdOut: $('thresholdOut'),
  mode: $('mode'),
  test: $('test'),
  reset: $('reset'),
};

const detector = new BlinkDetector({ closeThreshold: Number(el.threshold.value) });
const blinkTimes = [];
let landmarker = null;
let vision = null;
let drawing = null;
let lastVideoTime = -1;

// ---- Интерфейс ----

function setStatus(text, warn = false) {
  el.status.textContent = text;
  el.status.classList.toggle('warn', warn);
}

function setState(state) {
  el.stage.dataset.state = state;
}

function updateThresholdUi() {
  const value = Number(el.threshold.value);
  el.thresholdOut.textContent = value.toFixed(2);
  el.meterMark.style.left = `${value * 100}%`;
  detector.setOptions({ closeThreshold: value });
}

function updateStats(now) {
  while (blinkTimes.length && now - blinkTimes[0] > RATE_WINDOW_MS) blinkTimes.shift();
  el.count.textContent = String(detector.count);
  el.rate.textContent = detector.count ? String(blinkTimes.length) : '—';
}

function flash() {
  el.flash.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => el.flash.classList.remove('on')));
}

function beep() {
  playSound(el.sound.value, Number(el.volume.value));
}

// ---- Отрисовка глаз ----

function drawEyes(landmarks, closed) {
  const canvas = el.overlay;
  const ctx = canvas.getContext('2d');
  if (canvas.width !== el.video.videoWidth || canvas.height !== el.video.videoHeight) {
    canvas.width = el.video.videoWidth;
    canvas.height = el.video.videoHeight;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!landmarks) return;
  const color = closed ? '#f5b942' : '#4fd1a5';
  const { FaceLandmarker } = vision;
  for (const set of [FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE]) {
    drawing.drawConnectors(landmarks, set, { color, lineWidth: 2 });
  }
}

// ---- Основной цикл ----

function loop() {
  const video = el.video;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const result = landmarker.detectForVideo(video, now);
    const face = result.faceBlendshapes?.[0];

    if (!face) {
      detector.lost();
      drawEyes(null, false);
      el.meterFill.style.width = '0%';
      setStatus('Лицо не найдено — посмотрите в камеру', true);
    } else {
      const score = blinkScore(face.categories, el.mode.value);
      const event = detector.update(score, now);
      if (event === 'close') {
        beep();
        flash();
      } else if (event === 'blink') {
        blinkTimes.push(now);
      }
      el.meterFill.style.width = `${Math.round(score * 100)}%`;
      drawEyes(result.faceLandmarks[0], detector.closed);
      setStatus(detector.closed ? 'Глаза закрыты' : 'Слежу за глазами');
    }
    updateStats(now);
  }
  requestAnimationFrame(loop);
}

// ---- Запуск ----

async function loadLandmarker() {
  vision = await import(`${MEDIAPIPE_URL}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MEDIAPIPE_URL}/wasm`);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  };
  try {
    landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options);
  } catch {
    // Нет WebGL — работаем на CPU.
    options.baseOptions.delegate = 'CPU';
    landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options);
  }
  drawing = new vision.DrawingUtils(el.overlay.getContext('2d'));
}

async function start() {
  unlockAudio();
  setState('loading');

  if (!navigator.mediaDevices?.getUserMedia) {
    setState('error');
    setStatus('Браузер не даёт доступ к камере. Откройте страницу по https или с localhost.', true);
    return;
  }

  try {
    setStatus('Запрашиваю доступ к камере…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    el.video.srcObject = stream;
    await el.video.play();
  } catch (err) {
    setState('error');
    const denied = err?.name === 'NotAllowedError';
    setStatus(denied ? 'Доступ к камере запрещён — разрешите его в настройках браузера.' : `Камера недоступна: ${err?.message || err}`, true);
    return;
  }

  try {
    setStatus('Загружаю модель распознавания лица…');
    await loadLandmarker();
  } catch (err) {
    setState('error');
    setStatus(`Не удалось загрузить модель: ${err?.message || err}`, true);
    return;
  }

  setState('running');
  setStatus('Слежу за глазами');
  requestAnimationFrame(loop);
}

el.start.addEventListener('click', start);
el.threshold.addEventListener('input', updateThresholdUi);
el.test.addEventListener('click', () => { beep(); flash(); });
el.reset.addEventListener('click', () => {
  detector.reset();
  blinkTimes.length = 0;
  updateStats(performance.now());
});
updateThresholdUi();
