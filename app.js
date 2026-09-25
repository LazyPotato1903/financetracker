/* ============================================================================
 * Personal Finance Tracker — web app (runs SQLite in the browser via sql.js)
 * Version 1.0.0  |  Base currency PHP (₱) + USD  |  100% client-side & private
 * Data persists in the browser (IndexedDB). Import/Export a finance.db file.
 * ==========================================================================*/
const VERSION = "1.1.0";
const BASE_CCY = "PHP";
const SYM = "₱";
const IDB_NAME = "financeTracker";
const IDB_STORE = "kv";
const BUNDLED_DB = "data/finance.db";

const PALETTE = ["#2e7d6b","#1f3a5f","#ef6c00","#c62828","#6a1b9a","#00838f",
  "#558b2f","#f9a825","#4527a0","#ad1457","#00695c","#5d4037","#283593",
  "#9e9d24","#d84315","#0277bd","#7b1fa2","#33691e"];

const NAV = [
  ["Dashboard","▦"],["Transactions","⇄"],["Accounts","▤"],["Budgets","◑"],
  ["Savings Goals","◎"],["Debt","▽"],["Bills","🧾"],["Net Worth","📈"],["Settings","⚙"]
];

let SQL = null;      // sql.js module
let db = null;       // active database
let CH = [];         // active Chart.js instances (to destroy on nav)

/* ---------- tiny IndexedDB kv store ---------- */
function idbOpen(){
  return new Promise((res,rej)=>{
    const r = indexedDB.open(IDB_NAME,1);
    r.onupgradeneeded = ()=> r.result.createObjectStore(IDB_STORE);
    r.onsuccess = ()=> res(r.result);
    r.onerror = ()=> rej(r.error);
  });
}
async function idbGet(key){
  try{
    const d = await idbOpen();
    return await new Promise((res,rej)=>{
      const tx = d.transaction(IDB_STORE,"readonly").objectStore(IDB_STORE).get(key);
      tx.onsuccess=()=>res(tx.result); tx.onerror=()=>rej(tx.error);
    });
  }catch(e){ return null; }
}
async function idbSet(key,val){
  try{
    const d = await idbOpen();
    return await new Promise((res,rej)=>{
      const tx = d.transaction(IDB_STORE,"readwrite").objectStore(IDB_STORE).put(val,key);
      tx.onsuccess=()=>res(); tx.onerror=()=>rej(tx.error);
    });
  }catch(e){ /* storage may be blocked */ }
}
async function idbDel(key){
  try{ const d=await idbOpen();
    await new Promise(r=>{const t=d.transaction(IDB_STORE,"readwrite").objectStore(IDB_STORE).delete(key);t.onsuccess=r;t.onerror=r;});
  }catch(e){}
}

/* ---------- DB helpers ---------- */
function all(sql,params=[]){
  const st = db.prepare(sql); st.bind(params);
  const out=[]; while(st.step()) out.push(st.getAsObject()); st.free(); return out;
}
function one(sql,params=[]){ const r=all(sql,params); return r.length?r[0]:null; }
function scalar(sql,params=[]){ const r=one(sql,params); if(!r) return 0; const v=Object.values(r)[0]; return v==null?0:v; }
async function run(sql,params=[]){ db.run(sql,params); await persist(); }
async function persist(){ await idbSet("db", db.export()); }

