(() => {
"use strict";

const $ = (id) => document.getElementById(id);
const qs = (s, root=document) => root.querySelector(s);
const qsa = (s, root=document) => [...root.querySelectorAll(s)];
const LS_ACCOUNTS = "attendance_accounts_v1";
const LS_SESSION = "attendance_session_v1";
const LS_THEME = "attendance_theme_v1";
const APP_VERSION = 1;

let state = {
  username: null, account: null, date: localDateKey(new Date()), filter: "all",
  search: "", historyStart: "", historyEnd: "", calendarDate: new Date(),
  reportType: "single", deleteArmed: false, undo: [], modalAction: null
};
let toastTimer = null;

function localDateKey(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
}
function parseDateKey(k) { const [y,m,d] = k.split("-").map(Number); return new Date(y,m-1,d); }
function addDays(k,n) { const d=parseDateKey(k); d.setDate(d.getDate()+n); return localDateKey(d); }
function formatDate(k, opts={year:"numeric",month:"short",day:"numeric"}) { return parseDateKey(k).toLocaleDateString(undefined,opts); }
function monthKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;}
function escapeCsv(v){const s=String(v??"");return `"${s.replaceAll('"','""')}"`;}
function showToast(msg){const el=$("toast");el.textContent=msg;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),2600);}
function setMessage(id,msg,ok=false){const el=$(id);el.textContent=msg;el.style.color=ok?"var(--present)":"var(--absent)";}
function safeRead(key, fallback){try{const v=localStorage.getItem(key);return v===null?fallback:JSON.parse(v)}catch{return fallback}}
function safeWrite(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true}catch{return false}}
function safeRemove(key){try{localStorage.removeItem(key);return true}catch{return false}}
function getAccounts(){return safeRead(LS_ACCOUNTS,{});}
function saveAccounts(a){return safeWrite(LS_ACCOUNTS,a);}
function normalizeUser(s){return String(s||"").trim().toLowerCase();}
function usernameValid(s){return /^[\p{L}\p{N} _.-]{2,30}$/u.test(String(s||"").trim());}
function newAccount(username,salt,hash){
  return {version:APP_VERSION,username, salt, hash, people:[], attendance:{}, settings:{reportTitle:"Attendance Report",threshold:75}, lastBackup:0, createdAt:Date.now()};
}
function currentAccount(){return state.account;}

