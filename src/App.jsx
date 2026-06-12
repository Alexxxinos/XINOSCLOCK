import React, { useState, useEffect, useRef } from "react";

/* ============================================================
   JOBSITE TIME TRACKER
   - Mobile worker punch flow (scan -> signup/login -> punch -> sign)
   - Supervisor dashboard (live roster, hours, flags, GPS)
   - QR code generator per jobsite
   - Geofence: flags if worker leaves >2000ft without clocking out
   ============================================================ */

// ---------- MOCK DATA LAYER ----------
// In production this all lives in Supabase (Postgres + Realtime + Auth).
// Tables: sites, workers, punch_events
// This mock layer mimics that shape so swapping to Supabase is mostly
// a matter of replacing these functions with supabase-js calls.

const FT_PER_METER = 3.28084;
const GEOFENCE_RADIUS_FT = 2000;

const SITES = [
  { id: "site_4", name: "Riverside Ave", code: "Site #4", lat: 41.0262, lng: -73.5783, foreman: "Dave Keller" },
  { id: "site_7", name: "Harbor Point", code: "Site #7", lat: 41.0345, lng: -73.6280, foreman: "Lena Brooks" },
];

const seedWorkers = [
  { id: "w1", name: "Marcus Johnson", company: "Xinos Construction", pin: "1234", initials: "MJ", color: "#0C447C", bg: "#E6F1FB" },
  { id: "w2", name: "Sofia Reyes", company: "Xinos Construction", pin: "1234", initials: "SR", color: "#085041", bg: "#E1F5EE" },
  { id: "w3", name: "Tyler Walsh", company: "Xinos Construction", pin: "1234", initials: "TW", color: "#633806", bg: "#FAEEDA" },
  { id: "w4", name: "Darnell Nixon", company: "Xinos Construction", pin: "1234", initials: "DN", color: "#3C3489", bg: "#EEEDFE" },
  { id: "w5", name: "Priya Lamon", company: "Xinos Construction", pin: "1234", initials: "PL", color: "#444441", bg: "#F1EFE8" },
];

// distance in feet between two lat/lng points (haversine)
function distFeet(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const meters = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return meters * FT_PER_METER;
}

// jitter a coordinate slightly (for demo realism)
function jitter(lat, lng, maxFt = 150) {
  const meters = maxFt / FT_PER_METER;
  const dLat = (Math.random() - 0.5) * (meters / 111320) * 2;
  const dLng = (Math.random() - 0.5) * (meters / (111320 * Math.cos((lat * Math.PI) / 180))) * 2;
  return { lat: lat + dLat, lng: lng + dLng };
}

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtHrs(ms) {
  return (ms / 3600000).toFixed(1);
}

// ---------- ICONS (inline SVG, no external lib needed) ----------
const Icon = ({ name, size = 16, style }) => {
  const paths = {
    building: "M4 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16M14 21V9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v12M4 21h16M8 7h0M8 11h0M8 15h0",
    pin: "M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11zM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    pinOff: "M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11zM3 3l18 18",
    login: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3",
    logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
    sign: "M3 17l4-4 4 4 4-8 4 4M3 21h18",
    alert: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h0",
    qr: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v3h-3M14 20h3M17 17h3v3",
    check: "M20 6 9 17l-5-5",
    lock: "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4",
    chevLeft: "M15 18l-6-6 6-6",
    refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
    dollar: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
    users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
};

// ---------- QR CODE (real, scannable) ----------
function QRCode({ value, size = 180 }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    import("qrcode").then((QRCodeLib) => {
      if (cancelled || !canvasRef.current) return;
      QRCodeLib.toCanvas(canvasRef.current, value, {
        width: size,
        margin: 1,
        color: { dark: "#1a1a1a", light: "#ffffff" },
      });
    });
    return () => { cancelled = true; };
  }, [value, size]);
  return <canvas ref={canvasRef} width={size} height={size} style={{ background: "#fff", borderRadius: 8 }} />;
}

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  // Parse the URL path to support QR deep-links like /punch/site_4
  const path = window.location.pathname;
  const punchMatch = path.match(/^\/punch\/([a-zA-Z0-9_-]+)/);
  const initialSiteId = punchMatch ? punchMatch[1] : null;
  const initialView = initialSiteId ? "worker" : "home";

  const [view, setView] = useState(initialView); // home | worker | supervisor
  const [siteId, setSiteId] = useState(initialSiteId || SITES[0].id);

  function goHome() {
    setView("home");
    window.history.pushState({}, "", "/");
  }

  return (
    <div style={{ fontFamily: "'Inter','Helvetica Neue',Arial,sans-serif", minHeight: "100%", background: "#F6F5F2", color: "#1A1A1A" }}>
      {view === "home" && <HomeScreen onSelect={setView} />}
      {view === "worker" && <WorkerApp onBack={goHome} siteId={siteId} />}
      {view === "supervisor" && <SupervisorApp onBack={goHome} />}
    </div>
  );
}