/* ---------- schema (fallback if bundled db missing) ---------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS currencies(code TEXT PRIMARY KEY,rate REAL NOT NULL);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,type TEXT);
CREATE TABLE IF NOT EXISTS tags(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,type TEXT,currency TEXT DEFAULT 'PHP',starting REAL DEFAULT 0,notes TEXT);
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,date TEXT,type TEXT,amount REAL,currency TEXT DEFAULT 'PHP',category TEXT,account TEXT,recurring TEXT DEFAULT 'No',tag TEXT,notes TEXT,receipt TEXT);
CREATE TABLE IF NOT EXISTS budgets(id INTEGER PRIMARY KEY AUTOINCREMENT,category TEXT UNIQUE,monthly REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS goals(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,target REAL DEFAULT 0,saved REAL DEFAULT 0,target_date TEXT);
CREATE TABLE IF NOT EXISTS debts(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,type TEXT,original REAL DEFAULT 0,remaining REAL DEFAULT 0,apr REAL DEFAULT 0,payment REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bills(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,amount REAL DEFAULT 0,currency TEXT DEFAULT 'PHP',due_date TEXT,frequency TEXT,account TEXT,paid TEXT DEFAULT 'No');
CREATE TABLE IF NOT EXISTS networth(id INTEGER PRIMARY KEY AUTOINCREMENT,month TEXT UNIQUE,assets REAL,liabilities REAL,networth REAL);
`;
function ensureSchema(){
  db.run(SCHEMA);
  if(!scalar("SELECT COUNT(*) FROM currencies"))
    db.run("INSERT OR IGNORE INTO currencies(code,rate) VALUES('PHP',1),('USD',58)");
}

/* ---------- formatting ---------- */
function money(v,sym=true){
  v=Number(v||0);
  const s=Math.abs(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  return (v<0?"-":"")+(sym?SYM:"")+s;
}
function pct(v){ return (Number(v||0)*100).toFixed(1)+"%"; }
function pad2(n){ return String(n).padStart(2,"0"); }
function todayISO(){ const d=new Date(); return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
// LOCAL month key — avoids the UTC off-by-one that dropped the current month
function monthKey(d){ d=d||new Date(); return d.getFullYear()+"-"+pad2(d.getMonth()+1); }
function monthLabel(mk){ const [y,m]=mk.split("-").map(Number); return new Date(y,m-1,1).toLocaleDateString(undefined,{month:"short",year:"2-digit"}); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------- computations (mirror desktop app) ---------- */
function fx(code){ const r=one("SELECT rate FROM currencies WHERE code=?",[code||BASE_CCY]); return r?Number(r.rate):1; }
function toBase(amount,ccy){ return Number(amount||0)*fx(ccy); }
function accountBalance(name,starting){
  const inflow = scalar("SELECT SUM(amount*(SELECT rate FROM currencies WHERE code=transactions.currency)) FROM transactions WHERE type='Income' AND account=?",[name]);
  const outflow= scalar("SELECT SUM(amount*(SELECT rate FROM currencies WHERE code=transactions.currency)) FROM transactions WHERE type='Expense' AND account=?",[name]);
  return Number(starting||0)+Number(inflow)-Number(outflow);
}
function monthTotal(type,mkey,cat){
  let sql="SELECT SUM(amount*(SELECT rate FROM currencies WHERE code=transactions.currency)) FROM transactions WHERE type=? AND substr(date,1,7)=?";
  const args=[type,mkey]; if(cat){sql+=" AND category=?"; args.push(cat);}
  return Number(scalar(sql,args));
}
function totalAssets(){
  let a=0;
  for(const r of all("SELECT name,starting FROM accounts")){ const b=accountBalance(r.name,r.starting); if(b>=0)a+=b; }
  a+=Number(scalar("SELECT SUM(saved) FROM goals")); return a;
}
function totalLiabilities(){
  let l=0;
  for(const r of all("SELECT name,starting FROM accounts")){ const b=accountBalance(r.name,r.starting); if(b<0)l+=-b; }
  l+=Number(scalar("SELECT SUM(remaining) FROM debts")); return l;
}
function netWorth(){ return totalAssets()-totalLiabilities(); }
function healthScore(){
  const mk=monthKey(), income=monthTotal("Income",mk), expense=monthTotal("Expense",mk);
  const rate=income?(income-expense)/income:0;
  const tgt=Number(setting("target_savings_rate",0.20)), em=Number(setting("emergency_months",6));
  const debtPay=Number(scalar("SELECT SUM(payment) FROM debts")), goalSaved=Number(scalar("SELECT SUM(saved) FROM goals"));
  const s1=Math.max(0,Math.min(40, tgt?(rate/tgt)*40:0));
  const dti=income?(debtPay*12)/(income*12):1;
  const s2=Math.max(0,Math.min(30,(1-dti)*30));
  const cover=expense?goalSaved/expense:0;
  const s3=Math.max(0,Math.min(30, em?(cover/em)*30:0));
  return Math.round(s1+s2+s3);
}
function setting(k,def){ const r=one("SELECT value FROM settings WHERE key=?",[k]); return r?r.value:def; }
function categoryNames(type){ return all(type?"SELECT name FROM categories WHERE type=? ORDER BY name":"SELECT name FROM categories ORDER BY type DESC,name", type?[type]:[]).map(r=>r.name); }
function accountNames(){ return all("SELECT name FROM accounts ORDER BY name").map(r=>r.name); }
function tagNames(){ return all("SELECT name FROM tags ORDER BY name").map(r=>r.name); }
function ccyCodes(){ return all("SELECT code FROM currencies ORDER BY code").map(r=>r.code); }
function monthOffset(off){ const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-off); return d.getFullYear()+"-"+pad2(d.getMonth()+1); }
// ---- analytics helpers ----
function ytd(type){ const y=String(new Date().getFullYear());
  return Number(scalar("SELECT SUM(amount*(SELECT rate FROM currencies WHERE code=transactions.currency)) FROM transactions WHERE type=? AND substr(date,1,4)=?",[type,y])); }
function liquidCash(){ let c=0; for(const a of all("SELECT name,type,starting FROM accounts")){ if(a.type!=='Credit Card'){ const b=accountBalance(a.name,a.starting); if(b>0)c+=b; } } return c; }
function tagTotals(mk){ return all("SELECT COALESCE(NULLIF(TRIM(tag),''),'Untagged') AS tag, SUM(amount*(SELECT rate FROM currencies WHERE code=transactions.currency)) AS base FROM transactions WHERE type='Expense' AND substr(date,1,7)=? GROUP BY tag ORDER BY base DESC",[mk]); }
function categoryDeltas(mk,prev){ const out=[]; for(const n of categoryNames('Expense')){ const cur=monthTotal('Expense',mk,n), pv=monthTotal('Expense',prev,n); if(cur||pv) out.push({name:n,cur,prev:pv,delta:cur-pv}); } out.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)); return out; }
async function snapshotNetWorth(){
  const mk=monthKey(), a=totalAssets(), l=totalLiabilities();
  await run("INSERT INTO networth(month,assets,liabilities,networth) VALUES(?,?,?,?) ON CONFLICT(month) DO UPDATE SET assets=excluded.assets,liabilities=excluded.liabilities,networth=excluded.networth",[mk,a,l,a-l]);
}

/* ---------- toast ---------- */
let toastT=null;
function toast(msg){ const t=document.getElementById("toast"); t.textContent=msg; t.hidden=false;
  clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true,2600); }

/* ============================================================================
 *  VIEWS
 * ==========================================================================*/
let CURRENT="Dashboard";
function destroyCharts(){ CH.forEach(c=>{try{c.destroy();}catch(e){}}); CH=[]; }