async function hashPassword(password,saltHex){
  const data=new TextEncoder().encode(saltHex+password);
  const digest=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function randomSalt(){const a=new Uint8Array(16);crypto.getRandomValues(a);return [...a].map(b=>b.toString(16).padStart(2,"0")).join("");}
function validPassword(p){return typeof p==="string"&&p.length>=6;}
function waitKey(u){return `attendance_lock_${normalizeUser(u)}`;}
function getLock(u){return safeRead(waitKey(u),{fails:0,until:0});}
function setLock(u,v){safeWrite(waitKey(u),v);}
function clearLock(u){safeRemove(waitKey(u));}
function getSession(){try{return localStorage.getItem(LS_SESSION)}catch{return null}}
function setSession(u){try{localStorage.setItem(LS_SESSION,u);return true}catch{return false}}
function clearSession(){try{localStorage.removeItem(LS_SESSION)}catch{}}

function defaultAccountRepair(a){
  if(!a||typeof a!=="object")return null;
  a.people=Array.isArray(a.people)?a.people.filter(p=>p&&typeof p.id==="string"&&typeof p.name==="string"): [];
  a.attendance=(a.attendance&&typeof a.attendance==="object")?a.attendance:{};
  a.settings=(a.settings&&typeof a.settings==="object")?a.settings:{};
  a.settings.reportTitle=String(a.settings.reportTitle||"Attendance Report").slice(0,80);
  a.settings.threshold=Math.max(0,Math.min(100,Number(a.settings.threshold??75)));
  if(!Array.isArray(a.people))a.people=[];
  return a;
}
function persistAccount(){
  const accounts=getAccounts(), key=normalizeUser(state.account.username);
  accounts[key]=state.account; saveAccounts(accounts);
  setSession(key);
}
function loadAccount(username){
  const accounts=getAccounts(), a=accounts[normalizeUser(username)];
  if(!a)return false;
  state.account=defaultAccountRepair(a);state.username=state.account.username;persistAccount();return true;
}
function randomId(){return crypto.getRandomValues(new Uint32Array(2)).join("-");}

function showAuth(){
  $("authView").classList.remove("hidden");$("mainView").classList.add("hidden");
}
function showApp(){
  $("authView").classList.add("hidden");$("mainView").classList.remove("hidden");
  $("topUsername").textContent=state.account.username;
  applyTheme(getTheme());
  renderAll();
  maybeBackupReminder();
}
function switchAuth(mode){
  const login=mode==="login";$("loginPanel").classList.toggle("hidden",!login);$("signupPanel").classList.toggle("hidden",login);
  $("loginTab").classList.toggle("active",login);$("signupTab").classList.toggle("active",!login);
  setMessage("loginMessage","");setMessage("signupMessage","");
}
function setupTheme(){
  const saved=getTheme();applyTheme(saved);
}
function getTheme(){try{return localStorage.getItem(LS_THEME)||"auto"}catch{return"auto"}}
function applyTheme(theme){
  if(theme==="auto"){document.documentElement.removeAttribute("data-theme")}
  else document.documentElement.setAttribute("data-theme",theme);
  qsa(".theme-btn").forEach(b=>b.classList.toggle("active",b.dataset.theme===theme));
  try{localStorage.setItem(LS_THEME,theme)}catch{}
}

async function signup(){
  const username=$("signupUsername").value.trim(), p=$("signupPassword").value, p2=$("signupPassword2").value;
  if(!usernameValid(username)){setMessage("signupMessage","Username must be 2–30 characters and use letters, numbers, spaces, . _ or -.");return}
  if(!validPassword(p)){setMessage("signupMessage","Password must be at least 6 characters.");return}
  if(p!==p2){setMessage("signupMessage","The passwords do not match.");return}
  const accounts=getAccounts(), key=normalizeUser(username);
  if(accounts[key]){setMessage("signupMessage","That username is already taken.");return}
  const salt=randomSalt(), hash=await hashPassword(p,salt);
  accounts[key]=newAccount(username,salt,hash);
  if(!saveAccounts(accounts)){setMessage("signupMessage","Could not save the account in this browser.");return}
  $("signupUsername").value="";$("signupPassword").value="";$("signupPassword2").value="";
  switchAuth("login");$("loginUsername").value=username;showToast("Account created. You can now log in.");
}
async function login(){
  const username=$("loginUsername").value.trim(), p=$("loginPassword").value, key=normalizeUser(username);
  const lock=getLock(username), now=Date.now();
  if(lock.until>now){setMessage("loginMessage",`Too many wrong attempts. Try again in ${Math.ceil((lock.until-now)/1000)} seconds.`);return}
  const accounts=getAccounts(), a=accounts[key];
  if(!a){setMessage("loginMessage","Username or password is incorrect.");return}
  const hash=await hashPassword(p,a.salt);
  if(hash!==a.hash){
    const fails=(lock.fails||0)+1;
    if(fails>=5){setLock(username,{fails:0,until:Date.now()+30000});setMessage("loginMessage","Too many wrong attempts. Please wait 30 seconds.");}
    else {setLock(username,{fails,until:0});setMessage("loginMessage",`Username or password is incorrect. ${5-fails} attempt(s) left.`);}
    return;
  }
  clearLock(username);state.account=defaultAccountRepair(a);state.username=a.username;persistAccount();$("loginPassword").value="";showApp();showToast("Welcome back.");
}
function logout(){persistAccount();clearSession();state.account=null;state.username=null;showAuth();switchAuth("login");showToast("Logged out.");}

function nav(page){
  qsa(".nav-tab").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  ["attendance","people","history","settings"].forEach(p=>$(p+"Page").classList.toggle("hidden",p!==page));
  if(page==="attendance")renderAttendance();
  if(page==="people")renderPeople();
  if(page==="history")renderHistory();
  if(page==="settings")renderSettings();
}
function markSaved(){ $("saveIndicator").textContent="Saved"; $("saveIndicator").style.opacity="1"; clearTimeout(markSaved.t); markSaved.t=setTimeout(()=>{$("saveIndicator").style.opacity=".6"},1800); }
function recordUndo(label, before){
  state.undo.unshift({label,before:JSON.parse(JSON.stringify(before))});if(state.undo.length>10)state.undo.pop();renderUndo();
}
function renderUndo(){
  $("undoBtn").disabled=state.undo.length===0;
  $("undoText").textContent=state.undo.length?`${state.undo[0].label} · ${state.undo.length} undo${state.undo.length>1?"s":""} available.`:"No actions to undo.";
}
function undo(){
  const item=state.undo.shift();if(!item)return;
  state.account=defaultAccountRepair(item.before);persistAccount();renderAll();showToast("Undid the last action.");
}

function attendanceForDate(date){
  const a=state.account.attendance[date];
  if(!a||typeof a!=="object")return null;
  const clean={};
  state.account.people.forEach(p=>{if(typeof a[p.id]==="boolean")clean[p.id]=a[p.id]});
  return Object.keys(clean).length?clean:null;
}
function ensureDateRecord(date){
  if(!state.account.attendance[date])state.account.attendance[date]={};
  return state.account.attendance[date];
}
function setAttendance(personId,date,present){
  const before=JSON.parse(JSON.stringify(state.account));
  const rec=ensureDateRecord(date);rec[personId]=present;
  recordUndo(`Marked ${state.account.people.find(p=>p.id===personId)?.name||"person"}`,before);
  persistAccount();renderAttendance();markSaved();
}
function bulkAttendance(present){
  const before=JSON.parse(JSON.stringify(state.account));const rec=ensureDateRecord(state.date);
  state.account.people.forEach(p=>rec[p.id]=present);
  recordUndo(present?"Marked everyone present":"Cleared everyone",before);persistAccount();renderAttendance();markSaved();
}
function attendanceStats(date){
  const people=state.account.people, rec=attendanceForDate(date);let present=0,recorded=0;
  people.forEach(p=>{if(rec&&typeof rec[p.id]==="boolean"){recorded++;if(rec[p.id])present++;}});
  return {total:people.length,present,absent:recorded-present,recorded,percentage:recorded?Math.round(present/recorded*100):0};
}
function renderSummary(){
  const s=attendanceStats(state.date);
  const items=[["Total",s.total],["Present",s.present],["Absent",s.absent],["Attendance",`${s.percentage}%`]];
  $("attendanceSummary").replaceChildren(...items.map(x=>{const d=document.createElement("div");d.className="summary-card";const n=document.createElement("div");n.className="num";n.textContent=x[1];const l=document.createElement("div");l.className="label";l.textContent=x[0];d.append(n,l);return d}));
  $("recordStatus").textContent=s.recorded>0?`● Recorded · ${s.recorded} of ${s.total} people have a saved status for this date.`:"○ Not recorded yet";
  $("recordStatus").style.color=s.recorded?"var(--present)":"var(--muted)";
}
function renderAttendance(){
  if(!state.account)return;
  $("attendanceDate").value=state.date;renderSummary();
  const rec=attendanceForDate(state.date)||{}, query=state.search.toLowerCase();
  let people=state.account.people.filter(p=>p.name.toLowerCase().includes(query));
  people=people.filter(p=>state.filter==="all"||state.filter==="present"?(state.filter==="all"||rec[p.id]===true):rec[p.id]===false);
  const list=$("attendanceList");list.replaceChildren();
  $("attendanceEmpty").classList.toggle("hidden",people.length>0);
  if(!people.length){$("attendanceEmpty").replaceChildren();const h=document.createElement("h3");h.textContent=state.account.people.length?"No matching people":"No people yet";const p=document.createElement("p");p.textContent=state.account.people.length?"Try a different search or filter.":"Go to People to add someone."; $("attendanceEmpty").append(h,p);}
  people.forEach(p=>{
    const row=document.createElement("div");row.className="person-row attendance-row";
    const cb=document.createElement("input");cb.type="checkbox";cb.className="check";cb.checked=rec[p.id]===true;cb.setAttribute("aria-label",`Mark ${p.name} present`);
    const name=document.createElement("span");name.className="person-name";name.textContent=p.name;
    const pill=document.createElement("span");pill.className="status-pill "+(cb.checked?"status-present":"status-absent");pill.textContent=cb.checked?"Present":"Absent";
    row.append(cb,name,pill);
    row.addEventListener("click",e=>{if(e.target===cb)return;cb.checked=!cb.checked;setAttendance(p.id,state.date,cb.checked)});
    cb.addEventListener("change",()=>setAttendance(p.id,state.date,cb.checked));
    list.append(row);
  });
  renderUndo();
}
function renderPeople(){
  const list=$("peopleList");list.replaceChildren();const people=state.account.people.slice().sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:"base"}));
  $("peopleEmpty").classList.toggle("hidden",people.length>0);
  people.forEach(p=>{
    const row=document.createElement("div");row.className="person-row";
    const name=document.createElement("span");name.className="person-name";name.textContent=p.name;
    const edit=document.createElement("button");edit.className="secondary";edit.textContent="Edit";edit.type="button";
    const remove=document.createElement("button");remove.className="danger-outline";remove.textContent="Remove";remove.type="button";
    edit.addEventListener("click",()=>editPerson(p.id));remove.addEventListener("click",()=>removePerson(p.id));row.append(name,edit,remove);list.append(row);
  });
}
function addPerson(name){
  name=name.trim().replace(/\s+/g," ");if(!name){showToast("Enter a name.");return false}
  if(state.account.people.some(p=>p.name.toLowerCase()===name.toLowerCase())){showToast("That person already exists.");return false}
  const before=JSON.parse(JSON.stringify(state.account));state.account.people.push({id:randomId(),name});state.account.people.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:"base"}));
  recordUndo("Added a person",before);persistAccount();renderPeople();renderAttendance();showToast(`${name} added.`);return true;
}
function editPerson(id){
  const p=state.account.people.find(x=>x.id===id);if(!p)return;
  $("modalTitle").textContent="Edit person's name";$("modalText").textContent="Type the new name below.";
  $("modalOptions").replaceChildren();
  const input=document.createElement("input");input.value=p.name;input.maxLength=80;$("modalOptions").append(input);
  $("modal").classList.remove("hidden");$("modalConfirm").classList.remove("hidden");$("modalCancel").textContent="Cancel";
  state.modalAction=()=>{
    const name=input.value.trim().replace(/\s+/g," ");
    if(!name){showToast("Name cannot be empty.");return false}
    if(state.account.people.some(x=>x.id!==id&&x.name.toLowerCase()===name.toLowerCase())){showToast("That name already exists.");return false}
    const before=JSON.parse(JSON.stringify(state.account));p.name=name;recordUndo("Edited a person's name",before);persistAccount();closeModal();renderPeople();renderAttendance();showToast("Name updated.");return true;
  };
  input.focus();
}
function removePerson(id){
  const p=state.account.people.find(x=>x.id===id);if(!p)return;
  openModal("Remove person",`Remove ${p.name}? Choose whether to keep or delete this person's past attendance.`,[{label:"Keep attendance",value:"keep"},{label:"Delete attendance",value:"delete"}]);
  state.modalAction=(choice)=>{if(!choice)return false;const before=JSON.parse(JSON.stringify(state.account));state.account.people=state.account.people.filter(x=>x.id!==id);if(choice==="delete"){Object.keys(state.account.attendance).forEach(d=>{delete state.account.attendance[d][id];if(Object.keys(state.account.attendance[d]).length===0)delete state.account.attendance[d]})}recordUndo(`Removed ${p.name}`,before);persistAccount();closeModal();renderPeople();renderAttendance();showToast(`${p.name} removed.`);return true};
}
function openModal(title,text,options=[],action=null){
  $("modalTitle").textContent=title;$("modalText").textContent=text;$("modalOptions").replaceChildren();$("modal").classList.remove("hidden");state.modalAction=action;
  options.forEach((o,i)=>{const b=document.createElement("button");b.type="button";b.textContent=o.label;b.dataset.value=o.value;b.addEventListener("click",()=>{qsa(".modal-options button").forEach(x=>x.classList.remove("selected"));b.classList.add("selected")});$("modalOptions").append(b);if(i===0)b.classList.add("selected")});
  $("modalConfirm").textContent=options.length?"Confirm":"Confirm";
}
function closeModal(){$("modal").classList.add("hidden");state.modalAction=null}
function modalConfirm(){if(!state.modalAction){closeModal();return}const selected=qs(".modal-options button.selected");const val=selected?.dataset.value;const done=state.modalAction(val);if(done!==false&&state.modalAction)closeModal()}

