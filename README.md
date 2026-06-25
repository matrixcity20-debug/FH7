# FileSplit 🗂️

Dosyalarınızı güvenle yükleyin, saklayın ve paylaşın. Büyük dosyalar otomatik olarak parçalara bölünür ve AES-256-GCM ile şifrelenerek bulut depolamaya yüklenir. Kullanıcı başına depolama kotası ve admin paneli ile tam kontrol sizin elinizde.

---

## Özellikler

- **Parçalı yükleme** — Dosyalar 1 MB'lık chunk'lara bölünür; SHA-256 bütünlük kontrolü yapılır
- **Bulut depolama** — Cloudflare R2, Backblaze B2 ve iDrive e2 desteği; round-robin yük dağıtımı
- **Uçtan uca şifreleme** — Her dosya AES-256-GCM ile şifrelenir; anahtar yalnızca Firebase'de saklanır
- **Gerçek zamanlı indirme** — WebSocket sinyalizasyonu üzerinden P2P-tarzı hızlı indirme
- **Şifreli dosyalar** — Dosyaya opsiyonel parola (bcrypt hash ile saklanır)
- **TTL / Otomatik silme** — Dosyalar için son kullanma tarihi (1s · 24s · 7g · 30g)
- **Sürüm yönetimi** — Aynı dosyanın birden fazla versiyonunu saklayın ve gruplayın
- **Klasörler** — Dosyalarınızı klasörlere düzenleyin
- **Depolama paneli** — Kullanılan/toplam alan, maks. dosya boyutu görsel çubukla gösterilir
- **Per-user limitler** — Her kullanıcıya ayrı depolama kotası ve dosya boyutu limiti atanabilir
- **Admin paneli** — Yöneticiler `/admin` sayfasından tüm kullanıcı limitlerini, şikayetleri ve depolama istatistiklerini yönetir
- **Firebase arka ucu** — Kullanıcı, limit ve dosya kayıtları Firebase Realtime Database'de saklanır; yerel JSON fallback mevcuttur
- **JS embed snippet** — Harici sitelere indirme butonu ekleme

---

## Teknoloji Yığını

| Katman | Teknoloji |
|--------|-----------|
| **İstemci** | React 19, Vite 7, TailwindCSS 4, shadcn/ui, Framer Motion, Wouter, TanStack Query |
| **Sunucu** | Node.js 22+, Express 5, TypeScript |
| **Gerçek zamanlı** | WebSocket (`ws`) — sinyalizasyon + P2P indirme |
| **Veritabanı** | Firebase Realtime Database (Admin SDK) + yerel JSON fallback |
| **Bulut depolama** | Cloudflare R2 · Backblaze B2 · iDrive e2 (S3-uyumlu) |
| **Şifreleme** | AES-256-GCM (chunk başına bağımsız IV; kimlik doğrulamalı) |
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

`.env` dosyası oluşturun (`.env.example` dosyasını kopyalayıp düzenleyebilirsiniz):

```env
# Oturum güvenliği — rastgele ve uzun bir dize seçin (zorunlu)
# Oluşturmak için: openssl rand -hex 64
SESSION_SECRET=cok-gizli-bir-anahtar-buraya

PORT=5000
NODE_ENV=development

# Production'da ZORUNLU — izin verilen kaynak(lar)
# ALLOWED_ORIGINS=https://siteniz.com

# Depolama limitleri (opsiyonel)
MAX_FILE_SIZE_MB=500        # Dosya başına maks. boyut (varsayılan: 500 MB)
MAX_USER_STORAGE_MB=5000    # Kullanıcı başına toplam kota (varsayılan: 5 GB)
CHUNK_SIZE_MB=1             # Her parçanın boyutu (varsayılan: 1 MB)

# Admin erişimi — boş bırakırsanız hiç kimse admin olamaz (fail-secure)
ADMIN_USER_IDS=
```

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

## Bulut Depolama

Uygulama üç S3-uyumlu bulut depolama sağlayıcısını destekler. Tamamı birlikte çalışır; yükleme sırasında yapılandırılmış tüm bucket'lar arasında otomatik round-robin dağıtımı yapılır. Hiçbirini tanımlamazsanız dosyalar yalnızca yerel diske kaydedilir.

### Cloudflare R2 (Sağlayıcı 1)

```env
R2_ACCOUNT_ID=cloudflare-hesap-id
R2_ACCESS_KEY_ID=r2-access-key
R2_SECRET_ACCESS_KEY=r2-secret-key
R2_BUCKET_NAME=bucket-adi          # tek bucket
# veya birden fazla bucket için:
R2_BUCKET_NAMES=bucket-eu,bucket-us
```

### Backblaze B2 (Sağlayıcı 2)

```env
B2_KEY_ID=b2-application-key-id
B2_APP_KEY=b2-application-key
B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
B2_BUCKET_NAME=bucket-adi
# veya birden fazla bucket için:
B2_BUCKET_NAMES=bucket-b2-1,bucket-b2-2
```

### iDrive e2 (Sağlayıcı 3)

```env
E2_ACCESS_KEY_ID=e2-access-key-id
E2_SECRET_ACCESS_KEY=e2-secret-key
E2_ENDPOINT=https://HESAP_ID.s3.BOLGE.idrivecloud.io
E2_BUCKET_NAME=bucket-adi
# veya birden fazla bucket için:
E2_BUCKET_NAMES=bucket-e2-1,bucket-e2-2
```