function show(name){
  CURRENT=name; destroyCharts();
  document.querySelectorAll(".nav a").forEach(a=>a.classList.toggle("active",a.dataset.name===name));
  document.getElementById("crumb").textContent=name;
  const v=document.getElementById("view"); v.innerHTML="";
  ({Dashboard:renderDashboard,Transactions:renderTransactions,Accounts:renderAccounts,
    Budgets:renderBudgets,"Savings Goals":renderGoals,Debt:renderDebt,Bills:renderBills,
    "Net Worth":renderNetWorth,Settings:renderSettings}[name]||renderDashboard)(v);
}
function refresh(){ show(CURRENT); }

/* ---------- Dashboard ---------- */
function renderDashboard(v){
  const mk=monthKey(), prev=monthOffset(1);
  const income=monthTotal("Income",mk), expense=monthTotal("Expense",mk), net=income-expense;
  const rate=income?net/income:0, nw=netWorth(), score=healthScore();
  const now=new Date(), day=now.getDate();
  const eom=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  const projMonth=day?net/day*eom:net;
  const cash=liquidCash();
  const avgDaily=day?expense/day:0;
  const runway=avgDaily>0?Math.round(cash/avgDaily):null;
  const ytdInc=ytd("Income"), ytdExp=ytd("Expense"), ytdNet=ytdInc-ytdExp;

  const kpis=[
    ["Total Income",money(income),"good"],["Total Expenses",money(expense),"bad"],
    ["Net Savings",money(net),net>=0?"good":"bad"],["Savings Rate",pct(rate),"accent"],
    ["Net Worth",money(nw),""],["Health Score",score+"/100",score>=70?"good":score>=40?"warn":"bad"]
  ];
  const stats=[
    ["Cash Runway",runway==null?"—":runway+" days","accent"],
    ["Avg Daily Spend",money(avgDaily),"bad"],
    ["Liquid Cash",money(cash),""],
    ["YTD Income",money(ytdInc),"good"],
    ["YTD Expenses",money(ytdExp),"bad"],
    ["YTD Net Savings",money(ytdNet),ytdNet>=0?"good":"bad"]
  ];
  v.innerHTML=`
    <div class="page-head"><div><h1>Cash Flow Dashboard</h1>
      <div class="sub">${now.toLocaleDateString(undefined,{month:'long',year:'numeric'})} · Base currency ${BASE_CCY}</div></div></div>
    <div class="kpis">${kpis.map(k=>`<div class="card kpi"><div class="label">${k[0]}</div>
      <div class="value ${k[2]}">${k[1]}</div></div>`).join("")}</div>
    <div class="kpis">${stats.map(k=>`<div class="card kpi"><div class="label">${k[0]}</div>
      <div class="value ${k[2]}" style="font-size:19px">${k[1]}</div></div>`).join("")}</div>
    <div class="panels">
      <div class="panel"><h3>Spending Breakdown — This Month</h3><div class="chart-wrap"><canvas id="pie"></canvas></div></div>
      <div class="panel"><h3>Income vs Expenses — Monthly Trend</h3><div class="chart-wrap"><canvas id="bars"></canvas></div>
        <div class="fc-line">Projected month-end net savings: <b>${money(projMonth)}</b></div>
        <div class="fc-line">Projected annual savings (run-rate): <b>${money(projMonth*12)}</b></div></div>
    </div>
    <div class="panels" style="margin-top:16px">
      <div class="panel"><h3>Savings Rate — Trend</h3><div class="chart-wrap"><canvas id="srtrend"></canvas></div></div>
      <div class="panel"><h3>Spending by Tag — This Month</h3><div class="chart-wrap"><canvas id="tagpie"></canvas></div></div>
    </div>
    <div class="panels" style="margin-top:16px">
      <div class="panel"><h3>Spending vs Last Month</h3>${movers(mk,prev)}</div>
      <div class="panel"><h3>Budget Health</h3>${budgetMini(mk)}</div>
    </div>
    <div class="panels" style="margin-top:16px">
      <div class="panel"><h3>Top 5 Purchases — This Month</h3>${topPurchases(mk)}</div>
      <div class="panel"><h3>Net Worth — Trend</h3><div class="chart-wrap"><canvas id="nwmini"></canvas></div></div>
    </div>`;

  // pie — category spend this month
  const cats=[];
  for(const n of categoryNames("Expense")){ const amt=monthTotal("Expense",mk,n); if(amt>0)cats.push([n,amt]); }
  cats.sort((a,b)=>b[1]-a[1]);
  if(cats.length) CH.push(new Chart(document.getElementById("pie"),{type:"doughnut",
    data:{labels:cats.map(c=>c[0]),datasets:[{data:cats.map(c=>c[1]),backgroundColor:cats.map((_,i)=>PALETTE[i%PALETTE.length]),borderWidth:2,borderColor:"#fff"}]},
    options:{plugins:{legend:{position:"right",labels:{boxWidth:12,font:{size:11}}}},cutout:"55%",maintainAspectRatio:false}}));
  else document.getElementById("pie").parentElement.innerHTML='<div class="empty">No spending yet this month</div>';

  // bars — income vs expenses, last 6 months (labels via monthLabel, current month included)
  const months=[]; for(let o=5;o>=0;o--){const m=monthOffset(o);
    months.push([monthLabel(m),monthTotal("Income",m),monthTotal("Expense",m)]);}
  CH.push(new Chart(document.getElementById("bars"),{type:"bar",
    data:{labels:months.map(m=>m[0]),datasets:[
      {label:"Income",data:months.map(m=>m[1]),backgroundColor:"#2e7d32"},
      {label:"Expenses",data:months.map(m=>m[2]),backgroundColor:"#c62828"}]},
    options:{maintainAspectRatio:false,plugins:{legend:{position:"top",labels:{boxWidth:12}}},
      scales:{y:{ticks:{callback:v=>SYM+Number(v).toLocaleString()}}}}}));

  // savings-rate trend line
  const srL=[], srD=[];
  for(let o=5;o>=0;o--){const m=monthOffset(o); const inc=monthTotal("Income",m), exp=monthTotal("Expense",m);
    srL.push(monthLabel(m)); srD.push(inc? +(((inc-exp)/inc)*100).toFixed(1):0);}
  CH.push(new Chart(document.getElementById("srtrend"),{type:"line",
    data:{labels:srL,datasets:[{label:"Savings rate",data:srD,borderColor:"#2e7d6b",backgroundColor:"rgba(46,125,107,.12)",fill:true,tension:.25,pointRadius:3}]},
    options:{maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{callback:v=>v+"%"}}}}}));

  // spending by tag donut
  const tags=tagTotals(mk).filter(t=>t.base>0);
  if(tags.length) CH.push(new Chart(document.getElementById("tagpie"),{type:"doughnut",
    data:{labels:tags.map(t=>t.tag),datasets:[{data:tags.map(t=>t.base),backgroundColor:tags.map((_,i)=>PALETTE[i%PALETTE.length]),borderWidth:2,borderColor:"#fff"}]},
    options:{plugins:{legend:{position:"right",labels:{boxWidth:12,font:{size:11}}}},cutout:"55%",maintainAspectRatio:false}}));
  else document.getElementById("tagpie").parentElement.innerHTML='<div class="empty">No tagged spending this month</div>';

  // net worth mini trend
  const nwh=all("SELECT month,networth FROM networth ORDER BY month");
  if(nwh.length) CH.push(new Chart(document.getElementById("nwmini"),{type:"line",
    data:{labels:nwh.map(r=>r.month),datasets:[{label:"Net worth",data:nwh.map(r=>r.networth),borderColor:"#1f3a5f",backgroundColor:"rgba(31,58,95,.12)",fill:true,tension:.25,pointRadius:3}]},
    options:{maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{callback:v=>SYM+Number(v).toLocaleString()}}}}}));
  else document.getElementById("nwmini").parentElement.innerHTML='<div class="empty">Snapshot net worth (Net Worth tab) to see a trend</div>';
}
function movers(mk,prev){
  const rows=categoryDeltas(mk,prev).slice(0,8);
  if(!rows.length) return '<div class="empty">No spending to compare</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">This Month</th><th class="num">Last Month</th><th class="num">Change</th></tr></thead><tbody>${
    rows.map(r=>{const up=r.delta>0; const cls=up?'neg':(r.delta<0?'pos':''); const sign=up?'▲':(r.delta<0?'▼':'');
    return `<tr><td>${esc(r.name)}</td><td class="num">${money(r.cur)}</td><td class="num">${money(r.prev)}</td>
      <td class="num ${cls}">${sign} ${money(Math.abs(r.delta))}</td></tr>`;}).join("")}</tbody></table></div>`;
}
function topPurchases(mk){
  const rows=all("SELECT notes,category,amount*(SELECT rate FROM currencies WHERE code=transactions.currency) AS base FROM transactions WHERE type='Expense' AND substr(date,1,7)=? ORDER BY base DESC LIMIT 5",[mk]);
  if(!rows.length) return '<div class="empty">No purchases yet</div>';
  return `<div class="table-wrap"><table><tbody>${rows.map(r=>`<tr><td>${esc(r.notes||r.category)}</td><td class="num">${money(r.base)}</td></tr>`).join("")}</tbody></table></div>`;
}
function budgetMini(mk){
  const rows=all("SELECT category,monthly FROM budgets WHERE monthly>0 ORDER BY monthly DESC LIMIT 6");
  if(!rows.length) return '<div class="empty">No budgets set</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Spent / Budget</th><th style="width:120px">Used</th></tr></thead><tbody>${
    rows.map(r=>{const act=monthTotal("Expense",mk,r.category);const u=r.monthly?act/r.monthly:0;
    const col=u>1?"#c62828":u>0.8?"#ef6c00":"#2e7d6b";
    return `<tr><td>${esc(r.category)}</td><td class="num">${money(act)} / ${money(r.monthly)}</td>
      <td><div class="bar"><span style="width:${Math.min(100,u*100)}%;background:${col}"></span></div></td></tr>`;}).join("")}</tbody></table></div>`;
}

