import express from "express";
import http from "http";
import { GoogleGenAI } from "@google/genai";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import dotenv from "dotenv";
import { hedgedRace, DeadList, errorCode } from "./lib/race.ts";
import { takeSentences, cleanForSpeech } from "./lib/stream-utils.ts";
import { looksLikeReminder, looksLikeCall, resolveWhen, formatWhen, parseJsonLoose, localNowString, lastMachiAskedForTime } from "./lib/actions.ts";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

app.use(express.json({ limit: "10mb" }));

// CORS: the APK WebView runs from a different origin than the hosted backend
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const apiKey = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({
  apiKey,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

const MACHI_SYSTEM_PROMPT = `
You are "Machi" (மச்சி), a fast, highly knowledgeable, natural, friendly male companion inspired by JARVIS.
You speak casually, warmly, and humbly like a real-life close friend/brother who happens to be remarkably smart.

CRITICAL INSTRUCTIONS FOR UNDERSTANDING QUESTIONS & SPEED:
1. UNDERSTAND THE REAL INTENT OF QUESTIONS:
   - When the user asks a question (e.g., "Tell me about Rohit Sharma", "Who is Virat Kohli?", "Explain Python", "What is ERPNext?", "Tell me today's cricket news"), ANSWER IT DIRECTLY AND KNOWLEDGEABLY!
   - NEVER respond with generic listening phrases like "I'm listening to what you are saying", "Tell me what you want me to know", or "Waiting for command" when the user is asking an actual question.
   - Keep answers concise, informative, conversational, and direct (2-3 punchy sentences for voice playback, expanding when user asks to explain in detail).

2. CASUAL MALE VOICE PERSONA:
   - Use Tamil, Tanglish (Tamil in English script), or English matching the user's language style.
   - Speak naturally: "Hey machi, Rohit Sharma Indian cricket team-oda captain and legendary opener...", "Python oru versatile programming language da...", "Seri machi, naan help panren."
   - Avoid robotic sentence patterns, excessive greetings, and corporate disclaimers.

3. REAL-TIME FACTS & VERIFIED INFORMATION:
   - If user asks for latest news, today's scores, or time-sensitive events, provide the verified current facts.
   - Never invent sports scores or dates.

4. ACTIONS & INTENTS:
   - "create_reminder": when user asks to be reminded (extract title and time).
   - "query_notifications": when user asks what messages/notifications arrived.
   - "phone_call": when user wants to call someone.
   - "attend_call" / "reject_call": when managing calls.
   - "information": for general knowledge and educational explanations.
   - "chat": for friendly conversational banter.

Always respond in valid JSON format:
{
  "reply": "Conversational, direct, knowledgeable answer to be spoken aloud by TTS (in Tanglish, English, or Tamil matching user)",
  "intent": "chat" | "information" | "create_reminder" | "query_notifications" | "phone_call" | "attend_call" | "reject_call",
  "actionData": {
    "reminderTitle": "string or null",
    "reminderTime": "human or ISO time or null",
    "contactName": "string or null",
    "phoneNumber": "string or null"
  }
}
`;

const CANDIDATE_MODELS = (process.env.GEMINI_MODELS || "gemini-3.8-flash,gemini-flash-latest,gemini-3.5-flash-lite")
  .split(",").map(m => m.trim()).filter(Boolean);
const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || "15000", 10);

function requiresWebSearch(text: string): boolean {
  const lower = text.toLowerCase();
  const searchKeywords = [
    "today", "latest", "news", "score", "match", "current",
    "weather", "live", "price", "recently", "yesterday", "who won",
    "cricket news", "ind vs", "ipl", "world cup", "schedule", "results"
  ];
  return searchKeywords.some(kw => lower.includes(kw));
}

export function splitIntoSentences(text: string): string[] {
  if (!text) return [];
  const clean = text.trim();
  // Split on sentence boundaries while keeping abbreviations like Mr., Dr., etc. reasonably intact
  const rawSentences = clean.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g);
  if (!rawSentences) return [clean];
  const results = rawSentences
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return results.length > 0 ? results : [clean];
}

// Model invocation with strict timeout to prevent 20-30s cloud latency hangs
function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`Timeout of ${timeoutMs}ms exceeded on ${label}`), { code: "timeout" })), timeoutMs)
    )
  ]);
}

function withMemory(base: string, memory: any, nowMs?: number, tzOffsetMin?: number): string {
  let out = base;
  if (typeof nowMs === "number" && isFinite(nowMs)) out += `\nCurrent date/time for the user: ${localNowString(nowMs, typeof tzOffsetMin === "number" ? tzOffsetMin : 0)}.`;
  if (typeof memory === "string" && memory.trim()) {
    out += `\nWHAT YOU REMEMBER ABOUT THE USER (from earlier conversations; use it naturally, never recite it):\n${memory.trim().slice(0, 2500)}`;
  }
  return out;
}

