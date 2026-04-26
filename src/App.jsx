import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";

// ── Constants ────────────────────────────────────────────────────────────────
const PALETTE   = ["#22d3ee","#f59e0b","#a78bfa","#34d399","#fb7185","#60a5fa","#fbbf24","#4ade80"];
const TYPE_C    = {
  "Cổ phiếu":"#22d3ee","Cân bằng":"#f59e0b","Trái phiếu":"#a78bfa",
  "ETF":"#34d399","Index":"#fb7185","Global":"#f97316","—":"#6b7280"
};
const PRESETS   = [
  {l:"1M",m:1},{l:"3M",m:3},{l:"6M",m:6},{l:"YTD",ytd:true},
  {l:"1Y",m:12},{l:"2Y",m:24},{l:"3Y",m:36},{l:"5Y",m:60},{l:"7Y",m:84},{l:"10Y",m:120},{l:"ALL",all:true},
];
const TABS = ["📈 Chart","⚖️ So sánh","📅 Lợi nhuận năm","🎯 Rolling","⚡ Risk/Return","💰 DCA","🔄 LS vs DCA Stop","🏗️ Danh mục","₿ Bitcoin","🏆 Ranking"];

// ── Utils ────────────────────────────────────────────────────────────────────
const fmtD  = d => d.toISOString().split("T")[0];
const toVN  = s => { if(!s)return""; const [y,m,d]=s.split("-"); return `${d}/${m}/${y}`; };
const fmtN  = (v,dec=0) => v!=null?v.toLocaleString("vi-VN",{maximumFractionDigits:dec}):"—";
const fmtP  = v => v==null?"—":`${v>=0?"+":""}${v.toFixed(2)}%`;
const fmtP1 = v => v==null?"—":`${v>=0?"+":""}${v.toFixed(1)}%`;

function presetDates(p, firstDate) {
  const t = new Date();
  let f;
  if(p.all)  f = new Date(firstDate||"2000-01-01");
  else if(p.ytd) f = new Date(t.getFullYear(),0,1);
  else { f=new Date(t); f.setMonth(f.getMonth()-p.m); }
  return { f:fmtD(f), t:fmtD(t) };
}

// ── Parse raw item into unified {id, symbol, name, mgmt, type, data:[{date,close}]} ──
function parseItem(id, raw, isFund) {
  const data = (raw.data||[]).map(r => {
    const date  = isFund ? (r.navDate||r.date) : r.date;
    const close = isFund ? parseFloat(r.nav||0) : parseFloat(r.close||0);
    return date && close > 0 ? { date, close } : null;
  }).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date));
  return {
    id:     String(id),
    symbol: raw.symbol || id,
    name:   raw.name   || id,
    mgmt:   raw.mgmt   || "—",
    type:   raw.type   || "—",
    isFund,
    data,
  };
}

function calcStats(data) {
  if(!data?.length) return {};
  const cs = data.map(d=>d.close);
  const n0=cs[0], nN=cs[cs.length-1];
  const maxN=Math.max(...cs), minN=Math.min(...cs);
  const ret=(nN-n0)/n0*100;
  const days=(new Date(data[data.length-1].date)-new Date(data[0].date))/86400000;
  const cagr=days>0?(Math.pow(nN/n0,365/days)-1)*100:null;
  const changes=cs.slice(1).map((v,i)=>v/cs[i]-1);
  const mean=changes.reduce((a,b)=>a+b,0)/changes.length;
  const vol=Math.sqrt(changes.reduce((a,b)=>a+(b-mean)**2,0)/changes.length)*Math.sqrt(252)*100;
  const sharpe=cagr!=null&&vol>0?(cagr-5)/vol:null;
  let maxDD=0,peak=cs[0];
  cs.forEach(v=>{if(v>peak)peak=v;const dd=(v-peak)/peak*100;if(dd<maxDD)maxDD=dd;});
  return {ret,cagr,vol,sharpe,maxDD,maxN,minN,n0,nN,days};
}

// ── DCA helpers ──────────────────────────────────────────────────────────────
function runDCA(data, fromD, toD, amount, freq, initCap=0) {
  const d = (data||[]).filter(x=>x.date>=fromD&&x.date<=toD);
  if(!d.length) return {points:[],fin:{value:0,invested:0,units:0,avgNav:0},log:[]};
  const step = freq==="daily"?1:freq==="biweekly"?10:freq==="weekly"?5:21;
  // Initial capital invested on day 1
  let inv=initCap, units=initCap>0&&d[0].close>0?initCap/d[0].close:0;
  const points=[],log=[];
  if(initCap>0&&d[0]) log.push({date:d[0].date,nav:d[0].close,units:parseFloat(units.toFixed(4)),totalUnits:parseFloat(units.toFixed(4)),invested:inv,isInit:true});
  d.forEach((x,i)=>{
    const buy=i%step===0;
    if(buy){const u=amount/x.close;units+=u;inv+=amount;log.push({date:x.date,nav:x.close,units:parseFloat(u.toFixed(4)),totalUnits:parseFloat(units.toFixed(4)),invested:inv});}
    points.push({date:x.date,value:Math.round(units*x.close),invested:inv});
  });
  const last=points[points.length-1]||{value:0,invested:0};
  return {points,fin:{value:last.value,invested:last.invested,units:parseFloat(units.toFixed(4)),avgNav:units>0?last.invested/units:0},log};
}
function runLumpsum(data, fromD, toD, totalAmount) {
  const d=(data||[]).filter(x=>x.date>=fromD&&x.date<=toD);
  if(!d.length) return [];
  const units=totalAmount/d[0].close;
  return d.map(x=>({date:x.date,value:Math.round(units*x.close)}));
}
function runRollingDCA(data, holdMonths, amount, freq) {
  if(!data?.length) return [];
  const step=freq==="daily"?1:freq==="biweekly"?10:freq==="weekly"?5:21, holdDays=Math.round(holdMonths*21);
  const results=[];
  for(let start=0;start+holdDays<data.length;start+=21){
    const slice=data.slice(start,start+holdDays);
    let inv=0,units=0;
    slice.forEach((x,i)=>{if(i%step===0){units+=amount/x.close;inv+=amount;}});
    if(inv>0&&units>0){
      const finalVal=units*slice[slice.length-1].close;
      results.push({date:slice[0].date,roi:parseFloat(((finalVal-inv)/inv*100).toFixed(2)),finalVal,inv});
    }
  }
  return results;
}

// ── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#080c14;--surface:#0e1520;--border:#1a2235;--border2:#242f45;--txt:#e2e8f0;--muted:#64748b;--accent:#22d3ee;--accent2:#f59e0b}
body{background:var(--bg);color:var(--txt);font-family:'Space Grotesk',sans-serif}
.mono{font-family:'JetBrains Mono',monospace}
input[type=date]{background:var(--surface);border:1px solid var(--border2);color:var(--txt);border-radius:6px;padding:5px 10px;font-size:12px;outline:none;font-family:'JetBrains Mono',monospace}
input[type=date]:focus{border-color:var(--accent)}
input[type=number]{background:var(--surface);border:1px solid var(--border2);color:var(--txt);border-radius:6px;padding:6px 12px;font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;width={160}px}
input[type=number]:focus{border-color:var(--accent)}
.btn{background:transparent;border:1px solid var(--border2);color:var(--muted);border-radius:5px;padding:4px 11px;font-size:11px;cursor:pointer;transition:all .15s;font-family:'Space Grotesk',sans-serif;font-weight:500}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.on{background:rgba(34,211,238,.1);border-color:var(--accent);color:var(--accent);font-weight:600}
.btn.danger{border-color:#fb7185;color:#fb7185}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px}
.fc{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;cursor:pointer;transition:all .15s}
.fc:hover{border-color:var(--border2)}
.fc.sel{border-color:var(--accent);background:rgba(34,211,238,.06)}
.fc.cmp{border-color:var(--accent2);background:rgba(245,158,11,.06)}
.tab-btn{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--muted);padding:8px 12px;font-size:11px;cursor:pointer;transition:all .15s;font-weight:500;font-family:'Space Grotesk',sans-serif;white-space:nowrap}
.tab-btn.on{border-bottom-color:var(--accent);color:var(--txt)}
.sc{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;flex:1;min-width={90}px}
.badge{font-size:9px;padding:2px 7px;border-radius:20px;font-weight:600;letter-spacing:.04em;white-space:nowrap}
table{border-collapse:collapse;width={100}%}
th{text-align:left;padding:8px 12px;font-size:10px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);z-index:1;white-space:nowrap;font-family:'JetBrains Mono',monospace}
td{padding:7px 12px;font-size:12px;border-bottom:1px solid var(--bg);font-family:'JetBrains Mono',monospace}
tr:hover td{background:rgba(255,255,255,.02)}
.spin{width={28}px;height:28px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.uzone{border:2px dashed var(--border2);border-radius:14px;padding:44px 24px;text-align:center;cursor:pointer;transition:all .2s}
.uzone:hover{border-color:var(--accent);background:rgba(34,211,238,.03)}
::-webkit-scrollbar{width={4}px;height:4px}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
`;

const Tip = ({active,payload,label,fmt}) => {
  if(!active||!payload?.length) return null;
  return (
    <div style={{background:"#0e1520",border:"1px solid #1a2235",borderRadius:6,padding:"10px 14px",fontFamily:"'JetBrains Mono',monospace"}}>
      <div style={{color:"#64748b",fontSize:10,marginBottom:6}}>{toVN(label)||label}</div>
      {payload.map((p,i)=>(
        <div key={i} style={{color:p.color||"#22d3ee",fontSize:12,fontWeight:600,marginBottom:2}}>
          {p.name}: {fmt?fmt(p.value):fmtN(p.value)}
        </div>
      ))}
    </div>
  );
};

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [allItems, setAllItems] = useState({});  // id → parsed item
  const [loaded,   setLoaded]   = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [err,      setErr]      = useState("");

  const [selId,    setSelId]    = useState(null);
  const [cmpIds,   setCmpIds]   = useState([]);
  const [tab,      setTab]      = useState(0);
  const [preset,   setPreset]   = useState("1Y");
  const [from,     setFrom]     = useState("");
  const [to,       setTo]       = useState("");
  const [typeF,    setTypeF]    = useState("Tất cả");
  const [catF,     setCatF]     = useState("Tất cả"); // Quỹ / ETF/CP
  const [search,   setSearch]   = useState("");
  const fileRef = useRef();

  // ── Fetch global benchmarks (BTC, Gold, S&P500, Nasdaq, DJI) ─────────────
  // Global benchmarks are now fetched server-side by Python script
  const load = raw => {
    const out = {};
    // funds
    for(const [id, f] of Object.entries(raw.funds||{})) {
      const item = parseItem(id, f, true);
      if(item.data.length) out[id] = item;
    }
    // stocks/ETF
    for(const [id, f] of Object.entries(raw.stocks||{})) {
      const item = parseItem(id, f, false);
      if(item.data.length) out[id] = item;
    }
    if(!Object.keys(out).length) throw new Error("File không hợp lệ!");
    setAllItems(out);
    setLoaded(true); setErr("");
    const def = out["28"]?"28":Object.keys(out)[0];
    setSelId(def);
    const fd = out[def]?.data[0]?.date;
    const {f,t} = presetDates({l:"1Y",m:12}, fd);
    setFrom(f); setTo(t); setPreset("1Y");
  };

  const handleFile = e => {
    const file = e.target.files[0]; if(!file) return;
    setLoading(true);
    const r = new FileReader();
    r.onload = ev => { try{load(JSON.parse(ev.target.result));}catch(e){setErr(e.message);} finally{setLoading(false);} };
    r.readAsText(file);
  };

  // Auto-fetch từ Google Drive khi app load
  useEffect(()=>{
    const URLS = [
      "https://raw.githubusercontent.com/besthq2-tech/Quan-Tran-public-finance-research/main/data_vn_finance.json",
    ];
    (async()=>{
      setLoading(true); setErr("");
      for(const url of URLS){
        try{
          const res = await fetch(url);
          if(!res.ok) continue;
          const text = await res.text();
          if(!text.trim().startsWith("{")) continue;
          load(JSON.parse(text));
          setLoading(false);
          return;
        }catch(_){continue;}
      }
      setErr("Không tải được data từ Google Drive. Thử upload thủ công.");
      setLoading(false);
    })();
  },[]);

  const applyPreset = (p, pid) => {
    setPreset(p.l);
    const fd = (pid||selId) ? allItems[pid||selId]?.data[0]?.date : null;
    const {f,t} = presetDates(p, fd);
    setFrom(f); setTo(t);
  };

  const getFiltered = useCallback((id) => {
    const item = allItems[id]; if(!item) return [];
    return item.data.filter(d=>d.date>=from&&d.date<=to);
  }, [allItems,from,to]);

  // Overlap for compare
  const overlapFrom = useMemo(()=>{
    if(cmpIds.length<2) return from;
    return cmpIds.reduce((mx,id)=>{
      const first = allItems[id]?.data.find(x=>x.date>=from)?.date||from;
      return first>mx?first:mx;
    }, from);
  },[cmpIds,allItems,from]);

  const filteredOverlap = useCallback(id=>{
    const item=allItems[id]; if(!item) return [];
    return item.data.filter(d=>d.date>=overlapFrom&&d.date<=to);
  },[allItems,overlapFrom,to]);

  const selData = useMemo(()=>selId?getFiltered(selId):[],[selId,getFiltered]);
  const selItem = selId?allItems[selId]:null;
  const stats   = useMemo(()=>calcStats(selData),[selData]);

  // ── Filter list ───────────────────────────────────────────────────────────
  const ALL_TYPES = ["Tất cả","Cổ phiếu","Cân bằng","Trái phiếu","ETF","Index","Global"];
  const ALL_CATS  = ["Tất cả","Quỹ mở","Cổ phiếu","ETF","Global"];

  const itemList = useMemo(()=>
    Object.values(allItems)
      .filter(item => {
        if(catF==="Quỹ mở"   && !item.isFund) return false;
        if(catF==="ETF"      && item.type!=="ETF") return false;
        if(catF==="Global"   && item.type!=="Global") return false;
        if(catF==="Cổ phiếu" && (item.isFund||item.type==="ETF"||item.type==="Global"||item.type==="Index")) return false;
        // Sub-filter by rổ (mgmt field stores basket name)
        if(typeF==="VNDiamond" && !item.mgmt?.includes("Diamond")) return false;
        if(typeF==="VN30"      && !item.mgmt?.includes("VN30")) return false;
        if(typeF==="VNMidcap"  && !item.mgmt?.includes("VNMidcap")) return false;
        if(typeF==="Cân bằng"  && item.type!=="Cân bằng") return false;
        if(typeF==="Trái phiếu"&& item.type!=="Trái phiếu") return false;
        if(search){
          const q=search.toLowerCase();
          return item.symbol.toLowerCase().includes(q)||item.name.toLowerCase().includes(q)||item.mgmt.toLowerCase().includes(q);
        }
        return true;
      })
      .sort((a,b)=>{
        // Sort: fund theo NAV cuối, stock/ETF theo % return toàn thời gian
        const getRet = item => {
          const d = item.data;
          if(!d.length) return 0;
          return (d[d.length-1].close - d[0].close) / d[0].close * 100;
        };
        return getRet(b) - getRet(a);
      })
  ,[allItems,typeF,catF,search]);

  // ── Compare data ──────────────────────────────────────────────────────────
  const cmpData = useMemo(()=>{
    if(cmpIds.length<2) return [];
    const map={};
    cmpIds.forEach(id=>{
      const d=filteredOverlap(id); if(!d.length) return;
      const base=d[0].close;
      d.forEach(x=>{ if(!map[x.date])map[x.date]={date:x.date}; map[x.date][id]=parseFloat((x.close/base*100).toFixed(2)); });
    });
    return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));
  },[cmpIds,filteredOverlap]);

  // ── Annual returns ────────────────────────────────────────────────────────
  const annualData = useMemo(()=>{
    if(!selData.length) return [];
    const byY={};
    selData.forEach(d=>{const y=d.date.slice(0,4);byY[y]=byY[y]||[];byY[y].push(d.close);});
    const years=Object.keys(byY).sort();
    return years.map((y,i)=>{
      const prev=i>0?byY[years[i-1]][byY[years[i-1]].length-1]:null;
      const cur=byY[y][byY[y].length-1],first=byY[y][0];
      return {year:y,ret:parseFloat((prev?(cur-prev)/prev*100:(cur-first)/first*100).toFixed(2))};
    });
  },[selData]);

  // ── Rolling ───────────────────────────────────────────────────────────────
  const [rollM, setRollM] = useState(12);
  const rollData = useMemo(()=>{
    const step=Math.max(1,Math.floor(rollM*21/12));
    const out=[];
    for(let i=step;i<selData.length;i++){
      const p=selData[i-step],c=selData[i];
      out.push({date:c.date,ret:parseFloat(((c.close-p.close)/p.close*100).toFixed(2))});
    }
    return out;
  },[selData,rollM]);

  // ── Risk scatter ──────────────────────────────────────────────────────────
  const riskData = useMemo(()=>
    Object.values(allItems).map(item=>{
      const d=getFiltered(item.id);
      if(d.length<30) return null;
      // Chỉ include nếu item có data TỪ ĐẦU giai đoạn (không include quỹ sinh sau)
      const itemFirst = item.data[0]?.date || "9999";
      if(itemFirst > from) return null;
      const s=calcStats(d);
      return {name:item.symbol,x:parseFloat((s.vol||0).toFixed(2)),y:parseFloat((s.cagr||s.ret||0).toFixed(2)),type:item.type};
    }).filter(Boolean)
  ,[allItems,getFiltered,from]);

  // ── Heatmap ───────────────────────────────────────────────────────────────
  const heatData = useMemo(()=>{
    const allYears=new Set(), fundYears={};
    Object.values(allItems).forEach(item=>{
      const byY={};
      item.data.forEach(d=>{const y=d.date.slice(0,4);byY[y]=byY[y]||[];byY[y].push(d.close);});
      const ys=Object.keys(byY).sort(); fundYears[item.id]={};
      ys.forEach((y,i)=>{
        allYears.add(y);
        const prev=i>0?byY[ys[i-1]][byY[ys[i-1]].length-1]:null;
        const cur=byY[y][byY[y].length-1],first=byY[y][0];
        fundYears[item.id][y]=prev?(cur-prev)/prev*100:(cur-first)/first*100;
      });
    });
    return {years:[...allYears].sort(),fundYears};
  },[allItems]);

  function hmColor(v){
    if(v==null)return"#1a2235";
    if(v>30)return"#14532d";if(v>15)return"#166534";if(v>5)return"#15803d";if(v>0)return"#16a34a";
    if(v>-5)return"#dc2626";if(v>-15)return"#b91c1c";return"#7f1d1d";
  }

  const clr  = (stats.ret??0)>=0?"#22d3ee":"#fb7185";
  const priceFmt = selItem?.isFund ? "NAV" : "Giá";
  const priceUnit = selItem?.isFund ? "VND/CCQ" : "VND";

  // ── Loading screen ────────────────────────────────────────────────────────
  if(!loaded) return (
    <div style={{minHeight:"100vh",background:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <style>{CSS}</style>
      <div style={{textAlign:"center",maxWidth:420,padding:"0 24px",width:"100%"}}>
        <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--accent)",letterSpacing:".2em",marginBottom:16}}>TRẦN ĐỨC HỒNG QUÂN</div>
        <div style={{fontSize:20,fontWeight:700,marginBottom:20}}>Comprehensive Investing Research Tool</div>

        {loading
          ? <div style={{color:"var(--muted)",fontSize:12,fontFamily:"JetBrains Mono",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
              <div className="spin"/> Đang tải dữ liệu...
            </div>
          : <>
              {err&&<div style={{marginBottom:14,color:"#fb7185",fontSize:12,background:"rgba(251,113,133,.1)",border:"1px solid rgba(251,113,133,.3)",borderRadius:8,padding:"10px 14px"}}>⚠️ {err}</div>}
              <div style={{color:"var(--muted)",fontSize:12,marginBottom:10}}>Upload file để xem:</div>
              <div className="uzone" onClick={()=>fileRef.current?.click()}>
                <div style={{fontSize:28,marginBottom:8}}>📂</div>
                <div style={{fontSize:13,fontWeight:600,marginBottom:4}}>data_vn_finance.json</div>
                <div style={{fontSize:11,color:"var(--muted)"}}>Click để chọn file</div>
                <input ref={fileRef} type="file" accept=".json" style={{display:"none"}} onChange={handleFile}/>
              </div>
              <div style={{marginTop:12,fontSize:10,color:"#475569",fontFamily:"JetBrains Mono"}}>
                💡 Khi deploy lên Vercel sẽ tự động tải từ GitHub
              </div>
            </>
        }
      </div>
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:"var(--bg)",color:"var(--txt)",fontFamily:"'Space Grotesk',sans-serif"}}>
      <style>{CSS}</style>

      {/* HEADER */}
      <div style={{borderBottom:"1px solid var(--border)",padding:"12px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,background:"var(--bg)",zIndex:30}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:28,height:28,background:"linear-gradient(135deg,var(--accent),#818cf8)",borderRadius:7,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:"#080c14"}}>Q</div>
          <div>
            <span style={{fontWeight:700,fontSize:13}}>Comprehensive Investing Research</span>
            <span style={{color:"var(--muted)",fontSize:11,marginLeft:8}}>
              {Object.values(allItems).filter(x=>x.isFund).length} quỹ ·{" "}
              {Object.values(allItems).filter(x=>x.type==="ETF").length} ETF ·{" "}
              {Object.values(allItems).filter(x=>x.type==="Cổ phiếu").length} CP
              {Object.values(allItems).filter(x=>x.type==="Global").length>0&&<> · <span style={{color:"#f97316"}}>{Object.values(allItems).filter(x=>x.type==="Global").length} 🌍</span></>}
            </span>
          </div>
        </div>
        <button className="btn" onClick={()=>{setLoaded(false);setAllItems({});setSelId(null);setCmpIds([]);setErr("");}}>↩ Reload</button>
      </div>

      <div style={{display:"flex",height:"calc(100vh - 53px)"}}>

        {/* SIDEBAR — ẩn ở tab 5+ */}
        {tab<=4&&(
          <div style={{width:195,flexShrink:0,borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column",overflow:"hidden"}}>
            {/* Search + Category filter */}
            <div style={{padding:"7px 7px 4px",borderBottom:"1px solid var(--border)"}}>
              {/* Search */}
              <input
                placeholder="🔍 Tìm quỹ / mã CP..."
                value={search||""}
                onChange={e=>setSearch(e.target.value)}
                style={{width:"100%",boxSizing:"border-box",background:"var(--surface)",border:"1px solid var(--border2)",color:"var(--txt)",borderRadius:6,padding:"4px 8px",fontSize:10,fontFamily:"Space Grotesk",outline:"none",marginBottom:5}}
              />
              {/* Category */}
              <div style={{display:"flex",gap:3,marginBottom:4,flexWrap:"wrap"}}>
                {["Tất cả","Quỹ mở","Cổ phiếu","ETF","Global"].map(c=>(
                  <button key={c} className={`btn ${catF===c?"on":""}`} style={{fontSize:9,padding:"3px 6px"}} onClick={()=>{setCatF(c);setTypeF('Tất cả');}}>{c}</button>
                ))}
              </div>
              {/* Sub-filter by rổ (only for Cổ phiếu) */}
              {catF==="Cổ phiếu"&&(
                <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
                  {["VNDiamond","VN30","VNMidcap"].map(t=>(
                    <button key={t} className={`btn ${typeF===t?"on":""}`} style={{fontSize:9,padding:"3px 6px"}} onClick={()=>setTypeF(typeF===t?'Tất cả':t)}>{t}</button>
                  ))}
                </div>
              )}
              {/* Sub-filter for Quỹ mở */}
              {catF==="Quỹ mở"&&(
                <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
                  {["Cân bằng","Trái phiếu"].map(t=>(
                    <button key={t} className={`btn ${typeF===t?"on":""}`} style={{fontSize:9,padding:"3px 6px"}} onClick={()=>setTypeF(typeF===t?'Tất cả':t)}>{t}</button>
                  ))}
                </div>
              )}
            </div>
            {/* List */}
            <div style={{overflowY:"auto",flex:1,padding:"5px 7px",display:"flex",flexDirection:"column",gap:4}}>
              {itemList.map(item=>{
                const id=item.id;
                const d=item.data;
                const latN=d[d.length-1]?.close;
                const ret=d[0]?.close?((latN-d[0].close)/d[0].close*100):null;
                const days=d.length>1?(new Date(d[d.length-1].date)-new Date(d[0].date))/86400000:0;
                const cagr=days>365&&d[0].close>0?(Math.pow(latN/d[0].close,365/days)-1)*100:null;
                // Sharpe (rough): cagr / annualized vol
                const rets=d.slice(1).map((x,i)=>d[i].close>0?(x.close-d[i].close)/d[i].close:0);
                const avgR=rets.reduce((a,b)=>a+b,0)/(rets.length||1);
                const vol=rets.length>1?Math.sqrt(rets.reduce((a,b)=>a+(b-avgR)**2,0)/rets.length)*Math.sqrt(252):0;
                const sharpe=vol>0?(cagr||0)/100/vol:null;
                const firstYear=d[0]?.date?.slice(0,4)||"—";
                const isSel=selId===id&&tab!==1;
                const inCmp=cmpIds.includes(id);
                const cmpI=cmpIds.indexOf(id);
                const tc=TYPE_C[item.type]||"#6b7280";
                return (
                  <div key={id} className={`fc ${isSel?"sel":""} ${inCmp?"cmp":""}`}
                    onClick={()=>{
                      if(tab===1){
                        const newIds=cmpIds.includes(id)?cmpIds.filter(x=>x!==id):cmpIds.length<5?[...cmpIds,id]:cmpIds;
                        setCmpIds(newIds);
                        if(newIds.length>=2){
                          const lat=newIds.reduce((mx,i)=>{const d=allItems[i]?.data[0]?.date||"2000-01-01";return d>mx?d:mx;},"2000-01-01");
                          const {f,t}=presetDates({l:"ALL",all:true},lat); setFrom(f);setTo(t);setPreset("ALL");
                        }
                      } else {
                        setSelId(id); setTab(tab>4?0:tab);
                        const fd=item.data[0]?.date;
                        const {f,t}=presetDates({l:"1Y",m:12},fd); setFrom(f);setTo(t);setPreset("1Y");
                      }
                    }}>
                    <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                      {inCmp&&<div style={{width:7,height:7,borderRadius:1,background:PALETTE[cmpI],flexShrink:0}}/>}
                      <div style={{fontWeight:700,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.symbol}</div>
                      <span className="badge" style={{background:`${tc}20`,color:tc,border:`1px solid ${tc}40`,marginLeft:"auto",flexShrink:0}}>
                        {item.type==="Cổ phiếu"?"CP":item.type==="Trái phiếu"?"TP":item.type==="Cân bằng"?"CB":item.type}
                      </span>
                    </div>
                    <div style={{fontSize:9,color:"var(--muted)",marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.mgmt}</div>
                    <div style={{display:"flex",gap:6,marginTop:1}}>
                      {cagr!=null&&<span style={{fontSize:8,color:"#f59e0b",fontFamily:"JetBrains Mono"}}>CAGR {cagr>=0?"+":""}{cagr.toFixed(1)}%</span>}
                      {sharpe!=null&&<span style={{fontSize:8,color:"#a78bfa",fontFamily:"JetBrains Mono"}}>SR {sharpe.toFixed(2)}</span>}
                    </div>
                    <div style={{display:"flex",gap:6,marginTop:2}}>
                      {(()=>{
                        const mx=Math.max(...d.map(x=>x.close));
                        let peak=d[0]?.close||0,dd=0;
                        d.forEach(x=>{if(x.close>peak)peak=x.close;const cur=(x.close-peak)/peak*100;if(cur<dd)dd=cur;});
                        return dd<0?<span style={{fontSize:8,color:"#fb7185",fontFamily:"JetBrains Mono"}}>MDD {dd.toFixed(1)}%</span>:null;
                      })()}
                      <span style={{fontSize:8,color:"var(--muted)",fontFamily:"JetBrains Mono",marginLeft:"auto"}}>từ {firstYear}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* MAIN */}
        <div style={{flex:1,overflow:"auto",display:"flex",flexDirection:"column"}}>
          {/* TABS */}
          <div style={{borderBottom:"1px solid var(--border)",display:"flex",overflow:"auto",flexShrink:0}}>
            {TABS.map((t,i)=>(
              <button key={i} className={`tab-btn ${tab===i?"on":""}`} onClick={()=>setTab(i)}>{t}</button>
            ))}
          </div>

          <div style={{flex:1,overflow:"auto",padding:"12px 14px"}}>

            {/* DATE BAR */}
            {tab<=4&&(
              <div className="card" style={{padding:"9px 12px",marginBottom:10,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                  {PRESETS.map(p=>(
                    <button key={p.l} className={`btn ${preset===p.l?"on":""}`} onClick={()=>{
                      setPreset(p.l);
                      if(tab===1&&cmpIds.length>=2){
                        const lat=cmpIds.reduce((mx,id)=>{const d=allItems[id]?.data[0]?.date||"2000-01-01";return d>mx?d:mx;},"2000-01-01");
                        const {f,t}=presetDates(p,lat);setFrom(f);setTo(t);
                      } else { applyPreset(p,selId); }
                    }}>{p.l}</button>
                  ))}
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center",marginLeft:"auto"}}>
                  <input type="date" value={from} onChange={e=>{setFrom(e.target.value);setPreset(null);}}/>
                  <span style={{color:"var(--muted)",fontSize:11}}>→</span>
                  <input type="date" value={to} onChange={e=>{setTo(e.target.value);setPreset(null);}}/>
                  {tab===1&&cmpIds.length>=2&&(overlapFrom>from)&&(
                    <span style={{color:"#f59e0b",fontSize:10,fontFamily:"JetBrains Mono"}}>↑ overlap {toVN(overlapFrom)}</span>
                  )}
                </div>
              </div>
            )}

            {/* ══ TAB 0: CHART ══ */}
            {tab===0&&selItem&&(
              <>
                <div className="card" style={{padding:"12px 16px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                      <span style={{fontWeight:700,fontSize:17}}>{selItem.symbol}</span>
                      <span className="badge" style={{background:`${TYPE_C[selItem.type]||"#6b7280"}20`,color:TYPE_C[selItem.type]||"#6b7280",border:`1px solid ${TYPE_C[selItem.type]||"#6b7280"}40`}}>{selItem.type}</span>
                      <span className="badge" style={{background:"rgba(100,116,139,.15)",color:"var(--muted)",border:"1px solid rgba(100,116,139,.2)"}}>{selItem.isFund?"Quỹ mở":"Stock/ETF"}</span>
                    </div>
                    <div style={{color:"var(--muted)",fontSize:12}}>{selItem.name} · {selItem.mgmt}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div className="mono" style={{fontSize:20,fontWeight:700}}>{fmtN(stats.nN)}</div>
                    <div style={{fontSize:11,color:"var(--muted)"}}>{priceUnit} · {toVN(selData[selData.length-1]?.date)}</div>
                  </div>
                </div>

                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                  {[
                    {l:"Sinh lời",v:fmtP(stats.ret),c:(stats.ret??0)>=0?"#22d3ee":"#fb7185"},
                    {l:"CAGR",v:fmtP1(stats.cagr),c:(stats.cagr??0)>=0?"#22d3ee":"#fb7185"},
                    {l:"Volatility",v:fmtP1(stats.vol),c:"#f59e0b"},
                    {l:"Sharpe",v:stats.sharpe!=null?stats.sharpe.toFixed(2):"—",c:(stats.sharpe||0)>=1?"#22d3ee":(stats.sharpe||0)>=0?"#f59e0b":"#fb7185"},
                    {l:"Max DD",v:fmtP1(stats.maxDD),c:"#fb7185"},
                    {l:`${priceFmt} Max`,v:fmtN(stats.maxN),c:"var(--txt)"},
                  ].map(s=>(
                    <div key={s.l} className="sc">
                      <div style={{fontSize:9,color:"var(--muted)",letterSpacing:".1em",textTransform:"uppercase",marginBottom:6,fontFamily:"JetBrains Mono"}}>{s.l}</div>
                      <div className="mono" style={{fontSize:13,fontWeight:700,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>

                <div className="card" style={{padding:"14px 4px 10px",marginBottom:10}}>
                  <ResponsiveContainer width="100%" height={280}>
                    <AreaChart data={selData} margin={{top:6,right:6,bottom:0,left:0}}>
                      <defs>
                        <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={clr} stopOpacity={.2}/>
                          <stop offset="95%" stopColor={clr} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
                      <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false}
                        tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
                      <YAxis domain={["auto","auto"]} tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false}
                        tickFormatter={v=>(v/1000).toFixed(0)+"k"} width={42}/>
                      <Tooltip content={<Tip/>}/>
                      <Area type="monotone" dataKey="close" name={priceFmt} stroke={clr} strokeWidth={1.5} fill="url(#ag)" dot={false}
                        activeDot={{r:4,fill:clr,stroke:"#080c14",strokeWidth:2}}/>
                    </AreaChart>
                  </ResponsiveContainer>
                  <div style={{textAlign:"center",color:"var(--muted)",fontSize:10,marginTop:6}}>
                    {toVN(selData[0]?.date)} → {toVN(selData[selData.length-1]?.date)}
                  </div>
                </div>

                {/* Table */}
                <div className="card" style={{overflow:"hidden",maxHeight:300,overflowY:"auto"}}>
                  <table>
                    <thead><tr>
                      <th>#</th><th>Ngày</th>
                      <th style={{textAlign:"right"}}>{priceFmt}</th>
                      <th style={{textAlign:"right"}}>Δ</th>
                      <th style={{textAlign:"right"}}>Δ %</th>
                    </tr></thead>
                    <tbody>
                      {[...selData].reverse().map((row,i,arr)=>{
                        const prev=arr[i+1];
                        const chg=prev?row.close-prev.close:null;
                        const pct=prev?(chg/prev.close)*100:null;
                        const up=(chg||0)>=0;
                        return (
                          <tr key={row.date}>
                            <td style={{color:"var(--muted)"}}>{selData.length-i}</td>
                            <td style={{color:"#94a3b8"}}>{toVN(row.date)}</td>
                            <td style={{textAlign:"right",fontWeight:600}}>{fmtN(row.close)}</td>
                            <td style={{textAlign:"right",color:chg==null?"var(--muted)":up?"#22d3ee":"#fb7185"}}>{chg==null?"—":`${up?"+":""}${fmtN(chg)}`}</td>
                            <td style={{textAlign:"right",color:pct==null?"var(--muted)":up?"#22d3ee":"#fb7185"}}>{pct==null?"—":fmtP(pct)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* ══ TAB 1: SO SÁNH ══ */}
            {tab===1&&(
              <>
                <div className="card" style={{padding:"10px 14px",marginBottom:10}}>
                  <div style={{fontWeight:600,fontSize:13,marginBottom:6}}>⚖️ Chọn 2–5 items để so sánh (quỹ, ETF, CP đều được)</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                    {cmpIds.length===0?"← Tap vào sidebar":cmpIds.map((id,i)=>(
                      <span key={id} style={{display:"inline-flex",alignItems:"center",gap:4,background:`${PALETTE[i]}20`,border:`1px solid ${PALETTE[i]}40`,borderRadius:4,padding:"2px 8px",fontSize:11,color:PALETTE[i],fontWeight:600}}>
                        <span style={{width:6,height:6,borderRadius:1,background:PALETTE[i]}}/>
                        {allItems[id]?.symbol}
                        <span style={{cursor:"pointer",opacity:.6}} onClick={()=>setCmpIds(p=>p.filter(x=>x!==id))}>✕</span>
                      </span>
                    ))}
                    {cmpIds.length>0&&<button className="btn danger" style={{fontSize:10}} onClick={()=>setCmpIds([])}>Xóa hết</button>}
                  </div>
                  {cmpIds.length>=2&&(overlapFrom>from)&&(
                    <div style={{marginTop:8,fontSize:11,color:"#f59e0b",fontFamily:"JetBrains Mono"}}>
                      ⚠️ Overlap từ {toVN(overlapFrom)} (ngày bắt đầu muộn nhất)
                    </div>
                  )}
                </div>

                {cmpIds.length>=2&&cmpData.length>0?(
                  <>
                    <div className="card" style={{padding:"14px 4px 10px",marginBottom:10}}>
                      <div style={{color:"var(--muted)",fontSize:10,textAlign:"center",marginBottom:6,fontFamily:"JetBrains Mono"}}>Chuẩn hóa về 100 tại điểm bắt đầu</div>
                      <ResponsiveContainer width="100%" height={280}>
                        <LineChart data={cmpData} margin={{top:6,right:6,bottom:0,left:0}}>
                          <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
                          <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false}
                            tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
                          <YAxis tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} width={38}/>
                          <Tooltip content={<Tip fmt={v=>`${v?.toFixed(1)}`}/>}/>
                          <ReferenceLine y={100} stroke="#1a2235" strokeDasharray="4 4"/>
                          {cmpIds.map((id,i)=>(
                            <Line key={id} type="monotone" dataKey={id} name={allItems[id]?.symbol}
                              stroke={PALETTE[i]} strokeWidth={1.5} dot={false} connectNulls activeDot={{r:4}}/>
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="card" style={{overflow:"auto"}}>
                      <table>
                        <thead><tr>
                          <th>Symbol</th><th>Loại</th><th>Nguồn</th>
                          <th style={{textAlign:"right"}}>Giá/NAV</th>
                          <th style={{textAlign:"right"}}>Sinh lời kỳ</th>
                          <th style={{textAlign:"right"}}>CAGR</th>
                          <th style={{textAlign:"right"}}>Volatility</th>
                          <th style={{textAlign:"right"}}>Sharpe</th>
                          <th style={{textAlign:"right"}}>Max DD</th>
                        </tr></thead>
                        <tbody>
                          {cmpIds.map((id,i)=>{
                            const fd=filteredOverlap(id), item=allItems[id], s=calcStats(fd);
                            const tc=TYPE_C[item.type]||"#6b7280";
                            return (
                              <tr key={id}>
                                <td><div style={{display:"flex",alignItems:"center",gap:6}}>
                                  <div style={{width:8,height:8,borderRadius:2,background:PALETTE[i]}}/>
                                  <span style={{fontWeight:700}}>{item.symbol}</span>
                                </div></td>
                                <td><span className="badge" style={{background:`${tc}20`,color:tc,border:`1px solid ${tc}40`}}>{item.type}</span></td>
                                <td style={{color:"var(--muted)"}}>{item.isFund?"Quỹ mở":"ETF/CP"}</td>
                                <td style={{textAlign:"right"}}>{fmtN(s.nN)}</td>
                                <td style={{textAlign:"right",color:(s.ret??0)>=0?"#22d3ee":"#fb7185"}}>{fmtP(s.ret)}</td>
                                <td style={{textAlign:"right",color:(s.cagr??0)>=0?"#22d3ee":"#fb7185"}}>{fmtP1(s.cagr)}</td>
                                <td style={{textAlign:"right",color:"#f59e0b"}}>{fmtP1(s.vol)}</td>
                                <td style={{textAlign:"right",color:(s.sharpe||0)>=1?"#22d3ee":(s.sharpe||0)>=0?"#f59e0b":"#fb7185"}}>{s.sharpe!=null?s.sharpe.toFixed(2):"—"}</td>
                                <td style={{textAlign:"right",color:"#fb7185"}}>{fmtP1(s.maxDD)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                ):(
                  <div style={{textAlign:"center",color:"var(--muted)",padding:"60px 0"}}>Chọn ít nhất 2 items</div>
                )}
              </>
            )}

            {/* ══ TAB 2: LỢI NHUẬN NĂM ══ */}
            {tab===2&&selItem&&(
              <>
                <div style={{marginBottom:10,fontWeight:600,fontSize:14}}>{selItem.symbol} — Lợi nhuận từng năm</div>
                <div className="card" style={{padding:"14px 4px 10px",marginBottom:12}}>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={annualData} margin={{top:6,right:6,bottom:0,left:0}}>
                      <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
                      <XAxis dataKey="year" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false}/>
                      <YAxis tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>v+"%"} width={42}/>
                      <Tooltip content={<Tip fmt={v=>`${v?.toFixed(2)}%`}/>}/>
                      <ReferenceLine y={0} stroke="#1a2235"/>
                      <Bar dataKey="ret" name="Lợi nhuận" radius={[3,3,0,0]}>
                        {annualData.map((e,i)=><Cell key={i} fill={e.ret>=0?"#22d3ee":"#fb7185"}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {/* Heatmap */}
                <div style={{marginBottom:8,fontWeight:600,fontSize:12}}>Heatmap — Tất cả</div>
                <div className="card" style={{overflow:"auto",padding:14}}>
                  <div style={{display:"grid",gridTemplateColumns:`120px repeat(${heatData.years.length},50px)`,gap:3,minWidth:"max-content"}}>
                    <div/>
                    {heatData.years.map(y=><div key={y} style={{fontSize:10,color:"var(--muted)",fontFamily:"JetBrains Mono",textAlign:"center",padding:"3px 0"}}>{y}</div>)}
                    {Object.values(allItems).map(item=>(
                      <>
                        <div key={`l${item.id}`} style={{fontSize:10,fontWeight:600,display:"flex",alignItems:"center",paddingRight:6,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.symbol}</div>
                        {heatData.years.map(y=>{
                          const v=heatData.fundYears[item.id]?.[y];
                          return <div key={y} style={{width:50,height:32,borderRadius:4,background:hmColor(v),display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:600,fontFamily:"JetBrains Mono",color:v==null?"transparent":"#fff"}}>
                            {v!=null?`${v>0?"+":""}${v.toFixed(0)}%`:""}
                          </div>;
                        })}
                      </>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ══ TAB 3: ROLLING ══ */}
            {tab===3&&selItem&&(
              <>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10,flexWrap:"wrap"}}>
                  <span style={{fontWeight:600,fontSize:13}}>{selItem.symbol} — Rolling {rollM}M</span>
                  <div style={{display:"flex",gap:4}}>
                    {[3,6,12,24,36].map(m=>(
                      <button key={m} className={`btn ${rollM===m?"on":""}`} onClick={()=>setRollM(m)}>{m}M</button>
                    ))}
                  </div>
                </div>
                <div className="card" style={{padding:"14px 4px 10px",marginBottom:10}}>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={rollData} margin={{top:6,right:6,bottom:0,left:0}}>
                      <defs>
                        <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#22d3ee" stopOpacity={.15}/><stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
                      <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false}
                        tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
                      <YAxis tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>v+"%"} width={42}/>
                      <Tooltip content={<Tip fmt={v=>`${v?.toFixed(2)}%`}/>}/>
                      <ReferenceLine y={0} stroke="#1a2235" strokeDasharray="4 4"/>
                      <Area type="monotone" dataKey="ret" name={`${rollM}M return`} stroke="#22d3ee" strokeWidth={1.5} fill="url(#rg)" dot={false}
                        activeDot={{r:4,fill:"#22d3ee",stroke:"#080c14",strokeWidth:2}}/>
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                {(()=>{
                  const rets=rollData.map(d=>d.ret); if(!rets.length) return null;
                  const pos=rets.filter(r=>r>0).length, avg=rets.reduce((a,b)=>a+b,0)/rets.length;
                  return (
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      {[{l:"TB",v:fmtP1(avg),c:avg>=0?"#22d3ee":"#fb7185"},{l:"Tốt nhất",v:fmtP1(Math.max(...rets)),c:"#22d3ee"},{l:"Tệ nhất",v:fmtP1(Math.min(...rets)),c:"#fb7185"},{l:"% kỳ dương",v:`${(pos/rets.length*100).toFixed(0)}%`,c:"#f59e0b"}].map(s=>(
                        <div key={s.l} className="sc">
                          <div style={{fontSize:9,color:"var(--muted)",letterSpacing:".1em",textTransform:"uppercase",marginBottom:6,fontFamily:"JetBrains Mono"}}>{s.l}</div>
                          <div className="mono" style={{fontSize:13,fontWeight:700,color:s.c}}>{s.v}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </>
            )}

            {/* ══ TAB 4: RISK/RETURN ══ */}
            {tab===4&&(
              <>
                <div style={{marginBottom:10,fontWeight:600,fontSize:13}}>⚡ Risk vs Return — tất cả items trong kỳ</div>
                <div className="card" style={{padding:"14px 4px 10px",marginBottom:10}}>
                  <ResponsiveContainer width="100%" height={320}>
                    <ScatterChart margin={{top:8,right:20,bottom:20,left:0}}>
                      <CartesianGrid stroke="#1a2235" strokeDasharray="3 3"/>
                      <XAxis type="number" dataKey="x" name="Volatility" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>v+"%"} label={{value:"Volatility (%)",position:"insideBottom",offset:-10,fill:"#64748b",fontSize:11}}/>
                      <YAxis type="number" dataKey="y" name="CAGR" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>v+"%"} width={42} label={{value:"CAGR (%)",angle:-90,position:"insideLeft",fill:"#64748b",fontSize:11}}/>
                      <Tooltip content={({active,payload})=>{
                        if(!active||!payload?.length) return null;
                        const d=payload[0]?.payload;
                        return (
                          <div style={{background:"#0e1520",border:"1px solid #1a2235",borderRadius:6,padding:"10px 14px",fontFamily:"JetBrains Mono"}}>
                            <div style={{fontWeight:700,marginBottom:4}}>{d?.name}</div>
                            <div style={{color:"#f59e0b",fontSize:12}}>Vol: {d?.x}%</div>
                            <div style={{color:"#22d3ee",fontSize:12}}>CAGR: {d?.y}%</div>
                          </div>
                        );
                      }}/>
                      <ReferenceLine y={0} stroke="#1a2235" strokeDasharray="4 4"/>
                      <Scatter data={riskData} shape={props=>{
                        const {cx,cy,payload}=props;
                        const c=TYPE_C[payload.type]||"#6b7280";
                        return (
                          <g>
                            <circle cx={cx} cy={cy} r={6} fill={`${c}40`} stroke={c} strokeWidth={1.5}/>
                            <text x={cx} y={cy-10} textAnchor="middle" fill={c} fontSize={8} fontFamily="JetBrains Mono" fontWeight={600}>{payload.name}</text>
                          </g>
                        );
                      }}/>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}

            {/* ══ TABs 5-8 ══ */}
            {tab===5&&selItem&&<DCAPanel item={selItem} allItems={allItems}/>}
            {tab===6&&selItem&&<LSDCAStopPanel item={selItem} allItems={allItems}/>}
            {tab===7&&<PortfolioPanel allItems={allItems}/>}
            {tab===8&&<BitcoinPanel/>}
            {tab===9&&<RankingPanel allItems={allItems}/>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── DCA helpers (shared) ─────────────────────────────────────────────────────
// ── Shared period preset helper ──────────────────────────────────────────────
const PERIOD_PRESETS = [
  {l:"3Y", y:3},{l:"5Y", y:5},{l:"7Y", y:7},{l:"10Y", y:10},
  {l:"12.5Y", y:12.5},{l:"15Y", y:15},{l:"ALL", y:null},{l:"Tùy chọn", y:"custom"}
];

function periodDates(preset, customFrom, customTo) {
  const to = fmtD(new Date());
  if(!preset || preset.y === null) return {fromD:"2000-01-01", toD:to};
  if(preset.y === "custom")        return {fromD:customFrom,   toD:customTo};
  const f = new Date(); f.setFullYear(f.getFullYear() - preset.y);
  return {fromD:fmtD(f), toD:to};
}

function PeriodBar({preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo}) {
  return (
    <div style={{marginBottom:10}}>
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:preset?.y==="custom"?8:0}}>
        {PERIOD_PRESETS.map(p=>(
          <button key={p.l} className={`btn ${preset?.l===p.l?"on":""}`} style={{fontSize:10,padding:"3px 8px"}}
            onClick={()=>setPreset(p)}>{p.l}</button>
        ))}
      </div>
      {preset?.y==="custom"&&(
        <div style={{display:"flex",gap:8,alignItems:"center",marginTop:6}}>
          <input type="date" value={customFrom} onChange={e=>setCustomFrom(e.target.value)} style={{fontSize:11}}/>
          <span style={{color:"var(--muted)"}}>→</span>
          <input type="date" value={customTo}   onChange={e=>setCustomTo(e.target.value)}   style={{fontSize:11}}/>
        </div>
      )}
    </div>
  );
}

function ItemSelect({label, value, onChange, allItems, exclude=[]}) {
  return (
    <div>
      <div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>{label}</div>
      <select value={value||""} onChange={e=>onChange(e.target.value||null)}
        style={{background:"var(--surface)",border:"1px solid var(--border2)",color:"var(--txt)",borderRadius:6,padding:"5px 8px",fontSize:11,fontFamily:"Space Grotesk",outline:"none",maxWidth:200}}>
        {label!=="So sánh"&&<option value="">— Chọn —</option>}
        {label==="So sánh"&&<option value="">— Không —</option>}
        {Object.values(allItems).filter(x=>!exclude.includes(x.id)).map(x=>(
          <option key={x.id} value={x.id}>{x.symbol} — {x.type}</option>
        ))}
      </select>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  TAB 5: DCA Panel
// ════════════════════════════════════════════════════════════════
function DCAPanel({ item, allItems }) {
  const [itemId,    setItemId]    = useState(item.id);
  const [amountM,   setAmountM]   = useState(1);      // triệu VND
  const [initCapM,  setInitCapM]  = useState(0);      // vốn đầu tiên, triệu VND
  const [freq,      setFreq]      = useState("monthly");
  const [preset,    setPreset]    = useState({l:"5Y",y:5});
  const [customFrom,setCustomFrom]=useState(()=>{const t=new Date();t.setFullYear(t.getFullYear()-5);return fmtD(t);});
  const [customTo,  setCustomTo]  = useState(fmtD(new Date()));
  const [cmpId,     setCmpId]     = useState(null);
  const [dcaTab,    setDcaTab]    = useState(0);
  const [holdM,     setHoldM]     = useState(36);

  const amount  = amountM  * 1_000_000;
  const initCap = initCapM * 1_000_000;

  // Sync itemId nếu sidebar đổi
  useEffect(()=>setItemId(item.id),[item.id]);

  const selItem = allItems[itemId] || item;
  const cmpItem = cmpId ? allItems[cmpId] : null;

  const {fromD:rawFrom, toD} = useMemo(()=>periodDates(preset,customFrom,customTo),[preset,customFrom,customTo]);

  // Clamp fromD to item's actual first data date
  const itemFirst  = selItem.data[0]?.date || rawFrom;
  const fromD      = rawFrom > itemFirst ? rawFrom : itemFirst;

  // Overlap khi có cmpId
  const overlapFrom = useMemo(()=>{
    if(!cmpId) return fromD;
    const cmpFirst = (cmpItem?.data||[]).find(x=>x.date>=fromD)?.date || fromD;
    const mainFirst= (selItem.data||[]).find(x=>x.date>=fromD)?.date || fromD;
    return cmpFirst>mainFirst?cmpFirst:mainFirst;
  },[cmpId,cmpItem,selItem,fromD]);
  const ef = cmpId ? overlapFrom : fromD;

  const r1    = useMemo(()=>runDCA(selItem.data,ef,toD,amount,freq,initCap),[selItem,ef,toD,amount,freq,initCap]);
  const r1All = useMemo(()=>runDCA(selItem.data,fromD,toD,amount,freq,initCap),[selItem,fromD,toD,amount,freq,initCap]);
  const r2    = useMemo(()=>cmpId?runDCA(cmpItem?.data,overlapFrom,toD,amount,freq,initCap):{points:[],fin:{value:0,invested:0}},[cmpId,cmpItem,overlapFrom,toD,amount,freq,initCap]);
  const ls    = useMemo(()=>runLumpsum(selItem.data,ef,toD,r1.fin.invested),[selItem,ef,toD,r1.fin.invested]);
  const roll  = useMemo(()=>runRollingDCA(selItem.data,holdM,amount,freq),[selItem,holdM,amount,freq]);

  const {fin:f1}=r1,{fin:f2}=r2;
  const roi1=f1.invested>0?(f1.value-f1.invested)/f1.invested*100:0;
  const roi2=f2.invested>0?(f2.value-f2.invested)/f2.invested*100:0;
  const lsFin=ls[ls.length-1], lsRoi=lsFin&&f1.invested>0?(lsFin.value-f1.invested)/f1.invested*100:null;
  const fmtM=v=>(v/1e6).toFixed(2)+"M";
  const cagr1=(()=>{const d=(new Date(toD)-new Date(ef))/86400000;return d>0?(Math.pow(f1.value/f1.invested,365/d)-1)*100:null;})();

  const rollStats=useMemo(()=>{
    if(!roll.length) return null;
    const rets=roll.map(r=>r.roi),pos=rets.filter(r=>r>0).length;
    return {avg:rets.reduce((a,b)=>a+b,0)/rets.length,best:Math.max(...rets),bestDate:roll[rets.indexOf(Math.max(...rets))]?.date,worst:Math.min(...rets),worstDate:roll[rets.indexOf(Math.min(...rets))]?.date,pctPos:pos/rets.length*100,count:rets.length};
  },[roll]);

  const merged=useMemo(()=>{
    const map={};
    // Filter to >= ef to prevent pre-overlap data leaking into chart
    r1.points.forEach(p=>{if(p.date<ef)return;if(!map[p.date])map[p.date]={date:p.date};map[p.date].dca=p.value;map[p.date].inv=p.invested;});
    r2.points.forEach(p=>{if(p.date<ef)return;if(!map[p.date])map[p.date]={date:p.date};map[p.date].cmp=p.value;});
    ls.forEach(p=>{if(p.date<ef)return;if(!map[p.date])map[p.date]={date:p.date};map[p.date].ls=p.value;});
    return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));
  },[r1,r2,ls,ef]);

  const sc=(l,v,c)=><div key={l} className="sc"><div style={{fontSize:9,color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:6,fontFamily:"JetBrains Mono"}}>{l}</div><div className="mono" style={{fontSize:13,fontWeight:700,color:c}}>{v}</div></div>;

  return (
    <div>
      {/* Controls */}
      <div className="card" style={{padding:"12px 14px",marginBottom:10,display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-end"}}>
        <ItemSelect label="Quỹ / ETF / CP" value={itemId} onChange={v=>{if(v)setItemId(v);}} allItems={allItems}/>
        <div>
          <div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Vốn đầu tiên (triệu ₫)</div>
          <input type="number" value={initCapM} onChange={e=>setInitCapM(Math.max(0,Number(e.target.value)))} step={1} min={0} style={{width:90}}/>
        </div>
        <div>
          <div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Mỗi kỳ (triệu ₫)</div>
          <input type="number" value={amountM} onChange={e=>setAmountM(Math.max(0,Number(e.target.value)))} step={0.5} min={0} style={{width:80}}/>
        </div>
        <div>
          <div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Tần suất</div>
          <div style={{display:"flex",gap:3}}>{[["daily","Ngày"],["biweekly","2T"],["weekly","Tuần"],["monthly","Tháng"]].map(([v,l])=><button key={v} className={`btn ${freq===v?"on":""}`} style={{fontSize:10,padding:"3px 7px"}} onClick={()=>setFreq(v)}>{l}</button>)}</div>
        </div>
        <ItemSelect label="So sánh" value={cmpId} onChange={setCmpId} allItems={allItems} exclude={[itemId]}/>
      </div>
      <div className="card" style={{padding:"10px 14px",marginBottom:10}}>
        <PeriodBar preset={preset} setPreset={setPreset} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo}/>
        <div style={{fontSize:10,color:"var(--muted)",fontFamily:"JetBrains Mono"}}>
          {toVN(ef)} → {toVN(toD)}
          {cmpId&&(overlapFrom>fromD)&&<span style={{color:"#f59e0b",marginLeft:10}}>⚠️ Overlap từ {toVN(overlapFrom)} ({cmpItem?.symbol} bắt đầu muộn hơn)</span>}
          {itemFirst>rawFrom&&!cmpId&&<span style={{color:"#f59e0b",marginLeft:10}}>⚠️ {selItem.symbol} chỉ có data từ {toVN(itemFirst)}</span>}
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{borderBottom:"1px solid var(--border)",marginBottom:10,display:"flex"}}>
        {["📊 Simulator","⚖️ vs Lump Sum","🎲 Rolling DCA","📋 Nhật ký"].map((t,i)=>(
          <button key={i} className="tab-btn" style={{fontSize:11,...(dcaTab===i?{borderBottomColor:"var(--accent)",color:"var(--txt)"}:{})}} onClick={()=>setDcaTab(i)}>{t}</button>
        ))}
      </div>

      {dcaTab===0&&(
        <>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            {[["Đầu tư",fmtM(f1.invested),"var(--muted)"],["Giá trị",fmtM(f1.value),"#22d3ee"],["ROI",(roi1>=0?"+":"")+roi1.toFixed(2)+"%",roi1>=0?"#22d3ee":"#fb7185"],["CAGR",cagr1!=null?(cagr1>=0?"+":"")+cagr1.toFixed(1)+"%":"—","#f59e0b"],
              ...(cmpItem?[[""+cmpItem.symbol+" ROI",(roi2>=0?"+":"")+roi2.toFixed(2)+"%",roi2>=0?"#a78bfa":"#fb7185"]]:[])]
              .map(([l,v,c])=>sc(l,v,c))}
          </div>
          <div className="card" style={{padding:"14px 4px 10px"}}>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={merged} margin={{top:6,right:6,bottom:0,left:0}}>
                <defs>
                  <linearGradient id="dg1" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22d3ee" stopOpacity={.15}/><stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/></linearGradient>
                  <linearGradient id="dg2" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#a78bfa" stopOpacity={.12}/><stop offset="95%" stopColor="#a78bfa" stopOpacity={0}/></linearGradient>
                  <linearGradient id="dgi" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#64748b" stopOpacity={.08}/><stop offset="95%" stopColor="#64748b" stopOpacity={0}/></linearGradient>
                </defs>
                <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
                <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
                <YAxis tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>(v/1e6).toFixed(0)+"M"} width={38}/>
                <Tooltip formatter={(v,n)=>[fmtM(v)+"M",n]} labelFormatter={l=>toVN(l)} contentStyle={{background:"#0e1520",border:"1px solid #1a2235",borderRadius:6,fontFamily:"JetBrains Mono",fontSize:12}}/>
                <Area type="monotone" dataKey="inv" name="Đầu tư" stroke="#475569" strokeWidth={1} fill="url(#dgi)" dot={false}/>
                <Area type="monotone" dataKey="dca" name={"DCA "+selItem.symbol} stroke="#22d3ee" strokeWidth={1.5} fill="url(#dg1)" dot={false}/>
                {cmpItem&&<Area type="monotone" dataKey="cmp" name={"DCA "+cmpItem.symbol} stroke="#a78bfa" strokeWidth={1.5} fill="url(#dg2)" dot={false}/>}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {dcaTab===1&&(
        <>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            {[["DCA ROI",(roi1>=0?"+":"")+roi1.toFixed(2)+"%",roi1>=0?"#22d3ee":"#fb7185"],
              ["Lump Sum ROI",lsRoi!=null?(lsRoi>=0?"+":"")+lsRoi.toFixed(2)+"%":"—",(lsRoi||0)>=0?"#f59e0b":"#fb7185"],
              ["DCA hơn/kém",lsRoi!=null?(roi1-lsRoi>=0?"+":"")+(roi1-lsRoi).toFixed(2)+"%":"—",(roi1-(lsRoi||0))>=0?"#22d3ee":"#fb7185"]]
              .map(([l,v,c])=>sc(l,v,c))}
          </div>
          <div className="card" style={{padding:"14px 4px 10px"}}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={merged} margin={{top:6,right:6,bottom:0,left:0}}>
                <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
                <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
                <YAxis tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>(v/1e6).toFixed(0)+"M"} width={38}/>
                <Tooltip formatter={(v,n)=>[fmtM(v)+"M",n]} labelFormatter={l=>toVN(l)} contentStyle={{background:"#0e1520",border:"1px solid #1a2235",borderRadius:6,fontFamily:"JetBrains Mono",fontSize:12}}/>
                <Line type="monotone" dataKey="dca" name={"DCA "+selItem.symbol} stroke="#22d3ee" strokeWidth={1.5} dot={false} connectNulls/>
                <Line type="monotone" dataKey="ls" name="Lump Sum" stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls/>
                <Line type="monotone" dataKey="inv" name="Tổng vốn" stroke="#475569" strokeWidth={1} dot={false} strokeDasharray="4 3"/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {dcaTab===2&&rollStats&&(
        <>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,flexWrap:"wrap"}}>
            <span style={{color:"var(--muted)",fontSize:12}}>Nắm giữ</span>
            {[12,24,36,60,84].map(m=><button key={m} className={"btn "+(holdM===m?"on":"")} onClick={()=>setHoldM(m)}>{m}M</button>)}
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            {[["ROI TB",(rollStats.avg>=0?"+":"")+rollStats.avg.toFixed(2)+"%",rollStats.avg>=0?"#22d3ee":"#fb7185"],
              ["Tốt nhất","+"+rollStats.best.toFixed(2)+"%","#22d3ee"],["Tệ nhất",rollStats.worst.toFixed(2)+"%","#fb7185"],
              ["% kỳ lãi",rollStats.pctPos.toFixed(0)+"%",rollStats.pctPos>=70?"#22d3ee":"#f59e0b"],["Số kỳ",""+rollStats.count,"var(--muted)"]]
              .map(([l,v,c])=>sc(l,v,c))}
          </div>
          <div className="card" style={{padding:"14px 4px 10px"}}>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={roll} margin={{top:6,right:6,bottom:0,left:0}}>
                <defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22d3ee" stopOpacity={.15}/><stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
                <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
                <YAxis tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>v+"%"} width={38}/>
                <Tooltip formatter={(v)=>[v?.toFixed(2)+"%","ROI"]} labelFormatter={l=>"Bắt đầu: "+toVN(l)} contentStyle={{background:"#0e1520",border:"1px solid #1a2235",borderRadius:6,fontFamily:"JetBrains Mono",fontSize:12}}/>
                <ReferenceLine y={0} stroke="#1a2235" strokeDasharray="4 4"/>
                <Area type="monotone" dataKey="roi" stroke="#22d3ee" strokeWidth={1.5} fill="url(#rg)" dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {dcaTab===3&&(
        <div className="card" style={{overflow:"hidden",maxHeight:500,overflowY:"auto"}}>
          <table><thead><tr><th>#</th><th>Ngày</th><th style={{textAlign:"right"}}>NAV</th><th style={{textAlign:"right"}}>CCQ mua</th><th style={{textAlign:"right"}}>CCQ cộng dồn</th><th style={{textAlign:"right"}}>Đã đầu tư</th><th style={{textAlign:"right"}}>NAV TB</th></tr></thead>
          <tbody>{r1.log.map((row,i)=>(
            <tr key={row.date}><td style={{color:"var(--muted)"}}>{i+1}</td><td style={{color:"#94a3b8"}}>{toVN(row.date)}</td><td style={{textAlign:"right"}}>{fmtN(row.nav)}</td><td style={{textAlign:"right"}}>{row.units}</td><td style={{textAlign:"right",fontWeight:600}}>{row.totalUnits}</td><td style={{textAlign:"right",color:"var(--muted)"}}>{fmtN(row.invested)}</td><td style={{textAlign:"right",color:"#f59e0b"}}>{fmtN(row.invested/row.totalUnits)}</td></tr>
          ))}</tbody></table>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  TAB 6: LS vs DCA Stop Panel
// ════════════════════════════════════════════════════════════════
function LSDCAStopPanel({ item, allItems }) {
  const [itemId,    setItemId]    = useState(item.id);
  const [amountM,   setAmountM]   = useState(1);
  const [initCapM,  setInitCapM]  = useState(0);
  const amount  = amountM  * 1_000_000;
  const initCap = initCapM * 1_000_000;
  const [freq,      setFreq]      = useState("monthly");
  const [preset,    setPreset]    = useState({l:"5Y",y:5});
  const [customFrom,setCustomFrom]= useState(()=>{const t=new Date();t.setFullYear(t.getFullYear()-5);return fmtD(t);});
  const [customTo,  setCustomTo]  = useState(fmtD(new Date()));
  const [stopM,     setStopM]     = useState(24);
  const [cmpId,     setCmpId]     = useState(null);

  useEffect(()=>setItemId(item.id),[item.id]);

  const selItem = allItems[itemId] || item;
  const cmpItem = cmpId ? allItems[cmpId] : null;
  const step    = freq==="weekly"?5:21;

  const {fromD:rawFrom, toD} = useMemo(()=>periodDates(preset,customFrom,customTo),[preset,customFrom,customTo]);
  const itemFirst = selItem.data[0]?.date || rawFrom;
  const fromD     = rawFrom > itemFirst ? rawFrom : itemFirst;

  const overlapFrom = useMemo(()=>{
    if(!cmpId) return fromD;
    const cf=(cmpItem?.data||[]).find(x=>x.date>=fromD)?.date||fromD;
    const mf=(selItem.data||[]).find(x=>x.date>=fromD)?.date||fromD;
    return cf>mf?cf:mf;
  },[cmpId,cmpItem,selItem,fromD]);
  const ef = cmpId?overlapFrom:fromD;

  const dca    = useMemo(()=>runDCA(selItem.data,ef,toD,amount,freq),[selItem,ef,toD,amount,freq]);
  const lsData = useMemo(()=>{
    const d=selItem.data.filter(x=>x.date>=ef&&x.date<=toD);
    if(!d.length) return [];
    const units=dca.fin.invested/d[0].nav;
    return d.map(x=>({date:x.date,value:Math.round(units*x.nav)}));
  },[selItem,ef,toD,dca.fin.invested]);

  const dcaStop = useMemo(()=>{
    const d=selItem.data.filter(x=>x.date>=ef&&x.date<=toD);
    if(!d.length) return {points:[],fin:{value:0,invested:0}};
    const stopDay=stopM*21; let inv=0,units=0;
    const points=d.map((x,i)=>{if(i<stopDay&&i%step===0){units+=amount/x.nav;inv+=amount;} return {date:x.date,value:Math.round(units*x.nav),invested:inv};});
    return {points,fin:points[points.length-1]||{value:0,invested:0}};
  },[selItem,ef,toD,amount,step,stopM]);

  const cmpStop = useMemo(()=>{
    if(!cmpId) return {points:[],fin:{value:0,invested:0}};
    const d=(cmpItem?.data||[]).filter(x=>x.date>=overlapFrom&&x.date<=toD);
    if(!d.length) return {points:[],fin:{value:0,invested:0}};
    const stopDay=stopM*21; let inv=0,units=0;
    const points=d.map((x,i)=>{if(i<stopDay&&i%step===0){units+=amount/x.nav;inv+=amount;} return {date:x.date,value:Math.round(units*x.nav),invested:inv};});
    return {points,fin:points[points.length-1]||{value:0,invested:0}};
  },[cmpId,cmpItem,overlapFrom,toD,amount,step,stopM]);

  const {fin:fd}=dca, lsFin=lsData[lsData.length-1], {fin:fs}=dcaStop;
  const roiDCA  =fd.invested>0?(fd.value-fd.invested)/fd.invested*100:0;
  const roiLS   =lsFin&&fd.invested>0?(lsFin.value-fd.invested)/fd.invested*100:0;
  const roiStop =fs.invested>0?(fs.value-fs.invested)/fs.invested*100:0;
  const roiCmp  =cmpStop.fin.invested>0?(cmpStop.fin.value-cmpStop.fin.invested)/cmpStop.fin.invested*100:0;
  const fmtM=v=>(v/1e6).toFixed(2)+"M";
  const best=Math.max(roiDCA,roiLS,roiStop);
  const sc=(l,v,c,star)=><div key={l} className="sc" style={{border:star?"1px solid #22d3ee":""}}><div style={{fontSize:9,color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:6,fontFamily:"JetBrains Mono"}}>{star?"🏆 ":""}{l}</div><div className="mono" style={{fontSize:13,fontWeight:700,color:c}}>{v}</div></div>;

  const merged=useMemo(()=>{
    const map={};
    dca.points.forEach(p=>{if(!map[p.date])map[p.date]={date:p.date};map[p.date].dca=p.value;map[p.date].inv=p.invested;});
    lsData.forEach(p=>{if(!map[p.date])map[p.date]={date:p.date};map[p.date].ls=p.value;});
    dcaStop.points.forEach(p=>{if(!map[p.date])map[p.date]={date:p.date};map[p.date].stop=p.value;});
    if(cmpId) cmpStop.points.forEach(p=>{if(!map[p.date])map[p.date]={date:p.date};map[p.date].cmpStop=p.value;});
    return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));
  },[dca,lsData,dcaStop,cmpStop,cmpId]);

  return (
    <div>
      <div className="card" style={{padding:"12px 14px",marginBottom:10,display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-end"}}>
        <ItemSelect label="Quỹ / ETF / CP" value={itemId} onChange={v=>{if(v)setItemId(v);}} allItems={allItems}/>
        <div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Mỗi kỳ (triệu ₫)</div><input type="number" value={amountM} onChange={e=>setAmountM(Math.max(0,Number(e.target.value)))} step={0.5} min={0} style={{width:80}}/></div>
        <div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Tần suất</div><div style={{display:"flex",gap:4}}>{[["daily","Ngày"],["biweekly","2T"],["weekly","Tuần"],["monthly","Tháng"]].map(([v,l])=><button key={v} className={"btn "+(freq===v?"on":"")} style={{fontSize:10,padding:"3px 7px"}} onClick={()=>setFreq(v)}>{l}</button>)}</div></div>
        <div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Dừng DCA sau</div><div style={{display:"flex",gap:4}}>{[6,12,18,24,36].map(m=><button key={m} className={"btn "+(stopM===m?"on":"")} onClick={()=>setStopM(m)}>{m}M</button>)}</div></div>
        <ItemSelect label="So sánh" value={cmpId} onChange={setCmpId} allItems={allItems} exclude={[itemId]}/>
      </div>
      <div className="card" style={{padding:"10px 14px",marginBottom:10}}>
        <PeriodBar preset={preset} setPreset={setPreset} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo}/>
        <div style={{fontSize:10,color:"var(--muted)",fontFamily:"JetBrains Mono"}}>
          {toVN(ef)} → {toVN(toD)}
          {cmpId&&(overlapFrom>fromD)&&<span style={{color:"#f59e0b",marginLeft:10}}>⚠️ Overlap từ {toVN(overlapFrom)}</span>}
          {itemFirst>rawFrom&&<span style={{color:"#f59e0b",marginLeft:10}}>⚠️ {selItem.symbol} data từ {toVN(itemFirst)}</span>}
        </div>
      </div>

      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
        {[["Lump Sum ROI",(roiLS>=0?"+":"")+roiLS.toFixed(2)+"%",roiLS===best?"#22d3ee":roiLS>=0?"#64748b":"#fb7185",roiLS===best],
          ["DCA thuần ROI",(roiDCA>=0?"+":"")+roiDCA.toFixed(2)+"%",roiDCA===best?"#22d3ee":roiDCA>=0?"#64748b":"#fb7185",roiDCA===best],
          ["DCA Stop "+stopM+"M ROI",(roiStop>=0?"+":"")+roiStop.toFixed(2)+"%",roiStop===best?"#22d3ee":roiStop>=0?"#64748b":"#fb7185",roiStop===best],
          ["Stop — Giá trị",fmtM(fs.value)+"M","#f59e0b",false],
          ...(cmpItem?[[cmpItem.symbol+" Stop",(roiCmp>=0?"+":"")+roiCmp.toFixed(2)+"%",roiCmp>=0?"#a78bfa":"#fb7185",false]]:[])
        ].map(([l,v,c,star])=>sc(l,v,c,star))}
      </div>

      <div className="card" style={{padding:"14px 4px 10px"}}>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={merged} margin={{top:6,right:6,bottom:0,left:0}}>
            <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
            <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
            <YAxis tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>(v/1e6).toFixed(0)+"M"} width={38}/>
            <Tooltip formatter={(v,n)=>[fmtM(v)+"M",n]} labelFormatter={l=>toVN(l)} contentStyle={{background:"#0e1520",border:"1px solid #1a2235",borderRadius:6,fontFamily:"JetBrains Mono",fontSize:12}}/>
            <Line type="monotone" dataKey="ls"      name="Lump Sum"       stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls/>
            <Line type="monotone" dataKey="stop"    name={"DCA Stop "+stopM+"M"} stroke="#22d3ee" strokeWidth={2}   dot={false} connectNulls/>
            <Line type="monotone" dataKey="dca"     name="DCA thuần"      stroke="#64748b" strokeWidth={1}   dot={false} strokeDasharray="4 3" connectNulls/>
            {cmpItem&&<Line type="monotone" dataKey="cmpStop" name={cmpItem.symbol+" Stop"} stroke="#a78bfa" strokeWidth={1.5} dot={false} connectNulls/>}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  TAB 7: Portfolio Panel
// ════════════════════════════════════════════════════════════════

function PortfolioPanel({ allItems }) {
  // Multiple portfolios support
  const COLORS = ["#22d3ee","#f59e0b","#a78bfa","#34d399","#fb7185","#60a5fa"];
  const mkPort = (name,allocs) => ({name, allocs, show:true});
  const [portfolios, setPortfolios] = useState([
    mkPort("Danh mục 1", [{id:Object.keys(allItems)[0]||"28",w:60},{id:Object.keys(allItems)[1]||"ACB",w:40}])
  ]);
  const [activeP,  setActiveP]  = useState(0);
  const [amountM,  setAmountM]  = useState(1);
  const [freq,     setFreq]     = useState("monthly");
  const [preset,   setPreset]   = useState({l:"5Y",y:5});
  const [customFrom,setCustomFrom]=useState(()=>{const t=new Date();t.setFullYear(t.getFullYear()-5);return fmtD(t);});
  const [customTo, setCustomTo] = useState(fmtD(new Date()));

  const amount = amountM * 1_000_000;
  const step   = freq==="daily"?1:freq==="biweekly"?10:freq==="weekly"?5:21;
  const fmtMv  = v => (v/1e6).toFixed(2)+"M";

  const {fromD:rawFrom, toD} = useMemo(()=>periodDates(preset,customFrom,customTo),[preset,customFrom,customTo]);

  // Compute portData for each portfolio
  const allPortData = useMemo(()=>{
    return portfolios.map(port => {
      const allocs = port.allocs;
      const totalW = allocs.reduce((s,a)=>s+a.w,0);
      if(Math.abs(totalW-100)>=1 || !allocs.length) return {points:[], fin:{value:0,invested:0}, overlapFrom:rawFrom};
      // Overlap
      const overlapFrom = allocs.reduce((mx,{id})=>{
        const d=allItems[id]?.data||[];
        const first=d.find(x=>x.date>=rawFrom)?.date||rawFrom;
        return first>mx?first:mx;
      }, rawFrom);
      // Build lookup
      const navLookup={}, dateSets=[];
      allocs.forEach(({id})=>{
        const d=(allItems[id]?.data||[]).filter(x=>x.date>=overlapFrom&&x.date<=toD);
        dateSets.push(new Set(d.map(x=>x.date)));
        navLookup[id]={};
        d.forEach(x=>navLookup[id][x.date]=x.close);
      });
      if(!dateSets.length||!dateSets[0].size) return {points:[], fin:{value:0,invested:0}, overlapFrom};
      const dates=[...dateSets[0]].filter(d=>dateSets.every(s=>s.has(d))).sort();
      if(!dates.length) return {points:[], fin:{value:0,invested:0}, overlapFrom};
      let units={}, totalInv=0;
      allocs.forEach(({id})=>units[id]=0);
      const points = dates.map((date,i)=>{
        if(i%step===0){allocs.forEach(({id,w})=>{const nav=navLookup[id][date];if(nav)units[id]+=(amount*(w/100))/nav;});totalInv+=amount;}
        let val=0; allocs.forEach(({id})=>{val+=units[id]*(navLookup[id][date]||0);});
        return {date, value:Math.round(val), invested:totalInv};
      });
      const fin = points[points.length-1]||{value:0,invested:0};
      return {points, fin, overlapFrom};
    });
  },[portfolios,allItems,rawFrom,toD,amount,step]);

  // Merged chart data across all portfolios
  const chartData = useMemo(()=>{
    const map={};
    portfolios.forEach((port,pi)=>{
      if(!port.show) return;
      allPortData[pi].points.forEach(p=>{
        if(!map[p.date]) map[p.date]={date:p.date,inv:p.invested};
        map[p.date]["p"+pi]=p.value;
      });
    });
    return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));
  },[allPortData, portfolios]);

  const ap = portfolios[activeP]||portfolios[0];
  const apAllocs = ap?.allocs||[];
  const totalW = apAllocs.reduce((s,a)=>s+a.w,0);
  const valid = Math.abs(totalW-100)<1;
  const apData = allPortData[activeP]||{points:[],fin:{value:0,invested:0},overlapFrom:rawFrom};

  const setApAllocs = fn => setPortfolios(prev=>prev.map((p,i)=>i===activeP?{...p,allocs:fn(p.allocs)}:p));
  const addAlloc = ()=>{ const used=apAllocs.map(a=>a.id); const next=Object.keys(allItems).find(id=>!used.includes(id)); if(next)setApAllocs(p=>[...p,{id:next,w:0}]); };
  const addPortfolio = ()=>{ const n=portfolios.length; setPortfolios(p=>[...p,mkPort("Danh mục "+(n+1),[{id:Object.keys(allItems)[0]||"28",w:100}])]); setActiveP(n); };

  return (
    <div>
      {/* Portfolio tabs */}
      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
        {portfolios.map((p,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:0}}>
            <button onClick={()=>setActiveP(i)}
              style={{padding:"5px 12px",borderRadius:"6px 0 0 6px",border:`1px solid ${COLORS[i%COLORS.length]}`,
                background:activeP===i?COLORS[i%COLORS.length]+"22":"transparent",
                color:COLORS[i%COLORS.length],fontSize:11,cursor:"pointer",fontWeight:activeP===i?700:400}}>
              ● {p.name}
            </button>
            <button onClick={()=>setPortfolios(prev=>prev.map((x,j)=>j===i?{...x,show:!x.show}:x))}
              style={{padding:"5px 6px",border:`1px solid ${COLORS[i%COLORS.length]}`,borderLeft:"none",
                background:"transparent",color:p.show?COLORS[i%COLORS.length]:"#475569",fontSize:10,cursor:"pointer"}}>
              {p.show?"👁":"○"}
            </button>
            {portfolios.length>1&&(
              <button onClick={()=>{setPortfolios(prev=>prev.filter((_,j)=>j!==i));setActiveP(Math.max(0,activeP-1));}}
                style={{padding:"5px 6px",border:`1px solid ${COLORS[i%COLORS.length]}`,borderLeft:"none",
                  borderRadius:"0 6px 6px 0",background:"transparent",color:"#fb7185",fontSize:10,cursor:"pointer"}}>✕</button>
            )}
          </div>
        ))}
        <button className="btn" onClick={addPortfolio} style={{fontSize:10}}>+ Danh mục mới</button>
      </div>

      {/* Active portfolio name edit */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <input value={ap?.name||""} onChange={e=>setPortfolios(prev=>prev.map((p,i)=>i===activeP?{...p,name:e.target.value}:p))}
          style={{background:"var(--surface)",border:"1px solid var(--border2)",color:COLORS[activeP%COLORS.length],
            borderRadius:6,padding:"4px 10px",fontSize:12,fontFamily:"Space Grotesk",outline:"none",width:160,fontWeight:600}}/>
        <span style={{fontSize:10,color:"var(--muted)"}}>← tên danh mục</span>
      </div>

      {/* Alloc builder */}
      <div className="card" style={{padding:"12px 14px",marginBottom:10}}>
        <div style={{fontSize:12,fontWeight:600,marginBottom:8,color:COLORS[activeP%COLORS.length]}}>🏗️ Xây danh mục (quỹ + ETF + CP đều được)</div>
        {apAllocs.map((a,i)=>(
          <div key={i} style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
            <select value={a.id} onChange={e=>setApAllocs(p=>p.map((x,j)=>j===i?{...x,id:e.target.value}:x))}
              style={{flex:2,background:"var(--surface)",border:"1px solid var(--border2)",color:"var(--txt)",borderRadius:6,padding:"4px 8px",fontSize:11,outline:"none"}}>
              {Object.values(allItems).map(f=><option key={f.id} value={f.id}>{f.symbol} — {f.name?.slice(0,28)}</option>)}
            </select>
            <input type="range" min={0} max={100} value={a.w} onChange={e=>setApAllocs(p=>p.map((x,j)=>j===i?{...x,w:Number(e.target.value)}:x))} style={{flex:1,accentColor:COLORS[activeP%COLORS.length]}}/>
            <input type="number" min={0} max={100} value={a.w} onChange={e=>setApAllocs(p=>p.map((x,j)=>j===i?{...x,w:Number(e.target.value)}:x))}
              style={{width:48,background:"var(--surface)",border:"1px solid var(--border2)",color:"var(--txt)",borderRadius:6,padding:"4px 6px",fontFamily:"JetBrains Mono",fontSize:12,textAlign:"right",outline:"none"}}/>
            <span style={{color:"var(--muted)",fontSize:11}}>%</span>
            <button className="btn" style={{color:"#fb7185",borderColor:"#fb7185"}} onClick={()=>setApAllocs(p=>p.filter((_,j)=>j!==i))}>✕</button>
          </div>
        ))}
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <button className="btn" onClick={addAlloc}>+ Thêm</button>
          <span style={{fontSize:12,color:valid?"#22d3ee":"#fb7185",fontFamily:"JetBrains Mono",fontWeight:600}}>Tổng: {totalW}% {valid?"✓":"(cần đủ 100%)"}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="card" style={{padding:"10px 14px",marginBottom:10,display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-end"}}>
        <div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Mỗi kỳ (triệu ₫)</div>
          <input type="number" value={amountM} onChange={e=>setAmountM(Math.max(0,Number(e.target.value)))} step={0.5} min={0} style={{width:80}}/></div>
        <div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Tần suất</div>
          <div style={{display:"flex",gap:4}}>{[["daily","Ngày"],["biweekly","2T"],["weekly","Tuần"],["monthly","Tháng"]].map(([v,l])=><button key={v} className={"btn "+(freq===v?"on":"")} style={{fontSize:10,padding:"3px 7px"}} onClick={()=>setFreq(v)}>{l}</button>)}</div></div>
      </div>

      {/* Period */}
      <div className="card" style={{padding:"10px 14px",marginBottom:10}}>
        <PeriodBar preset={preset} setPreset={setPreset} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo}/>
        <div style={{fontSize:10,color:"var(--muted)",fontFamily:"JetBrains Mono",marginTop:4}}>
          {toVN(rawFrom)} → {toVN(toD)}
          {apData.overlapFrom>rawFrom&&<span style={{color:"#f59e0b",marginLeft:10}}>⚠️ Overlap — bắt đầu từ {toVN(apData.overlapFrom)}</span>}
        </div>
      </div>

      {/* Allocation bar - active portfolio */}
      <div style={{display:"flex",borderRadius:8,overflow:"hidden",height:22,marginBottom:10}}>
        {apAllocs.map((a,i)=>(
          <div key={i} style={{flex:a.w,background:PALETTE[i%PALETTE.length],display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#000",fontWeight:700,overflow:"hidden"}}>
            {a.w>8?(allItems[a.id]?.symbol||a.id)+" "+a.w+"%":""}
          </div>
        ))}
      </div>

      {/* Stats - all portfolios */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
        {portfolios.map((port,pi)=>{
          const fin=allPortData[pi]?.fin||{value:0,invested:0};
          const roi=fin.invested>0?(fin.value-fin.invested)/fin.invested*100:0;
          return (
            <div key={pi} className="sc" style={{border:`1px solid ${COLORS[pi%COLORS.length]}44`,opacity:port.show?1:0.4}}>
              <div style={{fontSize:9,color:COLORS[pi%COLORS.length],fontFamily:"JetBrains Mono",marginBottom:4,fontWeight:600}}>{port.name}</div>
              <div className="mono" style={{fontSize:13,fontWeight:700,color:roi>=0?"#22d3ee":"#fb7185"}}>{roi>=0?"+":""}{roi.toFixed(2)}%</div>
              <div style={{fontSize:9,color:"var(--muted)",marginTop:2}}>{fmtMv(fin.value)}</div>
            </div>
          );
        })}
      </div>

      {/* Chart — all portfolios on same chart */}
      {chartData.length>0?(
        <div className="card" style={{padding:"14px 4px 10px"}}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData} margin={{top:6,right:6,bottom:0,left:0}}>
              <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
              <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false}
                tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
              <YAxis tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false}
                tickFormatter={v=>(v/1e6).toFixed(0)+"M"} width={40}/>
              <Tooltip formatter={(v,n)=>[(v/1e6).toFixed(2)+"M VND",n]} labelFormatter={l=>toVN(l)}
                contentStyle={{background:"#0e1520",border:"1px solid #1a2235",borderRadius:6,fontFamily:"JetBrains Mono",fontSize:12}}/>
              <Line type="monotone" dataKey="inv" name="Tổng vốn" stroke="#475569" strokeWidth={1} strokeDasharray="4 3" dot={false}/>
              {portfolios.map((port,pi)=>port.show&&(
                <Line key={pi} type="monotone" dataKey={"p"+pi} name={port.name} stroke={COLORS[pi%COLORS.length]} strokeWidth={2} dot={false} connectNulls/>
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div style={{display:"flex",gap:14,justifyContent:"center",marginTop:8,flexWrap:"wrap"}}>
            {portfolios.filter(p=>p.show).map((p,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"var(--muted)"}}>
                <div style={{width:16,height:2,background:COLORS[portfolios.indexOf(p)%COLORS.length],borderRadius:1}}/>{p.name}
              </div>
            ))}
          </div>
        </div>
      ):<div style={{textAlign:"center",padding:"30px 0",color:"var(--muted)",fontSize:12}}>Điều chỉnh tỷ trọng cho đủ 100% để xem kết quả</div>}
    </div>
  );
}

function BitcoinPanel() {
  const [btcData,setBtcData]=useState([]);
  const [loaded,setLoaded]=useState(false);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const [amount,setAmount]=useState(1000000);
  const [freq,setFreq]=useState("monthly");
  const [fromD,setFromD]=useState("2019-01-01");
  const [toD,setToD]=useState(fmtD(new Date()));
  const [currency,setCurrency]=useState("usd");
  const [usdVnd,setUsdVnd]=useState(25000);

  const fetchBTC=async()=>{
    setLoading(true);setErr("");
    try{
      const r=await fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=max&interval=daily",{headers:{Accept:"application/json"}});
      if(!r.ok) throw new Error(`CoinGecko ${r.status}`);
      const json=await r.json();
      const prices=(json.prices||[]).map(([ts,price])=>({date:fmtD(new Date(ts)),close:parseFloat(price.toFixed(2))}));
      setBtcData(prices);setLoaded(true);
    }catch(e){setErr(`${e.message} — thử lại sau ít phút`);}
    finally{setLoading(false);}
  };

  const amountUSD=currency==="vnd"?amount/usdVnd:amount;
  const r1=useMemo(()=>runDCA(btcData,fromD,toD,amountUSD,freq),[btcData,fromD,toD,amountUSD,freq]);
  const ls=useMemo(()=>runLumpsum(btcData,fromD,toD,r1.fin.invested),[btcData,fromD,toD,r1.fin.invested]);
  const {fin}=r1;
  const roi=fin.invested>0?(fin.value-fin.invested)/fin.invested*100:0;
  const lsFin=ls[ls.length-1];
  const lsRoi=lsFin&&fin.invested>0?(lsFin.value-fin.invested)/fin.invested*100:null;
  const fmtUSD=v=>v!=null?`$${v.toLocaleString("en-US",{maximumFractionDigits:0})}`:"—";
  const fmtDisp=v=>currency==="vnd"?fmtN(v*usdVnd):fmtUSD(v);
  const merged=useMemo(()=>{const map={};r1.points.forEach(p=>{if(!map[p.date])map[p.date]={date:p.date};map[p.date].dca=p.value;map[p.date].inv=p.invested;});ls.forEach(p=>{if(!map[p.date])map[p.date]={date:p.date};map[p.date].ls=p.value;});return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));},[r1,ls]);

  if(!loaded) return (
    <div style={{maxWidth:480,margin:"40px auto"}}>
      <div className="card" style={{padding:"28px 24px",textAlign:"center"}}>
        <div style={{fontSize:40,marginBottom:16}}>₿</div>
        <div style={{fontWeight:600,fontSize:16,marginBottom:8}}>Bitcoin DCA Simulator</div>
        <div style={{color:"var(--muted)",fontSize:12,marginBottom:20}}>Data từ CoinGecko API (free, không cần auth)</div>
        <button className="btn on" style={{padding:"10px 32px",fontSize:13}} onClick={fetchBTC} disabled={loading}>
          {loading?"Đang tải...":"🌐 Tải dữ liệu Bitcoin"}
        </button>
        {loading&&<div style={{display:"flex",justifyContent:"center",marginTop:20}}><div className="spin"/></div>}
        {err&&<div style={{marginTop:14,color:"#fb7185",fontSize:12,background:"rgba(251,113,133,.1)",border:"1px solid rgba(251,113,133,.3)",borderRadius:8,padding:"10px 14px"}}>{err}</div>}
      </div>
    </div>
  );

  return (
    <div>
      <div className="card" style={{padding:"12px 14px",marginBottom:10,display:"flex",gap:14,flexWrap:"wrap",alignItems:"flex-end"}}>
        <div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Tiền tệ</div><div style={{display:"flex",gap:4}}>{[["usd","USD"],["vnd","VND"]].map(([v,l])=><button key={v} className={`btn ${currency===v?"on":""}`} onClick={()=>setCurrency(v)}>{l}</button>)}</div></div>
        {currency==="vnd"&&<div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Tỷ giá</div><input type="number" value={usdVnd} onChange={e=>setUsdVnd(Number(e.target.value))} step={100} style={{width:100}}/></div>}
        <div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Số tiền/kỳ ({currency.toUpperCase()})</div><input type="number" value={amount} onChange={e=>setAmount(Math.max(0,Number(e.target.value)))} step={currency==="vnd"?500000:100}/></div>
        <div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Tần suất</div><div style={{display:"flex",gap:4}}>{[["daily","Ngày"],["biweekly","2T"],["weekly","Tuần"],["monthly","Tháng"]].map(([v,l])=><button key={v} className={`btn ${freq===v?"on":""}`} style={{fontSize:10,padding:"3px 7px"}} onClick={()=>setFreq(v)}>{l}</button>)}</div></div>
        <div><div style={{fontSize:9,color:"var(--muted)",marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontFamily:"JetBrains Mono"}}>Giai đoạn</div><div style={{display:"flex",gap:5,alignItems:"center"}}><input type="date" value={fromD} onChange={e=>setFromD(e.target.value)} min="2013-04-28" style={{fontSize:11}}/><span style={{color:"var(--muted)",fontSize:11}}>→</span><input type="date" value={toD} onChange={e=>setToD(e.target.value)} style={{fontSize:11}}/></div></div>
        <button className="btn" onClick={()=>{setLoaded(false);setBtcData([]);}}>↩ Reload</button>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
        {[{l:"DCA ROI",v:`${roi>=0?"+":""}${roi.toFixed(2)}%`,c:roi>=0?"#f59e0b":"#fb7185"},{l:"Lump Sum ROI",v:lsRoi!=null?`${lsRoi>=0?"+":""}${lsRoi.toFixed(2)}%`:"—",c:(lsRoi||0)>=0?"#22d3ee":"#fb7185"},{l:"Đầu tư",v:fmtDisp(fin.invested),c:"var(--muted)"},{l:"Giá trị",v:fmtDisp(fin.value),c:"#f59e0b"},{l:"BTC sở hữu",v:`${fin.units?.toFixed(6)} BTC`,c:"var(--txt)"},{l:"Giá BTC TB",v:fmtUSD(fin.avgNav),c:"#a78bfa"}].map(s=>(
          <div key={s.l} className="sc"><div style={{fontSize:9,color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:6,fontFamily:"JetBrains Mono"}}>{s.l}</div><div className="mono" style={{fontSize:13,fontWeight:700,color:s.c}}>{s.v}</div></div>
        ))}
      </div>
      <div className="card" style={{padding:"14px 4px 8px",marginBottom:10}}>
        <div style={{color:"var(--muted)",fontSize:10,textAlign:"center",marginBottom:6,fontFamily:"JetBrains Mono"}}>Giá BTC (USD) lịch sử</div>
        <ResponsiveContainer width="100%" height={150}>
          <AreaChart data={btcData.filter(d=>d.date>=fromD&&d.date<=toD)} margin={{top:4,right:6,bottom:0,left:0}}>
            <defs><linearGradient id="btcg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f59e0b" stopOpacity={.2}/><stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/></linearGradient></defs>
            <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:9,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
            <YAxis tick={{fill:"#64748b",fontSize:9,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>"$"+(v/1000).toFixed(0)+"k"} width={44}/>
            <Tooltip formatter={(v)=>[`$${v.toLocaleString("en-US",{maximumFractionDigits:0})}`,"BTC"]} labelFormatter={l=>toVN(l)} contentStyle={{background:"#0e1520",border:"1px solid #1a2235",borderRadius:6,fontFamily:"JetBrains Mono",fontSize:11}}/>
            <Area type="monotone" dataKey="close" stroke="#f59e0b" strokeWidth={1.5} fill="url(#btcg)" dot={false}/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="card" style={{padding:"14px 4px 10px"}}>
        <div style={{color:"var(--muted)",fontSize:10,textAlign:"center",marginBottom:6,fontFamily:"JetBrains Mono"}}>DCA vs Lump Sum</div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={merged} margin={{top:6,right:6,bottom:0,left:0}}>
            <CartesianGrid stroke="#1a2235" strokeDasharray="3 3" vertical={false}/>
            <XAxis dataKey="date" tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>{const[y,m]=v.split("-");return m+"/"+y.slice(2);}} interval="preserveStartEnd"/>
            <YAxis tick={{fill:"#64748b",fontSize:10,fontFamily:"JetBrains Mono"}} tickLine={false} axisLine={false} tickFormatter={v=>currency==="vnd"?(v*usdVnd/1e6).toFixed(0)+"M":"$"+(v/1000).toFixed(0)+"k"} width={44}/>
            <Tooltip formatter={(v,n)=>[currency==="vnd"?`${((v*usdVnd)/1e6).toFixed(2)}M VND`:fmtUSD(v),n]} labelFormatter={l=>toVN(l)} contentStyle={{background:"#0e1520",border:"1px solid #1a2235",borderRadius:6,fontFamily:"JetBrains Mono",fontSize:12}}/>
            <Line type="monotone" dataKey="dca" name="DCA" stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls/>
            <Line type="monotone" dataKey="ls" name="Lump Sum" stroke="#22d3ee" strokeWidth={1.5} dot={false} connectNulls/>
            <Line type="monotone" dataKey="inv" name="Tổng vốn" stroke="#475569" strokeWidth={1} dot={false} strokeDasharray="4 3"/>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  TAB 9: Ranking — Xếp hạng tất cả theo CAGR / Sharpe / MaxDD
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
//  TAB 9: Ranking — xếp hạng theo giai đoạn
// ════════════════════════════════════════════════════════════════
const RANK_PERIODS = [
  {l:"ALL",  years:null},
  {l:"12.5Y",years:12.5},
  {l:"10Y",  years:10},
  {l:"7.5Y", years:7.5},
  {l:"5Y",   years:5},
  {l:"3Y",   years:3},
  {l:"Tùy chọn", years:"custom"},
];

function calcRankMetrics(data, fromD, toD) {
  // Chỉ tính nếu item có data từ TRƯỚC hoặc BẰNG fromD (cover đủ giai đoạn)
  const firstDate = data[0]?.date || "9999";
  if(firstDate > fromD) return null;

  const d = data.filter(x => x.date >= fromD && x.date <= toD);
  if(d.length < 30) return null;
  const first = d[0].close, last = d[d.length-1].close;
  if(!first || !last) return null;
  const days  = (new Date(d[d.length-1].date) - new Date(d[0].date)) / 86400000;
  const years = days / 365;
  if(years < 0.5) return null;

  const cagr = (Math.pow(last/first, 1/years) - 1) * 100;

  // Daily returns
  const rets  = d.slice(1).map((x,i) => d[i].close > 0 ? (x.close - d[i].close)/d[i].close : 0);
  const avgR  = rets.reduce((a,b)=>a+b,0) / (rets.length||1);
  const vol   = Math.sqrt(rets.reduce((a,b)=>a+(b-avgR)**2,0)/(rets.length||1)) * Math.sqrt(252) * 100;

  // Sharpe (rf=0)
  const sharpe = vol > 0 ? (cagr/100) / (vol/100) : 0;

  // Sortino — chỉ dùng downside deviation (ret < 0)
  const downRets    = rets.filter(r => r < 0);
  const downsideVol = downRets.length > 0
    ? Math.sqrt(downRets.reduce((a,b)=>a+b*b,0)/downRets.length) * Math.sqrt(252)
    : 0.0001;
  const sortino = (cagr/100) / downsideVol;

  // Max Drawdown
  let peak = d[0].close, mdd = 0;
  d.forEach(x => { if(x.close>peak)peak=x.close; const dd=(x.close-peak)/peak*100; if(dd<mdd)mdd=dd; });

  // Calmar
  const calmar = mdd < 0 ? cagr / Math.abs(mdd) : 0;

  return {
    cagr, vol, sharpe, sortino, mdd, calmar,
    years: parseFloat(years.toFixed(1)),
    fromDate: d[0].date, toDate: d[d.length-1].date
  };
}

function RankingPanel({ allItems }) {
  const [period,   setPeriod]  = useState("5Y");
  const [sortBy,   setSortBy]  = useState("score");
  const [filterT,  setFilterT] = useState("Tất cả");
  const [filterTy, setFilterTy]= useState("Tất cả");
  const [customFrom, setCustomFrom] = useState(() => { const d=new Date(); d.setFullYear(d.getFullYear()-5); return fmtD(d); });
  const [customTo,   setCustomTo]   = useState(fmtD(new Date()));

  const TYPE_COLORS = {"Cổ phiếu":"#22d3ee","Cân bằng":"#f59e0b","Trái phiếu":"#a78bfa","ETF":"#34d399","Index":"#fb7185","Global":"#f97316"};

  // Compute from/to for selected period
  const {fromD, toD} = useMemo(()=>{
    const p = RANK_PERIODS.find(x=>x.l===period);
    const to = fmtD(new Date());
    if(!p || p.years===null) return {fromD:"2000-01-01", toD:to};
    if(p.years==="custom")   return {fromD:customFrom,   toD:customTo};
    const f = new Date(); f.setFullYear(f.getFullYear() - p.years);
    return {fromD: fmtD(f), toD: to};
  },[period, customFrom, customTo]);

  const rows = useMemo(()=>{
    return Object.values(allItems)
      .filter(item => {
        if(filterT==="Quỹ mở" && !item.isFund) return false;
        if(filterT==="ETF"      && item.type!=="ETF") return false;
        if(filterT==="Global"   && item.type!=="Global") return false;
        if(filterT==="Cổ phiếu" && (item.isFund||item.type==="ETF"||item.type==="Global"||item.type==="Index")) return false;
        if(filterTy!=="Tất cả" && item.type!==filterTy) return false;
        return true;
      })
      .map(item => {
        const m = calcRankMetrics(item.data, fromD, toD);
        return m ? {item, ...m} : null;
      })
      .filter(Boolean);
  },[allItems, filterT, filterTy, fromD, toD]);

  const scored = useMemo(()=>{
    if(!rows.length) return [];
    const cagrs  = rows.map(r=>r.cagr);
    const sharpes= rows.map(r=>r.sharpe);
    const mdds   = rows.map(r=>r.mdd);
    const minC=Math.min(...cagrs),  maxC=Math.max(...cagrs);
    const minS=Math.min(...sharpes),maxS=Math.max(...sharpes);
    const minM=Math.min(...mdds);
    const sortinos= rows.map(r=>r.sortino);
    const minSo=Math.min(...sortinos), maxSo=Math.max(...sortinos);
    const norm=(v,mn,mx)=>mx>mn?(v-mn)/(mx-mn)*100:50;
    return rows.map(r=>({
      ...r,
      score: norm(r.cagr,minC,maxC)*0.4 + norm(r.sharpe,minS,maxS)*0.175 + norm(r.sortino,minSo,maxSo)*0.175 + norm(-r.mdd,0,-minM)*0.25
    })).sort((a,b)=>{
      if(sortBy==="score")   return b.score-a.score;
      if(sortBy==="cagr")    return b.cagr-a.cagr;
      if(sortBy==="sharpe")  return b.sharpe-a.sharpe;
      if(sortBy==="sortino") return b.sortino-a.sortino;
      if(sortBy==="mdd")     return b.mdd-a.mdd;
      if(sortBy==="calmar")  return b.calmar-a.calmar;
      if(sortBy==="vol")     return a.vol-b.vol;
      return 0;
    });
  },[rows, sortBy]);

  const cols = [
    {k:"score",   l:"Score",   fmt:v=>v.toFixed(1),                    c:v=>v>=70?"#22d3ee":v>=50?"#f59e0b":"#fb7185"},
    {k:"cagr",    l:"CAGR",    fmt:v=>(v>=0?"+":"")+v.toFixed(1)+"%", c:v=>v>=15?"#22d3ee":v>=0?"#64748b":"#fb7185"},
    {k:"sharpe",  l:"Sharpe",  fmt:v=>v.toFixed(2),                    c:v=>v>=1?"#22d3ee":v>=0.5?"#f59e0b":"#fb7185"},
    {k:"sortino", l:"Sortino", fmt:v=>v.toFixed(2),                    c:v=>v>=1.5?"#22d3ee":v>=0.8?"#f59e0b":"#fb7185"},
    {k:"mdd",     l:"Max DD",  fmt:v=>v.toFixed(1)+"%",                c:v=>v>-15?"#22d3ee":v>-30?"#f59e0b":"#fb7185"},
    {k:"calmar",  l:"Calmar",  fmt:v=>v.toFixed(2),                    c:v=>v>=1?"#22d3ee":v>=0.5?"#f59e0b":"#fb7185"},
    {k:"vol",     l:"Vol/Y",   fmt:v=>v.toFixed(1)+"%",                c:v=>v<15?"#22d3ee":v<25?"#f59e0b":"#fb7185"},
  ];

  return (
    <div>
      {/* Period sub-tabs */}
      <div style={{borderBottom:"1px solid var(--border)",marginBottom:12,display:"flex",gap:0,flexWrap:"wrap"}}>
        {RANK_PERIODS.map(p=>(
          <button key={p.l} className="tab-btn" style={{fontSize:11,...(period===p.l?{borderBottomColor:"var(--accent)",color:"var(--txt)"}:{})}}
            onClick={()=>setPeriod(p.l)}>{p.l}</button>
        ))}
      </div>

      {/* Custom date picker */}
      {period==="Tùy chọn"&&(
        <div className="card" style={{padding:"10px 14px",marginBottom:12,display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontSize:11,color:"var(--muted)"}}>Giai đoạn:</span>
          <input type="date" value={customFrom} onChange={e=>setCustomFrom(e.target.value)} style={{fontSize:11}}/>
          <span style={{color:"var(--muted)"}}>→</span>
          <input type="date" value={customTo}   onChange={e=>setCustomTo(e.target.value)}   style={{fontSize:11}}/>
          <span style={{fontSize:11,color:"#22d3ee",fontFamily:"JetBrains Mono"}}>
            {toVN(customFrom)} → {toVN(customTo)}
          </span>
        </div>
      )}

      {/* Filters */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:12}}>
        <div style={{display:"flex",gap:4}}>
          {["Tất cả","Quỹ mở","Cổ phiếu","ETF","Global"].map(f=>(
            <button key={f} className={`btn ${filterT===f?"on":""}`} onClick={()=>setFilterT(f)}>{f}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:4}}>
          {["Cổ phiếu","Cân bằng","Trái phiếu","ETF"].map(f=>(
            <button key={f} className={`btn ${filterTy===f?"on":""}`} onClick={()=>setFilterTy(filterTy===f?"Tất cả":f)}>{f}</button>
          ))}
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          <span style={{fontSize:11,color:"var(--muted)"}}>{scored.length} mục | {toVN(fromD)} → {toVN(toD)}</span>
        </div>
      </div>

      {/* Score formula */}
      <div className="card" style={{padding:"8px 14px",marginBottom:10,fontSize:10,color:"var(--muted)",display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
        <span>🏆 <strong style={{color:"var(--txt)"}}>Score</strong> = CAGR×40% + Sharpe×17.5% + Sortino×17.5% + MaxDD×25% — normalized 0–100</span>
        <span style={{color:"#64748b",fontSize:9}}>Sortino = CAGR / downside vol | Calmar = CAGR / |MaxDD|</span>
        <span style={{marginLeft:"auto",color:"#22d3ee",fontSize:10}}>↓ Click header để sort</span>
      </div>

      {/* Table */}
      {scored.length===0
        ? <div style={{textAlign:"center",padding:"40px 0",color:"var(--muted)"}}>Không đủ dữ liệu cho giai đoạn này</div>
        : (
        <div className="card" style={{overflow:"hidden"}}>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",tableLayout:"fixed"}}>
              <colgroup>
                <col style={{width:32}}/><col style={{width:95}}/><col style={{width:80}}/><col style={{width:44}}/>
                {cols.map(c=><col key={c.k} style={{width:64}}/>)}
              </colgroup>
              <thead>
                <tr>
                  <th style={{textAlign:"center"}}>#</th>
                  <th>Symbol</th>
                  <th style={{fontSize:9}}>Tên / Công ty</th>
                  <th style={{textAlign:"center",fontSize:9}}>Năm</th>
                  {cols.map(c=>(
                    <th key={c.k}
                      style={{textAlign:"right",cursor:"pointer",userSelect:"none",
                        color:sortBy===c.k?"var(--accent)":"var(--muted)",
                        background:sortBy===c.k?"rgba(34,211,238,.05)":""}}
                      onClick={()=>setSortBy(c.k)}>
                      {c.l}{sortBy===c.k?" ↓":""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scored.map((r,i)=>{
                  const tc    = TYPE_COLORS[r.item.type]||"#6b7280";
                  const badge = r.item.type==="Cổ phiếu"?"CP":r.item.type==="Trái phiếu"?"TP":r.item.type==="Cân bằng"?"CB":r.item.type;
                  const medal = i===0?"🥇":i===1?"🥈":i===2?"🥉":null;
                  return (
                    <tr key={r.item.id} style={{background:i<3?"rgba(34,211,238,.025)":"",opacity:r.years<1?0.5:1}}>
                      <td style={{textAlign:"center",fontWeight:700,fontSize:11,color:i<3?"#f59e0b":"var(--muted)"}}>
                        {medal||i+1}
                      </td>
                      <td>
                        <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:1}}>
                          <span style={{fontWeight:700,fontSize:11}}>{r.item.symbol}</span>
                          <span style={{fontSize:8,padding:"1px 4px",borderRadius:3,background:`${tc}20`,color:tc,border:`1px solid ${tc}40`}}>{badge}</span>
                        </div>
                        <div style={{fontSize:9,color:"var(--muted)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.item.mgmt}</div>
                      </td>
                      <td style={{fontSize:9,color:"var(--muted)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.item.name?.slice(0,22)}</td>
                      <td style={{textAlign:"center"}}>
                        <div style={{fontSize:9,color:"var(--muted)",fontFamily:"JetBrains Mono"}}>{r.years}Y</div>
                        <div style={{fontSize:8,color:"#475569",fontFamily:"JetBrains Mono"}}>{r.fromDate?.slice(0,7)}</div>
                      </td>
                      {cols.map(c=>(
                        <td key={c.k}
                          style={{textAlign:"right",fontFamily:"JetBrains Mono",fontSize:11,
                            fontWeight:sortBy===c.k?700:400,
                            color:c.c(r[c.k]),
                            background:sortBy===c.k?"rgba(34,211,238,.03)":""}}>
                          {c.fmt(r[c.k])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
