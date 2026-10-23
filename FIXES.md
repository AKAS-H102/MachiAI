# Machi — status after round 2

## Why the problem persisted after the previous ZIP
The `release/Machi.apk` (and `Machi-Setup.exe`) inside the previous ZIP were the OLD builds. Their bundled web
assets still contained the dead AI-Studio preview URL (`ais-pre-…run.app`) and the hardcoded
"local fallback mode-la…" reply. The previous round edited source only and never rebuilt, so installing that APK
reproduced the same behaviour. Those stale binaries (and the stale bundled web assets / server bundles) are now
REMOVED from this ZIP so they cannot be installed by mistake.

A working app needs two things that this sandbox did not have: (1) a deployed HTTPS backend with a real
`GEMINI_API_KEY`, and (2) an Android SDK build. Neither could be done here, so NO new APK/EXE is included.

## Changes in this round (source)
- `server.ts`: deleted the dead canned-answer code (`KNOWLEDGE_FALLBACK`, `generateSmartFallbackReply`);
  tightened the instant-call shortcut ("pick up" matched ordinary sentences); removed the non-standard
  `speechMetadata` field from the Gemini TTS request (voice stays Puck/Charon, unchanged); chat history from the
  client is validated, capped, and must start with a user turn; context window raised 4 -> 8 messages.
- `src/App.tsx`: synchronous in-flight guard (ref) so double-tap / voice + typed sends cannot fire two requests;
  follow-up context window 4 -> 8 messages.
(Earlier round, still in place: no hardcoded URL, real error bubbles with Retry, PCM->WAV, native TTS fallback,
audio focus, mic permission handling.)

## Build / deploy (required)
1. Deploy to Render using `render.yaml`; set `GEMINI_API_KEY` in the dashboard (never in the repo).
2. Check `https://<name>.onrender.com/api/machi/status` shows `"geminiConfigured": true`.
3. `curl -X POST https://<name>.onrender.com/api/machi/chat -H 'Content-Type: application/json' -d '{"message":"Hello Machi"}'`
   (note: exactly "Hello Machi" goes to the AI; "Hi Machi" is an instant canned greeting).
4. `BACKEND_URL=https://<name>.onrender.com ./build-android.sh` (needs JDK 17+, Android build-tools, Node 20+).
5. Windows: `npm run build`, bundle `server.ts` to `staging-windows/server.cjs`, put a `.env` with
   `GEMINI_API_KEY` next to it, then compile `Machi-Setup.nsi` with NSIS. (`start_machi.bat` expects `node.exe`
   beside `server.cjs`.)
6. Android log check: `adb logcat -s Machi`.

## Test status (honest)
Executed: TypeScript syntax parse of server.ts, App.tsx, machiVoice.ts (0 errors); grep confirmed the old APK
contained the dead URL and the fallback string, and the current source contains neither.
NOT executed (no network, no API key, no Android SDK/NSIS, no device): npm install, vite build, server start,
real AI reply, follow-up context, TTS audio generation/playback, Replay Voice, microphone/STT, hands-free loop,
APK build/install, Windows installer build.

---
# Round 3: speed, voice reliability, voice picker, soft-speech recognition
Verified here: TS syntax parse of all changed files; unit tests for the model race (7/7) and TTS chunking (6/6);
MainActivity.java compiles against android.jar. NOT verified (no network/device): live Gemini/Edge calls, UI render,
APK run, microphone accuracy. See the chat summary for the checklist.
- Speed: models run as a hedged race (2nd model starts after 5s or on failure; first answer wins); retired models (404)
  are skipped for 30 min; thinking budget set to 0 (auto-retried without if the model rejects it); client allows 45s per
  attempt with one automatic retry (free Render cold start); keep-warm ping every 4 min while the app is open.
- Voice: TTS races engines (Gemini voice, then Edge backup after 3.5s or on failure); dead TTS models skipped; fallback
  voice results are never cached; client merges sentences into 1-3 requests, 20s timeout + 1 retry.
- Voice picker: always visible under the Language toggle (mobile + desktop), also in the mobile settings sheet and desktop
  sidebar. Choice is saved and previewed. Voices: Puck, Charon, Prabhat, Guy, Andrew, Brian, Valluvar, Pallavi.
- Soft speech: longer silence tolerance, 5 candidate transcripts, Tamil/English additional languages, low-confidence
  results are no longer rejected (only near-empty ones), and the alternatives are sent to the AI to resolve mishearing.
- render.yaml: CHAT_TIMEOUT_MS=25000, CHAT_HEDGE_MS=5000.