// ---------- Actions (reminders, calls): the AI extracts structured data; we confirm only what was really understood ----------
async function extractAction(message: string, history: any[], nowMs: number, tzOffsetMin: number) {
  const recent = (Array.isArray(history) ? history.slice(-4) : [])
    .map((t: any) => t?.user ? `User: ${String(t.user).slice(0, 200)}` : t?.machi ? `Machi: ${String(t.machi).slice(0, 200)}` : "").filter(Boolean).join("\n");
  const prompt = `Current local date/time: ${localNowString(nowMs, tzOffsetMin)}.
Recent conversation:
${recent || "(none)"}
User's latest message: "${message.slice(0, 500)}"

The user may write English, Tamil or Tanglish. Decide if the latest message asks to (a) set a reminder/alarm, or (b) phone/call a person, or neither.
Return ONLY JSON: {"intent":"create_reminder"|"call_contact"|"none","title":string|null,"inMinutes":number|null,"localDateTime":"YYYY-MM-DD HH:mm"|null,"name":string|null,"number":string|null}
- create_reminder: title = what to remind (short, e.g. "take medicine"). Give EITHER inMinutes (relative: "in 10 minutes", "after 2 hours" = 120) OR localDateTime in the user's local time (e.g. "at 5pm" today, or tomorrow if that time already passed; "tomorrow 9am"). If the time is not stated or unclear, leave both null. If the user is only answering the time asked in the conversation above, combine it with that earlier reminder.
- call_contact: name = person to call as said (e.g. "Mom", "Amma", "Ravi"); number = digits only if the user said a phone number, else null.
- none: anything else (questions, chat).`;
  const tasks = deadModels.live((await getChatModels()).slice(0, 3).map(name => ({
    name, run: () => callModel(name, [{ role: "user", parts: [{ text: prompt }] }], { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 300 })
  })));
  const r = await hedgedRace(tasks, { hedgeMs: 3500, timeoutMs: 9000, onFail: (f) => { console.error(`[Machi] action-extract ${f.name} FAILED (${f.code})`); if (f.code === "404") deadModels.mark(f.name); } });
  return parseJsonLoose((r.value as any)?.text || "");
}

export interface ActionResult { reply: string; intent: string; actionData: Record<string, any>; }
// Returns null when the message is not an action (then the normal AI conversation handles it).
async function tryAction(message: string, history: any[], nowMs: number, tzOffsetMin: number): Promise<ActionResult | null> {
  if (!apiKey) return null;
  const gate = looksLikeReminder(message) || looksLikeCall(message) || (lastMachiAskedForTime(history) && /\d|am|pm|morning|evening|night|noon|minute|hour|nimisham|mani/i.test(message));
  if (!gate) return null;
  let ex: any;
  try { ex = await extractAction(message, history, nowMs, tzOffsetMin); }
  catch (e: any) { console.warn("[Machi] action extraction failed, falling back to normal chat:", String(e?.message || e).slice(0, 120)); return null; }
  if (!ex || typeof ex !== "object") return null;

  if (ex.intent === "create_reminder") {
    const title = String(ex.title || "").trim().slice(0, 120) || "your reminder";
    const when = resolveWhen(ex, nowMs, tzOffsetMin);
    if (when === null) {
      return { reply: `Seri da! "${title}" ku enna time-ku remind pannanum? Sollu, naan set panren.`, intent: "clarify_reminder", actionData: { reminderTitle: title } };
    }
    const label = formatWhen(when, nowMs, tzOffsetMin);
    return { reply: `Seri da machi! ${label}-ku "${title}" nu remind panren.`, intent: "create_reminder", actionData: { reminderTitle: title, whenMs: when, reminderTime: label } };
  }
  if (ex.intent === "call_contact") {
    const name = String(ex.name || "").trim().slice(0, 60);
    const number = String(ex.number || "").replace(/[^\d+]/g, "").slice(0, 20);
    if (!name && !number) return null;
    const who = name || number;
    return { reply: `${who}-ku call pannattuma? "yes" nu sollu, illa "cancel" nu sollu.`, intent: "call_contact", actionData: { name, number } };
  }
  return null;
}

function buildContents(conversationHistory: any, trimmed: string, context: any, alternatives: any): any[] {
  const lower = trimmed.toLowerCase();
  const contents: any[] = [];
  if (Array.isArray(conversationHistory)) {
    for (const turn of conversationHistory.slice(-20)) {
      if (turn && typeof turn.user === "string" && turn.user.trim()) contents.push({ role: "user", parts: [{ text: turn.user.slice(0, 2000) }] });
      if (turn && typeof turn.machi === "string" && turn.machi.trim()) contents.push({ role: "model", parts: [{ text: turn.machi.slice(0, 2000) }] });
    }
    // keep the prompt bounded: drop the oldest turns once it gets long
    const size = () => contents.reduce((n, c) => n + (c.parts?.[0]?.text?.length || 0), 0);
    while (contents.length > 2 && size() > 9000) contents.shift();
    // Gemini requires the first turn to be from the user
    while (contents.length && contents[0].role !== "user") contents.shift();
  }
  const conversationContext = context ? `Context: ${JSON.stringify(context)}\n` : "";
  const alts = Array.isArray(alternatives)
    ? alternatives.filter((x: any) => typeof x === "string" && x.trim() && x.trim().toLowerCase() !== lower).slice(0, 3).map((x: string) => x.slice(0, 300))
    : [];
  const altNote = alts.length
    ? `\n(Voice input. The speech recognizer may have misheard a soft or unclear voice. Other possible transcripts: ${alts.map(a => `"${a}"`).join(" | ")}. Reply to what the user most plausibly meant.)`
    : "";
  contents.push({ role: "user", parts: [{ text: `${conversationContext}User says: "${trimmed}"${altNote}` }] });
  return contents;
}

