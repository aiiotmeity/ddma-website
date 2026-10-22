import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
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
  Clock,
  AlertTriangle,
  ShieldCheck,
  Phone,
  Download,
  MapPin,
  BarChart3,
  Table2,
  Info,
  ChevronLeft,
  ChevronRight,
  Landmark,
  Siren,
  CloudSun,
  Trees,
  Cpu,
  Camera,
  Database,
  FileDown,
  RefreshCw,
  LogIn,
  LogOut,
  Lock,
  User,
  Eye,
  EyeOff,
  Map as MapIcon,
  ExternalLink,
  Navigation,
  KeyRound,
  UserCircle2,
} from "lucide-react";
import "./App.css";

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  "http://127.0.0.1:8000/api"
).replace(/\/+$/, "");
const REFRESH_MS = 60_000;
const STALE_MINUTES = 30;
const PAGE_SIZE = 10;
const MOBILE_PAGE_SIZE = 3;
const HISTORY_INTERVAL_MIN = 30;
const MAX_CHART_POINTS = 1500;
const OLD_STORAGE_KEYS = ["ddma_arg_history_v1", "ddma_arg_history_v2_ARGS1", "ddma_arg_history_v2_ARGS2"];
const SELECTED_KEY = "ddma_arg_selected_station";
const SESSION_KEY = "ddma_arg_session";

const STATION_LOCATIONS = {
  ARGS1: { lat: 10.20395751276211, lng: 76.53282253409051 },
  ARGS2: { lat: 10.15, lng: 76.733331 },
};

const MAP_DEFAULT_CENTER = [10.177, 76.633];

const googleMapsUrl = ({ lat, lng }) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

const DEFAULT_STATIONS = [
  { id: "ARGS1", name: "Illithode", status: "active" },
  { id: "ARGS2", name: "Kuttampuzha", status: "pending" },
];

const RANGES = [
  { id: "6h", label: "6 Hours", short: "6H", hours: 6 },
  { id: "24h", label: "24 Hours", short: "24H", hours: 24 },
  { id: "7d", label: "7 Days", short: "7D", hours: 168 },
  { id: "30d", label: "30 Days", short: "30D", hours: 720 },
  // { id: "all", label: "All", short: "All", hours: 0 },
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

function clearOldBrowserHistory() {
  try {
    OLD_STORAGE_KEYS.forEach((k) => localStorage.removeItem(k));
  } catch {
    return;
  }
}

function downsample(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const size = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const avg = (key) => {
      const vals = chunk.map((r) => r[key]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const rain = chunk.map((r) => r.rainfall).filter((v) => v != null);
    out.push({
      ...chunk[chunk.length - 1],
      rainfall: rain.length ? Math.max(...rain) : null,
      temperature: avg("temperature"),
      humidity: avg("humidity"),
    });
  }
  return out;
}

let authToken = null;
let onAuthLost = null;

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (saved?.token && saved.expiresAt > Date.now()) return saved;
    localStorage.removeItem(SESSION_KEY);
  } catch {
    return null;
  }
  return null;
}

function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    return;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    return;
  }
}

function authHeaders() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
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
    const { res, json } = await requestJSON(`${API_BASE}/arg/stations/`);
    if (!res.ok || !json) return DEFAULT_STATIONS;
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
  const res = await fetch(url, { cache: "no-store", headers: authHeaders() });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status === 401) {
    onAuthLost?.(json?.error || "Your session has expired. Please sign in again.");
    throw new Error("Session expired");
  }
  return { res, json };
}

