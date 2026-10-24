// Shared (server + app) logic for voice "actions": reminders, calls, yes/no confirmation, time resolution.
// Pure functions only, so they can be unit-tested without a phone or an AI.

export function looksLikeReminder(text: string): boolean {
  const t = (text || "").toLowerCase().trim();
  if (/^(what|how|why|who|explain|define|tell me about)\b/.test(t) && !/remind me/.test(t)) return false; // a question ABOUT reminders
  return /\bremind(er|ers)?\b/.test(t) || /\balarm\b/.test(t) || /\bwake me\b/.test(t) || /\btimer\b/.test(t)
    || /ninaivu\s*(paduth|vai|vachu|ootu)/.test(t) || /ninaivoot/.test(t) || /nyabaga|gnabaga|yaabagam/.test(t)
    || /நினைவூட்ட|நினைவு\s*படுத்த|ஞாபகப்படுத்|அலாரம்/.test(text || "");
}

export function looksLikeCall(text: string): boolean {
  const t = (text || "").toLowerCase().trim();
  if (looksLikeReminder(t)) return false; // "remind me to call mom" is a reminder
  if (/^(what|how|why|who|when|where|explain|tell me about|define)\b/.test(t)) return false;
  if (/\bcall(ing)?\s+(me|back|later|of duty|center|centre|function|stack|api)\b/.test(t)) return false;
  return /\b(call|phone|dial|ring)\b/.test(t) || /கூப்பிடு|அழை|போன்\s*பண்ணு/.test(text || "");
}

const YES = ["yes", "yeah", "yep", "yup", "ok", "okay", "sure", "confirm", "confirmed", "go ahead", "do it", "call", "please", "aama", "aam", "amam", "seri", "sari", "podu", "pannu", "pannunga", "pannidu", "ஆமா", "ஆம்", "சரி", "பண்ணு"];
const NO = ["no", "nope", "nah", "cancel", "stop", "dont", "don't", "do not", "wait", "never mind", "nevermind", "venam", "vendam", "vendaam", "illa", "illai", "ille", "வேண்டாம்", "இல்லை", "இல்ல"];
const norm = (s: string) => (s || "").toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
const hasWord = (text: string, list: string[]) => list.some(w => new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(text));
// short replies only, so "yes I want to know about call of duty" is not treated as a confirmation
export function isNo(text: string): boolean { const t = norm(text); return t.split(" ").length <= 6 && hasWord(t, NO); }
export function isYes(text: string): boolean { const t = norm(text); return t.split(" ").length <= 6 && !isNo(t) && hasWord(t, YES); }

export interface Extraction {
  intent?: string; title?: string | null; name?: string | null; number?: string | null;
  inMinutes?: number | null; localDateTime?: string | null;
}

export function parseJsonLoose(text: string): any | null {
  if (!text) return null;
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Turns "in 10 minutes" / "2026-10-25 17:30" (the user's LOCAL time) into an absolute epoch ms. null if unusable.
export function resolveWhen(ex: Extraction, nowMs: number, tzOffsetMin: number): number | null {
  let when: number | null = null;
  if (typeof ex.inMinutes === "number" && isFinite(ex.inMinutes) && ex.inMinutes > 0) {
    when = nowMs + Math.round(ex.inMinutes * 60000);
  } else if (typeof ex.localDateTime === "string") {
    const m = ex.localDateTime.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
    if (m) when = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - tzOffsetMin * 60000;
  }
  if (when === null || !isFinite(when)) return null;
  if (when < nowMs + 5000 || when > nowMs + 366 * 86400000) return null;
  return when;
}

const pad = (n: number) => String(n).padStart(2, "0");
// "Today 5:30 PM" / "Tomorrow 9:00 AM" / "26 Oct 6:00 PM" in the user's local time
export function formatWhen(whenMs: number, nowMs: number, tzOffsetMin: number): string {
  const d = new Date(whenMs + tzOffsetMin * 60000);
  const n = new Date(nowMs + tzOffsetMin * 60000);
  const dayDiff = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) / 86400000);
  const h24 = d.getUTCHours();
  const time = `${((h24 + 11) % 12) + 1}:${pad(d.getUTCMinutes())} ${h24 >= 12 ? "PM" : "AM"}`;
  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${time}`;
}

export function localNowString(nowMs: number, tzOffsetMin: number): string {
  const d = new Date(nowMs + tzOffsetMin * 60000);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `${days[d.getUTCDay()]} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (UTC${tzOffsetMin >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(tzOffsetMin) / 60))}:${pad(Math.abs(tzOffsetMin) % 60)})`;
}

// Did Machi's last message ask the user for a reminder time? Then a bare "5 pm" is the answer.
export function lastMachiAskedForTime(history: any[]): boolean {
  if (!Array.isArray(history)) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]?.machi;
    if (typeof m === "string" && m.trim()) return /remind/i.test(m) && /(what time|enna time|time-ku|when)/i.test(m);
  }
  return false;
}
