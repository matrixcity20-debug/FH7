/**
 * BUL-17 fix — local → Firebase user migration tool.
 *
 * Problem this solves:
 *   A deployment may run for a while on the local JSON user store
 *   (uploads/_users.json) and accumulate real accounts. If someone later
 *   adds FIREBASE_* env vars to switch backends WITHOUT migrating data
 *   first, those local users become invisible to Firebase's usernameIndex.
 *   An attacker (or just an unlucky new signup) could then register a
 *   *different* account using the same username — silent account
 *   confusion / identity squatting, with no error or warning to anyone.
 *
 * What this script does:
 *   1. Reads every user from the local _users.json store.
 *   2. For each one, atomically claims that username in Firebase's
 *      usernameIndex (preserving the original id/passwordHash/createdAt)
 *      — UNLESS the username is already taken in Firebase, in which case
 *      it is skipped and reported as a conflict for manual review.
 *   3. Prints a summary so the operator knows exactly what happened.
 *
 * This script is idempotent and safe to re-run: usernames already migrated
 * are skipped automatically (the existing usernameIndex entry causes the
 * transaction to abort), nothing is overwritten or duplicated.
 *
 * Usage (run BEFORE removing/changing the local store, with FIREBASE_* env
 * vars already configured):
 *
 *   npm run migrate:users
 */
import "../lib/env.js"; // load .env first so FIREBASE_* vars are present below
import { getFirebaseDb } from "../lib/firebase.js";
import { loadAllLocalUsers, migrateUserToFirebase } from "../lib/userStore.js";

async function main(): Promise<void> {
  const db = getFirebaseDb();
  if (!db) {
    console.error(
      "HATA: Firebase yapılandırılmamış. FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / " +
        "FIREBASE_PRIVATE_KEY / FIREBASE_DATABASE_URL ortam değişkenlerini ayarlayıp tekrar deneyin.",
    );
    process.exitCode = 1;
    return;
  }

  const localUsers = loadAllLocalUsers();
  if (localUsers.length === 0) {
    console.log("Yerel _users.json içinde taşınacak kullanıcı bulunamadı. Yapılacak bir şey yok.");
    return;
  }

  console.log(`${localUsers.length} yerel kullanıcı bulundu. Firebase'e taşıma başlıyor...\n`);

  let migrated = 0;
  let alreadyMigrated = 0;
  let skipped = 0;
  const conflicts: string[] = [];

  for (const user of localUsers) {
    const result = await migrateUserToFirebase(user);
    // Redact username from logs — show only last 4 chars of UUID for correlation.
    const shortId = user.id.slice(-4);
    if (result === "migrated") {
      migrated++;
      console.log(`  ✓ taşındı: [kullanıcı …${shortId}]`);
    } else if (result === "already-migrated") {
      alreadyMigrated++;
      console.log(`  · zaten taşınmış: [kullanıcı …${shortId}] — atlandı`);
    } else if (result === "conflict") {
      skipped++;
      conflicts.push(shortId);
      console.warn(`  ⚠ ÇAKIŞMA: [kullanıcı …${shortId}] zaten Firebase'de farklı bir hesap olarak kayıtlı — ATLANDI`);
    }
  }

  console.log("\n=== Özet ===");
  console.log(`Taşınan:           ${migrated}/${localUsers.length}`);
  console.log(`Zaten taşınmıştı:  ${alreadyMigrated}/${localUsers.length}`);
  console.log(`Çakışma (atlanan): ${skipped}/${localUsers.length}`);

  if (conflicts.length > 0) {
    console.log(`\nÇakışan kullanıcı kısa ID'leri: ${conflicts.join(", ")}`);
    console.log(
      "Bu kullanıcı adları hem yerel depoda hem Firebase'de birbirinden BAĞIMSIZ hesaplar olarak var.\n" +
        "Hangisinin gerçek/öncelikli hesap olduğuna manuel karar verip uygun tarafı elle birleştirin\n" +
        "(örn. eski hesabı yeniden adlandırıp kullanıcıyı bilgilendirin) — script bunu otomatik yapmaz,\n" +
        "çünkü hangi hesabın 'doğru' olduğuna karar vermek bir veri kaybı riski taşır.",
    );
    process.exitCode = 1; // non-zero so CI/operators notice unresolved conflicts
  } else {
    console.log("\nÇakışma yok — migration tamamlandı. Artık local _users.json dosyasını güvenle arşivleyebilirsiniz.");
  }
}

main().catch((err) => {
  console.error("Migration başarısız:", err);
  process.exitCode = 1;
});