// ---- Model discovery: ask Google which models THIS key can use, so a retired model never silently breaks chat/voice ----
let discovered: { chat: string[]; tts: string[]; at: number; error?: string } = { chat: [], tts: [], at: 0 };
const versionOf = (n: string) => parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [])[1] || "0");
async function discoverModels(force = false) {
  if (!apiKey) return discovered;
  if (!force && Date.now() - discovered.at < 30 * 60 * 1000) return discovered;
  discovered = { ...discovered, at: Date.now() }; // avoid a stampede of parallel listings
  try {
    const pager: any = await ai.models.list({ config: { pageSize: 100 } });
    const chat: string[] = [], tts: string[] = [];
    for await (const m of pager) {
      const name = String(m?.name || "").replace(/^models\//, "");
      const actions: string[] = m?.supportedActions || m?.supportedGenerationMethods || [];
      if (actions.length && !actions.includes("generateContent")) continue;
      if (/tts/i.test(name)) tts.push(name);
      else if (/flash/i.test(name) && !/(image|live|audio|embed|robot|computer|native|exp|8b|vision)/i.test(name)) chat.push(name);
    }
    const rank = (a: string, b: string) => versionOf(b) - versionOf(a) || a.length - b.length;
    discovered = { chat: chat.sort(rank), tts: tts.sort(rank), at: Date.now() };
    console.log(`[Machi] discovered models chat=[${discovered.chat.slice(0, 5).join(", ")}] tts=[${discovered.tts.slice(0, 5).join(", ")}]`);
  } catch (e: any) {
    discovered = { ...discovered, error: String(e?.message || e).slice(0, 200) };
    console.warn("[Machi] model discovery failed:", discovered.error);
  }
  return discovered;
}
const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function getChatModels(): Promise<string[]> {
  await Promise.race([discoverModels(), sleepMs(1500)]);
  const extra = discovered.chat.filter(m => !CANDIDATE_MODELS.includes(m)).slice(0, 2);
  return [...CANDIDATE_MODELS, ...extra];
}

const CHAT_HEDGE_MS = parseInt(process.env.CHAT_HEDGE_MS || "5000", 10);
// Thinking makes replies several seconds slower; chat does not need it. Set GEMINI_THINKING_BUDGET=off to disable this tweak.
const THINKING_BUDGET = process.env.GEMINI_THINKING_BUDGET ?? "0";
const deadModels = new DeadList();
const noThinkingModels = new Set<string>();

async function callModel(modelName: string, contents: any[], baseConfig: any) {
  const useThinking = THINKING_BUDGET !== "off" && !noThinkingModels.has(modelName);
  const config = useThinking ? { ...baseConfig, thinkingConfig: { thinkingBudget: parseInt(THINKING_BUDGET, 10) || 0 } } : baseConfig;
  try {
    return await ai.models.generateContent({ model: modelName, contents, config });
  } catch (err: any) {
    if (useThinking && errorCode(err) === "400" && /think/i.test(String(err?.message))) {
      noThinkingModels.add(modelName); // this model rejects the thinking setting: retry once without it, remember it
      console.warn(`[Machi] ${modelName} rejects thinkingConfig; retrying without it.`);
      return await ai.models.generateContent({ model: modelName, contents, config: baseConfig });
    }
    throw err;
  }
}

// Starts the first model; if it is slow (CHAT_HEDGE_MS) or fails, the next model starts in parallel. First good answer wins.
// Models that answered 404 (retired) are skipped for 30 minutes instead of costing time on every message.
async function generateGeminiContentWithFastFallback(contents: any[], baseConfig: any) {
  const chatModels = await getChatModels();
  const tasks = deadModels.live(chatModels.map(name => ({ name, run: () => callModel(name, contents, baseConfig) })));
  try {
    const r = await hedgedRace(tasks, {
      hedgeMs: CHAT_HEDGE_MS,
      timeoutMs: CHAT_TIMEOUT_MS,
      onFail: (f) => {
        console.error(`[Machi] Model ${f.name} FAILED (${f.code}): ${f.message}`);
        if (f.code === "404") deadModels.mark(f.name);
      },
    });
    return { response: r.value, modelUsed: r.name };
  } catch (e: any) {
    const err: any = new Error(String(e?.message || e));
    err.codes = (e?.failures || []).map((f: any) => f.code);
    throw err;
  }
}

function explainAiFailure(codes: string[] = []): string {
  if (codes.length && codes.every(c => c === "404")) return "None of the configured AI models are available to this API key (404). Set GEMINI_MODELS on the server to models your key can use.";
  if (codes.some(c => c === "401" || c === "403" || c === "400")) return "Google rejected the API key or request (" + codes.join(",") + "). Check GEMINI_API_KEY on the server.";
  if (codes.some(c => c === "429")) return "AI quota or rate limit reached (429). Wait a minute and retry.";
  if (codes.some(c => c === "503" || c === "timeout")) return "The AI model is busy or timed out (" + codes.join(",") + "). Please retry.";
  return "The AI service is temporarily unavailable. Please retry.";
}

app.post("/api/machi/chat", async (req, res) => {
  const startTime = Date.now();
  try {
    const { message, conversationHistory = [], languagePreference, context, alternatives } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const trimmed = message.trim();
    const lower = trimmed.toLowerCase();

    const nowMs = typeof req.body.nowMs === "number" ? req.body.nowMs : Date.now();
    const tzOffsetMin = typeof req.body.tzOffsetMin === "number" ? req.body.tzOffsetMin : 0;
    const action = await tryAction(trimmed, conversationHistory, nowMs, tzOffsetMin);
    if (action) {
      return res.json({ ...action, sentences: splitIntoSentences(action.reply), latencyMs: Date.now() - startTime });
    }

    if (!apiKey) {
      console.error("[Machi] GEMINI_API_KEY is not set on the server - cannot call the AI provider.");
      return res.status(503).json({ error: "AI provider is not configured on the server (missing GEMINI_API_KEY)." });
    }

    const contents = buildContents(conversationHistory, trimmed, context, alternatives);

    const needsSearch = requiresWebSearch(trimmed);
    const config: any = {
      systemInstruction: withMemory(MACHI_SYSTEM_PROMPT, req.body.memory, nowMs, tzOffsetMin),
      temperature: 0.6,
      maxOutputTokens: 1024, // headroom so 'thinking' models never return empty text
    };

    if (needsSearch) {
      config.tools = [{ googleSearch: {} }];
    } else {
      config.responseMimeType = "application/json";
    }

    let response: any;
    let modelUsed = "gemini-flash-latest";

    try {
      const result = await generateGeminiContentWithFastFallback(contents, config);
      response = result.response;
      modelUsed = result.modelUsed;
    } catch (apiErr: any) {
      console.error("[Machi] All AI models failed:", String(apiErr?.message || apiErr).slice(0, 200));
      return res.status(502).json({ error: explainAiFailure(apiErr?.codes) });
    }

    const textOutput = response.text || "";
    let parsed: any = {};
    let sources: { title: string; url: string }[] = [];

    const candidate = response.candidates?.[0];
    const groundingMetadata = candidate?.groundingMetadata;
    if (groundingMetadata?.groundingChunks) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk.web?.uri) {
          sources.push({
            title: chunk.web.title || new URL(chunk.web.uri).hostname,
            url: chunk.web.uri
          });
        }
      }
    }

    try {
      if (textOutput.trim().startsWith("{")) {
        parsed = JSON.parse(textOutput);
      } else {
        const clean = textOutput.replace(/```json|```/g, "").trim();
        parsed = JSON.parse(clean);
      }
    } catch {
      parsed = {
        reply: textOutput.trim(),
        intent: needsSearch ? "information" : "chat",
        actionData: {}
      };
    }

    const finalReply = parsed.reply || textOutput;
    if (!finalReply || !finalReply.trim()) {
      console.error(`[Machi] ${modelUsed} returned empty text`);
      return res.status(502).json({ error: "The AI service returned an empty answer. Please retry." });
    }
    console.log(`[Machi] chat ok model=${modelUsed} search=${needsSearch} ${Date.now() - startTime}ms`);
    const latencyMs = Date.now() - startTime;

    return res.json({
      reply: finalReply,
      sentences: splitIntoSentences(finalReply),
      intent: parsed.intent || (needsSearch ? "information" : "chat"),
      actionData: parsed.actionData || {},
      sources: sources.slice(0, 3),
      searchUsed: needsSearch,
      modelUsed,
      latencyMs
    });
  } catch (err: any) {
    console.error("[Machi] chat handler error:", err?.message || err);
    return res.status(500).json({ error: "Unexpected server error while generating the reply." });
  }
});

