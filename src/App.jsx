import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import {
  Star, Moon, Sun, Home, Plus, User, X, Check, Loader2, Pencil, Trash2,
  Lock, Unlock, ThumbsUp, ThumbsDown, Upload, Download, Settings as SettingsIcon, ChevronLeft,
} from "lucide-react";

// ---- shared with pricelist/nota: same Firebase project, same admin password ----
const AUTH_DOC_REF = doc(db, "pricelist", "main");
const DATA_DOC_REF = doc(db, "testi", "data");
const THEME_KEY = "testi-theme";

const RECENT_DAYS = 7;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// timestamp in ms, or 0 when the date is missing/invalid
const reviewTime = (r) => { const t = new Date(r.date).getTime(); return isNaN(t) ? 0 : t; };

const uid = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_SETTINGS = { emojiEnabled: true };
const DEFAULT_DATA = { settings: DEFAULT_SETTINGS, reviews: [] };

// ---- local device identity (no login needed for visitors) ----
const MY_REVIEWS_KEY = "testi-my-reviews"; // array of review ids this device submitted
const MY_REACTIONS_KEY = "testi-my-reactions"; // { [reviewId]: "agree" | "disagree" }

function getMyReviewIds() {
  try { return JSON.parse(localStorage.getItem(MY_REVIEWS_KEY) || "[]"); } catch (e) { return []; }
}
function addMyReviewId(id) {
  const list = getMyReviewIds();
  if (!list.includes(id)) {
    list.push(id);
    localStorage.setItem(MY_REVIEWS_KEY, JSON.stringify(list));
  }
}
function removeMyReviewId(id) {
  const list = getMyReviewIds().filter((x) => x !== id);
  localStorage.setItem(MY_REVIEWS_KEY, JSON.stringify(list));
}
function getMyReactions() {
  try { return JSON.parse(localStorage.getItem(MY_REACTIONS_KEY) || "{}"); } catch (e) { return {}; }
}
function setMyReaction(reviewId, reaction) {
  const map = getMyReactions();
  if (reaction) map[reviewId] = reaction;
  else delete map[reviewId];
  localStorage.setItem(MY_REACTIONS_KEY, JSON.stringify(map));
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const THEMES = {
  light: {
    bg: "#F4F6FB", bgElevated: "#FFFFFF", card: "#EAEEF6", cardBorder: "#C5CDDE",
    ink: "#352D3C", inkMuted: "#5E5875", inkFaint: "#948FA8", accent: "#5258A6",
    accentSoft: "#E5E7F4", star: "#D98FAF", onAccent: "#FFFFFF",
    positive: "#2F9E67", negative: "#C0473A", dangerSoft: "#FBEAE7",
    navBg: "#FFFFFF", navBorder: "#C5CDDE", overlay: "rgba(53,45,60,0.4)", isDark: false,
  },
  dark: {
    bg: "#211C28", bgElevated: "#2C2635", card: "#2C2635", cardBorder: "#433B52",
    ink: "#F2EFF6", inkMuted: "#C5CDDE", inkFaint: "#8B87A1", accent: "#DFA3BC",
    accentSoft: "#3A3762", star: "#DFA3BC", onAccent: "#211C28",
    positive: "#5FC98A", negative: "#E1786A", dangerSoft: "#382229",
    navBg: "#27212F", navBorder: "#433B52", overlay: "rgba(0,0,0,0.6)", isDark: true,
  },
};

const FONT_LINK = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Work+Sans:wght@400;500;600&display=swap');
html, body, #root { margin: 0; padding: 0; width: 100%; }
* { box-sizing: border-box; }
body { overflow-x: hidden; }
button { transition: transform 0.12s ease, opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
button:active { transform: scale(0.96); }
input, select, textarea { transition: border-color 0.15s ease; }
@keyframes testi-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes testi-slide-up { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes testi-scale-in { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
.testi-overlay { animation: testi-fade-in 0.18s ease; }
.testi-sheet { animation: testi-slide-up 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
.testi-card { animation: testi-scale-in 0.2s ease; }
@keyframes testi-spin { to { transform: rotate(360deg); } }
.animate-spin { animation: testi-spin 1s linear infinite; }
.testi-clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
`;

export default function App() {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) === "dark"; } catch (e) { return false; }
  });
  const [authPassword, setAuthPassword] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [loginError, setLoginError] = useState("");

  const [data, setData] = useState(null);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [page, setPage] = useState("wall"); // wall | profile
  const [showWriteReview, setShowWriteReview] = useState(null); // null | {} (new) | review object (editing)
  const [toast, setToast] = useState("");
  const [detailId, setDetailId] = useState(null); // review id shown in the detail overlay
  const editingRef = useRef(false);

  const T = dark ? THEMES.dark : THEMES.light;

  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch (e) {}
    document.body.style.background = T.bg;
    document.documentElement.style.background = T.bg;
  }, [dark, T.bg]);

  const flashToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 2200); };

  useEffect(() => {
    const unsub = onSnapshot(AUTH_DOC_REF, (snap) => {
      setAuthPassword(snap.exists() ? snap.data().password || "admin123" : "admin123");
      setAuthLoaded(true);
    }, () => { setAuthPassword("admin123"); setAuthLoaded(true); });
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(DATA_DOC_REF, (snap) => {
      if (!snap.exists()) {
        setDoc(DATA_DOC_REF, DEFAULT_DATA).catch(() => setConnectionError(true));
        setData(DEFAULT_DATA);
      } else if (!editingRef.current) {
        const d = snap.data();
        setData({ settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) }, reviews: d.reviews || [] });
      }
      setDataLoaded(true);
    }, (err) => {
      console.error(err);
      setConnectionError(true);
      setData(DEFAULT_DATA);
      setDataLoaded(true);
    });
    return () => unsub();
  }, []);

  const persist = useCallback(async (next) => {
    setData(next);
    try {
      await setDoc(DATA_DOC_REF, next);
      setConnectionError(false);
    } catch (e) {
      setConnectionError(true);
      flashToast("Couldn't save — check your connection");
    }
  }, []);

  const handleLogin = () => {
    if (pwInput === authPassword) { setIsAdmin(true); setShowLogin(false); setPwInput(""); setLoginError(""); }
    else setLoginError("Incorrect password.");
  };

  if (!authLoaded || !dataLoaded || !data) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg }}>
        <style>{FONT_LINK}</style>
        <Loader2 className="animate-spin" color={T.accent} size={26} />
      </div>
    );
  }

  const reviews = data.reviews || [];
  const myReviewIds = getMyReviewIds();
  const detailReview = detailId ? reviews.find((r) => r.id === detailId) : null;

  const saveReview = (review) => {
    const exists = reviews.some((r) => r.id === review.id);
    const nextReviews = exists ? reviews.map((r) => (r.id === review.id ? review : r)) : [review, ...reviews];
    persist({ ...data, reviews: nextReviews });
    if (!exists) addMyReviewId(review.id);
    setShowWriteReview(null);
    flashToast(exists ? "Review updated" : "Review posted");
  };

  const deleteReview = (id) => {
    persist({ ...data, reviews: reviews.filter((r) => r.id !== id) });
    removeMyReviewId(id);
    if (detailId === id) setDetailId(null);
    flashToast("Review deleted");
  };

  const toggleReaction = (review, reaction) => {
    const myReactions = getMyReactions();
    const current = myReactions[review.id];
    const counts = { agree: review.reactions?.agree || 0, disagree: review.reactions?.disagree || 0 };
    if (current === reaction) {
      counts[reaction] = Math.max(0, counts[reaction] - 1);
      setMyReaction(review.id, null);
    } else {
      if (current) counts[current] = Math.max(0, counts[current] - 1);
      counts[reaction] = (counts[reaction] || 0) + 1;
      setMyReaction(review.id, reaction);
    }
    persist({ ...data, reviews: reviews.map((r) => (r.id === review.id ? { ...r, reactions: counts } : r)) });
  };

  const toggleEmoji = () => persist({ ...data, settings: { ...data.settings, emojiEnabled: !data.settings.emojiEnabled } });

  return (
    <div style={{ minHeight: "100vh", width: "100%", background: T.bg, fontFamily: "'Work Sans', sans-serif", color: T.ink }}>
      <style>{FONT_LINK}</style>

      {connectionError && (
        <div style={{ background: T.dangerSoft, color: T.negative, fontSize: 12.5, padding: "8px 20px", textAlign: "center" }}>
          Couldn't connect to Firebase. Check your .env / Cloudflare environment variables and Firestore rules.
        </div>
      )}

      <div style={{ maxWidth: 560, margin: "0 auto", paddingBottom: 90 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 20px 14px", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {page !== "wall" && (
              <button onClick={() => setPage("wall")} aria-label="Back" title="Back" style={roundBtnStyle(T)}>
                <ChevronLeft size={20} />
              </button>
            )}
            <button onClick={() => setPage("wall")} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, minWidth: 0 }}>
              <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 21, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 8, color: T.ink }}>
                <Star size={18} color={T.star} fill={T.star} /> Testimonials
              </h1>
            </button>
          </div>
          <button onClick={() => setDark(!dark)} aria-label="Toggle theme" style={roundBtnStyle(T)}>
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>

        {page === "wall" && (
          <Wall
            T={T}
            reviews={reviews}
            settings={data.settings}
            isAdmin={isAdmin}
            myReviewIds={myReviewIds}
            myReactions={getMyReactions()}
            onEdit={(r) => setShowWriteReview(r)}
            onDelete={deleteReview}
            onReact={toggleReaction}
            onOpen={setDetailId}
          />
        )}

        {page === "profile" && (
          <Profile
            T={T}
            reviews={reviews}
            settings={data.settings}
            isAdmin={isAdmin}
            myReviewIds={myReviewIds}
            onEdit={(r) => setShowWriteReview(r)}
            onDelete={deleteReview}
            onLoginClick={() => setShowLogin(true)}
            onOpen={setDetailId}
            onLogout={() => setIsAdmin(false)}
            onToggleEmoji={toggleEmoji}
            data={data}
            persist={persist}
            flashToast={flashToast}
            authPassword={authPassword}
          />
        )}
      </div>

      {/* bottom nav */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: T.navBg, borderTop: `1px solid ${T.navBorder}`, display: "flex", justifyContent: "space-around", alignItems: "center", padding: "10px 20px calc(10px + env(safe-area-inset-bottom))", zIndex: 20 }}>
        <button
          onClick={() => { setPage("wall"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
          style={{ ...navBtnStyle(T, page === "wall"), background: "none", border: "none" }}
          title="Home"
        >
          <Home size={20} />
          <span style={navLabelStyle(T, page === "wall")}>Home</span>
        </button>
        <button onClick={() => setShowWriteReview({})} style={{ ...navBtnStyle(T, false), background: "none", border: "none" }} title="Write a review">
          <div style={{ width: 46, height: 46, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", color: T.onAccent, marginTop: -22, boxShadow: `0 4px 12px ${T.accent}55` }}>
            <Plus size={22} />
          </div>
        </button>
        <button onClick={() => setPage("profile")} style={{ ...navBtnStyle(T, page === "profile"), background: "none", border: "none" }} title="Profile">
          <User size={20} color={page === "profile" ? T.accent : T.inkMuted} />
          <span style={navLabelStyle(T, page === "profile")}>{isAdmin ? "Admin" : "Profile"}</span>
        </button>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 90, left: "50%", transform: "translateX(-50%)", background: T.accent, color: T.onAccent, padding: "10px 18px", borderRadius: 6, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6, zIndex: 30 }}>
          <Check size={14} /> {toast}
        </div>
      )}

      {showLogin && (
        <Modal T={T} onClose={() => { setShowLogin(false); setPwInput(""); setLoginError(""); }} title="Admin login">
          <p style={{ fontSize: 13.5, color: T.inkMuted, marginTop: -6, marginBottom: 14 }}>Enter the admin password to moderate reviews.</p>
          <input type="password" autoFocus value={pwInput} onChange={(e) => setPwInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLogin()} placeholder="Password" style={inputStyle(T)} />
          {loginError && <p style={{ color: T.negative, fontSize: 12.5, marginTop: 6 }}>{loginError}</p>}
          <button onClick={handleLogin} style={{ ...primaryBtnStyle(T), marginTop: 14, width: "100%" }}>Unlock</button>
        </Modal>
      )}

      {showWriteReview !== null && (
        <WriteReviewModal
          T={T}
          review={showWriteReview}
          onClose={() => setShowWriteReview(null)}
          onSave={saveReview}
          editingRef={editingRef}
        />
      )}

      {detailReview && (
        <ReviewDetail
          review={detailReview}
          T={T}
          settings={data.settings}
          canManage={isAdmin || myReviewIds.includes(detailReview.id)}
          myReaction={getMyReactions()[detailReview.id]}
          onClose={() => setDetailId(null)}
          onEdit={() => { setDetailId(null); setShowWriteReview(detailReview); }}
          onDelete={() => deleteReview(detailReview.id)}
          onReact={(reaction) => toggleReaction(detailReview, reaction)}
        />
      )}
    </div>
  );
}

// ---------------- WALL ----------------

function Wall({ T, reviews, settings, isAdmin, myReviewIds, myReactions, onEdit, onDelete, onReact, onOpen }) {
  const stats = useMemo(() => {
    const total = reviews.length;
    const sum = reviews.reduce((s, r) => s + (Number(r.rating) || 0), 0);
    const avg = total > 0 ? sum / total : 0;
    const counts = [0, 0, 0, 0, 0]; // index 0 = 1-star ... index 4 = 5-star
    reviews.forEach((r) => {
      const idx = Math.min(5, Math.max(1, Math.round(r.rating || 0))) - 1;
      counts[idx]++;
    });
    return { total, avg, counts };
  }, [reviews]);

  // ---- filters + sections ----
  const [view, setView] = useState("all"); // all | recent
  const [fYear, setFYear] = useState("");
  const [fMonth, setFMonth] = useState(""); // "0".."11"
  const [fDay, setFDay] = useState("");
  const hasDateFilter = !!(fYear || fMonth || fDay);

  const years = useMemo(() => {
    const set = new Set();
    reviews.forEach((r) => { const t = reviewTime(r); if (t) set.add(new Date(t).getFullYear()); });
    return [...set].sort((a, b) => b - a);
  }, [reviews]);

  const { list, sections } = useMemo(() => {
    const sorted = [...reviews].sort((a, b) => reviewTime(b) - reviewTime(a));
    const cutoff = Date.now() - RECENT_DAYS * 86400000;

    let list;
    if (view === "recent") {
      list = sorted.filter((r) => reviewTime(r) >= cutoff);
    } else if (hasDateFilter) {
      list = sorted.filter((r) => {
        const t = reviewTime(r);
        if (!t) return false;
        const d = new Date(t);
        return (!fYear || d.getFullYear() === Number(fYear))
          && (fMonth === "" || d.getMonth() === Number(fMonth))
          && (!fDay || d.getDate() === Number(fDay));
      });
    } else {
      list = sorted;
    }

    const groupByMonth = (items) => {
      const groups = [];
      items.forEach((r) => {
        const t = reviewTime(r);
        const d = new Date(t);
        const key = t ? `${d.getFullYear()}-${d.getMonth()}` : "undated";
        const title = t ? d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Undated";
        let g = groups.find((x) => x.key === key);
        if (!g) { g = { key, title, items: [] }; groups.push(g); }
        g.items.push(r);
      });
      return groups;
    };

    let sections;
    if (view === "recent") {
      sections = list.length ? [{ key: "recent", title: `Recent · last ${RECENT_DAYS} days`, items: list }] : [];
    } else if (hasDateFilter) {
      sections = groupByMonth(list);
    } else {
      const recent = list.filter((r) => reviewTime(r) >= cutoff);
      const older = list.filter((r) => reviewTime(r) < cutoff);
      sections = [
        ...(recent.length ? [{ key: "recent", title: "Recent", items: recent }] : []),
        ...groupByMonth(older),
      ];
    }
    return { list, sections };
  }, [reviews, view, hasDateFilter, fYear, fMonth, fDay]);

  const onDateChange = (setter) => (e) => { setter(e.target.value); setView("all"); };
  const showRecent = () => { setView("recent"); setFYear(""); setFMonth(""); setFDay(""); };
  const clearFilters = () => { setView("all"); setFYear(""); setFMonth(""); setFDay(""); };
  const selectStyle = { ...inputStyle(T), width: "auto", flex: 1, padding: "9px 10px", colorScheme: T.isDark ? "dark" : "light" };

  const renderCard = (r) => (
    <ReviewCard
      key={r.id}
      review={r}
      T={T}
      settings={settings}
      canManage={isAdmin || myReviewIds.includes(r.id)}
      myReaction={myReactions[r.id]}
      onEdit={() => onEdit(r)}
      onDelete={() => onDelete(r.id)}
      onReact={(reaction) => onReact(r, reaction)}
      onOpen={() => onOpen(r.id)}
    />
  );

  return (
    <div style={{ padding: "0 20px" }}>
      {/* grade report */}
      <div style={{ background: T.bgElevated, border: `1px solid ${T.cardBorder}`, borderRadius: 16, padding: 20, marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 20, alignItems: "center", marginBottom: 16 }}>
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <div style={{ fontFamily: "'Fraunces', serif", fontSize: 40, fontWeight: 700, color: T.accent, lineHeight: 1 }}>
              {stats.avg.toFixed(1)}
            </div>
            <div style={{ fontSize: 11, color: T.inkFaint, marginTop: 2 }}>out of 5</div>
            <StarRow value={stats.avg} T={T} size={14} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: T.inkMuted, marginBottom: 8 }}>
              <strong style={{ color: T.ink }}>{stats.total}</strong> review{stats.total !== 1 ? "s" : ""} total
            </div>
            {[5, 4, 3, 2, 1].map((star) => {
              const count = stats.counts[star - 1];
              const pct = stats.total > 0 ? (count / stats.total) * 100 : 0;
              return (
                <div key={star} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 10.5, color: T.inkFaint, width: 20, flexShrink: 0 }}>{star}★</span>
                  <div style={{ flex: 1, height: 6, borderRadius: 3, background: T.card, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: T.accent, borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: 10, color: T.inkFaint, width: 18, textAlign: "right", flexShrink: 0 }}>{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* filters */}
      {reviews.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button onClick={clearFilters} style={{ ...toggleChipStyle(T, view === "all" && !hasDateFilter), flex: 1 }}>All</button>
            <button onClick={showRecent} style={{ ...toggleChipStyle(T, view === "recent"), flex: 1 }}>Recent</button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <select aria-label="Year" value={fYear} onChange={onDateChange(setFYear)} style={selectStyle}>
              <option value="">Year</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select aria-label="Month" value={fMonth} onChange={onDateChange(setFMonth)} style={selectStyle}>
              <option value="">Month</option>
              {MONTH_NAMES.map((m, idx) => <option key={m} value={idx}>{m}</option>)}
            </select>
            <select aria-label="Day" value={fDay} onChange={onDateChange(setFDay)} style={selectStyle}>
              <option value="">Day</option>
              {Array.from({ length: 31 }, (_, n) => n + 1).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          {(hasDateFilter || view === "recent") && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, fontSize: 12, color: T.inkFaint }}>
              <span>Showing {list.length} of {reviews.length} review{reviews.length !== 1 ? "s" : ""}</span>
              {hasDateFilter && (
                <button onClick={clearFilters} style={{ background: "none", border: "none", padding: 0, color: T.accent, fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "'Work Sans', sans-serif" }}>
                  Clear filter
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* wall */}
      {reviews.length === 0 ? (
        <div style={{ textAlign: "center", color: T.inkFaint, fontSize: 13.5, padding: "30px 0" }}>No reviews yet — be the first to write one.</div>
      ) : list.length === 0 ? (
        <div style={{ textAlign: "center", color: T.inkFaint, fontSize: 13.5, padding: "30px 0" }}>
          {view === "recent" ? `No reviews in the last ${RECENT_DAYS} days.` : "No reviews match this filter."}
        </div>
      ) : (
        <div>
          {sections.map((sec) => (
            <div key={sec.key} style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12.5, fontWeight: 600, color: T.inkMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>
                <span>{sec.title}</span>
                <span style={{ color: T.inkFaint, fontWeight: 400, letterSpacing: 0 }}>{sec.items.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {sec.items.map(renderCard)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Review text clamped to 4 lines; shows "Read more" only when it's actually cut off.
function ReviewText({ text, T, expanded, size = 14, onClampChange, onOpen, mb = 10 }) {
  const ref = useRef(null);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    if (expanded) {
      setClamped(false);
      if (onClampChange) onClampChange(false);
      return;
    }
    let alive = true;
    const measure = () => {
      const el = ref.current;
      if (!alive || !el) return;
      const c = el.scrollHeight > el.clientHeight + 1;
      setClamped(c);
      if (onClampChange) onClampChange(c);
    };
    measure();
    window.addEventListener("resize", measure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    return () => { alive = false; window.removeEventListener("resize", measure); };
  }, [text, expanded]);

  return (
    <div style={{ margin: `0 0 ${mb}px` }}>
      <p
        ref={ref}
        className={expanded ? undefined : "testi-clamp"}
        style={{ fontSize: size, color: T.ink, lineHeight: 1.55, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {text}
      </p>
      {!expanded && clamped && (
        <button
          onClick={(e) => { e.stopPropagation(); if (onOpen) onOpen(); }}
          style={{ background: "none", border: "none", padding: 0, marginTop: 4, color: T.accent, fontWeight: 600, fontSize: size - 1, cursor: "pointer", fontFamily: "'Work Sans', sans-serif" }}
        >
          Read more
        </button>
      )}
    </div>
  );
}

function ReviewCard({ review, T, settings, canManage, myReaction, onEdit, onDelete, onReact, onOpen, expanded }) {
  const [clamped, setClamped] = useState(false);
  const clickable = !expanded && clamped;

  return (
    <div
      className={expanded ? undefined : "testi-card"}
      onClick={clickable ? onOpen : undefined}
      style={{ background: T.bgElevated, border: `1px solid ${T.cardBorder}`, borderRadius: 14, padding: 16, cursor: clickable ? "pointer" : "default" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {review.isAnonymous || !review.name ? "Anonymous" : review.name}
          </div>
          <div style={{ fontSize: 11, color: T.inkFaint, marginTop: 1 }}>{formatDate(review.date)}</div>
        </div>
        <StarRow value={review.rating} T={T} size={14} />
      </div>

      <ReviewText text={review.text} T={T} expanded={expanded} onClampChange={setClamped} onOpen={onOpen} />

      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "default" }}>
        {settings.emojiEnabled ? (
          <div style={{ display: "flex", gap: 6 }}>
            <ReactionBtn T={T} icon={<ThumbsUp size={13} />} count={review.reactions?.agree || 0} active={myReaction === "agree"} color={T.positive} onClick={() => onReact("agree")} />
            <ReactionBtn T={T} icon={<ThumbsDown size={13} />} count={review.reactions?.disagree || 0} active={myReaction === "disagree"} color={T.negative} onClick={() => onReact("disagree")} />
          </div>
        ) : <div />}

        {canManage && (
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={onEdit} style={iconBtnStyle(T)} title="Edit"><Pencil size={14} /></button>
            <button onClick={onDelete} style={{ ...iconBtnStyle(T), color: T.negative }} title="Delete"><Trash2 size={14} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

// Overlay showing one review in full.
function ReviewDetail({ review, T, settings, canManage, myReaction, onClose, onEdit, onDelete, onReact }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; };
  }, []);

  return (
    <div className="testi-overlay" onClick={onClose} style={{ position: "fixed", inset: 0, background: T.overlay, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
      <div className="testi-card" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 480, maxHeight: "86vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <button onClick={onClose} aria-label="Close" style={roundBtnStyle(T)}><X size={16} /></button>
        </div>
        <div style={{ overflowY: "auto" }}>
          <ReviewCard
            expanded
            review={review}
            T={T}
            settings={settings}
            canManage={canManage}
            myReaction={myReaction}
            onEdit={onEdit}
            onDelete={onDelete}
            onReact={onReact}
          />
        </div>
      </div>
    </div>
  );
}

function ReactionBtn({ T, icon, count, active, color, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 999, border: `1px solid ${active ? color : T.cardBorder}`,
        background: active ? `${color}1A` : "transparent", color: active ? color : T.inkMuted, cursor: "pointer", fontSize: 11.5, fontFamily: "'Work Sans', sans-serif",
      }}
    >
      {icon} {count}
    </button>
  );
}

function StarRow({ value, T, size = 16, interactive, onChange }) {
  const rounded = Math.round(value);
  return (
    <div style={{ display: "flex", gap: 2, justifyContent: "center" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!interactive}
          onClick={() => interactive && onChange(n)}
          style={{ background: "none", border: "none", padding: 0, cursor: interactive ? "pointer" : "default", display: "flex" }}
        >
          <Star size={interactive ? size + 8 : size} color={T.star} fill={n <= rounded ? T.star : "none"} />
        </button>
      ))}
    </div>
  );
}

// ---------------- WRITE REVIEW ----------------

function WriteReviewModal({ T, review, onClose, onSave, editingRef }) {
  const isEditing = !!review.id;
  const [name, setName] = useState(review.name || "");
  const [isAnonymous, setIsAnonymous] = useState(review.isAnonymous ?? false);
  const [rating, setRating] = useState(review.rating || 5);
  const [text, setText] = useState(review.text || "");

  const handleSave = () => {
    if (!text.trim()) return;
    onSave({
      id: review.id || uid(),
      name: isAnonymous ? "" : name.trim(),
      isAnonymous,
      rating,
      text: text.trim(),
      date: review.date || new Date().toISOString(),
      reactions: review.reactions || { agree: 0, disagree: 0 },
    });
  };

  return (
    <Modal T={T} title={isEditing ? "Edit your review" : "Write a review"} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }} onFocus={() => (editingRef.current = true)} onBlur={() => (editingRef.current = false)}>
        <div style={{ textAlign: "center" }}>
          <StarRow value={rating} T={T} size={22} interactive onChange={setRating} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setIsAnonymous(false)}
            style={{ ...toggleChipStyle(T, !isAnonymous), flex: 1 }}
          >
            Use a name
          </button>
          <button
            onClick={() => setIsAnonymous(true)}
            style={{ ...toggleChipStyle(T, isAnonymous), flex: 1 }}
          >
            Post anonymously
          </button>
        </div>

        {!isAnonymous && (
          <Field T={T} label="Your name (can be a fake name)">
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle(T)} placeholder="e.g. Budi, or any name you like" />
          </Field>
        )}

        <Field T={T} label="Your review">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} style={{ ...inputStyle(T), resize: "vertical" }} placeholder="Share your experience..." />
        </Field>

        <button onClick={handleSave} disabled={!text.trim()} style={{ ...primaryBtnStyle(T), opacity: text.trim() ? 1 : 0.5 }}>
          {isEditing ? "Save changes" : "Post review"}
        </button>
      </div>
    </Modal>
  );
}

// ---------------- PROFILE (visitor + admin) ----------------

function Profile({ T, reviews, settings, isAdmin, myReviewIds, onEdit, onDelete, onLoginClick, onLogout, onToggleEmoji, data, persist, flashToast, authPassword, onOpen }) {
  const myReviews = reviews.filter((r) => myReviewIds.includes(r.id));

  return (
    <div style={{ padding: "0 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={{ width: 48, height: 48, borderRadius: "50%", background: T.accentSoft, display: "flex", alignItems: "center", justifyContent: "center", color: T.accent }}>
          <User size={22} />
        </div>
        <div>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600 }}>{isAdmin ? "Admin" : "Your profile"}</div>
          <div style={{ fontSize: 12, color: T.inkFaint }}>{myReviews.length} review{myReviews.length !== 1 ? "s" : ""} from this device</div>
        </div>
      </div>

      {!isAdmin ? (
        <button onClick={onLoginClick} style={{ ...ghostBtnStyle(T), width: "100%", marginBottom: 20 }}>
          <Lock size={14} /> Log in as admin
        </button>
      ) : (
        <AdminPanel T={T} settings={settings} onToggleEmoji={onToggleEmoji} data={data} persist={persist} flashToast={flashToast} authPassword={authPassword} onLogout={onLogout} />
      )}

      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.inkMuted, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>Your reviews</div>
      {myReviews.length === 0 ? (
        <div style={{ textAlign: "center", color: T.inkFaint, fontSize: 13, padding: "20px 0" }}>You haven't posted any reviews from this device yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {myReviews.map((r) => (
            <MyReviewRow key={r.id} r={r} T={T} onEdit={() => onEdit(r)} onDelete={() => onDelete(r.id)} onOpen={() => onOpen(r.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MyReviewRow({ r, T, onEdit, onDelete, onOpen }) {
  const [clamped, setClamped] = useState(false);
  return (
    <div
      onClick={clamped ? onOpen : undefined}
      style={{ background: T.bgElevated, border: `1px solid ${T.cardBorder}`, borderRadius: 12, padding: 12, cursor: clamped ? "pointer" : "default" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <StarRow value={r.rating} T={T} size={12} />
        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 4 }}>
          <button onClick={onEdit} style={iconBtnStyle(T)}><Pencil size={13} /></button>
          <button onClick={onDelete} style={{ ...iconBtnStyle(T), color: T.negative }}><Trash2 size={13} /></button>
        </div>
      </div>
      <ReviewText text={r.text} T={T} size={13} mb={4} onClampChange={setClamped} onOpen={onOpen} />
      <div style={{ fontSize: 10.5, color: T.inkFaint, marginTop: 4 }}>{formatDate(r.date)}</div>
    </div>
  );
}

function AdminPanel({ T, settings, onToggleEmoji, data, persist, flashToast, authPassword, onLogout }) {
  const [newPw, setNewPw] = useState("");
  const fileInputRef = useRef(null);
  const [importBusy, setImportBusy] = useState(false);

  const exportExcel = async () => {
    const XLSX = await import("xlsx");
    const rows = data.reviews.map((r) => ({
      Date: formatDate(r.date), Name: r.isAnonymous ? "Anonymous" : (r.name || "Anonymous"),
      Rating: r.rating, Review: r.text, Agree: r.reactions?.agree || 0, Disagree: r.reactions?.disagree || 0,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Reviews");
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "testimonials.xlsx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flashToast("Exported");
  };

  const importExcel = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setImportBusy(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(evt.target.result, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        const newReviews = rows.map((r) => {
          const lower = {}; Object.keys(r).forEach((k) => (lower[k.toLowerCase()] = r[k]));
          const name = lower.name || "";
          return {
            id: uid(),
            name: name.toLowerCase() === "anonymous" ? "" : name,
            isAnonymous: !name || name.toLowerCase() === "anonymous",
            rating: parseInt(lower.rating, 10) || 5,
            text: lower.review || lower.text || "",
            date: lower.date ? new Date(lower.date).toISOString() : new Date().toISOString(),
            reactions: { agree: parseInt(lower.agree, 10) || 0, disagree: parseInt(lower.disagree, 10) || 0 },
          };
        }).filter((r) => r.text);
        persist({ ...data, reviews: [...newReviews, ...data.reviews] });
        flashToast(`Imported ${newReviews.length} reviews`);
      } catch (err) { flashToast("Couldn't read that file"); }
      finally { setImportBusy(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
    };
    reader.readAsArrayBuffer(file);
  };

  const changePassword = async () => {
    if (!newPw.trim()) return;
    try {
      await setDoc(AUTH_DOC_REF, { password: newPw.trim() }, { merge: true });
      flashToast("Password updated");
      setNewPw("");
    } catch (e) { flashToast("Couldn't update password"); }
  };

  return (
    <div style={{ background: T.bgElevated, border: `1px solid ${T.cardBorder}`, borderRadius: 14, padding: 16, marginBottom: 20 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.inkMuted, marginBottom: 12, display: "flex", alignItems: "center", gap: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
        <SettingsIcon size={13} /> Admin settings
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 13.5, color: T.ink }}>Emoji reactions</div>
          <div style={{ fontSize: 11, color: T.inkFaint }}>Let visitors agree/disagree with reviews</div>
        </div>
        <button onClick={onToggleEmoji} style={{ width: 46, height: 26, borderRadius: 999, border: "none", cursor: "pointer", background: settings.emojiEnabled ? T.accent : T.cardBorder, position: "relative", flexShrink: 0 }}>
          <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: settings.emojiEnabled ? 23 : 3, transition: "left 0.15s ease" }} />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
        <button onClick={exportExcel} style={ghostBtnStyle(T)}><Download size={14} /> Export reviews (Excel)</button>
        <button onClick={() => fileInputRef.current && fileInputRef.current.click()} style={ghostBtnStyle(T)}>
          {importBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import reviews (Excel)
        </button>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={importExcel} style={{ display: "none" }} />
      </div>

      <div style={{ borderTop: `1px solid ${T.cardBorder}`, paddingTop: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 11.5, color: T.inkFaint, marginBottom: 6 }}>Change admin password (shared with pricelist/nota)</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="text" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password" style={{ ...inputStyle(T), flex: 1 }} />
          <button onClick={changePassword} style={primaryBtnStyle(T)}>Save</button>
        </div>
      </div>

      <button onClick={onLogout} style={{ ...ghostBtnStyle(T), color: T.negative, borderColor: T.negative, width: "100%" }}>
        <Unlock size={14} /> Log out
      </button>
    </div>
  );
}

// ---------------- shared UI helpers ----------------

function Modal({ children, onClose, title, T }) {
  return (
    <div className="testi-overlay" style={{ position: "fixed", inset: 0, background: T.overlay, display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div className="testi-sheet" onClick={(e) => e.stopPropagation()} style={{ background: T.bg, borderRadius: "16px 16px 0 0", padding: 22, width: "100%", maxWidth: 480, maxHeight: "88vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, margin: 0, fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={iconBtnStyle(T)}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ T, label, children }) {
  return (
    <div>
      <label style={{ fontSize: 11.5, color: T.inkFaint, display: "block", marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

function navBtnStyle(T, active) {
  return { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, textDecoration: "none", color: active ? T.accent : T.inkMuted, cursor: "pointer" };
}
function navLabelStyle(T, active) {
  return { fontSize: 10.5, color: active ? T.accent : T.inkMuted, fontFamily: "'Work Sans', sans-serif" };
}
function toggleChipStyle(T, active) {
  return { padding: "9px 0", borderRadius: 8, border: `1px solid ${active ? T.accent : T.cardBorder}`, background: active ? T.accentSoft : "transparent", color: active ? T.accent : T.inkMuted, cursor: "pointer", fontSize: 13, fontWeight: 500, fontFamily: "'Work Sans', sans-serif" };
}
function inputStyle(T) {
  return { border: `1px solid ${T.cardBorder}`, borderRadius: 8, padding: "10px 12px", background: T.bgElevated, color: T.ink, outline: "none", fontFamily: "'Work Sans', sans-serif", width: "100%", fontSize: 16, minWidth: 0, boxSizing: "border-box" };
}
function primaryBtnStyle(T) {
  return { background: T.accent, color: T.onAccent, border: "none", borderRadius: 8, padding: "12px 16px", fontSize: 14.5, cursor: "pointer", fontFamily: "'Work Sans', sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%" };
}
function ghostBtnStyle(T) {
  return { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, padding: "10px 14px", borderRadius: 8, border: `1px dashed ${T.cardBorder}`, background: "transparent", color: T.inkMuted, cursor: "pointer", fontFamily: "'Work Sans', sans-serif" };
}
function iconBtnStyle(T) {
  return { display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, border: "none", background: "transparent", cursor: "pointer", color: T.inkMuted, flexShrink: 0 };
}
function roundBtnStyle(T) {
  return { width: 36, height: 36, borderRadius: "50%", background: T.card, border: `1px solid ${T.cardBorder}`, display: "flex", alignItems: "center", justifyContent: "center", color: T.ink, cursor: "pointer", flexShrink: 0, padding: 0 };
}
