import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  Brush,
} from "recharts";
import {
  CloudRain,
  Droplets,
  Thermometer,
  RefreshCw,
  Clock,
  AlertTriangle,
  ShieldCheck,
  Phone,
  Download,
  MapPin,
  Radio,
  BarChart3,
  Table2,
  Info,
  ChevronLeft,
  ChevronRight,
  Landmark,
  Siren,
  ListTree,
} from "lucide-react";
import "./App.css";

const API_BASE = (import.meta.env.VITE_API_URL || "http://127.0.0.1:8000/api").replace(/\/+$/, "");
const REFRESH_MS = 60_000;
const STALE_MINUTES = 30;
const MAX_HISTORY = 5000;
const PAGE_SIZE = 10;
const HISTORY_PREFIX = "ddma_arg_history_v2_";
const LEGACY_HISTORY_KEY = "ddma_arg_history_v1";
const SELECTED_KEY = "ddma_arg_selected_station";

const DEFAULT_STATIONS = [
  { id: "ARGS1", name: "Illithode", status: "active" },
  { id: "ARGS2", name: "Kuttampuzha", status: "pending" },
];

const RANGES = [
  { id: "6h", label: "6 Hours", short: "6H", ms: 6 * 3600e3 },
  { id: "24h", label: "24 Hours", short: "24H", ms: 24 * 3600e3 },
  { id: "7d", label: "7 Days", short: "7D", ms: 7 * 86400e3 },
  { id: "30d", label: "30 Days", short: "30D", ms: 30 * 86400e3 },
  { id: "all", label: "All", short: "All", ms: Infinity },
];

const CHART_TABS = [
  { id: "rainfall", label: "Rainfall", icon: CloudRain },
  { id: "temperature", label: "Temperature", icon: Thermometer },
  { id: "humidity", label: "Humidity", icon: Droplets },
  { id: "combined", label: "Combined", icon: BarChart3 },
];

const IMD_CATEGORIES = [
  { max: 0, label: "No Rain", level: "none" },
  { max: 2.4, label: "Very Light Rain", level: "green" },
  { max: 15.5, label: "Light Rain", level: "green" },
  { max: 64.4, label: "Moderate Rain", level: "yellow" },
  { max: 115.5, label: "Heavy Rain", level: "orange" },
  { max: 204.4, label: "Very Heavy Rain", level: "red" },
  { max: Infinity, label: "Extremely Heavy Rain", level: "red" },
];

const ALERT_TEXT = {
  none: "No rainfall recorded. Conditions normal.",
  green: "Normal conditions. No action required.",
  yellow: "Be aware. Monitor rainfall and river levels at Kalady.",
  orange: "Be prepared. Heavy rainfall over the upstream catchment.",
  red: "Take action. Very heavy rainfall — follow DDMA advisories.",
};

const C = {
  rain: "#1f6feb",
  temp: "#e8590c",
  hum: "#0d9488",
  orange: "#f08c00",
  red: "#d6336c",
  muted: "#5b6778",
  line: "#d9dfe8",
  grid: "#e9edf3",
  primary: "#0b3c7a",
};

const FIELDS = {
  rainfall: ["rfdmm", "rfd", "rainfall", "rainfallmm", "rain", "precipitation"],
  temperature: ["tc", "temp", "temperature", "temperaturec", "atc"],
  humidity: ["rh", "humidity", "relativehumidity", "rhpercent"],
  time: ["timestamp", "observedat", "datetime", "time", "date"],
};

const normalize = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

function pick(source, names) {
  if (!source || typeof source !== "object") return null;
  const hit = Object.entries(source).find(([k]) => names.includes(normalize(k)));
  return hit ? hit[1] : null;
}

const toNum = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