async function downloadMasterLog(station) {
  const res = await fetch(`${API_BASE}/arg/${encodeURIComponent(station.id)}/history.csv`, {
    cache: "no-store",
    headers: authHeaders(),
  });
  if (res.status === 401) {
    onAuthLost?.("Your session has expired. Please sign in again.");
    return;
  }
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const match = /filename="?([^"]+)"?/i.exec(res.headers.get("Content-Disposition") || "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = match ? match[1] : `${station.id}_MASTER_LOG.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function fetchLatest(id) {
  let { res, json } = await requestJSON(`${API_BASE}/arg/${encodeURIComponent(id)}/latest/`);
  if (res.status === 404 && id === DEFAULT_STATIONS[0].id) {
    ({ res, json } = await requestJSON(`${API_BASE}/arg/latest/`));
  }
  if (!res.ok || !json?.success) throw new Error(json?.error || `API error: ${res.status}`);
  return json;
}

async function fetchHistory(id, hours) {
  const { res, json } = await requestJSON(
    `${API_BASE}/arg/${encodeURIComponent(id)}/history/?hours=${hours}&interval=${HISTORY_INTERVAL_MIN}`
  );
  if (!res.ok || !json?.success) throw new Error(json?.error || `History error: ${res.status}`);
  return {
    readings: (json.readings || []).map((r) => ({
      t: r.t,
      label: r.label,
      rainfall: r.rainfall,
      temperature: r.temperature,
      humidity: r.humidity,
    })),
    summary: json.summary || {},
  };
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

const LOGOS = {
  ddma: { src: "/logos/ddma.png", name: "DDMA" },
  imd: { src: "/logos/imd.png", name: "IMD" },
  forest: { src: "/logos/forest.png", name: "Kerala Forest Department" },
  asiet: { src: "/logos/asiet.png", name: "ASIET" },
};

function Logo({ id, fallback }) {
  const [failed, setFailed] = useState(false);
  const logo = LOGOS[id];
  if (failed) return fallback ?? null;
  return (
    <img
      src={logo.src}
      alt={`${logo.name} logo`}
      className="logo-img"
      onError={() => setFailed(true)}
    />
  );
}

function StationPhoto() {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="about-photo">
      <img
        src="/images/arg-station.jpg"
        alt="Solar-powered Automatic Rain Gauge station with rain gauge, sensors and data logger inside a fenced enclosure"
        loading="lazy"
        onError={() => setFailed(true)}
      />
      <figcaption>
        <Camera size={14} />
        <span>Automatic Rain Gauge Station at Illithode</span>
      </figcaption>
    </figure>
  );
}

const escapeHtml = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function StationMap({ items, selectedId }) {
  const holder = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const fittedRef = useRef(false);

  useEffect(() => {
    fittedRef.current = false;
    const map = L.map(holder.current, { scrollWheelZoom: false, zoomSnap: 0.5 }).setView(MAP_DEFAULT_CENTER, 11);
    const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    });
    const satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri" }
    );
    street.addTo(map);
    L.control.layers({ Map: street, Satellite: satellite }, null, { position: "topright" }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(holder.current);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const group = layerRef.current;
    if (!map || !group) return;
    group.clearLayers();
    const points = [];

    items.forEach((s) => {
      if (!s.location) return;
      const { lat, lng } = s.location;
      points.push([lat, lng]);
      const icon = L.divIcon({
        className: "map-pin-wrap",
        html: `<div class="map-pin ${s.status}${s.id === selectedId ? " sel" : ""}"><span></span></div>`,
        iconSize: [34, 44],
        iconAnchor: [17, 42],
      });
      const reading = s.status === "pending"
        ? "Upcoming station"
        : s.reading
          ? `Rain ${fmt(s.reading.rainfall)} mm · ${fmt(s.reading.temperature)} °C · RH ${fmt(s.reading.humidity, 0)}%`
          : "Awaiting data";
      const marker = L.marker([lat, lng], { icon, title: `${s.name} – open in Google Maps`, riseOnHover: true });
      marker.bindTooltip(
        `<div class="map-tip"><strong>${escapeHtml(s.name)}</strong><span>${escapeHtml(s.id)}</span>` +
          `<p>${escapeHtml(reading)}</p><em>Click to open in Google Maps</em></div>`,
        { direction: "auto", offset: [0, -22], opacity: 1 }
      );
      marker.on("click", () => window.open(googleMapsUrl(s.location), "_blank", "noopener,noreferrer"));
      group.addLayer(marker);
    });

    if (!fittedRef.current && points.length) {
      if (points.length === 1) map.setView(points[0], 13);
      else map.fitBounds(points, { padding: [60, 60], maxZoom: 13 });
      fittedRef.current = true;
    }
  }, [items, selectedId]);

  return <div ref={holder} className="station-map" role="region" aria-label="Map of rain gauge stations" />;
}

function LoginPage({ onLogin, notice }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/auth/login/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        const left = json?.attemptsLeft;
        setError(
          (json?.error || `Sign-in failed (${res.status})`) +
            (left != null && left <= 3 ? ` ${left} attempt${left === 1 ? "" : "s"} left.` : "")
        );
        setPassword("");
        return;
      }
      onLogin({ token: json.token, user: json.user, expiresAt: json.expiresAt });
    } catch {
      setError("Unable to reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const checkCaps = (e) => setCapsLock(Boolean(e.getModifierState?.("CapsLock")));

  return (
    <div className="login-page">
      <div className="tricolor login-tricolor" aria-hidden="true"><span /><span /><span /></div>

      <aside className="login-hero">
        <div className="login-hero-bg" aria-hidden="true" />
        <div className="login-hero-inner">
          <div className="login-brand">
            <div className="seal"><Logo id="ddma" fallback={<ShieldCheck size={34} />} /></div>
            <div>
              <span className="login-kicker"><Landmark size={13} /> Government of Kerala</span>
              <strong>District Disaster Management Authority</strong>
              <span className="ml">ജില്ലാ ദുരന്ത നിവാരണ അതോറിറ്റി · എറണാകുളം</span>
            </div>
          </div>

          <div className="login-hero-copy">
            <h1>Automatic Rain Gauge<br />Monitoring System</h1>
            <p>Live rainfall, temperature and humidity from the upper Periyar catchment, for flood preparedness at Kalady.</p>
            <ul>
              <li><CloudRain size={16} /> Real-time observations every 15 minutes</li>
              <li><ShieldCheck size={16} /> IMD-standard stations at Illithode and Kuttampuzha</li>
              <li><Database size={16} /> Complete, continuous observation log</li>
            </ul>
          </div>

          <div className="login-partners">
            {Object.entries(LOGOS).map(([id, logo]) => (
              <div className="login-partner" key={id} title={logo.name}>
                <Logo id={id} fallback={<span>{logo.name}</span>} />
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="login-panel">
        <form className="login-card" onSubmit={submit} noValidate>
          <div className="login-lock"><Lock size={22} /></div>
          <h2>Secure sign in</h2>
          <p className="login-sub">Authorised DDMA personnel only</p>

          {notice && !error && (
            <div className="login-alert info" role="status"><Info size={16} /> <span>{notice}</span></div>
          )}
          {error && (
            <div className="login-alert" role="alert"><AlertTriangle size={16} /> <span>{error}</span></div>
          )}

          <label className="login-field">
            <span>Username</span>
            <div className="login-input">
              <User size={17} />
              <input
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck="false"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={busy}
                autoFocus
              />
            </div>
          </label>

          <label className="login-field">
            <span>Password</span>
            <div className="login-input">
              <KeyRound size={17} />
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={checkCaps}
                onKeyDown={checkCaps}
                disabled={busy}
              />
              <button
                type="button"
                className="login-eye"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            {capsLock && <small className="login-caps">Caps Lock is on</small>}
          </label>

          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? <RefreshCw size={17} className="spin" /> : <LogIn size={17} />}
            {busy ? "Verifying…" : "Sign in"}
          </button>

          <p className="login-legal">
            <ShieldCheck size={14} /> This is a restricted government system. Access is monitored and sessions
            expire automatically after 12 hours.
          </p>
        </form>

        <p className="login-credit">
          Developed by Centre for AI-IoT Innovation · ASIET
        </p>
      </main>
    </div>
  );
}

function LiveClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{fullFmt.format(now)} IST</span>;
}

function KpiCard({ title, value, unit, icon: Icon, accent, sub }) {
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
  const [session, setSession] = useState(() => {
    const saved = loadSession();
    authToken = saved?.token || null;
    return saved;
  });
  const [notice, setNotice] = useState("");

  const logout = useCallback((message = "") => {
    authToken = null;
    clearSession();
    setSession(null);
    setNotice(message);
  }, []);

  useEffect(() => {
    onAuthLost = (message) => logout(message);
    return () => {
      onAuthLost = null;
    };
  }, [logout]);

  useEffect(() => {
    if (!session) return undefined;
    const ms = session.expiresAt - Date.now();
    if (ms <= 0) {
      logout("Your session has expired. Please sign in again.");
      return undefined;
    }
    const id = setTimeout(() => logout("Your session has expired. Please sign in again."), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [session, logout]);

  const login = (next) => {
    authToken = next.token;
    saveSession(next);
    setNotice("");
    setSession(next);
  };

  if (!session) return <LoginPage onLogin={login} notice={notice} />;
  return <Dashboard key={session.token} session={session} onLogout={() => logout("You have been signed out.")} />;
}

function Dashboard({ session, onLogout }) {
  const [stations, setStations] = useState(DEFAULT_STATIONS);
  const [stationId, setStationId] = useState(() => readSelected() || DEFAULT_STATIONS[0].id);
  const [records, setRecords] = useState({});
  const [historyState, setHistoryState] = useState({ key: "", readings: [], summary: {}, loading: true, error: "" });
  const [range, setRange] = useState("24h");
  const [tab, setTab] = useState("rainfall");
  const [page, setPage] = useState(0);
  const [fontScale, setFontScale] = useState(100);
  const [logDownloading, setLogDownloading] = useState(false);
  const stationsRef = useRef(DEFAULT_STATIONS);

  const isMobile = useMediaQuery("(max-width: 640px)");
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setPage(0);
  }, [isMobile]);

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

  useEffect(() => {
    clearOldBrowserHistory();
  }, []);

  const station = stations.find((s) => s.id === stationId) || stations[0];
  const isPending = station.status === "pending";
  const rangeDef = RANGES.find((x) => x.id === range) || RANGES[1];
  const historyKey = `${station.id}|${rangeDef.hours}`;

  useEffect(() => {
    if (isPending) {
      setHistoryState({ key: historyKey, readings: [], summary: {}, loading: false, error: "" });
      return undefined;
    }
    let alive = true;
    const load = async (initial) => {
      if (initial) setHistoryState((prev) => ({ ...prev, key: historyKey, loading: true, error: "" }));
      try {
        const { readings, summary } = await fetchHistory(station.id, rangeDef.hours);
        if (alive) setHistoryState({ key: historyKey, readings, summary, loading: false, error: "" });
      } catch (err) {
        if (!alive) return;
        const msg = err?.message === "Failed to fetch" ? "Unable to connect to the server" : err?.message;
        setHistoryState((prev) => ({ ...prev, key: historyKey, loading: false, error: msg || "Unable to load history" }));
      }
    };
    load(true);
    const id = setInterval(() => load(false), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [historyKey, station.id, rangeDef.hours, isPending]);
  const record = records[station.id] || {};
  const result = record.json || null;
  const error = record.error || "";
  const loading = !isPending && !record.checkedAt;

  const latestRaw = getLatestRaw(result);
  const latest = toReading(latestRaw) || {};

  const historyReady = historyState.key === historyKey;
  const historyLoading = !historyReady || historyState.loading;
  const historyError = historyReady ? historyState.error : "";

  const history = useMemo(() => {
    const rows = historyReady ? historyState.readings : [];
    const last = rows[rows.length - 1];
    const slotMs = HISTORY_INTERVAL_MIN * 60000;
    const newSlot = latest.t && (!last || Math.floor(latest.t / slotMs) > Math.floor(last.t / slotMs));
    return newSlot ? [...rows, latest] : rows;
  }, [historyReady, historyState.readings, latest.t, latest.rainfall, latest.temperature, latest.humidity]);

  const category = classifyRain(latest.rainfall);
  const level = category?.level ?? "none";

  const minutesOld = latest.t ? (Date.now() - latest.t) / 60000 : null;
  const isStale = minutesOld != null && minutesOld > STALE_MINUTES;

  const filtered = history;

  const chartData = useMemo(
    () => downsample(filtered, MAX_CHART_POINTS).map((r) => ({ ...r, x: r.t ?? r.label })),
    [filtered]
  );

  const spanMs = filtered.length > 1 ? filtered[filtered.length - 1].t - filtered[0].t : 0;
  const tickFmt = (v) => {
    if (typeof v !== "number") return String(v).slice(-8);
    return spanMs <= 36 * 3600e3 ? timeFmt.format(new Date(v)) : dayFmt.format(new Date(v));
  };
  const summary = historyState.summary || {};

  const sRain = stats(filtered, "rainfall");
  const sTemp = stats(filtered, "temperature");
  const sHum = stats(filtered, "humidity");

  const pageSize = isMobile ? MOBILE_PAGE_SIZE : PAGE_SIZE;
  const tableRows = [...filtered].reverse();
  const pageCount = Math.max(1, Math.ceil(tableRows.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = tableRows.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const statusOf = (s) => {
    if (s.status === "pending") return "pending";
    const r = records[s.id];
    if (!r?.checkedAt) return "wait";
    return r.error ? "off" : "on";
  };

  const mapItems = useMemo(
    () =>
      stations.map((s) => ({
        id: s.id,
        name: s.name,
        status: statusOf(s),
        location: STATION_LOCATIONS[s.id] || null,
        reading: toReading(getLatestRaw(records[s.id]?.json)),
      })),
    [stations, records]
  );

  const handleLogDownload = async () => {
    setLogDownloading(true);
    try {
      await downloadMasterLog(station);
    } catch (err) {
      window.alert?.(err.message);
    } finally {
      setLogDownloading(false);
    }
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
            <div className="user-chip">
              <UserCircle2 size={15} />
              <span className="hide-xs">{session.user?.name || session.user?.username}</span>
              <button onClick={onLogout} aria-label="Sign out"><LogOut size={14} /><span className="hide-xs">Sign out</span></button>
            </div>
          </div>
        </div>
      </div>
      <div className="tricolor" aria-hidden="true"><span /><span /><span /></div>

      <header className="masthead">
        <div className="wrap masthead-inner">
          <div className="brand">
            <div className="seal"><Logo id="ddma" fallback={<ShieldCheck size={34} />} /></div>
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
            <a href="#map">Map</a>
            <a href="#about">About</a>
          </div>
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
              <KpiCard title="Rainfall" value={fmt(latest.rainfall)} unit="mm" icon={CloudRain} accent="rain" sub={category?.label ?? "IMD category"} />
              <KpiCard title="Temperature" value={fmt(latest.temperature)} unit="°C" icon={Thermometer} accent="temp" sub="Air temperature" />
              <KpiCard title="Relative Humidity" value={fmt(latest.humidity, 0)} unit="%" icon={Droplets} accent="hum" sub="Ambient RH" />
            </div>
          )}
        </section>

        <section id="history" className="section card">
          <div className="section-head">
            <div>
              <h2>Historical Trends</h2>
              <p>
                {station.name} ·{" "}
                {historyLoading
                  ? "Loading master log…"
                  : `${filtered.length.toLocaleString("en-IN")} observations · every ${HISTORY_INTERVAL_MIN} minutes`}
              </p>
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
            {historyLoading && chartData.length === 0 ? (
              <div className="chart-empty" style={{ height: chartHeight }}>
                <RefreshCw size={30} className="spin" />
                <p>Loading observation history…</p>
              </div>
            ) : chartData.length === 0 ? (
              <div className="chart-empty" style={{ height: chartHeight }}>
                <BarChart3 size={36} />
                <p>{historyError ? "Unable to load history" : "No observations in this period"}</p>
                <span>{historyError || (isPending ? "This station is not commissioned yet." : "Try a longer time range.")}</span>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={chartHeight}>{renderChart()}</ResponsiveContainer>
            )}
          </div>

          <div className="stat-row">
            <div><span>Rainfall</span><strong>{fmt(sRain.max)} mm</strong></div>
            <div><span>Temp. Max / Min</span><strong>{fmt(sTemp.max)}° / {fmt(sTemp.min)}°</strong></div>
            <div><span>Avg. Temperature</span><strong>{fmt(sTemp.avg)} °C</strong></div>
            <div><span>Avg. Humidity</span><strong>{fmt(sHum.avg, 0)} %</strong></div>
          </div>

          {/* {summary.firstReading && (
            <p className="history-source">
              <Database size={13} /> Master log holds{" "}
              <b>{Number(summary.totalReadings || 0).toLocaleString("en-IN")}</b> readings from{" "}
              {shortFmt.format(new Date(summary.firstReading))} to {shortFmt.format(new Date(summary.lastReading))}.
              Showing one reading every {HISTORY_INTERVAL_MIN} minutes.
            </p>
          )} */}

          <div className="legend-imd">
            <span><Info size={14} /> IMD 24-hr rainfall categories:</span>
            <span className="chip green">Light ≤ 15.5</span>
            <span className="chip yellow">Moderate 15.6–64.4</span>
            <span className="chip orange">Heavy 64.5–115.5</span>
            <span className="chip red">Very Heavy ≥ 115.6</span>
          </div>
        </section>

        <section id="map" className="section card map-section">
          <div className="section-head">
            <div>
              <h2><MapIcon size={20} /> Station Locations</h2>
              <p>Upper Periyar catchment · Click a station to open it in Google Maps</p>
            </div>
          </div>

          <div className="map-layout">
            <StationMap items={mapItems} selectedId={station.id} />

            <ul className="map-list">
              {mapItems.map((s) => (
                <li key={s.id} className={`map-item ${s.id === station.id ? "selected" : ""}`}>
                  <a
                    className="map-item-main"
                    href={s.location ? googleMapsUrl(s.location) : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open ${s.name} in Google Maps`}
                  >
                    <span className={`st-dot ${s.status}`} />
                    <span className="map-item-text">
                      <strong>{s.name}</strong>
                      <small>
                        {s.id}
                        {s.location && ` · ${s.location.lat.toFixed(4)}°N, ${s.location.lng.toFixed(4)}°E`}
                      </small>
                    </span>
                    <span className={`badge ${s.status}`}>
                      {s.status === "pending" ? "Upcoming" : s.status === "off" ? "Offline" : s.status === "wait" ? "Connecting" : "Active"}
                    </span>
                  </a>

                  {s.status !== "pending" && s.reading && (
                    <div className="map-item-stats">
                      <span><CloudRain size={13} /> {fmt(s.reading.rainfall)} mm</span>
                      <span><Thermometer size={13} /> {fmt(s.reading.temperature)} °C</span>
                      <span><Droplets size={13} /> {fmt(s.reading.humidity, 0)} %</span>
                    </div>
                  )}

                  <div className="map-item-actions">
                    {s.location && (
                      <a href={googleMapsUrl(s.location)} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={14} /> Google Maps
                      </a>
                    )}
                    {s.location && (
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${s.location.lat},${s.location.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Navigation size={14} /> Directions
                      </a>
                    )}
                    {s.status !== "pending" && s.id !== station.id && (
                      <button onClick={() => selectStation(s.id)}>View data</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="records" className="section card">
          <div className="section-head">
            <div>
              <h2><Table2 size={20} /> Observation Records</h2>
              <p>{station.name} · Every {HISTORY_INTERVAL_MIN} minutes</p>
            </div>
            <div className="records-actions">
              <button className="btn-outline" onClick={() => downloadCSV(tableRows, station)} disabled={!tableRows.length}>
                <Download size={16} /> This period
              </button>
              {!isPending && (
                <button className="btn-solid" onClick={handleLogDownload} disabled={logDownloading}>
                  {logDownloading ? <RefreshCw size={16} className="spin" /> : <FileDown size={16} />} Data Log
                </button>
              )}
            </div>
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
                  <tr className="empty-row">
                    <td colSpan={5} className="empty">
                      {historyLoading ? "Loading records…" : historyError || "No records in this period"}
                    </td>
                  </tr>
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
            <span>
              Page {safePage + 1} of {pageCount}
              {tableRows.length > 0 && (
                <small className="pager-range">
                  {" · "}
                  {safePage * pageSize + 1}–{Math.min(tableRows.length, (safePage + 1) * pageSize)} of{" "}
                  {tableRows.length.toLocaleString("en-IN")}
                </small>
              )}
            </span>
            <div>
              <button onClick={() => setPage(safePage - 1)} disabled={safePage === 0} aria-label="Previous page"><ChevronLeft size={16} /></button>
              <button onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1} aria-label="Next page"><ChevronRight size={16} /></button>
            </div>
          </div>
        </section>

        <section id="about" className="section card about">
          <span className="about-eyebrow">About the initiative</span>
          <h2>About the ARG Initiative</h2>

          <div className="about-top">
            <div className="about-lead">
              <p>
                Rainfall over the upstream catchment governs runoff and river flow at Kalady, which is not
                adequately monitored by existing IMD stations. This network of Automatic Rain Gauges
                provides continuous observations to support flood preparedness and early warning in
                Ernakulam district.
              </p>
              <p>
                The project follows <strong>IMD standards</strong> and is being developed in collaboration
                with the <strong>Forest Department</strong> and <strong>DDMA</strong>.
              </p>
            </div>

            <StationPhoto />
          </div>

          <h2 className="about-sub">A joint effort</h2>

          <div className="partner-grid">
            <article className="partner partner-ddma">
              <div className="partner-icon"><Logo id="ddma" fallback={<ShieldCheck size={22} />} /></div>
              <span className="partner-role">Lead Agency</span>
              <h4>District Disaster Management Authority, Ernakulam</h4>
              <p>
                Leads and coordinates the initiative, and puts the observations to work in flood
                preparedness, early warnings and response planning across the district.
              </p>
            </article>

            <article className="partner partner-imd">
              <div className="partner-icon"><Logo id="imd" fallback={<CloudSun size={22} />} /></div>
              <span className="partner-role">Standards &amp; Guidance</span>
              <h4>India Meteorological Department</h4>
              <p>
                The stations follow IMD standards for siting and instrumentation, so every reading is
                reliable and can be compared with the national observation network.
              </p>
            </article>

            <article className="partner partner-forest">
              <div className="partner-icon"><Logo id="forest" fallback={<Trees size={22} />} /></div>
              <span className="partner-role">Site Partner</span>
              <h4>Kerala Forest Department</h4>
              <p>
                Supports the stations in the forested upper catchment, from choosing the sites and
                providing access to helping keep the equipment safe in remote terrain.
              </p>
            </article>

            <article className="partner partner-asiet">
              <div className="partner-icon"><Logo id="asiet" fallback={<Cpu size={22} />} /></div>
              <span className="partner-role">Technology Partner</span>
              <h4>Adi Shankara Institute of Engineering and Technology</h4>
              <p>
                The <strong>Centre for AI-IoT Innovation</strong> designed and built the sensor network,
                the cloud data pipeline and this live monitoring dashboard.
              </p>
            </article>
          </div>
        </section>
      </main>

      <footer className="gov-footer">
        <div className="wrap footer-inner">
          <div>
            <strong>DDMA</strong>
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
              <span className="inst">ASIET</span>
            </p>
          </div>
        </div>
        <div className="footer-partners">
          <div className="wrap footer-partners-inner">
            <span>In collaboration with</span>
            <div className="footer-logos">
              {Object.entries(LOGOS).map(([id, logo]) => (
                <div className="footer-logo" key={id} title={logo.name}>
                  <Logo id={id} fallback={<span className="footer-logo-name">{logo.name}</span>} />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="footer-base">
          © {new Date().getFullYear()} DDMA Ernakulam · Automatic Rain Gauge Monitoring System
        </div>
      </footer>
    </div>
  );
}