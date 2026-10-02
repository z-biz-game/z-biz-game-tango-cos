// Sound. A code-breaking game has exactly three sounds worth having: a peg landing, the answer
// coming back, and the verdict. Everything is synthesised — no sample files, so nothing to
// download and nothing that can 404 offline.
//
// MUTE IS NOT A GAIN KNOB. `setMuted(true)` calls `suspend()` on the AudioContext AND makes the
// voice builders refuse to create a node: an oscillator created while "muted" and merely scaled
// to 0 still runs, still counts against the context, and starts audible the moment a stale
// resume() lands. `voicesCreated` is the witness — a test mutes, plays every cue and asserts the
// counter did not move.
//
// The context is created on the first cue, which in a browser means the first real gesture
// (pointerdown/keydown). Constructing it earlier yields a suspended context that never wakes, so
// the lazy creation is load-bearing, not tidiness.

const STEPS = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25]; // C D E G A C — one per colour

export function createAudio(opts = {}) {
  const Ctor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  let ctx = null;
  let master = null;
  let muted = !!opts.muted;
  let voices = 0;

  function context() {
    if (muted || !Ctor) return null;
    if (!ctx) {
      try {
        ctx = new Ctor();
      } catch (err) {
        return null;
      }
      master = ctx.createGain();
      master.gain.value = 0.16;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => { /* autoplay policy, retried next cue */ });
    return ctx;
  }

  // One short envelope. `type` is the waveform, `at` a delay in seconds so a cue can be a chord.
  function voice(freq, dur, { type = 'triangle', at = 0, vol = 1 } = {}) {
    const c = context();
    if (!c) return false;
    const osc = c.createOscillator();
    const gain = c.createGain();
    voices++;
    osc.type = type;
    osc.frequency.value = freq;
    const t0 = c.currentTime + at;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    return true;
  }

  const cues = {
    // A peg landing: pitch says which colour, so the hand learns the scale.
    put(colour) { voice(STEPS[colour % STEPS.length], 0.07, { vol: 0.5 }); },
    take() { voice(STEPS[0] / 2, 0.05, { type: 'sine', vol: 0.35 }); },
    // The answer coming back: one black peg is one rising ping, so (2,1) is literally audible.
    answer(black, white) {
      for (let i = 0; i < black; i++) voice(523.25 * (1 + i * 0.18), 0.1, { at: i * 0.06, vol: 0.55 });
      for (let i = 0; i < white; i++) voice(329.63, 0.06, { type: 'sine', at: 0.04 + i * 0.05, vol: 0.3 });
      if (!black && !white) voice(196.0, 0.12, { type: 'sine', vol: 0.3 });
    },
    illegal() { voice(110.0, 0.12, { type: 'square', vol: 0.22 }); },
    hint() { voice(784.0, 0.09, { type: 'sine', vol: 0.4 }); voice(1046.5, 0.09, { type: 'sine', at: 0.07, vol: 0.3 }); },
    win() { [0, 2, 4, 5].forEach((s, i) => voice(STEPS[s], 0.16, { at: i * 0.09, vol: 0.5 })); },
    lose() { [4, 2, 0].forEach((s, i) => voice(STEPS[s] / 2, 0.2, { at: i * 0.13, type: 'sine', vol: 0.4 })); },
    ui() { voice(659.25, 0.04, { type: 'sine', vol: 0.25 }); },
  };

  return {
    play(name, ...args) {
      const cue = cues[name];
      if (!cue) return false;
      cue(...args);
      return true;
    },
    // Muting suspends the context; unmuting resumes it. Nothing is ever "muted" by scaling a
    // node, and no voice is built while muted.
    setMuted(v) {
      muted = !!v;
      if (muted && ctx && ctx.state === 'running') ctx.suspend().catch(() => { /* not yet running */ });
      if (!muted && ctx && ctx.state === 'suspended') ctx.resume().catch(() => { /* gesture will */ });
      return muted;
    },
    get muted() { return muted; },
    // Where the audio actually is: `closed` before the first gesture, then the real state.
    get state() { return muted ? 'muted' : (ctx ? ctx.state : 'idle'); },
    get voicesCreated() { return voices; },
    // A tab going hidden must stop the sound, not just hide it.
    suspend() { if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); },
    resume() { if (!muted && ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
  };
}
