import ai.machi.assistant.SpeechCapture;
import java.util.Random;

public class VadTest {
    static int pass = 0, fail = 0;
    static void t(String name, boolean ok, String extra) { if (ok) pass++; else fail++; System.out.println((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  -> " + extra)); }
    static final Random R = new Random(42);

    // speech-like signal: syllable-modulated tone + noise; `rms` is the intended loudness
    static short[] seg(int ms, double rms, double noiseSigma, boolean speech) {
        int n = ms * 16;
        short[] out = new short[n];
        for (int i = 0; i < n; i++) {
            double v = R.nextGaussian() * noiseSigma;
            if (speech) {
                double env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * i / 16000.0);          // ~4 syllables / s
                v += Math.sqrt(2) * rms * env * (Math.sin(2 * Math.PI * 180 * i / 16000.0) + 0.5 * Math.sin(2 * Math.PI * 540 * i / 16000.0)) / 1.3;
            }
            out[i] = (short) Math.max(-32767, Math.min(32767, Math.round(v)));
        }
        return out;
    }
    // feed segments; returns {event ordinal at end, ms fed}
    static class Run { SpeechCapture.Event last = SpeechCapture.Event.NONE; boolean started = false; long ms = 0; SpeechCapture cap; }
    static Run feed(SpeechCapture cap, Run run, short[]... parts) {
        run.cap = cap;
        short[] f = new short[SpeechCapture.FRAME];
        for (short[] p : parts) {
            for (int off = 0; off + SpeechCapture.FRAME <= p.length; off += SpeechCapture.FRAME) {
                System.arraycopy(p, off, f, 0, SpeechCapture.FRAME);
                SpeechCapture.Event e = cap.feed(f, SpeechCapture.FRAME, run.ms);
                run.ms += 20;
                if (e == SpeechCapture.Event.SPEECH_START) run.started = true;
                if (e == SpeechCapture.Event.END || e == SpeechCapture.Event.TIMEOUT) { run.last = e; return run; }
            }
        }
        return run;
    }
    static short peakOf(byte[] wav) { int p = 0; for (int i = 44; i + 1 < wav.length; i += 2) p = Math.max(p, Math.abs((short) ((wav[i] & 0xFF) | (wav[i + 1] << 8)))); return (short) p; }
    static int le32(byte[] b, int o) { return (b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8) | ((b[o + 2] & 0xFF) << 16) | ((b[o + 3] & 0xFF) << 24); }

    public static void main(String[] a) {
        // 1. silence only -> times out (user said nothing), no speech reported
        Run r = feed(new SpeechCapture(900, 12000), new Run(), seg(15000, 0, 25, false));
        t("silence: no speech detected, times out after ~12 s", !r.started && r.last == SpeechCapture.Event.TIMEOUT && r.ms >= 12000 && r.ms < 12100, r.last + " ms=" + r.ms);

        // 2. SOFT speech (RMS ~150, barely above a quiet room) -> detected, ends ~0.9 s after, gain applied
        SpeechCapture c = new SpeechCapture(900, 12000);
        r = feed(c, new Run(), seg(1000, 0, 25, false), seg(2500, 150, 25, true), seg(2000, 0, 25, false));
        t("soft speech (RMS 150): detected", r.started, "started=" + r.started);
        t("soft speech: turn ends ~0.9 s after you stop (fast reply)", r.last == SpeechCapture.Event.END && r.ms >= 1000 + 2500 + 800 && r.ms <= 1000 + 2500 + 1100, "ms=" + r.ms + " last=" + r.last);
        byte[] wav = c.finishWav();
        t("soft speech: amplified a lot (gain >= 8x) and not clipped", c.lastGain >= 8f && peakOf(wav) <= 32767 && peakOf(wav) > 5000, "gain=" + c.lastGain + " peak=" + peakOf(wav));
        t("soft speech: recording contains the whole utterance (>= 2.4 s) but not minutes of silence", c.lastDurationMs >= 2400 && c.lastDurationMs <= 3600, "dur=" + c.lastDurationMs);

        // 3. normal speech
        c = new SpeechCapture(900, 12000);
        r = feed(c, new Run(), seg(800, 0, 30, false), seg(2000, 4000, 30, true), seg(2000, 0, 30, false));
        wav = c.finishWav();
        t("normal-volume speech: detected, ends, only mild gain (no over-amplification)", r.started && r.last == SpeechCapture.Event.END && c.lastGain < 8f, "gain=" + c.lastGain);

        // 4. noisy room (noise sigma 300, speech 1800): must still START and END (relative thresholds)
        c = new SpeechCapture(900, 12000);
        r = feed(c, new Run(), seg(1000, 0, 300, false), seg(2500, 1800, 300, true), seg(2500, 0, 300, false));
        t("noisy room: speech detected", r.started, "started=" + r.started);
        t("noisy room: turn still ends (does not run to the 25 s limit)", r.last == SpeechCapture.Event.END && r.ms < 8000, "ms=" + r.ms + " last=" + r.last);

        // 5. a short click / cough is ignored; real speech afterwards is still captured
        c = new SpeechCapture(900, 12000);
        r = feed(c, new Run(), seg(800, 0, 25, false), seg(100, 3000, 25, true), seg(1500, 0, 25, false));
        t("0.1 s click: does not end the turn or count as speech", r.last == SpeechCapture.Event.NONE, "last=" + r.last);
        r = feed(c, r, seg(2000, 400, 25, true), seg(2000, 0, 25, false));
        t("speech after a click is still captured", r.last == SpeechCapture.Event.END && c.finishWav().length > 44 + 16000 * 2, "last=" + r.last);

        // 6. a pause inside a sentence (0.6 s) must NOT cut the turn
        c = new SpeechCapture(900, 12000);
        r = feed(c, new Run(), seg(800, 0, 25, false), seg(1200, 500, 25, true), seg(600, 0, 25, false), seg(1200, 500, 25, true), seg(2000, 0, 25, false));
        t("0.6 s pause mid-sentence does not split the turn", r.last == SpeechCapture.Event.END && r.ms > 800 + 1200 + 600 + 1200 + 800, "ms=" + r.ms);

        // 7. endless speech is capped at 25 s
        c = new SpeechCapture(900, 12000);
        r = feed(c, new Run(), seg(800, 0, 25, false), seg(40000, 800, 25, true));
        t("continuous speech ends at the 25 s limit", r.last == SpeechCapture.Event.END && r.ms < 27000, "ms=" + r.ms);

        // 8. WAV container is valid (what the server sends to Gemini)
        c = new SpeechCapture(900, 12000);
        feed(c, new Run(), seg(800, 0, 25, false), seg(2000, 600, 25, true), seg(2000, 0, 25, false));
        wav = c.finishWav();
        boolean riff = wav[0] == 'R' && wav[1] == 'I' && wav[2] == 'F' && wav[3] == 'F' && wav[8] == 'W' && wav[12] == 'f' && wav[36] == 'd';
        t("WAV header valid: 16 kHz, mono, 16-bit, sizes consistent", riff && le32(wav, 24) == 16000 && wav[22] == 1 && wav[34] == 16 && le32(wav, 40) == wav.length - 44 && le32(wav, 4) == wav.length - 8, "len=" + wav.length);
        System.out.println(pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
