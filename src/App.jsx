import React, { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

/* ============================================================
   JOBSITE TIME TRACKER
   - Mobile worker punch flow (scan -> signup/login -> punch -> sign)
   - Supervisor dashboard (live roster, hours, flags, GPS)
   - QR code generator per jobsite
   - Geofence: flags if worker leaves >2000ft without clocking out

   Data is stored in Supabase:
   - sites: jobsite id, name, code, lat/lng, foreman
   - workers: id, name, company, pin, initials, color, bg
   - punch_events: worker_id, site_id, type (clock_in/clock_out),
     timestamp, lat/lng, gps_accuracy, flagged, flag_reason
   ============================================================ */

const FT_PER_METER = 3.28084;
const GEOFENCE_RADIUS_FT = 2000;

// Fallback site used only if the sites table hasn't loaded yet
const FALLBACK_SITE = { id: "site_4", name: "Riverside Ave", code: "Site #4", lat: 41.0262, lng: -73.5783, foreman: "Dave Keller" };

// ---------- DEVICE LOCK (anti buddy-punching) ----------
// Each physical device can only be used to sign in as ONE worker per
// jobsite per day. This stops one person from scanning in coworkers
// using their PINs. The lock is keyed by site so the same phone CAN
// be used for a different jobsite (e.g. a supervisor visiting multiple
// sites), but not to clock in multiple different people at the same site.
function deviceLockKey(siteId) {
  const today = new Date().toISOString().slice(0, 10);
  return `xora_lock_${siteId}_${today}`;
}
function getDeviceLock(siteId) {
  try {
    const raw = localStorage.getItem(deviceLockKey(siteId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setDeviceLock(siteId, workerId, workerName) {
  try {
    localStorage.setItem(deviceLockKey(siteId), JSON.stringify({ workerId, workerName }));
  } catch {}
}


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
    x: "M18 6 6 18M6 6l12 12",
    calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
    printer: "M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
};

// ---------- QR CODE (real, scannable) ----------
const QRCode = React.forwardRef(function QRCode({ value, size = 180 }, forwardedRef) {
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
  return <canvas ref={(el) => { canvasRef.current = el; if (forwardedRef) forwardedRef.current = el; }} width={size} height={size} style={{ background: "#fff", borderRadius: 8 }} />;
});

// ---------- RESPONSIVE HELPER ----------
function useIsMobile(breakpoint = 720) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    function onResize() { setIsMobile(window.innerWidth < breakpoint); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
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
  const [siteId, setSiteId] = useState(initialSiteId || FALLBACK_SITE.id);
  const [sites, setSites] = useState([FALLBACK_SITE]);

  useEffect(() => {
    supabase.from("sites").select("*").then(({ data, error }) => {
      if (!error && data && data.length) setSites(data);
    });
  }, []);

  function goHome() {
    setView("home");
    window.history.pushState({}, "", "/");
  }

  return (
    <div style={{ fontFamily: "'Inter','Helvetica Neue',Arial,sans-serif", minHeight: "100%", background: "#F6F5F2", color: "#1A1A1A" }}>
      {view === "home" && <HomeScreen onSelect={setView} />}
      {view === "worker" && <WorkerApp onBack={goHome} siteId={siteId} sites={sites} />}
      {view === "supervisor" && <SupervisorApp onBack={goHome} sites={sites} setSites={setSites} />}
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
      <h1 style={{ fontSize: 32, fontWeight: 600, margin: "0 0 8px", letterSpacing: "-0.02em" }}>Xora</h1>
      <p style={{ fontSize: 15, color: "#6B6A66", margin: "0 0 6px" }}>
        Just Xora in. Live crew tracking for every jobsite.
      </p>
      <p style={{ fontSize: 12, color: "#B5B3AD", margin: "0 0 40px" }}>
        Powered by Xinos Construction
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
function WorkerApp({ onBack, siteId, sites }) {
  const site = sites.find((s) => s.id === siteId) || sites[0] || FALLBACK_SITE;
  const [stage, setStage] = useState("loading"); // loading | scan | signup | sign_in | checked_in | clockedin | sign_out | done
  const [worker, setWorker] = useState(null);
  const [pinInput, setPinInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [error, setError] = useState("");
  const [signupForm, setSignupForm] = useState({ name: "", company: "", phone: "", pin: "" });
  const [gps, setGps] = useState(null);
  const gpsRef = useRef(null);
  useEffect(() => { gpsRef.current = gps; }, [gps]);
  const [gpsStatus, setGpsStatus] = useState("locating"); // locating | locked | denied
  const gpsStatusRef = useRef("locating");
  useEffect(() => { gpsStatusRef.current = gpsStatus; }, [gpsStatus]);
  const [clockInTime, setClockInTime] = useState(null);
  const [openPunchId, setOpenPunchId] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [geoFlag, setGeoFlag] = useState(null);
  const [busy, setBusy] = useState(false);

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

  // Wait briefly for GPS to resolve before clocking in, so the geofence
  // check on clock-in has real coordinates instead of nulls. Falls back
  // after ~6s if GPS is slow/unavailable so the worker isn't stuck.
  async function waitForGps(maxMs = 6000) {
    const start = Date.now();
    while (gpsStatusRef.current === "locating" && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Once we know who the worker is, check whether they already have
  // an open (un-clocked-out) punch for this site — if so, skip
  // straight to the clocked-in view instead of asking to clock in again.
  async function checkOpenPunch(w) {
    const { data } = await supabase
      .from("punch_events")
      .select("*")
      .eq("worker_id", w.id)
      .eq("site_id", site.id)
      .order("timestamp", { ascending: false })
      .limit(1);

    const last = data && data[0];
    if (last && last.type === "clock_in") {
      setClockInTime(new Date(last.timestamp).getTime());
      setOpenPunchId(last.id);
      setStage("clockedin");
    } else {
      await doClockIn(w);
    }
  }

  useEffect(() => {
    setStage("loading");
    // On first load, no worker is identified yet — show the PIN screen.
    setStage("scan");
  }, [site.id]);

  // live clock + geofence watch while on site
  const onSiteStages = ["sign_in", "checked_in", "clockedin"];
  useEffect(() => {
    if (!onSiteStages.includes(stage)) return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    let watchId;
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const d = distFeet(site.lat, site.lng, pos.coords.latitude, pos.coords.longitude);
          setGeoFlag(d > GEOFENCE_RADIUS_FT ? Math.round(d) : null);
          // If we're already clocked in and drift outside the geofence,
          // write a flag onto the open punch event so the supervisor
          // dashboard can surface it.
          if (d > GEOFENCE_RADIUS_FT && openPunchId) {
            supabase.from("punch_events").update({
              flagged: true,
              flag_reason: `${Math.round(d)} ft from jobsite`,
            }).eq("id", openPunchId);
          }
        },
        () => {},
        { enableHighAccuracy: true }
      );
    }
    return () => { clearInterval(t); if (watchId) navigator.geolocation.clearWatch(watchId); };
  }, [stage, site, openPunchId]);

  async function tryLogin() {
    setBusy(true);
    setError("");
    const { data, error: qErr } = await supabase
      .from("workers")
      .select("*")
      .eq("pin", pinInput)
      .ilike("name", `%${nameInput.trim()}%`)
      .limit(1);
    setBusy(false);
    if (qErr || !data || !data.length) {
      setError("Name + PIN not recognized. Try Marcus Johnson / 1234 for demo, or create an account.");
      return;
    }
    const found = data[0];

    // Device lock check: if this device already signed someone else in
    // at this jobsite today, block a different worker from using it.
    const lock = getDeviceLock(site.id);
    if (lock && lock.workerId !== found.id) {
      setError(`This device was already used to sign in ${lock.workerName} at this jobsite today. Each device can only sign in one worker per jobsite per day. Ask ${lock.workerName} to use their own device, or have them sign out first.`);
      return;
    }

    setWorker(found);
    await checkOpenPunch(found);
  }

  // GPS coordinates to attach to a punch, with geofence flag check
  function currentGpsPayload() {
    const g = gpsRef.current;
    if (!g) return { lat: null, lng: null, gps_accuracy: null, flagged: false, flag_reason: null };
    const d = distFeet(site.lat, site.lng, g.lat, g.lng);
    const flagged = d > GEOFENCE_RADIUS_FT;
    return {
      lat: g.lat, lng: g.lng, gps_accuracy: g.accuracy,
      flagged, flag_reason: flagged ? `Clocked in ${Math.round(d)} ft from jobsite` : null,
    };
  }

  async function doClockIn(w) {
    setBusy(true);
    await waitForGps();
    const payload = currentGpsPayload();
    const { data, error: insErr } = await supabase
      .from("punch_events")
      .insert({ worker_id: w.id, site_id: site.id, type: "clock_in", ...payload })
      .select()
      .single();
    setBusy(false);
    if (insErr) { setError("Couldn't save your clock-in: " + insErr.message); return; }
    setDeviceLock(site.id, w.id, w.name);
    setClockInTime(new Date(data.timestamp).getTime());
    setOpenPunchId(data.id);
    setStage("sign_in");
  }

  async function doClockOut() {
    setBusy(true);
    await waitForGps();
    const payload = currentGpsPayload();
    await supabase.from("punch_events").insert({
      worker_id: worker.id, site_id: site.id, type: "clock_out", ...payload,
    });
    setBusy(false);
    setStage("done");
  }

  async function submitSignup() {
    if (!signupForm.name || !signupForm.pin) { setError("Name and PIN are required."); return; }

    // Device lock check applies to new accounts too — if this device
    // already signed someone else in at this jobsite today, don't
    // allow creating yet another account from the same device.
    const lock = getDeviceLock(site.id);
    if (lock) {
      setError(`This device was already used to sign in ${lock.workerName} at this jobsite today. Each device can only sign in one worker per jobsite per day. Please use your own device.`);
      return;
    }

    setBusy(true);
    setError("");
    const initials = signupForm.name.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase();
    const { data, error: insErr } = await supabase
      .from("workers")
      .insert({
        name: signupForm.name,
        company: signupForm.company || null,
        pin: signupForm.pin,
        initials,
        color: "#0C447C",
        bg: "#E6F1FB",
      })
      .select()
      .single();
    setBusy(false);
    if (insErr) {
      setError("Couldn't create your account. Try again.");
      return;
    }
    setWorker(data);
    doClockIn(data);
  }

  const elapsed = clockInTime ? now - clockInTime : 0;

  return (
    <Shell onBack={onBack} title="Worker punch">
      <div style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}>
        <div style={phoneStyle}>
          <div style={statusBar}><span>9:41</span><span>LTE</span></div>

          {stage === "loading" && (
            <div style={{ ...screenPad, textAlign: "center", paddingTop: 60 }}>
              <p style={{ fontSize: 12, color: "#9A9893" }}>Loading...</p>
            </div>
          )}

          {stage === "scan" && (
            <div style={screenPad}>
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <SiteChip site={site} />
              </div>
              <div style={{ textAlign: "center", marginBottom: 18 }}>
                <Icon name="qr" size={64} style={{ color: "#1D9E75" }} />
                <p style={{ fontSize: 13, color: "#6B6A66", marginTop: 8 }}>QR code scanned</p>
              </div>
              <p style={{ fontSize: 13, fontWeight: 600, textAlign: "center", margin: "0 0 4px" }}>Sign in</p>
              <p style={{ fontSize: 11, color: "#9A9893", textAlign: "center", margin: "0 0 14px" }}>Demo: Marcus Johnson / 1234</p>
              <input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                type="text" placeholder="Full name"
                style={{ ...inputStyle, marginBottom: 8 }}
              />
              <input
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 4))}
                type="password" inputMode="numeric" placeholder="PIN"
                style={{ ...inputStyle, textAlign: "center", fontSize: 22, letterSpacing: 6, marginBottom: 10 }}
              />
              {error && <p style={{ fontSize: 11, color: "#A32D2D", margin: "0 0 10px" }}>{error}</p>}
              <button onClick={tryLogin} disabled={busy} style={submitBtn}>{busy ? "Checking..." : "Continue"}</button>
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
              <button onClick={submitSignup} disabled={busy} style={submitBtn}>{busy ? "Creating..." : "Create & clock in"}</button>
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
              <button onClick={doClockOut} disabled={busy} style={submitBtn}>{busy ? "Saving..." : "Submit & clock out"}</button>
            </div>
          )}

          {stage === "done" && (
            <div style={{ ...screenPad, textAlign: "center", paddingTop: 40 }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#EAF3DE", color: "#27500A", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                <Icon name="check" size={24} />
              </div>
              <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>Thank you, you're checked out</p>
              <p style={{ fontSize: 12, color: "#9A9893", margin: 0 }}>Total: {fmtHrs(elapsed)} hrs · See you tomorrow</p>
              <button onClick={() => { setStage("scan"); setWorker(null); setClockInTime(null); setOpenPunchId(null); setPinInput(""); setGeoFlag(null); }} style={{ ...ghostBtn, marginTop: 20 }}>Done</button>
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
  const ctxRef = useRef(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    function setup() {
      const rect = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // Fallback dimensions if the canvas hasn't been laid out yet
      const w = rect.width || 280;
      const h = rect.height || 60;
      c.width = w * dpr;
      c.height = h * dpr;
      const ctx = c.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = "#1A1A1A";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctxRef.current = ctx;
    }

    // Defer to next frame so the element has real layout dimensions
    const raf = requestAnimationFrame(setup);

    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return [t.clientX - r.left, t.clientY - r.top];
    };
    const start = (e) => {
      drawing.current = true;
      const ctx = ctxRef.current;
      if (!ctx) return;
      const [x, y] = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      e.preventDefault();
    };
    const move = (e) => {
      if (!drawing.current) return;
      const ctx = ctxRef.current;
      if (!ctx) return;
      const [x, y] = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      e.preventDefault();
    };
    const end = (e) => { drawing.current = false; e.preventDefault(); };

    c.addEventListener("mousedown", start);
    c.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    c.addEventListener("touchstart", start, { passive: false });
    c.addEventListener("touchmove", move, { passive: false });
    c.addEventListener("touchend", end, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      c.removeEventListener("mousedown", start);
      c.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      c.removeEventListener("touchstart", start);
      c.removeEventListener("touchmove", move);
      c.removeEventListener("touchend", end);
    };
  }, []);

  return (
    <canvas ref={canvasRef}
      style={{ border: "1px dashed #D8D6CF", borderRadius: 8, width: "100%", height: 60, marginBottom: 10, touchAction: "none", display: "block" }} />
  );
}

// ============================================================
// SUPERVISOR APP
// ============================================================
const ADMIN_PASSWORD = "sitemanager"; // demo only — replace with Supabase auth

function SupervisorApp({ onBack, sites, setSites }) {
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
        <div style={{ display: "flex", gap: 8, marginBottom: 16, marginTop: 16, overflowX: "auto", paddingBottom: 2 }}>
          <TabBtn active={tab === "dashboard"} onClick={() => setTab("dashboard")}>Live dashboard</TabBtn>
          <TabBtn active={tab === "qr"} onClick={() => setTab("qr")}>Jobsite QR codes</TabBtn>
          <TabBtn active={tab === "workers"} onClick={() => setTab("workers")}>Workers</TabBtn>
        </div>
        {tab === "dashboard" && <Dashboard sites={sites} />}
        {tab === "qr" && <QRSection sites={sites} setSites={setSites} />}
        {tab === "workers" && <WorkersSection />}
      </div>
    </Shell>
  );
}

function TabBtn({ active, children, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 16px", borderRadius: 8, border: "1px solid " + (active ? "#1A1A1A" : "#E5E3DD"),
      background: active ? "#1A1A1A" : "#fff", color: active ? "#fff" : "#1A1A1A",
      fontSize: 13, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
    }}>
      {children}
    </button>
  );
}

// ---------- LIVE DASHBOARD ----------
function Dashboard({ sites }) {
  const isMobile = useIsMobile();
  const [selectedSiteId, setSelectedSiteId] = useState(sites[0]?.id || FALLBACK_SITE.id);
  const site = sites.find((s) => s.id === selectedSiteId) || sites[0] || FALLBACK_SITE;
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(Date.now());

  // Date being viewed, as a YYYY-MM-DD string (defaults to today)
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  });
  const todayStr = new Date().toISOString().slice(0, 10);
  const isToday = selectedDate === todayStr;

  // Once real sites load, default to the first one if nothing selected yet
  useEffect(() => {
    if (sites.length && !sites.find((s) => s.id === selectedSiteId)) {
      setSelectedSiteId(sites[0].id);
    }
  }, [sites]);

  // Fetch raw punch events for the selected site + day from Supabase.
  // This is the only function that hits the database -- the roster rows
  // themselves are derived from this data client-side (see useMemo below),
  // so the live "hours so far" counter can tick every few seconds without
  // re-querying the database each time.
  async function loadEvents() {
    setLoading(true);
    const dayStart = new Date(selectedDate + "T00:00:00");
    const dayEnd = new Date(selectedDate + "T23:59:59.999");

    const { data, error } = await supabase
      .from("punch_events")
      .select("*, workers(*)")
      .eq("site_id", site.id)
      .gte("timestamp", dayStart.toISOString())
      .lte("timestamp", dayEnd.toISOString())
      .order("timestamp", { ascending: true });

    if (!error && data) setEvents(data);
    setLoading(false);
  }

  useEffect(() => {
    loadEvents();
  }, [site.id, selectedDate]);

  // Build roster: for each worker, pair the selected day's clock_in/clock_out
  // events into shifts. A worker can have multiple shifts in a day if they
  // left and came back. Recomputed whenever events, tick, or isToday change
  // -- this is pure client-side math, no network call.
  const roster = React.useMemo(() => {
    // group by worker
    const byWorker = {};
    for (const ev of events) {
      if (!ev.workers) continue;
      const wid = ev.worker_id;
      if (!byWorker[wid]) byWorker[wid] = { worker: ev.workers, events: [] };
      byWorker[wid].events.push(ev);
    }

    const rows = Object.values(byWorker).map(({ worker, events }) => {
      // pair clock_in/clock_out sequentially to compute total ms worked that day
      let totalMs = 0;
      let openClockIn = null;
      let firstClockIn = null;
      let lastClockOut = null;
      let shiftCount = 0;
      let activeFlag = null;
      let activeFlagLoc = null;

      for (const ev of events) {
        const t = new Date(ev.timestamp).getTime();
        if (ev.type === "clock_in") {
          openClockIn = ev;
          if (!firstClockIn) firstClockIn = ev;
          if (ev.flagged) { activeFlag = "gps_in"; activeFlagLoc = ev; }
        } else if (ev.type === "clock_out" && openClockIn) {
          totalMs += t - new Date(openClockIn.timestamp).getTime();
          openClockIn = null;
          lastClockOut = ev;
          shiftCount += 1;
        }
      }

      const stillOpen = !!openClockIn;
      if (stillOpen) {
        // Only count "still running" time for today. For past days with no
        // clock-out, we don't know when they stopped, so just show the
        // time up to clock-in (0) and flag it as missing a clock-out.
        if (isToday) {
          totalMs += tick - new Date(openClockIn.timestamp).getTime();
        }
        const latest = events[events.length - 1];
        if (latest.flagged && latest.type === "clock_in") {
          activeFlag = "geofence";
          activeFlagLoc = latest;
        }
      }

      return {
        id: worker.id,
        name: worker.name,
        company: worker.company,
        initials: worker.initials,
        color: worker.color,
        bg: worker.bg,
        status: stillOpen ? "in" : "out",
        // Show the FIRST clock-in of the day (when they arrived) and the
        // LAST clock-out (most recent departure), since "Hours" is a sum
        // across all shifts -- showing only the latest shift's times next
        // to a multi-shift total would be misleading.
        clockIn: firstClockIn ? new Date(firstClockIn.timestamp) : null,
        clockOut: lastClockOut ? new Date(lastClockOut.timestamp) : null,
        shiftCount: shiftCount + (stillOpen ? 1 : 0),
        totalMs,
        flag: activeFlag,
        flagLoc: activeFlagLoc,
        missingClockOut: stillOpen && !isToday,
      };
    });

    // sort: on site first, then by clock-in time
    rows.sort((a, b) => {
      if (a.status !== b.status) return a.status === "in" ? -1 : 1;
      return (a.clockIn?.getTime() || 0) - (b.clockIn?.getTime() || 0);
    });

    return rows;
  }, [events, tick, isToday]);

  // ---- Export to CSV ----
  const [exportOpen, setExportOpen] = useState(false);
  const [exportStart, setExportStart] = useState(selectedDate);
  const [exportEnd, setExportEnd] = useState(selectedDate);
  const [exporting, setExporting] = useState(false);

  function csvEscape(val) {
    const s = String(val ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function downloadCsv(filename, rows) {
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Export every raw punch event in the date range for this site,
  // one row per clock-in/clock-out, plus computed daily totals per worker.
  async function exportRange() {
    setExporting(true);
    const dayStart = new Date(exportStart + "T00:00:00");
    const dayEnd = new Date(exportEnd + "T23:59:59.999");

    const { data: events, error } = await supabase
      .from("punch_events")
      .select("*, workers(*)")
      .eq("site_id", site.id)
      .gte("timestamp", dayStart.toISOString())
      .lte("timestamp", dayEnd.toISOString())
      .order("timestamp", { ascending: true });

    setExporting(false);
    if (error || !events) return;

    // Sheet 1 style: raw punch log
    const rawRows = [
      ["Jobsite", "Worker", "Company", "Type", "Date", "Time", "Latitude", "Longitude", "GPS Accuracy (m)", "Flagged", "Flag Reason"],
    ];
    for (const ev of events) {
      const t = new Date(ev.timestamp);
      rawRows.push([
        `${site.code} - ${site.name}`,
        ev.workers?.name || "Unknown",
        ev.workers?.company || "",
        ev.type === "clock_in" ? "Clock In" : "Clock Out",
        t.toLocaleDateString(),
        t.toLocaleTimeString(),
        ev.lat ?? "",
        ev.lng ?? "",
        ev.gps_accuracy ?? "",
        ev.flagged ? "Yes" : "No",
        ev.flag_reason || "",
      ]);
    }

    downloadCsv(
      `${site.code.replace(/[^a-z0-9]/gi, "_")}_punches_${exportStart}_to_${exportEnd}.csv`,
      rawRows
    );

    // Sheet 2 style: daily totals per worker per day (separate file, since
    // CSV doesn't support multiple sheets)
    const dailyTotals = {}; // key: date|workerId
    for (const ev of events) {
      const dateStr = new Date(ev.timestamp).toLocaleDateString();
      const key = dateStr + "|" + ev.worker_id;
      if (!dailyTotals[key]) {
        dailyTotals[key] = {
          date: dateStr,
          worker: ev.workers?.name || "Unknown",
          company: ev.workers?.company || "",
          totalMs: 0,
          openClockIn: null,
          missingClockOut: false,
          flags: 0,
        };
      }
      const row = dailyTotals[key];
      if (ev.type === "clock_in") {
        row.openClockIn = new Date(ev.timestamp).getTime();
        if (ev.flagged) row.flags += 1;
      } else if (ev.type === "clock_out" && row.openClockIn) {
        row.totalMs += new Date(ev.timestamp).getTime() - row.openClockIn;
        row.openClockIn = null;
      }
    }
    for (const row of Object.values(dailyTotals)) {
      if (row.openClockIn) row.missingClockOut = true;
    }

    const totalsRows = [
      ["Jobsite", "Date", "Worker", "Company", "Total Hours", "Flags", "Missing Clock-Out"],
    ];
    for (const row of Object.values(dailyTotals)) {
      totalsRows.push([
        `${site.code} - ${site.name}`,
        row.date,
        row.worker,
        row.company,
        row.missingClockOut ? "" : (row.totalMs / 3600000).toFixed(2),
        row.flags,
        row.missingClockOut ? "Yes" : "No",
      ]);
    }

    downloadCsv(
      `${site.code.replace(/[^a-z0-9]/gi, "_")}_hours_summary_${exportStart}_to_${exportEnd}.csv`,
      totalsRows
    );

    setExportOpen(false);
  }

  // Live tick: drives the "hours so far" display for today's open shifts.
  // This does NOT hit the database -- it just forces the useMemo above to
  // recompute totalMs for anyone currently clocked in.
  //
  // Refresh rate adapts to the time of day: fast during typical
  // clock-in/clock-out windows when activity is highest, slower midday
  // and overnight when little is changing.
  //   6am-9am, 3pm-7pm  -> every 10s  (shift start/end rush)
  //   9am-3pm           -> every 30s  (steady work hours)
  //   7pm-6am           -> every 2min (overnight, rarely active)
  function getRefreshIntervalMs() {
    const hour = new Date().getHours();
    if ((hour >= 6 && hour < 9) || (hour >= 15 && hour < 19)) return 10000;
    if (hour >= 9 && hour < 15) return 30000;
    return 120000;
  }

  useEffect(() => {
    if (!isToday) return;
    let timer;
    function schedule() {
      timer = setTimeout(() => {
        setTick(Date.now());
        schedule(); // re-evaluate interval each time, in case the hour bucket changed
      }, getRefreshIntervalMs());
    }
    schedule();
    return () => clearTimeout(timer);
  }, [isToday]);

  // realtime: refetch events whenever a punch event changes for this site,
  // but only when viewing today (historical views shouldn't shift under you)
  useEffect(() => {
    if (!isToday) return;
    const channel = supabase
      .channel("punch_events_" + site.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "punch_events", filter: `site_id=eq.${site.id}` }, () => {
        loadEvents();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [site.id, isToday]);

  const onSite = roster.filter((w) => w.status === "in").length;
  const totalHoursToday = roster.reduce((sum, w) => sum + w.totalMs, 0);
  const flagged = roster.filter((w) => w.flag);

  return (
    <div>
      <div style={{ ...topbar, flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "flex-start" : "center", gap: isMobile ? 12 : 0 }}>
        <div>
          <p style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
            <Icon name="building" size={16} style={{ verticalAlign: -3, marginRight: 6 }} />
            {site.code} — {site.name}
          </p>
          <p style={{ fontSize: 12, color: "#6B6A66", margin: "4px 0 0" }}>
            Foreman: {site.foreman || "—"}{site.foreman_phone ? ` (${site.foreman_phone})` : ""}
            {site.created_at && ` · Created ${new Date(site.created_at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`}
          </p>
          <p style={{ fontSize: 12, color: "#6B6A66", margin: "2px 0 0" }}>
            Viewing {new Date(selectedDate + "T00:00:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", year: "numeric" })}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", width: isMobile ? "100%" : "auto" }}>
          <select
            value={selectedSiteId}
            onChange={(e) => setSelectedSiteId(e.target.value)}
            style={{
              fontSize: 13, padding: "7px 10px", borderRadius: 8, border: "1px solid #E5E3DD",
              background: "#fff", color: "#1A1A1A", cursor: "pointer",
              flex: isMobile ? "1 1 100%" : "initial",
            }}
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
            ))}
          </select>
          <div style={{ position: "relative", display: "flex", alignItems: "center", flex: isMobile ? "1 1 auto" : "initial" }}>
            <Icon name="calendar" size={14} style={{ position: "absolute", left: 10, color: "#9A9893", pointerEvents: "none" }} />
            <input
              type="date"
              value={selectedDate}
              max={todayStr}
              onChange={(e) => setSelectedDate(e.target.value)}
              style={{
                fontSize: 13, padding: "7px 10px 7px 32px", borderRadius: 8, border: "1px solid #E5E3DD",
                background: "#fff", color: "#1A1A1A", cursor: "pointer", width: isMobile ? "100%" : "auto",
              }}
            />
          </div>
          {!isToday && (
            <button onClick={() => setSelectedDate(todayStr)} style={{ ...ghostBtn, margin: 0, padding: "7px 10px", whiteSpace: "nowrap", border: "1px solid #E5E3DD", borderRadius: 8 }}>
              Back to today
            </button>
          )}
          {isToday && (
            <div style={{ background: "#EAF3DE", color: "#27500A", fontSize: 11, padding: "4px 10px", borderRadius: 20, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3B6D11", animation: "pulse 1.5s infinite" }} />
              Live
            </div>
          )}
          <button
            onClick={() => { setExportStart(selectedDate); setExportEnd(selectedDate); setExportOpen(true); }}
            style={{ ...submitBtn, margin: 0, width: isMobile ? "100%" : "auto", padding: "7px 14px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, whiteSpace: "nowrap" }}
          >
            <Icon name="download" size={14} />Export
          </button>
        </div>
      </div>

      {exportOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}
          onClick={() => setExportOpen(false)}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 360, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
            <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Export to Excel/CSV</p>
            <p style={{ fontSize: 12, color: "#9A9893", margin: "0 0 16px" }}>
              Downloads two CSV files for {site.code} — {site.name}: a raw punch log and a daily hours summary. Both open directly in Excel.
            </p>
            <p style={{ fontSize: 12, fontWeight: 500, margin: "0 0 4px" }}>From</p>
            <input type="date" value={exportStart} max={todayStr} onChange={(e) => setExportStart(e.target.value)} style={{ ...inputStyle, marginBottom: 10 }} />
            <p style={{ fontSize: 12, fontWeight: 500, margin: "0 0 4px" }}>To</p>
            <input type="date" value={exportEnd} max={todayStr} onChange={(e) => setExportEnd(e.target.value)} style={{ ...inputStyle, marginBottom: 16 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={exportRange} disabled={exporting} style={{ ...submitBtn, margin: 0, flex: 1 }}>
                {exporting ? "Exporting..." : "Download CSV files"}
              </button>
              <button onClick={() => setExportOpen(false)} style={{ ...ghostBtn, margin: 0, flex: 1, border: "1px solid #E5E3DD", borderRadius: 10, padding: "12px" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2,minmax(0,1fr))" : "repeat(4,minmax(0,1fr))", gap: 10, marginBottom: 16 }}>
        <Metric label={isToday ? "On site now" : "Still clocked in (no checkout)"} value={onSite} />
        <Metric label="Total workers" value={roster.length} />
        <Metric label="Hours billed" value={fmtHrs(totalHoursToday)} />
        <Metric label="Flags" value={flagged.length} danger={flagged.length > 0} />
      </div>

      <SectionHead>{isToday ? "Live roster" : "Roster for this day"}</SectionHead>
      <div style={card}>
        {!isMobile && (
          <div style={{ ...rosterRow, ...rowHeader }}>
            <div></div><div>Worker</div><div>Status</div><div>Clock in</div><div>Clock out</div><div>Hours</div><div>Flag</div>
          </div>
        )}
        {loading && <div style={{ padding: "14px 16px", fontSize: 12, color: "#9A9893" }}>Loading roster...</div>}
        {!loading && roster.length === 0 && (
          <div style={{ padding: "14px 16px", fontSize: 12, color: "#9A9893" }}>No punches on this day.</div>
        )}
        {roster.map((w) => {
          const flagBadge = w.flag === "geofence" ? (
            <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: "#FCEBEB", color: "#791F1F", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Icon name="pinOff" size={11} />{w.flagLoc?.flag_reason || "Off jobsite"}
            </span>
          ) : w.flag === "gps_in" ? (
            <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: "#FCEBEB", color: "#791F1F", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Icon name="pinOff" size={11} />Off-site GPS
            </span>
          ) : w.missingClockOut ? (
            <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: "#FAEEDA", color: "#633806", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Icon name="alert" size={11} />No clock-out
            </span>
          ) : null;

          if (isMobile) {
            return (
              <div key={w.id} style={{ padding: "12px 14px", borderBottom: "0.5px solid #F0EEE8" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={{ width: 32, height: 32, borderRadius: "50%", background: w.bg, color: w.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{w.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>{w.name}</p>
                    <p style={{ fontSize: 11, color: "#9A9893", margin: 0 }}>{w.company || "—"}</p>
                  </div>
                  <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: w.status === "in" ? "#EAF3DE" : "#F1EFE8", color: w.status === "in" ? "#27500A" : "#6B6A66", whiteSpace: "nowrap" }}>
                    {w.status === "in" ? "On site" : "Clocked out"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#6B6A66", flexWrap: "wrap" }}>
                  <span>In: <strong style={{ color: "#1A1A1A" }}>{w.clockIn ? fmtTime(w.clockIn) : "—"}</strong></span>
                  <span>Out: <strong style={{ color: w.clockOut ? "#1A1A1A" : "#B5B3AD" }}>{w.clockOut ? fmtTime(w.clockOut) : "—"}</strong></span>
                  <span>Hours: <strong style={{ color: "#1A1A1A" }}>{w.missingClockOut ? "—" : `${fmtHrs(w.totalMs)} hrs`}</strong></span>
                  {w.shiftCount > 1 && <span style={{ color: "#9A9893" }}>{w.shiftCount} shifts</span>}
                </div>
                {flagBadge && <div style={{ marginTop: 8 }}>{flagBadge}</div>}
              </div>
            );
          }

          return (
            <div key={w.id} style={rosterRow}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: w.bg, color: w.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>{w.initials}</div>
              <div>
                <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>{w.name}</p>
                <p style={{ fontSize: 11, color: "#9A9893", margin: 0 }}>{w.company || "—"}</p>
              </div>
              <div>
                <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: w.status === "in" ? "#EAF3DE" : "#F1EFE8", color: w.status === "in" ? "#27500A" : "#6B6A66" }}>
                  {w.status === "in" ? "On site" : "Clocked out"}
                </span>
              </div>
              <div style={{ fontSize: 13 }}>{w.clockIn ? fmtTime(w.clockIn) : "—"}</div>
              <div style={{ fontSize: 13, color: w.clockOut ? "#1A1A1A" : "#B5B3AD" }}>{w.clockOut ? fmtTime(w.clockOut) : "—"}</div>
              <div style={{ fontSize: 13 }}>
                {w.missingClockOut ? "—" : `${fmtHrs(w.totalMs)} hrs`}
                {w.shiftCount > 1 && <span style={{ color: "#9A9893", fontSize: 11 }}> ({w.shiftCount})</span>}
              </div>
              <div>
                {flagBadge || <span style={{ fontSize: 12, color: "#D8D6CF" }}>—</span>}
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
                {w.name} — {w.flagLoc?.flag_reason || "flagged location"}
              </p>
              <p style={{ fontSize: 11, color: "#9A9893", margin: 0 }}>
                Clock in at {w.clockIn ? fmtTime(w.clockIn) : "—"}
                {w.flagLoc?.lat ? ` · ${w.flagLoc.lat.toFixed(4)}, ${w.flagLoc.lng.toFixed(4)}` : ""}
              </p>
            </div>
          </div>
        ))}
      </div>

      <SectionHead>Hours summary</SectionHead>
      <div style={card}>
        <div style={{ ...hoursRow, ...rowHeader }}>
          <div>Worker</div><div>Hours</div><div>Of 8-hr day</div>
        </div>
        {roster.length === 0 && <div style={{ padding: "14px 16px", fontSize: 12, color: "#9A9893" }}>No data yet.</div>}
        {roster.map((w) => {
          const hrs = w.totalMs / 3600000;
          const pct = Math.min(100, Math.round((hrs / 8) * 100));
          return (
            <div key={w.id} style={hoursRow}>
              <div style={{ fontSize: 13 }}>{w.name}</div>
              <div style={{ fontSize: 13 }}>{w.missingClockOut ? "—" : `${hrs.toFixed(1)} hrs`}</div>
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
function QRSection({ sites, setSites }) {
  const isMobile = useIsMobile();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [foremanName, setForemanName] = useState("");
  const [foremanPhone, setForemanPhone] = useState("");
  const [foremen, setForemen] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.from("foremen").select("*").order("name", { ascending: true }).then(({ data, error }) => {
      if (!error && data) setForemen(data);
    });
  }, []);

  // When the foreman name matches a known foreman exactly, auto-fill
  // their saved phone number.
  function handleForemanNameChange(val) {
    setForemanName(val);
    const match = foremen.find((f) => f.name.toLowerCase() === val.trim().toLowerCase());
    if (match && match.phone) setForemanPhone(match.phone);
  }

  // Geocode an address to lat/lng using OpenStreetMap's free Nominatim API
  async function geocode(addr) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(addr)}`;
    const res = await fetch(url, { headers: { "Accept-Language": "en" } });
    const data = await res.json();
    if (!data || !data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
  }

  async function addSite() {
    if (!name.trim() || !address.trim()) {
      setError("Enter both a jobsite name and an address.");
      return;
    }
    setBusy(true);
    setError("");

    const geo = await geocode(address.trim());
    if (!geo) {
      setBusy(false);
      setError("Couldn't find that address. Try being more specific (street, city, state).");
      return;
    }

    const id = "site_" + Date.now();
    const newSite = {
      id, name: name.trim(), code: `Site #${sites.length + 1}`,
      lat: geo.lat, lng: geo.lng,
      address: geo.display,
      foreman: foremanName.trim() || null,
      foreman_phone: foremanPhone.trim() || null,
      created_at: new Date().toISOString(),
    };
    const { error: insErr } = await supabase.from("sites").insert(newSite);
    setBusy(false);
    if (!insErr) {
      setSites([...sites, newSite]);

      // Save/update the foreman lookup so name+phone are remembered
      // for next time, without blocking on the result.
      if (foremanName.trim()) {
        supabase.from("foremen")
          .upsert({ name: foremanName.trim(), phone: foremanPhone.trim() || null }, { onConflict: "name" })
          .then(({ error: fErr }) => {
            if (!fErr) {
              setForemen((prev) => {
                const existing = prev.find((f) => f.name.toLowerCase() === foremanName.trim().toLowerCase());
                if (existing) return prev.map((f) => f === existing ? { ...f, phone: foremanPhone.trim() || null } : f);
                return [...prev, { name: foremanName.trim(), phone: foremanPhone.trim() || null }];
              });
            }
          });
      }

      setName("");
      setAddress("");
      setForemanName("");
      setForemanPhone("");
    } else {
      setError("Couldn't save the jobsite. Try again.");
    }
  }

  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  async function deleteSite(id) {
    setDeletingId(id);
    const { error: delErr } = await supabase.from("sites").delete().eq("id", id);
    setDeletingId(null);
    setConfirmDeleteId(null);
    if (!delErr) {
      setSites(sites.filter((s) => s.id !== id));
    }
  }

  // Refs to each site's QR canvas, so we can grab the image for printing
  const qrRefs = useRef({});

  function printQR(site, url) {
    const canvas = qrRefs.current[site.id];
    if (!canvas) {
      alert("QR code isn't ready yet — wait a moment and try again.");
      return;
    }
    const dataUrl = canvas.toDataURL("image/png");

    // Print via a hidden iframe instead of window.open, which avoids
    // popup blockers entirely since no new window/tab is created.
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
      <html>
        <head>
          <title>${site.code} — ${site.name}</title>
          <style>
            body { font-family: -apple-system, Helvetica, Arial, sans-serif; text-align: center; padding: 40px; }
            img { width: 320px; height: 320px; margin-bottom: 20px; }
            h1 { font-size: 22px; margin: 0 0 4px; }
            p { font-size: 13px; color: #555; margin: 4px 0; }
            .url { font-size: 11px; color: #999; word-break: break-all; margin-top: 10px; }
          </style>
        </head>
        <body>
          <img src="${dataUrl}" />
          <h1>${site.code} — ${site.name}</h1>
          ${site.address ? `<p>${site.address}</p>` : ""}
          ${site.foreman ? `<p>Foreman: ${site.foreman}${site.foreman_phone ? " · " + site.foreman_phone : ""}</p>` : ""}
          <p>Scan to clock in / out</p>
          <p class="url">${url}</p>
        </body>
      </html>
    `);
    doc.close();

    // Give the image a moment to render before printing
    setTimeout(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      // Clean up the iframe after printing
      setTimeout(() => document.body.removeChild(iframe), 1000);
    }, 300);
  }

  return (
    <div>
      <SectionHead>Generate a new jobsite code</SectionHead>
      <div style={{ ...card, padding: "14px 16px", marginBottom: 20 }}>
        <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 8, marginBottom: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jobsite name (e.g. Maple St Renovation)"
            style={{ ...inputStyle, marginBottom: 0, flex: 1 }} onKeyDown={(e) => e.key === "Enter" && addSite()} />
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street address, city, state"
            style={{ ...inputStyle, marginBottom: 0, flex: 1 }} onKeyDown={(e) => e.key === "Enter" && addSite()} />
        </div>
        <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 8, marginBottom: error ? 8 : 0 }}>
          <input
            value={foremanName}
            onChange={(e) => handleForemanNameChange(e.target.value)}
            placeholder="Foreman name"
            list="foremen-list"
            style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
            onKeyDown={(e) => e.key === "Enter" && addSite()}
          />
          <datalist id="foremen-list">
            {foremen.map((f) => <option key={f.name} value={f.name} />)}
          </datalist>
          <input
            value={foremanPhone}
            onChange={(e) => setForemanPhone(e.target.value)}
            placeholder="Foreman phone number"
            type="tel"
            style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
            onKeyDown={(e) => e.key === "Enter" && addSite()}
          />
          <button onClick={addSite} disabled={busy} style={{ ...submitBtn, marginTop: 0, width: isMobile ? "100%" : 140 }}>{busy ? "Locating..." : "Create code"}</button>
        </div>
        <p style={{ fontSize: 11, color: "#9A9893", margin: "8px 0 0" }}>
          Foreman name + phone are remembered — start typing a name you've used before to auto-fill their number.
        </p>
        {error && <p style={{ fontSize: 11, color: "#A32D2D", margin: "8px 0 0" }}>{error}</p>}
      </div>

      <SectionHead>Active jobsite codes</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 16 }}>
        {sites.map((s) => {
          const url = `${window.location.origin}/punch/${s.id}`;
          const confirming = confirmDeleteId === s.id;
          return (
            <div key={s.id} style={{ ...card, padding: 16, textAlign: "center", position: "relative" }}>
              <button
                onClick={() => setConfirmDeleteId(confirming ? null : s.id)}
                title="Delete jobsite"
                style={{
                  position: "absolute", top: 10, right: 10, width: 26, height: 26, borderRadius: 8,
                  border: "1px solid #E5E3DD", background: "#fff", color: "#9A9893",
                  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0,
                }}
              >
                <Icon name="x" size={13} />
              </button>
              <QRCode ref={(el) => { qrRefs.current[s.id] = el; }} value={url} size={160} />
              <p style={{ fontSize: 13, fontWeight: 600, margin: "10px 0 2px" }}>{s.code} — {s.name}</p>
              {s.address && <p style={{ fontSize: 11, color: "#6B6A66", margin: "0 0 6px" }}>{s.address}</p>}
              {s.foreman && (
                <p style={{ fontSize: 11, color: "#6B6A66", margin: "0 0 6px" }}>
                  Foreman: {s.foreman}{s.foreman_phone ? ` · ${s.foreman_phone}` : ""}
                </p>
              )}
              <p style={{ fontSize: 11, color: "#9A9893", margin: "0 0 8px", wordBreak: "break-all" }}>{url}</p>
              <p style={{ fontSize: 11, color: "#9A9893", margin: "0 0 12px" }}>Print, laminate, and post at site entrance. Each scan checks the worker in automatically.</p>
              <button
                onClick={() => printQR(s, url)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500,
                  padding: "7px 14px", borderRadius: 8, border: "1px solid #E5E3DD", background: "#fff",
                  color: "#1A1A1A", cursor: "pointer",
                }}
              >
                <Icon name="printer" size={13} />Print QR code
              </button>

              {confirming && (
                <div style={{ marginTop: 12, padding: "10px 12px", background: "#FCEBEB", borderRadius: 8, textAlign: "left" }}>
                  <p style={{ fontSize: 12, color: "#791F1F", margin: "0 0 8px" }}>
                    Delete this jobsite and its QR code? Punch history for this site will remain in the database.
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => deleteSite(s.id)} disabled={deletingId === s.id}
                      style={{ flex: 1, padding: "7px", borderRadius: 8, border: "none", background: "#A32D2D", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                      {deletingId === s.id ? "Deleting..." : "Delete"}
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)}
                      style={{ flex: 1, padding: "7px", borderRadius: 8, border: "1px solid #E5E3DD", background: "#fff", color: "#1A1A1A", fontSize: 12, cursor: "pointer" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- WORKERS SECTION ----------
function WorkersSection() {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revealedId, setRevealedId] = useState(null);
  const [search, setSearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  useEffect(() => {
    supabase.from("workers").select("*").order("name", { ascending: true }).then(({ data, error }) => {
      if (!error && data) setWorkers(data);
      setLoading(false);
    });
  }, []);

  const filtered = workers.filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase()) ||
    (w.company || "").toLowerCase().includes(search.toLowerCase())
  );

  async function deleteWorker(id) {
    setDeletingId(id);
    const { error } = await supabase.from("workers").delete().eq("id", id);
    setDeletingId(null);
    setConfirmDeleteId(null);
    if (!error) {
      setWorkers(workers.filter((w) => w.id !== id));
    }
  }

  return (
    <div>
      <SectionHead>All workers</SectionHead>
      <div style={{ ...card, padding: "14px 16px", marginBottom: 16 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or company"
          style={{ ...inputStyle, marginBottom: 0 }} />
      </div>

      <div style={card}>
        <div style={{ ...workerRow, ...rowHeader }}>
          <div></div><div>Name</div><div>Company</div><div>PIN</div><div></div>
        </div>
        {loading && <div style={{ padding: "14px 16px", fontSize: 12, color: "#9A9893" }}>Loading...</div>}
        {!loading && filtered.length === 0 && (
          <div style={{ padding: "14px 16px", fontSize: 12, color: "#9A9893" }}>No workers found.</div>
        )}
        {filtered.map((w) => {
          const confirming = confirmDeleteId === w.id;
          return (
            <div key={w.id}>
              <div style={workerRow}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: w.bg, color: w.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>{w.initials}</div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{w.name}</div>
                <div style={{ fontSize: 13, color: "#6B6A66" }}>{w.company || "—"}</div>
                <div>
                  <button
                    onClick={() => setRevealedId(revealedId === w.id ? null : w.id)}
                    style={{
                      fontSize: 13, fontFamily: "monospace", border: "none", background: "transparent",
                      color: revealedId === w.id ? "#1A1A1A" : "#9A9893", cursor: "pointer", padding: "2px 6px",
                      borderRadius: 6, display: "flex", alignItems: "center", gap: 6,
                    }}
                  >
                    {revealedId === w.id ? w.pin : "••••"}
                    <Icon name="lock" size={12} />
                  </button>
                </div>
                <div style={{ textAlign: "right" }}>
                  <button
                    onClick={() => setConfirmDeleteId(confirming ? null : w.id)}
                    title="Remove worker"
                    style={{
                      width: 26, height: 26, borderRadius: 8, border: "1px solid #E5E3DD", background: "#fff",
                      color: "#9A9893", display: "inline-flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", padding: 0,
                    }}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              </div>
              {confirming && (
                <div style={{ padding: "10px 14px", background: "#FCEBEB", borderBottom: "0.5px solid #F0EEE8" }}>
                  <p style={{ fontSize: 12, color: "#791F1F", margin: "0 0 8px" }}>
                    Remove {w.name} from the system? Their existing punch history will remain in the database, but they won't be able to sign in again unless they create a new account.
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => deleteWorker(w.id)} disabled={deletingId === w.id}
                      style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#A32D2D", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                      {deletingId === w.id ? "Removing..." : "Remove worker"}
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)}
                      style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E5E3DD", background: "#fff", color: "#1A1A1A", fontSize: 12, cursor: "pointer" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 11, color: "#9A9893", marginTop: 10 }}>Click a PIN to reveal it. Workers use their name + PIN to sign in on the jobsite QR scan.</p>
    </div>
  );
}


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
const hoursRow = { display: "grid", gridTemplateColumns: "1.6fr 90px 90px", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: "0.5px solid #F0EEE8" };
const rowHeader = { background: "#FAFAF8", fontSize: 11, color: "#9A9893", fontWeight: 600, borderBottom: "0.5px solid #E5E3DD" };
const workerRow = { display: "grid", gridTemplateColumns: "32px 1.6fr 1fr 100px 50px", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "0.5px solid #F0EEE8" };
