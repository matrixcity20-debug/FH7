// Bu modülün TEK işi, diğer her şeyden önce .env dosyasını yüklemek.
// index.ts içinde ilk import olarak eklenmelidir, böylece SESSION_SECRET,
// FIREBASE_* gibi değişkenler app.ts/firebase.ts okunmadan önce hazır olur.
//
// Node.js 20.6+ yerleşik özelliği — ek paket (dotenv) gerekmez.
// Production'da (Fly/Railway/Render) .env dosyası genelde yoktur; platform
// kendi ortam değişkenlerini zaten enjekte eder, bu yüzden hata sessizce
// yutulur.
try {
  process.loadEnvFile();
} catch {
  /* .env dosyası bulunamadı — sorun değil, platform env'leri kullanılacak */
}
