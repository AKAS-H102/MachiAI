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

export interface VoiceOption { id: string; label: string; note: string; }
export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'Puck', label: 'Puck', note: 'Default neural voice (Gemini)' },
  { id: 'Charon', label: 'Charon', note: 'Deeper neural voice (Gemini)' },
  { id: 'Prabhat', label: 'Prabhat', note: 'Indian English, male' },
  { id: 'Guy', label: 'Guy', note: 'US English, male' },
  { id: 'Andrew', label: 'Andrew', note: 'US English, male' },
  { id: 'Brian', label: 'Brian', note: 'US English, male' },
  { id: 'Valluvar', label: 'Valluvar', note: 'Tamil, male' },
  { id: 'Pallavi', label: 'Pallavi', note: 'Tamil, female' },
];

// First chunk <= ~140 chars (fast start), later chunks <= ~260 chars. A single long sentence stays whole.
export function chunkSentences(sentences: string[], firstMax: number = 140, restMax: number = 260): string[] {
  const out: string[] = [];
  for (const raw of sentences) {
    const sent = raw.trim();
    if (!sent) continue;
    const last = out[out.length - 1];
    const max = out.length === 1 ? firstMax : restMax; // out.length === 1 means chunk #1 is still being built
    if (last !== undefined && (last + ' ' + sent).length <= max) out[out.length - 1] = last + ' ' + sent;
    else out.push(sent);
  }
  return out;
}

export function getSavedVoice(): string {
  try {
    const v = localStorage.getItem('machi_voice') || '';
    if (VOICE_OPTIONS.some(o => o.id === v)) return v;
  } catch {}
  return 'Puck';
}

export function saveVoice(id: string) {
  try { localStorage.setItem('machi_voice', id); } catch {}
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
  public lastVoiceUsed: string = '';
  public lastWasFallback: boolean = false;

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

    const baseUrl = getBackendBaseUrl();
    const t0 = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(`${baseUrl}/api/machi/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cleanText, voice: voicePreference, rate: 1.0, pitch: 1.0 }),
          signal: controller.signal
        });
        if (!res.ok) {
          console.warn(`[Machi Voice] TTS HTTP ${res.status} from ${baseUrl || '(no backend)'} (attempt ${attempt})`);
          if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // not retryable
          continue;
        }
        const data: TTSResponse & { usedFallback?: boolean } = await res.json();
        if (!data.audioBase64) { console.warn('[Machi Voice] TTS reply had no audio'); continue; }
        const byteChars = atob(data.audioBase64);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
        const mime = data.mimeType || (data.audioBase64.startsWith('UklGR') ? 'audio/wav' : 'audio/mpeg');
        console.log(`[Machi Timing] tts_fetch=${Date.now() - t0}ms`);
        console.log(`[Machi Voice] TTS ok requested=${voicePreference} used=${data.voice} fallback=${!!data.usedFallback} mime=${mime} bytes~${Math.round(data.audioBase64.length * 0.75)}`);
        this.lastVoiceUsed = data.voice;
        this.lastWasFallback = !!data.usedFallback;
        const payload: AudioPayload = { base64: data.audioBase64, mimeType: mime, url: URL.createObjectURL(new Blob([byteArray], { type: mime })) };
        this.audioPayloadCache.set(cacheKey, payload);
        return payload;
      } catch (e) {
        console.warn(`[Machi Voice] TTS fetch problem (attempt ${attempt}):`, String(e));
      } finally {
        clearTimeout(timer);
      }
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

    // Few, larger requests = fewer gaps and fewer chances to fail; short first chunk so speech starts quickly.
    const chunks = chunkSentences(cleanSentences);
    cleanSentences.length = 0;
    cleanSentences.push(...chunks);

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
