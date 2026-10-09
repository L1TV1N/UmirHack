/** Звук и вибрация при распознавании: на складе смотреть в экран некогда. Всё необязательное, сбой молчаливый. */
let audio: AudioContext | null = null;

export function beep(ok: boolean): void {
  try {
    navigator.vibrate?.(ok ? 40 : [70, 50, 70]);
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = ok ? 1100 : 280;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (ok ? 0.08 : 0.22));
  } catch {
    // звук не получился, ничего страшного
  }
}
