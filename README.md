# FileSplit 🗂️

Dosyalarınızı güvenle yükleyin, saklayın ve paylaşın. Büyük dosyalar otomatik olarak parçalara bölünür; WebSocket üzerinden gerçek zamanlı indirme sunulur. Kullanıcı başına depolama kotası ve admin paneli ile tam kontrol sizin elinizde.

---

## Özellikler

- **Parçalı yükleme** — Dosyalar 1 MB'lık chunk'lara bölünür; SHA-256 bütünlük kontrolü yapılır
- **Gerçek zamanlı indirme** — WebSocket sinyalizasyonu üzerinden P2P-tarzı hızlı indirme
- **Şifreli dosyalar** — Dosyaya opsiyonel parola (bcrypt hash ile saklanır)
- **TTL / Otomatik silme** — Dosyalar için son kullanma tarihi (1s · 24s · 7g · 30g)
- **Sürüm yönetimi** — Aynı dosyanın birden fazla versiyonunu saklayın ve gruplayın
- **Klasörler** — Dosyalarınızı klasörlere düzenleyin
- **Depolama paneli** — Kullanılan/toplam alan, maks. dosya boyutu görsel çubukla gösterilir
- **Per-user limitler** — Her kullanıcıya ayrı depolama kotası ve dosya boyutu limiti atanabilir
- **Admin paneli** — Yöneticiler `/admin` sayfasından tüm kullanıcı limitlerini yönetir
- **Firebase arka ucu** — Kullanıcı ve limit verisi Firebase Realtime Database'de saklanır; yerel JSON fallback mevcuttur
- **JS embed snippet** — Harici sitelere indirme butonu ekleme

---

## Ekran Görüntüleri

| Yükle | Kütüphane | Admin Paneli |
|-------|-----------|-------------|
| Sürükle-bırak yükleme arayüzü | Depolama paneli + dosya listesi | Per-user limit yönetimi |

---

## Teknoloji Yığını

| Katman | Teknoloji |
|--------|-----------|
| **İstemci** | React 19, Vite 7, TailwindCSS 4, shadcn/ui, Framer Motion, Wouter, TanStack Query |
| **Sunucu** | Node.js 22+, Express 5, TypeScript |
| **Gerçek zamanlı** | WebSocket (`ws`) — sinyalizasyon + P2P indirme |
| **Veritabanı** | Firebase Realtime Database (Admin SDK) + yerel JSON fallback |
| **Auth** | Session-based (`express-session`), bcrypt (cost 12) şifre hash |
| **Güvenlik** | Helmet, express-rate-limit, UUID path validation, IP hash loglama |
| **Build** | esbuild (sunucu), Vite (istemci) |

---

## Kurulum

### 1. Gereksinimler

- Node.js 22+
- npm

### 2. Repoyu klonlayın

```bash
git clone https://github.com/KULLANICI/filesplit.git
cd filesplit
npm install
```

### 3. Ortam değişkenlerini ayarlayın

`.env` dosyası oluşturun:

```env
# Oturum güvenliği — rastgele ve uzun bir dize seçin (zorunlu)
SESSION_SECRET=cok-gizli-bir-anahtar-buraya

# Sunucu portu (varsayılan: 5000)
PORT=5000

NODE_ENV=development

# Production'da ZORUNLU — izin verilen kaynak(lar)
# ALLOWED_ORIGINS=https://siteniz.com

# ──────────────────────────────────────────────
# Depolama limitleri (tümü opsiyonel)
# ──────────────────────────────────────────────
MAX_FILE_SIZE_MB=500        # Dosya başına maks. boyut (varsayılan: 500 MB)
MAX_USER_STORAGE_MB=5000    # Kullanıcı başına toplam kota (varsayılan: 5 GB)
CHUNK_SIZE_MB=1             # Her parçanın boyutu (varsayılan: 1 MB, maks: 100 MB)

# ──────────────────────────────────────────────
# Admin erişimi
# ──────────────────────────────────────────────
# Yönetici kullanıcı UUID'lerini virgülle ayırarak girin.
# Boş bırakırsanız hiç kimse admin olamaz (fail-secure).
ADMIN_USER_IDS=

# ──────────────────────────────────────────────
# Firebase (opsiyonel — yoksa yerel JSON kullanılır)
# ──────────────────────────────────────────────
# FIREBASE_PROJECT_ID=
# FIREBASE_CLIENT_EMAIL=
# FIREBASE_PRIVATE_KEY=
# FIREBASE_DATABASE_URL=
```

