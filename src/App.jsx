import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { doc, onSnapshot, setDoc, getDoc, getDocs, collection, query, where, runTransaction } from "firebase/firestore";
import { db } from "./firebase";
import {
  Star, Moon, Sun, Home, Plus, User, X, Check, Loader2, Pencil, Trash2,
  Lock, Unlock, ThumbsUp, ThumbsDown, Upload, Download, Settings as SettingsIcon, SlidersHorizontal,
  Image as ImageIcon, ImagePlus, FolderPlus, Search,
} from "lucide-react";

// ---- shared with pricelist/nota: same Firebase project, same admin password ----
const AUTH_DOC_REF = doc(db, "pricelist", "main");
// reviews + settings live here — same document and same shape as before, so existing reviews are kept
const DATA_DOC_REF = doc(db, "testi", "data");
// proofs: one small doc per image (number, date, thumbnail) + one doc holding the full image.
// They sit in the same "testi" collection so the Firestore rules you already have for it apply.
const proofMetaRef = (id) => doc(db, "testi", `proof_${id}`);
const proofImgRef = (id) => doc(db, "testi", `proofimg_${id}`);
const PROOF_KIND = "proof";
// one small doc listing every proof's number/date/category (no images): 1 read per visit, fits ~8,000 proofs
const PROOF_INDEX_REF = doc(db, "testi", "proofindex");
const PAGE_SIZE = 30; // thumbnails loaded per "page" inside a folder
const indexEntry = (p) => ({ id: p.id, cat: p.cat, date: p.date, seq: Number(p.seq) || 0, custom: p.custom || null });

const THEME_KEY = "testi-theme";
const LANG_KEY = "testi-lang";

const RECENT_DAYS = 7;
const RATING_STEP = 0.5; // rating input granularity: 0.5 = half stars, 0.25 = quarter stars
const fmtRating = (v) => String(Math.round((Number(v) || 0) * 100) / 100);
// timestamp in ms, or 0 when the date is missing/invalid
const reviewTime = (r) => { const t = new Date(r.date).getTime(); return isNaN(t) ? 0 : t; };

const uid = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_SETTINGS = { emojiEnabled: true };
const DEFAULT_DATA = { settings: DEFAULT_SETTINGS, reviews: [] };