function parseTime(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (dmy) {
    const [, d, m, y, h, mi, se] = dmy;
    return new Date(+y, +m - 1, +d, +h, +mi, +(se || 0)).getTime();
  }
  let t = Date.parse(s);
  if (Number.isNaN(t)) t = Date.parse(s.replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
}

function toReading(raw) {
  if (!raw || typeof raw !== "object") return null;
  const timeRaw = pick(raw, FIELDS.time);
  return {
    t: parseTime(timeRaw),
    label: timeRaw != null ? String(timeRaw) : null,
    rainfall: toNum(pick(raw, FIELDS.rainfall)),
    temperature: toNum(pick(raw, FIELDS.temperature)),
    humidity: toNum(pick(raw, FIELDS.humidity)),
  };
}

function getLatestRaw(json) {
  const data = json?.data || {};
  return data.latest && typeof data.latest === "object" ? data.latest : data;
}

function extractReadings(json) {
  const data = json?.data || {};
  const apiHistory = [data.history, data.records, data.readings].find(Array.isArray) || [];
  return [...apiHistory.map(toReading), toReading(getLatestRaw(json))].filter(Boolean);
}

function loadHistory(id) {
  try {
    let raw = localStorage.getItem(HISTORY_PREFIX + id);
    if (!raw && id === DEFAULT_STATIONS[0].id) raw = localStorage.getItem(LEGACY_HISTORY_KEY);
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(id, list) {
  try {
    localStorage.setItem(HISTORY_PREFIX + id, JSON.stringify(list));
  } catch {
    return;
  }
}

function mergeHistory(existing, incoming) {
  const map = new Map();
  [...existing, ...incoming].forEach((r) => {
    if (!r || (r.t == null && !r.label)) return;
    map.set(r.t ?? r.label, r);
  });
  return [...map.values()].sort((a, b) => (a.t ?? 0) - (b.t ?? 0)).slice(-MAX_HISTORY);
}

function readSelected() {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

async function loadStations() {
  try {
    const res = await fetch(`${API_BASE}/arg/stations/`, { cache: "no-store" });
    if (!res.ok) return DEFAULT_STATIONS;
    const json = await res.json();
    const list = (Array.isArray(json.stations) ? json.stations : [])
      .filter((s) => s && s.id)
      .map((s) => ({
        id: String(s.id),
        name: s.name || String(s.id),
        status: s.status === "pending" ? "pending" : "active",
      }));
    return list.length ? list : DEFAULT_STATIONS;
  } catch {
    return DEFAULT_STATIONS;
  }
}

async function requestJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

async function fetchLatest(id) {
  let { res, json } = await requestJSON(`${API_BASE}/arg/${encodeURIComponent(id)}/latest/`);
  if (res.status === 404 && id === DEFAULT_STATIONS[0].id) {
    ({ res, json } = await requestJSON(`${API_BASE}/arg/latest/`));
  }
  if (!res.ok || !json?.success) throw new Error(json?.error || `API error: ${res.status}`);
  return json;
}

function classifyRain(mm) {
  if (mm == null) return null;
  return IMD_CATEGORIES.find((c) => mm <= c.max);
}

const fmt = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));

const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
const fullFmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Kolkata" });
const shortFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

function fmtTime(t, label) {
  if (t == null) return label ?? "—";
  return fullFmt.format(new Date(t));
}

function stats(list, key) {
  const vals = list.map((r) => r[key]).filter((v) => v != null);
  if (!vals.length) return { min: null, max: null, avg: null };
  return {
    min: Math.min(...vals),
    max: Math.max(...vals),
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
  };
}

function downloadCSV(rows, station) {
  const header = ["Station", "Timestamp", "Rainfall (mm)", "Temperature (°C)", "Humidity (%)"];
  const lines = rows.map((r) =>
    [station.id, fmtTime(r.t, r.label), r.rainfall ?? "", r.temperature ?? "", r.humidity ?? ""]
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(",")
  );
  const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${station.id}_history_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function LiveClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{fullFmt.format(now)} IST</span>;
}

function KpiCard({ title, value, unit, icon: Icon, accent, sub, trend }) {
  return (
    <article className={`kpi kpi-${accent}`}>
      <div className="kpi-head">
        <span>{title}</span>
        <div className="kpi-icon"><Icon size={20} /></div>
      </div>
      <div className="kpi-value">
        {value == null || value === "—" ? <span className="na">N/A</span> : <>{value}<small>{unit}</small></>}
      </div>
      <div className="kpi-foot">
        <span>{sub}</span>
        {/* {trend != null && trend !== 0 && (
          <span className={`trend ${trend > 0 ? "up" : "down"}`}>
            {trend > 0 ? "▲" : "▼"} {Math.abs(trend).toFixed(1)}
          </span>
        )} */}
      </div>
    </article>
  );
}

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="chart-tip">
      <strong>{fmtTime(r.t, r.label)}</strong>
      {payload.map((p) => (
        <div key={p.dataKey}>
          <i style={{ background: p.color }} />
          {p.name}: <b>{fmt(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [stations, setStations] = useState(DEFAULT_STATIONS);
  const [stationId, setStationId] = useState(() => readSelected() || DEFAULT_STATIONS[0].id);
  const [records, setRecords] = useState({});
  const [histories, setHistories] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState("24h");
  const [tab, setTab] = useState("rainfall");
  const [page, setPage] = useState(0);
  const [fontScale, setFontScale] = useState(100);
  const stationsRef = useRef(DEFAULT_STATIONS);

  const isMobile = useMediaQuery("(max-width: 640px)");

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontScale}%`;
  }, [fontScale]);

  useEffect(() => {
    try {
      localStorage.setItem(SELECTED_KEY, stationId);
    } catch {
      return;
    }
  }, [stationId]);

  const refreshAll = useCallback(async () => {
    const active = stationsRef.current.filter((s) => s.status !== "pending");
    if (!active.length) return;
    setRefreshing(true);

    const results = await Promise.all(
      active.map(async (s) => {
        try {
          return [s.id, { json: await fetchLatest(s.id), error: "" }];
        } catch (err) {
          const msg = err?.message === "Failed to fetch" ? "Unable to connect to the server" : err?.message;
          return [s.id, { json: null, error: msg || "Unable to retrieve station data" }];
        }
      })
    );

    const checkedAt = Date.now();
    setRecords((prev) => {
      const next = { ...prev };
      results.forEach(([id, r]) => {
        next[id] = r.json
          ? { json: r.json, error: "", checkedAt }
          : { json: prev[id]?.json ?? null, error: r.error, checkedAt };
      });
      return next;
    });

    setHistories((prev) => {
      const next = { ...prev };
      results.forEach(([id, r]) => {
        if (!r.json) return;
        const merged = mergeHistory(prev[id] ?? loadHistory(id), extractReadings(r.json));
        saveHistory(id, merged);
        next[id] = merged;
      });
      return next;
    });

    setRefreshing(false);
  }, []);

  useEffect(() => {
    let alive = true;
    let timer;
    (async () => {
      const list = await loadStations();
      if (!alive) return;
      stationsRef.current = list;
      setStations(list);
      setStationId((cur) => {
        const ok = list.find((s) => s.id === cur && s.status !== "pending");
        return ok ? cur : (list.find((s) => s.status !== "pending") || list[0]).id;
      });
      refreshAll();
      timer = setInterval(refreshAll, REFRESH_MS);
    })();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshAll]);

  const station = stations.find((s) => s.id === stationId) || stations[0];
  const isPending = station.status === "pending";
  const record = records[station.id] || {};
  const result = record.json || null;
  const error = record.error || "";
  const loading = !isPending && !record.checkedAt;

  const history = useMemo(
    () => histories[station.id] ?? loadHistory(station.id),
    [histories, station.id]
  );

  const latestRaw = getLatestRaw(result);
  const latest = toReading(latestRaw) || {};
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const trend = (k) => (latest[k] != null && previous?.[k] != null ? latest[k] - previous[k] : null);

  const category = classifyRain(latest.rainfall);
  const level = category?.level ?? "none";

  const minutesOld = latest.t ? (Date.now() - latest.t) / 60000 : null;
  const isStale = minutesOld != null && minutesOld > STALE_MINUTES;

  const filtered = useMemo(() => {
    const r = RANGES.find((x) => x.id === range);
    if (!r || r.ms === Infinity) return history;
    const anchor = history.length ? history[history.length - 1].t ?? Date.now() : Date.now();
    return history.filter((h) => h.t == null || h.t >= anchor - r.ms);
  }, [history, range]);

  const chartData = useMemo(() => filtered.map((r) => ({ ...r, x: r.t ?? r.label })), [filtered]);

  const rangeMs = RANGES.find((x) => x.id === range)?.ms ?? Infinity;
  const tickFmt = (v) => {
    if (typeof v !== "number") return String(v).slice(-8);
    return rangeMs <= 24 * 3600e3 ? timeFmt.format(new Date(v)) : dayFmt.format(new Date(v));
  };

  const sRain = stats(filtered, "rainfall");
  const sTemp = stats(filtered, "temperature");
  const sHum = stats(filtered, "humidity");

  const tableRows = [...filtered].reverse();
  const pageCount = Math.max(1, Math.ceil(tableRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = tableRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const allFields = Object.entries(latestRaw).filter(([, v]) => v === null || typeof v !== "object");

  const statusOf = (s) => {
    if (s.status === "pending") return "pending";
    const r = records[s.id];
    if (!r?.checkedAt) return "wait";
    return r.error ? "off" : "on";
  };

  const selectStation = (id) => {
    setStationId(id);
    setPage(0);
  };

  const chartHeight = isMobile ? 260 : 360;
  const tickSize = isMobile ? 10 : 12;
  const margin = isMobile ? { top: 8, right: 4, left: -8, bottom: 0 } : { top: 10, right: 16, left: 0, bottom: 0 };
  const axisProps = {
    dataKey: "x",
    tickFormatter: tickFmt,
    tick: { fontSize: tickSize, fill: C.muted },
    stroke: C.line,
    minTickGap: isMobile ? 20 : 28,
  };
  const yProps = { tick: { fontSize: tickSize, fill: C.muted }, stroke: C.line, width: isMobile ? 36 : 44 };
  const showBrush = !isMobile && chartData.length > 20;

  function renderChart() {
    const brush = showBrush && (
      <Brush dataKey="x" height={24} stroke={C.primary} tickFormatter={tickFmt} travellerWidth={8} />
    );

    if (tab === "rainfall")
      return (
        <BarChart data={chartData} margin={margin}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
          <XAxis {...axisProps} />
          <YAxis {...yProps} width={isMobile ? 40 : 60} unit={isMobile ? "" : " mm"} />
          <Tooltip content={<ChartTooltip />} />
          <ReferenceLine y={64.5} stroke={C.orange} strokeDasharray="5 4" label={{ value: isMobile ? "Heavy" : "Heavy (64.5 mm)", fill: C.orange, fontSize: 11, position: "insideTopRight" }} />
          <ReferenceLine y={115.6} stroke={C.red} strokeDasharray="5 4" label={{ value: isMobile ? "V. Heavy" : "Very Heavy (115.6 mm)", fill: C.red, fontSize: 11, position: "insideTopRight" }} />
          <Bar dataKey="rainfall" name="Rainfall (mm)" fill={C.rain} radius={[4, 4, 0, 0]} maxBarSize={28} />
          {brush}
        </BarChart>
      );

    if (tab === "temperature")
      return (
        <ComposedChart data={chartData} margin={margin}>
          <defs>
            <linearGradient id="gTemp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.temp} stopOpacity={0.35} />
              <stop offset="100%" stopColor={C.temp} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
          <XAxis {...axisProps} />
          <YAxis {...yProps} unit="°" domain={["dataMin - 1", "dataMax + 1"]} />
          <Tooltip content={<ChartTooltip />} />
          <Area type="monotone" dataKey="temperature" name="Temperature (°C)" stroke={C.temp} strokeWidth={2.5} fill="url(#gTemp)" dot={false} activeDot={{ r: 5 }} />
          {brush}
        </ComposedChart>
      );

    if (tab === "humidity")
      return (
        <ComposedChart data={chartData} margin={margin}>
          <defs>
            <linearGradient id="gHum" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.hum} stopOpacity={0.35} />
              <stop offset="100%" stopColor={C.hum} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
          <XAxis {...axisProps} />
          <YAxis {...yProps} unit="%" domain={[0, 100]} />
          <Tooltip content={<ChartTooltip />} />
          <Area type="monotone" dataKey="humidity" name="Humidity (%)" stroke={C.hum} strokeWidth={2.5} fill="url(#gHum)" dot={false} activeDot={{ r: 5 }} />
          {brush}
        </ComposedChart>
      );

    return (
      <ComposedChart data={chartData} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
        <XAxis {...axisProps} />
        <YAxis yAxisId="rain" {...yProps} width={isMobile ? 40 : 60} unit={isMobile ? "" : " mm"} />
        <YAxis yAxisId="pct" orientation="right" {...yProps} width={isMobile ? 30 : 44} domain={[0, 100]} />
        <Tooltip content={<ChartTooltip />} />
        <Legend wrapperStyle={{ fontSize: isMobile ? 11 : 13 }} />
        <Bar yAxisId="rain" dataKey="rainfall" name="Rainfall (mm)" fill={C.rain} radius={[4, 4, 0, 0]} maxBarSize={24} />
        <Line yAxisId="pct" type="monotone" dataKey="temperature" name="Temp (°C)" stroke={C.temp} strokeWidth={2} dot={false} />
        <Line yAxisId="pct" type="monotone" dataKey="humidity" name="RH (%)" stroke={C.hum} strokeWidth={2} dot={false} />
        {brush}
      </ComposedChart>
    );
  }

  return (
    <div className="gov">
      <a href="#main" className="skip-link">Skip to main content</a>

      <div className="util-bar">
        <div className="wrap util-inner">
          <span className="util-left"><Landmark size={14} /> Government of Kerala</span>
          <div className="util-right">
            <span className="hide-sm"><Clock size={13} /> <LiveClock /></span>
            <div className="a11y" role="group" aria-label="Text size">
              <button onClick={() => setFontScale((s) => Math.max(87.5, s - 12.5))} aria-label="Decrease text size">A-</button>
              <button onClick={() => setFontScale(100)} aria-label="Reset text size">A</button>
              <button onClick={() => setFontScale((s) => Math.min(125, s + 12.5))} aria-label="Increase text size">A+</button>
            </div>
          </div>
        </div>
      </div>
      <div className="tricolor" aria-hidden="true"><span /><span /><span /></div>

      <header className="masthead">
        <div className="wrap masthead-inner">
          <div className="brand">
            <div className="seal"><ShieldCheck size={34} /></div>
            <div>
              <h1>District Disaster Management Authority</h1>
              <p className="ml">ജില്ലാ ദുരന്ത നിവാരണ അതോറിറ്റി · എറണാകുളം</p>
              <p className="sub">Ernakulam · Automatic Rain Gauge Monitoring System</p>
            </div>
          </div>
          <a className="helpline" href="tel:1077">
            <Phone size={18} />
            <div>
              <span>Emergency Helpline</span>
              <strong>1077 · 112</strong>
            </div>
          </a>
        </div>
      </header>

      <nav className="main-nav" aria-label="Main">
        <div className="wrap nav-inner">
          <div className="nav-links">
            <a href="#overview">Dashboard</a>
            <a href="#history">History</a>
            <a href="#records">Records</a>
            <a href="#stations">Stations</a>
            <a href="#about">About</a>
          </div>
          {/* <button className="refresh-btn" onClick={refreshAll} disabled={refreshing} aria-label="Refresh data">
            <RefreshCw size={15} className={refreshing ? "spin" : ""} />
            <span className="hide-xs">{refreshing ? "Updating" : "Refresh"}</span>
          </button> */}
        </div>
      </nav>

      <div className={`alert-strip level-${isPending ? "none" : level}`} role="status">
        <div className="wrap alert-inner">
          <span className="alert-tag"><Siren size={15} /> {category && !isPending ? category.label : "Status"}</span>
          <span className="alert-msg">
            <b>{station.name}:</b>{" "}
            {isPending
              ? "Station not yet commissioned."
              : loading
                ? "Fetching latest observation…"
                : ALERT_TEXT[level]}
            {isStale && !isPending && " Data from station is delayed."}
          </span>
        </div>
      </div>

      <main id="main" className="wrap">
        <div className="crumb">
          <span>Home</span> › <span>ARG Network</span> › <strong>{station.id} – {station.name}</strong>
        </div>

        <div className="station-switch" role="tablist" aria-label="Select station">
          {stations.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === station.id}
              className={s.id === station.id ? "on" : ""}
              disabled={s.status === "pending"}
              onClick={() => selectStation(s.id)}
            >
              <span className={`st-dot ${statusOf(s)}`} />
              <span>{s.name}</span>
              <small>{s.status === "pending" ? "Upcoming" : s.id}</small>
            </button>
          ))}
        </div>

        {error && (
          <div className="error-box" role="alert">
            <AlertTriangle />
            <div>
              <strong>Unable to retrieve {station.name} data</strong>
              <p>{error}{result ? " · Showing last received values." : ""}</p>
            </div>
            <button onClick={refreshAll}>Retry</button>
          </div>
        )}

        <section id="overview" className="section">
          <div className="section-head">
            <div>
              <h2>Current Observations</h2>
              <p>
                <MapPin size={14} />
                <span>
                  {station.name} ARG ({station.id}) · Observed{" "}
                  {latest.t || latest.label ? fmtTime(latest.t, latest.label) : "—"}
                </span>
              </p>
            </div>
            <span className={`live-pill ${isPending ? "stale" : error ? "off" : isStale ? "stale" : ""}`}>
              <span className="dot" />
              {isPending ? "Upcoming" : loading ? "Connecting" : error ? "Offline" : isStale ? "Delayed" : "Live"}
            </span>
          </div>

          {isPending ? (
            <div className="notice">
              <Info size={20} />
              <p>{station.name} station is not commissioned yet. Observations will appear here once it starts reporting.</p>
            </div>
          ) : loading && !result ? (
            <div className="kpi-grid">
              {[0, 1, 2].map((i) => <div key={i} className="kpi skeleton" />)}
            </div>
          ) : (
            <div className="kpi-grid">
              <KpiCard title="Rainfall" value={fmt(latest.rainfall)} unit="mm" icon={CloudRain} accent="rain" sub={category?.label ?? "IMD category"} trend={trend("rainfall")} />
              <KpiCard title="Temperature" value={fmt(latest.temperature)} unit="°C" icon={Thermometer} accent="temp" sub="Air temperature" trend={trend("temperature")} />
              <KpiCard title="Relative Humidity" value={fmt(latest.humidity, 0)} unit="%" icon={Droplets} accent="hum" sub="Ambient RH" trend={trend("humidity")} />
            </div>
          )}
        </section>

        <section id="history" className="section card">
          <div className="section-head">
            <div>
              <h2>Historical Trends</h2>
              <p>{station.name} · {filtered.length} observations in selected period</p>
            </div>
            <div className="seg" role="tablist" aria-label="Time range">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={range === r.id}
                  className={range === r.id ? "on" : ""}
                  onClick={() => {
                    setRange(r.id);
                    setPage(0);
                  }}
                >
                  {isMobile ? r.short : r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="tabs" role="tablist" aria-label="Parameter">
            {CHART_TABS.map(({ id, label, icon: Icon }) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>

          <div className="chart-box" style={{ minHeight: chartHeight }}>
            {chartData.length === 0 ? (
              <div className="chart-empty" style={{ height: chartHeight }}>
                <BarChart3 size={36} />
                <p>No history available for this period yet.</p>
                <span>Readings are recorded every {REFRESH_MS / 1000} seconds while this page is open.</span>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={chartHeight}>{renderChart()}</ResponsiveContainer>
            )}
          </div>

          <div className="stat-row">
            <div><span>Peak Rainfall</span><strong>{fmt(sRain.max)} mm</strong></div>
            <div><span>Temp. Max / Min</span><strong>{fmt(sTemp.max)}° / {fmt(sTemp.min)}°</strong></div>
            <div><span>Avg. Temperature</span><strong>{fmt(sTemp.avg)} °C</strong></div>
            <div><span>Avg. Humidity</span><strong>{fmt(sHum.avg, 0)} %</strong></div>
          </div>

          <div className="legend-imd">
            <span><Info size={14} /> IMD 24-hr rainfall categories:</span>
            <span className="chip green">Light ≤ 15.5</span>
            <span className="chip yellow">Moderate 15.6–64.4</span>
            <span className="chip orange">Heavy 64.5–115.5</span>
            <span className="chip red">Very Heavy ≥ 115.6</span>
          </div>
        </section>

        <section id="records" className="section card">
          <div className="section-head">
            <div>
              <h2><Table2 size={20} /> Observation Records</h2>
              <p>{station.name} · Most recent first</p>
            </div>
            <button className="btn-outline" onClick={() => downloadCSV(tableRows, station)} disabled={!tableRows.length}>
              <Download size={16} /> Download CSV
            </button>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date &amp; Time (IST)</th>
                  <th>Rainfall (mm)</th>
                  <th>Temp (°C)</th>
                  <th>RH (%)</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 ? (
                  <tr className="empty-row"><td colSpan={5} className="empty">No records yet</td></tr>
                ) : (
                  pageRows.map((r, i) => {
                    const c = classifyRain(r.rainfall);
                    return (
                      <tr key={`${r.t ?? r.label}-${i}`}>
                        <td data-label="Date & Time" className="when">{fmtTime(r.t, r.label)}</td>
                        <td data-label="Rainfall (mm)" className="num">{fmt(r.rainfall)}</td>
                        <td data-label="Temp (°C)" className="num">{fmt(r.temperature)}</td>
                        <td data-label="RH (%)" className="num">{fmt(r.humidity, 0)}</td>
                        <td data-label="Category">{c ? <span className={`chip ${c.level}`}>{c.label}</span> : "—"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <span>Page {safePage + 1} of {pageCount}</span>
            <div>
              <button onClick={() => setPage(safePage - 1)} disabled={safePage === 0} aria-label="Previous page"><ChevronLeft size={16} /></button>
              <button onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1} aria-label="Next page"><ChevronRight size={16} /></button>
            </div>
          </div>
        </section>

        <section id="stations" className="section card">
          <h2><Radio size={20} /> Station Network</h2>
          <div className="station-grid">
            {stations.map((s) => {
              const st = statusOf(s);
              const r = toReading(getLatestRaw(records[s.id]?.json));
              const c = classifyRain(r?.rainfall);
              return (
                <article key={s.id} className={`station-card ${s.id === station.id ? "selected" : ""}`}>
                  <header>
                    <span className={`st-dot ${st}`} />
                    <div>
                      <strong>{s.name}</strong>
                      <small>{s.id}</small>
                    </div>
                    <span className={`badge ${st}`}>
                      {st === "pending" ? "Upcoming" : st === "off" ? "Offline" : st === "wait" ? "Connecting" : "Active"}
                    </span>
                  </header>
                  {s.status === "pending" ? (
                    <p className="station-note"></p>
                  ) : (
                    <dl>
                      <div><dt>Rainfall</dt><dd>{fmt(r?.rainfall)} mm</dd></div>
                      <div><dt>Temp</dt><dd>{fmt(r?.temperature)} °C</dd></div>
                      <div><dt>RH</dt><dd>{fmt(r?.humidity, 0)} %</dd></div>
                    </dl>
                  )}
                  <footer>
                    <span>{r?.t ? shortFmt.format(new Date(r.t)) : r?.label || "—"}</span>
                    {c && s.status !== "pending" && <span className={`chip ${c.level}`}>{c.label}</span>}
                  </footer>
                  {s.status !== "pending" && s.id !== station.id && (
                    <button className="btn-link" onClick={() => selectStation(s.id)}>View station →</button>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        {/* {allFields.length > 0 && !isPending && (
          <section className="section card">
            <h2><ListTree size={20} /> All Reported Parameters</h2>
            <div className="param-grid">
              {allFields.map(([k, v]) => (
                <div key={k}><span>{k}</span><strong>{v === null || v === "" ? "—" : String(v)}</strong></div>
              ))}
            </div>
          </section>
        )} */}

        <section id="about" className="section card about">
          <h2>About the ARG Initiative</h2>
          <p>
            Rainfall over the upstream catchment governs runoff and river flow at Kalady, which is not
            adequately monitored by existing IMD stations. This network of Automatic Rain Gauges
            provides continuous observations to support flood preparedness and early warning in
            Ernakulam district.
          </p>
          <p>
            The project is IMD-compliant and proposed jointly with the Forest Department and DDMA.
          </p>
        </section>
      </main>

      <footer className="gov-footer">
        <div className="wrap footer-inner">
          <div>
            <strong>District Disaster Management Authority, Ernakulam</strong>
            <p>Civil Station, Kakkanad, Ernakulam, Kerala</p>
          </div>
          <div>
            <strong>Emergency</strong>
            <p>District Control Room: 1077 · National Emergency: 112</p>
          </div>
          <div>
            <strong>Disclaimer</strong>
            <p>Observations are provisional and depend on sensor and communication availability.</p>
          </div>
          <div className="footer-credit">
            <strong>Developed By</strong>
            <p>
              Centre for AI-IoT Innovation
              <br />
              <span className="inst">Adi Shankara Institute of Engineering and Technology</span>
            </p>
          </div>
        </div>
        <div className="footer-base">
          © {new Date().getFullYear()} DDMA Ernakulam · Automatic Rain Gauge Monitoring System
        </div>
      </footer>
    </div>
  );
}