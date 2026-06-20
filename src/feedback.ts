// Game-wide tactile feedback: a sound + a haptic on every meaningful interaction,
// so the whole UI feels alive. Built on the procedural audio engine plus
// Capacitor Haptics (native iOS Taptic Engine) with a web Vibration fallback.
import { battleAudio } from './audio';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

type Hap = 'light' | 'medium' | 'heavy' | 'success' | 'warning';
function haptic(kind: Hap) {
  // Real Taptic Engine on the native iOS app; the plugin's web build falls back
  // to the Vibration API (Android) and no-ops where unsupported (iOS Safari).
  try {
    if (kind === 'success') Haptics.notification({ type: NotificationType.Success }).catch(() => {});
    else if (kind === 'warning') Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
    else Haptics.impact({ style: kind === 'medium' ? ImpactStyle.Medium : kind === 'heavy' ? ImpactStyle.Heavy : ImpactStyle.Light }).catch(() => {});
  } catch { /* best-effort */ }
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
