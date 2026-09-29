# APEX AUTH - KeyAuth style panel + loader control

Apne **loader** ke liye complete authentication & licensing website:
license keys, customer accounts, aur sabse zaroori —
**loader ko online / offline / maintenance me ek click se switch karna.**

Built with **Node.js + Express + SQLite** (zero native dependencies, `node:sqlite` built-in).

---

## ⚡ Quick start (Windows)

```bat
start.bat
```

ya manually:

```bat
npm install
npm start
```

| URL | Kya hai |
|-----|---------|
| `http://localhost:3000/` | Landing page (hero + status) |
| `http://localhost:3000/login.html` | Sign in / Register (Admin · Reseller · Client tabs) |
| `http://localhost:3000/app.html` | Console (Dashboard, Loaders, Customers, Licenses…) |
| `http://localhost:3000/api/public/status` | Public status API |

**Default admin:** `admin` / `admin123`
(first boot par console me bhi print hota hai — login ke baad turant change karein:
Settings → Account Security)

> Pehli baar Node chahiye: https://nodejs.org (LTS). `package.json` ke according Node ≥ 22.5.

---

## 👥 Accounts & roles (3 tabs)

Login page par 3 tabs hain — har tab sirf apni role ka account accept karta hai
(galat tab par login karoge to error aayega):

| Tab | Role | Kya kar sakta hai |
|-----|------|-------------------|
| 🛡 **Admin** (owner) | `admin` | Loaders (online/offline/maintenance), Customers, Licenses, Activity Log, site Settings |
| 🤝 **Reseller (sub-user)** | `reseller` | Dashboard, **Customers**, **Licenses** (key generator + products), apna Settings — loader control, logs aur site settings **nahi** |
| 👤 **Client** | `user` | Sirf apna Dashboard, Licenses (subscription/HWID reset) aur Account Security |

* **Registration** sirf **Client** account banata hai — "Create one →" sirf Client tab par
  dikhta hai (signup band ho to `Settings → Sign-ups` se khol dein).
* **Reseller / Admin accounts admin panel se bante hain:**
  Console → **Customers → ＋ Add User → Role: Reseller (sub-user)**.
* Reseller clients ko bana sakta hai, lekin doosra reseller/admin **nahi** bana sakta
  (server par check), aur destructive bulk actions (`Ban All`, `Purge Users`) admin-only hain.

---

## 🎛 Loader control — online / offline / maintenance

Console → **Loaders** har loader card par 3-way switch:

| State | Effect on the loader |
|-------|----------------------|
| 🟢 **online** | Login + key activation chalta hai |
| 🔴 **offline** | API `{"code":"OFFLINE"}` return karta hai — loader login block |
| 🟡 **maintenance** | API `{"code":"MAINTENANCE", "error":"<aapka message>", "until":…}` — loader apna maintenance screen dikhata hai |

Maintenance enable karte waqt **message + duration** (15 min → 24h ya manual) set hota hai,
jo seedha loader ko bheja jata hai. Dashboard par live banner bhi dikhta hai.
Har switch ka entry **Activity Log** me save hota hai.

---

## 🔑 License keys

Console → **Licenses**

* **Key Generator** — **Product** (Internal / External / Silent Aim / Silent Cover),
  plan (Daily/Weekly/Monthly/Quarterly/Yearly/Lifetime),
  key **prefix** (`APEX-XXXX-XXXX-XXXX`), custom key, quantity (max 100),
  **user limit** (single account / unlimited)
* **Products bar** — har loader ke liye default 4 products seed hote hain;
  wahan se naya product add / remove kar sakte hain (naya loader banate hi bhi mil jaate hain).
  Har product ko **apna app id (`prd_xxx`) · secret · version** milta hai
* Table — search, status filters (All/Active/Unused/Expired/Revoked),
  loader filter **+ product filter**, Product column (product · loader),
  per-key actions: copy · reset HWID · pause/resume · delete, **Export CSV** (product column ke saath)
* **Bulk operations** — Reset All HWIDs · Pause All · Resume All · Delete Unused · Purge All Keys

