// Shared by server (sentence splitting of a streamed reply) and client (reading the SSE stream).

// Takes complete sentences out of a growing text buffer so each can be spoken as soon as it exists.
// `final` = the model finished, so flush whatever is left. Decimals like "3.5" are not sentence ends.
export function takeSentences(buffer: string, final: boolean, minLen: number = 12): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  const re = /^([\s\S]*?[.!?…]+["')\]]*)(\s+|$)/;
  for (;;) {
    const m = rest.match(re);
    if (!m) break;
    const candidate = m[1];
    const afterTerminator = m[2];
    // a sentence ending exactly at the end of the buffer might continue ("3." -> "3.5"): wait unless final
    if (!final && afterTerminator === "") break;
    // glue very short fragments ("Hi.") to the next sentence so we do not make tiny speech requests
    if (candidate.trim().length < minLen && !final) {
      const next = rest.slice(m[0].length);
      if (!next.trim()) break;
      const m2 = next.match(re);
      if (!m2 || (!final && m2[2] === "")) break;
      sentences.push((candidate + " " + m2[1]).trim());
      rest = next.slice(m2[0].length);
      continue;
    }
    sentences.push(candidate.trim());
    rest = rest.slice(m[0].length);
  }
  if (final && rest.trim()) { sentences.push(rest.trim()); rest = ""; }
  return { sentences: sentences.map(cleanForSpeech).filter(Boolean), rest };
}

export function cleanForSpeech(s: string): string {
  return s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
}

// Incremental Server-Sent-Events parser: feed it text chunks, get complete JSON events back.
export function parseSse(buffer: string): { events: any[]; rest: string } {
  const events: any[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n\n")) !== -1) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
    if (!data) continue;
    try { events.push(JSON.parse(data)); } catch { /* ignore malformed block */ }
  }
  return { events, rest };
}