// ---------- Real-time streaming chat ----------
// Same persona as /chat but plain text, streamed. Each complete sentence is sent immediately so the app can start
// speaking after the FIRST sentence instead of waiting for the whole reply (phone-call feel).
const STREAM_FIRST_CHUNK_MS = parseInt(process.env.STREAM_FIRST_CHUNK_MS || "7000", 10);
const STREAM_SYSTEM_PROMPT = MACHI_SYSTEM_PROMPT.slice(0, MACHI_SYSTEM_PROMPT.indexOf("4. ACTIONS & INTENTS")) + `
OUTPUT FORMAT: Reply with plain spoken text ONLY - no JSON, no markdown, no bullet points, no emojis. Use 2-3 short natural sentences unless the user asks for detail. The text is read aloud, so write it exactly as it should be spoken. The user is talking by voice and the speech recognizer can mishear: answer what they most plausibly meant.`;

async function openStreamAndFirstChunk(modelName: string, contents: any[], baseConfig: any) {
  const attempt = async (config: any) => {
    const work = (async () => {
      const stream: any = await ai.models.generateContentStream({ model: modelName, contents, config });
      const it = stream[Symbol.asyncIterator]();
      const first = await it.next();
      return { it, first };
    })();
    return await callWithTimeout(work, STREAM_FIRST_CHUNK_MS, modelName);
  };
  const useThinking = THINKING_BUDGET !== "off" && !noThinkingModels.has(modelName);
  try {
    return await attempt(useThinking ? { ...baseConfig, thinkingConfig: { thinkingBudget: parseInt(THINKING_BUDGET, 10) || 0 } } : baseConfig);
  } catch (err: any) {
    if (useThinking && errorCode(err) === "400" && /think/i.test(String(err?.message))) {
      noThinkingModels.add(modelName);
      return await attempt(baseConfig);
    }
    throw err;
  }
}

interface PipelineCtx {
  send: (o: any) => void;
  gone: () => boolean;
  message: string;
  history: any[];
  context?: any;
  memory?: string;
  alternatives?: any;
  nowMs: number;
  tzOffsetMin: number;
  startTime: number;
}

