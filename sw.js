// ============================================================
//  sw.js — Service Worker OFFLINE-FIRST + Background Sync
//  PLN UP3 Jayapura — Monitoring Gardu
//
//  Tujuan:
//  1) App-shell (index.html, manifest.json, supabase-api.js, icon)
//     bisa dibuka TANPA internet (offline-first), dengan strategi
//     "Network First, fallback ke Cache" → saat online tetap ambil
//     versi terbaru dari server, saat offline langsung disajikan
//     dari cache.
//  2) Background Sync tetap seperti semula → kirim ulang data
//     antrian IndexedDB begitu jaringan kembali online.
//
//  Anti stale-cache saat deploy:
//  - Nama cache disisipi BUILD_TIME (di-inject otomatis oleh
//    GitHub Actions saat deploy) → setiap deploy = nama cache baru.
//  - Saat 'activate', SEMUA cache lama (nama berbeda) dihapus.
//  - Karena strategi fetch adalah Network-First, selama user online
//    dia SELALU dapat versi terbaru dari server (cache cuma dipakai
//    saat network gagal / offline). Jadi tidak perlu hapus cache
//    manual & tidak akan "tersangkut" versi lama saat ada koneksi.
//
//  BUILD_TIME di-inject otomatis oleh GitHub Actions saat deploy.
// ============================================================

var SW_VERSION  = 'gardu-pln-v1783299275'; // di-replace otomatis saat deploy
var CACHE_NAME  = 'gardu-pln-shell-1783299275';
var DB_NAME     = 'gardu-pln-db';
var DB_VERSION  = 1;
var QUEUE_STORE = 'gardu-sync-queue';
var SYNC_TAG    = 'sync-inspeksi';

// Aset app-shell yang di-precache supaya app bisa dibuka offline.
// Hanya aset statis milik app sendiri — TIDAK termasuk request ke
// Supabase (beda origin, selalu harus fresh dari network).
var APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './supabase-api.js',
  './icon-baru-192.png',
  './icon-baru-512.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.min.js'
];

// ── INSTALL ───────────────────────────────────────────────────
// Precache app-shell. Kalau salah satu aset gagal (mis. icon
// belum ada di server), jangan sampai install gagal total →
// cache satu-satu dan skip yang error.
self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.all(
        APP_SHELL.map(function(url) {
          // PENTING: cache:'reload' memaksa browser mengambil byte terbaru
          // dari server saat precache, bukan dari HTTP disk cache miliknya
          // sendiri. Tanpa ini, precache saat install bisa saja "mengunci"
          // versi lama app-shell yang kebetulan masih tersimpan di HTTP
          // cache browser (mis. karena header Cache-Control dari GitHub
          // Pages), sehingga deploy baru terasa butuh clear cache manual.
          return fetch(url, { cache: 'reload' })
            .then(function(res) {
              if (res && res.ok) return cache.put(url, res);
            })
            .catch(function(err) {
              console.warn('[SW] Gagal precache:', url, err);
            });
        })
      );
    })
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────
// Hapus semua cache lama (dari deploy sebelumnya) supaya storage
// tidak menumpuk dan tidak ada risiko file usang tersajikan.
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

// ── FETCH: Network-First, fallback ke Cache ──────────────────
// Hanya menangani GET request ke origin sendiri (app-shell).
// Request ke Supabase / domain lain (beda origin) dibiarkan lewat
// apa adanya, TIDAK pernah di-intercept atau di-cache di sini.
self.addEventListener('fetch', function(event) {
  var req = event.request;

  if (req.method !== 'GET') return;              // POST/PUT dll → biarkan
  if (new URL(req.url).origin !== location.origin) return; // beda origin → biarkan (Supabase, dsb.)

  event.respondWith(
    // cache:'no-store' → jangan pernah pakai HTTP disk cache browser untuk
    // request app-shell ini. Ini bagian krusial dari "network-first sungguhan":
    // tanpa opsi ini, browser bisa saja diam-diam menjawab fetch() dari HTTP
    // cache-nya sendiri (mengikuti header Cache-Control server) walau kode di
    // sini niatnya selalu ke jaringan — efeknya sama seperti stale cache,
    // padahal Cache Storage SW sudah benar. Dengan no-store, setiap deploy
    // baru otomatis langsung terlihat begitu online, tanpa perlu hapus cache.
    fetch(req, { cache: 'no-store' })
      .then(function(res) {
        // Sukses online → update cache dengan versi terbaru sekaligus
        if (res && res.ok) {
          var resClone = res.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(req, resClone);
          });
        }
        return res;
      })
      .catch(function() {
        // Offline / network gagal → sajikan dari cache
        return caches.match(req).then(function(cached) {
          if (cached) return cached;
          // Fallback terakhir untuk navigasi: index.html dari cache
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return Promise.reject('offline dan tidak ada di cache: ' + req.url);
        });
      })
  );
});

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
  // Jaga-jaga: skipWaiting() sudah dipanggil otomatis di 'install' di atas,
  // tapi pesan ini tetap ditangani untuk defense-in-depth kalau suatu saat
  // perilaku itu diubah atau ada race condition SW yang masih 'waiting'.
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('[SW] Aktif — versi ' + SW_VERSION + ' — offline-first app-shell + Background Sync.');