// ---------- HOME / ENTRY ----------
function HomeScreen({ onSelect }) {
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "60px 24px", textAlign: "center" }}>
      <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 56, height: 56, borderRadius: 14, background: "#1D9E75", color: "#fff", marginBottom: 20 }}>
        <Icon name="building" size={28} />
      </div>
      <h1 style={{ fontSize: 32, fontWeight: 600, margin: "0 0 8px", letterSpacing: "-0.02em" }}>SiteClock</h1>
      <p style={{ fontSize: 15, color: "#6B6A66", margin: "0 0 40px" }}>
        Scan in, scan out. Live crew tracking for every jobsite.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <button onClick={() => onSelect("worker")} style={cardBtn}>
          <Icon name="qr" size={26} style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>Worker punch</div>
          <div style={{ fontSize: 12, color: "#9A9893", marginTop: 4 }}>Simulates scanning the jobsite QR</div>
        </button>
        <button onClick={() => onSelect("supervisor")} style={cardBtn}>
          <Icon name="lock" size={26} style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>Supervisor dashboard</div>
          <div style={{ fontSize: 12, color: "#9A9893", marginTop: 4 }}>Live roster, hours, flags &amp; QR codes</div>
        </button>
      </div>

      <p style={{ fontSize: 12, color: "#B5B3AD", marginTop: 32 }}>
        Demo mode — uses sample data. GPS uses your real browser location.
      </p>
    </div>
  );
}

const cardBtn = {
  background: "#fff",
  border: "1px solid #E5E3DD",
  borderRadius: 14,
  padding: "24px 18px",
  cursor: "pointer",
  textAlign: "left",
  transition: "border-color .15s",
  color: "#1A1A1A",
};

