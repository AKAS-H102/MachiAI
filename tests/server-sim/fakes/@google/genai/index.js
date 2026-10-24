// SIMULATED Google provider. dead-flash = retired (404), slow-flash = too slow, good-flash = works but rejects
// thinkingConfig (like some real models); *-tts models = voices.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const calls = (globalThis.__calls = {});
const note = (m) => { calls[m] = (calls[m] || 0) + 1; };
const err404 = (m) => Object.assign(new Error(`{"error":{"code":404,"message":"models/${m} is no longer available"}}`), { status: 404 });
const PCM = Buffer.alloc(4800).toString("base64");
export class GoogleGenAI {
  constructor() {
    this.models = {
      list: async () => ({ async *[Symbol.asyncIterator]() {
        yield { name: "models/dead-flash", supportedActions: ["generateContent"] };
        yield { name: "models/good-flash", supportedActions: ["generateContent"] };
        yield { name: "models/gemini-9-flash-preview-tts", supportedActions: ["generateContent"] };
        yield { name: "models/embedding-001", supportedActions: ["embedContent"] };
      } }),
      generateContent: async ({ model, contents, config }) => {
        note(model);
        if (model.endsWith("tts")) {
          if (globalThis.__ttsDead || model.includes("2.5")) throw err404(model);
          return { candidates: [{ content: { parts: [{ inlineData: { data: PCM } }] } }] };
        }
        if (model === "dead-flash") throw err404(model);
        if (model === "slow-flash") { await sleep(9000); return { text: "late" }; }
        if (config?.thinkingConfig) throw Object.assign(new Error('{"error":{"code":400,"message":"thinking budget not supported"}}'), { status: 400 });
        if (globalThis.__allChatDead) throw err404(model);
        const first = contents[0]?.parts || [];
        const promptText = first[0]?.text || "";
        if (first.some(p => p.inlineData)) { globalThis.__audioCalls = (globalThis.__audioCalls || 0) + 1; return { text: globalThis.__transcript ?? "hello machi" }; }
        if (promptText.includes("Return ONLY JSON")) { globalThis.__extractCalls = (globalThis.__extractCalls || 0) + 1; globalThis.__lastExtractPrompt = promptText; return { text: JSON.stringify(globalThis.__extraction || { intent: "none" }) }; }
        if (promptText.includes("You maintain a short private memory")) { globalThis.__memPrompt = promptText; return { text: "- Name: Akash\n- Has a brother Ravi" }; }
        return { text: JSON.stringify({ reply: "Hello da machi, epdi irukka?", intent: "chat", actionData: {} }), candidates: [] };
      },
      generateContentStream: async ({ model, contents, config }) => {
        note(model);
        globalThis.__lastStreamPrompt = contents[contents.length - 1].parts[0].text;
        globalThis.__lastStreamSystem = config?.systemInstruction; globalThis.__lastStreamContents = contents;
        if (model === "dead-flash" || globalThis.__allChatDead) throw err404(model);
        if (model === "slow-flash") { await sleep(5000); }
        if (config?.thinkingConfig) throw Object.assign(new Error('{"error":{"code":400,"message":"thinking budget not supported"}}'), { status: 400 });
        const parts = ["Hey machi, thala ", "valikuthaa? ", "Konjam rest edu da. ", "Tea kudichittu relax pannu, ", "seri-ya?"];
        return { async *[Symbol.asyncIterator]() { for (const p of parts) { await sleep(150); yield { text: p, candidates: [] }; } } };
      },
    };
  }
}
