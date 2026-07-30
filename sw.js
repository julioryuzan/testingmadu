// ============================================================
//  sw.js — Service Worker minimal
//  PLN UP3 Jayapura — Monitoring Gardu
//
//  Tujuan: HANYA Background Sync — kirim ulang data yang antri
//  saat jaringan petugas terputus, tanpa cache aset apapun.
//
//  Keunggulan pendekatan minimal ini:
//  - Tidak ada masalah cache lama saat deploy baru → tidak perlu
//    bump versi, tidak perlu hapus cache browser manual
//  - Browser selalu ambil index.html, JS, CSS langsung dari server
//  - SW hanya aktif saat ada data di antrian IndexedDB yang perlu
//    dikirim ulang ke server
//
//  BUILD_TIME di-inject otomatis oleh GitHub Actions saat deploy.
//  Tujuannya: setiap deploy SW dianggap "file baru" oleh browser
//  sehingga SW langsung diinstall ulang tanpa perlu hapus cache.
// ============================================================

var SW_VERSION  = 'gardu-pln-v{{BUILD_TIME}}'; // di-replace otomatis saat deploy
var DB_NAME     = 'gardu-pln-db';
var DB_VERSION  = 1;
var QUEUE_STORE = 'gardu-sync-queue';
var SYNC_TAG    = 'sync-inspeksi';

// ── INSTALL & ACTIVATE ───────────────────────────────────────
// Tidak cache apapun — browser handle semua aset seperti biasa
self.addEventListener('install',  function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

// ── Tidak ada fetch handler ───────────────────────────────────
// Browser ambil semua file langsung dari server.
// Tidak ada cache → tidak ada masalah versi lama tersangkut.

// ── BACKGROUND SYNC ──────────────────────────────────────────
// Dipicu oleh browser saat jaringan kembali online,
// setelah halaman memanggil: reg.sync.register('sync-inspeksi')
self.addEventListener('sync', function(event) {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(kirimAntrianInspeksi());
  }
});

// ── Kirim semua antrian dari IndexedDB ───────────────────────
function kirimAntrianInspeksi() {
  return bukaDB().then(function(db) {
    return getAllQueue(db).then(function(items) {
      if (!items || !items.length) return;
      return items.reduce(function(chain, item) {
        return chain.then(function() { return kirimSatu(db, item); });
      }, Promise.resolve());
    });
  }).catch(function(e) {
    console.warn('[SW] kirimAntrianInspeksi error:', e);
  });
}

function kirimSatu(db, item) {
  if (!item.apiUrl || !item.payload) return Promise.resolve();
  return fetch(item.apiUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(item.payload)
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    if (res && res.status === 'ok') {
      return hapusQueue(db, item.id).then(function() {
        return self.clients.matchAll({ includeUncontrolled: true }).then(function(clients) {
          clients.forEach(function(c) {
            c.postMessage({
              type:    'SYNC_SUCCESS',
              idGardu: item.payload.idGardu || item.id,
              message: '☁️ Data ' + (item.payload.idGardu || '') + ' berhasil dikirim ke server.'
            });
          });
        });
      });
    } else {
      console.log('[SW] Server menolak:', res && res.message);
    }
  })
  .catch(function(err) {
    console.log('[SW] Gagal kirim (akan retry saat online):', err.message);
  });
}

// ── IndexedDB helpers ─────────────────────────────────────────
function bukaDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

function getAllQueue(db) {
  return new Promise(function(resolve, reject) {
    var req = db.transaction(QUEUE_STORE, 'readonly').objectStore(QUEUE_STORE).getAll();
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

function hapusQueue(db, id) {
  return new Promise(function(resolve, reject) {
    var req = db.transaction(QUEUE_STORE, 'readwrite').objectStore(QUEUE_STORE).delete(id);
    req.onsuccess = function() { resolve(); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

// ── MESSAGE dari halaman ──────────────────────────────────────
self.addEventListener('message', function(event) {
  if (!event.data) return;
  // Trigger kirim antrian manual (mis. user tekan tombol "Kirim Ulang")
  if (event.data.type === 'SYNC_NOW') {
    kirimAntrianInspeksi();
  }
});

console.log('[SW minimal] Aktif — versi ' + SW_VERSION + ' — hanya Background Sync, tidak ada caching aset.');