> `.env` dosyası `npm run dev` ve `npm start` tarafından Node.js'in yerleşik `process.loadEnvFile()` özelliği ile otomatik yüklenir — ek paket gerekmez.

### 4. Geliştirme modunda çalıştırın

```bash
npm run dev
```

- İstemci → `http://localhost:5173`
- Sunucu → `http://localhost:5000`

### 5. Production build

```bash
npm run build
npm start
```

---

## Firebase Kurulumu (opsiyonel)

Firebase kurulmadan uygulama sorunsuz çalışır — kullanıcılar `uploads/_users.json` dosyasına kaydedilir. Firebase eklemek istiyorsanız:

1. [Firebase Console](https://console.firebase.google.com/)'da proje oluşturun.
2. **Realtime Database** → **Create Database**.
3. **Proje Ayarları → Service Accounts → Generate new private key** ile JSON indirin.
4. JSON'daki değerleri `.env` dosyanıza ekleyin:

```env
FIREBASE_PROJECT_ID=proje-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@proje-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://proje-id-default-rtdb.firebaseio.com
```

5. Güvenlik kurallarını deploy edin (önerilir):

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only database
```

> **Önemli:** Servis hesabı JSON dosyasını **asla** repoya commit etmeyin.

### Yerel'den Firebase'e geçiş

Daha önce yerel modda çalıştırıp gerçek kullanıcı biriktirdiyseniz, FIREBASE_* değişkenlerini eklemeden **önce** migration aracını çalıştırın. Aksi hâlde yerel kullanıcılar Firebase'de görünmez ve biri aynı kullanıcı adıyla farklı bir hesap kaydedebilir.

```bash
npm run migrate:users
```

Script idempotenttir — güvenle tekrar çalıştırılabilir.

---

## Admin Paneli

Bir kullanıcıya admin yetkisi vermek için UUID'sini `.env` dosyasına ekleyin:

```env
ADMIN_USER_IDS=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

UUID'yi bulmak için:
- **Yerel mod:** `uploads/_users.json` dosyasına bakın
- **Firebase modu:** Firebase Console → Realtime Database → `users/` node'u

Admin kullanıcı giriş yaptığında navbar'da **Admin** bağlantısı görünür. `/admin` sayfasından:

| İşlem | Açıklama |
|-------|----------|
| Kullanıcı listesi | Her kullanıcının kullandığı alan ve mevcut limitleri |
| Depolama kotası | Kullanıcı başına toplam alan sınırı (MB) |
| Maks. dosya boyutu | Kullanıcı başına tek dosya sınırı (MB) |
| Varsayılana dön | Özel limiti kaldır, sunucu varsayılanına dön |

---

## Deploy

### Fly.io

```bash
fly launch
fly secrets set SESSION_SECRET=$(openssl rand -hex 32)
fly volumes create filesplit_data --region fra --size 5
fly deploy
```

### Railway

`railway.toml` mevcut — Railway dashboard'dan `SESSION_SECRET` ekleyin, otomatik deploy olur.

### Render

`render.yaml` mevcut — "New Blueprint" ile yükleyin. `SESSION_SECRET` otomatik oluşturulur.

---

## API Referansı

### Auth

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `POST` | `/auth/register` | Yeni kullanıcı kaydı |
| `POST` | `/auth/login` | Giriş |
| `POST` | `/auth/logout` | Çıkış |
| `GET` | `/auth/me` | Oturum bilgisi (`id`, `username`, `isAdmin`) |

### Dosyalar

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `POST` | `/api/upload` | Tek parçalı yükleme |
| `POST` | `/api/upload-init` | Çok parçalı yükleme başlat |
| `POST` | `/api/upload-part` | Parça yükle |
| `POST` | `/api/upload-finish` | Yüklemeyi tamamla |
| `GET` | `/api/files` | Dosya listesi |
| `GET` | `/api/files/:id` | Dosya meta verisi |
| `DELETE` | `/api/files/:id` | Dosya sil |
| `GET` | `/api/user/storage` | Depolama kullanımı + limitler |

### Klasörler

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `GET` | `/api/folders` | Klasör listesi |
| `POST` | `/api/folders` | Klasör oluştur |
| `DELETE` | `/api/folders/:id` | Klasör sil |

### Admin

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `GET` | `/api/admin/users` | Tüm kullanıcılar + kullanım + limitler |
| `PATCH` | `/api/admin/users/:id/limits` | Kullanıcı limitini güncelle |
| `DELETE` | `/api/admin/users/:id/limits` | Limiti varsayılana döndür |
| `GET` | `/api/admin/defaults` | Sunucu varsayılan limitleri |

### Diğer

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `GET` | `/api/health` | Sağlık kontrolü |
| `WS` | `/ws` | Gerçek zamanlı P2P sinyalizasyon |

---

## Güvenlik

| Konu | Uygulama |
|------|----------|
| Path traversal | Tüm `fileId` / `folderId` değerleri UUID regex + `path.resolve` containment-check ile doğrulanır |
| HTTP başlıkları | **Helmet.js** — CSP, HSTS, X-Frame-Options vb. |
| Rate limiting | **express-rate-limit** — tüm endpointlerde |
| WebSocket koruması | Bağlantı başına mesaj boyutu (64 KB) ve hız (120 mesaj/dk) sınırı |
| IP loglama | Ham IP adresi yerine SHA-256 hash'inin ilk 8 karakteri loglanır (GDPR Art.5) |
| Admin erişimi | `ADMIN_USER_IDS` boşsa hiç kimseye admin yetkisi verilmez (fail-secure) |
| Şifreler | bcrypt cost 12 ile hashlenir; hiçbir zaman plaintext saklanmaz |
| Firebase | Tarayıcıya Firebase kimlik bilgisi hiç gönderilmez; Admin SDK yalnızca sunucu tarafında |

---

## Proje Yapısı

```
filesplit/
├── client/                        # React + Vite istemci
│   └── src/
│       ├── components/
│       │   ├── layout.tsx          # Navbar (admin linki dahil)
│       │   └── ui/                 # shadcn/ui bileşenleri
│       ├── hooks/
│       │   └── use-auth.tsx        # Auth context
│       └── pages/
│           ├── upload.tsx          # Dosya yükleme sayfası
│           ├── file-list.tsx       # Kütüphane + depolama paneli
│           ├── file-detail.tsx     # Dosya detay / indirme
│           ├── admin.tsx           # Admin paneli
│           ├── login.tsx
│           └── register.tsx
├── server/
│   └── src/
│       ├── lib/
│       │   ├── fileStore.ts        # Dosya/klasör depolama (disk)
│       │   ├── userStore.ts        # Kullanıcı yönetimi + per-user limitler
│       │   ├── firebase.ts         # Firebase Admin SDK
│       │   ├── signaling.ts        # WebSocket sinyalizasyon sunucusu
│       │   └── sessionMiddleware.ts
│       ├── routes/
│       │   ├── files.ts            # Dosya API'leri
│       │   ├── auth.ts             # Kimlik doğrulama
│       │   ├── admin.ts            # Admin API'leri
│       │   └── health.ts
│       └── scripts/
│           └── migrate-local-to-firebase.ts
├── uploads/                       # Yüklenen dosyalar (yerel modda)
├── database.rules.json            # Firebase RTDB güvenlik kuralları
└── package.json
```

---

## Lisans

MIT
