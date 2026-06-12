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
function WorkerApp({ onBack, siteId, sites }) {
  const site = sites.find((s) => s.id === siteId) || sites[0] || FALLBACK_SITE;
  const [stage, setStage] = useState("loading"); // loading | scan | signup | sign_in | checked_in | clockedin | sign_out | done
  const [worker, setWorker] = useState(null);
  const [pinInput, setPinInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [error, setError] = useState("");
  const [signupForm, setSignupForm] = useState({ name: "", company: "", phone: "", pin: "" });
  const [gps, setGps] = useState(null);
  const [gpsStatus, setGpsStatus] = useState("locating"); // locating | locked | denied
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
      setStage("scan");
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
    const t = setInterval(() => setNow(Date.now()), 1000);
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
      .ilike("name", nameInput.trim())
      .limit(1);
    setBusy(false);
    if (qErr || !data || !data.length) {
      setError("Name + PIN not recognized. Try Marcus Johnson / 1234 for demo, or create an account.");
      return;
    }
    const found = data[0];
    setWorker(found);
    checkOpenPunch(found);
  }

  // GPS coordinates to attach to a punch, with geofence flag check
  function currentGpsPayload() {
    if (!gps) return { lat: null, lng: null, gps_accuracy: null, flagged: false, flag_reason: null };
    const d = distFeet(site.lat, site.lng, gps.lat, gps.lng);
    const flagged = d > GEOFENCE_RADIUS_FT;
    return {
      lat: gps.lat, lng: gps.lng, gps_accuracy: gps.accuracy,
      flagged, flag_reason: flagged ? `Clocked in ${Math.round(d)} ft from jobsite` : null,
    };
  }

  async function doClockIn(w) {
    setBusy(true);
    const payload = currentGpsPayload();
    const { data, error: insErr } = await supabase
      .from("punch_events")
      .insert({ worker_id: w.id, site_id: site.id, type: "clock_in", ...payload })
      .select()
      .single();
    setBusy(false);
    if (insErr) { setError("Couldn't save your clock-in. Try again."); return; }
    setClockInTime(new Date(data.timestamp).getTime());
    setOpenPunchId(data.id);
    setStage("sign_in");
  }

  async function doClockOut() {
    setBusy(true);
    const payload = currentGpsPayload();
    await supabase.from("punch_events").insert({
      worker_id: worker.id, site_id: site.id, type: "clock_out", ...payload,
    });
    setBusy(false);
    setStage("done");
  }

  async function submitSignup() {
    if (!signupForm.name || !signupForm.pin) { setError("Name and PIN are required."); return; }
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
        <div style={{ display: "flex", gap: 8, marginBottom: 16, marginTop: 16 }}>
          <TabBtn active={tab === "dashboard"} onClick={() => setTab("dashboard")}>Live dashboard</TabBtn>
          <TabBtn active={tab === "qr"} onClick={() => setTab("qr")}>Jobsite QR codes</TabBtn>
        </div>
        {tab === "dashboard" ? <Dashboard sites={sites} /> : <QRSection sites={sites} setSites={setSites} />}
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
function Dashboard({ sites }) {
  const site = sites[0] || FALLBACK_SITE;
  const [roster, setRoster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(Date.now());

  // Build roster: for each worker, pair today's clock_in/clock_out events
  // into shifts. A worker can have multiple shifts in a day if they left
  // and came back; we show the most recent shift as their current status.
  async function loadRoster() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data: events, error } = await supabase
      .from("punch_events")
      .select("*, workers(*)")
      .eq("site_id", site.id)
      .gte("timestamp", startOfDay.toISOString())
      .order("timestamp", { ascending: true });

    if (error || !events) { setLoading(false); return; }

    // group by worker
    const byWorker = {};
    for (const ev of events) {
      if (!ev.workers) continue;
      const wid = ev.worker_id;
      if (!byWorker[wid]) byWorker[wid] = { worker: ev.workers, events: [] };
      byWorker[wid].events.push(ev);
    }

    const rows = Object.values(byWorker).map(({ worker, events }) => {
      // pair clock_in/clock_out sequentially to compute total ms worked today
      let totalMs = 0;
      let openClockIn = null;
      let lastClockIn = null;
      let lastClockOut = null;
      let activeFlag = null;
      let activeFlagLoc = null;

      for (const ev of events) {
        const t = new Date(ev.timestamp).getTime();
        if (ev.type === "clock_in") {
          openClockIn = ev;
          lastClockIn = ev;
          if (ev.flagged) { activeFlag = "gps_in"; activeFlagLoc = ev; }
        } else if (ev.type === "clock_out" && openClockIn) {
          totalMs += t - new Date(openClockIn.timestamp).getTime();
          openClockIn = null;
          lastClockOut = ev;
        }
      }

      const stillOpen = !!openClockIn;
      if (stillOpen) {
        totalMs += tick - new Date(openClockIn.timestamp).getTime();
        // check the latest punch event for a live geofence flag
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
        clockIn: lastClockIn ? new Date(lastClockIn.timestamp) : null,
        clockOut: lastClockOut ? new Date(lastClockOut.timestamp) : null,
        totalMs,
        flag: activeFlag,
        flagLoc: activeFlagLoc,
      };
    });

    // sort: on site first, then by clock-in time
    rows.sort((a, b) => {
      if (a.status !== b.status) return a.status === "in" ? -1 : 1;
      return (a.clockIn?.getTime() || 0) - (b.clockIn?.getTime() || 0);
    });

    setRoster(rows);
    setLoading(false);
  }

  useEffect(() => {
    loadRoster();
    const t = setInterval(() => setTick(Date.now()), 5000);
    return () => clearInterval(t);
  }, [site.id]);

  useEffect(() => {
    loadRoster();
  }, [tick]);

  // realtime: refresh roster whenever a punch event changes for this site
  useEffect(() => {
    const channel = supabase
      .channel("punch_events_" + site.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "punch_events", filter: `site_id=eq.${site.id}` }, () => {
        loadRoster();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [site.id]);

  const onSite = roster.filter((w) => w.status === "in").length;
  const totalHoursToday = roster.reduce((sum, w) => sum + w.totalMs, 0);
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
        {loading && <div style={{ padding: "14px 16px", fontSize: 12, color: "#9A9893" }}>Loading roster...</div>}
        {!loading && roster.length === 0 && (
          <div style={{ padding: "14px 16px", fontSize: 12, color: "#9A9893" }}>No punches yet today.</div>
        )}
        {roster.map((w) => (
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
            <div style={{ fontSize: 13 }}>{fmtHrs(w.totalMs)} hrs</div>
            <div>
              {w.flag === "geofence" && (
                <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: "#FCEBEB", color: "#791F1F", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Icon name="pinOff" size={11} />{w.flagLoc?.flag_reason || "Off jobsite"}
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
        ))}
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

      <SectionHead>Hours summary (today)</SectionHead>
      <div style={card}>
        <div style={{ ...hoursRow, ...rowHeader }}>
          <div>Worker</div><div>Today</div><div>This week</div><div>Progress</div>
        </div>
        {roster.length === 0 && <div style={{ padding: "14px 16px", fontSize: 12, color: "#9A9893" }}>No data yet.</div>}
        {roster.map((w) => {
          const today = w.totalMs / 3600000;
          const pct = Math.min(100, Math.round((today / 8) * 100));
          return (
            <div key={w.id} style={hoursRow}>
              <div style={{ fontSize: 13 }}>{w.name}</div>
              <div style={{ fontSize: 13 }}>{today.toFixed(1)} hrs</div>
              <div style={{ fontSize: 13, color: "#9A9893" }}>—</div>
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
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      foreman: null,
    };
    const { error: insErr } = await supabase.from("sites").insert(newSite);
    setBusy(false);
    if (!insErr) {
      setSites([...sites, newSite]);
      setName("");
      setAddress("");
    } else {
      setError("Couldn't save the jobsite. Try again.");
    }
  }

  return (
    <div>
      <SectionHead>Generate a new jobsite code</SectionHead>
      <div style={{ ...card, padding: "14px 16px", marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: error ? 8 : 0 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jobsite name (e.g. Maple St Renovation)"
            style={{ ...inputStyle, marginBottom: 0, flex: 1 }} onKeyDown={(e) => e.key === "Enter" && addSite()} />
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street address, city, state"
            style={{ ...inputStyle, marginBottom: 0, flex: 1 }} onKeyDown={(e) => e.key === "Enter" && addSite()} />
          <button onClick={addSite} disabled={busy} style={{ ...submitBtn, marginTop: 0, width: 140 }}>{busy ? "Locating..." : "Create code"}</button>
        </div>
        {error && <p style={{ fontSize: 11, color: "#A32D2D", margin: "8px 0 0" }}>{error}</p>}
      </div>

      <SectionHead>Active jobsite codes</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 16 }}>
        {sites.map((s) => {
          const url = `${window.location.origin}/punch/${s.id}`;
          return (
            <div key={s.id} style={{ ...card, padding: 16, textAlign: "center" }}>
              <QRCode value={url} size={160} />
              <p style={{ fontSize: 13, fontWeight: 600, margin: "10px 0 2px" }}>{s.code} — {s.name}</p>
              {s.address && <p style={{ fontSize: 11, color: "#6B6A66", margin: "0 0 6px" }}>{s.address}</p>}
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