// ============================================================
// WORKER APP (mobile punch flow)
// ============================================================
function WorkerApp({ onBack, siteId }) {
  const site = SITES.find((s) => s.id === siteId) || SITES[0];
  const [stage, setStage] = useState("scan"); // scan | login | signup | sign_in | checked_in | clockedin | sign_out | done
  const [worker, setWorker] = useState(null);
  const [pinInput, setPinInput] = useState("");
  const [error, setError] = useState("");
  const [signupForm, setSignupForm] = useState({ name: "", company: "", phone: "", pin: "" });
  const [gps, setGps] = useState(null);
  const [gpsStatus, setGpsStatus] = useState("locating"); // locating | locked | denied
  const [clockInTime, setClockInTime] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [geoFlag, setGeoFlag] = useState(null);

  // GPS acquisition
  useEffect(() => {
    if (!navigator.geolocation) { setGpsStatus("denied"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setGpsStatus("locked");
      },
      () => setGpsStatus("denied"),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, []);

  // live clock + geofence watch while on site (signed in through clocked-in)
  const onSiteStages = ["sign_in", "checked_in", "clockedin"];
  useEffect(() => {
    if (!onSiteStages.includes(stage)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    let watchId;
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const d = distFeet(site.lat, site.lng, pos.coords.latitude, pos.coords.longitude);
          setGeoFlag(d > GEOFENCE_RADIUS_FT ? Math.round(d) : null);
        },
        () => {},
        { enableHighAccuracy: true }
      );
    }
    return () => { clearInterval(t); if (watchId) navigator.geolocation.clearWatch(watchId); };
  }, [stage, site]);

  function tryLogin() {
    const found = seedWorkers.find((w) => w.pin === pinInput);
    if (found) { setWorker(found); setError(""); doClockIn(found); }
    else setError("PIN not recognized. Try 1234 for demo, or create an account.");
  }

  function doClockIn(w) {
    setClockInTime(Date.now());
    setStage("sign_in");
  }

  function submitSignup() {
    if (!signupForm.name || !signupForm.pin) { setError("Name and PIN are required."); return; }
    const newWorker = {
      id: "new_" + Date.now(),
      name: signupForm.name,
      company: signupForm.company || "—",
      pin: signupForm.pin,
      initials: signupForm.name.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase(),
      color: "#0C447C", bg: "#E6F1FB",
    };
    setWorker(newWorker);
    doClockIn(newWorker);
  }

  const elapsed = clockInTime ? now - clockInTime : 0;

  return (
    <Shell onBack={onBack} title="Worker punch">
      <div style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}>
        <div style={phoneStyle}>
          <div style={statusBar}><span>9:41</span><span>LTE</span></div>

          {stage === "scan" && (
            <div style={screenPad}>
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <SiteChip site={site} />
              </div>
              <div style={{ textAlign: "center", marginBottom: 18 }}>
                <Icon name="qr" size={64} style={{ color: "#1D9E75" }} />
                <p style={{ fontSize: 13, color: "#6B6A66", marginTop: 8 }}>QR code scanned</p>
              </div>
              <p style={{ fontSize: 13, fontWeight: 600, textAlign: "center", margin: "0 0 4px" }}>Enter your PIN</p>
              <p style={{ fontSize: 11, color: "#9A9893", textAlign: "center", margin: "0 0 14px" }}>Demo PIN: 1234</p>
              <input
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 4))}
                type="password" inputMode="numeric" placeholder="••••"
                style={{ ...inputStyle, textAlign: "center", fontSize: 22, letterSpacing: 6, marginBottom: 10 }}
              />
              {error && <p style={{ fontSize: 11, color: "#A32D2D", margin: "0 0 10px" }}>{error}</p>}
              <button onClick={tryLogin} style={submitBtn}>Continue</button>
              <button onClick={() => { setStage("signup"); setError(""); }} style={ghostBtn}>
                First time here? Create account
              </button>
              <GpsRow status={gpsStatus} />
            </div>
          )}

          {stage === "signup" && (
            <div style={screenPad}>
              <div style={{ textAlign: "center", marginBottom: 10 }}><SiteChip site={site} /></div>
              <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 2px" }}>Create account</p>
              <p style={{ fontSize: 11, color: "#9A9893", margin: "0 0 10px" }}>Takes about 30 seconds</p>
              <input style={inputStyle} placeholder="Full name" value={signupForm.name}
                onChange={(e) => setSignupForm({ ...signupForm, name: e.target.value })} />
              <input style={inputStyle} placeholder="Company" value={signupForm.company}
                onChange={(e) => setSignupForm({ ...signupForm, company: e.target.value })} />
              <input style={inputStyle} placeholder="Phone number" type="tel" value={signupForm.phone}
                onChange={(e) => setSignupForm({ ...signupForm, phone: e.target.value })} />
              <input style={inputStyle} placeholder="Create a 4-digit PIN" type="password" inputMode="numeric"
                maxLength={4} value={signupForm.pin}
                onChange={(e) => setSignupForm({ ...signupForm, pin: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
              {error && <p style={{ fontSize: 11, color: "#A32D2D", margin: "0 0 8px" }}>{error}</p>}
              <button onClick={submitSignup} style={submitBtn}>Create &amp; clock in</button>
              <button onClick={() => setStage("scan")} style={ghostBtn}>Back</button>
            </div>
          )}

          {stage === "sign_in" && worker && (
            <div style={screenPad}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px" }}>Sign to confirm</p>
              <p style={{ fontSize: 11, color: "#9A9893", margin: "0 0 12px" }}>You're checking in for the day</p>
              <Row label="Worker" value={worker.name} />
              <Row label="Clock in" value={fmtTime(new Date(clockInTime))} bold />
              <SignaturePad />
              <button onClick={() => setStage("checked_in")} style={submitBtn}>Submit &amp; check in</button>
            </div>
          )}

          {stage === "checked_in" && worker && (
            <div style={{ ...screenPad, textAlign: "center", paddingTop: 40 }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#EAF3DE", color: "#27500A", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                <Icon name="check" size={24} />
              </div>
              <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>Thank you, you're checked in</p>
              <p style={{ fontSize: 12, color: "#9A9893", margin: 0 }}>Clocked in at {fmtTime(new Date(clockInTime))}</p>
              <p style={{ fontSize: 12, color: "#9A9893", margin: "12px 0 0" }}>Rescan this code and tap "Clock out" at the end of your day.</p>
              <button onClick={() => setStage("clockedin")} style={{ ...ghostBtn, marginTop: 20 }}>View status</button>
            </div>
          )}

          {stage === "clockedin" && worker && (
            <div style={screenPad}>
              <div style={{ textAlign: "center", marginBottom: 10 }}><SiteChip site={site} /></div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 4 }}>
                <div style={{ width: 44, height: 44, borderRadius: "50%", background: worker.bg, color: worker.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                  {worker.initials}
                </div>
                <p style={{ fontSize: 14, fontWeight: 600, margin: 0, textAlign: "center" }}>{worker.name}</p>
                <p style={{ fontSize: 11, color: "#9A9893", margin: "2px 0 0" }}>On site since {fmtTime(new Date(clockInTime))}</p>
              </div>
              <div style={{ fontSize: 28, fontWeight: 600, textAlign: "center", margin: "12px 0 2px" }}>
                {Math.floor(elapsed / 3600000)}h {Math.floor((elapsed % 3600000) / 60000)}m
              </div>
              <p style={{ fontSize: 11, color: "#9A9893", textAlign: "center", margin: "0 0 16px" }}>time on site today</p>

              {geoFlag && (
                <div style={{ background: "#FCEBEB", color: "#791F1F", borderRadius: 10, padding: "10px 12px", fontSize: 12, marginBottom: 12, display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <Icon name="alert" size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>You're {geoFlag.toLocaleString()} ft from the jobsite. This will be flagged unless you clock out.</span>
                </div>
              )}

              <hr style={hr} />
              <button onClick={() => setStage("sign_out")} style={{ ...punchBtn, background: "#FCEBEB", color: "#791F1F" }}>
                <Icon name="logout" size={15} style={{ marginRight: 6, verticalAlign: -2 }} />Clock out
              </button>
              <GpsRow status={gpsStatus} accuracy={gps?.accuracy} />
            </div>
          )}

          {stage === "sign_out" && worker && (
            <div style={screenPad}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px" }}>Sign to confirm</p>
              <p style={{ fontSize: 11, color: "#9A9893", margin: "0 0 12px" }}>Left healthy and uninjured</p>
              <Row label="Clocked in" value={fmtTime(new Date(clockInTime))} />
              <Row label="Total hours" value={fmtHrs(elapsed) + " hrs"} bold />
              <SignaturePad />
              <button onClick={() => setStage("done")} style={submitBtn}>Submit &amp; clock out</button>
            </div>
          )}

          {stage === "done" && (
            <div style={{ ...screenPad, textAlign: "center", paddingTop: 40 }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#EAF3DE", color: "#27500A", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                <Icon name="check" size={24} />
              </div>
              <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>Thank you, you're checked out</p>
              <p style={{ fontSize: 12, color: "#9A9893", margin: 0 }}>Total: {fmtHrs(elapsed)} hrs · See you tomorrow</p>
              <button onClick={() => { setStage("scan"); setWorker(null); setClockInTime(null); setPinInput(""); }} style={{ ...ghostBtn, marginTop: 20 }}>Done</button>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6B6A66", marginBottom: 6 }}>
      <span>{label}</span>
      <span style={{ color: "#1A1A1A", fontWeight: bold ? 600 : 400 }}>{value}</span>
    </div>
  );
}

function SiteChip({ site }) {
  return (
    <span style={{ background: "#E6F1FB", color: "#0C447C", fontSize: 11, padding: "4px 10px", borderRadius: 20, display: "inline-flex", alignItems: "center", gap: 5 }}>
      <Icon name="building" size={12} />{site.code} — {site.name}
    </span>
  );
}

function GpsRow({ status, accuracy }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, color: "#9A9893", marginTop: 10 }}>
      <Icon name={status === "denied" ? "pinOff" : "pin"} size={13} />
      {status === "locating" && "GPS acquiring..."}
      {status === "locked" && `GPS locked${accuracy ? ` (±${Math.round(accuracy)}m)` : ""}`}
      {status === "denied" && "GPS unavailable — punch logged without location"}
    </div>
  );
}

function SignaturePad() {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    ctx.strokeStyle = "#1A1A1A";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return [t.clientX - r.left, t.clientY - r.top];
    };
    const start = (e) => { drawing.current = true; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); };
    const move = (e) => { if (!drawing.current) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); e.preventDefault(); };
    const end = () => { drawing.current = false; };
    c.addEventListener("mousedown", start); c.addEventListener("mousemove", move); c.addEventListener("mouseup", end);
    c.addEventListener("touchstart", start); c.addEventListener("touchmove", move); c.addEventListener("touchend", end);
    return () => {
      c.removeEventListener("mousedown", start); c.removeEventListener("mousemove", move); c.removeEventListener("mouseup", end);
      c.removeEventListener("touchstart", start); c.removeEventListener("touchmove", move); c.removeEventListener("touchend", end);
    };
  }, []);
  return (
    <canvas ref={canvasRef} width={148} height={60}
      style={{ border: "1px dashed #D8D6CF", borderRadius: 8, width: "100%", height: 60, marginBottom: 10, touchAction: "none" }} />
  );
}

