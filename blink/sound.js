// Синтез коротких звуков через Web Audio API — без аудиофайлов.

let ctx = null;

// AudioContext можно запустить только после жеста пользователя.
export function unlockAudio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function envelope(gain, t, volume, attack, decay) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0002), t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

const SOUNDS = {
  beep(ac, out, t, volume) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    envelope(gain, t, volume, 0.005, 0.15);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.2);
  },

  pop(ac, out, t, volume) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.12);
    envelope(gain, t, volume, 0.003, 0.12);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.15);
  },

  bell(ac, out, t, volume) {
    for (const [freq, share] of [[1320, 1], [2640, 0.4], [3960, 0.2]]) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      envelope(gain, t, volume * share, 0.004, 0.6);
      osc.connect(gain).connect(out);
      osc.start(t);
      osc.stop(t + 0.7);
    }
  },

  click(ac, out, t, volume) {
    const length = Math.floor(ac.sampleRate * 0.03);
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    const src = ac.createBufferSource();
    const gain = ac.createGain();
    src.buffer = buffer;
    gain.gain.value = volume;
    src.connect(gain).connect(out);
    src.start(t);
  },
};

export const SOUND_NAMES = Object.keys(SOUNDS);

export function playSound(name, volume = 0.5) {
  const ac = unlockAudio();
  (SOUNDS[name] || SOUNDS.beep)(ac, ac.destination, ac.currentTime, volume);
}
