"""
=================================================================
  Tranquan Personal Finance Library
  Output: data_vn_finance.json (relative — works locally & GitHub Actions)
=================================================================
"""
import requests, json, time, os
from datetime import date, datetime

# Relative path — GitHub Actions chạy từ repo root
# Locally: file sẽ tạo trong cùng thư mục với script
OUTPUT  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data_vn_finance.json")
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

# VN30 basket
print()
vn30 = {}
try:
    for group in ["VN30","vn30"]:
        r = requests.get(f"https://iboard-query.ssi.com.vn/stock/group/{group}",
                         headers=H_SSI, timeout=10)
        if r.status_code == 200:
            raw = r.json()
            items = (raw.get("data") or raw.get("value") or [])
            if isinstance(items, dict):
                items = items.get("stocks") or items.get("items") or []
            for item in items:
                sym = item.get("stockSymbol") or item.get("symbol") or item.get("code") or ""
                if sym: vn30[sym] = item.get("stockName") or item.get("name") or sym
            if vn30: break
except Exception as e:
    print(f"  SSI VN30 error: {e}")

if not vn30:
    vn30 = {"ACB":"ACB","BID":"BIDV","BVH":"Bảo Việt","CTG":"VietinBank","FPT":"FPT",
            "GAS":"PV Gas","GVR":"GVR","HDB":"HDBank","HPG":"Hòa Phát","KDH":"KDH",
            "MBB":"MB Bank","MSN":"Masan","MWG":"Mobile World","NVL":"Novaland",
            "PDR":"PDR","PLX":"Petrolimex","POW":"PV Power","SAB":"Sabeco",
            "SSI":"SSI","STB":"Sacombank","TCB":"Techcombank","TPB":"TPBank",
            "VCB":"Vietcombank","VHM":"Vinhomes","VIB":"VIB","VIC":"Vingroup",
            "VJC":"Vietjet","VNM":"Vinamilk","VPB":"VPBank","VRE":"Vincom Retail"}
    print(f"  ⚠️  SSI VN30 fail — dùng hardcode ({len(vn30)} cp)")
else:
    print(f"  ✓ VN30 từ SSI: {len(vn30)} cp — {list(vn30.keys())}")

for sym, name in vn30.items():
    if sym not in result["stocks"]:  # skip nếu đã có từ VNDiamond
        pts = fetch_ohlcv(sym)
        if pts:
            result["stocks"][sym] = {"symbol":sym,"name":name,"mgmt":"VN30","type":"Cổ phiếu","data":pts}
            print(f"  ✓ {sym:8s} | {len(pts):5d} recs | {pts[0]['date']} → {pts[-1]['date']} | {name}")
        else:
            print(f"  ✗ {sym:8s} | {name}")
        time.sleep(0.2)
    else:
        # Cập nhật mgmt tag nếu đã có
        result["stocks"][sym]["mgmt"] = "VN30+Diamond"

# VNMidcap basket
print()
vnmid = {}
try:
    for group in ["VNMidCap","VNMIDCAP","vnmidcap"]:
        r = requests.get(f"https://iboard-query.ssi.com.vn/stock/group/{group}",
                         headers=H_SSI, timeout=10)
        if r.status_code == 200:
            raw = r.json()
            items = (raw.get("data") or raw.get("value") or [])
            if isinstance(items, dict):
                items = items.get("stocks") or items.get("items") or []
            for item in items:
                sym = item.get("stockSymbol") or item.get("symbol") or item.get("code") or ""
                if sym: vnmid[sym] = item.get("stockName") or item.get("name") or sym
            if vnmid: break
except Exception as e:
    print(f"  SSI VNMidcap error: {e}")

if not vnmid:
    vnmid = {"DGC":"Đức Giang Chemicals","DGW":"Digiworld","DPM":"PetroVietnam Fertilizer",
             "DXS":"Dat Xanh Services","EIB":"Eximbank","EVF":"EVF","GEX":"Gelex",
             "HAH":"Hai An","HCM":"HSC","HDC":"HDC","IJC":"IJC","KBC":"Kinh Bac",
             "KDC":"Kido","LPB":"LienViet","NAB":"NAB","NLG":"Nam Long","NT2":"NT2",
             "PAN":"PAN Group","PC1":"PC1","PHR":"Phu Rieng","PNJ":"PNJ","PPC":"PPC",
             "REE":"REE","SCS":"SCS","SHB":"SHB","SZC":"SZC","VCI":"VCI",
             "VGC":"Viglacera","VGI":"Viettel Global","VIX":"VIX","VND":"VNDirect"}
    print(f"  ⚠️  SSI VNMidcap fail — dùng hardcode ({len(vnmid)} cp)")
else:
    print(f"  ✓ VNMidcap từ SSI: {len(vnmid)} cp — {list(vnmid.keys())}")

for sym, name in vnmid.items():
    if sym not in result["stocks"]:
        pts = fetch_ohlcv(sym)
        if pts:
            result["stocks"][sym] = {"symbol":sym,"name":name,"mgmt":"VNMidcap","type":"Cổ phiếu","data":pts}
            print(f"  ✓ {sym:8s} | {len(pts):5d} recs | {pts[0]['date']} → {pts[-1]['date']} | {name}")
        else:
            print(f"  ✗ {sym:8s} | {name}")
        time.sleep(0.2)