/* ---------- generic CRUD table ---------- */
function crud(v,cfg){
  const rows=cfg.fetch();
  v.innerHTML=`
    <div class="page-head"><div><h1>${cfg.title}</h1>${cfg.sub?`<div class="sub">${cfg.sub}</div>`:""}</div></div>
    ${cfg.editable!==false?`<div class="toolbar">
      <button class="btn sm" id="addBtn">+ Add</button>
      <button class="btn sm ghost" id="editBtn">Edit</button>
      <button class="btn sm danger" id="delBtn">Delete</button></div>`:""}
    <div class="table-wrap"><table><thead><tr>${
      cfg.columns.map(c=>`<th class="${c.kind==='money'||c.kind==='pct'||c.kind==='num'?'num':''}">${c.label}</th>`).join("")}</tr></thead>
      <tbody id="tbody">${rows.length?"":`<tr><td colspan="${cfg.columns.length}" class="empty">Nothing here yet — click “+ Add”.</td></tr>`}</tbody></table></div>`;
  const tb=v.querySelector("#tbody");
  rows.forEach(r=>{
    const tr=document.createElement("tr"); tr.dataset.id=r.id;
    tr.innerHTML=cfg.columns.map(c=>cellHTML(r,c)).join("");
    tr.onclick=()=>{tb.querySelectorAll("tr").forEach(x=>x.classList.remove("selected")); tr.classList.add("selected"); tb._sel=r;};
    tr.ondblclick=()=>openForm(cfg,r);
    tb.appendChild(tr);
  });
  if(cfg.editable!==false){
    v.querySelector("#addBtn").onclick=()=>openForm(cfg,null);
    v.querySelector("#editBtn").onclick=()=>{ if(!tb._sel)return toast("Select a row first"); openForm(cfg,tb._sel); };
    v.querySelector("#delBtn").onclick=async()=>{ if(!tb._sel)return toast("Select a row first");
      if(confirm("Delete this row?")){ await cfg.del(tb._sel.id); toast("Deleted"); refresh(); } };
  }
}
function cellHTML(r,c){
  let v=r[c.key], cls=(c.kind==='money'||c.kind==='pct'||c.kind==='num')?'num':'';
  if(c.render) return `<td class="${cls}">${c.render(r)}</td>`;
  if(c.kind==='money'){ const n=Number(v||0); return `<td class="num ${n<0?'neg':''}">${money(v)}</td>`; }
  if(c.kind==='pct') return `<td class="num">${pct(v)}</td>`;
  if(c.kind==='num') return `<td class="num">${v==null?"":v}</td>`;
  return `<td class="${cls}">${esc(v)}</td>`;
}

