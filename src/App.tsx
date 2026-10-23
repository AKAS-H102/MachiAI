import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, 
  MicOff, 
  Volume2, 
  Send, 
  Sparkles, 
  Bell, 
  Clock, 
  CheckCircle, 
  Download, 
  Info,
  ExternalLink,
  Laptop,
  Smartphone,
  RefreshCw,
  Zap,
  Sliders,
  X,
  Copy,
  Check,
  Link,
  Loader2,
  Globe,
  Radio
} from 'lucide-react';
import { machiVoice, getBackendBaseUrl, isEmbeddedApp, setBackendBaseUrl, VOICE_OPTIONS, getSavedVoice, saveVoice, parsePhoneVoices, isPhoneVoice } from './utils/machiVoice.ts';
import type { VoiceOption } from './utils/machiVoice.ts';
import { parseSse } from '../lib/stream-utils.ts';

interface Message {
  id: string;
  sender: 'user' | 'machi';
  text: string;
  timestamp: string;
  intent?: string;
  sources?: { title: string; url: string }[];
  latencyMs?: number;
  modelUsed?: string;
  isError?: boolean;
  retryText?: string;
}

interface Reminder {
  id: string;
  title: string;
  time: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      sender: 'machi',
      text: "Vanakkam da machi! Machi Voice Assistant is live. Hands-free continuous conversation mode ready-ah irukku. Enna venum nu sollu da!",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [speechLanguage, setSpeechLanguage] = useState<'en-IN' | 'ta-IN' | 'en-US'>('en-IN');
  const [isHandsFree, setIsHandsFree] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [volumePercent, setVolumePercent] = useState<number>(125);
  const [selectedVoice, setSelectedVoice] = useState<string>(getSavedVoice());
  const selectedVoiceRef = useRef<string>(selectedVoice);
  const [phoneVoices, setPhoneVoices] = useState<VoiceOption[]>([]);
  const [micRoute, setMicRoute] = useState<string>('');
  const [firstSentenceShown, setFirstSentenceShown] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'installers' | 'reminders'>('chat');
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [backendDraft, setBackendDraft] = useState<string>('');
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);

  const [reminders, setReminders] = useState<Reminder[]>([
    { id: '1', title: 'Check project deployment', time: 'Today at 6:00 PM' }
  ]);

  const [status, setStatus] = useState({
    online: true,
    voiceProfile: 'Locked Natural Male (Puck/Guy)'
  });

  const sttReadyTsRef = useRef<number>(Date.now());
  const isLoadingRef = useRef<boolean>(false);
  selectedVoiceRef.current = selectedVoice; // callbacks registered once (native mic, hands-free) must always see the CURRENT voice
  const handleSendRef = useRef<(t?: string, retry?: boolean) => void>(() => {});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const isHandsFreeRef = useRef<boolean>(true);
  const lastProcessedTranscriptRef = useRef<string>('');
  const lastProcessedTimeRef = useRef<number>(0);
  const lastAlternativesRef = useRef<string[]>([]);

  useEffect(() => {
    isHandsFreeRef.current = isHandsFree;
  }, [isHandsFree]);

  useEffect(() => {
    const unsubscribe = machiVoice.subscribe((speaking) => {
      setIsSpeaking(speaking);
      // Automatically pause microphone while Machi speaks to prevent audio loop / self-listening
      if (speaking) {
        stopListeningAction(false);
      }
    });

    const baseUrl = getBackendBaseUrl();
    fetch(`${baseUrl}/api/machi/status`)
      .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(data => {
        setBackendOnline(true);
        setStatus({
          online: data.status === 'online',
          voiceProfile: data.voiceProfile || 'Locked Natural Male (Puck/Guy)'
        });
      })
      .catch((e) => { console.warn('[Machi] status check failed:', String(e)); setBackendOnline(false); });

    // Set up Android Native Bridge Callbacks
    setupNativeAndroidCallbacks();

    // Set up Web Speech Recognition fallback for desktop browser
    initWebSpeechRecognition(speechLanguage);

    // Keep the free-tier backend awake while the app is open (it sleeps after ~15 min idle -> 50s first reply)
    const keepWarm = setInterval(() => {
      fetch(`${getBackendBaseUrl()}/api/machi/status`).catch(() => {});
    }, 4 * 60 * 1000);

    return () => {
      clearInterval(keepWarm);
      unsubscribe();
      machiVoice.stop();
      stopListeningAction(true);
    };
  }, []);

  const askToRepeat = () => {
    const msg = "Sorry machi, I didn't catch that clearly. Could you say it again?";
    setMessages(prev => [...prev, {
      id: Date.now().toString(), sender: 'machi', text: msg,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }]);
    machiVoice.speak(msg, selectedVoiceRef.current, undefined, () => {
      if (isHandsFreeRef.current) setTimeout(() => startListeningAction(), 500);
    });
  };

  const setupNativeAndroidCallbacks = () => {
    if (typeof window === 'undefined') return;

    (window as any).onMachiNativeVoices = (json: string) => setPhoneVoices(parsePhoneVoices(json));
    (window as any).onMachiNativeRoute = (label: string) => setMicRoute(label || '');
    machiVoice.onVoiceStatus = (msg) => setVoiceError(msg);
    try { (window as any).MachiAndroid?.requestVoices?.(); } catch {}

    (window as any).onMachiNativeSpeechStart = () => {
      setIsListening(true);
    };

    (window as any).onMachiNativeInterimTranscript = (text: string) => {
      if (text && !machiVoice.getSpeakingState()) {
        setInterimTranscript(text);
      }
    };

    (window as any).onMachiNativeReadyForSpeech = () => {
      sttReadyTsRef.current = Date.now();
      setIsListening(true);
      setInterimTranscript('');
    };

    (window as any).onMachiNativeFinalTranscript = (text: string, confidence?: number, alts?: string[]) => {
      setInterimTranscript('');
      // Ignore anything captured while Machi talks or right after (its own echo)
      if (machiVoice.getSpeakingState() || machiVoice.msSinceSpeechEnd() < 800) return;
      if (isLoadingRef.current) return;

      const clean = text ? text.trim() : '';
      const now = Date.now();
      console.log(`[Machi Timing] stt=${now - sttReadyTsRef.current}ms conf=${confidence}`);

      // Soft or unclear speech gets LOW recognizer confidence even when the words are right, so only ask to repeat
      // when the result is essentially empty/garbage. Everything else is sent, together with the recognizer's
      // other candidate transcripts so the AI can work out what was meant.
      if (clean.length < 2 || (typeof confidence === 'number' && confidence >= 0 && confidence < 0.1)) {
        askToRepeat();
        return;
      }
      lastAlternativesRef.current = Array.isArray(alts) ? alts.filter(a => typeof a === 'string' && a.trim() && a.trim() !== clean).slice(0, 3) : [];

      // Guard against duplicate / stale submissions
      if (clean !== lastProcessedTranscriptRef.current || now - lastProcessedTimeRef.current > 3000) {
        lastProcessedTranscriptRef.current = clean;
        lastProcessedTimeRef.current = now;
        handleSendRef.current(clean);
      }
    };

    (window as any).onMachiNativeSpeechError = (errCode: string) => {
      console.warn('[Native Speech Recognition]:', errCode);
      const fatal: Record<string, string> = {
        no_permission: 'Microphone permission is denied. Allow it in Android Settings > Apps > Machi > Permissions.',
        init_failed: 'Speech recognition could not start on this phone.',
        unavailable: 'No speech recognition service found. Install/enable the Google app (Speech Services).',
        busy: 'Speech recognizer is busy. Tap the mic again.',
      };
      if (fatal[errCode]) {
        setIsListening(false);
        setIsHandsFree(false);
        setVoiceError(fatal[errCode]);
        return;
      }
      // Benign (no_match / timeout / network blips): resume only in hands-free mode
      if (isHandsFreeRef.current && !machiVoice.getSpeakingState()) {
        setTimeout(() => {
          if (isHandsFreeRef.current && !machiVoice.getSpeakingState()) {
            startListeningAction();
          }
        }, 600);
      } else {
        setIsListening(false);
      }
    };

    (window as any).onMachiNativeSpeechEnd = () => {
      // User paused or completed speech
    };
  };

  const initWebSpeechRecognition = (lang: string) => {
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }

    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognitionClass) {
      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = lang;
      recognition.maxAlternatives = 3;

      recognition.onstart = () => {
        setIsListening(true);
        setInterimTranscript('');
      };

      recognition.onend = () => {
        if (isHandsFreeRef.current && !machiVoice.getSpeakingState() && !isLoading) {
          try {
            recognition.start();
            return;
          } catch {}
        }
        setIsListening(false);
        setInterimTranscript('');
      };

      recognition.onresult = (event: any) => {
        if (machiVoice.getSpeakingState()) return;

        let finalTrans = '';
        let interimTrans = '';

        const webAlts: string[] = [];
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTrans += event.results[i][0].transcript;
            for (let k = 1; k < event.results[i].length; k++) webAlts.push(String(event.results[i][k].transcript || '').trim());
          } else {
            interimTrans += event.results[i][0].transcript;
          }
        }

        if (interimTrans) {
          setInterimTranscript(interimTrans);
        }

        if (finalTrans.trim()) {
          setInterimTranscript('');
          const clean = finalTrans.trim();
          const now = Date.now();
          if (
            clean.length >= 2 &&
            (clean !== lastProcessedTranscriptRef.current || now - lastProcessedTimeRef.current > 3000)
          ) {
            lastProcessedTranscriptRef.current = clean;
            lastProcessedTimeRef.current = now;
            lastAlternativesRef.current = webAlts.filter(a => a && a !== clean).slice(0, 3);
            handleSendRef.current(clean);
          }
        }
      };

      recognition.onerror = (e: any) => {
        console.warn('[Web Speech Recognition Note]:', e?.error);
        if (e?.error === 'not-allowed') {
          setIsListening(false);
          setIsHandsFree(false);
        }
      };

      recognitionRef.current = recognition;
    }
  };

  const handleLanguageChange = (newLang: 'en-IN' | 'ta-IN' | 'en-US') => {
    setSpeechLanguage(newLang);
    initWebSpeechRecognition(newLang);
    if (isListening) {
      stopListeningAction(false);
      setTimeout(() => startListeningAction(), 200);
    }
  };

  const startListeningAction = () => {
    machiVoice.unlockAudio();
    setIsListening(true);
    setInterimTranscript('');

    // Check for Native Android Speech Recognizer Bridge
    const nativeBridge = (window as any).MachiAndroid;
    if (nativeBridge && typeof nativeBridge.startListening === 'function') {
      try {
        nativeBridge.startListening(speechLanguage);
        return;
      } catch (err) {
        console.warn('[Native startListening failed, falling back to WebSpeech]:', err);
      }
    }

    // Web Speech API fallback
    try {
      recognitionRef.current?.start();
    } catch {}
  };

  const stopListeningAction = (resetHandsFree: boolean = false) => {
    setIsListening(false);
    setInterimTranscript('');
    if (resetHandsFree) {
      setIsHandsFree(false);
    }

    const nativeBridge = (window as any).MachiAndroid;
    if (nativeBridge && typeof nativeBridge.stopListening === 'function') {
      try { nativeBridge.stopListening(); } catch {}
    }
    if (resetHandsFree && nativeBridge && typeof nativeBridge.releaseAudioRoute === 'function') {
      try { nativeBridge.releaseAudioRoute(); } catch {}
    }

    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
    }
  };

  const toggleListening = () => {
    machiVoice.unlockAudio();

    if (isListening) {
      stopListeningAction(true);
    } else {
      machiVoice.stop();
      setIsHandsFree(true);
      startListeningAction();
    }
  };

  const toggleHandsFree = () => {
    machiVoice.unlockAudio();
    const nextVal = !isHandsFree;
    setIsHandsFree(nextVal);
    if (nextVal && !isListening && !machiVoice.getSpeakingState()) {
      startListeningAction();
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, interimTranscript]);

  const handleVolumeChange = (newPercent: number) => {
    setVolumePercent(newPercent);
    machiVoice.setVolume(newPercent / 100);
  };

  const handleSendMessage = async (textToSend?: string, isRetry: boolean = false) => {
    machiVoice.unlockAudio();
    const text = (textToSend || inputText).trim();
    if (!text || isLoading || isLoadingRef.current) return;

    // Discard single random letters or noises
    if (text.length < 2) return;

    stopListeningAction(false);

    const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (isRetry) {
      // drop the previous error bubble for this text
      setMessages(prev => prev.filter(m => !(m.isError && m.retryText === text)));
    } else {
      const userMsg: Message = { id: Date.now().toString(), sender: 'user', text, timestamp: stamp() };
      setMessages(prev => [...prev, userMsg]);
      if (!textToSend) setInputText('');
    }
    isLoadingRef.current = true; // synchronous guard: blocks a second request before React re-renders
    setFirstSentenceShown(false);
    setIsLoading(true);

    const showError = (detail: string) => {
      console.warn('[Machi] chat failed:', detail);
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        sender: 'machi',
        text: detail,
        timestamp: stamp(),
        isError: true,
        retryText: text
      }]);
    };

    try {
      const baseUrl = getBackendBaseUrl();
      if (!baseUrl && isEmbeddedApp()) {
        showError('Backend server is not configured. Set the Machi server URL (Settings) and try again.');
        return;
      }

      const history = messages.filter(m => !m.isError).slice(-8).map(m => ({
        user: m.sender === 'user' ? m.text : undefined,
        machi: m.sender === 'machi' ? m.text : undefined,
      }));

      const reqStart = Date.now();
      const alternatives = lastAlternativesRef.current;
      lastAlternativesRef.current = [];
      const body = JSON.stringify({ message: text, conversationHistory: history, alternatives, languagePreference: speechLanguage });

      // ---------- Real-time path: stream the reply and start SPEAKING after the first sentence ----------
      const finishHandsFree = () => {
        if (isHandsFreeRef.current) {
          setTimeout(() => {
            if (isHandsFreeRef.current && !machiVoice.getSpeakingState()) startListeningAction();
          }, 400);
        }
      };
      const runStream = async (): Promise<'done' | 'fallback'> => {
        const controller = new AbortController();
        // first sentence may need a cold start (free server) -> 45s; once flowing, 20s of silence = stalled
        let timer = setTimeout(() => controller.abort(), 45000);
        let speech: ReturnType<typeof machiVoice.beginStream> | null = null;
        const msgId = (Date.now() + 1).toString();
        let sawSentence = false;
        let doneEvt: any = null;
        let errorText: string | null = null;
        try {
          console.log(`[Machi] POST ${baseUrl}/api/machi/chat/stream`);
          const res = await fetch(`${baseUrl}/api/machi/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal
          });
          if (!res.ok || !res.body) { console.warn(`[Machi] stream HTTP ${res.status} -> using standard endpoint`); return 'fallback'; }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(), 20000);
            buf += decoder.decode(value, { stream: true });
            const parsed = parseSse(buf);
            buf = parsed.rest;
            for (const ev of parsed.events) {
              if (ev.type === 'sentence' && typeof ev.text === 'string' && ev.text.trim()) {
                if (!sawSentence) {
                  sawSentence = true;
                  console.log(`[Machi Timing] first_sentence=${Date.now() - reqStart}ms`);
                  setFirstSentenceShown(true);
                  setMessages(prev => [...prev, { id: msgId, sender: 'machi', text: ev.text, timestamp: stamp() }]);
                  speech = machiVoice.beginStream(selectedVoiceRef.current, undefined, finishHandsFree);
                } else {
                  setMessages(prev => prev.map(m => m.id === msgId ? { ...m, text: m.text + ' ' + ev.text } : m));
                }
                speech!.push(ev.text);
              } else if (ev.type === 'done') {
                doneEvt = ev;
              } else if (ev.type === 'error') {
                errorText = String(ev.error || 'The AI service did not answer.');
              }
            }
          }
        } catch (e: any) {
          console.warn('[Machi] stream problem:', String(e));
          if (!sawSentence) return 'fallback';
        } finally {
          clearTimeout(timer);
        }

        if (!sawSentence) {
          if (errorText) { showError(`${errorText} Tap Retry.`); return 'done'; }
          return 'fallback';
        }
        console.log(`[Machi Timing] stream_total=${Date.now() - reqStart}ms server_latency=${doneEvt?.latencyMs}ms model=${doneEvt?.modelUsed}`);
        setMessages(prev => prev.map(m => m.id === msgId
          ? { ...m, intent: doneEvt?.intent, sources: doneEvt?.sources, latencyMs: doneEvt?.latencyMs, modelUsed: doneEvt?.modelUsed }
          : m));
        if (doneEvt?.intent === 'create_reminder' && doneEvt.actionData?.reminderTitle) {
          setReminders(prev => [...prev, {
            id: Date.now().toString(),
            title: doneEvt.actionData.reminderTitle,
            time: doneEvt.actionData.reminderTime || 'Later today'
          }]);
        }
        speech!.end().then(ok => {
          if (!ok) setVoiceError('Voice playback failed - the reply is shown as text. Use "Replay voice" to retry.');
        });
        return 'done';
      };
      const streamed = await runStream();
      if (streamed === 'done') return;

      // Streaming unavailable -> standard request (same real AI, whole reply at once).
      // The free Render server sleeps when idle and can need ~50s to wake up, so allow 45s, and retry once on a
      // network error / 502 / 503 / timeout instead of immediately showing an error.
      let response: Response | null = null;
      let lastNetErr: any = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45000);
        try {
          console.log(`[Machi] POST ${baseUrl}/api/machi/chat (attempt ${attempt})`);
          response = await fetch(`${baseUrl}/api/machi/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal
          });
          lastNetErr = null;
          if ((response.status === 502 || response.status === 503) && attempt === 1) {
            console.warn(`[Machi] chat HTTP ${response.status}, retrying once`);
            continue;
          }
          break;
        } catch (e: any) {
          lastNetErr = e;
          response = null;
          if (attempt === 2) throw e;
        } finally {
          clearTimeout(timer);
        }
      }
      if (!response) throw lastNetErr || new Error('no response');

      if (!response.ok) {
        let serverMsg = '';
        try { serverMsg = (await response.json())?.error || ''; } catch {}
        console.warn(`[Machi] chat HTTP ${response.status}`);
        showError(`Machi server error (${response.status}). ${serverMsg || 'The AI service did not answer.'} Tap Retry.`);
        return;
      }

      const data = await response.json();
      console.log(`[Machi Timing] chat_roundtrip=${Date.now() - reqStart}ms server_latency=${data?.latencyMs}ms`);
      if (!data || typeof data.reply !== 'string' || !data.reply.trim()) {
        showError('The AI service returned an empty answer. Tap Retry.');
        return;
      }
      const machiReply = data.reply;

      const machiMsg: Message = {
        id: (Date.now() + 1).toString(),
        sender: 'machi',
        text: machiReply,
        timestamp: stamp(),
        intent: data.intent,
        sources: data.sources,
        latencyMs: data.latencyMs,
        modelUsed: data.modelUsed
      };
      setMessages(prev => [...prev, machiMsg]);

      if (data.intent === 'create_reminder' && data.actionData?.reminderTitle) {
        setReminders(prev => [
          ...prev,
          {
            id: Date.now().toString(),
            title: data.actionData.reminderTitle,
            time: data.actionData.reminderTime || 'Later today'
          }
        ]);
      }

      // Hands-free auto-resume once playback is finished
      const onPlaybackFinished = () => {
        if (isHandsFreeRef.current) {
          setTimeout(() => {
            if (isHandsFreeRef.current && !machiVoice.getSpeakingState()) {
              startListeningAction();
            }
          }, 800);
        }
      };

      const spoken = (data.sentences && Array.isArray(data.sentences) && data.sentences.length > 0)
        ? machiVoice.speakPipelined(data.sentences, selectedVoiceRef.current, undefined, onPlaybackFinished)
        : machiVoice.speak(machiReply, selectedVoiceRef.current, undefined, onPlaybackFinished);
      spoken.then(ok => {
        if (!ok) setVoiceError('Voice playback failed - the reply is shown as text. Use "Replay voice" to retry.');
      });
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      showError(aborted
        ? 'The server took too long to answer. Tap Retry.'
        : 'Cannot reach the Machi server. Check your internet / server URL and tap Retry.');
    } finally {
      isLoadingRef.current = false;
      setIsLoading(false);
    }
  };

  isLoadingRef.current = isLoading;
  handleSendRef.current = (t, r) => { handleSendMessage(t, r); };

  const handleVoiceChange = (id: string) => {
    setSelectedVoice(id);
    saveVoice(id);
    setVoiceError(null);
    machiVoice.unlockAudio();
    machiVoice.stop();
    // Preview the newly chosen voice so the change is audible immediately
    machiVoice.speak("Hey machi, idhu dhaan en new voice da.", id)
      .then(ok => { if (!ok) setVoiceError('Could not play the sample for this voice. Check the server connection and phone volume.'); });
  };

  const voicePicker = (compact: boolean) => (
    <div className={compact ? 'flex items-center gap-1.5 pt-0.5' : 'space-y-1.5 bg-slate-950/80 p-3 rounded-xl border border-slate-800'}>
      <span className={compact ? 'text-[10px] text-slate-500 font-mono' : 'text-xs font-semibold text-slate-300 flex items-center gap-1.5'}>
        {compact ? 'Voice:' : <><Volume2 className="w-3.5 h-3.5 text-cyan-400" /> Machi's Voice:</>}
      </span>
      <select
        aria-label="Machi's voice"
        value={selectedVoice}
        onChange={(e) => handleVoiceChange(e.target.value)}
        className={compact
          ? 'text-[11px] font-mono px-2 py-0.5 rounded bg-slate-900 text-cyan-300 border border-cyan-800/60 max-w-[200px]'
          : 'w-full py-2 px-2.5 rounded-lg text-xs bg-slate-900 text-cyan-300 border border-cyan-800/60'}
      >
        <optgroup label="Machi voices (server)">
          {VOICE_OPTIONS.map(v => <option key={v.id} value={v.id}>{v.label} - {v.note}</option>)}
        </optgroup>
        {phoneVoices.length > 0 && (
          <optgroup label="Phone voices (work offline)">
            {phoneVoices.map(v => <option key={v.id} value={v.id}>{v.label} - {v.note}</option>)}
          </optgroup>
        )}
        {isPhoneVoice(selectedVoice) && !phoneVoices.some(v => v.id === selectedVoice) && (
          <option value={selectedVoice}>Saved phone voice</option>
        )}
      </select>
      {!compact && (
        <p className="text-[10px] text-slate-500 leading-snug">If the chosen neural voice is busy, Machi briefly uses a backup voice so you never get silence.</p>
      )}
    </div>
  );

  const handleTestVoice = () => {
    machiVoice.unlockAudio();
    setVoiceError(null);
    machiVoice.speak(
      "Hey machi, voice is fully locked, loud, and crystal clear! Ready for Windows and Android installation da.",
      selectedVoice
    ).then(ok => { if (!ok) setVoiceError('Voice playback failed. Check the server connection and phone volume.'); });
  };

  const handleCopyLink = async (fileName: string) => {
    const origin = window.location.origin;
    const url = `${origin}/release/${fileName}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(fileName);
      setTimeout(() => setCopiedLink(null), 2500);
    } catch {
      window.prompt("Copy direct download link:", url);
    }
  };

  const handleDownload = async (fileName: string, minSizeBytes: number) => {
    setDownloadingFile(fileName);
    try {
      const res = await fetch(`/release/${fileName}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();

      if (blob.size < minSizeBytes) {
        throw new Error(`Corrupted file: only ${blob.size} bytes`);
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      window.location.href = `/release/${fileName}`;
    } finally {
      setDownloadingFile(null);
    }
  };

  return (
    <div 
      onClick={() => machiVoice.unlockAudio()}
      className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 flex-col md:flex-row"
    >
      {/* DESKTOP SIDEBAR (Hidden on Mobile) */}
      <aside className="hidden md:flex w-80 border-r border-cyan-900/30 bg-slate-900/40 backdrop-blur-xl flex-col justify-between p-4 shrink-0">
        <div>
          {/* Logo & Assistant Identity */}
          <div className="flex items-center justify-between mb-6 pb-4 border-b border-cyan-900/30">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 via-sky-500 to-indigo-500 p-[2px] shadow-lg shadow-cyan-500/20">
                <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-cyan-400" />
                </div>
              </div>
              <div>
                <h1 className="text-base font-extrabold tracking-wider bg-gradient-to-r from-cyan-400 via-sky-300 to-indigo-300 bg-clip-text text-transparent flex items-center gap-1.5">
                  MACHI
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-700/50">
                    JARVIS CORE
                  </span>
                </h1>
                <p className="text-[11px] text-slate-400">Personal AI Companion</p>
              </div>
            </div>
            <div className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
              status.online 
                ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40' 
                : 'bg-rose-950/60 text-rose-400 border-rose-800/40'
            }`}>
              {status.online ? 'ONLINE' : 'OFFLINE'}
            </div>
          </div>

          {/* Master Voice Settings Card */}
          <div className="mb-4 p-3.5 rounded-2xl bg-slate-900/80 border border-cyan-500/30 shadow-lg shadow-cyan-950/40 relative overflow-hidden">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-bold text-white tracking-wide">Machi Voice</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-700/60">
                {selectedVoice.toUpperCase()}
              </span>
            </div>
            <div className="mb-3">{voicePicker(false)}</div>

            {/* Volume Slider */}
            <div className="space-y-1.5 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80 mb-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-300 flex items-center gap-1">
                  <Volume2 className="w-3.5 h-3.5 text-cyan-400" /> Voice Volume:
                </span>
                <span className="font-mono font-bold text-cyan-400">{volumePercent}%</span>
              </div>
              <input
                type="range"
                min="50"
                max="160"
                step="5"
                value={volumePercent}
                onChange={(e) => handleVolumeChange(parseInt(e.target.value, 10))}
                className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-slate-500 font-mono">
                <span>Normal (100%)</span>
                <span>Enhanced (125%)</span>
                <span>Max (160%)</span>
              </div>
            </div>

            <button
              onClick={handleTestVoice}
              className="w-full py-2 px-3 rounded-xl bg-cyan-950 hover:bg-cyan-900/70 border border-cyan-700/50 text-cyan-300 text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer"
            >
              <Volume2 className="w-3.5 h-3.5" /> Test Voice & Loudness
            </button>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1.5">
            <button
              onClick={() => setActiveTab('chat')}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all ${
                activeTab === 'chat'
                  ? 'bg-gradient-to-r from-cyan-500/20 to-sky-500/10 text-cyan-300 border border-cyan-500/30 shadow-md shadow-cyan-500/10'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Zap className="w-4 h-4 text-cyan-400" />
              <span>Live Voice Assistant</span>
            </button>

            <button
              onClick={() => setActiveTab('installers')}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all ${
                activeTab === 'installers'
                  ? 'bg-gradient-to-r from-cyan-500/20 to-sky-500/10 text-cyan-300 border border-cyan-500/30 shadow-md shadow-cyan-500/10'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <div className="flex items-center gap-3">
                <Download className="w-4 h-4 text-cyan-400" />
                <span>Installers & Builds</span>
              </div>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                PC & APK
              </span>
            </button>

            <button
              onClick={() => setActiveTab('reminders')}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all ${
                activeTab === 'reminders'
                  ? 'bg-gradient-to-r from-cyan-500/20 to-sky-500/10 text-cyan-300 border border-cyan-500/30 shadow-md shadow-cyan-500/10'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <div className="flex items-center gap-3">
                <Clock className="w-4 h-4 text-cyan-400" />
                <span>Smart Reminders</span>
              </div>
              {reminders.length > 0 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 font-mono">
                  {reminders.length}
                </span>
              )}
            </button>
          </nav>
        </div>

        {/* Desktop Audio Engine Footer */}
        <div className="pt-4 border-t border-cyan-900/30 text-[11px] text-slate-400 space-y-1.5">
          <div className="flex justify-between">
            <span>Speech Engine:</span>
            <span className="text-slate-300 font-mono">Gemini / Edge Neural</span>
          </div>
          <div className="flex justify-between">
            <span>Audio Pipeline:</span>
            <span className="text-cyan-400 font-mono">Native Android MediaPlayer</span>
          </div>
          <div className="flex justify-between">
            <span>Status:</span>
            <span className={isSpeaking ? "text-cyan-400 font-mono font-semibold" : isListening ? "text-amber-400 font-mono font-semibold" : "text-slate-400 font-mono"}>
              {isSpeaking ? "Speaking aloud..." : isListening ? "Listening..." : "Standby"}
            </span>
          </div>
        </div>
      </aside>

      {/* MOBILE HEADER (Visible only on mobile phones) */}
      <header className="md:hidden border-b border-cyan-900/40 bg-slate-900/90 backdrop-blur-md px-3 py-2 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-600 to-indigo-600 p-[1.5px]">
            <div className="w-full h-full bg-slate-950 rounded-[7px] flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-cyan-400" />
            </div>
          </div>
          <div>
            <h1 className="text-sm font-extrabold tracking-wider bg-gradient-to-r from-cyan-400 to-indigo-300 bg-clip-text text-transparent">
              MACHI
            </h1>
            <span className="text-[9px] text-slate-400 font-mono">JARVIS ASSISTANT</span>
          </div>
        </div>

        {/* Master ON/OFF Header Button for Mobile */}
        <div className="flex items-center gap-2">
          <button
            onClick={toggleListening}
            className={`px-3 py-1.5 rounded-xl font-bold text-xs flex items-center gap-1.5 shadow-md transition-all ${
              isListening
                ? 'bg-rose-500 text-white animate-pulse ring-2 ring-rose-400 shadow-rose-500/40'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30'
            }`}
          >
            {isListening ? (
              <>
                <Mic className="w-3.5 h-3.5 animate-bounce" />
                <span>LISTENING (ON)</span>
              </>
            ) : (
              <>
                <MicOff className="w-3.5 h-3.5" />
                <span>STANDBY (OFF)</span>
              </>
            )}
          </button>

          <button
            onClick={() => setMobileSettingsOpen(true)}
            className="p-2 rounded-xl bg-slate-800 text-cyan-300 border border-slate-700"
            title="Audio & Voice Settings"
          >
            <Sliders className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* MOBILE SETTINGS MODAL / DRAWER */}
      {mobileSettingsOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex flex-col justify-end">
          <div className="bg-slate-900 border-t border-cyan-500/40 rounded-t-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-cyan-900/40">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-cyan-400" /> Voice & Assistant Settings
              </h2>
              <button 
                onClick={() => setMobileSettingsOpen(false)}
                className="p-1 rounded-lg bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Hands-free mode toggle in modal */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950/80 border border-slate-800">
              <div>
                <p className="text-xs font-bold text-white">Hands-Free Continuous Mode</p>
                <p className="text-[10px] text-slate-400 mt-0.5">Listens automatically after speaking</p>
              </div>
              <button
                onClick={toggleHandsFree}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  isHandsFree
                    ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {isHandsFree ? 'ENABLED' : 'DISABLED'}
              </button>
            </div>

            {/* Volume Control */}
            <div className="space-y-2 bg-slate-950/80 p-3 rounded-xl border border-slate-800">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-300 flex items-center gap-1.5 font-semibold">
                  <Volume2 className="w-4 h-4 text-cyan-400" /> Voice Output Volume:
                </span>
                <span className="font-mono font-bold text-cyan-400">{volumePercent}%</span>
              </div>
              <input
                type="range"
                min="50"
                max="160"
                step="5"
                value={volumePercent}
                onChange={(e) => handleVolumeChange(parseInt(e.target.value, 10))}
                className="w-full accent-cyan-400 h-2 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>

            {/* Voice Selector */}
            {voicePicker(false)}

            {/* Language Selector */}
            <div className="space-y-1.5 bg-slate-950/80 p-3 rounded-xl border border-slate-800">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-cyan-400" /> Speech Recognition Language:
              </label>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  onClick={() => handleLanguageChange('en-IN')}
                  className={`py-2 px-2.5 rounded-lg text-xs font-medium border text-center transition-all ${
                    speechLanguage === 'en-IN'
                      ? 'bg-cyan-950 text-cyan-300 border-cyan-500 font-bold'
                      : 'bg-slate-900 text-slate-400 border-slate-800'
                  }`}
                >
                  Tanglish / English (IN)
                </button>
                <button
                  onClick={() => handleLanguageChange('ta-IN')}
                  className={`py-2 px-2.5 rounded-lg text-xs font-medium border text-center transition-all ${
                    speechLanguage === 'ta-IN'
                      ? 'bg-cyan-950 text-cyan-300 border-cyan-500 font-bold'
                      : 'bg-slate-900 text-slate-400 border-slate-800'
                  }`}
                >
                  தமிழ் (Tamil)
                </button>
              </div>
            </div>

            {/* Test Voice Button */}
            <button
              onClick={handleTestVoice}
              className="w-full py-2.5 px-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-cyan-600/30"
            >
              <Volume2 className="w-4 h-4" /> Test Voice Playback Now
            </button>

            {/* Tab navigation within drawer */}
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800">
              <button
                onClick={() => { setActiveTab('installers'); setMobileSettingsOpen(false); }}
                className="py-2 px-3 rounded-xl bg-slate-800 text-cyan-300 text-xs font-medium flex items-center justify-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" /> Downloads & Builds
              </button>
              <button
                onClick={() => { setActiveTab('reminders'); setMobileSettingsOpen(false); }}
                className="py-2 px-3 rounded-xl bg-slate-800 text-cyan-300 text-xs font-medium flex items-center justify-center gap-1.5"
              >
                <Clock className="w-3.5 h-3.5" /> Reminders ({reminders.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MAIN VIEW AREA */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {/* Desktop Tab Switcher Header */}
        <header className="hidden md:flex h-14 border-b border-cyan-900/30 bg-slate-900/20 backdrop-blur-md px-6 items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-300">
              {activeTab === 'chat' && 'Interactive Holographic Console'}
              {activeTab === 'installers' && 'Independent Production Deployments'}
              {activeTab === 'reminders' && 'Automated Voice Reminders & Alerts'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {/* Hands-Free Toggle for Desktop */}
            <button
              onClick={toggleHandsFree}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                isHandsFree 
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-sm' 
                  : 'bg-slate-800/80 text-slate-400 border-slate-700'
              }`}
            >
              <Radio className={`w-3.5 h-3.5 ${isHandsFree ? 'text-cyan-400 animate-pulse' : 'text-slate-500'}`} />
              <span>Hands-Free Mode: {isHandsFree ? 'ON' : 'OFF'}</span>
            </button>

            <button
              onClick={() => setActiveTab('installers')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gradient-to-r from-sky-500/20 to-cyan-500/20 hover:from-sky-500/30 hover:to-cyan-500/30 text-cyan-300 border border-cyan-500/30 text-xs font-semibold shadow-sm transition-all"
            >
              <Download className="w-3.5 h-3.5" /> Download Windows Setup & Android APK
            </button>
          </div>
        </header>

        {/* TAB 1: Live Voice Assistant Console */}
        {activeTab === 'chat' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Visualizer Orb & Dedicated Voice Control Header */}
            <div className="py-3 md:py-6 flex flex-col items-center justify-center shrink-0 border-b border-cyan-900/20 bg-gradient-to-b from-slate-900/40 to-transparent">
              {/* Central Glowing JARVIS Orb */}
              <div 
                onClick={toggleListening}
                className="relative w-24 h-24 md:w-36 md:h-36 flex items-center justify-center cursor-pointer group select-none"
              >
                <div className="absolute inset-0 rounded-full border border-dashed border-cyan-400/40 animate-arc-rotate"></div>
                <div className="absolute inset-2 rounded-full border border-cyan-500/30 animate-arc-rotate-reverse"></div>
                <div className={`w-14 h-14 md:w-20 md:h-20 rounded-full flex items-center justify-center transition-all duration-500 ${
                  isSpeaking
                    ? 'bg-gradient-to-tr from-cyan-400 via-sky-300 to-blue-500 shadow-[0_0_50px_15px_rgba(6,182,212,0.6)] scale-110'
                    : isListening
                    ? 'bg-gradient-to-tr from-amber-400 via-rose-500 to-pink-500 shadow-[0_0_40px_10px_rgba(244,63,94,0.5)] scale-105'
                    : 'bg-gradient-to-tr from-cyan-600 via-sky-500 to-indigo-600 shadow-[0_0_30px_6px_rgba(6,182,212,0.35)] hover:scale-105'
                }`}>
                  {isSpeaking ? (
                    <Volume2 className="w-6 h-6 md:w-8 md:h-8 text-slate-950 animate-bounce" />
                  ) : isListening ? (
                    <Mic className="w-6 h-6 md:w-8 md:h-8 text-white animate-pulse" />
                  ) : (
                    <Sparkles className="w-6 h-6 md:w-8 md:h-8 text-slate-950 group-hover:rotate-12 transition-transform" />
                  )}
                </div>
              </div>

              {/* Status and Action Buttons */}
              <div className="mt-2 flex flex-col items-center gap-1.5 px-4 text-center">
                {/* Dedicated Listening ON/OFF Master Button */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleListening}
                    className={`px-4 py-1.5 rounded-full text-xs font-bold flex items-center gap-2 shadow-md transition-all cursor-pointer ${
                      isListening
                        ? 'bg-rose-500/90 hover:bg-rose-600 text-white ring-2 ring-rose-400 shadow-rose-500/30'
                        : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-600/30'
                    }`}
                  >
                    {isListening ? (
                      <>
                        <Mic className="w-3.5 h-3.5 animate-pulse" />
                        <span>MIC: ON (Tap to Pause)</span>
                      </>
                    ) : (
                      <>
                        <MicOff className="w-3.5 h-3.5" />
                        <span>MIC: OFF (Tap to Talk)</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={toggleHandsFree}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border flex items-center gap-1.5 transition-all ${
                      isHandsFree
                        ? 'bg-emerald-950/60 text-emerald-300 border-emerald-600/50'
                        : 'bg-slate-900 text-slate-400 border-slate-800'
                    }`}
                    title="Hands-free auto-conversation mode"
                  >
                    <Radio className={`w-3 h-3 ${isHandsFree ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
                    <span>Hands-Free: {isHandsFree ? 'ON' : 'OFF'}</span>
                  </button>
                </div>

                {/* Live Real-time Hearing Transcript */}
                {interimTranscript ? (
                  <p className="text-xs font-mono text-amber-300 animate-pulse px-3 py-1 rounded-lg bg-amber-950/40 border border-amber-800/40 max-w-md">
                    Hearing: "{interimTranscript}..."
                  </p>
                ) : (
                  <p className="text-[11px] font-mono text-cyan-300/80">
                    {isSpeaking 
                      ? "Machi is replying aloud through speaker..." 
                      : isListening 
                      ? (isHandsFree ? "Hands-free active: Speak now in Tamil or English..." : "Listening to your voice...") 
                      : "Tap button above to begin speaking"}
                  </p>
                )}
                {micRoute && (
                  <p className="text-[10px] font-mono text-slate-500">Audio: {micRoute}</p>
                )}

                {/* Language Mode Toggle Badge */}
                <div className="flex items-center gap-1.5 pt-0.5">
                  <span className="text-[10px] text-slate-500 font-mono">Language:</span>
                  <button
                    onClick={() => handleLanguageChange(speechLanguage === 'en-IN' ? 'ta-IN' : 'en-IN')}
                    className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-cyan-400 border border-cyan-800/50 flex items-center gap-1"
                  >
                    <Globe className="w-2.5 h-2.5" />
                    {speechLanguage === 'en-IN' ? 'Tanglish / English (IN)' : 'தமிழ் (Tamil)'}
                  </button>
                </div>

                {/* Voice selector - always visible */}
                {voicePicker(true)}
              </div>
            </div>

            {/* Conversation Log Feed */}
            <div className="flex-1 overflow-y-auto p-3 md:p-6 space-y-3 md:space-y-4">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-mono text-slate-400">
                      {msg.sender === 'user' ? 'You' : 'Machi'}
                    </span>
                    <span className="text-[10px] text-slate-500">{msg.timestamp}</span>
                    {msg.sender === 'machi' && typeof msg.latencyMs === 'number' && (
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-950/60 text-cyan-400 border border-cyan-800/40 flex items-center gap-0.5">
                        <Zap className="w-2.5 h-2.5 text-cyan-400" />
                        {msg.latencyMs < 1000 ? `${msg.latencyMs}ms` : `${(msg.latencyMs / 1000).toFixed(2)}s`}
                      </span>
                    )}
                  </div>
                  <div
                    className={`max-w-xl rounded-2xl px-3.5 py-2.5 md:px-4 md:py-3 text-sm leading-relaxed shadow-md ${
                      msg.sender === 'user'
                        ? 'bg-gradient-to-r from-sky-600 to-blue-600 text-white rounded-tr-sm'
                        : 'bg-slate-900/90 text-slate-100 border border-cyan-800/40 rounded-tl-sm'
                    }`}
                  >
                    <p>{msg.text}</p>
                    
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-2.5 pt-2 border-t border-cyan-900/30 flex flex-wrap gap-1.5">
                        <span className="text-[10px] text-slate-400 flex items-center gap-1">
                          <Info className="w-3 h-3 text-cyan-400" /> Verified:
                        </span>
                        {msg.sources.map((src, i) => (
                          <a
                            key={i}
                            href={src.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-cyan-950/60 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-700/40"
                          >
                            {src.title} <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  {msg.sender === 'machi' && msg.isError && msg.retryText && (
                    <button
                      onClick={() => handleSendMessage(msg.retryText, true)}
                      className="mt-1 text-[11px] text-amber-300 hover:text-amber-200 flex items-center gap-1 px-1 py-0.5 cursor-pointer"
                    >
                      <RefreshCw className="w-3 h-3" /> Retry
                    </button>
                  )}
                  {msg.sender === 'machi' && !msg.isError && (
                    <button
                      onClick={() => {
                        setVoiceError(null);
                        machiVoice.speak(msg.text, selectedVoice).then(ok => {
                          if (!ok) setVoiceError('Could not play the voice. Check the server connection and volume, then retry.');
                        });
                      }}
                      className="mt-1 text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 px-1 py-0.5 cursor-pointer"
                    >
                      <Volume2 className="w-3 h-3" /> Replay voice
                    </button>
                  )}
                </div>
              ))}
              {(backendOnline === false || (isEmbeddedApp() && !getBackendBaseUrl())) && (
                <div className="bg-amber-950/60 border border-amber-700/50 rounded-xl p-3 text-xs text-amber-200 space-y-2">
                  <div>Machi server is not reachable. Enter your deployed server URL (https://...) so Machi can use the real AI.</div>
                  <div className="flex gap-2">
                    <input
                      value={backendDraft}
                      onChange={e => setBackendDraft(e.target.value)}
                      placeholder="https://your-machi-server.example.com"
                      className="flex-1 bg-slate-900 border border-amber-800/50 rounded px-2 py-1 text-amber-100"
                    />
                    <button
                      className="px-3 py-1 rounded bg-amber-600 text-white font-bold cursor-pointer"
                      onClick={() => {
                        if (/^https?:\/\//i.test(backendDraft.trim())) {
                          setBackendBaseUrl(backendDraft);
                          try { (window as any).MachiAndroid?.setBackendUrl?.(backendDraft.trim()); } catch {}
                          window.location.reload();
                        }
                      }}
                    >Save</button>
                  </div>
                </div>
              )}
              {voiceError && (
                <div className="bg-rose-950/60 border border-rose-700/50 rounded-xl px-3 py-2 text-xs text-rose-200 flex justify-between gap-2">
                  <span>{voiceError}</span>
                  <button className="underline cursor-pointer" onClick={() => setVoiceError(null)}>dismiss</button>
                </div>
              )}
              {isLoading && !firstSentenceShown && (
                <div className="flex flex-col items-start">
                  <div className="bg-slate-900/80 border border-cyan-800/40 rounded-2xl px-4 py-3 rounded-tl-sm">
                    <div className="flex items-center gap-2 text-xs text-cyan-400">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Machi is thinking and generating answer...
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick Prompt Suggestions */}
            <div className="px-3 py-1.5 flex items-center gap-2 overflow-x-auto no-scrollbar border-t border-cyan-900/20 bg-slate-950/80 shrink-0">
              <span className="text-[10px] text-slate-400 whitespace-nowrap">Try asking:</span>
              {[
                "Who is Virat Kohli?",
                "Tell me about Rohit Sharma",
                "Explain Python programming",
                "What is ERPNext?",
                "Remind me in 30 minutes to call friend"
              ].map((suggestion, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(suggestion)}
                  className="text-[11px] px-2.5 py-1 rounded-full bg-slate-900 hover:bg-cyan-950 text-slate-300 hover:text-cyan-300 border border-slate-800 hover:border-cyan-700/50 whitespace-nowrap transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>

            {/* Bottom Input Bar */}
            <div className="p-2.5 md:p-4 bg-slate-900/60 border-t border-cyan-900/30 backdrop-blur-md shrink-0">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendMessage();
                }}
                className="flex items-center gap-2 max-w-4xl mx-auto"
              >
                <button
                  type="button"
                  onClick={toggleListening}
                  className={`p-2.5 md:p-3 rounded-xl transition-all shadow-md cursor-pointer shrink-0 ${
                    isListening
                      ? 'bg-rose-500 text-white animate-pulse ring-2 ring-rose-400'
                      : 'bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-cyan-800/40'
                  }`}
                  title={isListening ? "Stop Listening" : "Start Voice Input"}
                >
                  {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                </button>
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Ask Machi anything (Tamil, Tanglish, English)..."
                  className="flex-1 bg-slate-950/80 border border-cyan-900/40 rounded-xl px-3 py-2.5 md:px-4 md:py-3 text-sm focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 text-slate-100 placeholder:text-slate-500"
                />
                <button
                  type="submit"
                  disabled={!inputText.trim() || isLoading}
                  className="p-2.5 md:p-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:hover:bg-cyan-600 text-white transition-all shadow-md shadow-cyan-600/30 cursor-pointer shrink-0"
                >
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
          </div>
        )}

        {/* TAB 2: Standalone Installers & Builds */}
        {activeTab === 'installers' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <Download className="w-6 h-6 text-cyan-400" />
                    Independent Production Deployments
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Complete native desktop & mobile packages built directly with NSIS and Android SDK build tools.
                  </p>
                </div>
                <button
                  onClick={() => setActiveTab('chat')}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 text-xs font-semibold"
                >
                  Back to Assistant
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Windows Card */}
                <div className="rounded-2xl border border-cyan-900/40 bg-slate-900/60 p-6 flex flex-col justify-between shadow-xl relative overflow-hidden group">
                  <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                    <Laptop className="w-32 h-32 text-cyan-400" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <span className="p-3 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-400">
                        <Laptop className="w-6 h-6" />
                      </span>
                      <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-sky-950/60 text-sky-400 border border-sky-800/40">
                        Windows Standalone Setup
                      </span>
                    </div>

                    <h3 className="text-lg font-bold text-white mb-1">Machi for Windows</h3>
                    <p className="text-xs font-mono text-cyan-300 mb-3">Machi-Setup.exe</p>
                    <p className="text-xs text-slate-400 leading-relaxed mb-4">
                      Full native Windows setup package compiled with NSIS. Installs Machi directly to Program Files, creates Start Menu & Desktop shortcuts, and launches instantly without requiring Node.js, Python, or command-line tools.
                    </p>

                    <div className="space-y-2 mb-6 text-xs text-slate-300 bg-slate-950/60 p-3.5 rounded-xl border border-slate-800">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Start Menu & Desktop shortcuts included</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Bundled portable Node.exe runtime (No manual setup)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Locked voice: Puck / Guy Neural + Loudness Gain</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Independent executable (Does not depend on dev server)</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <button
                      onClick={() => handleDownload('Machi-Setup.exe', 15000000)}
                      disabled={downloadingFile === 'Machi-Setup.exe'}
                      className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-sky-500 to-cyan-500 hover:from-sky-400 hover:to-cyan-400 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/25 transition-all disabled:opacity-60 cursor-pointer"
                    >
                      {downloadingFile === 'Machi-Setup.exe' ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" /> Verifying & Downloading (18.3 MB)...
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4" /> Download Machi-Setup.exe (18.3 MB)
                        </>
                      )}
                    </button>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleCopyLink('Machi-Setup.exe')}
                        className="flex-1 py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-800/40 text-xs flex items-center justify-center gap-1.5 transition-all"
                      >
                        {copiedLink === 'Machi-Setup.exe' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" /> Link Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" /> Copy Direct Link
                          </>
                        )}
                      </button>
                      <a
                        href="/release/Machi-Setup.exe"
                        download="Machi-Setup.exe"
                        className="py-1.5 px-3 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs flex items-center gap-1"
                        title="Direct browser fallback link"
                      >
                        <Link className="w-3.5 h-3.5" /> Fallback
                      </a>
                    </div>
                    <p className="text-center text-[10px] text-slate-500 font-mono">
                      Target: Windows 10 / 11 (64-bit) • Size: 18.3 MB
                    </p>
                  </div>
                </div>

                {/* Android APK Card */}
                <div className="rounded-2xl border border-cyan-500/30 bg-slate-900/60 p-6 flex flex-col justify-between shadow-xl relative overflow-hidden group">
                  <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                    <Smartphone className="w-32 h-32 text-cyan-400" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <span className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                        <Smartphone className="w-6 h-6" />
                      </span>
                      <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-emerald-950/60 text-emerald-400 border border-emerald-800/40">
                        Genuine Signed APK (252 KB)
                      </span>
                    </div>

                    <h3 className="text-lg font-bold text-white mb-1">Machi for Android</h3>
                    <p className="text-xs font-mono text-cyan-300 mb-3">Machi.apk</p>
                    <p className="text-xs text-slate-400 leading-relaxed mb-4">
                      Built with Android native hardware MediaPlayer & system SpeechRecognizer bridge. Includes hands-free continuous conversation mode, loud phone speaker audio output, and dual Tamil / Tanglish support.
                    </p>

                    <div className="space-y-2 mb-6 text-xs text-slate-300 bg-slate-950/60 p-3.5 rounded-xl border border-slate-800">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Native Android Hardware MediaPlayer (Loud speaker audio)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>System SpeechRecognizer with noise suppression</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Hands-free continuous conversation mode (Zero echo)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Direct connection to deployed Machi backend</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <button
                      onClick={() => handleDownload('Machi.apk', 200000)}
                      disabled={downloadingFile === 'Machi.apk'}
                      className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 transition-all disabled:opacity-60 cursor-pointer"
                    >
                      {downloadingFile === 'Machi.apk' ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" /> Verifying & Downloading (252 KB)...
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4" /> Download Machi.apk (252 KB)
                        </>
                      )}
                    </button>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleCopyLink('Machi.apk')}
                        className="flex-1 py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-800/40 text-xs flex items-center justify-center gap-1.5 transition-all"
                      >
                        {copiedLink === 'Machi.apk' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" /> Link Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" /> Copy Direct Link
                          </>
                        )}
                      </button>
                      <a
                        href="/release/Machi.apk"
                        download="Machi.apk"
                        className="py-1.5 px-3 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs flex items-center gap-1"
                        title="Direct browser fallback link"
                      >
                        <Link className="w-3.5 h-3.5" /> Fallback
                      </a>
                    </div>
                    <p className="text-center text-[10px] text-slate-500 font-mono">
                      Target: Android 5.0 to 14+ (ARM64 / x86_64) • Size: 252 KB
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: Smart Reminders */}
        {activeTab === 'reminders' && (
          <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="max-w-2xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <Clock className="w-6 h-6 text-cyan-400" />
                    Automated Voice Reminders
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Reminders created automatically via voice command. Machi will announce them aloud.
                  </p>
                </div>
                <button
                  onClick={() => setActiveTab('chat')}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 text-xs font-semibold"
                >
                  Back to Assistant
                </button>
              </div>

              <div className="space-y-3">
                {reminders.map((reminder) => (
                  <div
                    key={reminder.id}
                    className="flex items-center justify-between p-4 rounded-xl bg-slate-900/60 border border-cyan-900/30 shadow-md"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-cyan-950 flex items-center justify-center border border-cyan-800/50">
                        <Bell className="w-4 h-4 text-cyan-400" />
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-white">{reminder.title}</h4>
                        <p className="text-xs text-slate-400 font-mono mt-0.5">{reminder.time}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setReminders(prev => prev.filter(r => r.id !== reminder.id))}
                      className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-rose-400 transition-colors"
                      title="Dismiss reminder"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