async function runTextPipeline(c: PipelineCtx): Promise<void> {
  const { send, message: trimmed } = c;
  // 1) reminders / calls: AI-extracted, confirmed truthfully
  const action = await tryAction(trimmed, c.history, c.nowMs, c.tzOffsetMin);
  if (action) {
    for (const sentence of splitIntoSentences(action.reply)) send({ type: "sentence", text: sentence });
    send({ type: "done", ...action, latencyMs: Date.now() - c.startTime });
    return;
  }
  if (!apiKey) { send({ type: "error", error: "AI provider is not configured on the server (missing GEMINI_API_KEY)." }); return; }

  // 2) normal conversation, streamed sentence by sentence
  const contents = buildContents(c.history, trimmed, c.context, c.alternatives);
  const needsSearch = requiresWebSearch(trimmed);
  const config: any = { systemInstruction: withMemory(STREAM_SYSTEM_PROMPT, c.memory, c.nowMs, c.tzOffsetMin), temperature: 0.6, maxOutputTokens: 1024 };
  if (needsSearch) config.tools = [{ googleSearch: {} }];

  const models = deadModels.live((await getChatModels()).map(name => ({ name })));
  const codes: string[] = [];
  for (const { name: modelName } of models) {
    if (c.gone()) return;
    let full = "", buffer = "", emitted = 0;
    const sources: { title: string; url: string }[] = [];
    try {
      const { it, first } = await openStreamAndFirstChunk(modelName, contents, config);
      let result: any = first;
      while (!result.done) {
        const chunk = result.value;
        const piece: string = chunk?.text || "";
        for (const g of chunk?.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
          if (g.web?.uri && sources.length < 3) sources.push({ title: g.web.title || new URL(g.web.uri).hostname, url: g.web.uri });
        }
        if (piece) {
          full += piece; buffer += piece;
          const r = takeSentences(buffer, false);
          buffer = r.rest;
          for (const sentence of r.sentences) { send({ type: "sentence", text: sentence }); emitted++; }
        }
        if (c.gone()) return;
        result = await callWithTimeout(it.next(), CHAT_TIMEOUT_MS, modelName); // idle timeout between chunks
      }
      for (const sentence of takeSentences(buffer, true).sentences) { send({ type: "sentence", text: sentence }); emitted++; }
      if (!full.trim()) throw new Error("empty answer");
      console.log(`[Machi] stream ok model=${modelName} search=${needsSearch} total=${Date.now() - c.startTime}ms`);
      send({ type: "done", reply: cleanForSpeech(full), intent: needsSearch ? "information" : "chat", actionData: {}, sources, searchUsed: needsSearch, modelUsed: modelName, latencyMs: Date.now() - c.startTime });
      return;
    } catch (err: any) {
      const code = errorCode(err);
      codes.push(code);
      console.error(`[Machi] Stream model ${modelName} FAILED (${code}): ${String(err?.message || err).slice(0, 200)}`);
      if (code === "404") deadModels.mark(modelName);
      if (emitted > 0) {
        // Part of the answer was already sent (and is being spoken): end it cleanly rather than switching model mid-sentence.
        for (const sentence of takeSentences(buffer, true).sentences) send({ type: "sentence", text: sentence });
        send({ type: "done", reply: cleanForSpeech(full), intent: "chat", actionData: {}, sources, modelUsed: modelName, partial: true, latencyMs: Date.now() - c.startTime });
        return;
      }
    }
  }
  send({ type: "error", error: explainAiFailure(codes) });
}

function openSse(res: any) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  let clientGone = false;
  res.on("close", () => { if (!res.writableEnded) clientGone = true; });
  return {
    send: (o: any) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch {} },
    gone: () => clientGone,
    finish: () => { try { res.end(); } catch {} },
  };
}

const numOr = (v: any, d: number) => (typeof v === "number" && isFinite(v) ? v : d);

app.post("/api/machi/chat/stream", async (req, res) => {
  const startTime = Date.now();
  const { message, conversationHistory = [], context, alternatives, memory } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }
  const sse = openSse(res);
  try {
    await runTextPipeline({
      send: sse.send, gone: sse.gone, message: message.trim(), history: conversationHistory, context, memory, alternatives,
      nowMs: numOr(req.body.nowMs, Date.now()), tzOffsetMin: numOr(req.body.tzOffsetMin, 0), startTime,
    });
  } catch (e: any) {
    console.error("[Machi] stream handler error:", e?.message || e);
    sse.send({ type: "error", error: "Unexpected server error while generating the reply." });
  }
  sse.finish();
});