/* ---------- modal form ---------- */
function openForm(cfg,row){
  const isEdit=!!row;
  const host=document.getElementById("modalHost");
  const fields=cfg.fields;
  host.innerHTML=`<div class="modal-back"><div class="modal"><h2>${isEdit?"Edit":"Add"} ${cfg.singular}</h2>
    <form id="f">${fields.map(f=>fieldHTML(f,row)).join("")}
    <div class="modal-actions"><button type="button" class="btn ghost" id="cancel">Cancel</button>
      <button type="submit" class="btn">Save</button></div></form></div></div>`;
  const close=()=>host.innerHTML="";
  host.querySelector("#cancel").onclick=close;
  host.querySelector(".modal-back").onclick=e=>{ if(e.target.classList.contains("modal-back"))close(); };
  host.querySelector("#f").onsubmit=async e=>{
    e.preventDefault();
    const val={};
    for(const f of fields){
      let raw=(host.querySelector("#fld_"+f.key).value||"").trim();
      if(f.kind==="num"){ raw=raw.replace(/,/g,""); if(raw==="")raw="0"; if(isNaN(Number(raw)))return toast(`"${f.label}" must be a number`); val[f.key]=Number(raw); }
      else val[f.key]=raw;
    }
    await cfg.save(isEdit?row.id:null,val); close(); toast(isEdit?"Saved":"Added"); refresh();
  };
  const first=host.querySelector("input,select"); if(first)first.focus();
}
function fieldHTML(f,row){
  const val=row?(row[f.key]??""):(f.kind==="date"?todayISO():"");
  const opts=typeof f.options==="function"?f.options():f.options;
  if(opts){
    return `<div class="field"><label>${f.label}</label><select id="fld_${f.key}">${
      opts.map(o=>`<option ${String(o)===String(val)?"selected":""}>${esc(o)}</option>`).join("")}</select></div>`;
  }
  const type=f.kind==="date"?"date":f.kind==="num"?"number":"text";
  const step=f.kind==="num"?' step="0.01"':"";
  return `<div class="field"><label>${f.label}</label><input id="fld_${f.key}" type="${type}"${step} value="${esc(val)}"></div>`;
}

