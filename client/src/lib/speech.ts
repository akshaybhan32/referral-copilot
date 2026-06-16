// Minimal, typed wrappers over the browser Web Speech API.
// STT (speech -> text) and TTS (text -> speech) run entirely client-side —
// no serving endpoint, no cost. Used for the mic button and read-aloud.

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionEvent {
  results: ArrayLike<ArrayLike<RecognitionAlternative>>;
}
interface RecognitionErrorEvent {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  }
}

function getRecognitionCtor(): RecognitionCtor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export const sttSupported = (): boolean => getRecognitionCtor() !== null;
export const ttsSupported = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window;

// Listen once in `lang` (BCP-47, e.g. "hi-IN") and resolve with the transcript.
export function listenOnce(lang: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      reject(new Error('Speech recognition is not supported in this browser.'));
      return;
    }
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (e) => resolve(e.results[0][0].transcript);
    rec.onerror = (e) => reject(new Error(e.error || 'speech error'));
    rec.start();
  });
}

// Read `text` aloud in `lang`. Cancels any in-flight utterance first.
export function speak(text: string, lang: string): void {
  if (!ttsSupported() || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
