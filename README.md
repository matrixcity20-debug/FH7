# FileSplit

Dosya yükleme, parçalama ve dağıtım uygulaması. Kullanıcı kimlik doğrulaması, dosya gizliliği ve WebRTC P2P seeding destekler.

## Özellikler

- Kullanıcı kaydı ve girişi (bcrypt + express-session)
- Her kullanıcı yalnızca kendi dosyalarını görür
- Dosyaları parçalara bölerek saklama (1 MB chunk)
- P2P WebRTC seeding — tarayıcıdan doğrudan paylaşım
- Klasör organizasyonu
- TTL (otomatik silme: 1s, 24s, 7g, 30g)
- JS embed snippet ile harici sitelere indirme butonu ekleme
- SHA-256 bütünlük kontrolü

## Kurulum

```bash
npm install
```

Ortam değişkenleri için `.env` dosyası oluştur:

```
SESSION_SECRET=gizli-anahtar-buraya
PORT=5000
NODE_ENV=development
```

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

- **Backend**: Node.js 22, Express 5, TypeScript, express-session, bcryptjs, multer, ws
- **Frontend**: React 19, Vite 7, Tailwind CSS v4, wouter, TanStack Query
- **Depolama**: Flat-file (uploads/ dizini)
