// Machi Locked Voice Service
// Locked Voice: Gemini Puck Neural TTS (Primary) with Microsoft Edge en-US-GuyNeural / ta-IN-ValluvarNeural (Secondary)
// Dual Pipeline: Android Native MediaPlayer (in APK) & HTML5 Audio (in Browser)

export interface TTSResponse {
  audioBase64: string;
  mimeType: string;
  voice: string;
}

export interface AudioPayload {
  base64: string;
  mimeType: string;
  url: string;
}

// Backend URL resolution order:
//  1. URL saved by the user in-app (localStorage "machi_backend_url")
//  2. window.__MACHI_BACKEND_URL__ (injected by host page)
//  3. URL baked into the Android APK (MachiAndroid.getBackendUrl(), from res/values/strings.xml)
//  4. VITE_BACKEND_URL set at build time
//  5. same origin (only valid when served by server.ts in a browser)
// Returns '' when running inside the APK/file:// with nothing configured -> callers must show a clear error.
export function getBackendBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  const w = window as any;
  let custom = '';
  try { custom = localStorage.getItem('machi_backend_url') || ''; } catch {}
  if (!custom) custom = w.__MACHI_BACKEND_URL__ || '';
  if (!custom && w.MachiAndroid && typeof w.MachiAndroid.getBackendUrl === 'function') {
    try { custom = w.MachiAndroid.getBackendUrl() || ''; } catch {}
  }
  if (!custom) custom = (import.meta as any).env?.VITE_BACKEND_URL || '';
  if (custom) return custom.trim().replace(/\/+$/, '');
  return isEmbeddedApp() ? '' : window.location.origin;
}

export function isEmbeddedApp(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as any).MachiAndroid ||
    window.location.protocol === 'file:' ||
    !window.location.host ||
    window.location.host === 'machi.ai';
}

export function setBackendBaseUrl(url: string) {
  try { localStorage.setItem('machi_backend_url', url.trim().replace(/\/+$/, '')); } catch {}
}

export class MachiBackendError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