/* ---------- section configs ---------- */
function renderTransactions(v){
  crud(v,{title:"Transactions",singular:"transaction",
    columns:[
      {key:"date",label:"Date"},{key:"type",label:"Type",render:r=>`<span class="pill ${r.type?.toLowerCase()}">${esc(r.type)}</span>`},
      {key:"amount",label:"Amount",kind:"money"},{key:"currency",label:"Ccy"},
      {key:"base",label:`Amount (${BASE_CCY})`,kind:"money"},
      {key:"category",label:"Category"},{key:"account",label:"Account"},
      {key:"recurring",label:"Recur"},{key:"tag",label:"Tag"},{key:"notes",label:"Notes"}],
    fields:[
      {key:"date",label:"Date",kind:"date"},
      {key:"type",label:"Type",options:["Expense","Income","Transfer"]},
      {key:"amount",label:"Amount",kind:"num"},
      {key:"currency",label:"Currency",options:ccyCodes},
      {key:"category",label:"Category",options:()=>categoryNames()},
      {key:"account",label:"Account",options:accountNames},
      {key:"recurring",label:"Recurring",options:["No","Yes"]},
      {key:"tag",label:"Tag",options:tagNames},
      {key:"notes",label:"Notes"}],
    fetch:()=>all("SELECT * FROM transactions ORDER BY date DESC,id DESC").map(r=>({...r,base:toBase(r.amount,r.currency)})),
    save:async(id,x)=>{ if(id)await run("UPDATE transactions SET date=?,type=?,amount=?,currency=?,category=?,account=?,recurring=?,tag=?,notes=? WHERE id=?",[x.date,x.type,x.amount,x.currency,x.category,x.account,x.recurring,x.tag,x.notes,id]);
      else await run("INSERT INTO transactions(date,type,amount,currency,category,account,recurring,tag,notes) VALUES(?,?,?,?,?,?,?,?,?)",[x.date,x.type,x.amount,x.currency,x.category,x.account,x.recurring,x.tag,x.notes]); },
    del:async id=>run("DELETE FROM transactions WHERE id=?",[id])});
}
function renderAccounts(v){
  crud(v,{title:"Accounts",singular:"account",sub:"Current balance is auto-computed from transactions",
    columns:[{key:"name",label:"Account"},{key:"type",label:"Type"},{key:"currency",label:"Ccy"},
      {key:"starting",label:"Starting",kind:"money"},{key:"balance",label:"Current Balance",kind:"money"},{key:"notes",label:"Notes"}],
    fields:[{key:"name",label:"Account Name"},{key:"type",label:"Type",options:["Bank","E-Wallet","Cash","Credit Card"]},
      {key:"currency",label:"Currency",options:ccyCodes},{key:"starting",label:"Starting Balance (negative = owed)",kind:"num"},{key:"notes",label:"Notes"}],
    fetch:()=>all("SELECT * FROM accounts ORDER BY name").map(r=>({...r,balance:accountBalance(r.name,r.starting)})),
    save:async(id,x)=>{ if(id)await run("UPDATE accounts SET name=?,type=?,currency=?,starting=?,notes=? WHERE id=?",[x.name,x.type,x.currency,x.starting,x.notes,id]);
      else await run("INSERT INTO accounts(name,type,currency,starting,notes) VALUES(?,?,?,?,?)",[x.name,x.type,x.currency,x.starting,x.notes]); },
    del:async id=>run("DELETE FROM accounts WHERE id=?",[id])});
}
function renderBudgets(v){
  const mk=monthKey();
  crud(v,{title:"Budgets",singular:"budget",sub:`Tracking ${new Date().toLocaleDateString(undefined,{month:'long',year:'numeric'})}`,
    columns:[{key:"category",label:"Category"},{key:"monthly",label:"Monthly Budget",kind:"money"},
      {key:"actual",label:"Actual Spend",kind:"money"},{key:"remaining",label:"Remaining",kind:"money"},
      {key:"used",label:"% Used",render:r=>{const c=r.used>1?"#c62828":r.used>0.8?"#ef6c00":"#2e7d6b";
        return `<div class="bar"><span style="width:${Math.min(100,r.used*100)}%;background:${c}"></span></div> ${pct(r.used)}`;}}],
    fields:[{key:"category",label:"Category",options:()=>categoryNames("Expense")},{key:"monthly",label:"Monthly Budget",kind:"num"}],
    fetch:()=>all("SELECT * FROM budgets ORDER BY category").map(r=>{const a=monthTotal("Expense",mk,r.category);const m=Number(r.monthly||0);return{...r,actual:a,remaining:m-a,used:m?a/m:0};}),
    save:async(id,x)=>{ if(id)await run("UPDATE budgets SET category=?,monthly=? WHERE id=?",[x.category,x.monthly,id]);
      else await run("INSERT INTO budgets(category,monthly) VALUES(?,?) ON CONFLICT(category) DO UPDATE SET monthly=excluded.monthly",[x.category,x.monthly]); },
    del:async id=>run("DELETE FROM budgets WHERE id=?",[id])});
}
function renderGoals(v){
  crud(v,{title:"Savings Goals",singular:"goal",
    columns:[{key:"name",label:"Goal"},{key:"target",label:"Target",kind:"money"},{key:"saved",label:"Saved",kind:"money"},
      {key:"remaining",label:"Remaining",kind:"money"},
      {key:"progress",label:"Progress",render:r=>`<div class="bar"><span style="width:${Math.min(100,r.progress*100)}%"></span></div> ${pct(r.progress)}`},
      {key:"target_date",label:"Target Date"}],
    fields:[{key:"name",label:"Goal"},{key:"target",label:"Target Amount",kind:"num"},{key:"saved",label:"Saved So Far",kind:"num"},{key:"target_date",label:"Target Date",kind:"date"}],
    fetch:()=>all("SELECT * FROM goals ORDER BY name").map(r=>{const t=Number(r.target||0),s=Number(r.saved||0);return{...r,remaining:Math.max(0,t-s),progress:t?Math.min(1,s/t):0};}),
    save:async(id,x)=>{ if(id)await run("UPDATE goals SET name=?,target=?,saved=?,target_date=? WHERE id=?",[x.name,x.target,x.saved,x.target_date,id]);
      else await run("INSERT INTO goals(name,target,saved,target_date) VALUES(?,?,?,?)",[x.name,x.target,x.saved,x.target_date]); },
    del:async id=>run("DELETE FROM goals WHERE id=?",[id])});
}
function renderDebt(v){
  crud(v,{title:"Debt Tracker",singular:"debt",
    columns:[{key:"name",label:"Debt"},{key:"type",label:"Type"},{key:"original",label:"Original",kind:"money"},
      {key:"remaining",label:"Remaining",kind:"money"},{key:"apr",label:"APR",kind:"pct"},
      {key:"payment",label:"Monthly Pay",kind:"money"},{key:"payoff",label:"Est. Months",kind:"num"}],
    fields:[{key:"name",label:"Debt"},{key:"type",label:"Type",options:["Credit Card","Loan","Mortgage","Other"]},
      {key:"original",label:"Original Amount",kind:"num"},{key:"remaining",label:"Remaining Balance",kind:"num"},
      {key:"apr",label:"Interest Rate (0.24 = 24%)",kind:"num"},{key:"payment",label:"Monthly Payment",kind:"num"}],
    fetch:()=>all("SELECT * FROM debts ORDER BY name").map(r=>{const rem=Number(r.remaining||0),pay=Number(r.payment||0),apr=Number(r.apr||0);const eff=pay-rem*apr/12;return{...r,payoff:pay&&eff>0?Math.ceil(rem/eff):0};}),
    save:async(id,x)=>{ if(id)await run("UPDATE debts SET name=?,type=?,original=?,remaining=?,apr=?,payment=? WHERE id=?",[x.name,x.type,x.original,x.remaining,x.apr,x.payment,id]);
      else await run("INSERT INTO debts(name,type,original,remaining,apr,payment) VALUES(?,?,?,?,?,?)",[x.name,x.type,x.original,x.remaining,x.apr,x.payment]); },
    del:async id=>run("DELETE FROM debts WHERE id=?",[id])});
}
function renderBills(v){
  crud(v,{title:"Bills & Subscriptions",singular:"bill",
    columns:[{key:"name",label:"Bill"},{key:"amount",label:"Amount",kind:"money"},{key:"currency",label:"Ccy"},
      {key:"due_date",label:"Next Due"},{key:"frequency",label:"Frequency"},{key:"account",label:"Account"},
      {key:"status",label:"Status",render:r=>{const m={Paid:"paid",OVERDUE:"overdue","Due Soon":"soon",Upcoming:"upcoming"}[r.status]||"upcoming";return `<span class="pill ${m}">${esc(r.status)}</span>`;}},
      {key:"days",label:"Days Left",kind:"num"}],
    fields:[{key:"name",label:"Bill"},{key:"amount",label:"Amount",kind:"num"},{key:"currency",label:"Currency",options:ccyCodes},
      {key:"due_date",label:"Next Due Date",kind:"date"},{key:"frequency",label:"Frequency",options:["Monthly","Weekly","Quarterly","Yearly","One-time"]},
      {key:"account",label:"Account",options:accountNames},{key:"paid",label:"Paid?",options:["No","Yes"]}],
    fetch:()=>all("SELECT * FROM bills ORDER BY due_date").map(r=>{
      let days=null; if(r.due_date){days=Math.round((new Date(r.due_date)-new Date(todayISO()))/86400000);}
      let status=r.paid==="Yes"?"Paid":days==null?"":days<0?"OVERDUE":days<=5?"Due Soon":"Upcoming";
      return{...r,days:days==null?"":days,status};}),
    save:async(id,x)=>{ if(id)await run("UPDATE bills SET name=?,amount=?,currency=?,due_date=?,frequency=?,account=?,paid=? WHERE id=?",[x.name,x.amount,x.currency,x.due_date,x.frequency,x.account,x.paid,id]);
      else await run("INSERT INTO bills(name,amount,currency,due_date,frequency,account,paid) VALUES(?,?,?,?,?,?,?)",[x.name,x.amount,x.currency,x.due_date,x.frequency,x.account,x.paid]); },
    del:async id=>run("DELETE FROM bills WHERE id=?",[id])});
}
function renderNetWorth(v){
  const a=totalAssets(),l=totalLiabilities(),nw=a-l;
  const hist=all("SELECT * FROM networth ORDER BY month");
  v.innerHTML=`
    <div class="page-head"><div><h1>Net Worth</h1></div>
      <button class="btn" id="snap">📸 Snapshot This Month</button></div>
    <div class="kpis">
      <div class="card kpi"><div class="label">Total Assets</div><div class="value good">${money(a)}</div></div>
      <div class="card kpi"><div class="label">Total Liabilities</div><div class="value bad">${money(l)}</div></div>
      <div class="card kpi"><div class="label">Net Worth</div><div class="value">${money(nw)}</div></div>
    </div>
    <div class="panels">
      <div class="panel"><h3>Monthly History</h3>${hist.length?
        `<div class="table-wrap"><table><thead><tr><th>Month</th><th class="num">Assets</th><th class="num">Liabilities</th><th class="num">Net Worth</th></tr></thead>
        <tbody>${hist.map(r=>`<tr><td>${esc(r.month)}</td><td class="num">${money(r.assets)}</td><td class="num">${money(r.liabilities)}</td><td class="num">${money(r.networth)}</td></tr>`).join("")}</tbody></table></div>`
        :'<div class="empty">Take a snapshot to start tracking</div>'}</div>
      <div class="panel"><h3>Net Worth Over Time</h3><div class="chart-wrap"><canvas id="nwline"></canvas></div></div>
    </div>`;
  v.querySelector("#snap").onclick=async()=>{ await snapshotNetWorth(); toast("Snapshot saved"); refresh(); };
  if(hist.length) CH.push(new Chart(document.getElementById("nwline"),{type:"line",
    data:{labels:hist.map(r=>r.month),datasets:[{label:"Net Worth",data:hist.map(r=>r.networth),borderColor:"#2e7d6b",backgroundColor:"rgba(46,125,107,.12)",fill:true,tension:.25,pointRadius:3}]},
    options:{maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{callback:v=>SYM+Number(v).toLocaleString()}}}}}));
}

