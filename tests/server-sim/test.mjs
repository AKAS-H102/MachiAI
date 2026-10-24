process.env.GEMINI_API_KEY = "fake"; process.env.NODE_ENV = "production"; process.env.PORT = "0";
process.env.GEMINI_MODELS = "dead-flash,slow-flash,good-flash"; process.env.STREAM_FIRST_CHUNK_MS = "700"; process.env.CHAT_HEDGE_MS = "300"; process.env.TTS_HEDGE_MS = "300";
await import("./server.ts");
await new Promise(r => setTimeout(r, 400));
const R = globalThis.__routes; const handler = (m, p) => R[m].find(x => x[0] === p)[1];
let pass = 0, fail = 0; const t = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c || x === undefined ? "" : "  -> " + JSON.stringify(x))); };
function mk(body) {
  const ev = [], t0 = Date.now(); const h = {}; let ended = false, status = 200, json = null; const lis = {};
  const res = { setHeader: (k, v) => h[k] = v, flushHeaders() {}, write(s) { for (const b of s.split("\n\n").filter(Boolean)) ev.push({ t: Date.now() - t0, ...JSON.parse(b.replace(/^data: /, "")) }); },
    end() { ended = true; this.writableEnded = true; }, on(e, f) { lis[e] = f; }, writableEnded: false, status(c) { status = c; return this; }, json(o) { json = o; return this; } };
  return { req: { body }, res, ev, get status() { return status; }, get json() { return json; }, get ended() { return ended; } };
}
const stream = async (msg, extra = {}) => { const c = mk({ message: msg, ...extra }); await handler("post", "/api/machi/chat/stream")(c.req, c.res); return c; };
const tts = async (text, voice) => { const c = mk({ text, voice }); await handler("post", "/api/machi/tts")(c.req, c.res); return c; };