Customers page — accounts, ban/unban, subscription days add, HWID reset, password reset,
bulk actions (Reset HWIDs / Unban / Ban / Purge).

---

## 🔌 Loader API (C++ ke liye)

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/api/loader/init` | `{app, version}` | app status, version, maintenance message, `update_available` |
| POST | `/api/loader/login` | `{app, username, password, hwid}` | `{token, user, license}` |
| POST | `/api/loader/activate` | `{app, key, hwid}` (+ optional `Bearer <token>`) | bound license (`guest:true` = bina login) |
| POST | `/api/loader/reset-hwid` | `{app, key}` ya (+ token) | HWID hata deta hai (dobara activate chalega) |
| POST | `/api/loader/ping` | `{app}` (+ token) | heartbeat |
| POST | `/api/loader/logout` | `{}` | logout |
| GET | `/api/public/status?app=apex` | — | public status (landing page bhi yahi use karti hai) |

Maintenance/offline ke waqt **sirf** `/api/loader/init` aur `/api/public/status` chalte hain —
baaki sab `503` + `code` return karta hai.

### 🔐 Loader credentials — app id · secret · version

Console → **Loaders → "Loader Credentials"** panel har loader ki ye values dikhata hai
(KeyAuth wale `app name / ownerid / secret / version` jaisa):

| Field | Kya hai | Loader me kahan |
|-------|---------|-----------------|
| **App name / slug** | loader ka API naam (`apex`) | `Client(base, "apex")` |
| **App ID (user id)** | `app_xxxxxxxx` — har loader ka unique id | header/payload me (abhi informational) |
| **Secret** | 48-char hex — API key | `x-api-key` header |
| **Version** | loader version (`1.0.0`) | panel ko batata hai (`update_available`) |

* Buttons: **Copy all**, **Copy C++ snippet**, **♻ Regenerate secret** (purana turant band).
* Checkbox **"Require API secret"** on karte hi har loader call par `x-api-key` verify hota hai —
  galat/missing par `403 {"code":"BAD_SECRET"}`. **Default OFF** hai, isliye purana loader
  bina secret ke chalta rahega.
* Secret **public API me kabhi nahi jata** (`/api/public/status` me `app_key` hai, secret nahi) —
  sirf admin panel me dikhta hai.

**Product-level credentials (sab product ke liye alag)** — panel ke **Product Credentials**
panel me har product (Internal / External / Silent Aim / Silent Cover) ki apni values hoti hain:
`app id (prd_xxx)`, apna **secret**, **version**. Loader har call me apna product bhejta hai —
`{"product":"Internal"}` (id / naam / slug, teeno chalte hain) — phir **sirf us product ka**
secret verify hota hai, baaki product bina secret ke chalte rahenge. Isse per-build lock ban jaata
hai: jaise External wali build Internal par chal hi nahi sakti.

* Checkbox **"Require API secret"** product ke liye bhi hai (default OFF).
* Product secret sirf **admin** ko milta hai — reseller ke `/api/admin/products` response me
  `secret` field hi nahi hota, aur wo usse PATCH bhi nahi kar sakta (`403 Admin only`).

### 🔔 Discord realtime audit — sirf **key use** par embed

**Site Settings → "Discord webhook — realtime audit"** me webhook URL paste karein
(Discord → channel ⚙ → Integrations → Webhooks → New webhook → Copy URL) aur
**🔔 Send test** dabayein. Uske baad jab bhi koi **key use** hogi, channel me ye embed aayega
(**login par nahi** — sirf key redeem/activate hone par):

| Field | Kahan se aata hai |
|-------|-------------------|
| 👤 User | account username (login ke saath) ya key ka owner / `guest` |
| 🧩 Product | key ka product (Internal / External …), warna loader naam |
| 💳 Plan | key plan (Monthly / Lifetime) |
| 🌐 IP Address | client ka asli IP |
| 📍 Location | `🇮🇳 Jamnagar, Gujarat, India` — ipwho.is se (1 ghante cache) |
| 🔑 HWID | chhota format `6bf680…1733` |
| 💻 Client | loader User-Agent → `Windows Loader` |
| ⏳ Expires | `in a month (2026-10-27)` / `Lifetime` / `Expired` |
| ✅ Status | `Authorized` |
| 🎟 License Key | masked — `PolarX-****-****-****-5998` |

* Admin kisi user ko delete kare to **laal** embed `Account Removed` jaata hai
  (user + kitne keys, removed by, IP, location).
* **Loader aur panel ek hi machine par ho** (localhost / `::1`) to IP field me aapki
  **public IP** (IPv4, nahi mila to IPv6) aur uska location aata hai — kyunki client
  wahi machine hai. Panel VPS par ho to har client ka asli IP + city aayega.
* Sirf **key redeem/activate** par embed jaata hai — loader login par nahi.
* Test endpoint: `POST /api/admin/settings/test-webhook` (admin) — sample embed bhejta hai.
* Nginx/reverse proxy ke peeche ho to `TRUST_PROXY=1` set karein, warna IP proxy ka dikhega.
* Webhook URL sirf admin GET/PUT settings me rehta hai — public API me kabhi nahi.

### C++ integration

`integration/` folder:

* **`apex_auth.h`** — header-only, dependency-free (WinHTTP), C++17.
  Functions: `Status()`, `Login()`, `Activate()`, `Ping()`, `Logout()`, `hwid()`
  (MachineGuid se machine fingerprint). MSVC ke liye `winhttp.lib`/`advapi32.lib`
  `#pragma comment` se auto-link hote hain. Secret ho to `x-api-key` khud bhej deta hai.
