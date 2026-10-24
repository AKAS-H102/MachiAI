import { machiVoice, isPhoneVoice, parsePhoneVoices } from "../../src/utils/machiVoice.ts";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const t=(n:string,c:boolean,x?:any)=>{c?pass++:fail++;console.log((c?"PASS ":"FAIL ")+n+(c||x===undefined?"":" -> "+JSON.stringify(x)))};
const mv:any=machiVoice; const log:string[]=[]; const t0=Date.now(); const stamp=()=>Date.now()-t0;
let speakingStates:boolean[]=[]; mv.subscribe((s:boolean)=>speakingStates.push(s));
mv.fetchAudioPayload=async(text:string,voice:string)=>{ if(voice.startsWith("phone:")) return null; await sleep(text.startsWith("One")?200:40); if(text.includes("BAD")) return null; return {base64:"x",mimeType:"audio/wav",url:"u:"+text}; };
mv.playAudio=async(p:any)=>{ log.push(`play ${p.url} @${stamp()}`); await sleep(100); return true; };
mv.fallbackBrowserTTS=async(text:string,_s:any,phone?:string)=>{ log.push(`phone[${phone||"default"}] ${text}`); await sleep(50); return true; };

// 1. sentences pushed over time (as a stream would)
let started=0,ended=0;
let s=mv.beginStream("Puck",()=>started++,()=>ended++);
s.push("One first sentence."); await sleep(30); s.push("Two second sentence."); await sleep(300); s.push("Three third sentence.");
const okAll=await s.end();
const order=log.filter(l=>l.startsWith("play")).map(l=>l.slice(5).replace(/ @\d+$/,""));
t("plays in push order", JSON.stringify(order)==='["u:One first sentence.","u:Two second sentence.","u:Three third sentence."]', order);
t("playback began after first sentence only (~200ms, not after all pushes)", parseInt(log[0].split("@")[1])<350, log[0]);
t("start/end callbacks fire once, speaking true->false", started===1&&ended===1&&speakingStates.includes(true)&&speakingStates[speakingStates.length-1]===false, speakingStates);
t("end() resolves true when all spoken", okAll===true);

// 2. server voice fails for one sentence -> phone voice speaks it, order kept
log.length=0; s=mv.beginStream("Puck");
s.push("Alpha sentence ok."); s.push("BAD sentence here."); s.push("Gamma sentence ok.");
await s.end();
t("failed sentence falls back to phone voice, order preserved", log.map(l=>l.split(" ")[0]).join()==="play,phone[default],play", log);

// 3. chosen phone voice is used for every sentence, no server calls
log.length=0; s=mv.beginStream("phone:en-in-x-end-local");
s.push("Hello there friend."); s.push("Second one here.");
await s.end();
t("phone voice id passed to native engine for each sentence", log.length===2&&log.every(l=>l.startsWith("phone[en-in-x-end-local]")), log);

// 4. cancel stops playback
log.length=0; s=mv.beginStream("Puck"); s.push("One long sentence to cancel."); await sleep(250); s.cancel(); await sleep(250);
t("cancel() stops further playback", log.filter(l=>l.startsWith("play")).length<=1);
// 5. end with nothing pushed finishes cleanly
s=mv.beginStream("Puck"); const r=await s.end(); t("empty stream ends cleanly", r===true);
t("isPhoneVoice", isPhoneVoice("phone:x")&&!isPhoneVoice("Puck"));
t("parsePhoneVoices", parsePhoneVoices('[{"name":"en-in-x-ahp-local","locale":"en-IN"}]')[0].id==="phone:en-in-x-ahp-local");
console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