// ---- chat streaming ----
let c = await stream("Hello Machi, thala valikuthu da", { alternatives: ["thala valikuthu", "tala valikudhu"] });
const sents = c.ev.filter(e => e.type === "sentence"), done = c.ev.find(e => e.type === "done");
t("stream: skipped retired + slow model, answered by good-flash", done?.modelUsed === "good-flash", done);
t("stream: thinkingConfig rejected (400) -> retried without, still answered", !!done && sents.length >= 2, c.ev);
t("stream: first sentence arrives BEFORE the reply is complete", sents.length && sents[0].t < done.t - 100, { first: sents[0]?.t, done: done?.t });
t("stream: sentences joined == full reply", sents.map(s => s.text).join(" ") === done.reply, { j: sents.map(s => s.text).join(" "), r: done.reply });
t("stream: recognizer alternatives forwarded to the AI", /Other possible transcripts/.test(globalThis.__lastStreamPrompt) && /tala valikudhu/.test(globalThis.__lastStreamPrompt));
const before = { ...globalThis.__calls };
c = await stream("second message");
t("stream: retired model not retried on next message (404 cached)", (globalThis.__calls["dead-flash"] || 0) === before["dead-flash"], globalThis.__calls);
const afterFirst = c.ev.find(e => e.type === "sentence");
const modelCallsBefore = globalThis.__calls["good-flash"];
c = await stream("Any new notification da?");
t("no canned reply: notification question goes to the real AI", globalThis.__calls["good-flash"] > modelCallsBefore && c.ev.some(e => e.type === "sentence" && !/recent-ah notifications vandhurukku/.test(e.text)));
c = await stream("");   t("empty message rejected (400)", c.status === 400);
// ---- actions: reminders & calls (AI extracts, server confirms what was really understood) ----
const NOW = Date.UTC(2026, 9, 24, 6, 30), TZ = 330;
const done_ = (c) => c.ev.find(e => e.type === "done");
globalThis.__extraction = { intent: "create_reminder", title: "take medicine", inMinutes: 10 };
c = await stream("remind me to take medicine in 10 minutes", { nowMs: NOW, tzOffsetMin: TZ });
t("reminder: relative time resolved to an absolute timestamp", done_(c)?.intent === "create_reminder" && done_(c).actionData.whenMs === NOW + 600000 && done_(c).actionData.reminderTitle === "take medicine", done_(c));
t("reminder: confirmation sentence states the real time", c.ev.some(e => e.type === "sentence" && /Today 12:10 PM/.test(e.text) && /take medicine/.test(e.text)), c.ev.filter(e=>e.type==="sentence"));
globalThis.__extraction = { intent: "create_reminder", title: "call mom", inMinutes: null, localDateTime: null };
c = await stream("remind me to call mom", { nowMs: NOW, tzOffsetMin: TZ });
t("reminder without a time -> asks for the time (nothing scheduled)", done_(c)?.intent === "clarify_reminder" && !done_(c).actionData.whenMs, done_(c));
globalThis.__extraction = { intent: "create_reminder", title: "call mom", localDateTime: "2026-10-24 17:00" };
const hist = [{ user: "remind me to call mom" }, { machi: 'Seri da! "call mom" ku enna time-ku remind pannanum? Sollu, naan set panren.' }];
const ex0 = globalThis.__extractCalls || 0;
c = await stream("5 pm", { nowMs: NOW, tzOffsetMin: TZ, conversationHistory: hist });
t("follow-up '5 pm' answers the pending reminder question", done_(c)?.intent === "create_reminder" && done_(c).actionData.whenMs === Date.UTC(2026, 9, 24, 11, 30) && (globalThis.__extractCalls || 0) === ex0 + 1, done_(c));
globalThis.__extraction = { intent: "call_contact", name: "Mom", number: null };
c = await stream("call mom", { nowMs: NOW, tzOffsetMin: TZ });
t("call: returns call_contact intent needing confirmation", done_(c)?.intent === "call_contact" && done_(c).actionData.name === "Mom" && (() => { const j = c.ev.filter(e => e.type === "sentence").map(e => e.text).join(" "); return /Mom/.test(j) && /yes/i.test(j) && /cancel/i.test(j); })(), done_(c));
const ex1 = globalThis.__extractCalls;
c = await stream("what is a reminder app");
t("question ABOUT reminders is not hijacked (no extraction call)", globalThis.__extractCalls === ex1 && done_(c)?.intent === "chat");
globalThis.__extraction = { intent: "none" };
c = await stream("call of duty is fun, remind me why");
t("extraction says 'none' -> falls through to normal AI chat", done_(c)?.intent === "chat" && done_(c)?.modelUsed === "good-flash", done_(c));
// ---- memory + history reach the model ----
c = await stream("what did I tell you about my brother?", { memory: "- Name: Akash\n- Has a brother Ravi", nowMs: NOW, tzOffsetMin: TZ, conversationHistory: Array.from({ length: 30 }, (_, i) => i % 2 ? { machi: "m" + i } : { user: "u" + i }) });
t("memory + current time are given to the AI", /WHAT YOU REMEMBER/.test(globalThis.__lastStreamSystem) && /brother Ravi/.test(globalThis.__lastStreamSystem) && /Saturday 2026-10-24 12:00/.test(globalThis.__lastStreamSystem));
t("history window is 20 turns (+ the new message), starts with a user turn", globalThis.__lastStreamContents.length <= 21 && globalThis.__lastStreamContents[0].role === "user", globalThis.__lastStreamContents.length);
// ---- voice: audio -> transcript -> same pipeline ----
const voice = async (b) => { const c = mk({ audioBase64: "A".repeat(400), mimeType: "audio/wav", ...b }); await handler("post", "/api/machi/voice/stream")(c.req, c.res); return c; };
globalThis.__transcript = "Machi thala romba valikuthu da";
c = await voice({});
t("voice: 'heard' transcript is sent first, then the streamed reply", c.ev[0]?.type === "heard" && c.ev[0].text === "Machi thala romba valikuthu da" && c.ev.some(e => e.type === "sentence") && done_(c)?.modelUsed === "good-flash", c.ev.map(e=>e.type));
globalThis.__transcript = "[none]";
c = await voice({});
t("voice: silence / noise -> no reply, noSpeech flag (client just keeps listening)", c.ev[0]?.type === "heard" && c.ev[0].text === "" && done_(c)?.noSpeech === true && !c.ev.some(e => e.type === "sentence"), c.ev);
globalThis.__transcript = "remind me to drink water in 5 minutes"; globalThis.__extraction = { intent: "create_reminder", title: "drink water", inMinutes: 5 };
c = await voice({ nowMs: NOW, tzOffsetMin: TZ });
t("voice: spoken reminder request is scheduled via the same action path", done_(c)?.intent === "create_reminder" && done_(c).actionData.whenMs === NOW + 300000, done_(c));
c = await handler("post", "/api/machi/voice/stream")(mk({ audioBase64: "x" }).req, (() => { const r = mk({ audioBase64: "x" }); globalThis.__r = r; return r.res; })());
t("voice: missing/short audio rejected (400)", globalThis.__r.status === 400);
// ---- memory endpoint ----
const mm = mk({ memory: "- Name: Akash", messages: [{ role: "user", text: "my brother Ravi lives in Chennai" }, { role: "machi", text: "Nice da" }] });
await handler("post", "/api/machi/memory")(mm.req, mm.res);
t("memory: updated notes returned, current notes + conversation given to the AI", /Ravi/.test(mm.json?.memory) && /my brother Ravi lives in Chennai/.test(globalThis.__memPrompt) && /Name: Akash/.test(globalThis.__memPrompt), mm.json);
// ---- non-stream /chat fallback path ----
const cc = mk({ message: "hello" }); await handler("post", "/api/machi/chat")(cc.req, cc.res);
t("/chat fallback endpoint returns real model reply", cc.json?.reply?.startsWith("Hello da machi") && cc.json?.modelUsed === "good-flash", cc.json);
// ---- TTS ----
c = await tts("Hello machi epdi irukka", "Puck");
t("TTS Puck: served by Gemini voice (discovered TTS model), not fallback", c.json?.voice === "Puck" && c.json?.usedFallback === false && c.json.mimeType === "audio/wav", c.json && { v: c.json.voice, f: c.json.usedFallback });
c = await tts("Hello machi epdi irukka", "Guy");        t("TTS Guy -> Edge Guy voice", c.json?.voice === "en-US-GuyNeural", c.json?.voice);
c = await tts("Hello machi", "Prabhat");                t("TTS Prabhat -> en-IN-PrabhatNeural", c.json?.voice === "en-IN-PrabhatNeural", c.json?.voice);
c = await tts("வணக்கம் மச்சி", "Pallavi");              t("TTS Pallavi -> ta-IN-PallaviNeural", c.json?.voice === "ta-IN-PallaviNeural", c.json?.voice);
c = await tts("Hello machi", "Valluvar");               t("TTS Valluvar -> ta-IN-ValluvarNeural", c.json?.voice === "ta-IN-ValluvarNeural", c.json?.voice);
// Gemini voice dead -> backup voice, flagged as fallback and NOT cached
globalThis.__ttsDead = true; globalThis.__edgeCalls = 0;
c = await tts("Backup test sentence one", "Puck");
t("TTS Puck unavailable -> backup voice flagged usedFallback=true", c.json?.usedFallback === true && c.json?.voice === "en-US-GuyNeural", c.json && { v: c.json.voice, f: c.json.usedFallback });
const e1 = globalThis.__edgeCalls; c = await tts("Backup test sentence one", "Puck");
t("fallback audio is not cached (re-synthesised next time)", globalThis.__edgeCalls > e1);
// everything dead -> 503 with reasons
globalThis.__edgeFail = true;
c = await tts("Nothing works sentence", "Puck");
t("all voice engines down -> 503 with failure details (app then uses phone voice)", c.status === 503 && Array.isArray(c.json?.details) && c.json.details.length > 0, c.json);
// diag
globalThis.__edgeFail = false; globalThis.__ttsDead = false;
const d = mk({}); await handler("get", "/api/machi/diag")(d.req, d.res);
t("diag lists discovered models + verdict", d.json?.discovered?.tts?.includes("gemini-9-flash-preview-tts") && d.json?.verdict?.chat === "OK" && /OK/.test(d.json.verdict.geminiVoices), d.json?.verdict);
// all chat dead
globalThis.__allChatDead = true;
c = await stream("hello again");
const er = c.ev.find(e => e.type === "error");
t("stream: all models down -> clear error event (no fake reply)", !!er && !c.ev.some(e => e.type === "sentence"), c.ev);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
