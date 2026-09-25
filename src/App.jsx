import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import {
  Star, Moon, Sun, Home, Plus, User, X, Check, Loader2, Pencil, Trash2,
  Lock, Unlock, ThumbsUp, ThumbsDown, Upload, Download, Settings as SettingsIcon,
} from "lucide-react";

// ---- shared with pricelist/nota: same Firebase project, same admin password ----
const AUTH_DOC_REF = doc(db, "pricelist", "main");
const DATA_DOC_REF = doc(db, "testi", "data");
const THEME_KEY = "testi-theme";
const HOME_URL = "https://home.xiao-qi.my.id"; // placeholder — not built yet

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
    bg: "#FAF7F0", bgElevated: "#FFFFFF", card: "#F4EFE3", cardBorder: "#E6DDC8",
    ink: "#2B2416", inkMuted: "#6B6048", inkFaint: "#A79C7E", accent: "#C99A2E",
    accentSoft: "#F3E6C4", positive: "#2F9E67", negative: "#C0473A", dangerSoft: "#FBEAE7",
    chipBg: "#F3E6C4", chipActiveBg: "#C99A2E", chipActiveText: "#2B2416",
    navBg: "#FFFFFF", navBorder: "#E6DDC8", overlay: "rgba(43,36,22,0.4)", isDark: false,
  },
  dark: {
    bg: "#1B1710", bgElevated: "#241F16", card: "#241F16", cardBorder: "#3A3324",
    ink: "#F3ECD9", inkMuted: "#C4B990", inkFaint: "#7A7156", accent: "#E3B23C",
    accentSoft: "#33291A", positive: "#5FC98A", negative: "#E1786A", dangerSoft: "#2E1D18",
    chipBg: "#33291A", chipActiveBg: "#E3B23C", chipActiveText: "#1B1710",
    navBg: "#1F1B12", navBorder: "#3A3324", overlay: "rgba(0,0,0,0.6)", isDark: true,
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
  const [page, setPage] = useState("wall"); // wall | profile
  const [showWriteReview, setShowWriteReview] = useState(null); // null | {} (new) | review object (editing)
  const [toast, setToast] = useState("");
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
        setDoc(DATA_DOC_REF, DEFAULT_DATA).catch(() => {});
        setData(DEFAULT_DATA);
      } else if (!editingRef.current) {
        const d = snap.data();
        setData({ settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) }, reviews: d.reviews || [] });
      }
      setDataLoaded(true);
    }, () => { setData(DEFAULT_DATA); setDataLoaded(true); });
    return () => unsub();
  }, []);

  const persist = useCallback(async (next) => {
    setData(next);
    try { await setDoc(DATA_DOC_REF, next); } catch (e) { flashToast("Couldn't save — check your connection"); }
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

      <div style={{ maxWidth: 560, margin: "0 auto", paddingBottom: 90 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 20px 14px" }}>
          <button onClick={() => setPage("wall")} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 21, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 8, color: T.ink }}>
              <Star size={18} color={T.accent} fill={T.accent} /> Testimonials
            </h1>
          </button>
          <button onClick={() => setDark(!dark)} style={{ width: 36, height: 36, borderRadius: "50%", background: T.card, border: `1px solid ${T.cardBorder}`, display: "flex", alignItems: "center", justifyContent: "center", color: T.ink, cursor: "pointer" }}>
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
        <a href={HOME_URL} style={navBtnStyle(T, false)} title="Home">
          <Home size={20} />
          <span style={navLabelStyle(T, false)}>Home</span>
        </a>
        <button onClick={() => setShowWriteReview({})} style={{ ...navBtnStyle(T, false), background: "none", border: "none" }} title="Write a review">
          <div style={{ width: 46, height: 46, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", color: T.isDark ? "#1B1710" : "#fff", marginTop: -22, boxShadow: `0 4px 12px ${T.accent}55` }}>
            <Plus size={22} />
          </div>
        </button>
        <button onClick={() => setPage("profile")} style={{ ...navBtnStyle(T, page === "profile"), background: "none", border: "none" }} title="Profile">
          <User size={20} color={page === "profile" ? T.accent : T.inkMuted} />
          <span style={navLabelStyle(T, page === "profile")}>{isAdmin ? "Admin" : "Profile"}</span>
        </button>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 90, left: "50%", transform: "translateX(-50%)", background: T.accent, color: T.isDark ? "#1B1710" : "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6, zIndex: 30 }}>
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
    </div>
  );
}

// ---------------- WALL ----------------

function Wall({ T, reviews, settings, isAdmin, myReviewIds, myReactions, onEdit, onDelete, onReact }) {
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

      {/* wall */}
      {reviews.length === 0 ? (
        <div style={{ textAlign: "center", color: T.inkFaint, fontSize: 13.5, padding: "30px 0" }}>No reviews yet — be the first to write one.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {reviews.map((r) => (
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewCard({ review, T, settings, canManage, myReaction, onEdit, onDelete, onReact }) {
  return (
    <div className="testi-card" style={{ background: T.bgElevated, border: `1px solid ${T.cardBorder}`, borderRadius: 14, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {review.isAnonymous || !review.name ? "Anonymous" : review.name}
          </div>
          <div style={{ fontSize: 11, color: T.inkFaint, marginTop: 1 }}>{formatDate(review.date)}</div>
        </div>
        <StarRow value={review.rating} T={T} size={14} />
      </div>

      <p style={{ fontSize: 14, color: T.ink, lineHeight: 1.55, margin: "0 0 10px", whiteSpace: "pre-wrap" }}>{review.text}</p>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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
          <Star size={interactive ? size + 8 : size} color={T.accent} fill={n <= rounded ? T.accent : "none"} />
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

function Profile({ T, reviews, settings, isAdmin, myReviewIds, onEdit, onDelete, onLoginClick, onLogout, onToggleEmoji, data, persist, flashToast, authPassword }) {
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
            <div key={r.id} style={{ background: T.bgElevated, border: `1px solid ${T.cardBorder}`, borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <StarRow value={r.rating} T={T} size={12} />
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => onEdit(r)} style={iconBtnStyle(T)}><Pencil size={13} /></button>
                  <button onClick={() => onDelete(r.id)} style={{ ...iconBtnStyle(T), color: T.negative }}><Trash2 size={13} /></button>
                </div>
              </div>
              <p style={{ fontSize: 13, color: T.ink, margin: 0, whiteSpace: "pre-wrap" }}>{r.text}</p>
              <div style={{ fontSize: 10.5, color: T.inkFaint, marginTop: 4 }}>{formatDate(r.date)}</div>
            </div>
          ))}
        </div>
      )}
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
  return { background: T.accent, color: T.isDark ? "#1B1710" : "#fff", border: "none", borderRadius: 8, padding: "12px 16px", fontSize: 14.5, cursor: "pointer", fontFamily: "'Work Sans', sans-serif", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%" };
}
function ghostBtnStyle(T) {
  return { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, padding: "10px 14px", borderRadius: 8, border: `1px dashed ${T.cardBorder}`, background: "transparent", color: T.inkMuted, cursor: "pointer", fontFamily: "'Work Sans', sans-serif" };
}
function iconBtnStyle(T) {
  return { display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, border: "none", background: "transparent", cursor: "pointer", color: T.inkMuted, flexShrink: 0 };
}
