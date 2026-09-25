# Testimonials — Public Review Wall

A public reviews page: visitors write star-rated reviews (named or anonymous), see them laid out as a wall, and can edit/delete their own from the same device. A "grade report" header shows the average rating and a per-star breakdown. Admins can moderate, toggle reactions on/off, and import/export via Excel.

Shares the same Firebase project as your pricelist and nota apps, and the same admin password — no separate login to manage.

## 1. Set up

Use the **same Firebase project** as your other apps. Update Firestore rules to add the `testi` collection:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /pricelist/main { allow read: if true; allow write: if true; }
    match /pricelist/guides { allow read: if true; allow write: if true; }
    match /nota/data { allow read: if true; allow write: if true; }
    match /testi/data { allow read: if true; allow write: if true; }
  }
}
```

Same caveat as before: this is a convenience lock via the app's own password screen, not real authentication.

## 2. Configure and run

```bash
cp .env.example .env
```
Paste in the same six Firebase values you're already using for pricelist/nota.

```bash
npm install
npm run dev
```

## 3. Deploy

Same pattern as your other sites: push to its own GitHub repo, connect a new Cloudflare Pages/Workers project (build command `npm run build`, output `dist`), add the same six `VITE_FIREBASE_*` environment variables, then add a custom domain — e.g. `testi.xiao-qi.my.id` — from that project's Domains tab.

## How it works

- **Writing a review**: tap the ➕ in the bottom nav. Choose "Use a name" (any name, real or fake) or "Post anonymously," pick a star rating, write the text, post.
- **Editing/deleting your own**: the app remembers which reviews came from your device (via browser storage, not an account). Your own reviews show edit/delete buttons on the wall, and are also listed under Profile with a count of how many you've posted. Clearing your browser data will forget this — there's no server-side account tied to it.
- **Reactions**: 👍/👎 buttons let other visitors agree/disagree with a review. Each device can only react once per review (togglable, and switching your vote removes the old one). Admin can turn this feature off entirely from Profile → Admin settings.
- **Admin**: tap Profile → "Log in as admin" (same password as your pricelist/nota sites). From there: toggle reactions on/off, export all reviews to Excel, import reviews from Excel/CSV, edit or delete *any* review (not just your own), and change the shared admin password.
- **Grade report**: the average rating, total count, and a 5-star-down-to-1-star breakdown bar are always computed live from whatever reviews currently exist — no manual entry.
- **Home nav button**: currently points to `https://home.xiao-qi.my.id`, a placeholder for a future hub site that doesn't exist yet. Once you build that site, this link will just work — no code change needed here unless you want a different URL, in which case update the `HOME_URL` constant near the top of `src/App.jsx`.

## Import format

Excel/CSV columns (case-insensitive): `Date`, `Name` (blank or "Anonymous" for anonymous), `Rating` (1–5), `Review`, `Agree`, `Disagree`. Imported reviews are added to the existing list, not replacing it.
