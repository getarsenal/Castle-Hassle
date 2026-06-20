// Game-wide tactile feedback: a sound + a haptic on every meaningful interaction,
// so the whole UI feels alive. Built on the procedural audio engine plus
// Capacitor Haptics (native iOS Taptic Engine) with a web Vibration fallback.
import { battleAudio } from './audio';

type Hap = 'light' | 'medium' | 'heavy' | 'success' | 'warning';
function haptic(kind: Hap) {
  try {
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.() && cap.Plugins?.Haptics) {
      const H = cap.Plugins.Haptics;
      if (kind === 'success' || kind === 'warning') H.notification({ type: kind.toUpperCase() });
      else H.impact({ style: kind.toUpperCase() });
    } else if ((navigator as any).vibrate) {
      const v = kind === 'success' ? [10, 35, 10] : kind === 'warning' ? [8, 26, 8] : kind === 'medium' ? 16 : kind === 'heavy' ? 24 : 7;
      (navigator as any).vibrate(v);
    }
  } catch { /* haptics are best-effort */ }
}

// Named feedbacks for moments the global dispatcher can't infer.
export const feedback = {
  reward() { battleAudio.reward(); haptic('success'); },
  unlock() { battleAudio.unlock(); haptic('success'); },
  open() { battleAudio.whoosh(true); haptic('light'); },
  close() { battleAudio.whoosh(false); haptic('light'); },
  coin() { battleAudio.coin(); haptic('medium'); },
  commit() { battleAudio.commit(); haptic('medium'); },
  tap() { battleAudio.tap(); haptic('light'); },
};

// One global listener gives EVERY button/control a press sound + haptic, mapped by
// what was pressed — so new buttons anywhere in the game are covered for free.
export function installFeedback() {
  document.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement)?.closest?.('button, .card') as HTMLElement | null;
    if (!el) return;
    const cl = el.classList;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') { battleAudio.denied(); haptic('warning'); return; }
    if (/close/i.test(el.className) || el.id === 'musterBack') { battleAudio.whoosh(false); haptic('light'); return; }
    if (cl.contains('rec') || cl.contains('musRec') || cl.contains('buy')) { battleAudio.coin(); haptic('medium'); return; }      // purchases
    if (cl.contains('go') || cl.contains('raidGo') || el.id === 'musterBtn') { battleAudio.commit(); haptic('medium'); return; } // commit to a fight
    if (cl.contains('card')) { battleAudio.select(); haptic('light'); return; }                                                  // select an arm
    battleAudio.tap(); haptic('light');
  }, true); // capture so it fires even when a handler stops propagation
}