class MachiVoiceManager {
  private currentAudio: HTMLAudioElement | null = null;
  private isSpeaking: boolean = false;
  private onStateChangeCallbacks: Set<(speaking: boolean) => void> = new Set();
  private audioPayloadCache = new Map<string, AudioPayload>();
  private volume: number = 1.0;
  private playSessionId: number = 0;
  private audioUnlocked: boolean = false;
  private lastSpeechEndTs: number = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      const savedVol = localStorage.getItem('machi_voice_volume');
      if (savedVol) {
        const parsed = parseFloat(savedVol);
        if (!isNaN(parsed) && parsed >= 0.2 && parsed <= 2.0) {
          this.volume = parsed;
        }
      }
    }
  }

  // Pre-unlock audio on mobile touch to ensure immediate playback without gesture blocks
  public unlockAudio() {
    if (this.audioUnlocked) return;
    this.audioUnlocked = true;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextClass) {
        const ctx = new AudioContextClass();
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
      }
    } catch {}
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0.1, Math.min(2.0, vol));
    if (typeof window !== 'undefined') {
      localStorage.setItem('machi_voice_volume', this.volume.toString());
    }
    if (this.currentAudio) {
      this.currentAudio.volume = Math.min(1.0, this.volume);
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public subscribe(cb: (speaking: boolean) => void): () => void {
    this.onStateChangeCallbacks.add(cb);
    return () => this.onStateChangeCallbacks.delete(cb);
  }

  public setSpeaking(state: boolean) {
    if (this.isSpeaking && !state) this.lastSpeechEndTs = Date.now();
    this.isSpeaking = state;
    this.onStateChangeCallbacks.forEach(cb => cb(state));
  }

  // ms since Machi last stopped speaking (used to ignore its own echo)
  public msSinceSpeechEnd(): number {
    return this.isSpeaking ? 0 : Date.now() - this.lastSpeechEndTs;
  }

  public getSpeakingState(): boolean {
    return this.isSpeaking;
  }

  public stop() {
    this.playSessionId++;

    // Stop Native Android MediaPlayer if running in APK
    if (typeof window !== 'undefined' && (window as any).MachiAndroid) {
      try {
        (window as any).MachiAndroid.stopSpeaking();
      } catch {}
    }

    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch {}
      this.currentAudio = null;
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }

    this.setSpeaking(false);
  }

  // Fetch or retrieve cached audio payload with base64 data and blob URL
  public async fetchAudioPayload(text: string, voicePreference: string = 'Puck'): Promise<AudioPayload | null> {
    const cleanText = text.trim();
    if (!cleanText) return null;

    const cacheKey = `${voicePreference}:${cleanText}`;
    const cached = this.audioPayloadCache.get(cacheKey);
    if (cached) return cached;

    try {
      const baseUrl = getBackendBaseUrl();
      const t0 = Date.now();
      const res = await fetch(`${baseUrl}/api/machi/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: cleanText,
          voice: voicePreference,
          rate: 1.0,
          pitch: 1.0
        })
      });

      if (!res.ok) {
        console.warn(`[Machi Voice] TTS HTTP ${res.status} from ${baseUrl || '(no backend)'}`);
      }
      if (res.ok) {
        const data: TTSResponse = await res.json();
        if (data.audioBase64) {
          const byteChars = atob(data.audioBase64);
          const byteNumbers = new Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) {
            byteNumbers[i] = byteChars.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          const mime = data.mimeType || (data.audioBase64.startsWith('UklGR') ? 'audio/wav' : 'audio/mpeg');
          console.log(`[Machi Timing] tts_fetch=${Date.now() - t0}ms`);
          console.log(`[Machi Voice] TTS ok voice=${data.voice} mime=${mime} bytes~${Math.round(data.audioBase64.length * 0.75)}`);
          const blob = new Blob([byteArray], { type: mime });
          const url = URL.createObjectURL(blob);

          const payload: AudioPayload = {
            base64: data.audioBase64,
            mimeType: mime,
            url
          };

          this.audioPayloadCache.set(cacheKey, payload);
          return payload;
        }
      }
    } catch (e) {
      console.warn('[Machi Voice] Audio prefetch note:', e);
    }
    return null;
  }

  // Play audio through Android Native MediaPlayer (in APK) or HTMLAudioElement (in browser)
  private playAudio(payload: AudioPayload, sessionId: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.playSessionId !== sessionId) {
        resolve(false);
        return;
      }

      this.unlockAudio();

      // Priority 1: Native Android MediaPlayer Bridge
      const nativeBridge = (window as any).MachiAndroid;
      if (nativeBridge && typeof nativeBridge.speak === 'function') {
        let isDone = false;
        let safety: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (safety) clearTimeout(safety);
          (window as any).onMachiNativeAudioEnded = null;
          (window as any).onMachiNativeAudioStarted = null;
          (window as any).onMachiNativeAudioError = null;
        };
        const done = (success: boolean, why?: string) => {
          if (isDone) return;
          isDone = true;
          cleanup();
          if (!success) console.warn('[Machi Voice] native playback failed:', why);
          resolve(success);
        };

        (window as any).onMachiNativeAudioStarted = () => { this.setSpeaking(true); };
        // Only a real completion callback counts as success
        (window as any).onMachiNativeAudioEnded = () => done(true);
        (window as any).onMachiNativeAudioError = (why: string) => done(false, why);

        // Safety net only: treat as FAILURE (not success) so the fallback engine takes over
        safety = setTimeout(() => done(false, 'native playback timeout'), 60000);

        try {
          nativeBridge.speak(payload.base64, payload.mimeType);
          return;
        } catch (err) {
          done(false, String(err));
        }
        return;
      }

      // Priority 2: Direct HTMLAudioElement for browsers / desktop
      const audio = new Audio();
      this.currentAudio = audio;
      audio.preload = 'auto';
      audio.volume = Math.min(1.0, this.volume);

      audio.onended = () => {
        if (this.currentAudio === audio) {
          this.currentAudio = null;
        }
        resolve(true);
      };

      audio.onerror = (e) => {
        console.warn('[Machi Voice] Audio playback error:', e);
        if (this.currentAudio === audio) {
          this.currentAudio = null;
        }
        resolve(false);
      };

      audio.src = payload.url;
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[Machi Voice] play() promise rejected:', err);
          resolve(false);
        });
      }
    });
  }

  // Pipelined sentence-by-sentence playback: plays sentence 1 immediately while sentence 2 prefetches
  public async speakPipelined(
    sentences: string[],
    voicePreference: string = 'Puck',
    onStart?: () => void,
    onEnd?: () => void
  ): Promise<boolean> {
    if (!sentences || sentences.length === 0) return false;
    const cleanSentences = sentences.map(s => s.trim()).filter(s => s.length > 0);
    if (cleanSentences.length === 0) return false;

    this.stop();
    const sessionId = ++this.playSessionId;
    this.setSpeaking(true);
    onStart?.();

    let anyFailed = false;
    try {
      let nextPayloadPromise: Promise<AudioPayload | null> = this.fetchAudioPayload(cleanSentences[0], voicePreference);

      for (let i = 0; i < cleanSentences.length; i++) {
        if (this.playSessionId !== sessionId) break;

        const currentText = cleanSentences[i];
        const payload = await nextPayloadPromise;

        // Prefetch the next sentence in parallel while the current sentence is spoken
        if (i + 1 < cleanSentences.length) {
          nextPayloadPromise = this.fetchAudioPayload(cleanSentences[i + 1], voicePreference);
        }

        if (this.playSessionId !== sessionId) break;

        if (payload) {
          const played = await this.playAudio(payload, sessionId);
          if (!played && this.playSessionId === sessionId) {
            const ok = await this.fallbackBrowserTTS(currentText, sessionId);
            if (!ok) anyFailed = true;
          }
        } else {
          const ok = await this.fallbackBrowserTTS(currentText, sessionId);
          if (!ok) anyFailed = true;
        }
      }

      if (this.playSessionId === sessionId) {
        this.setSpeaking(false);
        onEnd?.();
      }
      // true only if every sentence was actually played by some engine
      return !anyFailed;
    } catch {
      if (this.playSessionId === sessionId) {
        this.setSpeaking(false);
        onEnd?.();
      }
      return false;
    }
  }

  public async speak(
    text: string, 
    voicePreference: string = 'Puck',
    onStart?: () => void,
    onEnd?: () => void
  ): Promise<boolean> {
    if (!text || !text.trim()) return false;
    const cleanText = text.trim();

    const rawSentences = cleanText.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g);
    const sentences = rawSentences ? rawSentences.map(s => s.trim()).filter(s => s.length > 0) : [cleanText];

    if (sentences.length > 1) {
      return this.speakPipelined(sentences, voicePreference, onStart, onEnd);
    }

    return this.speakPipelined([cleanText], voicePreference, onStart, onEnd);
  }

  private fallbackBrowserTTS(text: string, sessionId?: number): Promise<boolean> {
    return new Promise((resolve) => {
      // Android APK: WebView has no speechSynthesis -> use native Android TextToSpeech
      const nb = typeof window !== 'undefined' ? (window as any).MachiAndroid : null;
      if (nb && typeof nb.speakText === 'function') {
        let finished = false;
        const finish = (ok: boolean, why?: string) => {
          if (finished) return;
          finished = true;
          (window as any).onMachiNativeTtsDone = null;
          (window as any).onMachiNativeTtsError = null;
          if (!ok) console.warn('[Machi Voice] native TTS failed:', why);
          resolve(ok);
        };
        (window as any).onMachiNativeTtsDone = () => finish(true);
        (window as any).onMachiNativeTtsError = (why: string) => finish(false, why);
        setTimeout(() => finish(false, 'native TTS timeout'), 30000);
        try { nb.speakText(text, 'en-IN'); } catch (e) { finish(false, String(e)); }
        return;
      }
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        resolve(false);
        return;
      }
      if (sessionId !== undefined && this.playSessionId !== sessionId) {
        resolve(false);
        return;
      }

      try {
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.0;
        utter.pitch = 1.0;
        utter.volume = Math.min(1.0, this.volume);

        const voices = window.speechSynthesis.getVoices();
        const maleVoice = voices.find(v => 
          (v.name.includes('Guy') || v.name.includes('Male') || v.name.includes('Natural') || v.name.includes('David')) &&
          (v.lang.startsWith('en') || v.lang.startsWith('ta'))
        );
        if (maleVoice) {
          utter.voice = maleVoice;
        }

        utter.onend = () => resolve(true);
        utter.onerror = () => resolve(false);

        window.speechSynthesis.speak(utter);
      } catch {
        resolve(false);
      }
    });
  }
}

export const machiVoice = new MachiVoiceManager();
