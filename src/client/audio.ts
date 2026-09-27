/** 効果音(WebAudioで合成。音源ファイル不要)。ブラウザの仕様で最初のクリック/キー操作までは鳴らない */
let ac: AudioContext | null = null;
export const audioState = { enabled: true };

function ctx(): AudioContext | null {
  if (!ac) { try { ac = new AudioContext(); } catch { return null; } }
  if (ac.state === "suspended") void ac.resume();
  return ac;
}
addEventListener("pointerdown", ctx);
addEventListener("keydown", ctx);

function tone(freq: number, dur: number, type: OscillatorType = "sine", vol = 0.15, slideTo?: number) {
  if (!audioState.enabled) return;
  const a = ctx();
  if (!a || a.state !== "running") return;
  const o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + dur);
}

export const sfx = {
  grab: () => tone(880, 0.06, "triangle", 0.08),
  place: () => tone(200, 0.12, "sine", 0.3, 90),
  capture: () => { tone(150, 0.22, "sawtooth", 0.18, 50); tone(600, 0.08, "square", 0.05, 200); },
  check: () => { tone(660, 0.12, "square", 0.07); setTimeout(() => tone(880, 0.18, "square", 0.07), 120); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.4, "triangle", 0.12), i * 140)),
  lose: () => [392, 330, 262].forEach((f, i) => setTimeout(() => tone(f, 0.5, "triangle", 0.1), i * 200)),
  notify: () => { tone(740, 0.1, "sine", 0.1); setTimeout(() => tone(988, 0.14, "sine", 0.1), 100); },
  tick: () => tone(1200, 0.04, "square", 0.05),
};