// ---------- Speech -> text on the server (Gemini understands Tamil / Tanglish / English, soft or noisy audio) ----------
async function transcribeAudio(audioBase64: string, mimeType: string, history: any[], languagePreference?: string): Promise<string> {
  const recent = (Array.isArray(history) ? history.slice(-4) : [])
    .map((t: any) => t?.user ? `User: ${String(t.user).slice(0, 150)}` : t?.machi ? `Machi: ${String(t.machi).slice(0, 150)}` : "").filter(Boolean).join("\n");
  const instruction = `Transcribe the speech in this audio exactly as spoken. The speaker may talk Tamil, English, or Tanglish (Tamil mixed with English), possibly softly, quickly or with background noise. Write Tamil words in English letters (Tanglish) the way a Tamil speaker would type them, and English words normally. Do not translate, summarise, answer, or add anything. ${languagePreference === "ta-IN" ? "The user mostly speaks Tamil." : ""}
Conversation so far (only to help you pick the right words):
${recent || "(none)"}
Output ONLY the transcript. If there is no clear human speech, output exactly: [none]`;
  const contents = [{ role: "user", parts: [{ text: instruction }, { inlineData: { mimeType: mimeType || "audio/wav", data: audioBase64 } }] }];
  const tasks = deadModels.live((await getChatModels()).slice(0, 3).map(name => ({
    name, run: () => callModel(name, contents, { temperature: 0, maxOutputTokens: 400 })
  })));
  const r = await hedgedRace(tasks, { hedgeMs: 4000, timeoutMs: 12000, onFail: (f) => { console.error(`[Machi] transcribe ${f.name} FAILED (${f.code}): ${f.message}`); if (f.code === "404") deadModels.mark(f.name); } });
  return String((r.value as any)?.text || "").replace(/^["'\s]+|["'\s]+$/g, "").trim();
}

app.post("/api/machi/voice/stream", async (req, res) => {
  const startTime = Date.now();
  const { audioBase64, mimeType, conversationHistory = [], context, memory, languagePreference } = req.body || {};
  if (!audioBase64 || typeof audioBase64 !== "string" || audioBase64.length < 200) {
    return res.status(400).json({ error: "Audio is required" });
  }
  const sse = openSse(res);
  try {
    if (!apiKey) { sse.send({ type: "error", error: "AI provider is not configured on the server (missing GEMINI_API_KEY)." }); return sse.finish(); }
    let heard = "";
    try {
      heard = await transcribeAudio(audioBase64, mimeType, conversationHistory, languagePreference);
    } catch (e: any) {
      const codes = (e?.failures || []).map((f: any) => f.code);
      console.error("[Machi] transcription failed:", codes.join(","));
      sse.send({ type: "error", error: "Could not understand the audio right now (" + explainAiFailure(codes) + ")" });
      return sse.finish();
    }
    const cleaned = heard.replace(/\[none\]/gi, "").trim();
    console.log(`[Machi] heard (${Date.now() - startTime}ms): "${cleaned.slice(0, 120)}"`);
    sse.send({ type: "heard", text: cleaned });
    if (cleaned.length < 2) { sse.send({ type: "done", noSpeech: true, reply: "", intent: "none", actionData: {}, latencyMs: Date.now() - startTime }); return sse.finish(); }
    await runTextPipeline({
      send: sse.send, gone: sse.gone, message: cleaned, history: conversationHistory, context, memory,
      nowMs: numOr(req.body.nowMs, Date.now()), tzOffsetMin: numOr(req.body.tzOffsetMin, 0), startTime,
    });
  } catch (e: any) {
    console.error("[Machi] voice handler error:", e?.message || e);
    sse.send({ type: "error", error: "Unexpected server error while processing your voice." });
  }
  sse.finish();
});

// ---------- Long-term memory: the phone keeps the notes; this call just rewrites them from recent chat ----------
app.post("/api/machi/memory", async (req, res) => {
  const { memory = "", messages = [] } = req.body || {};
  if (!apiKey) return res.status(503).json({ error: "AI provider is not configured." });
  if (!Array.isArray(messages) || messages.length === 0) return res.json({ memory: String(memory).slice(0, 2500) });
  const convo = messages.slice(-14).map((m: any) => `${m?.role === "user" ? "User" : "Machi"}: ${String(m?.text || "").slice(0, 300)}`).join("\n");
  const prompt = `You maintain a short private memory about the USER of a voice assistant so it can remember them in later conversations.
Current notes:
${String(memory).slice(0, 2500) || "(empty)"}

Recent conversation:
${convo}

Rewrite the notes: keep lasting facts (name, family/friends and who they are, job/study, places, preferences, health issues they mentioned, plans, ongoing topics) and drop small talk and one-off questions. Merge with the current notes, remove outdated or duplicate items, never invent anything. At most 14 short lines, each starting with "- ". Under 1500 characters. Output ONLY the notes.`;
  try {
    const tasks = deadModels.live((await getChatModels()).slice(0, 3).map(name => ({
      name, run: () => callModel(name, [{ role: "user", parts: [{ text: prompt }] }], { temperature: 0.2, maxOutputTokens: 700 })
    })));
    const r = await hedgedRace(tasks, { hedgeMs: 5000, timeoutMs: 15000, onFail: (f) => { if (f.code === "404") deadModels.mark(f.name); } });
    const out = String((r.value as any)?.text || "").trim().slice(0, 1800);
    return res.json({ memory: out || String(memory) });
  } catch (e: any) {
    return res.status(502).json({ error: "Memory update failed", memory: String(memory).slice(0, 2500) });
  }
});

function formatConversationalText(raw: string): string {
  let text = raw.trim();
  text = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
  text = text.replace(/\bdon['’]t\s+worry,?\s+machi\b[,.]?/gi, "Don't worry machi,");
  text = text.replace(/\bhey\s+machi\b[,.]?/gi, "Hey machi,");
  text = text.replace(/\bseri\s+machi\b[,.]?/gi, "Seri machi,");
  text = text.replace(/\bsollu\s+da\b[,.]?/gi, "sollu da,");
  text = text.replace(/\b(kavala|kavalai)\s+padatha\b[,.]?/gi, "kavala padatha,");
  text = text.replace(/\bnaan\s+help\s+panren\b[,.]?/gi, "naan help panren.");
  text = text.replace(/^machi\b[,.]?/gi, "Machi,");
  text = text.replace(/\s*([,;:])\s*/g, "$1 ");
  text = text.replace(/\s*([?!])\s*/g, "$1 ");
  text = text.replace(/\s+/g, " ").trim();
  if (!/[.!?]$/.test(text)) {
    text += ".";
  }
  return text;
}

const ttsAudioCache = new Map<string, any>();
const MAX_TTS_CACHE_SIZE = 300;

function getCachedTTS(key: string) {
  return ttsAudioCache.get(key) || null;
}

function setCachedTTS(key: string, val: any) {
  if (ttsAudioCache.size >= MAX_TTS_CACHE_SIZE) {
    const firstKey = ttsAudioCache.keys().next().value;
    if (firstKey) ttsAudioCache.delete(firstKey);
  }
  ttsAudioCache.set(key, val);
}

const inFlightTtsRequests = new Map<string, Promise<any>>();
let edgeTtsCooldownUntil = 0;

// Voices selectable in the app. Puck/Charon = Gemini neural; the rest = Microsoft Edge neural voices.
const EDGE_VOICES: Record<string, string> = {
  guy: "en-US-GuyNeural",
  andrew: "en-US-AndrewMultilingualNeural",
  brian: "en-US-BrianMultilingualNeural",
  prabhat: "en-IN-PrabhatNeural",
  valluvar: "ta-IN-ValluvarNeural",
  pallavi: "ta-IN-PallaviNeural",
};

async function synthesizeWithEdgeTTS(text: string, preferredVoice?: string, speechRate?: number, pitchVal?: number) {
  if (Date.now() < edgeTtsCooldownUntil) {
    return null;
  }

  const isTamilScript = /[\u0B80-\u0BFF]/.test(text);
  const voiceKey = (preferredVoice || "").replace(/_conversational$/i, "").toLowerCase();
  const targetVoice = EDGE_VOICES[voiceKey] || (isTamilScript ? "ta-IN-ValluvarNeural" : "en-US-GuyNeural");

  const formattedText = formatConversationalText(text);

  let rateStr = "+0%";
  if (typeof speechRate === "number" && (speechRate < 0.92 || speechRate > 1.08)) {
    const ratePct = Math.round((speechRate - 1) * 100);
    rateStr = `${ratePct >= 0 ? "+" : ""}${ratePct}%`;
  }

  let pitchStr = "+0Hz";
  if (typeof pitchVal === "number" && (pitchVal < 0.94 || pitchVal > 1.06)) {
    const pitchHz = Math.round((pitchVal - 1) * 20);
    pitchStr = `${pitchHz >= 0 ? "+" : ""}${pitchHz}Hz`;
  }

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(targetVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = await tts.toStream(formattedText, { rate: rateStr, pitch: pitchStr });

    const audioBuffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        try { tts.close(); } catch {}
        reject(new Error("Edge TTS connection timed out"));
      }, 5000);

      audioStream.on("data", (c: Buffer) => chunks.push(c));
      audioStream.on("end", () => {
        clearTimeout(timer);
        try { tts.close(); } catch {}
        resolve(Buffer.concat(chunks));
      });
      audioStream.on("error", (err: any) => {
        clearTimeout(timer);
        try { tts.close(); } catch {}
        reject(err);
      });
    });

    if (audioBuffer && audioBuffer.length > 0) {
      return {
        audioBase64: audioBuffer.toString("base64"),
        mimeType: "audio/mpeg",
        voice: targetVoice,
      };
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    if (errMsg.includes("429")) {
      edgeTtsCooldownUntil = Date.now() + 60000;
      console.warn(`[Machi TTS] Edge TTS 429 rate limit. Activated 60s cooldown.`);
    } else {
      console.warn(`[Machi TTS] Edge TTS note: ${errMsg}`);
    }
  }
  return null;
}

// Gemini Neural TTS (Voice: Puck / Charon) with 2.8s strict timeout
// Gemini TTS returns headerless 16-bit PCM @24kHz mono. Players (MediaPlayer/<audio>) cannot play that
// unless it is wrapped in a WAV container.
function pcmToWavBase64(pcmBase64: string, sampleRate = 24000, channels = 1, bits = 16): string {
  const pcm = Buffer.from(pcmBase64, "base64");
  if (pcm.length >= 4 && pcm.toString("ascii", 0, 4) === "RIFF") return pcmBase64; // already WAV
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  header.writeUInt16LE(channels * (bits / 8), 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

const TTS_MODELS = (process.env.GEMINI_TTS_MODELS || "gemini-2.5-flash-preview-tts,gemini-2.5-flash-lite-preview-tts")
  .split(",").map(m => m.trim()).filter(Boolean);
const deadTtsModels = new DeadList();
let lastTtsFailures: string[] = [];
async function getTtsModels(): Promise<string[]> {
  await Promise.race([discoverModels(), sleepMs(1500)]);
  // If GEMINI_TTS_MODELS is set it wins; otherwise models Google reports for this key go first (defaults may be retired)
  const list = process.env.GEMINI_TTS_MODELS ? [...TTS_MODELS, ...discovered.tts] : [...discovered.tts, ...TTS_MODELS];
  return Array.from(new Set(list));
}
const TTS_HEDGE_MS = parseInt(process.env.TTS_HEDGE_MS || "3500", 10);

async function geminiTtsOnce(modelName: string, text: string, voiceName: string) {
  if (!apiKey) throw Object.assign(new Error("no api key"), { code: "nokey" });
  const response: any = await ai.models.generateContent({
    model: modelName,
    contents: [{ role: "user", parts: [{ text: formatConversationalText(text) }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });
  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("Gemini TTS returned no audio");
  return { audioBase64: pcmToWavBase64(base64Audio), mimeType: "audio/wav", voice: voiceName, usedFallback: false };
}

async function executeSpeechSynthesis(text: string, preferredVoice?: string, rate?: number, pitch?: number) {
  const cleanText = text.trim();
  const cacheKey = `${preferredVoice || "Puck"}|${rate || 1}|${pitch || 1}|${cleanText}`;

  const cached = getCachedTTS(cacheKey);
  if (cached) return cached;
  if (inFlightTtsRequests.has(cacheKey)) return await inFlightTtsRequests.get(cacheKey);

  const synthesisPromise = (async () => {
    const key = (preferredVoice || "Puck").replace(/_conversational$/i, "").replace(/^gemini_/i, "").toLowerCase();
    const wantsEdge = !!EDGE_VOICES[key];
    const gemVoice = key === "charon" ? "Charon" : "Puck";

    const edgeTask = (voice: string, fallback: boolean) => ({
      name: `edge:${voice}`,
      run: async () => {
        const r = await synthesizeWithEdgeTTS(cleanText, voice, rate, pitch);
        if (!r) throw Object.assign(new Error("Edge TTS unavailable"), { code: "edge" });
        return { ...r, usedFallback: fallback };
      },
    });
    const ttsModels = (await getTtsModels()).filter(m => !deadTtsModels.isDead(m)).slice(0, 4);
    const geminiTasks = ttsModels.map(m => ({
      name: m, run: () => geminiTtsOnce(m, cleanText, gemVoice),
    }));

    // Chosen voice first. If it is slow (3.5s) or fails, the next engine starts in parallel so speech is never left silent.
    const tasks = wantsEdge
      ? [edgeTask(preferredVoice || "Guy", false), ...geminiTasks]
      : [...geminiTasks, edgeTask("en-US-GuyNeural", true)];

    try {
      const r = await hedgedRace<any>(tasks, {
        hedgeMs: TTS_HEDGE_MS,
        timeoutMs: 12000,
        onFail: (f) => {
          console.warn(`[Machi TTS] ${f.name} FAILED (${f.code}): ${f.message.slice(0, 140)}`);
          if (f.code === "404" && !f.name.startsWith("edge:")) deadTtsModels.mark(f.name);
        },
      });
      const result = r.value;
      lastTtsFailures = [];
      if (!result.usedFallback) setCachedTTS(cacheKey, result); // never cache a fallback voice
      return result;
    } catch (e: any) {
      lastTtsFailures = (e?.failures || []).map((f: any) => `${f.name}: ${f.code} ${f.message}`.slice(0, 200));
      console.error("[Machi TTS] all engines failed:", lastTtsFailures.join(" | "));
      return null;
    }
  })();

  inFlightTtsRequests.set(cacheKey, synthesisPromise);
  try {
    return await synthesisPromise;
  } finally {
    inFlightTtsRequests.delete(cacheKey);
  }
}

app.post("/api/machi/tts", async (req, res) => {
  try {
    const { text, voice, rate, pitch } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Text is required" });
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return res.status(400).json({ error: "Text cannot be empty" });
    }

    const result = await executeSpeechSynthesis(trimmed, voice, rate, pitch);
    console.log(`[Machi TTS] requested=${voice || "default"} used=${result?.voice || "none"} fallback=${!!result?.usedFallback} chars=${trimmed.length}`);
    if (result) {
      return res.json(result);
    }

    return res.status(503).json({
      error: "Neural voice synthesis is unavailable right now.",
      details: lastTtsFailures,
      circuitBreakerActive: Date.now() < edgeTtsCooldownUntil
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "TTS generation failure" });
  }
});

// ---------- Diagnostics: open /api/machi/diag in a browser to see exactly which AI / voice engines work ----------
let diagCache: { at: number; data: any } | null = null;
async function timedTest(name: string, fn: () => Promise<any>) {
  const t0 = Date.now();
  try {
    const r: any = await fn();
    const bytes = r?.audioBase64 ? Math.round(r.audioBase64.length * 0.75) : undefined;
    return { name, ok: true, ms: Date.now() - t0, ...(bytes ? { bytes } : {}) };
  } catch (e: any) {
    return { name, ok: false, ms: Date.now() - t0, code: errorCode(e), error: String(e?.message || e).slice(0, 220) };
  }
}
app.get("/api/machi/diag", async (_req, res) => {
  if (diagCache && Date.now() - diagCache.at < 60000) return res.json({ ...diagCache.data, cached: true });
  const data: any = { geminiConfigured: !!apiKey, serverTime: new Date().toISOString(), tests: [] };
  if (apiKey) {
    await discoverModels(true);
    data.discovered = { chat: discovered.chat.slice(0, 8), tts: discovered.tts.slice(0, 8), listError: discovered.error };
    data.configuredChatModels = CANDIDATE_MODELS;
    const chatList = (await getChatModels()).slice(0, 3);
    const ttsList = (await getTtsModels()).slice(0, 3);
    const jobs: Promise<any>[] = [];
    for (const m of chatList) jobs.push(timedTest(`chat:${m}`, () => callWithTimeout(callModel(m, [{ role: "user", parts: [{ text: "Say hi in one word" }] }], { maxOutputTokens: 64 }), 15000, m)));
    for (const m of ttsList) jobs.push(timedTest(`gemini-voice(Puck):${m}`, () => callWithTimeout(geminiTtsOnce(m, "Hello machi, this is a voice test.", "Puck"), 15000, m)));
    jobs.push(timedTest("edge-voice(Guy)", async () => {
      const r = await synthesizeWithEdgeTTS("Hello machi, this is a voice test.", "Guy");
      if (!r) throw new Error("Edge TTS returned nothing (cooldown after errors, or blocked) - see server logs");
      return r;
    }));
    data.tests = await Promise.all(jobs);
    const ok = (prefix: string) => data.tests.some((t: any) => t.ok && t.name.startsWith(prefix));
    data.verdict = {
      chat: ok("chat:") ? "OK" : "FAILING - no chat model answered",
      geminiVoices: ok("gemini-voice") ? "OK (Puck/Charon work)" : "FAILING - Puck/Charon unavailable; the app uses a backup voice",
      edgeVoices: ok("edge-voice") ? "OK (Guy/Andrew/Brian/Prabhat/Valluvar/Pallavi work)" : "FAILING - Edge voices unavailable from this server",
      phoneVoiceFallback: !ok("gemini-voice") && !ok("edge-voice") ? "YES - every reply will be spoken by the phone's own voice" : "no",
    };
  } else {
    data.verdict = { chat: "FAILING - GEMINI_API_KEY missing" };
  }
  diagCache = { at: Date.now(), data };
  res.json(data);
});

app.get("/api/machi/status", (_req, res) => {
  res.json({
    status: "online",
    assistant: "Machi (JARVIS Fast Pipeline Edition)",
    version: "1.7.0",
    capabilities: [
      "Sub-Second Intent Execution",
      "Pipelined Sentence TTS",
      "Low-Latency Gemini Thinking",
      "Adaptive Circuit Breakers"
    ],
    voiceProfile: "Natural Human-Like Male Voice (Locked Puck Neural)",
    geminiConfigured: !!apiKey,
    edgeTtsCircuitBreakerActive: Date.now() < edgeTtsCooldownUntil,
    serverTime: new Date().toISOString()
  });
});

app.use("/release", express.static(path.resolve(__dirname, "release")));

async function startServer() {
  discoverModels().catch(() => {});
  const isProd = process.env.NODE_ENV === "production";
  const httpServer = http.createServer(app);

  if (!isProd) {
    const { createServer } = await import("vite").then(s => {
      const e = "default";
      return (s as any)[e] && typeof (s as any)[e] === "object" && "__esModule" in (s as any)[e] ? (s as any)[e] : s;
    });
    const vite = await createServer({
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Machi Personal AI Assistant running on http://0.0.0.0:${port}`);
  });
}

startServer();