// ============================================================
// SUPERVISOR APP
// ============================================================
const ADMIN_PASSWORD = "sitemanager"; // demo only — replace with Supabase auth

function SupervisorApp({ onBack }) {
  const [authed, setAuthed] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("dashboard"); // dashboard | qr

  if (!authed) {
    return (
      <Shell onBack={onBack} title="Supervisor login">
        <div style={{ maxWidth: 360, margin: "60px auto", padding: "0 24px" }}>
          <div style={{ background: "#fff", border: "1px solid #E5E3DD", borderRadius: 14, padding: 28 }}>
            <Icon name="lock" size={24} style={{ marginBottom: 12 }} />
            <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Supervisor access</p>
            <p style={{ fontSize: 12, color: "#9A9893", margin: "0 0 16px" }}>Demo password: sitemanager</p>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password"
              style={{ ...inputStyle, marginBottom: 10 }}
              onKeyDown={(e) => e.key === "Enter" && (pw === ADMIN_PASSWORD ? setAuthed(true) : setErr("Incorrect password"))} />
            {err && <p style={{ fontSize: 11, color: "#A32D2D", margin: "0 0 8px" }}>{err}</p>}
            <button onClick={() => (pw === ADMIN_PASSWORD ? setAuthed(true) : setErr("Incorrect password"))} style={submitBtn}>
              Sign in
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onBack={onBack} title="Supervisor dashboard">
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "0 20px 40px" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, marginTop: 16 }}>
          <TabBtn active={tab === "dashboard"} onClick={() => setTab("dashboard")}>Live dashboard</TabBtn>
          <TabBtn active={tab === "qr"} onClick={() => setTab("qr")}>Jobsite QR codes</TabBtn>
        </div>
        {tab === "dashboard" ? <Dashboard /> : <QRSection />}
      </div>
    </Shell>
  );
}