# ════════════════════════════════════════════════════════════
#  PART 3: GLOBAL BENCHMARKS (server-side, no CORS issues)
# ════════════════════════════════════════════════════════════
print(f"\n{'=' * 65}")
print("  PART 3: Global Benchmarks")
print("=" * 65)

H_YAHOO = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}

def fetch_yahoo_etf(ticker, name, mgmt):
    """Fetch daily OHLC từ Yahoo Finance."""
    # Dùng range=max với interval=1d để lấy daily từ đầu
    for host in ["query1", "query2"]:
        url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=max"
        try:
            r = requests.get(url, headers=H_YAHOO, timeout=20)
            if r.status_code != 200: continue
            d = r.json()
            res = d.get("chart",{}).get("result",[])
            if not res: continue
            ts  = res[0].get("timestamp",[])
            cls = res[0].get("indicators",{}).get("adjclose",[{}])[0].get("adjclose",[])
            pts = [{"date": datetime.fromtimestamp(ts[i]).strftime("%Y-%m-%d"),
                    "close": round(cls[i], 4)}
                   for i in range(min(len(ts),len(cls))) if cls[i] is not None]
            pts.sort(key=lambda x: x["date"])
            if pts:
                result["stocks"][ticker] = {"symbol":ticker,"name":name,"mgmt":mgmt,"type":"Global","data":pts}
                print(f"  ✓ {ticker:8s} | {len(pts):5d} recs | {pts[0]['date']} → {pts[-1]['date']} | {name}")
                return
        except Exception as e:
            continue
    print(f"  ✗ {ticker} — all hosts failed")

def fetch_coingecko_btc():
    """Fetch Bitcoin từ CoinGecko — thử nhiều endpoint."""
    # Endpoint 1: public API v3
    urls = [
        "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=max&interval=daily",
        "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=3650&interval=daily",
    ]
    H = {"Accept":"application/json","User-Agent":"Mozilla/5.0 (compatible; curl/7.0)","x-cg-demo-api-key":""}
    for url in urls:
        try:
            time.sleep(2)  # CoinGecko rate limit
            r = requests.get(url, headers=H, timeout=30)
            if r.status_code == 200:
                prices = r.json().get("prices",[])
                pts = [{"date": datetime.fromtimestamp(ts/1000).strftime("%Y-%m-%d"),
                        "close": round(p, 2)} for ts,p in prices]
                pts.sort(key=lambda x: x["date"])
                if pts:
                    result["stocks"]["BTC"] = {"symbol":"BTC","name":"Bitcoin","mgmt":"Crypto","type":"Global","data":pts}
                    print(f"  ✓ BTC      | {len(pts):5d} recs | {pts[0]['date']} → {pts[-1]['date']} | Bitcoin (USD)")
                    return
        except Exception as e:
            print(f"  ✗ BTC attempt failed: {e}")
    # Fallback: dùng Yahoo Finance BTC-USD
    try:
        r = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1d&range=max",
            headers={"User-Agent":"Mozilla/5.0","Accept":"application/json"}, timeout=20)
        if r.status_code == 200:
            res = r.json().get("chart",{}).get("result",[])
            if res:
                ts  = res[0].get("timestamp",[])
                cls = res[0].get("indicators",{}).get("adjclose",[{}])[0].get("adjclose",[])
                pts = [{"date":datetime.fromtimestamp(ts[i]).strftime("%Y-%m-%d"),"close":round(cls[i],2)}
                       for i in range(min(len(ts),len(cls))) if cls[i] is not None]
                pts.sort(key=lambda x:x["date"])
                if pts:
                    result["stocks"]["BTC"] = {"symbol":"BTC","name":"Bitcoin","mgmt":"Crypto","type":"Global","data":pts}
                    print(f"  ✓ BTC      | {len(pts):5d} recs | {pts[0]['date']} → {pts[-1]['date']} | Bitcoin via Yahoo")
                    return
    except Exception as e:
        print(f"  ✗ BTC Yahoo fallback failed: {e}")
    print("  ✗ BTC — all sources failed")

# Fetch all global
fetch_coingecko_btc();             time.sleep(1)
fetch_yahoo_etf("GLD",  "Vàng (GLD ETF)",     "Commodity"); time.sleep(0.5)
fetch_yahoo_etf("SLV",  "Bạc (SLV ETF)",      "Commodity"); time.sleep(0.5)
fetch_yahoo_etf("SPY",  "S&P 500 (SPY)",       "US Market"); time.sleep(0.5)
fetch_yahoo_etf("QQQ",  "Nasdaq 100 (QQQ)",    "US Market"); time.sleep(0.5)
fetch_yahoo_etf("DIA",  "Dow Jones (DIA)",      "US Market"); time.sleep(0.5)

# ════════════════════════════════════════════════════════════
#  SAVE
# ════════════════════════════════════════════════════════════
with open(OUTPUT,"w",encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"\n{'=' * 65}")
print(f"  ✅ {len(result['funds'])} quỹ mở")
print(f"  ✅ {len(result['stocks'])} ETF/stocks/global")
print(f"  📁 → {OUTPUT}")
print("=" * 65)