/* ---------- Settings ---------- */
let SETTAB="Currencies";
function renderSettings(v){
  v.innerHTML=`<div class="page-head"><div><h1>Settings & Reference Data</h1>
    <div class="sub">Currencies/FX, categories and tags feed the dropdowns everywhere.</div></div></div>
    <div class="tabs">${["Currencies","Categories","Tags","Data & About"].map(t=>`<button class="${t===SETTAB?'active':''}" data-t="${t}">${t}</button>`).join("")}</div>
    <div id="settab"></div>`;
  v.querySelectorAll(".tabs button").forEach(b=>b.onclick=()=>{SETTAB=b.dataset.t;renderSettings(v);});
  const host=v.querySelector("#settab");
  if(SETTAB==="Currencies") crud(host,{title:"Currencies / FX",singular:"currency",
    columns:[{key:"code",label:"Currency"},{key:"rate",label:`Rate to ${BASE_CCY}`,kind:"num"}],
    fields:[{key:"code",label:"Currency Code"},{key:"rate",label:`Rate to ${BASE_CCY}`,kind:"num"}],
    fetch:()=>all("SELECT code,rate FROM currencies ORDER BY code").map(r=>({...r,id:r.code})),
    save:async(id,x)=>{ const code=x.code.toUpperCase(); if(id&&id!==code)await run("UPDATE currencies SET code=?,rate=? WHERE code=?",[code,x.rate,id]);
      else await run("INSERT INTO currencies(code,rate) VALUES(?,?) ON CONFLICT(code) DO UPDATE SET rate=excluded.rate",[code,x.rate]); },
    del:async id=>{ if(id===BASE_CCY)return toast("Can't delete the base currency"); await run("DELETE FROM currencies WHERE code=?",[id]); }});
  else if(SETTAB==="Categories") crud(host,{title:"Categories",singular:"category",
    columns:[{key:"name",label:"Category"},{key:"type",label:"Type"}],
    fields:[{key:"name",label:"Category"},{key:"type",label:"Type",options:["Income","Expense"]}],
    fetch:()=>all("SELECT * FROM categories ORDER BY type DESC,name"),
    save:async(id,x)=>{ if(id)await run("UPDATE categories SET name=?,type=? WHERE id=?",[x.name,x.type,id]);
      else await run("INSERT OR IGNORE INTO categories(name,type) VALUES(?,?)",[x.name,x.type]); },
    del:async id=>run("DELETE FROM categories WHERE id=?",[id])});
  else if(SETTAB==="Tags") crud(host,{title:"Tags",singular:"tag",
    columns:[{key:"name",label:"Tag"}],fields:[{key:"name",label:"Tag"}],
    fetch:()=>all("SELECT * FROM tags ORDER BY name"),
    save:async(id,x)=>{ if(id)await run("UPDATE tags SET name=? WHERE id=?",[x.name,id]); else await run("INSERT OR IGNORE INTO tags(name) VALUES(?)",[x.name]); },
    del:async id=>run("DELETE FROM tags WHERE id=?",[id])});
  else host.innerHTML=`<div class="panel">
      <h3>Data & About</h3>
      <p style="color:#41597a;line-height:1.6">Personal Finance Tracker <b>v${VERSION}</b> · base currency ${BASE_CCY} (${SYM}).<br>
      Your data lives only in this browser (IndexedDB) and in any <code>.db</code> file you export.
      Nothing is uploaded to a server.</p>
      <div class="toolbar">
        <button class="btn" id="sExport">⤒ Export .db</button>
        <button class="btn ghost" id="sImport">⤓ Import .db</button>
        <button class="btn danger" id="sReset">Reset to sample data</button>
      </div>
      <p style="color:#6b7785;font-size:12.5px">Tip: Export regularly to back up, and to move your data to another device or browser.</p></div>`;
  if(SETTAB==="Data & About"){
    host.querySelector("#sExport").onclick=exportDb;
    host.querySelector("#sImport").onclick=()=>document.getElementById("importFile").click();
    host.querySelector("#sReset").onclick=async()=>{ if(confirm("Discard current data and reload the bundled sample database?")){ await idbDel("db"); location.reload(); } };
  }
}