function addDaysRange(start,end){
  const out=[];let d=parseDateKey(start), last=parseDateKey(end);if(d>last)return out;
  while(d<=last){out.push(localDateKey(d));d.setDate(d.getDate()+1)}return out;
}
function recordedDates(start,end){
  const dates=Object.keys(state.account.attendance).filter(d=>state.account.attendance[d]&&Object.keys(state.account.attendance[d]).length);
  return dates.filter(d=>(!start||d>=start)&&(!end||d<=end)).sort();
}
function personMetrics(person,start,end){
  const dates=recordedDates(start,end), present=dates.filter(d=>state.account.attendance[d]?.[person.id]===true).length;
  return {daysPresent:present,daysRecorded:dates.filter(d=>typeof state.account.attendance[d]?.[person.id]==="boolean").length,percentage:dates.filter(d=>typeof state.account.attendance[d]?.[person.id]==="boolean").length?Math.round(present/dates.filter(d=>typeof state.account.attendance[d]?.[person.id]==="boolean").length*100):0};
}
function streaks(person){
  const dates=recordedDates("", "").filter(d=>state.account.attendance[d]?.[person.id]===true).sort();
  let longest=0,current=0,run=0,prev=null;
  dates.forEach(d=>{if(prev&&addDays(prev,1)===d)run++;else run=1;longest=Math.max(longest,run);prev=d});
  let cursor=localDateKey(new Date());while(state.account.attendance[cursor]?.[person.id]===true){current++;cursor=addDays(cursor,-1)}
  return {current,longest};
}
function renderHistory(){
  if(!state.account)return;
  if(!$("historyStart").value){const d=new Date();d.setMonth(d.getMonth(),1);$("historyStart").value=localDateKey(d)}
  if(!$("historyEnd").value)$("historyEnd").value=localDateKey(new Date());
  state.historyStart=$("historyStart").value;state.historyEnd=$("historyEnd").value;
  const grid=$("historyPeople");grid.replaceChildren();const threshold=state.account.settings.threshold;
  state.account.people.forEach(p=>{const m=personMetrics(p,state.historyStart,state.historyEnd), st=streaks(p);const c=document.createElement("div");c.className="history-card"+(m.daysRecorded&&m.percentage<threshold?" below":"");
    const head=document.createElement("div");head.className="history-head";const n=document.createElement("strong");n.textContent=p.name;const per=document.createElement("strong");per.textContent=`${m.percentage}%`;head.append(n,per);
    const bar=document.createElement("div");bar.className="progress";const fill=document.createElement("span");fill.style.width=`${Math.min(100,m.percentage)}%`;bar.append(fill);
    const stats=document.createElement("div");stats.className="stats-line";[`${m.daysPresent} present`,`${m.daysRecorded} days recorded`,`Current streak: ${st.current}`,`Longest: ${st.longest}`].forEach(t=>{const s=document.createElement("span");s.textContent=t;stats.append(s)});
    c.append(head,bar,stats);c.addEventListener("click",()=>showPersonDetail(p.id));grid.append(c);
  });
  drawChart();renderCalendar();renderHints();
}
function showPersonDetail(id){
  const p=state.account.people.find(x=>x.id===id);if(!p)return;
  const dates=recordedDates(state.historyStart,state.historyEnd);const st=streaks(p),m=personMetrics(p,state.historyStart,state.historyEnd);
  let lines=dates.filter(d=>typeof state.account.attendance[d]?.[id]==="boolean").map(d=>`${formatDate(d)} — ${state.account.attendance[d][id]?"Present":"Absent"}`).join("\n");
  openModal(p.name,`${m.percentage}% · Current streak ${st.current} · Longest streak ${st.longest}\n\n${lines||"No recorded dates in this range."}`);
  $("modalOptions").replaceChildren();$("modalConfirm").classList.add("hidden");$("modalCancel").textContent="Close";
  state.modalAction=null;
}
function drawChart(){
  const canvas=$("attendanceChart"), ctx=canvas.getContext("2d"), dpr=devicePixelRatio||1,w=canvas.clientWidth||600,h=240;
  canvas.width=w*dpr;canvas.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
  const dates=recordedDates(state.historyStart,state.historyEnd).slice(-30), vals=dates.map(d=>attendanceStats(d).percentage);
  $("chartEmpty").classList.toggle("hidden",dates.length>0);if(!dates.length)return;
  ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue("--border");ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue("--muted");ctx.font="11px system-ui";
  [0,25,50,75,100].forEach(v=>{const y=h-25-(v/100)*(h-45);ctx.beginPath();ctx.moveTo(36,y);ctx.lineTo(w-10,y);ctx.stroke();ctx.fillText(`${v}%`,4,y+4)});
  ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue("--accent");ctx.lineWidth=2;ctx.beginPath();
  vals.forEach((v,i)=>{const x=42+(i/(Math.max(1,vals.length-1)))*(w-55),y=h-25-(v/100)*(h-45);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();
  ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue("--accent");vals.forEach((v,i)=>{const x=42+(i/(Math.max(1,vals.length-1)))*(w-55),y=h-25-(v/100)*(h-45);ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill()});
}
function renderCalendar(){
  const d=state.calendarDate,y=d.getFullYear(),m=d.getMonth();$("calendarTitle").textContent=d.toLocaleDateString(undefined,{month:"long",year:"numeric"});
  const grid=$("calendarGrid");grid.replaceChildren();const first=new Date(y,m,1),last=new Date(y,m+1,0),start=first.getDay();
  for(let i=0;i<start;i++){const e=document.createElement("div");e.className="cal-day muted-day";grid.append(e)}
  for(let day=1;day<=last.getDate();day++){const k=localDateKey(new Date(y,m,day)),e=document.createElement("button");e.type="button";e.className="cal-day";if(k===localDateKey(new Date()))e.classList.add("today");const s=attendanceStats(k);if(s.recorded)e.classList.add("recorded");
    const n=document.createElement("span");n.className="day-number";n.textContent=day;e.append(n);if(s.recorded){const c=document.createElement("span");c.className="count";c.textContent=`${s.present} present`;e.append(c)}e.addEventListener("click",()=>{state.date=k;nav("attendance")});grid.append(e)}
}
function renderHints(){
  const box=$("weekdayHints");box.replaceChildren();const h=document.createElement("h3");h.textContent="Recent weekdays without a record";box.append(h);
  const ul=document.createElement("ul"), today=new Date();let found=0;
  for(let i=0;i<21&&found<5;i++){const d=new Date(today);d.setDate(today.getDate()-i);if(d.getDay()===0||d.getDay()===6)continue;const k=localDateKey(d);if(!state.account.attendance[k]||Object.keys(state.account.attendance[k]).length===0){const li=document.createElement("li");li.textContent=formatDate(k,{weekday:"short",month:"short",day:"numeric"});ul.append(li);found++}}
  if(!found){const p=document.createElement("p");p.className="muted";p.textContent="No recent weekday gaps found.";box.append(p)}else box.append(ul);
}

function renderSettings(){
  $("reportTitle").value=state.account.settings.reportTitle;$("threshold").value=state.account.settings.threshold;
  $("pdfSingleDate").value=state.date;$("pdfStart").value=state.historyStart||state.date;$("pdfEnd").value=state.historyEnd||state.date;
  qsa(".report-type").forEach(b=>b.classList.toggle("active",b.dataset.reportType===state.reportType));
  $("singleReportBox").classList.toggle("hidden",state.reportType!=="single");$("rangeReportBox").classList.toggle("hidden",state.reportType!=="range");
  $("deleteConfirm").classList.toggle("hidden",!state.deleteArmed);
  setMessage("pdfMessage","");setMessage("backupMessage","");setMessage("passwordMessage","");
}
function saveSettings(){
  const title=$("reportTitle").value.trim().replace(/\s+/g," ")||"Attendance Report", threshold=Math.max(0,Math.min(100,Number($("threshold").value)));
  state.account.settings.reportTitle=title;state.account.settings.threshold=threshold;persistAccount();renderHistory();showToast("Settings saved.");
}
function maybeBackupReminder(){
  const last=Number(state.account.lastBackup||0);if(!last||Date.now()-last>14*86400000)showToast("Reminder: download a backup in Settings.");
}

function exportBlob(filename,content,type){
  const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function backupData(){return {app:"Attendance",version:APP_VERSION,exportedAt:new Date().toISOString(),account:JSON.parse(JSON.stringify(state.account))}}
function exportBackup(){
  exportBlob(`attendance-backup-${localDateKey(new Date())}.json`,JSON.stringify(backupData(),null,2),"application/json");
  state.account.lastBackup=Date.now();persistAccount();setMessage("backupMessage","Backup downloaded.",true);showToast("Backup downloaded.");
}
function validateBackup(data){
  const a=data?.account;if(!a||typeof a!=="object"||typeof a.username!=="string"||!Array.isArray(a.people)||!a.attendance||typeof a.attendance!=="object"||!a.settings)return false;
  if(!a.salt||!a.hash)return false;
  if(a.people.some(p=>!p||typeof p.id!=="string"||typeof p.name!=="string"))return false;
  for(const [d,r] of Object.entries(a.attendance)){if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||typeof r!=="object")return false;for(const [id,v] of Object.entries(r))if(typeof v!=="boolean")return false}
  return true;
}
function importBackup(file){
  const reader=new FileReader();reader.onload=()=>{
    try{const data=JSON.parse(reader.result);if(!validateBackup(data)){setMessage("backupMessage","Invalid backup file.");return}
      openModal("Replace current data?",`This will replace ${state.account.username}'s people, attendance and settings with the backup.`,[{label:"Replace data",value:"replace"}]);
      state.modalAction=(choice)=>{if(choice!=="replace")return false;const accounts=getAccounts(),key=normalizeUser(state.account.username);const imported=defaultAccountRepair(data.account);imported.username=state.account.username;imported.salt=state.account.salt;imported.hash=state.account.hash;accounts[key]=imported;if(!saveAccounts(accounts)){showToast("Could not save the imported data.");return false}state.account=imported;persistAccount();closeModal();renderAll();setMessage("backupMessage","Backup imported.",true);showToast("Backup imported.");return true};
    }catch{setMessage("backupMessage","Could not read that JSON file.");}
  };reader.readAsText(file);$("importBackupInput").value="";
}
function exportCsv(){
  const dates=recordedDates("","");let rows=[["Name",...dates.map(d=>formatDate(d,{year:"numeric",month:"2-digit",day:"2-digit"})),"Days Present","Days Recorded","Percentage"]];
  state.account.people.forEach(p=>{const vals=dates.map(d=>typeof state.account.attendance[d]?.[p.id]==="boolean"?(state.account.attendance[d][p.id]?"Present":"Absent"):"");const m=personMetrics(p,"","");rows.push([p.name,...vals,m.daysPresent,m.daysRecorded,`${m.percentage}%`])});
  exportBlob(`attendance-${localDateKey(new Date())}.csv`,rows.map(r=>r.map(escapeCsv).join(",")).join("\r\n"),"text/csv;charset=utf-8");showToast("CSV downloaded.");
}
function reportDates(){
  if(state.reportType==="single")return {start:$("pdfSingleDate").value,end:$("pdfSingleDate").value};
  if(state.reportType==="range")return {start:$("pdfStart").value,end:$("pdfEnd").value};
  const d=new Date();return {start:localDateKey(new Date(d.getFullYear(),d.getMonth(),1)),end:localDateKey(new Date(d.getFullYear(),d.getMonth()+1,0))};
}
function generatePdf(){
  const lib=window.jspdf?.jsPDF;if(!lib){setMessage("pdfMessage","PDF library failed to load. Use Print as a fallback.");return}
  const {start,end}=reportDates();if(!start||!end||start>end){setMessage("pdfMessage","Choose a valid date or date range.");return}
  const doc=new lib({orientation:"portrait",unit:"mm",format:"a4"}), title=state.account.settings.reportTitle;
  doc.setFontSize(18);doc.text(title,14,16);doc.setFontSize(10);doc.text(`Account: ${state.account.username}`,14,23);doc.text(`Period: ${start===end?formatDate(start):`${formatDate(start)} – ${formatDate(end)}`}`,14,29);doc.text(`Generated: ${new Date().toLocaleString()}`,14,35);
  const dates=recordedDates(start,end), body=[];
  if(start===end){
    const rec=attendanceForDate(start)||{};state.account.people.forEach(p=>body.push([p.name,rec[p.id]===true?"Present":rec[p.id]===false?"Absent":"Not recorded"]));
    const s=attendanceStats(start);doc.autoTable({startY:41,head:[["Person","Status"]],body,theme:"grid",styles:{fontSize:9},headStyles:{fillColor:[22,138,97]},didDrawPage:()=>{doc.setFontSize(8);doc.text(`Page ${doc.internal.getNumberOfPages()}`,190,290,{align:"right"})}});
    let y=doc.lastAutoTable.finalY+9;doc.setFontSize(10);doc.text(`Total: ${s.total}    Present: ${s.present}    Absent: ${s.absent}    Recorded: ${s.recorded}    Attendance: ${s.percentage}%`,14,y);
  }else{
    state.account.people.forEach(p=>{const m=personMetrics(p,start,end);body.push([p.name,m.daysPresent,m.daysRecorded-m.daysPresent,m.daysRecorded,`${m.percentage}%`])});
    const overallDates=dates, totalPossible=state.account.people.length*overallDates.length,totalPresent=overallDates.reduce((sum,d)=>sum+state.account.people.filter(p=>state.account.attendance[d]?.[p.id]===true).length,0);
    const totalRecorded=overallDates.reduce((sum,d)=>sum+state.account.people.filter(p=>typeof state.account.attendance[d]?.[p.id]==="boolean").length,0), totalAbsent=totalRecorded-totalPresent, pct=totalRecorded?Math.round(totalPresent/totalRecorded*100):0;
    doc.autoTable({startY:41,head:[["Person","Days present","Days absent","Days recorded","Percentage"]],body,theme:"grid",styles:{fontSize:9},headStyles:{fillColor:[22,138,97]},didDrawPage:()=>{doc.setFontSize(8);doc.text(`Page ${doc.internal.getNumberOfPages()}`,190,290,{align:"right"})}});
    doc.setFontSize(10);doc.text(`Overall recorded: ${totalRecorded}/${totalPossible}    Present: ${totalPresent}    Absent: ${totalAbsent}    Attendance: ${pct}%`,14,doc.lastAutoTable.finalY+9);
  }
  const filename=`attendance-${start}.pdf`;doc.save(filename);setMessage("pdfMessage","PDF downloaded.",true);showToast("PDF downloaded.");
}
function printReport(){
  const {start,end}=reportDates();if(!start||!end||start>end){setMessage("pdfMessage","Choose a valid date or date range.");return}
  const win=window.open("","_blank");if(!win){setMessage("pdfMessage","Pop-up blocked. Allow pop-ups to use Print.");return}
  const rows=[];if(start===end){const rec=attendanceForDate(start)||{};state.account.people.forEach(p=>rows.push(`<tr><td>${safeText(p.name)}</td><td>${rec[p.id]===true?"Present":rec[p.id]===false?"Absent":"Not recorded"}</td></tr>`))}
  else state.account.people.forEach(p=>{const m=personMetrics(p,start,end);rows.push(`<tr><td>${safeText(p.name)}</td><td>${m.daysPresent}</td><td>${m.daysRecorded-m.daysPresent}</td><td>${m.daysRecorded}</td><td>${m.percentage}%</td></tr>`)});
  const head=start===end?"<th>Person</th><th>Status</th>":"<th>Person</th><th>Present</th><th>Absent</th><th>Recorded</th><th>Percentage</th>";
  win.document.write(`<!doctype html><title>${safeText(state.account.settings.reportTitle)}</title><style>body{font:14px Arial;padding:30px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#eee}@media print{@page{size:A4;margin:15mm}}</style><h1>${safeText(state.account.settings.reportTitle)}</h1><p>Account: ${safeText(state.account.username)}<br>Period: ${safeText(start===end?formatDate(start):formatDate(start)+" – "+formatDate(end))}<br>Generated: ${safeText(new Date().toLocaleString())}</p><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table><script>window.onload=()=>window.print()<\/script>`);
  win.document.close();
}
function safeText(s){const d=document.createElement("div");d.textContent=String(s);return d.innerHTML}

function renderAll(){renderAttendance();renderPeople();renderHistory();renderSettings();setupTheme();}
function init(){
  $("loginTab").addEventListener("click",()=>switchAuth("login"));$("signupTab").addEventListener("click",()=>switchAuth("signup"));
  $("loginBtn").addEventListener("click",login);$("signupBtn").addEventListener("click",signup);
  ["loginUsername","loginPassword"].forEach(id=>$(id).addEventListener("keydown",e=>{if(e.key==="Enter")login()}));
  ["signupUsername","signupPassword","signupPassword2"].forEach(id=>$(id).addEventListener("keydown",e=>{if(e.key==="Enter")signup()}));
  qsa(".password-toggle").forEach(b=>b.addEventListener("click",()=>{const i=$(b.dataset.target);i.type=i.type==="password"?"text":"password";b.textContent=i.type==="password"?"Show":"Hide"}));
  $("logoutBtn").addEventListener("click",logout);qsa(".nav-tab").forEach(b=>b.addEventListener("click",()=>nav(b.dataset.page)));
  $("attendanceDate").addEventListener("change",e=>{state.date=e.target.value||localDateKey(new Date());renderAttendance()});
  $("prevDayBtn").addEventListener("click",()=>{state.date=addDays(state.date,-1);renderAttendance()});$("nextDayBtn").addEventListener("click",()=>{state.date=addDays(state.date,1);renderAttendance()});$("todayBtn").addEventListener("click",()=>{state.date=localDateKey(new Date());renderAttendance()});
  $("attendanceSearch").addEventListener("input",e=>{state.search=e.target.value;renderAttendance()});qsa(".filter-btn").forEach(b=>b.addEventListener("click",()=>{state.filter=b.dataset.filter;qsa(".filter-btn").forEach(x=>x.classList.toggle("active",x===b));renderAttendance()}));
  $("markAllBtn").addEventListener("click",()=>bulkAttendance(true));$("clearAllBtn").addEventListener("click",()=>bulkAttendance(false));$("undoBtn").addEventListener("click",undo);
  $("personName").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();addPerson($("personName").value);$("personName").value="";}});$("addPersonBtn").addEventListener("click",()=>{if(addPerson($("personName").value))$("personName").value=""});
  $("bulkToggleBtn").addEventListener("click",()=>{$("bulkBox").classList.toggle("hidden")});$("bulkAddBtn").addEventListener("click",()=>{const names=$("bulkNames").value.split(/\r?\n/);let added=0;names.forEach(n=>{if(addPerson(n))added++});$("bulkNames").value="";showToast(`${added} name(s) added.`)});
  $("historyStart").addEventListener("change",renderHistory);$("historyEnd").addEventListener("change",renderHistory);$("historyThisMonthBtn").addEventListener("click",()=>{const d=new Date();$("historyStart").value=localDateKey(new Date(d.getFullYear(),d.getMonth(),1));$("historyEnd").value=localDateKey(new Date(d.getFullYear(),d.getMonth()+1,0));renderHistory()});
  $("calendarPrev").addEventListener("click",()=>{state.calendarDate.setMonth(state.calendarDate.getMonth()-1);renderCalendar()});$("calendarNext").addEventListener("click",()=>{state.calendarDate.setMonth(state.calendarDate.getMonth()+1);renderCalendar()});
  $("saveSettingsBtn").addEventListener("click",saveSettings);qsa(".theme-btn").forEach(b=>b.addEventListener("click",()=>applyTheme(b.dataset.theme)));
  qsa(".report-type").forEach(b=>b.addEventListener("click",()=>{state.reportType=b.dataset.reportType;renderSettings()}));$("downloadPdfBtn").addEventListener("click",generatePdf);$("printReportBtn").addEventListener("click",printReport);
  $("exportBackupBtn").addEventListener("click",exportBackup);$("importBackupInput").addEventListener("change",e=>{if(e.target.files[0])importBackup(e.target.files[0])});$("exportCsvBtn").addEventListener("click",exportCsv);
  $("changePasswordBtn").addEventListener("click",async()=>{const cur=$("currentPassword").value,n=$("newPassword").value,n2=$("newPassword2").value;if(!validPassword(n)){setMessage("passwordMessage","New password must be at least 6 characters.");return}if(n!==n2){setMessage("passwordMessage","New passwords do not match.");return}if(await hashPassword(cur,state.account.salt)!==state.account.hash){setMessage("passwordMessage","Current password is incorrect.");return}const salt=randomSalt();state.account.salt=salt;state.account.hash=await hashPassword(n,salt);persistAccount();$("currentPassword").value=$("newPassword").value=$("newPassword2").value="";setMessage("passwordMessage","Password changed successfully.",true);showToast("Password changed.")});
  $("deleteAccountBtn").addEventListener("click",()=>{if(!$("deletePassword").value){showToast("Enter your password first.");return}state.deleteArmed=true;renderSettings();showToast("Click the red confirmation button to permanently delete.")});
  $("deleteCancelBtn").addEventListener("click",()=>{state.deleteArmed=false;$("deletePassword").value="";renderSettings()});
  $("deleteConfirmBtn").addEventListener("click",async()=>{if(await hashPassword($("deletePassword").value,state.account.salt)!==state.account.hash){showToast("Incorrect password.");return}const accounts=getAccounts();delete accounts[normalizeUser(state.account.username)];saveAccounts(accounts);clearSession();state.account=null;state.username=null;state.deleteArmed=false;showAuth();switchAuth("login");showToast("Account deleted.")});
  $("modalCancel").addEventListener("click",()=>{closeModal();$("modalConfirm").classList.remove("hidden");$("modalCancel").textContent="Cancel"});$("modalConfirm").addEventListener("click",()=>{modalConfirm();$("modalConfirm").classList.remove("hidden");$("modalCancel").textContent="Cancel"});
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("modal").classList.contains("hidden"))closeModal()});
  setupTheme();
  const session=getSession();if(session&&loadAccount(session))showApp();else showAuth();
}
document.addEventListener("DOMContentLoaded",init);
})();