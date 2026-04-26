"""
=================================================================
  Tranquan Personal Finance Library
  Output: G:\My Drive\Personal\Finance\data_vn_finance.json
  Structure:
  {
    "funds":  { pid:  { symbol, name, mgmt, type, data:[{navDate,nav}] } },
    "stocks": { sym:  { symbol, name, mgmt, type, data:[{date,close,...}] } }
  }
=================================================================
"""
import requests, json, time
from datetime import date, datetime

OUTPUT  = r"G:\My Drive\Personal\Finance\data_vn_finance.json"
TODAY   = str(date.today())
FROM_TS = int(datetime(2010, 1, 1).timestamp())
TO_TS   = int(datetime.now().timestamp())

H_FM = {
    "Content-Type": "application/json",
    "Referer":      "https://fmarket.vn/",
    "Origin":       "https://fmarket.vn",
    "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept":       "application/json, text/plain, */*",
}
H_SSI = {
    "Origin":     "https://iboard.ssi.com.vn",
    "Referer":    "https://iboard.ssi.com.vn/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept":     "application/json, text/plain, */*",
}
H_DNSE = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer":    "https://dnse.com.vn/",
}

def classify_fund_type(name, sym):
    s = ((name or "") + " " + (sym or "")).lower()
    if any(x in s for x in ["trái phiếu","bond","bf","fif","dfix","vlbf",
                              "vndbf","ssibf","pvbf","asbf","mbbond","hdbond"]):
        return "Trái phiếu"
    if any(x in s for x in ["cân bằng","balanced","tbf","vibf","mafbal","vcambf","pbif"]):
        return "Cân bằng"
    return "Cổ phiếu"

def fetch_ohlcv(symbol, stype="stock"):
    url = (f"https://services.entrade.com.vn/chart-api/v2/ohlcs/{stype}"
           f"?from={FROM_TS}&to={TO_TS}&symbol={symbol}&resolution=1D")
    try:
        r = requests.get(url, headers=H_DNSE, timeout=15)
        if r.status_code != 200: return []
        d = r.json()
        t = d.get("t",[]); c = d.get("c",[]); o = d.get("o",[])
        h = d.get("h",[]); l = d.get("l",[]); v = d.get("v",[])
        if not t: return []
        pts = [{"date": datetime.fromtimestamp(t[i]).strftime("%Y-%m-%d"),
                "close": c[i] if i<len(c) else None,
                "open":  o[i] if i<len(o) else None,
                "high":  h[i] if i<len(h) else None,
                "low":   l[i] if i<len(l) else None,
                "vol":   v[i] if i<len(v) else None}
               for i in range(len(t))]
        return sorted(pts, key=lambda x: x["date"])
    except: return []

result = {"funds": {}, "stocks": {}}

# ════════════════════════════════════════════════════════════
#  PART 1: QUỸ MỞ — Fmarket
# ════════════════════════════════════════════════════════════
print("=" * 65)
print("  PART 1: Quỹ mở — Fmarket")
print("=" * 65)

rows = requests.post("https://api.fmarket.vn/res/products/filter", headers=H_FM, json={
    "types":["NEW_FUND","TRADING_FUND"],"page":1,"pageSize":1000,
    "sortOrder":"DESC","sortField":"navTo12Months","isIpo":False,
    "fundAssetTypes":[],"bondRemainPeriods":[],"searchField":"","issuerIds":[]
}, timeout=15).json()["data"]["rows"]

print(f"  {len(rows)} quỹ tìm thấy\n")

for p in sorted(rows, key=lambda x: x["id"]):
    pid  = p["id"]
    sym  = p.get("shortName") or p.get("code") or f"FUND{pid}"
    name = p.get("name") or sym
    mgmt = p.get("owner",{}).get("shortName") or ""
    ftype= classify_fund_type(name, sym)
    try:
        r = requests.post("https://api.fmarket.vn/res/product/get-nav-history",
            headers=H_FM, json={"isAllData":1,"productId":pid,"navPeriod":"navToAll"}, timeout=20)
        data = r.json().get("data",[])
        if not data:
            r2 = requests.post("https://api.fmarket.vn/res/product/get-nav-history",
                headers=H_FM, json={"productId":pid,"fromDate":"2004-01-01","toDate":TODAY}, timeout=20)
            data = r2.json().get("data",[])
        if data:
            result["funds"][str(pid)] = {"id":pid,"symbol":sym,"name":name,"mgmt":mgmt,"type":ftype,"data":data}
            print(f"  ✓ {sym:15s} | {len(data):4d} recs | {data[0]['navDate']} → {data[-1]['navDate']}")
        else:
            print(f"  ✗ {sym}")
    except Exception as e:
        print(f"  ✗ {sym}: {e}")
    time.sleep(0.15)

