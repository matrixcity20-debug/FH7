# FileSplit

Dosya yükleme, parçalama ve dağıtım uygulaması. Kullanıcı kimlik doğrulaması, dosya gizliliği ve WebRTC P2P seeding destekler.

## Özellikler

- Kullanıcı kaydı ve girişi (bcrypt + express-session)
- Kullanıcı hesapları, ayarlanmışsa Firebase Realtime Database'e güvenli şekilde kaydedilir; ayarlanmamışsa otomatik olarak yerel dosyaya kaydedilir (bkz. "Firebase Realtime Database Kurulumu")
- Her kullanıcı yalnızca kendi dosyalarını görür
- Dosyaları parçalara bölerek saklama (1 MB chunk)
- Direkt indirme linki ve paylaşım (sayfa) linki ayrı ayrı kopyalanabilir
- P2P WebRTC seeding — tarayıcıdan doğrudan paylaşım
- Klasör organizasyonu
- TTL (otomatik silme: 1s, 24s, 7g, 30g)
- JS embed snippet ile harici sitelere indirme butonu ekleme
- SHA-256 bütünlük kontrolü

## Kurulum

```bash
npm install
```

`.env.example` dosyasını kopyalayıp `.env` olarak kaydedin, kendi değerlerinizi girin:

```bash
cp .env.example .env
```

Zorunlu değişkenler:

```
SESSION_SECRET=gizli-anahtar-buraya
PORT=5000
NODE_ENV=development
```

`.env` dosyası `npm run dev` ve `npm start` ile otomatik yüklenir (Node.js'in yerleşik `process.loadEnvFile()` özelliği — ek paket gerekmez).

## Firebase Realtime Database Kurulumu (kullanıcı hesapları)

Kullanıcı kayıtlarını Firebase Realtime Database'e kaydetmek **isteğe bağlıdır**.
Aşağıdaki dört ortam değişkenini ayarlamazsanız, kullanıcılar otomatik olarak
yerel dosyaya (`uploads/_users.json`) kaydedilir ve uygulama sorunsuz çalışır.

**Neden güvenli?**
- Tarayıcıya (istemciye) hiçbir Firebase yapılandırması gönderilmez. Bağlantı
  yalnızca bu sunucudan, **Admin SDK** servis hesabı kimlik bilgileriyle kurulur.
- `database.rules.json` dosyası tüm istemci okuma/yazma erişimini reddeder
  (`".read": false, ".write": false`). Admin SDK bu kuralları zaten bypass
  ettiği için sunucu erişimi engellenmez, ama tarayıcıdan/3. taraftan doğrudan
  erişim mümkün olmaz.
- Şifreler hiçbir zaman düz metin olarak saklanmaz; sadece bcrypt (cost 12)
  hash'i Firebase'e yazılır.
- Kullanıcı adı benzersizliği, eşzamanlı kayıt denemelerine karşı Firebase
  transaction'ı ile atomik şekilde garanti edilir.

**Kurulum adımları:**

1. [Firebase Console](https://console.firebase.google.com/)'da bir proje açın (veya mevcut birini kullanın).
2. Sol menüden **Realtime Database** → **Create Database** ile bir RTDB oluşturun.
3. Proje Ayarları → **Service Accounts** sekmesinden **Generate new private key** ile bir JSON dosyası indirin.
4. İndirilen JSON'daki `project_id`, `client_email`, `private_key` alanlarını ve RTDB'nizin URL'sini `.env` dosyanıza girin:

   ```
   FIREBASE_PROJECT_ID=proje-id-buraya
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@proje-id-buraya.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   FIREBASE_DATABASE_URL=https://proje-id-buraya-default-rtdb.firebaseio.com
   ```

5. Firebase CLI kuruluysa güvenlik kurallarını deploy edin (önerilir):

   ```bash
   npm install -g firebase-tools
   firebase login
   firebase deploy --only database
   ```

   (Kuralları manuel olarak da Firebase Console → Realtime Database → Rules
   sekmesine `database.rules.json` içeriğini yapıştırarak uygulayabilirsiniz.)

6. Servis hesabı JSON dosyasını **asla** repoya commit etmeyin; `.env` dosyası `.gitignore`'da zaten hariç tutulmuştur. Hosting platformunuzda (Fly/Railway/Render) bu dört değişkeni "secret/environment variable" olarak ekleyin.

## Geliştirme

```bash
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:5000

## Production Build

```bash
npm run build
npm start
```

## Deploy

### Fly.io

```bash
fly launch
fly secrets set SESSION_SECRET=$(openssl rand -hex 32)
fly volumes create filesplit_data --region fra --size 5
fly deploy
```

### Railway

`railway.toml` mevcut — Railway dashboard'dan SESSION_SECRET girin, otomatik deploy olur.

### Render

`render.yaml` mevcut — Render dashboard'dan "New Blueprint" ile yükleyin. SESSION_SECRET otomatik oluşturulur.

## Stack

- **Backend**: Node.js 22, Express 5, TypeScript, express-session, bcryptjs, multer, ws, firebase-admin (opsiyonel kullanıcı deposu)
- **Frontend**: React 19, Vite 7, Tailwind CSS v4, wouter, TanStack Query
- **Depolama**: Flat-file (uploads/ dizini) + opsiyonel Firebase Realtime Database (kullanıcı hesapları)