function TabBtn({ active, children, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 16px", borderRadius: 8, border: "1px solid " + (active ? "#1A1A1A" : "#E5E3DD"),
      background: active ? "#1A1A1A" : "#fff", color: active ? "#fff" : "#1A1A1A",
      fontSize: 13, fontWeight: 500, cursor: "pointer",
    }}>
      {children}
    </button>
  );
}

// ---------- LIVE DASHBOARD ----------
function Dashboard() {
  const site = SITES[0];
  const [roster, setRoster] = useState(() =>
    seedWorkers.map((w, i) => {
      const clockIn = new Date();
      clockIn.setHours(7, 45 + i * 4, 0, 0);
      const clockedOut = i >= 3; // last two are clocked out (matches earlier mockup)
      const out = clockedOut ? new Date(clockIn.getTime() + 9.3 * 3600000) : null;
      const { lat, lng } = jitter(site.lat, site.lng, i === 2 ? 2400 : 150); // Tyler (i=2) is off-site
      return {
        ...w,
        clockIn,
        clockOut: out,
        status: clockedOut ? "out" : "in",
        lat, lng,
        flag: i === 2 ? "gps_in" : null,
      };
    })
  );
  const [tick, setTick] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // recompute geofence flags live
  useEffect(() => {
    setRoster((prev) =>
      prev.map((w) => {
        if (w.status !== "in") return w;
        const d = distFeet(site.lat, site.lng, w.lat, w.lng);
        return { ...w, distFt: Math.round(d), flag: d > GEOFENCE_RADIUS_FT ? "geofence" : null };
      })
    );
  }, [tick, site]);

  const onSite = roster.filter((w) => w.status === "in").length;
  const totalHoursToday = roster.reduce((sum, w) => {
    const end = w.clockOut ? w.clockOut.getTime() : tick;
    return sum + (end - w.clockIn.getTime());
  }, 0);
  const flagged = roster.filter((w) => w.flag);

  return (
    <div>
      <div style={topbar}>
        <div>
          <p style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
            <Icon name="building" size={16} style={{ verticalAlign: -3, marginRight: 6 }} />
            {site.code} — {site.name}
          </p>
          <p style={{ fontSize: 12, color: "#6B6A66", margin: "4px 0 0" }}>
            Foreman: {site.foreman} · {new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
          </p>
        </div>
        <div style={{ background: "#EAF3DE", color: "#27500A", fontSize: 11, padding: "4px 10px", borderRadius: 20, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3B6D11", animation: "pulse 1.5s infinite" }} />
          Live
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 10, marginBottom: 16 }}>
        <Metric label="On site now" value={onSite} />
        <Metric label="Total workers today" value={roster.length} />
        <Metric label="Hours billed today" value={fmtHrs(totalHoursToday)} />
        <Metric label="Flags" value={flagged.length} danger={flagged.length > 0} />
      </div>

      <SectionHead>Live roster</SectionHead>
      <div style={card}>
        <div style={{ ...rosterRow, ...rowHeader }}>
          <div></div><div>Worker</div><div>Status</div><div>Clock in</div><div>Clock out</div><div>Hours today</div><div>Flag</div>
        </div>
        {roster.map((w) => {
          const end = w.clockOut ? w.clockOut.getTime() : tick;
          const hrs = fmtHrs(end - w.clockIn.getTime());
          return (
            <div key={w.id} style={rosterRow}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: w.bg, color: w.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>{w.initials}</div>
              <div>
                <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>{w.name}</p>
                <p style={{ fontSize: 11, color: "#9A9893", margin: 0 }}>{w.company}</p>
              </div>
              <div>
                <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: w.status === "in" ? "#EAF3DE" : "#F1EFE8", color: w.status === "in" ? "#27500A" : "#6B6A66" }}>
                  {w.status === "in" ? "On site" : "Clocked out"}
                </span>
              </div>
              <div style={{ fontSize: 13 }}>{fmtTime(w.clockIn)}</div>
              <div style={{ fontSize: 13, color: w.clockOut ? "#1A1A1A" : "#B5B3AD" }}>{w.clockOut ? fmtTime(w.clockOut) : "—"}</div>
              <div style={{ fontSize: 13 }}>{hrs} hrs</div>
              <div>
                {w.flag === "geofence" && (
                  <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: "#FCEBEB", color: "#791F1F", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Icon name="pinOff" size={11} />{w.distFt?.toLocaleString()} ft away
                  </span>
                )}
                {w.flag === "gps_in" && (
                  <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: "#FCEBEB", color: "#791F1F", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Icon name="pinOff" size={11} />Off-site GPS
                  </span>
                )}
                {!w.flag && <span style={{ fontSize: 12, color: "#D8D6CF" }}>—</span>}
              </div>
            </div>
          );
        })}
      </div>

      <SectionHead>Flags &amp; alerts</SectionHead>
      <div style={{ ...card, borderColor: flagged.length ? "#F0C8C8" : "#E5E3DD", padding: "12px 14px", marginBottom: 16 }}>
        {flagged.length === 0 && <p style={{ fontSize: 12, color: "#9A9893", margin: 0 }}>No active flags.</p>}
        {flagged.map((w) => (
          <div key={w.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderBottom: "0.5px solid #F0EEE8" }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: "#FCEBEB", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon name="alert" size={14} style={{ color: "#A32D2D" }} />
            </div>
            <div>
              <p style={{ fontSize: 12, margin: "0 0 2px" }}>
                {w.name} —{" "}
                {w.flag === "geofence"
                  ? `currently ${w.distFt?.toLocaleString()} ft from jobsite (limit ${GEOFENCE_RADIUS_FT.toLocaleString()} ft) without clocking out`
                  : "GPS punched from off-site location"}
              </p>
              <p style={{ fontSize: 11, color: "#9A9893", margin: 0 }}>
                Clock in at {fmtTime(w.clockIn)} · {w.lat.toFixed(4)}, {w.lng.toFixed(4)}
              </p>
            </div>
          </div>
        ))}
      </div>

      <SectionHead>Hours summary (this week)</SectionHead>
      <div style={card}>
        <div style={{ ...hoursRow, ...rowHeader }}>
          <div>Worker</div><div>Today</div><div>This week</div><div>Progress</div>
        </div>
        {roster.map((w, i) => {
          const end = w.clockOut ? w.clockOut.getTime() : tick;
          const today = (end - w.clockIn.getTime()) / 3600000;
          const week = today + [29, 27.5, 25.5, 29.5, 28.5][i % 5];
          const pct = Math.min(100, Math.round((week / 40) * 100));
          return (
            <div key={w.id} style={hoursRow}>
              <div style={{ fontSize: 13 }}>{w.name}</div>
              <div style={{ fontSize: 13 }}>{today.toFixed(1)} hrs</div>
              <div style={{ fontSize: 13 }}>{week.toFixed(1)} hrs</div>
              <div>
                <div style={{ width: 60, height: 5, borderRadius: 3, background: "#F1EFE8", display: "inline-block" }}>
                  <div style={{ width: pct + "%", height: 5, borderRadius: 3, background: "#1D9E75" }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value, danger }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E3DD", borderRadius: 10, padding: "12px 14px" }}>
      <p style={{ fontSize: 11, color: "#9A9893", margin: "0 0 4px" }}>{label}</p>
      <p style={{ fontSize: 22, fontWeight: 600, margin: 0, color: danger ? "#A32D2D" : "#1A1A1A" }}>{value}</p>
    </div>
  );
}
function SectionHead({ children }) {
  return <p style={{ fontSize: 12, fontWeight: 600, color: "#9A9893", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 8px" }}>{children}</p>;
}

// ---------- QR SECTION ----------
function QRSection() {
  const [sites, setSites] = useState(SITES);
  const [name, setName] = useState("");

  function addSite() {
    if (!name.trim()) return;
    const id = "site_" + (sites.length + 1);
    setSites([...sites, { id, name: name.trim(), code: `Site #${sites.length + 1}`, lat: 41.03 + Math.random() * 0.02, lng: -73.6 + Math.random() * 0.02, foreman: "—" }]);
    setName("");
  }

  return (
    <div>
      <SectionHead>Generate a new jobsite code</SectionHead>
      <div style={{ ...card, padding: "14px 16px", marginBottom: 20, display: "flex", gap: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jobsite name (e.g. Maple St Renovation)"
          style={{ ...inputStyle, marginBottom: 0, flex: 1 }} onKeyDown={(e) => e.key === "Enter" && addSite()} />
        <button onClick={addSite} style={{ ...submitBtn, marginTop: 0, width: 140 }}>Create code</button>
      </div>

      <SectionHead>Active jobsite codes</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 16 }}>
        {sites.map((s) => {
          const url = `${window.location.origin}/punch/${s.id}`;
          return (
            <div key={s.id} style={{ ...card, padding: 16, textAlign: "center" }}>
              <QRCode value={url} size={160} />
              <p style={{ fontSize: 13, fontWeight: 600, margin: "10px 0 2px" }}>{s.code} — {s.name}</p>
              <p style={{ fontSize: 11, color: "#9A9893", margin: "0 0 8px", wordBreak: "break-all" }}>{url}</p>
              <p style={{ fontSize: 11, color: "#9A9893", margin: 0 }}>Print, laminate, and post at site entrance. Each scan checks the worker in automatically.</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- SHARED CHROME ----------
function Shell({ onBack, title, children }) {
  return (
    <div>
      <div style={{ borderBottom: "1px solid #E5E3DD", padding: "14px 20px", display: "flex", alignItems: "center", gap: 10, background: "#fff" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", color: "#6B6A66" }}>
          <Icon name="chevLeft" size={20} />
        </button>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      </div>
      {children}
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
    </div>
  );
}

// ---------- SHARED STYLES ----------
const phoneStyle = { width: 320, background: "#fff", borderRadius: 28, border: "1px solid #E5E3DD", overflow: "hidden", boxShadow: "0 8px 30px rgba(0,0,0,0.06)" };
const statusBar = { background: "#1a1a1a", color: "#fff", fontSize: 12, padding: "10px 18px", display: "flex", justifyContent: "space-between" };
const screenPad = { padding: "24px 22px" };
const inputStyle = { width: "100%", boxSizing: "border-box", border: "1px solid #E5E3DD", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#1A1A1A", background: "#FAFAF8", marginBottom: 8 };
const submitBtn = { display: "block", width: "100%", padding: 12, borderRadius: 10, border: "none", background: "#1D9E75", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", marginTop: 4 };
const ghostBtn = { display: "block", width: "100%", padding: 10, borderRadius: 10, border: "none", background: "transparent", color: "#6B6A66", fontSize: 12, cursor: "pointer", marginTop: 6, textAlign: "center" };
const punchBtn = { display: "block", width: "100%", padding: 13, borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer", textAlign: "center" };
const hr = { border: "none", borderTop: "0.5px solid #F0EEE8", margin: "10px 0" };
const topbar = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, paddingTop: 4 };
const card = { background: "#fff", border: "1px solid #E5E3DD", borderRadius: 12, marginBottom: 16, overflow: "hidden" };
const rosterRow = { display: "grid", gridTemplateColumns: "32px 1.6fr 90px 80px 80px 90px 130px", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "0.5px solid #F0EEE8" };
const hoursRow = { display: "grid", gridTemplateColumns: "1.6fr 90px 90px 90px", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: "0.5px solid #F0EEE8" };
const rowHeader = { background: "#FAFAF8", fontSize: 11, color: "#9A9893", fontWeight: 600, borderBottom: "0.5px solid #E5E3DD" };