> **Güvenlik notu:** Şifreleme anahtarı hiçbir zaman bulut depolamaya yazılmaz. Dosyalar bulut tarafında sızdırılsa bile anahtar olmadan içerik okunamaz.

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
| Depolama testi | R2 / B2 / e2 bucket bağlantısını canlı test et |
| Depolama istatistikleri | Provider ve bucket başına dosya/boyut dağılımı |
| Şikayet yönetimi | Bildirilen dosyaları görüntüle ve kaldır |
| Varsayılana dön | Özel limiti kaldır, sunucu varsayılanına dön |

---

## Deploy

### Fly.io

```bash
fly launch
fly secrets set SESSION_SECRET=$(openssl rand -hex 64)
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
| `POST` | `/api/files/upload` | Tek parçalı yükleme |
| `POST` | `/api/files/upload-init` | Çok parçalı yükleme başlat |
| `POST` | `/api/files/upload-part` | Parça yükle |
| `POST` | `/api/files/upload-finalize` | Yüklemeyi tamamla ve bütünlük doğrula |
| `GET` | `/api/files` | Dosya listesi |
| `GET` | `/api/files/:id` | Dosya meta verisi |
| `GET` | `/api/files/:id/download` | Dosyayı indir (stream) |
| `GET` | `/api/files/:id/snippet` | JS embed kodu |
| `DELETE` | `/api/files/:id` | Dosya sil |

### Klasörler

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `GET` | `/api/folders` | Klasör listesi |
| `POST` | `/api/folders` | Klasör oluştur |
| `DELETE` | `/api/folders/:id` | Klasör sil |
| `PATCH` | `/api/files/:id/folder` | Dosyayı klasöre taşı |

### Admin

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `GET` | `/api/admin/users` | Tüm kullanıcılar + kullanım + limitler |
| `GET` | `/api/admin/users/:id/limits` | Kullanıcı limitini getir |
| `PATCH` | `/api/admin/users/:id/limits` | Kullanıcı limitini güncelle |
| `DELETE` | `/api/admin/users/:id/limits` | Limiti varsayılana döndür |
| `GET` | `/api/admin/defaults` | Sunucu varsayılan limitleri |
| `GET` | `/api/admin/r2/stats` | Depolama istatistikleri (R2+B2+e2) |
| `POST` | `/api/admin/storage/test` | Bucket bağlantısını test et |
| `GET` | `/api/admin/reports` | Şikayet listesi |
| `DELETE` | `/api/admin/reports/:id` | Şikayeti kapat |
| `DELETE` | `/api/admin/reports/:id/file` | Şikayeti kapat + dosyayı sil |

### Diğer

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| `GET` | `/api/health` | Sağlık kontrolü |
| `WS` | `/ws` | Gerçek zamanlı P2P sinyalizasyon |

---

## Güvenlik

| Konu | Uygulama |
|------|----------|
| Dosya şifreleme | AES-256-GCM; her chunk için bağımsız IV; kimlik doğrulamalı şifreleme |
| Anahtar yönetimi | Şifreleme anahtarı yalnızca Firebase'de saklanır; bulut bucket'larına asla yazılmaz |
| Nesne yolu gizleme | Bucket'lardaki nesne yolları SHA-256 tabanlı; UUID'ler doğrudan görünmez |
| Path traversal | Tüm `fileId` / `folderId` değerleri UUID regex + `path.resolve` containment-check ile doğrulanır |
| HTTP başlıkları | **Helmet.js** — CSP, HSTS, X-Frame-Options vb. |
| Rate limiting | **express-rate-limit** — tüm endpointlerde; admin için ayrı limit |
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
│       │   ├── RateLimitWarning.tsx
│       │   └── ui/                 # shadcn/ui bileşenleri
│       ├── hooks/
│       │   └── use-auth.tsx        # Auth context
│       ├── lib/
│       │   ├── generated/          # Orval ile üretilen API hook'ları ve Zod şemaları
│       │   ├── custom-fetch.ts
│       │   └── sha256.ts
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
│       │   ├── fileRegistry.ts     # Firebase RTDB dosya kayıt yönetimi
│       │   ├── storageProvider.ts  # Birleşik depolama yönlendiricisi (R2+B2+e2)
│       │   ├── r2Storage.ts        # Cloudflare R2 istemcisi
│       │   ├── b2Storage.ts        # Backblaze B2 istemcisi
│       │   ├── e2Storage.ts        # iDrive e2 istemcisi
│       │   ├── userStore.ts        # Kullanıcı yönetimi + per-user limitler
│       │   ├── firebase.ts         # Firebase Admin SDK
│       │   ├── signaling.ts        # WebSocket sinyalizasyon sunucusu
│       │   ├── uploadSessionStore.ts
│       │   └── sessionMiddleware.ts
│       ├── routes/
│       │   ├── files/index.ts      # Dosya API'leri
│       │   ├── auth.ts             # Kimlik doğrulama
│       │   ├── admin.ts            # Admin API'leri
│       │   └── health.ts
│       └── scripts/
│           └── migrate-local-to-firebase.ts
├── database.rules.json            # Firebase RTDB güvenlik kuralları
├── .env.example                   # Tüm ortam değişkenleri açıklamalarıyla
└── package.json
```

---

## Lisans

MIT
