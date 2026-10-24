import { takeSentences, parseSse, cleanForSpeech } from "../../lib/stream-utils.ts";
let f=0; const t=(n:string,c:boolean,extra?:any)=>{console.log((c?"PASS ":"FAIL ")+n+(c||!extra?"":" -> "+JSON.stringify(extra))); if(!c)f++;};
// simulate token stream arriving in tiny pieces
const full="Hey machi, thala valikuthaa? Konjam rest edu da. Pi is 3.5 approx, ok? Seri!";
let buf="", out:string[]=[], times:number[]=[];
for (let i=0;i<full.length;i+=5){ buf+=full.slice(i,i+5); const r=takeSentences(buf,false); if(r.sentences.length){ out.push(...r.sentences); times.push(i);} buf=r.rest; }
const fin=takeSentences(buf,true); out.push(...fin.sentences);
t("first sentence emitted before stream ends", times.length>0 && times[0] < full.length-10, times);
t("all text delivered, nothing lost/duplicated", out.join(" ")===full, out);
t("decimal 3.5 not split", !out.some(s=>s.endsWith("3.")), out);
t("short 'Hi.' glued to next", takeSentences("Hi. How are you doing today? ",false).sentences[0]==="Hi. How are you doing today?", takeSentences("Hi. How are you doing today? ",false));
t("final flushes unterminated tail", takeSentences("No punctuation here",true).sentences[0]==="No punctuation here");
t("not final keeps unterminated tail", takeSentences("No punctuation here",false).sentences.length===0);
t("markdown stripped", cleanForSpeech("**Hello** `x` #1")==="Hello x 1", cleanForSpeech("**Hello** `x` #1"));
// SSE
let r=parseSse('data: {"type":"sentence","text":"A"}\n\ndata: {"type":"do'); t("sse: one full event, partial kept", r.events.length===1 && r.rest.startsWith("data: {\"type\":\"do"), r);
r=parseSse(r.rest+'ne"}\n\n'); t("sse: partial completes", r.events.length===1 && r.events[0].type==="done", r);
t("sse: garbage ignored", parseSse("data: {bad\n\ndata: {\"a\":1}\n\n").events.length===1);
console.log(f?"FAILED":"ALL PASSED"); process.exit(f?1:0);
