import { hedgedRace, DeadList } from "../../lib/race.ts";
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
const ok=(name:string,ms:number)=>({name,run:async()=>{await sleep(ms);return name;}});
const bad=(name:string,ms:number,msg:string)=>({name,run:async()=>{await sleep(ms);throw new Error(msg);}});
let pass=0,fail=0; const t=(n:string,c:boolean)=>{c?pass++:fail++;console.log((c?"PASS ":"FAIL ")+n)};
let s=Date.now();
let r=await hedgedRace([ok("a",50),ok("b",10)],{hedgeMs:500,timeoutMs:2000});
t("fast primary wins without hedge",r.name==="a"&&Date.now()-s<300);
s=Date.now(); r=await hedgedRace([ok("slow",3000),ok("fast",50)],{hedgeMs:200,timeoutMs:5000});
t("slow primary is hedged by 2nd model (~250ms, not 3s)",r.name==="fast"&&Date.now()-s<600);
s=Date.now(); r=await hedgedRace([bad("dead",5,'{"error":{"code":404}}'),ok("good",30)],{hedgeMs:5000,timeoutMs:2000});
t("failure immediately starts next model",r.name==="good"&&Date.now()-s<300&&r.failures[0].code==="404");
s=Date.now(); r=await hedgedRace([ok("hang",9000),ok("b",20)],{hedgeMs:5000,timeoutMs:150});
t("per-task timeout falls through to next",r.name==="b"&&r.failures[0].code==="timeout");
try{await hedgedRace([bad("x",5,"503 busy"),bad("y",5,'{"code":429}')],{hedgeMs:100,timeoutMs:500});t("all fail rejects",false)}
catch(e:any){t("all fail rejects with codes "+e.failures.map((f:any)=>f.code),e.failures.length===2&&e.failures[0].code==="503"&&e.failures[1].code==="429")}
const d=new DeadList(1000); d.mark("m1"); t("dead list skips marked",d.live([{name:"m1"},{name:"m2"}]).length===1);
d.mark("m2"); t("dead list falls back to all when all dead",d.live([{name:"m1"},{name:"m2"}]).length===2);
console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
