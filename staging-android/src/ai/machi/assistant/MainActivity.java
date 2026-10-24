package ai.machi.assistant;

import android.app.Activity;
import android.os.Bundle;
import android.content.Context;
import android.content.Intent;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.PermissionRequest;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.view.Window;
import android.view.WindowManager;
import android.view.View;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import android.util.Base64;
import android.media.MediaPlayer;
import android.media.AudioManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.provider.Settings;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.Voice;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import android.speech.SpeechRecognizer;
import android.speech.RecognizerIntent;
import android.speech.RecognitionListener;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Locale;
import android.content.SharedPreferences;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

public class MainActivity extends Activity {
    private static final String TAG = "Machi";
    private static final int PERMISSION_REQUEST_CODE = 101;
    
    private WebView mWebView;
    private MediaPlayer mMediaPlayer;
    private SpeechRecognizer mSpeechRecognizer;
    private AudioManager mAudioManager;
    private boolean mIsListening = false;
    private TextToSpeech mTts;
    private boolean mTtsReady = false;
    private String mPendingTtsText = null;
    private String mPendingTtsLang = "en-IN";
    private AudioManager.OnAudioFocusChangeListener mFocusListener;
    private boolean mPendingStartListening = false;
    private String mPendingListenLang = "en-IN";
    private String mPendingTtsVoice = null;
    private final Handler mHandler = new Handler(Looper.getMainLooper());
    private boolean mScoActive = false;
    private BroadcastReceiver mScoReceiver = null;
    private Runnable mScoPending = null;
    private AudioDeviceCallback mRouteCallback = null;
    private static final String BT_CONNECT = "android.permission.BLUETOOTH_CONNECT";
    private static final String POST_NOTIF = "android.permission.POST_NOTIFICATIONS";
    private static final int PERMISSION_CALL_CODE = 102;
    private String mPendingCallName = null;
    private String mPendingDialNumber = null, mPendingDialLabel = null;
    private boolean mCallPermAsked = false;
    private boolean mPendingCapture = false;
    private volatile boolean mCaptureRunning = false;
    private volatile int mCaptureGen = 0;
    private volatile byte[] mCapturedWav = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep screen active while conversing with assistant
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );

        if (getWindow() != null && getWindow().getDecorView() != null) {
            getWindow().getDecorView().setBackgroundColor(0xFF020617);
        }

        mAudioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        mWebView = new WebView(this);
        mWebView.setBackgroundColor(0xFF020617);
        mWebView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        setContentView(mWebView);

        WebSettings settings = mWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setAllowUniversalAccessFromFileURLs(true);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Register Native Android Hardware Bridge for reliable speech recognition & loud speaker TTS
        mWebView.addJavascriptInterface(new MachiNativeBridge(), "MachiAndroid");

        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    request.grant(request.getResources());
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.d(TAG, "[JS] " + consoleMessage.message());
                return true;
            }
        });

        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                view.loadUrl(url);
                return true;
            }
        });

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            ArrayList<String> need = new ArrayList<String>();
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                need.add(android.Manifest.permission.RECORD_AUDIO);
            }
            if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(BT_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                need.add(BT_CONNECT);
            }
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(POST_NOTIF) != PackageManager.PERMISSION_GRANTED) {
                need.add(POST_NOTIF); // without it Android hides reminder notifications
            }
            if (!need.isEmpty()) {
                requestPermissions(need.toArray(new String[0]), PERMISSION_REQUEST_CODE);
            }
        }

        // Follow headset / earbuds being connected or removed (built-in mic <-> wired <-> Bluetooth)
        if (Build.VERSION.SDK_INT >= 23 && mAudioManager != null) {
            mRouteCallback = new AudioDeviceCallback() {
                @Override public void onAudioDevicesAdded(AudioDeviceInfo[] added) { refreshRouteLabel(); }
                @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                    if (mScoActive && findInput(true) == null) stopBluetoothCall();
                    refreshRouteLabel();
                }
            };
            mAudioManager.registerAudioDeviceCallback(mRouteCallback, mHandler);
        }

        loadMachiApp();
    }

    private void loadMachiApp() {
        try {
            InputStream is = getAssets().open("www/index.html");
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int length;
            while ((length = is.read(buffer)) != -1) {
                baos.write(buffer, 0, length);
            }
            is.close();
            String html = baos.toString("UTF-8");
            mWebView.loadDataWithBaseURL("https://machi.ai/", html, "text/html", "UTF-8", null);
        } catch (Exception e) {
            Log.e(TAG, "Fallback to file asset URL: " + e.getMessage());
            mWebView.loadUrl("file:///android_asset/www/index.html");
        }
    }


    // ---------- helpers ----------
    private static String jsStr(String s) {
        // Safe JS string literal (handles quotes, backslashes, newlines, U+2028/2029)
        if (s == null) return "''";
        StringBuilder sb = new StringBuilder("'");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '\'': sb.append("\\'"); break;
                case '"': sb.append("\\\""); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\u2028': sb.append("\\u2028"); break;
                case '\u2029': sb.append("\\u2029"); break;
                default: sb.append(c);
            }
        }
        return sb.append("'").toString();
    }

    private void requestAudioFocus() {
        try {
            if (mAudioManager == null) return;
            if (mFocusListener == null) {
                mFocusListener = new AudioManager.OnAudioFocusChangeListener() {
                    @Override public void onAudioFocusChange(int change) {
                        Log.d(TAG, "audio focus change: " + change);
                    }
                };
            }
            int r = mAudioManager.requestAudioFocus(mFocusListener, mScoActive ? AudioManager.STREAM_VOICE_CALL : AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
            Log.d(TAG, "audio focus request result=" + r);
        } catch (Exception e) {
            Log.w(TAG, "audio focus request failed: " + e.getMessage());
        }
    }

    private void abandonAudioFocus() {
        try {
            if (mAudioManager != null && mFocusListener != null) mAudioManager.abandonAudioFocus(mFocusListener);
        } catch (Exception ignored) {}
    }

    private void ensureTts(final Runnable onReady) {
        if (mTts != null && mTtsReady) { if (onReady != null) onReady.run(); return; }
        if (mTts != null) return; // initialising; pending text is flushed in onInit
        mTts = new TextToSpeech(getApplicationContext(), new TextToSpeech.OnInitListener() {
            @Override public void onInit(int status) {
                if (status != TextToSpeech.SUCCESS) {
                    Log.e(TAG, "TextToSpeech init failed status=" + status);
                    mTts = null; mTtsReady = false;
                    mPendingTtsText = null;
                    evalJs("window.onMachiNativeTtsError && window.onMachiNativeTtsError('tts_init_failed');");
                    return;
                }
                mTtsReady = true;
                Log.d(TAG, "TextToSpeech ready, engine=" + (mTts != null ? mTts.getDefaultEngine() : "?"));
                mTts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) {
                        abandonAudioFocus();
                        evalJs("window.onMachiNativeTtsDone && window.onMachiNativeTtsDone();");
                    }
                    @Override public void onError(String id) {
                        abandonAudioFocus();
                        Log.e(TAG, "TTS utterance error");
                        evalJs("window.onMachiNativeTtsError && window.onMachiNativeTtsError('tts_utterance_error');");
                    }
                });
                pushVoicesToJs();
                if (mPendingTtsText != null) {
                    String t = mPendingTtsText; mPendingTtsText = null;
                    doSpeakText(t, mPendingTtsLang, mPendingTtsVoice);
                }
            }
        });
    }

    private void doSpeakText(String text, String lang, String voiceName) {
        if (mTts == null || !mTtsReady) {
            evalJs("window.onMachiNativeTtsError && window.onMachiNativeTtsError('tts_not_ready');");
            return;
        }
        Locale loc = Locale.forLanguageTag(lang == null || lang.isEmpty() ? "en-IN" : lang);
        int avail = mTts.setLanguage(loc);
        if (avail == TextToSpeech.LANG_MISSING_DATA || avail == TextToSpeech.LANG_NOT_SUPPORTED) {
            Log.w(TAG, "TTS language " + loc + " unsupported, using en-US");
            avail = mTts.setLanguage(Locale.US);
            if (avail == TextToSpeech.LANG_MISSING_DATA || avail == TextToSpeech.LANG_NOT_SUPPORTED) {
                evalJs("window.onMachiNativeTtsError && window.onMachiNativeTtsError('tts_language_unsupported');");
                return;
            }
        }
        // A specific phone voice chosen in the app overrides the language default
        if (voiceName != null && voiceName.length() > 0 && Build.VERSION.SDK_INT >= 21) {
            try {
                Voice chosen = null;
                Set<Voice> all = mTts.getVoices();
                if (all != null) for (Voice v : all) { if (voiceName.equals(v.getName())) { chosen = v; break; } }
                if (chosen != null) mTts.setVoice(chosen); else Log.w(TAG, "phone voice not found: " + voiceName);
            } catch (Exception e) { Log.w(TAG, "setVoice failed: " + e.getMessage()); }
        }
        if (Build.VERSION.SDK_INT >= 21) {
            try {
                mTts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(mScoActive ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            } catch (Exception ignored) {}
        }
        requestAudioFocus();
        int r = mTts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "machi-" + System.currentTimeMillis());
        if (r != TextToSpeech.SUCCESS) {
            abandonAudioFocus();
            evalJs("window.onMachiNativeTtsError && window.onMachiNativeTtsError('tts_speak_failed');");
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("machi", Context.MODE_PRIVATE);
    }

    private String readAssetText(String name) {
        try {
            InputStream is = getAssets().open(name);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] b = new byte[1024]; int n;
            while ((n = is.read(b)) != -1) baos.write(b, 0, n);
            is.close();
            return baos.toString("UTF-8").trim();
        } catch (Exception e) { return ""; }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_CALL_CODE) { handleCallPermissionResult(permissions, grantResults); return; }
        if (requestCode == PERMISSION_REQUEST_CODE) {
            boolean micAsked = false, granted = false;
            for (int i = 0; i < permissions.length && i < grantResults.length; i++) {
                if (android.Manifest.permission.RECORD_AUDIO.equals(permissions[i])) {
                    micAsked = true;
                    granted = grantResults[i] == PackageManager.PERMISSION_GRANTED;
                } else if (BT_CONNECT.equals(permissions[i])) {
                    Log.d(TAG, "BLUETOOTH_CONNECT granted=" + (grantResults[i] == PackageManager.PERMISSION_GRANTED));
                    refreshRouteLabel();
                }
            }
            if (!micAsked) return;
            Log.d(TAG, "RECORD_AUDIO permission granted=" + granted);
            if (mPendingCapture) {
                mPendingCapture = false;
                if (granted) {
                    mWebView.post(new Runnable() { @Override public void run() {
                        routeAudioThen(new Runnable() { @Override public void run() { startCaptureInternal(); } });
                    } });
                } else {
                    evalJs("window.onMachiCaptureError && window.onMachiCaptureError('no_permission');");
                }
                return;
            }
            if (granted && mPendingStartListening) {
                mPendingStartListening = false;
                mWebView.post(new Runnable() { @Override public void run() {
                    routeAudioThen(new Runnable() { @Override public void run() { beginRecognition(mPendingListenLang); } });
                } });
            } else if (!granted) {
                mPendingStartListening = false;
                evalJs("window.onMachiNativeSpeechError && window.onMachiNativeSpeechError('no_permission');");
            }
        }
    }

    private void handleCallPermissionResult(String[] permissions, int[] grantResults) {
        boolean contactsOk = false, phoneOk = false;
        for (int i = 0; i < permissions.length && i < grantResults.length; i++) {
            boolean ok = grantResults[i] == PackageManager.PERMISSION_GRANTED;
            if (android.Manifest.permission.READ_CONTACTS.equals(permissions[i])) contactsOk = ok;
            if (android.Manifest.permission.CALL_PHONE.equals(permissions[i])) phoneOk = ok;
        }
        if (mPendingCallName != null) {
            String n = mPendingCallName; mPendingCallName = null;
            if (contactsOk) lookupAndCall(n); else callResult("no_permission", "contacts");
        } else if (mPendingDialNumber != null) {
            String num = mPendingDialNumber, label = mPendingDialLabel;
            mPendingDialNumber = null; mPendingDialLabel = null;
            if (phoneOk) placeCall(num, label); else openDialer(num, label);
        }
    }

    private boolean hasMicPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void beginRecognition(String language) {
        try {
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                Log.e(TAG, "No speech recognition service available");
                evalJs("window.onMachiNativeSpeechError && window.onMachiNativeSpeechError('unavailable');");
                return;
            }
            if (mSpeechRecognizer != null) {
                try { mSpeechRecognizer.destroy(); } catch (Exception ignored) {}
                mSpeechRecognizer = null;
            }
            mSpeechRecognizer = SpeechRecognizer.createSpeechRecognizer(MainActivity.this);
            mSpeechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {
                    mIsListening = true;
                    Log.d(TAG, "STT ready");
                    evalJs("window.onMachiNativeReadyForSpeech && window.onMachiNativeReadyForSpeech();");
                }
                @Override public void onBeginningOfSpeech() {
                    evalJs("window.onMachiNativeSpeechStart && window.onMachiNativeSpeechStart();");
                }
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {
                    evalJs("window.onMachiNativeSpeechEnd && window.onMachiNativeSpeechEnd();");
                }
                @Override public void onError(int error) {
                    mIsListening = false;
                    String d;
                    switch (error) {
                        case SpeechRecognizer.ERROR_NO_MATCH: d = "no_match"; break;
                        case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: d = "timeout"; break;
                        case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: d = "no_permission"; break;
                        case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: d = "busy"; break;
                        case SpeechRecognizer.ERROR_NETWORK:
                        case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: d = "network"; break;
                        case SpeechRecognizer.ERROR_AUDIO: d = "audio"; break;
                        default: d = "code_" + error;
                    }
                    Log.w(TAG, "STT error " + error + " -> " + d);
                    evalJs("window.onMachiNativeSpeechError && window.onMachiNativeSpeechError(" + jsStr(d) + ");");
                }
                @Override public void onResults(Bundle results) {
                    mIsListening = false;
                    ArrayList<String> m = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (m != null && !m.isEmpty() && m.get(0) != null && m.get(0).trim().length() > 0) {
                        float[] sc = results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
                        float conf = (sc != null && sc.length > 0) ? sc[0] : -1f;
                        Log.d(TAG, "STT final result received (" + m.get(0).length() + " chars) conf=" + conf);
                        // Send the other candidate transcripts too: soft / unclear speech is often mis-ranked,
                        // and the AI can use the alternatives to work out what was really said.
                        StringBuilder alts = new StringBuilder("[");
                        for (int i = 1; i < m.size() && i < 5; i++) {
                            if (m.get(i) == null || m.get(i).trim().length() == 0) continue;
                            if (alts.length() > 1) alts.append(",");
                            alts.append(jsStr(m.get(i)));
                        }
                        alts.append("]");
                        evalJs("window.onMachiNativeFinalTranscript && window.onMachiNativeFinalTranscript(" + jsStr(m.get(0)) + "," + conf + "," + alts + ");");
                    } else {
                        evalJs("window.onMachiNativeSpeechError && window.onMachiNativeSpeechError('no_match');");
                    }
                }
                @Override public void onPartialResults(Bundle partial) {
                    ArrayList<String> p = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (p != null && !p.isEmpty() && p.get(0) != null) {
                        evalJs("window.onMachiNativeInterimTranscript && window.onMachiNativeInterimTranscript(" + jsStr(p.get(0)) + ");");
                    }
                }
                @Override public void onEvent(int eventType, Bundle params) {}
            });

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            String lang = (language != null && !language.isEmpty()) ? language : "en-IN";
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
            // Longer silence windows so quiet / slow speakers are not cut off
            // Short enough that Machi answers right after you stop talking, long enough not to cut off soft / slow speech
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L);
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1000L);
            // Prefer the chosen language but also understand Tamil / Indian & US English words mixed in (Tanglish)
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
            intent.putExtra("android.speech.extra.EXTRA_ADDITIONAL_LANGUAGES", new String[]{"ta-IN", "en-IN", "en-US"});
            Log.d(TAG, "STT start lang=" + lang);
            mSpeechRecognizer.startListening(intent);
        } catch (Exception e) {
            Log.e(TAG, "STT init error: " + e.getMessage());
            evalJs("window.onMachiNativeSpeechError && window.onMachiNativeSpeechError('init_failed');");
        }
    }

    public class MachiNativeBridge {
        @JavascriptInterface
        public boolean isNativeBridge() { return true; }

        // Backend URL: user-saved value first, then optional assets/backend_url.txt baked into the APK
        @JavascriptInterface
        public String getBackendUrl() {
            String saved = prefs().getString("backend_url", "");
            if (saved != null && saved.length() > 0) return saved;
            return readAssetText("backend_url.txt");
        }

        @JavascriptInterface
        public void setBackendUrl(String url) {
            prefs().edit().putString("backend_url", url == null ? "" : url.trim()).apply();
            Log.d(TAG, "backend url saved");
        }

        @JavascriptInterface
        public void speak(final String base64Audio, final String mimeType) {
            if (base64Audio == null || base64Audio.isEmpty()) {
                evalJs("window.onMachiNativeAudioError && window.onMachiNativeAudioError('empty_audio');");
                return;
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        releasePlayer();
                        stopRecognizerQuietly();

                        byte[] audioBytes = Base64.decode(base64Audio, Base64.DEFAULT);
                        String ext = (mimeType != null && (mimeType.contains("mp3") || mimeType.contains("mpeg"))) ? ".mp3" : ".wav";
                        File cacheFile = new File(getCacheDir(), "machi_tts_playback" + ext);
                        FileOutputStream fos = new FileOutputStream(cacheFile);
                        fos.write(audioBytes);
                        fos.flush();
                        fos.close();
                        Log.d(TAG, "TTS audio written: " + audioBytes.length + " bytes, mime=" + mimeType);

                        requestAudioFocus();
                        if (mAudioManager != null) {
                            int vol = mAudioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
                            Log.d(TAG, "STREAM_MUSIC volume=" + vol + "/" + mAudioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
                            if (vol == 0) {
                                evalJs("console.warn('Phone media volume is 0 - raise the volume');");
                            }
                        }

                        mMediaPlayer = new MediaPlayer();
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                            // USAGE_MEDIA so it follows the media volume slider and plays on the speaker
                            AudioAttributes attributes = new AudioAttributes.Builder()
                                .setUsage(mScoActive ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build();
                            mMediaPlayer.setAudioAttributes(attributes);
                        } else {
                            mMediaPlayer.setAudioStreamType(AudioManager.STREAM_MUSIC);
                        }

                        mMediaPlayer.setDataSource(cacheFile.getAbsolutePath());
                        mMediaPlayer.setVolume(1.0f, 1.0f);

                        mMediaPlayer.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                            @Override public void onPrepared(MediaPlayer mp) {
                                mp.start();
                                Log.d(TAG, "MediaPlayer started, duration=" + mp.getDuration() + "ms");
                                evalJs("window.onMachiNativeAudioStarted && window.onMachiNativeAudioStarted();");
                            }
                        });
                        mMediaPlayer.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                            @Override public void onCompletion(MediaPlayer mp) {
                                Log.d(TAG, "MediaPlayer completed");
                                releasePlayer();
                                abandonAudioFocus();
                                evalJs("window.onMachiNativeAudioEnded && window.onMachiNativeAudioEnded();");
                            }
                        });
                        mMediaPlayer.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                            @Override public boolean onError(MediaPlayer mp, int what, int extra) {
                                Log.e(TAG, "MediaPlayer error what=" + what + " extra=" + extra);
                                releasePlayer();
                                abandonAudioFocus();
                                evalJs("window.onMachiNativeAudioError && window.onMachiNativeAudioError('mediaplayer_" + what + "_" + extra + "');");
                                return true;
                            }
                        });
                        mMediaPlayer.prepareAsync();
                    } catch (Exception e) {
                        Log.e(TAG, "Native speak error: " + e);
                        releasePlayer();
                        evalJs("window.onMachiNativeAudioError && window.onMachiNativeAudioError(" + jsStr("speak_exception") + ");");
                    }
                }
            });
        }

        // Native Android TextToSpeech fallback (used when server audio is unavailable)
        @JavascriptInterface
        public void speakText(final String text, final String lang) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (text == null || text.trim().isEmpty()) {
                        evalJs("window.onMachiNativeTtsError && window.onMachiNativeTtsError('empty_text');");
                        return;
                    }
                    releasePlayer();
                    stopRecognizerQuietly();
                    mPendingTtsText = text;
                    mPendingTtsLang = lang;
                    mPendingTtsVoice = null;
                    if (mTts != null && mTtsReady) {
                        String t = mPendingTtsText; mPendingTtsText = null;
                        doSpeakText(t, lang, null);
                    } else {
                        ensureTts(null);
                    }
                }
            });
        }

        // Same, but with a specific phone voice picked in the app's voice list
        @JavascriptInterface
        public void speakTextWithVoice(final String text, final String lang, final String voiceName) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (text == null || text.trim().isEmpty()) {
                        evalJs("window.onMachiNativeTtsError && window.onMachiNativeTtsError('empty_text');");
                        return;
                    }
                    releasePlayer();
                    stopRecognizerQuietly();
                    mPendingTtsText = text;
                    mPendingTtsLang = lang;
                    mPendingTtsVoice = voiceName;
                    if (mTts != null && mTtsReady) {
                        String t = mPendingTtsText; mPendingTtsText = null;
                        doSpeakText(t, lang, voiceName);
                    } else {
                        ensureTts(null);
                    }
                }
            });
        }

        // The app asks for the list of voices installed on this phone
        @JavascriptInterface
        public void requestVoices() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (mTts != null && mTtsReady) pushVoicesToJs(); else ensureTts(null);
                }
            });
        }

        // Called when the conversation / mic is switched off: leave Bluetooth "call" audio and return to normal media audio
        @JavascriptInterface
        public void releaseAudioRoute() {
            runOnUiThread(new Runnable() { @Override public void run() { stopBluetoothCall(); refreshRouteLabel(); } });
        }

        @JavascriptInterface
        public void stopSpeaking() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    releasePlayer();
                    if (mTts != null && mTtsReady) { try { mTts.stop(); } catch (Exception ignored) {} }
                    abandonAudioFocus();
                }
            });
        }

        @JavascriptInterface
        public void startListening(final String language) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    releasePlayer();
                    if (!hasMicPermission()) {
                        mPendingStartListening = true;
                        mPendingListenLang = language;
                        Log.d(TAG, "requesting RECORD_AUDIO permission");
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, PERMISSION_REQUEST_CODE);
                        }
                        return;
                    }
                    // Use whichever mic is active (earbuds / wired headset / phone); Bluetooth needs call-audio routing first
                    final String lang = language;
                    routeAudioThen(new Runnable() { @Override public void run() { beginRecognition(lang); } });
                }
            });
        }

        @JavascriptInterface
        public void stopListening() {
            runOnUiThread(new Runnable() {
                @Override public void run() { stopRecognizerQuietly(); }
            });
        }

        // ---- Own microphone capture (accurate for soft voices and Bluetooth/wired mics): the audio goes to the server for transcription ----
        @JavascriptInterface
        public boolean hasCapture() { return true; }

        @JavascriptInterface
        public void startCapture(final String language) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    releasePlayer();
                    if (!hasMicPermission()) {
                        mPendingCapture = true;
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, PERMISSION_REQUEST_CODE);
                        }
                        return;
                    }
                    routeAudioThen(new Runnable() { @Override public void run() { startCaptureInternal(); } });
                }
            });
        }

        // The finished recording (16 kHz mono WAV, base64). Fetched on demand so we never push a huge string through evaluateJavascript.
        @JavascriptInterface
        public String takeCapturedAudio() {
            byte[] w = mCapturedWav;
            mCapturedWav = null;
            return w == null ? "" : Base64.encodeToString(w, Base64.NO_WRAP);
        }

        // ---- Reminders: real alarms + notifications, even when the app is closed ----
        @JavascriptInterface
        public String scheduleReminder(String id, String title, String whenMs) {
            try { return ReminderUtil.schedule(getApplicationContext(), id, title, Long.parseLong(whenMs)); }
            catch (Exception e) { Log.e(TAG, "scheduleReminder: " + e); return "error"; }
        }

        @JavascriptInterface
        public void cancelReminder(String id) { ReminderUtil.cancel(getApplicationContext(), id); }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(new Runnable() { @Override public void run() {
                try {
                    Intent i = new Intent(Build.VERSION.SDK_INT >= 26 ? Settings.ACTION_APP_NOTIFICATION_SETTINGS : Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    if (Build.VERSION.SDK_INT >= 26) i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    else i.setData(Uri.fromParts("package", getPackageName(), null));
                    startActivity(i);
                } catch (Exception e) { Log.w(TAG, "openNotificationSettings: " + e.getMessage()); }
            } });
        }

        // ---- Calling: look the name up in contacts (asks permission), then place the call. JS has already asked the user to confirm. ----
        @JavascriptInterface
        public void callContact(final String name, final String number) {
            runOnUiThread(new Runnable() { @Override public void run() { handleCall(name, number); } });
        }
    }

    // ===================== Audio routing (built-in mic / wired headset / Bluetooth earbuds) =====================
    private static boolean isBtInput(int type) { return type == 7 /* BLUETOOTH_SCO */ || type == 26 /* BLE_HEADSET */; }
    private static boolean isWiredInput(int type) { return type == 3 /* WIRED_HEADSET */ || type == 22 /* USB_HEADSET */ || type == 11 /* USB_DEVICE */; }

    private boolean btAllowed() {
        return Build.VERSION.SDK_INT < 31 || checkSelfPermission(BT_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private AudioDeviceInfo findInput(boolean bluetooth) {
        if (mAudioManager == null || Build.VERSION.SDK_INT < 23) return null;
        try {
            if (bluetooth && !btAllowed()) return null;
            for (AudioDeviceInfo d : mAudioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                int t = d.getType();
                if (bluetooth ? isBtInput(t) : isWiredInput(t)) return d;
            }
        } catch (Exception e) { Log.w(TAG, "getDevices failed: " + e.getMessage()); }
        return null;
    }

    private static String devName(AudioDeviceInfo d) {
        try { CharSequence n = d.getProductName(); return n == null ? "" : n.toString(); } catch (Exception e) { return ""; }
    }

    private String currentRouteLabel() {
        AudioDeviceInfo bt = findInput(true);
        if (bt != null) return "Bluetooth " + devName(bt);
        AudioDeviceInfo wired = findInput(false);
        if (wired != null) return "Wired headset " + devName(wired);
        return "Phone microphone";
    }

    private void refreshRouteLabel() {
        evalJs("window.onMachiNativeRoute && window.onMachiNativeRoute(" + jsStr(currentRouteLabel().trim()) + ");");
    }

    // Chooses the active input. Bluetooth earbuds only deliver their microphone in "call" (SCO / communication-device)
    // mode, so switch to that before listening; wired and built-in mics work with the normal route.
    private void routeAudioThen(final Runnable then) {
        if (mAudioManager == null || Build.VERSION.SDK_INT < 23) { then.run(); return; }
        AudioDeviceInfo bt = findInput(true);
        if (bt != null) {
            refreshRouteLabel();
            if (mScoActive) { then.run(); return; }
            startBluetoothCall(then);
        } else {
            if (mScoActive) stopBluetoothCall();
            refreshRouteLabel();
            then.run();
        }
    }

    private void startBluetoothCall(final Runnable then) {
        try {
            mAudioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= 31) {
                boolean ok = false;
                for (AudioDeviceInfo d : mAudioManager.getAvailableCommunicationDevices()) {
                    if (isBtInput(d.getType())) { ok = mAudioManager.setCommunicationDevice(d); break; }
                }
                mScoActive = ok;
                Log.d(TAG, "Bluetooth communication device set=" + ok);
                if (!ok) mAudioManager.setMode(AudioManager.MODE_NORMAL);
                mHandler.postDelayed(then, ok ? 400 : 0); // give the headset a moment to open its mic
            } else {
                mScoPending = then;
                if (mScoReceiver == null) {
                    mScoReceiver = new BroadcastReceiver() {
                        @Override public void onReceive(Context c, Intent i) {
                            int st = i.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1);
                            if (st == AudioManager.SCO_AUDIO_STATE_CONNECTED) {
                                mScoActive = true;
                                Runnable r = mScoPending; mScoPending = null;
                                if (r != null) { mHandler.removeCallbacks(r); r.run(); }
                            } else if (st == AudioManager.SCO_AUDIO_STATE_DISCONNECTED) {
                                mScoActive = false;
                            }
                        }
                    };
                    registerReceiver(mScoReceiver, new IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED));
                }
                mAudioManager.startBluetoothSco();
                mAudioManager.setBluetoothScoOn(true);
                // if the headset does not answer, listen with the normal mic rather than hang
                mHandler.postDelayed(new Runnable() { @Override public void run() {
                    Runnable r = mScoPending; mScoPending = null;
                    if (r != null) { Log.w(TAG, "SCO did not connect in time"); r.run(); }
                } }, 2500);
            }
        } catch (Exception e) {
            Log.w(TAG, "startBluetoothCall failed: " + e.getMessage());
            mScoActive = false;
            then.run();
        }
    }

    private void stopBluetoothCall() {
        if (mAudioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                mAudioManager.clearCommunicationDevice();
            } else {
                mAudioManager.stopBluetoothSco();
                mAudioManager.setBluetoothScoOn(false);
            }
            mAudioManager.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception e) { Log.w(TAG, "stopBluetoothCall: " + e.getMessage()); }
        mScoActive = false;
        mScoPending = null;
        if (mScoReceiver != null) {
            try { unregisterReceiver(mScoReceiver); } catch (Exception ignored) {}
            mScoReceiver = null;
        }
    }

    // Sends the phone's installed English / Tamil voices to the app's voice list
    private void pushVoicesToJs() {
        if (mTts == null || !mTtsReady || Build.VERSION.SDK_INT < 21) return;
        try {
            Set<Voice> all = mTts.getVoices();
            ArrayList<Voice> list = new ArrayList<Voice>();
            if (all != null) for (Voice v : all) {
                String lang = v.getLocale() == null ? "" : v.getLocale().getLanguage();
                if (lang.equals("en") || lang.equals("ta")) list.add(v);
            }
            java.util.Collections.sort(list, new java.util.Comparator<Voice>() {
                @Override public int compare(Voice a, Voice b) {
                    int ia = "in".equalsIgnoreCase(a.getLocale().getCountry()) ? 0 : 1;
                    int ib = "in".equalsIgnoreCase(b.getLocale().getCountry()) ? 0 : 1;
                    if (ia != ib) return ia - ib;
                    int c = a.getLocale().toLanguageTag().compareTo(b.getLocale().toLanguageTag());
                    return c != 0 ? c : a.getName().compareTo(b.getName());
                }
            });
            JSONArray arr = new JSONArray();
            for (Voice v : list) {
                if (arr.length() >= 12) break;
                JSONObject o = new JSONObject();
                o.put("name", v.getName());
                o.put("locale", v.getLocale().toLanguageTag());
                o.put("network", v.isNetworkConnectionRequired());
                arr.put(o);
            }
            evalJs("window.onMachiNativeVoices && window.onMachiNativeVoices(" + jsStr(arr.toString()) + ");");
        } catch (Exception e) { Log.w(TAG, "pushVoicesToJs failed: " + e.getMessage()); }
    }

    // ===================== Microphone capture (voice-activity detection lives in SpeechCapture, which is unit-tested) =====================
    private void startCaptureInternal() {
        mCaptureRunning = true;
        final int gen = ++mCaptureGen;
        final boolean sco = mScoActive;
        new Thread(new Runnable() { @Override public void run() { runCapture(gen, sco); } }, "machi-capture").start();
    }

    private void captureError(String code) {
        evalJs("window.onMachiCaptureError && window.onMachiCaptureError(" + jsStr(code) + ");");
    }

    private void runCapture(int gen, boolean sco) {
        final int SR = SpeechCapture.SAMPLE_RATE;
        AudioRecord rec = null;
        AutomaticGainControl agc = null;
        NoiseSuppressor ns = null;
        try {
            int minBuf = AudioRecord.getMinBufferSize(SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minBuf <= 0) { captureError("record_failed"); return; }
            int bufBytes = Math.max(minBuf, SR);           // ~0.5 s
            int[] sources = sco ? new int[]{MediaRecorder.AudioSource.VOICE_COMMUNICATION, MediaRecorder.AudioSource.MIC}
                                : new int[]{MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC};
            for (int src : sources) {
                try {
                    AudioRecord r = new AudioRecord(src, SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufBytes);
                    if (r.getState() == AudioRecord.STATE_INITIALIZED) { rec = r; Log.d(TAG, "capture source=" + src + " sco=" + sco); break; }
                    r.release();
                } catch (Exception e) { Log.w(TAG, "AudioRecord source " + src + " failed: " + e.getMessage()); }
            }
            if (rec == null) { captureError("record_failed"); return; }
            if (Build.VERSION.SDK_INT >= 23) {
                try {
                    AudioDeviceInfo dev = findInput(true);       // Bluetooth earbuds first,
                    if (dev == null) dev = findInput(false);     // then wired / USB headset, else the phone mic
                    if (dev != null) { rec.setPreferredDevice(dev); Log.d(TAG, "capture device=" + devName(dev) + " type=" + dev.getType()); }
                } catch (Exception e) { Log.w(TAG, "setPreferredDevice: " + e.getMessage()); }
            }
            try {
                if (AutomaticGainControl.isAvailable()) { agc = AutomaticGainControl.create(rec.getAudioSessionId()); if (agc != null) agc.setEnabled(true); }
                if (NoiseSuppressor.isAvailable()) { ns = NoiseSuppressor.create(rec.getAudioSessionId()); if (ns != null) ns.setEnabled(true); }
            } catch (Exception e) { Log.w(TAG, "audio effects: " + e.getMessage()); }

            rec.startRecording();
            if (rec.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) { captureError("record_failed"); return; }
            evalJs("window.onMachiCaptureStart && window.onMachiCaptureStart();");

            SpeechCapture cap = new SpeechCapture(900, 12000);   // 0.9 s of quiet ends your turn; 12 s of nothing = give up
            short[] frame = new short[SpeechCapture.FRAME];
            SpeechCapture.Event ev = SpeechCapture.Event.NONE;
            String reason = "cancelled";
            while (mCaptureRunning && gen == mCaptureGen) {
                int n = rec.read(frame, 0, SpeechCapture.FRAME);
                if (n <= 0) {
                    if (n == AudioRecord.ERROR_DEAD_OBJECT || n == AudioRecord.ERROR_INVALID_OPERATION) { reason = "error"; break; }
                    continue;
                }
                ev = cap.feed(frame, n, System.currentTimeMillis());
                if (ev == SpeechCapture.Event.SPEECH_START) evalJs("window.onMachiCaptureSpeech && window.onMachiCaptureSpeech();");
                else if (ev == SpeechCapture.Event.END) { reason = "ended"; break; }
                else if (ev == SpeechCapture.Event.TIMEOUT) { reason = "timeout"; break; }
            }
            if (!"ended".equals(reason)) {
                if ("timeout".equals(reason)) captureError("no_speech");
                else if ("error".equals(reason)) captureError("record_failed");
                return;                                          // cancelled: say nothing
            }
            mCapturedWav = cap.finishWav();
            Log.d(TAG, "capture done " + cap.lastDurationMs + "ms peak=" + cap.lastPeak + " gain=" + cap.lastGain + " noise=" + (int) cap.noiseLevel());
            evalJs("window.onMachiAudioReady && window.onMachiAudioReady(" + cap.lastDurationMs + ");");
        } catch (Exception e) {
            Log.e(TAG, "capture failed: " + e);
            captureError("record_failed");
        } finally {
            try { if (agc != null) agc.release(); } catch (Exception ignored) {}
            try { if (ns != null) ns.release(); } catch (Exception ignored) {}
            if (rec != null) {
                try { rec.stop(); } catch (Exception ignored) {}
                try { rec.release(); } catch (Exception ignored) {}
            }
        }
    }

    // ===================== Calling =====================
    private void callResult(String status, String detail) {
        evalJs("window.onMachiNativeCall && window.onMachiNativeCall(" + jsStr(status) + "," + jsStr(detail == null ? "" : detail) + ");");
    }

    private void handleCall(String name, String number) {
        String digits = number == null ? "" : number.replaceAll("[^0-9+]", "");
        String label = (name != null && name.trim().length() > 0) ? name.trim() : digits;
        if (digits.length() >= 5) { placeCall(digits, label); return; }
        if (name == null || name.trim().isEmpty()) { callResult("not_found", ""); return; }
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(android.Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            mPendingCallName = name.trim();
            mCallPermAsked = true;
            requestPermissions(new String[]{android.Manifest.permission.READ_CONTACTS, android.Manifest.permission.CALL_PHONE}, PERMISSION_CALL_CODE);
            return;
        }
        lookupAndCall(name.trim());
    }

    private ArrayList<String[]> findContacts(String name) {
        ArrayList<String[]> out = new ArrayList<String[]>();
        java.util.HashSet<String> seen = new java.util.HashSet<String>();
        ArrayList<String> needles = new ArrayList<String>();
        needles.add(name);
        for (String w : name.split("\\s+")) if (w.length() >= 3 && !w.equalsIgnoreCase(name)) needles.add(w);
        for (String needle : needles) {
            Cursor cur = null;
            try {
                cur = getContentResolver().query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    new String[]{ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER},
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?", new String[]{"%" + needle + "%"},
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC");
                while (cur != null && cur.moveToNext() && out.size() < 6) {
                    String n = cur.getString(0), num = cur.getString(1);
                    if (num == null) continue;
                    String key = num.replaceAll("[^0-9]", "");
                    if (key.length() > 10) key = key.substring(key.length() - 10);
                    if (seen.add(key)) out.add(new String[]{n, num});
                }
            } catch (Exception e) { Log.w(TAG, "contacts query failed: " + e.getMessage());
            } finally { if (cur != null) cur.close(); }
            if (!out.isEmpty()) break;                             // the full name matched: do not widen the search
        }
        return out;
    }

    private void lookupAndCall(String name) {
        ArrayList<String[]> found = findContacts(name);
        if (found.isEmpty()) { callResult("not_found", name); return; }
        if (found.size() > 1) {                                    // an exact-name match wins
            for (String[] f : found) if (f[0] != null && f[0].equalsIgnoreCase(name)) { found.clear(); found.add(f); break; }
        }
        if (found.size() == 1) { placeCall(found.get(0)[1], found.get(0)[0]); return; }
        try {
            JSONArray arr = new JSONArray();
            for (String[] f : found) { JSONObject o = new JSONObject(); o.put("name", f[0]); o.put("number", f[1]); arr.put(o); }
            callResult("multiple", arr.toString());
        } catch (Exception e) { callResult("error", "contacts"); }
    }

    private void placeCall(String number, String label) {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(android.Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            if (mCallPermAsked) { openDialer(number, label); return; }   // already asked and declined: open the dialer instead
            mCallPermAsked = true;
            mPendingDialNumber = number; mPendingDialLabel = label;
            requestPermissions(new String[]{android.Manifest.permission.CALL_PHONE}, PERMISSION_CALL_CODE);
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_CALL, Uri.fromParts("tel", number, null)));
            callResult("calling", label);
        } catch (Exception e) { Log.w(TAG, "ACTION_CALL failed: " + e.getMessage()); openDialer(number, label); }
    }

    private void openDialer(String number, String label) {
        try {
            startActivity(new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)));
            callResult("dialer", label);
        } catch (Exception e) { callResult("error", "dialer"); }
    }

    private void releasePlayer() {
        if (mMediaPlayer != null) {
            try { if (mMediaPlayer.isPlaying()) mMediaPlayer.stop(); } catch (Exception ignored) {}
            try { mMediaPlayer.release(); } catch (Exception ignored) {}
            mMediaPlayer = null;
        }
    }

    private void stopRecognizerQuietly() {
        mIsListening = false;
        mCaptureRunning = false;
        if (mSpeechRecognizer != null) {
            try { mSpeechRecognizer.stopListening(); } catch (Exception ignored) {}
        }
    }

    private void evalJs(final String script) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (mWebView != null) {
                    mWebView.evaluateJavascript(script, null);
                }
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (mMediaPlayer != null) {
            releasePlayer();
            abandonAudioFocus();
            evalJs("window.onMachiNativeAudioEnded && window.onMachiNativeAudioEnded();");
        }
        if (mSpeechRecognizer != null) {
            try { mSpeechRecognizer.stopListening(); } catch (Exception ignored) {}
        }
        mCaptureRunning = false;
        stopBluetoothCall();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopBluetoothCall();
        if (mRouteCallback != null && mAudioManager != null && Build.VERSION.SDK_INT >= 23) {
            try { mAudioManager.unregisterAudioDeviceCallback(mRouteCallback); } catch (Exception ignored) {}
        }
        if (mMediaPlayer != null) {
            try { mMediaPlayer.release(); } catch (Exception ignored) {}
            mMediaPlayer = null;
        }
        if (mSpeechRecognizer != null) {
            try { mSpeechRecognizer.destroy(); } catch (Exception ignored) {}
            mSpeechRecognizer = null;
        }
        if (mTts != null) {
            try { mTts.stop(); mTts.shutdown(); } catch (Exception ignored) {}
            mTts = null; mTtsReady = false;
        }
        abandonAudioFocus();
    }

    @Override
    public void onBackPressed() {
        if (mWebView != null && mWebView.canGoBack()) {
            mWebView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