* **`example_usage.cpp`** — poora flow (boot check → login → key redeem → heartbeat)
  aur ImGui snippet jo maintenance message dikhakar login block karta hai.

```cpp
#define VERSION_STRING "1.0.0"
#define APP_SECRET     ""     // panel → Loaders → Credentials (require on ho to)
#define APP_PRODUCT    ""     // panel → Product Credentials (jaise "Internal")
#include "apex_auth.h"

apex::Client auth("https://your-panel.com", "apex", APP_SECRET, APP_PRODUCT);

std::string state, msg, ver, err;
if (!auth.Status(state, msg, ver)) {      // offline / maintenance
    ShowMaintenanceScreen(msg);           // panel ka message dikhao
    return;
}
if (auth.Login(user, pass, apex::hwid(), err)) {
    auth.Activate(licenseKey, apex::hwid(), err);
}
```

> `apex` = loader ka **slug** (Console → Loaders card par likha hota hai).
> Header ko VS me compile karke verify kiya gaya hai (C++17).

### ♻ AdiAuth / KeyAuth wala purana loader — bina code badle

Agar aapka loader pehle se `AdiAuth::KeyAuthApp` use karta hai, to uska `AdiAuth.hpp`
**drop-in** replace kar dein — saath `apex_auth.h` bhi usi folder me rakhna hai.
Purana file `AdiAuth.adiauth.bak.hpp` naam se backup rehta hai.

```cpp
// (1) slug   (2) product   (3) secret   (4) version   (5) panel base URL (bina /api)
AdiAuth::KeyAuthApp* auth = new AdiAuth::KeyAuthApp(
    "apex", "Internal",
    "b9b6602b…", "1.0.0", "https://aapka-panel.com");
```

* `auth->init() / login() / reg() / license() / validate() / logout() / ResetHWID()` —
  sab waise hi rehte hain (`last_error`, `authenticated`, `user.*`, `app.version`,
  `app.download` bhi milta hai).
* `license(key)` **bina login ke** chalta hai (key-only loader) — panel unclaimed key par
  machine bind kar deta hai; account se judi key par `401 Login first` aata hai.
* arg1/arg2 ka order matter **nahi**: galat diya to panel `404` deta hai aur header
  khud swap karke dobara try karta hai.
* Verified: MSVC `/std:c++17` compile + live probe (init / auto-swap / bad slug /
  bad secret / guest activate / wrong key / ResetHWID) sab pass.

---

## 🎮 ApexLoader — apne loader ko panel se connect karna

