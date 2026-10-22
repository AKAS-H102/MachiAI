import express from "express";
import http from "http";
import { GoogleGenAI } from "@google/genai";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import dotenv from "dotenv";
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

const CANDIDATE_MODELS = (process.env.GEMINI_MODELS || "gemini-flash-latest,gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",").map(m => m.trim()).filter(Boolean);
const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || "12000", 10);

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
      setTimeout(() => reject(new Error(`Timeout of ${timeoutMs}ms exceeded on ${label}`)), timeoutMs)
    )
  ]);
}

async function generateGeminiContentWithFastFallback(contents: any[], baseConfig: any) {
  let lastError = null;

  for (const modelName of CANDIDATE_MODELS) {
    try {
      const config = { ...baseConfig };

      // Per-model timeout (CHAT_TIMEOUT_MS): prevents hanging if a model experiences 503 or demand spikes
      const response = await callWithTimeout(
        ai.models.generateContent({ model: modelName, contents, config }),
        CHAT_TIMEOUT_MS,
        modelName
      );

      return { response, modelUsed: modelName };
    } catch (err: any) {
      lastError = err;
      const status = err?.status || (err?.message?.includes("503") ? 503 : err?.message?.includes("429") ? 429 : "timeout");
      console.error(`[Machi] Model ${modelName} FAILED (${status}): ${String(err?.message || err).slice(0, 200)}. Trying next model.`);
    }
  }
  throw lastError;
}

