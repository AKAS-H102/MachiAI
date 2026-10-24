package ai.machi.assistant;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.Arrays;

/**
 * Decides when you start and stop talking, and prepares the recording. No Android classes, so it is unit-testable.
 * The speech threshold follows the room's noise level (so soft voices are caught), the end of your turn is judged
 * relative to how loud YOU were (so noisy rooms still end), and the finished audio is amplified up to 30x.
 */
public final class SpeechCapture {
    public enum Event { NONE, SPEECH_START, END, TIMEOUT }

    public static final int SAMPLE_RATE = 16000;
    public static final int FRAME = 320;                    // 20 ms
    static final int CALIB_FRAMES = 12;                     // 0.24 s to learn the background noise
    static final int PREROLL_FRAMES = 15;                   // keep 0.3 s before speech so first syllables survive
    static final int START_FRAMES = 5;                      // 0.1 s above threshold = speech
    static final int MIN_SPEECH_FRAMES = 10;                // shorter than 0.2 s = click / cough, ignore
    static final int MAX_BYTES = SAMPLE_RATE * 2 * 25;      // 25 s per turn

    private final int endSilenceFrames;
    private final long noSpeechTimeoutMs;
    private final double[] calib = new double[CALIB_FRAMES];
    private int calibN = 0;
    private double noise = 40;
    private double speechLevel = 0;
    private boolean inSpeech = false;
    private int loud = 0, silent = 0, speechFrames = 0;
    private long startedAtMs = -1;
    private final ArrayDeque<short[]> pre = new ArrayDeque<short[]>();
    private final ByteArrayOutputStream pcm = new ByteArrayOutputStream();

    // results (valid after END)
    public float lastGain = 1f;
    public int lastPeak = 0;
    public int lastDurationMs = 0;

    public SpeechCapture(int endSilenceMs, long noSpeechTimeoutMs) {
        this.endSilenceFrames = Math.max(1, endSilenceMs / 20);
        this.noSpeechTimeoutMs = noSpeechTimeoutMs;
    }

    public double noiseLevel() { return noise; }
    public boolean isInSpeech() { return inSpeech; }

    public static double rms(short[] f, int n) {
        if (n <= 0) return 0;
        double sum = 0;
        for (int i = 0; i < n; i++) sum += (double) f[i] * f[i];
        return Math.sqrt(sum / n);
    }

    private void writeFrame(short[] f, int n) {
        for (int i = 0; i < n; i++) { pcm.write(f[i] & 0xFF); pcm.write((f[i] >> 8) & 0xFF); }
    }

    public Event feed(short[] frame, int n, long nowMs) {
        if (startedAtMs < 0) startedAtMs = nowMs;
        double r = rms(frame, n);
        if (calibN < CALIB_FRAMES) {
            calib[calibN++] = r;
            pre.addLast(Arrays.copyOf(frame, n));
            if (calibN == CALIB_FRAMES) {
                double[] c = calib.clone();
                Arrays.sort(c);
                noise = Math.min(400, Math.max(c[3], 20));    // low percentile: robust even if you start talking at once
            }
            return Event.NONE;
        }
        double startThr = Math.max(noise * 3.0, 80.0);
        if (!inSpeech) {
            pre.addLast(Arrays.copyOf(frame, n));
            while (pre.size() > PREROLL_FRAMES) pre.removeFirst();
            if (r > startThr) loud++; else { loud = 0; noise = noise * 0.97 + r * 0.03; }
            if (loud >= START_FRAMES) {
                inSpeech = true; silent = 0; speechFrames = loud; speechLevel = r;
                for (short[] f : pre) writeFrame(f, f.length);
                pre.clear();
                return Event.SPEECH_START;
            }
            if (nowMs - startedAtMs > noSpeechTimeoutMs) return Event.TIMEOUT;
            return Event.NONE;
        }
        writeFrame(frame, n);
        double endThr = Math.max(Math.max(noise * 1.8, 55.0), speechLevel * 0.3);
        if (r > endThr) {
            silent = 0; speechFrames++;
            if (r > startThr) speechLevel = speechLevel * 0.9 + r * 0.1;
        } else silent++;
        if (silent >= endSilenceFrames) {
            if (speechFrames < MIN_SPEECH_FRAMES) {          // just a blip: forget it and keep waiting
                pcm.reset(); inSpeech = false; loud = 0; silent = 0; speechFrames = 0; speechLevel = 0;
                return Event.NONE;
            }
            return Event.END;
        }
        if (pcm.size() > MAX_BYTES) return Event.END;
        return Event.NONE;
    }

    /** Trims trailing quiet, amplifies soft speech (max 30x, never clips) and wraps it as a 16 kHz mono WAV. */
    public byte[] finishWav() {
        byte[] raw = pcm.toByteArray();
        int trim = Math.max(0, silent - 15) * FRAME * 2;
        int len = Math.max(0, raw.length - trim) & ~1;
        int peak = 1;
        for (int i = 0; i + 1 < len; i += 2) {
            int v = Math.abs((short) ((raw[i] & 0xFF) | (raw[i + 1] << 8)));
            if (v > peak) peak = v;
        }
        float gain = Math.min(30f, 26000f / peak);
        if (gain > 1.15f) {
            for (int i = 0; i + 1 < len; i += 2) {
                int v = (short) ((raw[i] & 0xFF) | (raw[i + 1] << 8));
                v = Math.max(-32767, Math.min(32767, Math.round(v * gain)));
                raw[i] = (byte) (v & 0xFF);
                raw[i + 1] = (byte) ((v >> 8) & 0xFF);
            }
        } else gain = 1f;
        lastGain = gain; lastPeak = peak; lastDurationMs = len / 2 * 1000 / SAMPLE_RATE;
        return wav(raw, len, SAMPLE_RATE);
    }

    public static byte[] wav(byte[] pcm, int len, int sampleRate) {
        ByteArrayOutputStream o = new ByteArrayOutputStream(len + 44);
        o.write('R'); o.write('I'); o.write('F'); o.write('F'); w32(o, 36 + len);
        o.write('W'); o.write('A'); o.write('V'); o.write('E'); o.write('f'); o.write('m'); o.write('t'); o.write(' ');
        w32(o, 16); w16(o, 1); w16(o, 1); w32(o, sampleRate); w32(o, sampleRate * 2); w16(o, 2); w16(o, 16);
        o.write('d'); o.write('a'); o.write('t'); o.write('a'); w32(o, len);
        o.write(pcm, 0, len);
        return o.toByteArray();
    }
    private static void w16(ByteArrayOutputStream o, int v) { o.write(v & 0xFF); o.write((v >> 8) & 0xFF); }
    private static void w32(ByteArrayOutputStream o, int v) { w16(o, v & 0xFFFF); w16(o, (v >> 16) & 0xFFFF); }
}