`New folder (10)` wala loader (**ApexLoader.exe**) ab **APEX AUTH panel se juda hai** —
`apex_auth.h` usi folder me pada hai aur `main.cpp` me `#include "apex_auth.h"` hai.

**Flow (INJECT button dabne par):**

1. `/api/loader/init` → panel status + version (startup par ek baar bhi check hota hai)
2. `/api/loader/activate` → key verify + HWID bind — **yahi se Discord audit embed jaata hai**
3. verify **OK** → apne aap inject chalta hai · galat key → red message, inject band

**Loader ke 4 constant** (`main.cpp` → `APEX AUTH` block, globals ke paas):

```cpp
static const char* kPanelUrl = "http://localhost:3000";  // VPS par https://your-panel.com
static const char* kPanelApp = "apex";                  // Console → Loaders → slug
static const char* kPanelSec = "b9b6602b…";              // Console → Loader → App Secret
static const char* kPanelVer = "1.0.0";
```

**Product mapping** (loader index → panel product):
`0 EXTERNAL → External` · `1 INTERNAL → Internal` · `2 SILENT AIM → Silent Aim` ·
`3 SILENT COVER → Silent Cover`

**UI:** license field ke neeche status line aata hai —
`key verify ho raha hai...` (amber) → `key verified - Internal ready` (green),
ya panel ka error laal me (`Key not found` / `Key expired` / `Key is bound to another HWID`).
Button: `VERIFY KEY` → `VERIFYING KEY...` → `INJECT`.

> Verified: MSBuild `Release|x64` → `Build\ApexLoader.exe` · native probe (init ok /
> hwid / activate ok / wrong key rejected) pass · exe startup par panel ko init bhejta hai.

---

## 🚀 Deploy (VPS)

```bash
# 1. Node 22+ install karein, phir
git clone <repo> && cd apex-auth
npm install
ADMIN_PASSWORD='Strong-Password-Here' PORT=3000 pm2 start server.js --name apexauth

# 2. Nginx reverse proxy (HTTPS zaroori hai — loader ko mixed-content se bachane ke liye)
```

* Database: `data/panel.db` (WAL mode) — backup ke liye yahi file copy kar lein.
* Env vars: `PORT` (default `3000`), `ADMIN_PASSWORD` (sirf **first boot** par kaam karta hai).
* Render / Railway / any Node host par bhi chalta hai (persistent disk par `data/` rakhein).

---

## 🗂 Structure

```
apex-auth/
├─ server.js            # Express app + saari APIs
├─ webhook.js           # Discord realtime audit (key use / login / delete embeds)
├─ db.js                # SQLite schema, seed (products), hashing, key generator
├─ package.json
├─ data/panel.db        # database (auto-create)
├─ public/
│  ├─ index.html        # landing
│  ├─ login.html        # sign in / register (Admin | Reseller | Client)
│  ├─ app.html          # console (SPA)
│  ├─ 404.html
│  └─ assets/css|js
├─ test/
│  ├─ smoke.js          # 56 checks — loader switch, credentials, keys, guest flow, webhook, bulk
│  └─ role-check.js     # 29 checks — reseller role + product secrets + register
└─ integration/
   ├─ apex_auth.h      # C++ client (WinHTTP)
   └─ example_usage.cpp
```

## ✅ Tests (non-destructive — apna data chhute nahi)

```bat
:: server chalu hona chahiye; admin password env me dein
set SMOKE_ADMIN=admin
set ADMIN_PASSWORD=aapka_password
node test\smoke.js
node test\role-check.js
```

Dono test apna temporary loader / user / product / key banate hain aur khatam kar dete hain.

## 🔐 Security notes

* Passwords: `scrypt` + random salt, sessions: 32-byte random tokens (DB me).
* Rate limiting on login/register/activate endpoints.
* SQL: sab queries parameterized.
* Role-based access: client ko staff API `403`, reseller ko loaders/logs/site settings `403`.
* Loader app secret: sirf admin endpoint me, public API me kabhi nahi; "Require API secret" on ho to galat key par `403 BAD_SECRET`.
* Panel ko **HTTPS** ke peeche rakhein aur default admin password badal lein.
