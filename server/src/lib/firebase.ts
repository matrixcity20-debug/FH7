import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getDatabase, type Database } from "firebase-admin/database";
import { logger } from "./logger.js";

/**
 * Firebase Admin SDK bağlantısı.
 *
 * ÖNEMLİ GÜVENLİK NOTU:
 * Bu modül kullanıcı verilerine SADECE sunucu tarafında, Admin SDK servis
 * hesabı kimlik bilgileriyle erişir. İstemci (tarayıcı) tarafına HİÇBİR
 * Firebase yapılandırması (apiKey, databaseURL vb.) gönderilmez. Admin SDK
 * kimlik bilgileri Realtime Database güvenlik kurallarını bypass eder, bu
 * yüzden database.rules.json dosyasında tüm istemci erişimi reddedilmiştir
 * — veritabanına giriş tek yol olarak bu sunucudan geçer.
 *
 * Gerekli ortam değişkenleri (.env dosyasına veya hosting platformunun
 * secret/env ayarlarına eklenmeli, ASLA repoya commit edilmemeli):
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY   (servis hesabı JSON'undaki private_key alanı)
 *   FIREBASE_DATABASE_URL  (örn: https://<proje-id>-default-rtdb.firebaseio.com)
 *
 * Bu değişkenler tanımlı değilse, kullanıcı deposu otomatik olarak yerel
 * dosya tabanlı depoya (uploads/_users.json) geri döner — yani Firebase
 * yapılandırmadan da proje normal şekilde çalışmaya devam eder.
 */

let db: Database | null = null;
let initAttempted = false;
let initLoggedWarning = false;

function initFirebase(): Database | null {
  if (initAttempted) return db;
  initAttempted = true;

  const projectId = process.env["FIREBASE_PROJECT_ID"];
  const clientEmail = process.env["FIREBASE_CLIENT_EMAIL"];
  const rawPrivateKey = process.env["FIREBASE_PRIVATE_KEY"];
  const databaseURL = process.env["FIREBASE_DATABASE_URL"];

  if (!projectId || !clientEmail || !rawPrivateKey || !databaseURL) {
    if (!initLoggedWarning) {
      initLoggedWarning = true;
      logger.warn(
        "Firebase ortam değişkenleri eksik (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY / FIREBASE_DATABASE_URL). Kullanıcı hesapları yerel dosyaya (uploads/_users.json) kaydedilecek.",
      );
    }
    return null;
  }

  try {
    // .env dosyalarında private key genelde tek satırda \n kaçışlı saklanır.
    const privateKey = rawPrivateKey.includes("\\n")
      ? rawPrivateKey.replace(/\\n/g, "\n")
      : rawPrivateKey;

    const app: App = getApps()[0] ?? initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      databaseURL,
    });

    db = getDatabase(app);
    logger.info({ projectId }, "Firebase Realtime Database bağlantısı kuruldu");
    return db;
  } catch (err) {
    logger.error({ err }, "Firebase başlatılamadı, yerel dosya deposuna geri dönülüyor");
    db = null;
    return null;
  }
}

/** Firebase yapılandırılmışsa Database referansını, değilse null döner. */
export function getFirebaseDb(): Database | null {
  return initFirebase();
}

export function isFirebaseEnabled(): boolean {
  return getFirebaseDb() !== null;
}