app.post("/api/machi/chat", async (req, res) => {
  const startTime = Date.now();
  try {
    const { message, conversationHistory = [], languagePreference, context } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const trimmed = message.trim();
    const lower = trimmed.toLowerCase();

    // Fast-path instant intent matching (sub-millisecond latency)
    if (lower.startsWith("remind") || lower.includes("remind pannu") || lower.includes("reminder")) {
      const title = trimmed.replace(/remind me to|remind pannu|reminder/i, "").trim() || "Call Friend";
      const timeMatch = trimmed.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
      const timeStr = timeMatch ? timeMatch[0] : "In 30 minutes";
      const reply = `Okay da machi! Reminder set panniten. ${timeStr}-ku "${title}" kandippa remind panren.`;
      return res.json({
        reply,
        sentences: splitIntoSentences(reply),
        intent: "create_reminder",
        actionData: { reminderTitle: title, reminderTime: timeStr },
        latencyMs: Date.now() - startTime
      });
    }

    if (lower.includes("notification") || lower.includes("enna notification")) {
      const reply = "Hey machi, ungalukku recent-ah notifications vandhurukku. WhatsApp and messages check pannalaama?";
      return res.json({
        reply,
        sentences: splitIntoSentences(reply),
        intent: "query_notifications",
        actionData: {},
        latencyMs: Date.now() - startTime
      });
    }

    if (lower.includes("attend the call") || lower.includes("attend call") || lower.includes("pick up the call") || lower.includes("answer the call")) {
      const reply = "Seri machi, call attend panren da!";
      return res.json({
        reply,
        sentences: splitIntoSentences(reply),
        intent: "attend_call",
        actionData: {},
        latencyMs: Date.now() - startTime
      });
    }

    if (lower.includes("reject the call") || lower.includes("reject call") || lower.includes("cut pannu")) {
      const reply = "Call reject panniyachu machi.";
      return res.json({
        reply,
        sentences: splitIntoSentences(reply),
        intent: "reject_call",
        actionData: {},
        latencyMs: Date.now() - startTime
      });
    }

    if (trimmed === "Hi Machi" || trimmed === "Hey Machi" || trimmed === "Hai Machi" || trimmed === "Machi") {
      const reply = "Hey machi, sollu da! Enna help venum? Ready-ah iruken.";
      return res.json({
        reply,
        sentences: splitIntoSentences(reply),
        intent: "chat",
        actionData: {},
        latencyMs: Date.now() - startTime
      });
    }

    if (!apiKey) {
      console.error("[Machi] GEMINI_API_KEY is not set on the server - cannot call the AI provider.");
      return res.status(503).json({ error: "AI provider is not configured on the server (missing GEMINI_API_KEY)." });
    }

    const contents: any[] = [];
    if (Array.isArray(conversationHistory)) {
      for (const turn of conversationHistory.slice(-8)) {
        if (turn && typeof turn.user === "string" && turn.user.trim()) contents.push({ role: "user", parts: [{ text: turn.user.slice(0, 2000) }] });
        if (turn && typeof turn.machi === "string" && turn.machi.trim()) contents.push({ role: "model", parts: [{ text: turn.machi.slice(0, 2000) }] });
      }
      // Gemini requires the first turn to be from the user
      while (contents.length && contents[0].role !== "user") contents.shift();
    }

    const conversationContext = context ? `Context: ${JSON.stringify(context)}\n` : "";
    contents.push({ role: "user", parts: [{ text: `${conversationContext}User says: "${trimmed}"` }] });

    const needsSearch = requiresWebSearch(trimmed);
    const config: any = {
      systemInstruction: MACHI_SYSTEM_PROMPT,
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
      return res.status(502).json({ error: "The AI service is temporarily unavailable. Please retry." });
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

// Real-time streaming SSE endpoint
app.get("/api/machi/chat/stream", async (req, res) => {
  const message = req.query.message as string;
  if (!message) {
    return res.status(400).send("Message is required");
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  if (!apiKey) {
    res.write(`data: ${JSON.stringify({ error: "AI provider is not configured on the server.", done: true })}\n\n`);
    return res.end();
  }

  for (const modelName of CANDIDATE_MODELS) {
    try {
      const stream = await callWithTimeout(
        ai.models.generateContentStream({
          model: modelName,
          contents: [{ role: "user", parts: [{ text: `User: "${trimmed}". Reply directly as Machi, friendly male friend, in 2 short sentences.` }] }],
          config: {
            systemInstruction: "You are Machi, a fast, knowledgeable male friend. Answer the user directly, concisely in Tanglish/English.",
            temperature: 0.6
          }
        }),
        CHAT_TIMEOUT_MS,
        modelName
      );

      let accumulated = "";
      for await (const chunk of stream) {
        const text = chunk.text || "";
        if (text) {
          accumulated += text;
          res.write(`data: ${JSON.stringify({ chunk: text, done: false })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ done: true, fullReply: accumulated })}\n\n`);
      return res.end();
    } catch (e: any) {
      console.log(`[Machi Stream] Model ${modelName} stream exception: ${e?.message?.slice(0, 60)}, cascading...`);
    }
  }

  res.write(`data: ${JSON.stringify({ error: "The AI service is temporarily unavailable.", done: true })}\n\n`);
  return res.end();
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

async function synthesizeWithEdgeTTS(text: string, preferredVoice?: string, speechRate?: number, pitchVal?: number) {
  if (Date.now() < edgeTtsCooldownUntil) {
    return null;
  }

  const isTamilScript = /[\u0B80-\u0BFF]/.test(text);
  let targetVoice = "en-US-GuyNeural";

  if (preferredVoice === "Guy" || preferredVoice === "guy_conversational") {
    targetVoice = "en-US-GuyNeural";
  } else if (preferredVoice === "Valluvar" || isTamilScript) {
    targetVoice = "ta-IN-ValluvarNeural";
  } else if (preferredVoice === "Andrew" || preferredVoice === "andrew_conversational") {
    targetVoice = "en-US-AndrewMultilingualNeural";
  } else if (preferredVoice === "Brian" || preferredVoice === "brian_conversational") {
    targetVoice = "en-US-BrianMultilingualNeural";
  }

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

async function synthesizeWithGeminiTTS(text: string, selectedVoice: string = "Puck") {
  if (!apiKey) return null;
  const formattedText = formatConversationalText(text);
  const candidateModels = (process.env.GEMINI_TTS_MODELS || "gemini-2.5-flash-preview-tts,gemini-2.5-flash-lite-preview-tts").split(",").map(m => m.trim()).filter(Boolean);

  for (const modelName of candidateModels) {
    try {
      const response = await callWithTimeout(
        ai.models.generateContent({
          model: modelName,
          contents: [{
            role: "user",
            parts: [{
              text: formattedText
            }]
          }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: selectedVoice }
              }
            }
          }
        }),
        8000,
        modelName
      );

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        return {
          audioBase64: pcmToWavBase64(base64Audio),
          mimeType: "audio/wav",
          voice: selectedVoice,
        };
      }
    } catch (err: any) {
      console.error(`[Machi TTS] Gemini TTS ${modelName} FAILED: ${String(err?.message || err).slice(0, 160)}`);
    }
  }
  return null;
}

async function executeSpeechSynthesis(text: string, preferredVoice?: string, rate?: number, pitch?: number) {
  const cleanText = text.trim();
  const cacheKey = `${preferredVoice || "Puck"}|${rate || 1}|${pitch || 1}|${cleanText}`;

  const cached = getCachedTTS(cacheKey);
  if (cached) {
    return cached;
  }

  if (inFlightTtsRequests.has(cacheKey)) {
    return await inFlightTtsRequests.get(cacheKey);
  }

  const synthesisPromise = (async () => {
    const wantsEdgeVoice = preferredVoice === "Guy" || preferredVoice === "Andrew" || preferredVoice === "Brian" || preferredVoice === "Valluvar";

    if (wantsEdgeVoice && Date.now() >= edgeTtsCooldownUntil) {
      const edgeResult = await synthesizeWithEdgeTTS(cleanText, preferredVoice, rate, pitch);
      if (edgeResult) {
        setCachedTTS(cacheKey, edgeResult);
        return edgeResult;
      }
    }

    // Default primary: Puck neural voice
    const geminiVoice = preferredVoice === "Charon" || preferredVoice === "gemini_charon" ? "Charon" : "Puck";
    const geminiResult = await synthesizeWithGeminiTTS(cleanText, geminiVoice);
    if (geminiResult) {
      setCachedTTS(cacheKey, geminiResult);
      return geminiResult;
    }

    // High-speed fallback to Guy Neural if Gemini is busy
    if (Date.now() >= edgeTtsCooldownUntil) {
      const edgeFallback = await synthesizeWithEdgeTTS(cleanText, "en-US-GuyNeural", rate, pitch);
      if (edgeFallback) {
        setCachedTTS(cacheKey, edgeFallback);
        return edgeFallback;
      }
    }

    return null;
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
    console.log(`[Machi TTS] voice=${voice || "default"} chars=${trimmed.length} ok=${!!result}`);
    if (result) {
      return res.json(result);
    }

    return res.status(503).json({
      error: "Neural voice synthesis is temporarily busy. Please retry.",
      circuitBreakerActive: Date.now() < edgeTtsCooldownUntil
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "TTS generation failure" });
  }
});

app.get("/api/machi/status", (_req, res) => {
  res.json({
    status: "online",
    assistant: "Machi (JARVIS Fast Pipeline Edition)",
    version: "1.6.0",
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