# ════════════════════════════════════════════════════════════
#  PART 2: ETF + VNINDEX + VNDiamond — DNSE
# ════════════════════════════════════════════════════════════
print(f"\n{'=' * 65}")
print("  PART 2: ETF + VNINDEX + VNDiamond stocks — DNSE")
print("=" * 65)

# VNINDEX
pts = fetch_ohlcv("VNINDEX", "index")
if pts:
    result["stocks"]["VNINDEX"] = {"symbol":"VNINDEX","name":"VN Index","mgmt":"HOSE","type":"Index","data":pts}
    print(f"  ✓ VNINDEX       | {len(pts):5d} recs | {pts[0]['date']} → {pts[-1]['date']}")
time.sleep(0.2)

# ETFs
ETFS = {
    "E1VFVN30": ("ETF VFM VN30",         "VFM",    "ETF"),
    "FUEVFVND": ("ETF VFM VN Diamond",   "VFM",    "ETF"),
    "FUESSVFL": ("ETF SSI VN30 Lead",    "SSI-AM", "ETF"),
    "FUEDCMID": ("ETF DC VN MidCap",     "DCVFM",  "ETF"),
    "FUEIP100": ("ETF SSIAM VNFin Lead", "SSI-AM", "ETF"),
    "FUESSV50": ("ETF SSI SCA50",        "SSI-AM", "ETF"),
    "FUEVN100": ("ETF VFM VN100",        "VFM",    "ETF"),
}
print()
for sym, (name, mgmt, stype) in ETFS.items():
    pts = fetch_ohlcv(sym)
    if pts:
        result["stocks"][sym] = {"symbol":sym,"name":name,"mgmt":mgmt,"type":stype,"data":pts}
        print(f"  ✓ {sym:12s} | {len(pts):5d} recs | {pts[0]['date']} → {pts[-1]['date']}")
    else:
        print(f"  ✗ {sym}")
    time.sleep(0.2)

# VNDiamond basket từ SSI
print()
diamond = {}
try:
    for group in ["VNDIAMOND","VNDiamond"]:
        r = requests.get(f"https://iboard-query.ssi.com.vn/stock/group/{group}",
                         headers=H_SSI, timeout=10)
        if r.status_code == 200:
            raw = r.json()
            items = (raw.get("data") or raw.get("value") or [])
            if isinstance(items, dict):
                items = items.get("stocks") or items.get("items") or []
            for item in items:
                sym = item.get("stockSymbol") or item.get("symbol") or item.get("code") or ""
                if sym: diamond[sym] = item.get("stockName") or item.get("name") or sym
            if diamond: break
except Exception as e:
    print(f"  SSI error: {e}")

if not diamond:
    # Hardcode VNDiamond nếu API fail
    diamond = {
        "ACB":"Asia Commercial Bank","BID":"BIDV","CTG":"VietinBank",
        "FPT":"FPT Corp","HDB":"HDBank","MBB":"MB Bank","MSN":"Masan",
        "MWG":"Mobile World","STB":"Sacombank","TCB":"Techcombank",
        "TPB":"TPBank","VCB":"Vietcombank","VHM":"Vinhomes","VIB":"VIB",
        "VIC":"Vingroup","VND":"VNDirect","VPB":"VPBank","VRE":"Vincom Retail",
    }
    print(f"  ⚠️  SSI API fail — dùng hardcode VNDiamond ({len(diamond)} cp)")
else:
    print(f"  ✓ VNDiamond từ SSI: {len(diamond)} cp — {list(diamond.keys())}")

for sym, name in diamond.items():
    pts = fetch_ohlcv(sym)
    if pts:
        result["stocks"][sym] = {"symbol":sym,"name":name,"mgmt":"VNDiamond","type":"Cổ phiếu","data":pts}
        print(f"  ✓ {sym:8s} | {len(pts):5d} recs | {pts[0]['date']} → {pts[-1]['date']} | {name}")
    else:
        print(f"  ✗ {sym:8s} | {name}")
    time.sleep(0.2)

# ════════════════════════════════════════════════════════════
#  SAVE
# ════════════════════════════════════════════════════════════
with open(OUTPUT,"w",encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"\n{'=' * 65}")
print(f"  ✅ {len(result['funds'])} quỹ mở")
print(f"  ✅ {len(result['stocks'])} ETF/stocks")
print(f"  📁 → {OUTPUT}")
print("=" * 65)