// ---- proofs ----
const DEFAULT_FORMAT = "TESTI/{CAT}/{ROM}/{YYYY}/{NNN}";
const FOLDER_COLORS = ["#ffc9d9", "#fff09e", "#c4ecd8", "#cde2f8", "#dcd3f6", "#ffdcbd"];
const DEFAULT_CATS = [
  { id: "streaming", name: "Streaming Apps", code: "STR", color: FOLDER_COLORS[0] },
  { id: "education", name: "Education Apps", code: "EDU", color: FOLDER_COLORS[1] },
  { id: "editing", name: "Editing Apps", code: "EDT", color: FOLDER_COLORS[2] },
  { id: "music", name: "Music Apps", code: "MUS", color: FOLDER_COLORS[3] },
  { id: "other", name: "Other Apps", code: "OTH", color: FOLDER_COLORS[4] },
  { id: "robux", name: "Robux Vilog", code: "RBX", color: FOLDER_COLORS[5] },
];
const FORMAT_TOKENS = ["NNN", "NNNN", "DD", "MM", "ROM", "YYYY", "YY", "CAT"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const MAX_IMG_CHARS = 900000; // Firestore documents max out at ~1 MB
const STAR_COLOR = "#f2b705";
const POS = "#2f9e67";
const NEG = "#d0564a";

const pad2 = (n) => String(n).padStart(2, "0");
const proofTime = (p) => { const t = new Date(p.date).getTime(); return isNaN(t) ? 0 : t; };
const byNewest = (a, b) => proofTime(b) - proofTime(a) || (Number(b.seq) || 0) - (Number(a.seq) || 0);
const monthKey = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
const catColor = (cat, i) => cat.color || FOLDER_COLORS[i % FOLDER_COLORS.length];

function autoNumber(p, fmt, cats) {
  const d = new Date(p.date);
  const ok = !isNaN(d.getTime());
  const cat = cats.find((c) => c.id === p.cat);
  const seq = Number(p.seq) || 0;
  const map = {
    NNNN: String(seq).padStart(4, "0"),
    NNN: String(seq).padStart(3, "0"),
    DD: ok ? pad2(d.getDate()) : "",
    MM: ok ? pad2(d.getMonth() + 1) : "",
    ROM: ok ? ROMAN[d.getMonth()] : "",
    YYYY: ok ? String(d.getFullYear()) : "",
    YY: ok ? String(d.getFullYear()).slice(2) : "",
    CAT: cat ? cat.code : "",
  };
  return (fmt || DEFAULT_FORMAT).replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
}
const proofNumber = (p, fmt, cats) => p.custom || autoNumber(p, fmt, cats);

// proofs of one category, optionally narrowed by the proofs-page filters
function proofsIn(proofs, catId, filter, fmt, cats) {
  let list = proofs.filter((p) => p.cat === catId).sort(byNewest);
  if (filter) {
    if (filter.month) list = list.filter((p) => monthKey(p.date) === filter.month);
    const q = (filter.q || "").trim().toLowerCase();
    if (q) list = list.filter((p) => proofNumber(p, fmt, cats).toLowerCase().includes(q));
    if (filter.sort === "old") list = [...list].reverse();
  }
  return list;
}

// ---- image compression (keeps each image under the Firestore document limit) ----
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
function drawScaled(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { url: canvas.toDataURL("image/jpeg", quality), w, h };
}
async function compressImage(file) {
  const img = await loadImage(file);
  let side = 1280, q = 0.75;
  let out = drawScaled(img, side, q);
  while (out.url.length > MAX_IMG_CHARS && side > 500) {
    if (q > 0.55) q -= 0.1; else side = Math.round(side * 0.8);
    out = drawScaled(img, side, q);
  }
  if (out.url.length > MAX_IMG_CHARS) throw new Error("image-too-big");
  const thumb = drawScaled(img, 260, 0.7).url;
  return { full: out, thumb };
}

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

function formatDate(iso, locale) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

// ---------------- TRANSLATIONS ----------------

const STR = {
  id: {
    locale: "id-ID",
    title: "Testimoni GinzaCo", signTop: "apa kata mereka tentang", outOf: "dari 5",
    reviewsTotal: () => "ulasan total",
    home: "Beranda", proofs: "Bukti", profile: "Profil", admin: "Admin", write: "Tulis ulasan",
    toggleTheme: "Ganti tema", language: "Bahasa", back: "Kembali", close: "Tutup",
    connErr: "Tidak bisa terhubung ke Firebase. Cek .env / environment variables Cloudflare dan Firestore rules.",
    proofsErr: "Bukti tidak bisa dimuat. Cek Firestore rules untuk koleksi \"testi\".",
    // home
    proofsH: "Bukti transaksi", proofsP: "Pilih kategori untuk lihat semua bukti.", seeAll: "Lihat semua",
    reviewsH: "Semua ulasan",
    noReviews: "Belum ada ulasan — jadilah yang pertama menulis.",
    noRecent: (n) => `Tidak ada ulasan dalam ${n} hari terakhir.`,
    noMatch: "Tidak ada ulasan yang cocok dengan filter ini.",
    allReviews: "Semua ulasan", recentDays: (n) => `Terbaru · ${n} hari terakhir`, recent: "Terbaru",
    undated: "Tanpa tanggal", dayN: (d) => `Tanggal ${d}`, ofTotal: (a, b) => `${a} dari ${b}`,
    filterTitle: "Filter ulasan", filterAria: "Filter ulasan", all: "Semua", pickDate: "Atau pilih tanggal",
    year: "Tahun", month: "Bulan", day: "Tanggal",
    showingOf: (a, b) => `Menampilkan ${a} dari ${b} ulasan`, showingAll: "Menampilkan semua ulasan",
    clear: "Hapus filter", done: "Selesai", readMore: "Baca selengkapnya", anonymous: "Anonim",
    edit: "Edit", del: "Hapus",
    // write review
    writeTitle: "Tulis ulasan", editTitle: "Edit ulasanmu",
    ratingHint: "ketuk sisi kiri bintang untuk nilai setengah",
    useName: "Pakai nama", postAnon: "Kirim sebagai anonim",
    nameLabel: "Namamu (boleh nama samaran)", namePh: "mis. Budi, atau nama apa saja",
    reviewLabel: "Ulasanmu", reviewPh: "Ceritakan pengalamanmu...",
    saveChanges: "Simpan perubahan", post: "Kirim ulasan",
    starN: (n) => `${n} bintang`,
    // confirm
    delReviewTitle: "Hapus ulasan ini?", delReviewMsg: "Ulasan ini akan dihapus permanen dan tidak bisa dikembalikan.",
    saveEditTitle: "Simpan perubahan?", saveEditMsg: "Editanmu akan menggantikan versi ulasan yang sekarang.",
    cancel: "Batal", save: "Simpan", delete: "Hapus",
    // toasts
    tPosted: "Ulasan terkirim", tUpdated: "Ulasan diperbarui", tDeleted: "Ulasan dihapus",
    tSaveFail: "Gagal menyimpan — cek koneksimu", tExported: "Berhasil diekspor",
    tImported: (n) => `${n} ulasan diimpor`, tReadFail: "File tidak bisa dibaca",
    tPwUpdated: "Password diperbarui", tPwFail: "Gagal memperbarui password",
    tUploaded: (n) => `${n} bukti diunggah`, tUploadFail: (n) => `${n} gambar gagal diunggah`,
    tProofDeleted: "Bukti dihapus", tCatSaved: "Kategori disimpan", tCatDeleted: "Kategori dihapus",
    tFmtSaved: "Format disimpan", tNumSaved: "Nomor disimpan",
    // login + profile
    loginTitle: "Login admin", loginP: "Masukkan password admin untuk mengelola ulasan dan bukti.",
    password: "Password", wrongPw: "Password salah.", unlock: "Masuk",
    yourProfile: "Profilmu", fromDevice: (n) => `${n} ulasan dari perangkat ini`,
    loginAdmin: "Masuk sebagai admin", yourReviews: "Ulasanmu",
    noMine: "Kamu belum menulis ulasan dari perangkat ini.",
    adminSettings: "Pengaturan admin", emoji: "Reaksi emoji", emojiP: "Pengunjung bisa setuju/tidak setuju dengan ulasan",
    exportX: "Ekspor ulasan (Excel)", importX: "Impor ulasan (Excel)",
    changePw: "Ganti password admin (sama dengan pricelist/nota)", newPw: "Password baru", logout: "Keluar",
    // proofs page
    allProofs: "Semua bukti", allProofsP: "Filter berdasarkan kategori, bulan, atau nomor testi.",
    search: "Cari nomor testi…", allMonths: "Semua bulan", newest: "Terbaru", oldest: "Terlama",
    found: (n) => `${n} bukti ditemukan`, emptyProofs: "Tidak ada bukti yang cocok.",
    proofCount: (n) => `${n} bukti`, addCat: "Tambah kategori", emptyFolder: "Belum ada bukti di folder ini.",
    fmtH: "Format nomor testimoni",
    fmtHelp: "Ketuk token untuk menambahkannya ke format.",
    fmtNote: "Nomor lama ikut berubah, kecuali yang diedit manual.",
    example: "Contoh",
    tk: { NNN: "urut 001", NNNN: "urut 0001", DD: "tgl", MM: "bln", ROM: "bln romawi", YYYY: "tahun", YY: "thn", CAT: "kode kat." },
    // category editor
    editCat: "Edit kategori", newCat: "Kategori baru", catName: "Nama kategori", catCode: "Kode (untuk {CAT})",
    deleteCat: "Hapus kategori", catNotEmpty: "Kosongkan folder ini dulu sebelum menghapus kategorinya.",
    delCatTitle: "Hapus kategori ini?", delCatMsg: "Folder kosong ini akan dihapus.",
    // viewer
    upload: "Unggah bukti", uploading: "Mengunggah…", editNo: "Edit nomor", manual: "manual",
    delProofTitle: "Hapus bukti ini?", delProofMsg: "Gambar ini akan dihapus permanen.",
    imgFail: "Gambar tidak bisa dimuat.",
    loadMore: (n) => `Muat lebih banyak (${n} lagi)`,
  },
  en: {
    locale: "en-US",
    title: "GinzaCo Testimonials", signTop: "what people say about", outOf: "out of 5",
    reviewsTotal: (n) => (n === 1 ? "review total" : "reviews total"),
    home: "Home", proofs: "Proofs", profile: "Profile", admin: "Admin", write: "Write a review",
    toggleTheme: "Toggle theme", language: "Language", back: "Back", close: "Close",
    connErr: "Couldn't connect to Firebase. Check your .env / Cloudflare environment variables and Firestore rules.",
    proofsErr: "Couldn't load proofs. Check the Firestore rules for the \"testi\" collection.",
    proofsH: "Proof of transactions", proofsP: "Pick a category to see all proofs.", seeAll: "See all",
    reviewsH: "All reviews",
    noReviews: "No reviews yet — be the first to write one.",
    noRecent: (n) => `No reviews in the last ${n} days.`,
    noMatch: "No reviews match this filter.",
    allReviews: "All reviews", recentDays: (n) => `Recent · last ${n} days`, recent: "Recent",
    undated: "Undated", dayN: (d) => `Day ${d}`, ofTotal: (a, b) => `${a} of ${b}`,
    filterTitle: "Filter reviews", filterAria: "Filter reviews", all: "All", pickDate: "Or pick a date",
    year: "Year", month: "Month", day: "Day",
    showingOf: (a, b) => `Showing ${a} of ${b} review${b !== 1 ? "s" : ""}`, showingAll: "Showing all reviews",
    clear: "Clear", done: "Done", readMore: "Read more", anonymous: "Anonymous",
    edit: "Edit", del: "Delete",
    writeTitle: "Write a review", editTitle: "Edit your review",
    ratingHint: "tap the left side of a star for a partial rating",
    useName: "Use a name", postAnon: "Post anonymously",
    nameLabel: "Your name (can be a fake name)", namePh: "e.g. Budi, or any name you like",
    reviewLabel: "Your review", reviewPh: "Share your experience...",
    saveChanges: "Save changes", post: "Post review",
    starN: (n) => `${n} star${n > 1 ? "s" : ""}`,
    delReviewTitle: "Delete this review?", delReviewMsg: "This review will be permanently removed. This can't be undone.",
    saveEditTitle: "Save your changes?", saveEditMsg: "Your edits will replace the current version of this review.",
    cancel: "Cancel", save: "Save", delete: "Delete",
    tPosted: "Review posted", tUpdated: "Review updated", tDeleted: "Review deleted",
    tSaveFail: "Couldn't save — check your connection", tExported: "Exported",
    tImported: (n) => `Imported ${n} reviews`, tReadFail: "Couldn't read that file",
    tPwUpdated: "Password updated", tPwFail: "Couldn't update password",
    tUploaded: (n) => `${n} proof${n !== 1 ? "s" : ""} uploaded`, tUploadFail: (n) => `${n} image${n !== 1 ? "s" : ""} failed to upload`,
    tProofDeleted: "Proof deleted", tCatSaved: "Category saved", tCatDeleted: "Category deleted",
    tFmtSaved: "Format saved", tNumSaved: "Number saved",
    loginTitle: "Admin login", loginP: "Enter the admin password to manage reviews and proofs.",
    password: "Password", wrongPw: "Incorrect password.", unlock: "Unlock",
    yourProfile: "Your profile", fromDevice: (n) => `${n} review${n !== 1 ? "s" : ""} from this device`,
    loginAdmin: "Log in as admin", yourReviews: "Your reviews",
    noMine: "You haven't posted any reviews from this device yet.",
    adminSettings: "Admin settings", emoji: "Emoji reactions", emojiP: "Let visitors agree/disagree with reviews",
    exportX: "Export reviews (Excel)", importX: "Import reviews (Excel)",
    changePw: "Change admin password (shared with pricelist/nota)", newPw: "New password", logout: "Log out",
    allProofs: "All proofs", allProofsP: "Filter by category, month, or testimony number.",
    search: "Search testimony no…", allMonths: "All months", newest: "Newest", oldest: "Oldest",
    found: (n) => `${n} proof${n !== 1 ? "s" : ""} found`, emptyProofs: "No matching proofs.",
    proofCount: (n) => `${n} proof${n !== 1 ? "s" : ""}`, addCat: "Add category", emptyFolder: "No proofs in this folder yet.",
    fmtH: "Testimony number format",
    fmtHelp: "Tap a token to add it to the format.",
    fmtNote: "Old numbers update too, except ones you edited by hand.",
    example: "Example",
    tk: { NNN: "seq 001", NNNN: "seq 0001", DD: "day", MM: "month", ROM: "roman month", YYYY: "year", YY: "yr", CAT: "cat. code" },
    editCat: "Edit category", newCat: "New category", catName: "Category name", catCode: "Code (for {CAT})",
    deleteCat: "Delete category", catNotEmpty: "Empty this folder before deleting the category.",
    delCatTitle: "Delete this category?", delCatMsg: "This empty folder will be removed.",
    upload: "Upload proof", uploading: "Uploading…", editNo: "Edit number", manual: "manual",
    delProofTitle: "Delete this proof?", delProofMsg: "This image will be permanently removed.",
    imgFail: "Couldn't load the image.",
    loadMore: (n) => `Load more (${n} left)`,
  },
};

// ---------------- STYLES ----------------

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Gochi+Hand&family=Nunito:wght@400;600;700;800;900&display=swap');
html, body, #root { margin: 0; padding: 0; width: 100%; }
* { box-sizing: border-box; }
body { overflow-x: hidden; }
.gc {
  --navy: #23264f; --edge: #23264f; --ink: #1c1f3d; --blue: #3d63dd;
  --paper: #ffffff; --line: #e6e8f3; --outer: #dcdcf5;
  --pink: #ffc9d9; --peach: #ffdcbd; --yellow: #fff09e; --mint: #c4ecd8; --sky: #cde2f8; --lilac: #dcd3f6;
  --muted: #6b6f93; --neg: #c0473a; --negsoft: #fbeae7;
  --hand: 'Gochi Hand', 'Comic Sans MS', cursive;
  --sans: 'Nunito', 'Segoe UI', system-ui, sans-serif;
  min-height: 100vh; width: 100%; background: var(--outer); font-family: var(--sans); color: var(--ink);
}
.gc.dark {
  --navy: #0b0d22; --edge: #4a4f8a; --ink: #eef0ff; --paper: #171a35; --line: #23274a; --outer: #0f1128;
  --muted: #a3a7cc; --neg: #ef8a7c; --negsoft: #3a2024;
}
.gc button { font-family: var(--sans); }
.gc button:not(:disabled):active { transform: translate(1px, 1px); }
.page {
  max-width: 620px; margin: 0 auto; min-height: 100vh; padding: 14px 14px 150px;
  background-color: var(--paper);
  background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size: 22px 22px;
}
.box { border: 2.5px solid var(--edge); border-radius: 14px; background: var(--paper); box-shadow: 3px 3px 0 var(--edge); }
.banner { background: var(--negsoft); color: var(--neg); font-size: 12.5px; font-weight: 700; padding: 8px 20px; text-align: center; }

/* top bar */
.topbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 999px; }
.brand { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; background: none; border: 0; padding: 0; cursor: pointer; color: var(--ink); text-align: left; }
.logo { width: 34px; height: 34px; border-radius: 50%; background: var(--yellow); border: 2px solid #23264f; display: grid; place-items: center; flex: none; }
.brand .t { font-weight: 900; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.iconbtn { width: 34px; height: 34px; border-radius: 50%; border: 2px solid var(--edge); background: var(--paper); color: var(--ink); display: grid; place-items: center; cursor: pointer; flex: none; padding: 0; position: relative; }
.iconbtn.sm { width: 28px; height: 28px; }
.iconbtn.danger { color: var(--neg); }
.dot { position: absolute; top: -2px; right: -2px; width: 11px; height: 11px; border-radius: 50%; background: var(--pink); border: 2px solid var(--edge); }
.lang { display: flex; flex: none; border: 2px solid var(--edge); border-radius: 999px; padding: 2px; background: var(--paper); }
.lang button { border: 0; background: transparent; font-weight: 900; font-size: 11px; color: var(--ink); padding: 5px 9px; border-radius: 999px; cursor: pointer; }
.lang button.on { background: var(--yellow); color: #23264f; }

/* hero */
.hero { margin-top: 18px; background: var(--navy); border-radius: 16px; padding: 18px; color: #fff;
  background-image: radial-gradient(rgba(255,255,255,.08) 1px, transparent 1px); background-size: 8px 8px; }
.sign { background: #fff; color: var(--blue); border: 2.5px solid #1c1f3d; border-radius: 8px; padding: 6px 14px 8px; text-align: center; transform: rotate(-1.2deg); box-shadow: 3px 3px 0 rgba(0,0,0,.35); }
.sign small { display: block; font-size: 12px; color: #555; font-family: var(--hand); }
.sign h1 { margin: 0; font-family: var(--hand); font-weight: 400; font-size: 40px; line-height: 1; }
.score { display: grid; grid-template-columns: auto 1fr; gap: 18px; margin-top: 16px; align-items: center; }
.big { text-align: center; }
.big .n { font-size: 52px; font-weight: 900; line-height: 1; }
.big .of { font-size: 12px; opacity: .8; margin-bottom: 2px; }
.bars { display: grid; gap: 5px; font-size: 12px; min-width: 0; }
.bars .r { display: grid; grid-template-columns: 22px 1fr 18px; gap: 8px; align-items: center; }
.bars .r span:last-child { text-align: right; }
.bar { height: 9px; border-radius: 99px; background: rgba(255,255,255,.15); border: 1.5px solid rgba(255,255,255,.4); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--yellow); }
.total { font-size: 13px; margin-bottom: 6px; opacity: .9; }
.total b { font-size: 15px; }

/* section heads */
.sh { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; margin: 26px 2px 12px; }
.sh h2 { margin: 0; font-family: var(--hand); font-weight: 400; font-size: 28px; line-height: 1; }
.sh p { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.linkbtn { border: 2px solid var(--edge); background: var(--yellow); color: #23264f; border-radius: 8px; padding: 6px 11px; font-weight: 900; font-size: 12px; cursor: pointer; white-space: nowrap; }

/* folders */
.folders { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 26px 14px; padding-top: 14px; }
.fwrap { position: relative; min-width: 0; }
.folder { position: relative; display: block; width: 100%; aspect-ratio: 1 / .9; border: 0; background: none; padding: 0; cursor: pointer; color: #23264f; }
.f-back { position: absolute; inset: 16% 0 0 0; background: var(--c); border: 2.5px solid #23264f; border-radius: 4px 12px 12px 12px; box-shadow: 3px 3px 0 #23264f; }
.f-back::before { content: ""; position: absolute; left: -2.5px; top: -15px; width: 46%; height: 16px; background: var(--c); border: 2.5px solid #23264f; border-bottom: 0; border-radius: 9px 9px 0 0; }
.pic { position: absolute; bottom: 34%; width: 42%; aspect-ratio: 3 / 4; background: #fff; border: 2px solid #23264f; border-radius: 6px; padding: 3px; transition: transform .25s ease-out; }
.pic img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 3px; }
.pic .ph { display: block; width: 100%; height: 100%; border-radius: 3px; background: var(--c); opacity: .55; }
.tile .ph { position: absolute; inset: 0; display: grid; place-items: center; padding-bottom: 30%; color: #23264f; opacity: .55; cursor: zoom-in; }
.loadmore { margin-top: 14px; }
.pic.a { left: 10%; transform: rotate(-9deg); }
.pic.b { left: 29%; transform: rotate(3deg); bottom: 38%; }
.pic.c { left: 50%; transform: rotate(11deg); }
.f-front { position: absolute; left: 0; right: 0; bottom: 0; height: 60%; background: var(--c); border: 2.5px solid #23264f; border-radius: 10px;
  display: flex; flex-direction: column; justify-content: flex-end; padding: 8px 10px; text-align: left;
  background-image: linear-gradient(rgba(255,255,255,.35), rgba(255,255,255,0) 40%); }
.f-front b { font-size: 13px; font-weight: 900; line-height: 1.15; overflow-wrap: anywhere; padding-right: 26px; }
.f-front small { font-size: 11px; font-weight: 700; opacity: .7; }
.fedit { position: absolute; right: 6px; bottom: 6px; z-index: 3; width: 28px; height: 28px; border-radius: 50%; border: 2px solid #23264f; background: #fff; color: #23264f; display: grid; place-items: center; cursor: pointer; padding: 0; }
.folder.add .f-back, .folder.add .f-front { background: var(--paper); border-style: dashed; }
.folder.add .f-back::before { background: var(--paper); border-style: dashed; }
.folder.add .f-front { align-items: center; justify-content: center; gap: 4px; color: var(--ink); text-align: center; }
.folder.add .f-front b { padding-right: 0; }
@media (prefers-reduced-motion: no-preference) {
  .folder:hover .pic.a { transform: rotate(-13deg) translateY(-8px); }
  .folder:hover .pic.b { transform: rotate(2deg) translateY(-12px); }
  .folder:hover .pic.c { transform: rotate(15deg) translateY(-8px); }
}

/* proofs page */
.fmtcard { padding: 14px; margin-bottom: 16px; background: var(--yellow); color: #23264f; }
.gc.dark .fmtcard { background: #3a3560; color: #eef0ff; }
.fmtcard h3 { margin: 0 0 4px; font-size: 14px; font-weight: 900; }
.fmtcard p { margin: 0 0 10px; font-size: 11.5px; opacity: .85; }
.fmtrow { display: flex; gap: 8px; }
.mono { font-family: ui-monospace, 'SF Mono', Consolas, monospace !important; }
.tokens { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.tok { border: 2px solid #23264f; background: #fff; color: #23264f; border-radius: 8px; padding: 3px 7px; font-family: ui-monospace, Consolas, monospace !important; font-size: 11px; font-weight: 700; cursor: pointer; }
.tok small { font-family: var(--sans); opacity: .6; margin-left: 3px; }
.example { font-size: 12px; font-weight: 800; }
.example code { font-family: ui-monospace, Consolas, monospace; background: #fff; color: #23264f; border: 2px solid #23264f; border-radius: 6px; padding: 2px 6px; margin-left: 4px; word-break: break-all; }
.filters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
.filters .search { grid-column: 1 / -1; position: relative; }
.filters .search .field { padding-left: 34px; }
.filters .search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); }
.chips { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; border-bottom: 2.5px solid var(--edge); margin-bottom: 6px; }
.chip { flex: none; border: 2px solid var(--edge); background: var(--sky); color: #23264f; border-radius: 8px 8px 0 0; padding: 6px 11px; font-size: 12px; font-weight: 800; cursor: pointer; }
.chip.on { background: var(--navy); color: #fff; }
.gc.dark .chip.on { background: var(--edge); }
.resc { font-size: 12px; color: var(--muted); margin: 6px 2px 0; }
.empty { grid-column: 1 / -1; text-align: center; font-size: 13.5px; color: var(--muted); padding: 30px 0; }

/* folder viewer */
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.tile { position: relative; aspect-ratio: 3 / 4; border: 2px solid var(--edge); border-radius: 10px; overflow: hidden; background: var(--c); min-width: 0; }
.tile > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
.lbl { position: absolute; left: 5px; right: 5px; bottom: 5px; background: #fff; color: #23264f; border: 2px solid #23264f; border-radius: 7px; padding: 4px 6px; line-height: 1.2; }
.lbl b { display: block; font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 10px; font-weight: 700; overflow-wrap: anywhere; }
.lbl small { display: block; font-size: 10px; color: #6b6f93; font-weight: 700; margin-top: 1px; }
.lbl input { width: 100%; border: 0; border-bottom: 2px solid #23264f; font-family: ui-monospace, Consolas, monospace; font-size: 10px; padding: 1px 0; background: transparent; color: #23264f; outline: none; }
.cust { display: inline-block; font-family: var(--sans); font-size: 9px; font-weight: 900; background: #fff09e; border-radius: 4px; padding: 0 4px; margin-left: 4px; vertical-align: 1px; }
.tile-tools { position: absolute; top: 5px; right: 5px; display: flex; gap: 4px; }
.tile-tools button { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #23264f; background: #fff; color: #23264f; display: grid; place-items: center; cursor: pointer; padding: 0; }
.tile-tools button.del { color: #c0473a; }
.tile.up { border-style: dashed; background: var(--paper); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; cursor: pointer; color: var(--ink); font-weight: 800; font-size: 12px; text-align: center; padding: 6px; }
.tile.up.busy { cursor: progress; opacity: .7; }
.lightbox img { display: block; max-width: 100%; max-height: 70vh; margin: 0 auto; border-radius: 8px; border: 2px solid var(--edge); }
.lightbox .cap { display: flex; justify-content: space-between; gap: 8px; margin-top: 10px; font-size: 12px; }
.lightbox .cap b { font-family: ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
.lightbox .cap span { color: var(--muted); white-space: nowrap; font-weight: 700; }

/* reviews */
.filterrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
.filterrow .lab { font-size: 13px; color: var(--muted); min-width: 0; }
.filterrow .lab strong { color: var(--ink); font-weight: 900; }
.sec { margin-bottom: 18px; }
.month { display: flex; justify-content: space-between; font-size: 12px; font-weight: 900; letter-spacing: .06em; color: var(--muted); text-transform: uppercase; margin: 6px 2px 8px; }
.month span:last-child { letter-spacing: 0; font-weight: 700; }
.revs { display: flex; flex-direction: column; gap: 12px; }
.rev { padding: 14px; }
.rev.click { cursor: pointer; }
.rev .hd { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
.rev .nm { font-weight: 900; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rev .dt { font-size: 11px; color: var(--muted); margin-top: 1px; }
.rev .ft { display: flex; justify-content: space-between; align-items: center; cursor: default; }
.txt { font-size: 14px; line-height: 1.55; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.more { background: none; border: 0; padding: 0; margin-top: 4px; color: var(--blue); font-weight: 800; cursor: pointer; }
.gc.dark .more { color: #9fb2ff; }
.votes { display: flex; gap: 6px; }
.vote { display: flex; align-items: center; gap: 5px; border: 2px solid var(--edge); background: var(--paper); color: var(--ink); border-radius: 999px; padding: 4px 10px; font-weight: 800; font-size: 12px; cursor: pointer; }
.tools { display: flex; gap: 4px; }
.stars { display: flex; gap: 2px; justify-content: center; }
.stars button { background: none; border: 0; padding: 0; display: block; position: relative; }
.stars button span { position: absolute; left: 0; top: 0; height: 100%; overflow: hidden; display: block; }

/* forms */
.field { width: 100%; min-width: 0; border: 2px solid var(--edge); border-radius: 10px; padding: 9px 11px; font-family: var(--sans); font-weight: 700; font-size: 16px; background: var(--paper); color: var(--ink); outline: none; }
.field:focus { box-shadow: 2px 2px 0 var(--edge); }
.gc.dark .field { color-scheme: dark; }
.flabel { display: block; font-size: 12px; font-weight: 800; margin-bottom: 4px; color: var(--muted); }
.stack { display: flex; flex-direction: column; gap: 14px; }
.seg { display: flex; gap: 8px; }
.seg button { flex: 1; padding: 9px 0; border-radius: 10px; border: 2px solid var(--edge); background: var(--paper); color: var(--ink); cursor: pointer; font-size: 13px; font-weight: 800; }
.seg button.on { background: var(--sky); color: #23264f; }
.btn { display: flex; align-items: center; justify-content: center; gap: 7px; border: 2px solid var(--edge); border-radius: 10px; padding: 10px 14px; font-weight: 900; font-size: 13.5px; cursor: pointer; color: var(--ink); background: var(--paper); }
.btn.pri { background: var(--yellow); color: #23264f; border-color: #23264f; box-shadow: 2px 2px 0 #23264f; }
.btn.red { background: #c0473a; color: #fff; border-color: #23264f; }
.btn.ghost { border-style: dashed; color: var(--muted); }
.btn.outline-red { color: var(--neg); border-color: var(--neg); }
.btn.full { width: 100%; }
.btn:disabled { opacity: .5; cursor: default; }
.row2 { display: flex; gap: 8px; }
.row2 > * { flex: 1; }
.hint { font-size: 12px; color: var(--muted); }
.err { color: var(--neg); font-size: 12.5px; font-weight: 700; margin: 6px 0 0; }

/* profile */
.prof { display: flex; align-items: center; gap: 12px; margin: 18px 0 20px; }
.avatar { width: 48px; height: 48px; border-radius: 50%; background: var(--pink); border: 2.5px solid #23264f; display: grid; place-items: center; color: #23264f; flex: none; }
.prof .nm { font-family: var(--hand); font-size: 26px; line-height: 1; }
.panel { padding: 16px; margin-bottom: 20px; }
.panel-h { font-size: 12.5px; font-weight: 900; color: var(--muted); margin-bottom: 12px; display: flex; align-items: center; gap: 6px; text-transform: uppercase; letter-spacing: .04em; }
.setrow { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 14px; }
.toggle { width: 46px; height: 26px; border-radius: 999px; border: 2px solid var(--edge); cursor: pointer; background: var(--paper); position: relative; flex: none; padding: 0; }
.toggle i { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--edge); transition: left .15s ease; }
.toggle.on { background: var(--pink); }
.toggle.on i { left: 22px; background: #23264f; }
.divider { border-top: 2px dashed var(--line); padding-top: 12px; margin-bottom: 12px; }
.myrev { padding: 12px; }

/* dock */
.dock { position: fixed; left: 50%; bottom: calc(14px + env(safe-area-inset-bottom)); transform: translateX(-50%); width: min(340px, calc(100% - 28px)); z-index: 20; }
.nav { display: grid; grid-template-columns: 1fr 1fr 1fr; padding: 5px; border-radius: 999px; gap: 4px; }
.nav button { border: 2px solid transparent; background: transparent; font-size: 11px; font-weight: 800; color: var(--ink); display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 8px; border-radius: 999px; cursor: pointer; }
.nav button.on { background: var(--yellow); color: #23264f; border-color: #23264f; }
.fab { position: absolute; right: 4px; bottom: calc(100% + 12px); display: flex; align-items: center; gap: 6px; background: var(--pink); color: #23264f; border: 2.5px solid #23264f; border-radius: 999px; padding: 10px 16px 10px 12px; font-weight: 900; font-size: 13px; cursor: pointer; box-shadow: 3px 3px 0 #23264f; }
.toast { position: fixed; bottom: calc(150px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); background: #23264f; color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 13.5px; font-weight: 800; display: flex; align-items: center; gap: 6px; z-index: 90; white-space: nowrap; }

/* overlays */
.overlay { position: fixed; inset: 0; background: rgba(20,22,50,.6); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 50; }
.overlay.z60 { z-index: 60; } .overlay.z70 { z-index: 70; } .overlay.z80 { z-index: 80; }
.sheet { width: 100%; max-width: 480px; max-height: 88vh; overflow-y: auto; padding: 18px; position: relative; }
.sheet.wide { max-width: 560px; }
.sheet.narrow { max-width: 360px; }
.sheet-h { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
.sheet-h h3 { margin: 0; font-family: var(--hand); font-weight: 400; font-size: 26px; line-height: 1.1; overflow-wrap: anywhere; }
.sheet-h .sub { font-size: 12px; color: var(--muted); margin-top: 2px; font-weight: 700; }
.detail { width: 100%; max-width: 480px; max-height: 86vh; display: flex; flex-direction: column; }
.detail .top { display: flex; justify-content: flex-end; margin-bottom: 10px; }
.detail .scroll { overflow-y: auto; }
.loading { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
@keyframes gc-spin { to { transform: rotate(360deg); } }
.animate-spin { animation: gc-spin 1s linear infinite; }
@media (prefers-reduced-motion: no-preference) {
  .overlay { animation: gc-fade .18s ease; }
  .sheet, .detail { animation: gc-pop .22s cubic-bezier(.16, 1, .3, 1); }
  .rev.anim { animation: gc-pop .2s ease; }
}
@keyframes gc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes gc-pop { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }
@media (max-width: 420px) {
  .folders { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .big .n { font-size: 42px; }
}
`;

// ---------------- APP ----------------

export default function App() {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) === "dark"; } catch (e) { return false; }
  });
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem(LANG_KEY) === "en" ? "en" : "id"; } catch (e) { return "id"; }
  });
  const L = STR[lang];

  const [authPassword, setAuthPassword] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [loginError, setLoginError] = useState(false);

  const [data, setData] = useState(null);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [proofs, setProofs] = useState([]); // from the index doc: id, cat, date, seq, custom (no images)
  const [proofsError, setProofsError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [thumbs, setThumbs] = useState({}); // proof id -> thumbnail, fetched only when it's on screen
  const thumbReq = useRef(new Set());

  const [page, setPage] = useState("home"); // home | proofs | profile
  const [showWriteReview, setShowWriteReview] = useState(null); // null | {} (new) | review object (editing)
  const [toast, setToast] = useState("");
  const [detailId, setDetailId] = useState(null); // review id shown in the detail overlay
  const [confirm, setConfirm] = useState(null); // null | { type: "delete" | "edit" | "proof" | "cat", ... }
  const [openFolder, setOpenFolder] = useState(null); // null | { catId, filter }
  const [viewProof, setViewProof] = useState(null); // proof shown full-size
  const [editCat, setEditCat] = useState(null); // null | {} (new) | category
  const editingRef = useRef(false);
  const toastTimer = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch (e) {}
    const bg = dark ? "#0f1128" : "#dcdcf5";
    document.body.style.background = bg;
    document.documentElement.style.background = bg;
  }, [dark]);

  useEffect(() => {
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    document.documentElement.lang = lang;
  }, [lang]);

  const flashToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  };

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

  // proofs: listen to ONE index doc (numbers/dates only). Thumbnails and full images load on demand,
  // so a visit costs about the same with 50 proofs or 5,000.
  useEffect(() => {
    let rebuilding = false;
    const unsub = onSnapshot(PROOF_INDEX_REF, async (snap) => {
      if (snap.exists()) {
        const items = snap.data().items;
        setProofs(Array.isArray(items) ? items.filter((p) => p && p.id) : []);
        setProofsError(false);
        return;
      }
      // first run (or proofs uploaded before the index existed): build the index once
      if (rebuilding) return;
      rebuilding = true;
      try {
        const res = await getDocs(query(collection(db, "testi"), where("kind", "==", PROOF_KIND)));
        const items = res.docs.map((d) => d.data()).filter((p) => p && p.id).map(indexEntry);
        await runTransaction(db, async (tx) => {
          const cur = await tx.get(PROOF_INDEX_REF);
          if (!cur.exists()) tx.set(PROOF_INDEX_REF, { items });
        });
      } catch (e) {
        console.error(e);
        setProofsError(true);
      }
    }, (err) => {
      console.error(err);
      setProofsError(true);
    });
    return () => unsub();
  }, []);

  // fetch thumbnails only for proofs that are actually shown (cached for the rest of the visit)
  const ensureThumbs = useCallback((ids) => {
    const need = ids.filter((id) => id && !thumbReq.current.has(id));
    if (!need.length) return;
    need.forEach((id) => thumbReq.current.add(id));
    Promise.all(need.map((id) =>
      getDoc(proofMetaRef(id))
        .then((snap) => [id, snap.exists() ? snap.data().thumb || "" : ""])
        .catch(() => { thumbReq.current.delete(id); return null; })
    )).then((pairs) => setThumbs((t) => {
      const next = { ...t };
      pairs.forEach((x) => { if (x) next[x[0]] = x[1]; });
      return next;
    }));
  }, []);

  const persist = useCallback(async (next) => {
    setData(next);
    try {
      await setDoc(DATA_DOC_REF, next);
      setConnectionError(false);
      return true;
    } catch (e) {
      setConnectionError(true);
      flashToast(STR[lang].tSaveFail);
      return false;
    }
  }, [lang]);

  const handleLogin = () => {
    if (pwInput === authPassword) { setIsAdmin(true); setShowLogin(false); setPwInput(""); setLoginError(false); }
    else setLoginError(true);
  };

  const go = (p) => { setPage(p); window.scrollTo({ top: 0, behavior: "smooth" }); };

  const rootClass = `gc${dark ? " dark" : ""}`;

  if (!authLoaded || !dataLoaded || !data) {
    return (
      <div className={rootClass}>
        <style>{CSS}</style>
        <div className="loading"><Loader2 className="animate-spin" color="#3d63dd" size={26} /></div>
      </div>
    );
  }

  const reviews = data.reviews || [];
  const settings = data.settings;
  const cats = Array.isArray(settings.proofCats) && settings.proofCats.length ? settings.proofCats : DEFAULT_CATS;
  const proofFormat = settings.proofFormat || DEFAULT_FORMAT;
  const myReviewIds = getMyReviewIds();
  const detailReview = detailId ? reviews.find((r) => r.id === detailId) : null;
  const saveSettings = (patch) => persist({ ...data, settings: { ...data.settings, ...patch } });

  // ---- reviews ----
  const commitReview = (review) => {
    const exists = reviews.some((r) => r.id === review.id);
    const nextReviews = exists ? reviews.map((r) => (r.id === review.id ? review : r)) : [review, ...reviews];
    persist({ ...data, reviews: nextReviews });
    if (!exists) addMyReviewId(review.id);
    setShowWriteReview(null);
    flashToast(exists ? L.tUpdated : L.tPosted);
  };

  const saveReview = (review) => {
    if (reviews.some((r) => r.id === review.id)) setConfirm({ type: "edit", review });
    else commitReview(review);
  };

  const requestDelete = (id) => setConfirm({ type: "delete", id });

  const deleteReview = (id) => {
    persist({ ...data, reviews: reviews.filter((r) => r.id !== id) });
    removeMyReviewId(id);
    if (detailId === id) setDetailId(null);
    flashToast(L.tDeleted);
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

  const toggleEmoji = () => saveSettings({ emojiEnabled: !data.settings.emojiEnabled });

  // ---- proofs ----
  // every change to the proof list goes through a transaction on the index doc,
  // so two uploads at the same time can't get the same number
  const updateIndex = (change, extra) => runTransaction(db, async (tx) => {
    const snap = await tx.get(PROOF_INDEX_REF);
    const items = snap.exists() && Array.isArray(snap.data().items) ? snap.data().items : [];
    tx.set(PROOF_INDEX_REF, { items: change(items) });
    if (extra) extra(tx, items);
  });

  const uploadProofs = async (catId, files) => {
    const list = (files || []).filter((f) => f && f.type && f.type.startsWith("image/"));
    if (!list.length || uploading) return;
    setUploading(true);
    let ok = 0, failed = 0;
    for (const file of list) {
      try {
        const { full, thumb } = await compressImage(file);
        const id = uid() + uid();
        const date = new Date().toISOString();
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(PROOF_INDEX_REF);
          const items = snap.exists() && Array.isArray(snap.data().items) ? snap.data().items : [];
          const seq = items.reduce((m, p) => Math.max(m, Number(p.seq) || 0), 0) + 1;
          tx.set(proofImgRef(id), { kind: "proofimg", id, img: full.url });
          tx.set(proofMetaRef(id), { kind: PROOF_KIND, id, cat: catId, date, seq, custom: null, thumb, w: full.w, h: full.h });
          tx.set(PROOF_INDEX_REF, { items: [...items, { id, cat: catId, date, seq, custom: null }] });
        });
        thumbReq.current.add(id);
        setThumbs((t) => ({ ...t, [id]: thumb }));
        ok++;
      } catch (e) {
        console.error(e);
        failed++;
      }
    }
    setUploading(false);
    flashToast(failed ? L.tUploadFail(failed) : L.tUploaded(ok));
  };

  const saveProofNumber = async (id, value) => {
    const p = proofs.find((x) => x.id === id);
    if (!p) return;
    const v = (value || "").trim();
    const custom = !v || v === autoNumber(p, proofFormat, cats) ? null : v;
    if (custom === (p.custom || null)) return;
    try {
      await updateIndex(
        (items) => items.map((x) => (x.id === id ? { ...x, custom } : x)),
        (tx) => tx.set(proofMetaRef(id), { custom }, { merge: true })
      );
      flashToast(L.tNumSaved);
    } catch (e) { flashToast(L.tSaveFail); }
  };

  const deleteProof = async (id) => {
    try {
      await updateIndex(
        (items) => items.filter((x) => x.id !== id),
        (tx) => { tx.delete(proofMetaRef(id)); tx.delete(proofImgRef(id)); }
      );
      if (viewProof && viewProof.id === id) setViewProof(null);
      flashToast(L.tProofDeleted);
    } catch (e) { flashToast(L.tSaveFail); }
  };

  const saveCategory = async (cat) => {
    const exists = cats.some((c) => c.id === cat.id);
    const next = exists ? cats.map((c) => (c.id === cat.id ? cat : c)) : [...cats, cat];
    const ok = await saveSettings({ proofCats: next });
    if (ok) flashToast(L.tCatSaved);
    setEditCat(null);
  };

  const deleteCategory = async (catId) => {
    const ok = await saveSettings({ proofCats: cats.filter((c) => c.id !== catId) });
    if (ok) flashToast(L.tCatDeleted);
    setEditCat(null);
  };

  const saveFormat = async (fmt) => {
    const ok = await saveSettings({ proofFormat: (fmt || "").trim() || DEFAULT_FORMAT });
    if (ok) flashToast(L.tFmtSaved);
  };

  const folderCat = openFolder ? cats.find((c) => c.id === openFolder.catId) : null;
  const folderColor = folderCat ? catColor(folderCat, cats.indexOf(folderCat)) : null;
  const folderItems = folderCat ? proofsIn(proofs, folderCat.id, openFolder.filter, proofFormat, cats) : [];

  return (
    <div className={rootClass}>
      <style>{CSS}</style>

      {connectionError && <div className="banner">{L.connErr}</div>}
      {proofsError && !connectionError && <div className="banner">{L.proofsErr}</div>}

      <div className="page">
        <div className="topbar box">
          <button className="brand" onClick={() => go("home")}>
            <span className="logo"><Star size={16} color="#23264f" fill="#23264f" /></span>
            <span className="t">{L.title}</span>
          </button>
          <div className="lang" role="group" aria-label={L.language}>
            <button className={lang === "id" ? "on" : ""} onClick={() => setLang("id")}>ID</button>
            <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>EN</button>
          </div>
          <button className="iconbtn" onClick={() => setDark(!dark)} aria-label={L.toggleTheme} title={L.toggleTheme}>
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>

        {page === "home" && (
          <HomePage
            L={L}
            reviews={reviews}
            settings={settings}
            isAdmin={isAdmin}
            myReviewIds={myReviewIds}
            myReactions={getMyReactions()}
            onEdit={(r) => setShowWriteReview(r)}
            onDelete={requestDelete}
            onReact={toggleReaction}
            onOpen={setDetailId}
            cats={cats}
            proofs={proofs}
            thumbs={thumbs}
            ensureThumbs={ensureThumbs}
            onOpenFolder={(catId) => setOpenFolder({ catId, filter: null })}
            onSeeAllProofs={() => go("proofs")}
          />
        )}

        {page === "proofs" && (
          <ProofsPage
            L={L}
            isAdmin={isAdmin}
            cats={cats}
            proofs={proofs}
            thumbs={thumbs}
            ensureThumbs={ensureThumbs}
            fmt={proofFormat}
            onOpenFolder={(catId, filter) => setOpenFolder({ catId, filter })}
            onEditCat={(cat) => setEditCat(cat)}
            onSaveFormat={saveFormat}
          />
        )}

        {page === "profile" && (
          <Profile
            L={L}
            reviews={reviews}
            settings={settings}
            isAdmin={isAdmin}
            myReviewIds={myReviewIds}
            onEdit={(r) => setShowWriteReview(r)}
            onDelete={requestDelete}
            onLoginClick={() => setShowLogin(true)}
            onOpen={setDetailId}
            onLogout={() => setIsAdmin(false)}
            onToggleEmoji={toggleEmoji}
            data={data}
            persist={persist}
            flashToast={flashToast}
          />
        )}
      </div>

      {/* bottom nav: Proofs · Home (middle) · Profile, with the write button floating above the right side */}
      <div className="dock">
        <button className="fab" onClick={() => setShowWriteReview({})} title={L.write}>
          <Plus size={18} /><span>{L.write}</span>
        </button>
        <nav className="nav box">
          <button className={page === "proofs" ? "on" : ""} onClick={() => go("proofs")}>
            <ImageIcon size={16} /><span>{L.proofs}</span>
          </button>
          <button className={page === "home" ? "on" : ""} onClick={() => go("home")}>
            <Home size={16} /><span>{L.home}</span>
          </button>
          <button className={page === "profile" ? "on" : ""} onClick={() => go("profile")}>
            <User size={16} /><span>{isAdmin ? L.admin : L.profile}</span>
          </button>
        </nav>
      </div>

      {toast && <div className="toast"><Check size={14} /> {toast}</div>}

      {showLogin && (
        <Modal L={L} onClose={() => { setShowLogin(false); setPwInput(""); setLoginError(false); }} title={L.loginTitle}>
          <p className="hint" style={{ marginTop: -4, marginBottom: 14 }}>{L.loginP}</p>
          <input type="password" autoFocus value={pwInput} onChange={(e) => setPwInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLogin()} placeholder={L.password} className="field" />
          {loginError && <p className="err">{L.wrongPw}</p>}
          <button onClick={handleLogin} className="btn pri full" style={{ marginTop: 14 }}>{L.unlock}</button>
        </Modal>
      )}

      {showWriteReview !== null && (
        <WriteReviewModal
          L={L}
          review={showWriteReview}
          onClose={() => setShowWriteReview(null)}
          onSave={saveReview}
          editingRef={editingRef}
        />
      )}

      {detailReview && (
        <ReviewDetail
          L={L}
          review={detailReview}
          settings={settings}
          canManage={isAdmin || myReviewIds.includes(detailReview.id)}
          myReaction={getMyReactions()[detailReview.id]}
          onClose={() => setDetailId(null)}
          onEdit={() => { setDetailId(null); setShowWriteReview(detailReview); }}
          onDelete={() => requestDelete(detailReview.id)}
          onReact={(reaction) => toggleReaction(detailReview, reaction)}
        />
      )}

      {folderCat && (
        <FolderViewer
          key={folderCat.id}
          L={L}
          thumbs={thumbs}
          ensureThumbs={ensureThumbs}
          cat={folderCat}
          color={folderColor}
          items={folderItems}
          fmt={proofFormat}
          cats={cats}
          isAdmin={isAdmin}
          uploading={uploading}
          onUpload={(files) => uploadProofs(folderCat.id, files)}
          onSaveNumber={saveProofNumber}
          onDelete={(p) => setConfirm({ type: "proof", id: p.id })}
          onView={setViewProof}
          onClose={() => setOpenFolder(null)}
        />
      )}

      {viewProof && (
        <ImageLightbox
          L={L}
          proof={viewProof}
          thumb={thumbs[viewProof.id]}
          number={proofNumber(viewProof, proofFormat, cats)}
          onClose={() => setViewProof(null)}
        />
      )}

      {editCat && (
        <CategoryEditor
          L={L}
          cat={editCat}
          count={editCat.id ? proofs.filter((p) => p.cat === editCat.id).length : 0}
          nextColor={FOLDER_COLORS[cats.length % FOLDER_COLORS.length]}
          onClose={() => setEditCat(null)}
          onSave={saveCategory}
          onDelete={() => setConfirm({ type: "cat", id: editCat.id })}
        />
      )}

      {confirm && (
        <ConfirmDialog
          L={L}
          title={{ delete: L.delReviewTitle, edit: L.saveEditTitle, proof: L.delProofTitle, cat: L.delCatTitle }[confirm.type]}
          message={{ delete: L.delReviewMsg, edit: L.saveEditMsg, proof: L.delProofMsg, cat: L.delCatMsg }[confirm.type]}
          confirmLabel={confirm.type === "edit" ? L.save : L.delete}
          danger={confirm.type !== "edit"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            if (c.type === "delete") deleteReview(c.id);
            else if (c.type === "edit") commitReview(c.review);
            else if (c.type === "proof") deleteProof(c.id);
            else if (c.type === "cat") deleteCategory(c.id);
          }}
        />
      )}
    </div>
  );
}

// ---------------- HOME ----------------

function HomePage({ L, reviews, settings, isAdmin, myReviewIds, myReactions, onEdit, onDelete, onReact, onOpen, cats, proofs, thumbs, ensureThumbs, onOpenFolder, onSeeAllProofs }) {
  const locale = L.locale;
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

  const monthNames = useMemo(
    () => Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(locale, { month: "short" })),
    [locale]
  );

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
        const title = t ? d.toLocaleDateString(locale, { month: "long", year: "numeric" }) : L.undated;
        let g = groups.find((x) => x.key === key);
        if (!g) { g = { key, title, items: [] }; groups.push(g); }
        g.items.push(r);
      });
      return groups;
    };

    let sections;
    if (view === "recent") {
      sections = list.length ? [{ key: "recent", title: L.recentDays(RECENT_DAYS), items: list }] : [];
    } else if (hasDateFilter) {
      sections = groupByMonth(list);
    } else {
      const recent = list.filter((r) => reviewTime(r) >= cutoff);
      const older = list.filter((r) => reviewTime(r) < cutoff);
      sections = [
        ...(recent.length ? [{ key: "recent", title: L.recent, items: recent }] : []),
        ...groupByMonth(older),
      ];
    }
    return { list, sections };
  }, [reviews, view, hasDateFilter, fYear, fMonth, fDay, locale, L]);

  const [showFilter, setShowFilter] = useState(false);
  const isFiltered = view === "recent" || hasDateFilter;
  let filterLabel = L.allReviews;
  if (view === "recent") filterLabel = L.recentDays(RECENT_DAYS);
  else if (hasDateFilter) {
    filterLabel = (fMonth === "" && !fYear)
      ? L.dayN(fDay)
      : [fDay, fMonth !== "" ? monthNames[Number(fMonth)] : "", fYear].filter(Boolean).join(" ");
  }
  const onDateChange = (setter) => (e) => { setter(e.target.value); setView("all"); };
  const showRecent = () => { setView("recent"); setFYear(""); setFMonth(""); setFDay(""); };
  const clearFilters = () => { setView("all"); setFYear(""); setFMonth(""); setFDay(""); };

  const renderCard = (r) => (
    <ReviewCard
      key={r.id}
      L={L}
      review={r}
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
    <div>
      {/* grade report */}
      <section className="hero">
        <div className="sign"><small>{L.signTop}</small><h1>GinzaCo!!</h1></div>
        <div className="score">
          <div className="big">
            <div className="n">{stats.avg.toFixed(1)}</div>
            <div className="of">{L.outOf}</div>
            <StarRow value={stats.avg} size={15} L={L} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="total"><b>{stats.total}</b> {L.reviewsTotal(stats.total)}</div>
            <div className="bars">
              {[5, 4, 3, 2, 1].map((star) => {
                const count = stats.counts[star - 1];
                const pct = stats.total > 0 ? (count / stats.total) * 100 : 0;
                return (
                  <div key={star} className="r">
                    <span>{star}★</span>
                    <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                    <span>{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* proof folders */}
      <div className="sh">
        <div><h2>{L.proofsH}</h2><p>{L.proofsP}</p></div>
        <button className="linkbtn" onClick={onSeeAllProofs}>{L.seeAll}</button>
      </div>
      <div className="folders">
        {cats.map((c, i) => (
          <Folder key={c.id} L={L} cat={c} color={catColor(c, i)} items={proofsIn(proofs, c.id, null)} thumbs={thumbs} ensureThumbs={ensureThumbs} onOpen={() => onOpenFolder(c.id)} />
        ))}
      </div>

      {/* reviews */}
      <div className="sh">
        <div><h2>{L.reviewsH}</h2></div>
      </div>

      {reviews.length > 0 && (
        <div className="filterrow">
          <div className="lab">
            <strong>{filterLabel}</strong>
            {isFiltered && <span> · {L.ofTotal(list.length, reviews.length)}</span>}
          </div>
          <button onClick={() => setShowFilter(true)} aria-label={L.filterAria} title={L.filterAria} className="iconbtn">
            <SlidersHorizontal size={16} />
            {isFiltered && <span className="dot" />}
          </button>
        </div>
      )}

      {reviews.length === 0 ? (
        <div className="empty">{L.noReviews}</div>
      ) : list.length === 0 ? (
        <div className="empty">{view === "recent" ? L.noRecent(RECENT_DAYS) : L.noMatch}</div>
      ) : (
        <div>
          {sections.map((sec) => (
            <div key={sec.key} className="sec">
              <div className="month"><span>{sec.title}</span><span>{sec.items.length}</span></div>
              <div className="revs">{sec.items.map(renderCard)}</div>
            </div>
          ))}
        </div>
      )}

      {showFilter && (
        <Modal L={L} title={L.filterTitle} onClose={() => setShowFilter(false)}>
          <div className="stack">
            <div className="seg">
              <button onClick={clearFilters} className={!isFiltered ? "on" : ""}>{L.all}</button>
              <button onClick={showRecent} className={view === "recent" ? "on" : ""}>{L.recent}</button>
            </div>

            <Field label={L.pickDate}>
              <div className="row2">
                <select aria-label={L.year} value={fYear} onChange={onDateChange(setFYear)} className="field">
                  <option value="">{L.year}</option>
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                <select aria-label={L.month} value={fMonth} onChange={onDateChange(setFMonth)} className="field">
                  <option value="">{L.month}</option>
                  {monthNames.map((m, idx) => <option key={idx} value={idx}>{m}</option>)}
                </select>
                <select aria-label={L.day} value={fDay} onChange={onDateChange(setFDay)} className="field">
                  <option value="">{L.day}</option>
                  {Array.from({ length: 31 }, (_, n) => n + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </Field>

            <div className="hint">{isFiltered ? L.showingOf(list.length, reviews.length) : L.showingAll}</div>

            <div className="row2">
              <button onClick={clearFilters} disabled={!isFiltered} className="btn ghost">{L.clear}</button>
              <button onClick={() => setShowFilter(false)} className="btn pri">{L.done}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------- PROOFS ----------------

// A folder with up to 3 of its newest images peeking out of the top.
function Folder({ L, cat, color, items, onOpen, onEdit, thumbs, ensureThumbs }) {
  const peek = items.slice(0, 3);
  const peekKey = peek.map((p) => p.id).join(",");
  useEffect(() => { if (peekKey) ensureThumbs(peekKey.split(",")); }, [peekKey, ensureThumbs]);
  const slots = peek.length === 1 ? [["b", 0]] : peek.length === 2 ? [["a", 1], ["c", 0]] : [["a", 2], ["c", 1], ["b", 0]];
  return (
    <div className="fwrap">
      <button className="folder" style={{ "--c": color }} onClick={onOpen}>
        <div className="f-back" />
        {peek.length > 0 && slots.map(([pos, idx]) => (
          <div key={peek[idx].id} className={`pic ${pos}`}>{thumbs[peek[idx].id] ? <img src={thumbs[peek[idx].id]} alt="" /> : <span className="ph" />}</div>
        ))}
        <div className="f-front"><b>{cat.name}</b><small>{L.proofCount(items.length)}</small></div>
      </button>
      {onEdit && (
        <button className="fedit" onClick={onEdit} aria-label={L.editCat} title={L.editCat}><Pencil size={13} /></button>
      )}
    </div>
  );
}

function ProofsPage({ L, isAdmin, cats, proofs, thumbs, ensureThumbs, fmt, onOpenFolder, onEditCat, onSaveFormat }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [month, setMonth] = useState("");
  const [sort, setSort] = useState("new");
  const filter = { q, month, sort };
  const filtersOn = !!(month || q.trim());

  const months = useMemo(() => [...new Set(proofs.map((p) => monthKey(p.date)).filter(Boolean))].sort().reverse(), [proofs]);
  useEffect(() => { if (month && !months.includes(month)) setMonth(""); }, [months, month]);
  useEffect(() => { if (cat !== "all" && !cats.some((c) => c.id === cat)) setCat("all"); }, [cats, cat]);

  let total = 0;
  const shown = cats
    .map((c, i) => ({ c, color: catColor(c, i), items: proofsIn(proofs, c.id, filter, fmt, cats) }))
    .filter((x) => cat === "all" || x.c.id === cat)
    .filter((x) => { total += x.items.length; return !(filtersOn && !x.items.length); });

  const monthLabel = (m) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString(L.locale, { month: "long", year: "numeric" });
  };

  return (
    <div>
      <div className="sh">
        <div><h2>{L.allProofs}</h2><p>{L.allProofsP}</p></div>
      </div>

      {isAdmin && <FormatCard L={L} fmt={fmt} cats={cats} proofs={proofs} onSave={onSaveFormat} />}

      <div className="filters">
        <div className="search">
          <Search size={16} />
          <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L.search} />
        </div>
        <select className="field" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">{L.allMonths}</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <select className="field" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="new">{L.newest}</option>
          <option value="old">{L.oldest}</option>
        </select>
      </div>
      <div className="chips">
        <button className={`chip${cat === "all" ? " on" : ""}`} onClick={() => setCat("all")}>{L.all}</button>
        {cats.map((c) => (
          <button key={c.id} className={`chip${cat === c.id ? " on" : ""}`} onClick={() => setCat(c.id)}>{c.name}</button>
        ))}
      </div>
      <p className="resc">{L.found(total)}</p>

      <div className="folders">
        {shown.map(({ c, color, items }) => (
          <Folder
            key={c.id}
            L={L}
            cat={c}
            color={color}
            items={items}
            onOpen={() => onOpenFolder(c.id, filter)}
            onEdit={isAdmin ? () => onEditCat(c) : undefined}
            thumbs={thumbs}
            ensureThumbs={ensureThumbs}
          />
        ))}
        {isAdmin && cat === "all" && (
          <div className="fwrap">
            <button className="folder add" onClick={() => onEditCat({})}>
              <div className="f-back" />
              <div className="f-front"><FolderPlus size={18} /><b>{L.addCat}</b></div>
            </button>
          </div>
        )}
        {!shown.length && !(isAdmin && cat === "all") && <div className="empty">{L.emptyProofs}</div>}
      </div>
    </div>
  );
}

function FormatCard({ L, fmt, cats, proofs, onSave }) {
  const [draft, setDraft] = useState(fmt);
  const inputRef = useRef(null);
  useEffect(() => setDraft(fmt), [fmt]);

  const insertToken = (tok) => {
    const el = inputRef.current;
    const s = el && el.selectionStart != null ? el.selectionStart : draft.length;
    const e = el && el.selectionEnd != null ? el.selectionEnd : s;
    setDraft(draft.slice(0, s) + tok + draft.slice(e));
    requestAnimationFrame(() => {
      if (el) { el.focus(); el.setSelectionRange(s + tok.length, s + tok.length); }
    });
  };

  const nextSeq = proofs.reduce((m, p) => Math.max(m, Number(p.seq) || 0), 0) + 1;
  const example = autoNumber({ seq: nextSeq, date: new Date().toISOString(), cat: cats[0] ? cats[0].id : "" }, draft || DEFAULT_FORMAT, cats);
  const changed = draft.trim() !== fmt;

  return (
    <section className="fmtcard box">
      <h3>{L.fmtH}</h3>
      <p>{L.fmtHelp} {L.fmtNote}</p>
      <div className="fmtrow">
        <input ref={inputRef} className="field mono" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        <button className="btn pri" style={{ flex: "none" }} disabled={!changed} onClick={() => onSave(draft)}>{L.save}</button>
      </div>
      <div className="tokens">
        {FORMAT_TOKENS.map((k) => (
          <button key={k} className="tok" onClick={() => insertToken(`{${k}}`)}>{`{${k}}`}<small>{L.tk[k]}</small></button>
        ))}
      </div>
      <div className="example">{L.example}:<code>{example}</code></div>
    </section>
  );
}

function FolderViewer({ L, cat, color, items, fmt, cats, isAdmin, uploading, onUpload, onSaveNumber, onDelete, onView, onClose, thumbs, ensureThumbs }) {
  const [editing, setEditing] = useState(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const visible = items.slice(0, limit);
  const visKey = visible.map((p) => p.id).join(",");
  useEffect(() => { if (visKey) ensureThumbs(visKey.split(",")); }, [visKey, ensureThumbs]);
  const [val, setVal] = useState("");
  const cancelRef = useRef(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !editing) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onClose]);

  const startEdit = (p) => { cancelRef.current = false; setEditing(p.id); setVal(proofNumber(p, fmt, cats)); };
  const finishEdit = () => {
    if (!editing) return;
    if (!cancelRef.current) onSaveNumber(editing, val);
    setEditing(null);
  };

  return (
    <div className="overlay z60" onClick={onClose}>
      <div className="sheet wide box" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-h">
          <div>
            <h3>{cat.name}</h3>
            <div className="sub">{L.proofCount(items.length)}</div>
          </div>
          <button onClick={onClose} className="iconbtn" aria-label={L.close}><X size={16} /></button>
        </div>

        <div className="grid">
          {isAdmin && (
            <label className={`tile up${uploading ? " busy" : ""}`}>
              {uploading ? <Loader2 size={24} className="animate-spin" /> : <ImagePlus size={24} />}
              <span>{uploading ? L.uploading : L.upload}</span>
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={uploading}
                style={{ display: "none" }}
                onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ""; onUpload(files); }}
              />
            </label>
          )}
          {visible.map((p) => (
            <div key={p.id} className="tile" style={{ "--c": color }}>
              {thumbs[p.id]
                ? <img src={thumbs[p.id]} alt={proofNumber(p, fmt, cats)} onClick={() => onView(p)} />
                : <div className="ph" onClick={() => onView(p)}><Loader2 size={18} className="animate-spin" /></div>}
              {isAdmin && editing !== p.id && (
                <div className="tile-tools">
                  <button onClick={() => startEdit(p)} aria-label={L.editNo} title={L.editNo}><Pencil size={11} /></button>
                  <button className="del" onClick={() => onDelete(p)} aria-label={L.delete} title={L.delete}><Trash2 size={11} /></button>
                </div>
              )}
              <div className="lbl">
                {editing === p.id ? (
                  <input
                    autoFocus
                    value={val}
                    onChange={(e) => setVal(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onBlur={finishEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") { cancelRef.current = true; e.currentTarget.blur(); }
                    }}
                  />
                ) : (
                  <b>{proofNumber(p, fmt, cats)}{p.custom && <span className="cust">{L.manual}</span>}</b>
                )}
                <small>{formatDate(p.date, L.locale)}</small>
              </div>
            </div>
          ))}
        </div>
        {items.length > limit && (
          <button className="btn pri full loadmore" onClick={() => setLimit((l) => l + PAGE_SIZE)}>{L.loadMore(items.length - limit)}</button>
        )}
        {!items.length && !isAdmin && <div className="empty">{L.emptyFolder}</div>}
      </div>
    </div>
  );
}

function ImageLightbox({ L, proof, thumb, number, onClose }) {
  const [src, setSrc] = useState(thumb || "");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(thumb || ""); setLoading(true); setFailed(false);
    getDoc(proofImgRef(proof.id)).then((snap) => {
      if (!alive) return;
      if (snap.exists() && snap.data().img) setSrc(snap.data().img);
      else setFailed(true);
      setLoading(false);
    }).catch(() => { if (alive) { setFailed(true); setLoading(false); } });
    return () => { alive = false; };
  }, [proof.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="overlay z80" onClick={onClose}>
      <div className="sheet wide box lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-h" style={{ marginBottom: 10 }}>
          <div />
          <button onClick={onClose} className="iconbtn" aria-label={L.close}><X size={16} /></button>
        </div>
        {src ? <img src={src} alt={number} /> : <div className="empty"><Loader2 size={22} className="animate-spin" /></div>}
        <div className="cap">
          <b>{number}</b>
          <span>{loading ? <Loader2 size={13} className="animate-spin" /> : formatDate(proof.date, L.locale)}</span>
        </div>
        {failed && <p className="err">{L.imgFail}</p>}
      </div>
    </div>
  );
}

function CategoryEditor({ L, cat, count, nextColor, onClose, onSave, onDelete }) {
  const isNew = !cat.id;
  const [name, setName] = useState(cat.name || "");
  const [code, setCode] = useState(cat.code || "");
  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const canSave = name.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    const autoCode = name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "CAT";
    onSave({
      id: cat.id || uid(),
      name: name.trim(),
      code: cleanCode || autoCode,
      color: cat.color || nextColor,
    });
  };

  return (
    <Modal L={L} title={isNew ? L.newCat : L.editCat} onClose={onClose} narrow>
      <div className="stack">
        <Field label={L.catName}>
          <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        </Field>
        <Field label={L.catCode}>
          <input className="field mono" value={cleanCode} maxLength={6} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        </Field>
        <button className="btn pri full" disabled={!canSave} onClick={save}>{L.save}</button>
        {!isNew && (
          count > 0
            ? <div className="hint">{L.catNotEmpty}</div>
            : <button className="btn outline-red full" onClick={onDelete}><Trash2 size={14} /> {L.deleteCat}</button>
        )}
      </div>
    </Modal>
  );
}

// ---------------- REVIEWS ----------------

// Review text clamped to 4 lines; shows "Read more" only when it's actually cut off.
function ReviewText({ L, text, expanded, size = 14, onClampChange, onOpen, mb = 10 }) {
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
      <p ref={ref} className={`txt${expanded ? "" : " clamp"}`} style={{ fontSize: size }}>{text}</p>
      {!expanded && clamped && (
        <button className="more" style={{ fontSize: size - 1 }} onClick={(e) => { e.stopPropagation(); if (onOpen) onOpen(); }}>
          {L.readMore}
        </button>
      )}
    </div>
  );
}

function ReviewCard({ L, review, settings, canManage, myReaction, onEdit, onDelete, onReact, onOpen, expanded }) {
  const [clamped, setClamped] = useState(false);
  const clickable = !expanded && clamped;

  return (
    <div className={`rev box${expanded ? "" : " anim"}${clickable ? " click" : ""}`} onClick={clickable ? onOpen : undefined}>
      <div className="hd">
        <div style={{ minWidth: 0 }}>
          <div className="nm">{review.isAnonymous || !review.name ? L.anonymous : review.name}</div>
          <div className="dt">{formatDate(review.date, L.locale)}</div>
        </div>
        <StarRow value={review.rating} size={15} L={L} />
      </div>

      <ReviewText L={L} text={review.text} expanded={expanded} onClampChange={setClamped} onOpen={onOpen} />

      <div className="ft" onClick={(e) => e.stopPropagation()}>
        {settings.emojiEnabled ? (
          <div className="votes">
            <ReactionBtn icon={<ThumbsUp size={13} />} count={review.reactions?.agree || 0} active={myReaction === "agree"} color={POS} onClick={() => onReact("agree")} />
            <ReactionBtn icon={<ThumbsDown size={13} />} count={review.reactions?.disagree || 0} active={myReaction === "disagree"} color={NEG} onClick={() => onReact("disagree")} />
          </div>
        ) : <div />}

        {canManage && (
          <div className="tools">
            <button onClick={onEdit} className="iconbtn sm" title={L.edit} aria-label={L.edit}><Pencil size={13} /></button>
            <button onClick={onDelete} className="iconbtn sm danger" title={L.del} aria-label={L.del}><Trash2 size={13} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

// Overlay showing one review in full.
function ReviewDetail({ L, review, settings, canManage, myReaction, onClose, onEdit, onDelete, onReact }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; };
  }, []);

  return (
    <div className="overlay z60" onClick={onClose}>
      <div className="detail" onClick={(e) => e.stopPropagation()}>
        <div className="top">
          <button onClick={onClose} aria-label={L.close} className="iconbtn"><X size={16} /></button>
        </div>
        <div className="scroll">
          <ReviewCard
            expanded
            L={L}
            review={review}
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

function ReactionBtn({ icon, count, active, color, onClick }) {
  return (
    <button
      onClick={onClick}
      className="vote"
      style={active ? { borderColor: color, color, background: `${color}22` } : undefined}
    >
      {icon} {count}
    </button>
  );
}

// Shows partial stars (rounded to the nearest quarter). When interactive, tapping the left/right part of a star picks a partial rating.
function StarRow({ value, size = 16, interactive, onChange, L }) {
  const starSize = interactive ? size + 8 : size;
  const shown = Math.min(5, Math.max(0, Math.round((Number(value) || 0) * 4) / 4));
  return (
    <div className="stars">
      {[1, 2, 3, 4, 5].map((n) => {
        const frac = Math.min(1, Math.max(0, shown - (n - 1)));
        // the star glyph spans roughly x=2..22 of its 24-wide box, so map the fraction onto that
        const clip = frac >= 1 ? 100 : frac <= 0 ? 0 : ((2 + 20 * frac) / 24) * 100;
        const pick = (e) => {
          if (!interactive) return;
          if (e.detail === 0) { onChange(n); return; } // keyboard activation: whole star
          const rect = e.currentTarget.getBoundingClientRect();
          const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          const snapped = Math.ceil((n - 1 + x) / RATING_STEP - 1e-9) * RATING_STEP;
          onChange(Math.min(5, Math.max(RATING_STEP, snapped)));
        };
        return (
          <button
            key={n}
            type="button"
            disabled={!interactive}
            onClick={pick}
            aria-label={L ? L.starN(n) : `${n}`}
            style={{ cursor: interactive ? "pointer" : "default", width: starSize, height: starSize }}
          >
            <Star size={starSize} color={STAR_COLOR} fill="none" style={{ display: "block" }} />
            {clip > 0 && (
              <span style={{ width: `${clip}%` }}>
                <Star size={starSize} color={STAR_COLOR} fill={STAR_COLOR} style={{ display: "block" }} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------- WRITE REVIEW ----------------

function WriteReviewModal({ L, review, onClose, onSave, editingRef }) {
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
    <Modal L={L} title={isEditing ? L.editTitle : L.writeTitle} onClose={onClose}>
      <div className="stack" onFocus={() => (editingRef.current = true)} onBlur={() => (editingRef.current = false)}>
        <div style={{ textAlign: "center" }}>
          <StarRow value={rating} size={22} interactive onChange={setRating} L={L} />
          <div className="hint" style={{ marginTop: 6 }}>
            <b style={{ color: "var(--ink)" }}>{fmtRating(rating)} / 5</b> · {L.ratingHint}
          </div>
        </div>

        <div className="seg">
          <button onClick={() => setIsAnonymous(false)} className={!isAnonymous ? "on" : ""}>{L.useName}</button>
          <button onClick={() => setIsAnonymous(true)} className={isAnonymous ? "on" : ""}>{L.postAnon}</button>
        </div>

        {!isAnonymous && (
          <Field label={L.nameLabel}>
            <input value={name} onChange={(e) => setName(e.target.value)} className="field" placeholder={L.namePh} />
          </Field>
        )}

        <Field label={L.reviewLabel}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} className="field" style={{ resize: "vertical" }} placeholder={L.reviewPh} />
        </Field>

        <button onClick={handleSave} disabled={!text.trim()} className="btn pri full">
          {isEditing ? L.saveChanges : L.post}
        </button>
      </div>
    </Modal>
  );
}

// ---------------- PROFILE (visitor + admin) ----------------

function Profile({ L, reviews, settings, isAdmin, myReviewIds, onEdit, onDelete, onLoginClick, onLogout, onToggleEmoji, data, persist, flashToast, onOpen }) {
  const myReviews = reviews.filter((r) => myReviewIds.includes(r.id));

  return (
    <div>
      <div className="prof">
        <div className="avatar"><User size={22} /></div>
        <div>
          <div className="nm">{isAdmin ? L.admin : L.yourProfile}</div>
          <div className="hint">{L.fromDevice(myReviews.length)}</div>
        </div>
      </div>

      {!isAdmin ? (
        <button onClick={onLoginClick} className="btn ghost full" style={{ marginBottom: 20 }}>
          <Lock size={14} /> {L.loginAdmin}
        </button>
      ) : (
        <AdminPanel L={L} settings={settings} onToggleEmoji={onToggleEmoji} data={data} persist={persist} flashToast={flashToast} onLogout={onLogout} />
      )}

      <div className="month"><span>{L.yourReviews}</span><span /></div>
      {myReviews.length === 0 ? (
        <div className="empty">{L.noMine}</div>
      ) : (
        <div className="revs">
          {myReviews.map((r) => (
            <MyReviewRow key={r.id} L={L} r={r} onEdit={() => onEdit(r)} onDelete={() => onDelete(r.id)} onOpen={() => onOpen(r.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MyReviewRow({ L, r, onEdit, onDelete, onOpen }) {
  const [clamped, setClamped] = useState(false);
  return (
    <div className={`myrev box${clamped ? " rev click" : ""}`} onClick={clamped ? onOpen : undefined}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <StarRow value={r.rating} size={13} L={L} />
        <div className="tools" onClick={(e) => e.stopPropagation()}>
          <button onClick={onEdit} className="iconbtn sm" aria-label={L.edit}><Pencil size={13} /></button>
          <button onClick={onDelete} className="iconbtn sm danger" aria-label={L.del}><Trash2 size={13} /></button>
        </div>
      </div>
      <ReviewText L={L} text={r.text} size={13} mb={4} onClampChange={setClamped} onOpen={onOpen} />
      <div className="hint" style={{ fontSize: 10.5, marginTop: 4 }}>{formatDate(r.date, L.locale)}</div>
    </div>
  );
}

function AdminPanel({ L, settings, onToggleEmoji, data, persist, flashToast, onLogout }) {
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
    flashToast(L.tExported);
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
          const name = String(lower.name || "");
          return {
            id: uid(),
            name: name.toLowerCase() === "anonymous" ? "" : name,
            isAnonymous: !name || name.toLowerCase() === "anonymous",
            rating: Math.min(5, Math.max(RATING_STEP, Math.round((parseFloat(lower.rating) || 5) / RATING_STEP) * RATING_STEP)),
            text: lower.review || lower.text || "",
            date: lower.date ? new Date(lower.date).toISOString() : new Date().toISOString(),
            reactions: { agree: parseInt(lower.agree, 10) || 0, disagree: parseInt(lower.disagree, 10) || 0 },
          };
        }).filter((r) => r.text);
        persist({ ...data, reviews: [...newReviews, ...data.reviews] });
        flashToast(L.tImported(newReviews.length));
      } catch (err) { flashToast(L.tReadFail); }
      finally { setImportBusy(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
    };
    reader.readAsArrayBuffer(file);
  };

  const changePassword = async () => {
    if (!newPw.trim()) return;
    try {
      await setDoc(AUTH_DOC_REF, { password: newPw.trim() }, { merge: true });
      flashToast(L.tPwUpdated);
      setNewPw("");
    } catch (e) { flashToast(L.tPwFail); }
  };

  return (
    <div className="panel box">
      <div className="panel-h"><SettingsIcon size={13} /> {L.adminSettings}</div>

      <div className="setrow">
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800 }}>{L.emoji}</div>
          <div className="hint" style={{ fontSize: 11 }}>{L.emojiP}</div>
        </div>
        <button onClick={onToggleEmoji} className={`toggle${settings.emojiEnabled ? " on" : ""}`} aria-pressed={!!settings.emojiEnabled} aria-label={L.emoji}><i /></button>
      </div>

      <div className="stack" style={{ gap: 8, marginBottom: 14 }}>
        <button onClick={exportExcel} className="btn ghost"><Download size={14} /> {L.exportX}</button>
        <button onClick={() => fileInputRef.current && fileInputRef.current.click()} className="btn ghost">
          {importBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {L.importX}
        </button>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={importExcel} style={{ display: "none" }} />
      </div>

      <div className="divider">
        <div className="hint" style={{ fontSize: 11.5, marginBottom: 6 }}>{L.changePw}</div>
        <div className="row2">
          <input type="text" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder={L.newPw} className="field" style={{ flex: 1 }} />
          <button onClick={changePassword} className="btn pri" style={{ flex: "none" }}>{L.save}</button>
        </div>
      </div>

      <button onClick={onLogout} className="btn outline-red full">
        <Unlock size={14} /> {L.logout}
      </button>
    </div>
  );
}

// ---------------- shared UI helpers ----------------

function Modal({ L, children, onClose, title, narrow }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className={`sheet box${narrow ? " narrow" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-h">
          <h3>{title}</h3>
          <button onClick={onClose} className="iconbtn" aria-label={L ? L.close : "Close"}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ L, title, message, confirmLabel, danger, onConfirm, onCancel }) {
  useEffect(() => {
    // capture phase so Esc closes only this dialog, not the overlay underneath
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="overlay z70" onClick={onCancel}>
      <div className="sheet narrow box" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-h"><h3>{title}</h3></div>
        <p className="hint" style={{ fontSize: 13.5, margin: "0 0 18px", lineHeight: 1.5 }}>{message}</p>
        <div className="row2">
          <button onClick={onCancel} className="btn">{L.cancel}</button>
          <button onClick={onConfirm} autoFocus className={`btn ${danger ? "red" : "pri"}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="flabel">{label}</label>
      {children}
    </div>
  );
}