/* ---------- import / export ---------- */
function exportDb(){
  const data=db.export();
  const blob=new Blob([data],{type:"application/octet-stream"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="finance.db";
  a.click(); URL.revokeObjectURL(a.href);
  toast("Exported finance.db");
}
async function importDb(file){
  try{
    const buf=new Uint8Array(await file.arrayBuffer());
    const test=new SQL.Database(buf);           // validate
    test.run("SELECT 1 FROM transactions LIMIT 1"); // must be our schema
    test.close();
    if(db)db.close();
    db=new SQL.Database(buf);
    ensureSchema();
    await persist();
    toast("Imported "+file.name);
    refresh();
  }catch(e){
    alert("That file doesn't look like a Finance Tracker database.\n\n"+e.message);
  }
}

/* ============================================================================
 *  BOOT
 * ==========================================================================*/
async function boot(){
  document.getElementById("verLabel").textContent="v"+VERSION;
  // nav
  const nav=document.getElementById("nav");
  nav.innerHTML=NAV.map(([n,ic])=>`<a data-name="${n}"><span class="ic">${ic}</span>${n}</a>`).join("");
  nav.querySelectorAll("a").forEach(a=>a.onclick=()=>show(a.dataset.name));
  // topbar buttons
  document.getElementById("btnExport").onclick=exportDb;
  document.getElementById("btnImport").onclick=()=>document.getElementById("importFile").click();
  document.getElementById("importFile").onchange=e=>{ if(e.target.files[0])importDb(e.target.files[0]); e.target.value=""; };

  // init sql.js
  SQL=await initSqlJs({locateFile:f=>"https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/"+f});

  // load: IndexedDB -> bundled db -> fresh schema
  let bytes=await idbGet("db");
  let src="saved data";
  if(!bytes){
    try{ const res=await fetch(BUNDLED_DB,{cache:"no-store"});
      if(res.ok){ bytes=new Uint8Array(await res.arrayBuffer()); src="sample data"; } }catch(e){}
  }
  if(bytes){ db=new SQL.Database(bytes); }
  else { db=new SQL.Database(); src="new database"; }
  ensureSchema();
  await persist();
  document.getElementById("dbStatus").textContent="● Loaded ("+src+")";
  show("Dashboard");
}
boot();
