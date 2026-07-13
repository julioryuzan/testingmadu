// ============================================================
//  PLN UP3 JAYAPURA — Supabase API Layer  v8
//  File: supabase-api.js
//  Semua action memanggil RPC (fn_*) atau REST view
// ============================================================

// ── KONFIGURASI ──────────────────────────────────────────────
var SUPABASE_URL  = 'https://ckarfhmaydqhcclvueqn.supabase.co';
var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrYXJmaG1heWRxaGNjbHZ1ZXFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMzkwNTgsImV4cCI6MjA5NDkxNTA1OH0.js9CKdBZ-8omTQpwaTfnuvTGStuB1tajjRbdCrP5L6o';

// ── ULP Enum normalizer ──────────────────────────────────────
function _normalizeUlpEnum(ulp) {
  if (!ulp) return null;
  var s = String(ulp).trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith('ULP ')) return s;
  return 'ULP ' + s;
}

// ── Numeric parser — aman untuk format Indonesia & internasional ──────────────
// Menangani: "53,789" (koma=desimal) → 53.789
//            "1.234,56" (titik=ribuan, koma=desimal) → 1234.56
//            "53.789" (titik=desimal, bukan ribuan) → 53.789
//            "53789" (integer) → 53789
// Heuristik untuk ambiguitas titik tunggal + 3 digit:
//   Nilai arus/tegangan/beban trafo batas wajar: Arus < 3000 A, Tegangan < 500 V
//   Jika hasil tanpa titik > MAX_SENSOR_VAL kemungkinan titik = desimal (bukan ribuan)
function _parseNumSafe(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  var s = String(val).trim();
  if (s === '' || s === '-' || s.toLowerCase() === 'null') return null;

  var dotCount   = (s.match(/\./g)  || []).length;
  var commaCount = (s.match(/,/g)   || []).length;

  if (commaCount >= 1 && dotCount >= 1) {
    // Format campuran: titik=ribuan, koma=desimal → "1.234,56" → "1234.56"
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (commaCount === 1 && dotCount === 0) {
    // Hanya koma: desimal Indonesia → "53,789" → "53.789"
    s = s.replace(',', '.');
  } else if (dotCount === 1 && commaCount === 0) {
    // Satu titik: bisa desimal atau ribuan (ambiguitas)
    var parts = s.split('.');
    if (parts[1] && parts[1].length === 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      // Pola "NNN.NNN" — ambiguous. Cek: jika nilai tanpa titik (misal 53789) > 9999,
      // maka besar kemungkinan titik = pemisah ribuan. Hapus titik.
      // Untuk nilai sensor (arus A, tegangan V, dll.) yang wajar, nilai > 9999 tidak masuk akal.
      var withoutDot = parseFloat(parts[0] + parts[1]);
      var withDot    = parseFloat(s);
      // Jika nilai dengan titik masuk akal (< 9999) → pertahankan titik sebagai desimal
      // Jika nilai dengan titik > 9999 maka titik adalah ribuan → hapus titik
      if (withDot > 9999) {
        s = parts[0] + parts[1]; // hapus titik: 53.789 → 53789 (ribuan)
      }
      // else: titik adalah desimal, biarkan apa adanya
    }
    // Jika pola lain (mis. "3.5", "220.5"), biarkan apa adanya
  }

  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── SHA-256 helper ───────────────────────────────────────────
async function sha256(str) {
  var buf = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf))
    .map(function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

// ── Supabase REST helper ─────────────────────────────────────
function sbFetch(path, opts) {
  opts = opts || {};
  var headers = Object.assign({
    'apikey':        SUPABASE_ANON,
    'Authorization': 'Bearer ' + SUPABASE_ANON,
    'Content-Type':  'application/json',
    'Prefer':        opts.prefer || ''
  }, opts.headers || {});
  return fetch(SUPABASE_URL + path, {
    method:  opts.method  || 'GET',
    headers: headers,
    body:    opts.body    || undefined,
    signal:  opts.signal  || undefined
  });
}

// ── RPC helper ───────────────────────────────────────────────
function sbRpc(funcName, params, signal) {
  return sbFetch('/rest/v1/rpc/' + funcName, {
    method: 'POST',
    body:   JSON.stringify(params || {}),
    signal: signal
  });
}

// ── RPC wrapper: panggil dan parse JSON langsung ─────────────
async function rpcCall(funcName, params, signal) {
  var res = await sbRpc(funcName, params, signal);
  if (!res.ok) {
    var errTxt = await res.text().catch(function() { return String(res.status); });
    // Saring pesan teknis agar tidak bocor langsung ke UI
    // (index.html akan menyaring lebih lanjut via userFriendlyError)
    var technicalMsg = 'Server error ' + res.status + ': ' + errTxt;
    return { status: 'error', message: technicalMsg, _technical: true };
  }
  var data = await res.json();
  if (!data) return { status: 'error', message: 'Response kosong dari server.' };
  // Supabase RPC kadang mengembalikan array [result] — unwrap otomatis
  if (Array.isArray(data)) {
    if (data.length === 0) return { status: 'error', message: 'Response kosong dari server.' };
    data = data[0];
  }
  return data;
}

// ── apiCall wrapper ──────────────────────────────────────────
var _HEAVY_ACTIONS = {
  getGarduKritis: 1, getExportRekap: 1, getRekap: 1, getDaftarGardu: 1, getRiwayat: 1
};
var _TIMEOUT_MS = { getDaftarGardu: 120000, getGarduKritis: 90000, getExportRekap: 90000, getRekap: 60000, getRiwayat: 180000 };

function apiCall(action, params, cb) {
  var controller = new AbortController();
  var done = false;
  var timeoutMs = _TIMEOUT_MS[action] || (_HEAVY_ACTIONS[action] ? 60000 : 30000);
  var timer = setTimeout(function() {
    if (done) return;
    done = true;
    controller.abort();
    cb({ status: 'error', message: 'Koneksi timeout. Periksa jaringan lalu coba lagi.' });
  }, timeoutMs);

  function finish(result) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(result);
  }

  _dispatch(action, params, controller.signal)
    .then(finish)
    .catch(function(err) {
      if (done) return;
      finish({
        status: 'error',
        message: err.name === 'AbortError'
          ? 'Koneksi timeout. Periksa jaringan lalu coba lagi.'
          : 'Gagal menghubungi server. (' + err.message + ')'
      });
    });
}

// ── Router ───────────────────────────────────────────────────
async function _dispatch(action, p, signal) {
  switch (action) {
    case 'loginUser':        return _login(p, signal);
    case 'verifyToken':      return _verifyToken(p, signal);
    case 'getDaftarGardu':   return _getDaftarGardu(p, signal);
    case 'getDetailLengkap': return _getDetailLengkap(p, signal);
    case 'getDetailGardu':   return _getDetailGardu(p, signal);
    case 'getTrenBeban':     return _getTrenBeban(p, signal);
    case 'getRekap':         return _getRekap(p, signal);
    case 'getGarduKritis':   return _getGarduKritis(p, signal);
    case 'getExportRekap':   return _getExportRekap(p, signal);
    case 'verifyPin':        return _verifyPin(p, signal);
    case 'setPin':           return _setPin(p, signal);
    case 'tambahGardu':      return _tambahGardu(p, signal);
    case 'editGardu':        return _editGardu(p, signal);
    case 'hapusGardu':       return _hapusGardu(p, signal);
    case 'getDaftarUser':    return _getDaftarUser(p, signal);
    case 'hapusUser':        return _hapusUser(p, signal);
    case 'cariGardu':        return _cariGardu(p, signal);
    case 'logoutUser':       return _logoutUser(p, signal);
    case 'getRiwayat':       return _getRiwayat(p, signal);
    case 'getRekapGardu':    return _getRekapGardu(p, signal);
    case 'tambahUser':       return _tambahUser(p, signal);
    case 'editUser':         return _editUser(p, signal);
    case 'gantiPassword':    return _gantiPassword(p, signal);
    case 'verifyULPPin':     return _verifyULPPin(p, signal);
    case 'toggleStatus':     return _toggleStatus(p, signal);
    case 'tambahInspeksi':   return _tambahInspeksi(p, signal);
    case 'hapusInspeksi':    return _hapusInspeksi(p, signal);
    case 'getInspeksi':      return _getInspeksi(p, signal);
    case 'editInspeksi':     return _editInspeksi(p, signal);
    case 'getInspeksiById':  return _getInspeksiById(p, signal);
    case 'resetPassword':    return _resetPasswordByAdmin(p, signal);
    case 'resetPin':         return _resetPinByAdmin(p, signal);
    case 'aktifkanUser':     return _aktifkanUser(p, signal);
    case 'statistikUlp':     return _statistikUlp(p, signal);
    case 'maintenanceCleanup': return _maintenanceCleanup(p, signal);
    case 'tambahPemeliharaan':    return _tambahPemeliharaan(p, signal);
    case 'getDaftarPemeliharaan': return _getDaftarPemeliharaan(p, signal);
    case 'hapusPemeliharaan':     return _hapusPemeliharaan(p, signal);
    case 'editPemeliharaan':      return _editPemeliharaan(p, signal);
    default: return { status: 'error', message: 'Action tidak dikenali: ' + action };
  }
}

// ── HELPER: verify token via RPC ─────────────────────────────
async function _getUserFromToken(token) {
  if (!token) return null;
  try {
    var data = await rpcCall('fn_verify_token', { p_token: token });
    if (!data || data.status !== 'ok') return null;
    return data;
  } catch (e) {
    console.error('[sbApi] _getUserFromToken error:', e);
    return null;
  }
}

// ── LOGIN ────────────────────────────────────────────────────
async function _login(p, signal) {
  var pwHash = await sha256(String(p.password || '').trim());
  var data = await rpcCall('fn_login', {
    p_username:      String(p.username || '').trim().toLowerCase(),
    p_password_hash: pwHash
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: data.message || 'Login gagal.' };

  // fn_login bisa return flat (username,nama,role,ulp) atau nested di data.user
  var u = (data.user && typeof data.user === 'object') ? data.user : data;
  return {
    status: 'ok',
    token:  data.token,
    user: {
      username: u.username || '',
      nama:     u.nama     || u.username || '',
      role:     u.role     || '',
      ulp:      u.ulp      || ''
    }
  };
}

// ── VERIFY TOKEN ─────────────────────────────────────────────
async function _verifyToken(p, signal) {
  var data = await rpcCall('fn_verify_token', { p_token: p.token }, signal);
  if (!data || data.status !== 'ok')
    return { status: 'error', message: 'Sesi tidak valid.' };
  return {
    status: 'ok',
    user: {
      username: data.username,
      nama:     data.nama,
      role:     data.role,
      ulp:      data.ulp || ''
    }
  };
}

// ── DAFTAR GARDU — pagination loop melewati limit 1000 Supabase ──────────────
async function _getDaftarGardu(p, signal) {
  var PAGE_SIZE = 500;
  var baseUrl = '/rest/v1/v_gardu_lengkap?select=*&order=no_gardu.asc';
  if (p && p.ulp) baseUrl += '&ulp=eq.' + encodeURIComponent(_normalizeUlpEnum(p.ulp));

  var allRows = [];
  var offset  = 0;
  var hasMore = true;

  while (hasMore) {
    var rangeStart = offset;
    var rangeEnd   = offset + PAGE_SIZE - 1;
    var res = await sbFetch(baseUrl, {
      signal: signal,
      headers: {
        'Range-Unit': 'items',
        'Range':      rangeStart + '-' + rangeEnd,
        'Prefer':     'count=none'
      }
    });

    if (!res.ok) {
      var errTxt = await res.text().catch(function() { return res.status; });
      return { status: 'error', message: 'Gagal memuat daftar gardu (' + res.status + '): ' + errTxt };
    }

    var rows = await res.json();
    if (!rows || !rows.length) break;

    allRows = allRows.concat(rows);
    offset += PAGE_SIZE;

    // Jika hasil < PAGE_SIZE berarti sudah halaman terakhir
    hasMore = rows.length === PAGE_SIZE;
  }

  // Deduplikasi berdasarkan no_gardu untuk hindari ghost row
  var seen = {};
  var uniqueRows = allRows.filter(function(g) {
    var key = (g.no_gardu || '').trim().toUpperCase();
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });

  var data = uniqueRows.map(function(g) {
    return {
      'NO_GARDU':           g.no_gardu || '',
      'ULP':                g.ulp      || '',
      'UNITUP':             g.unitup   || '',
      'PENYULANG':          g.penyulang || '',
      'ALAMAT':             g.alamat   || '',
      'KAPASITAS_KVA':      g.kapasitas_kva != null ? String(g.kapasitas_kva) : '',
      'TIPE':               g.tipe     || '',
      'STATUS_OPERASIONAL': g.status_operasional || '',
      'STATUS_KEPEMILIKAN': g.status_kepemilikan || '',
      'MEREK_TRAFO':        g.merek_trafo || '',
      '_lastInspeksi':      g.last_inspeksi_tgl || '',
      '_lastPetugas':       g.last_inspeksi_petugas || '',
      '_lastBeban':         g.last_prosen != null ? String(g.last_prosen) : '',
      '_totalInspeksi':     g.total_inspeksi || 0,
      'LATITUDE':           g.latitude  || '',
      'LONGITUDE':          g.longitude || '',
      'KETERANGAN':         g.keterangan || ''
    };
  });

  return {
    status: 'ok',
    data: data,
    _generatedAt: new Date().toLocaleTimeString('id-ID')
  };
}

// ── DETAIL GARDU + RIWAYAT ───────────────────────────────────
async function _getDetailLengkap(p, signal) {
  var noGardu = (p.noGardu || '').trim().toUpperCase();

  // Gunakan v_gardu_lengkap (view publik) daripada tabel gardu langsung
  var resG = await sbFetch(
    '/rest/v1/v_gardu_lengkap?no_gardu=eq.' + encodeURIComponent(noGardu) + '&limit=1',
    { signal: signal }
  );
  if (!resG.ok) {
    var errTxt = await resG.text().catch(function() { return resG.status; });
    return { status: 'error', message: 'Gagal memuat data gardu (' + resG.status + ').' };
  }

  var garduArr = await resG.json();
  if (!garduArr || !garduArr.length)
    return { status: 'error', message: 'Gardu tidak ditemukan: ' + noGardu };

  var g = garduArr[0];

  // Ambil riwayat inspeksi via REST langsung — agar kolom jurusan JSONB selalu ikut
  var riwayatRows = [];
  try {
    var resI = await sbFetch(
      '/rest/v1/inspeksi?no_gardu=eq.' + encodeURIComponent(noGardu) +
      '&select=*&order=tgl_ukur.desc,jam_ukur.desc&limit=5',
      { signal: signal }
    );
    if (resI.ok) {
      var rawI = await resI.json();
      riwayatRows = (rawI || []).map(function(row) {
        row.ulp                = g.ulp;
        row.unitup             = g.unitup;
        row.penyulang          = g.penyulang;
        row.alamat             = g.alamat;
        row.status_kepemilikan = g.status_kepemilikan;
        return _mapInspeksiRow(row);
      });
    } else {
      // Fallback ke RPC
      var riwayatData = await rpcCall('fn_get_riwayat_inspeksi', { p_no_gardu: noGardu, p_limit: 5 }, signal);
      if (riwayatData && riwayatData.status === 'ok') {
        riwayatRows = (riwayatData.data || []).map(function(r) { return _mapInspeksiRow(r); });
      }
    }
  } catch (e) {
    console.warn('[sbApi] Gagal memuat riwayat inspeksi:', e);
  }

  // Map gardu dari v_gardu_lengkap
  var garduMapped = {
    'NO_GARDU':           g.no_gardu   || '',
    'ULP':                g.ulp        || '',
    'UNITUP':             g.unitup     || '',
    'PENYULANG':          g.penyulang  || '',
    'ALAMAT':             g.alamat     || '',
    'KAPASITAS_KVA':      g.kapasitas_kva != null ? String(g.kapasitas_kva) : '',
    'DAYA_KVA':           g.kapasitas_kva != null ? String(g.kapasitas_kva) : '',
    'TIPE':               g.tipe       || '',
    'MEREK_TRAFO':        g.merek_trafo || '',
    'STATUS_KEPEMILIKAN': g.status_kepemilikan || '',
    'STATUS_OPERASIONAL': g.status_operasional || '',
    'LATITUDE':           g.latitude   || '',
    'LONGITUDE':          g.longitude  || '',
    'KETERANGAN':         g.keterangan || '',
    'SERIAL_NUMBER':      g.serial_number      || '',
    'ARUS_PRIMER':        g.arus_primer        != null ? String(g.arus_primer)        : '',
    'ARUS_SEKUNDER':      g.arus_sekunder      != null ? String(g.arus_sekunder)      : '',
    'TEGANGAN_PRIMER':    g.tegangan_primer    != null ? String(g.tegangan_primer)    : '',
    'TEGANGAN_SEKUNDER':  g.tegangan_sekunder  != null ? String(g.tegangan_sekunder)  : '',
    'FREKUENSI_HZ':       g.frekuensi_hz       != null ? String(g.frekuensi_hz)       : '',
    'VEKTOR_GRUP':        g.vektor_grup        || '',
    'JENIS_OLI':          g.jenis_oli          || '',
    'VOLUME_OLI_LITER':   g.volume_oli_liter   != null ? String(g.volume_oli_liter)   : '',
    'BERAT_TOTAL_KG':     g.berat_total_kg     != null ? String(g.berat_total_kg)     : '',
    'TAHUN_PRODUKSI':     g.tahun_produksi     != null ? String(g.tahun_produksi)     : ''
  };

  return {
    status:  'ok',
    data:    garduMapped,
    riwayat: riwayatRows
  };
}

// ── DETAIL GARDU SAJA ────────────────────────────────────────
async function _getDetailGardu(p, signal) {
  var noGardu = (p.noGardu || '').trim().toUpperCase();
  var res = await sbFetch(
    '/rest/v1/gardu?no_gardu=eq.' + encodeURIComponent(noGardu) + '&limit=1',
    { signal: signal }
  );
  if (!res.ok) return { status: 'error', message: 'Gagal memuat data gardu.' };

  var arr = await res.json();
  if (!arr || !arr.length)
    return { status: 'error', message: 'Gardu tidak ditemukan: ' + noGardu };

  return { status: 'ok', data: _mapGarduRow(arr[0]) };
}

// ── TREN BEBAN via RPC ───────────────────────────────────────
async function _getTrenBeban(p, signal) {
  var data = await rpcCall('fn_get_tren_beban', {
    p_no_gardu: (p.noGardu || '').trim().toUpperCase(),
    p_limit:    100
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: data.message || 'Gagal memuat tren beban.' };

  var rows = (data.data || []).map(function(r) {
    return { tgl: r.tgl_ukur, prosen: parseFloat(r.prosen) };
  });

  return { status: 'ok', data: rows };
}

// ── REKAP DASHBOARD via RPC ──────────────────────────────────
async function _getRekap(p, signal) {
  var ulpFilter = (p && p.ulp) ? _normalizeUlpEnum(p.ulp) : null;
  var data = await rpcCall('fn_get_rekap', { p_ulp: ulpFilter }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: data.message || 'Gagal memuat rekap.' };

  return data;
}

// ── GARDU KRITIS via RPC ─────────────────────────────────────
async function _getGarduKritis(p, signal) {
  var ulpFilter = (p && p.ulp) ? _normalizeUlpEnum(p.ulp) : null;
  var data = await rpcCall('fn_get_gardu_kritis', { p_ulp: ulpFilter }, signal);

  if (!data || data.status !== 'ok') {
    var errMsg = (data && data.message) ? data.message : 'Gagal memuat data gardu kritis.';
    return { status: 'error', message: errMsg };
  }

  return data;
}

// ── EXPORT REKAP via REST (selalu ambil kolom detail lengkap) ──────────────
async function _getExportRekap(p, signal) {
  var ulpFilter = (p && p.ulp) ? _normalizeUlpEnum(p.ulp) : null;

  // STRATEGI EXPORT v9:
  // Langkah 1: Ambil semua data gardu dari v_gardu_lengkap (pagination).
  // Langkah 2: Ambil inspeksi terakhir per gardu LANGSUNG dari tabel inspeksi
  //            via REST (select=*) — ini DIJAMIN mengembalikan semua kolom detail
  //            (r_total, s_total, t_total, n_total, thd_r, thd_s, thd_t, jam_ukur, dll).
  //            fn_get_riwayat_inspeksi TIDAK dipakai di sini karena kadang
  //            tidak mengembalikan field detail sehingga kolom export jadi kosong.
  // Langkah 3: Merge & hitung keterangan otomatis.

  // ── LANGKAH 1: Ambil semua gardu dari v_gardu_lengkap ──────
  var PAGE_SIZE = 500;
  var garduRows = [];
  var offset    = 0;
  var hasMore   = true;
  var baseGarduUrl = '/rest/v1/v_gardu_lengkap?select=*&order=no_gardu.asc';
  if (ulpFilter) baseGarduUrl += '&ulp=eq.' + encodeURIComponent(ulpFilter);

  while (hasMore) {
    var res = await sbFetch(baseGarduUrl, {
      signal: signal,
      headers: {
        'Range-Unit': 'items',
        'Range':      offset + '-' + (offset + PAGE_SIZE - 1),
        'Prefer':     'count=none'
      }
    });
    if (!res.ok) {
      var errTxt = await res.text().catch(function() { return res.status; });
      return { status: 'error', message: 'Gagal memuat data gardu (' + res.status + '): ' + errTxt };
    }
    var batch = await res.json();
    if (!batch || !batch.length) break;
    garduRows = garduRows.concat(batch);
    offset   += PAGE_SIZE;
    hasMore   = batch.length === PAGE_SIZE;
  }

  if (!garduRows.length) {
    return { status: 'error', message: 'Tidak ada data gardu ditemukan.' };
  }

  // ── LANGKAH 2: Ambil inspeksi terakhir per gardu via REST SELECT * ──────
  // Query REST ke tabel inspeksi dengan select=* untuk mendapatkan SEMUA kolom detail.
  // Diurutkan desc sehingga baris pertama per no_gardu adalah yang terbaru.
  var inspMap = {}; // no_gardu → row inspeksi terakhir (dengan semua kolom detail)
  try {
    var inspUrl = '/rest/v1/inspeksi?select=*&order=tgl_ukur.desc,jam_ukur.desc';
    if (ulpFilter) inspUrl += '&ulp=eq.' + encodeURIComponent(ulpFilter);

    var iOff2  = 0;
    var iMore2 = true;
    while (iMore2) {
      var iRes = await sbFetch(inspUrl, {
        signal: signal,
        headers: {
          'Range-Unit': 'items',
          'Range':      iOff2 + '-' + (iOff2 + 999),
          'Prefer':     'count=none'
        }
      });
      if (!iRes.ok) break;
      var iBatch2 = await iRes.json();
      if (!iBatch2 || !iBatch2.length) break;
      iBatch2.forEach(function(r) {
        var key = (r.no_gardu || '').trim().toUpperCase();
        // Simpan hanya yang terbaru per gardu (urutan desc sudah dijaga server)
        if (key && !inspMap[key]) inspMap[key] = r;
      });
      iOff2  += 1000;
      iMore2  = iBatch2.length === 1000;
    }
  } catch (e2) { /* non-fatal — inspMap tetap kosong, gardu ditampilkan tanpa detail */ }

  // Fallback: jika REST inspeksi gagal (misal RLS), coba via RPC
  if (Object.keys(inspMap).length === 0) {
    try {
      var BATCH = 2000;
      var iOff  = 0;
      var iMore = true;
      while (iMore) {
        var iData = await rpcCall('fn_get_riwayat_inspeksi', {
          p_no_gardu:  null,
          p_ulp:       ulpFilter,
          p_tgl_awal:  null,
          p_tgl_akhir: null,
          p_limit:     BATCH,
          p_offset:    iOff
        }, signal);
        if (!iData || iData.status !== 'ok') break;
        var iBatch = iData.data || [];
        iBatch.forEach(function(r) {
          var key = (r.no_gardu || r.noGardu || '').trim().toUpperCase();
          if (key && !inspMap[key]) inspMap[key] = r;
        });
        iOff  += BATCH;
        iMore  = iBatch.length === BATCH;
      }
    } catch (e3) { /* non-fatal */ }
  }

  // 2d. Merge: gabungkan data gardu + inspeksi terakhir
  // Hitung hari sejak inspeksi terakhir
  var today = new Date(); today.setHours(0, 0, 0, 0);

  // Deduplikasi gardu
  var seenGardu = {};
  var merged = [];
  garduRows.forEach(function(g) {
    var key = (g.no_gardu || '').trim().toUpperCase();
    if (!key || seenGardu[key]) return;
    seenGardu[key] = true;

    var ins = inspMap[key] || {};

    // Hari sejak inspeksi
    var tglUkur = ins.tgl_ukur || ins.tglUkur || '';
    var hariSejak = '';
    if (tglUkur) {
      var d = new Date(tglUkur); d.setHours(0, 0, 0, 0);
      hariSejak = String(Math.max(0, Math.round((today - d) / 86400000)));
    }

    // Keterangan otomatis
    var prosen    = ins.prosen != null ? parseFloat(ins.prosen) : NaN;
    var hariNum   = hariSejak !== '' ? parseInt(hariSejak) : NaN;
    var keterangan = '';
    if (!tglUkur) {
      keterangan = 'BELUM INSPEKSI';
    } else if (!isNaN(prosen) && prosen > 80) {
      keterangan = 'BEBAN LEBIH';
    } else if (!isNaN(hariNum) && hariNum > 90) {
      keterangan = 'OVERDUE';
    } else {
      keterangan = 'OK';
    }

    merged.push({
      noGardu:     key,
      ulp:         g.ulp                                          || '',
      unitup:      g.unitup                                        || '',
      penyulang:   g.penyulang                                     || '',
      alamat:      g.alamat                                        || '',
      daya:        g.kapasitas_kva != null ? String(g.kapasitas_kva) : '',
      status:      g.status_operasional                            || '',
      kepemilikan: g.status_kepemilikan                            || '',
      tglUkur:     tglUkur,
      jamUkur:     ins.jam_ukur ? String(ins.jam_ukur).slice(0, 5) : '',
      petugas:     ins.petugas                                     || '',
      prosen:      ins.prosen    != null ? String(ins.prosen)       : '',
      rTotal:      ins.r_total   != null ? String(ins.r_total)      : '',
      sTotal:      ins.s_total   != null ? String(ins.s_total)      : '',
      tTotal:      ins.t_total   != null ? String(ins.t_total)      : '',
      nTotal:      ins.n_total   != null ? String(ins.n_total)      : '',
      thdR:        ins.thd_r     != null ? String(ins.thd_r)        : '',
      thdS:        ins.thd_s     != null ? String(ins.thd_s)        : '',
      thdT:        ins.thd_t     != null ? String(ins.thd_t)        : '',
      hariSejak:   hariSejak,
      keterangan:  keterangan
    });
  });

  return { status: 'ok', data: merged };
}

// ── Helper: normalisasi satu baris export dari RPC ────────────
function _mapExportRow(r) {
  return {
    noGardu:     r.noGardu     || r.no_gardu              || '',
    ulp:         r.ulp                                     || '',
    unitup:      r.unitup                                  || '',
    penyulang:   r.penyulang                               || '',
    alamat:      r.alamat                                  || '',
    daya:        r.daya        != null ? String(r.daya)        : (r.kapasitas_kva != null ? String(r.kapasitas_kva) : ''),
    status:      r.status      || r.status_operasional     || '',
    kepemilikan: r.kepemilikan || r.status_kepemilikan     || '',
    tglUkur:     r.tglUkur     || r.tgl_ukur               || '',
    jamUkur:     (r.jamUkur || r.jam_ukur) ? String(r.jamUkur || r.jam_ukur).slice(0, 5) : '',
    petugas:     r.petugas                                 || '',
    prosen:      r.prosen      != null ? String(r.prosen)      : '',
    rTotal:      r.rTotal      != null ? String(r.rTotal)      : (r.r_total   != null ? String(r.r_total)   : ''),
    sTotal:      r.sTotal      != null ? String(r.sTotal)      : (r.s_total   != null ? String(r.s_total)   : ''),
    tTotal:      r.tTotal      != null ? String(r.tTotal)      : (r.t_total   != null ? String(r.t_total)   : ''),
    nTotal:      r.nTotal      != null ? String(r.nTotal)      : (r.n_total   != null ? String(r.n_total)   : ''),
    thdR:        r.thdR        != null ? String(r.thdR)        : (r.thd_r     != null ? String(r.thd_r)     : ''),
    thdS:        r.thdS        != null ? String(r.thdS)        : (r.thd_s     != null ? String(r.thd_s)     : ''),
    thdT:        r.thdT        != null ? String(r.thdT)        : (r.thd_t     != null ? String(r.thd_t)     : ''),
    hariSejak:   r.hariSejak   != null ? String(r.hariSejak)   : (r.hari_sejak != null ? String(r.hari_sejak) : ''),
    keterangan:  r.keterangan                              || ''
  };
}

// ── VERIFY PIN via RPC ───────────────────────────────────────
async function _verifyPin(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session) return { status: 'error', message: 'Sesi tidak valid.' };

  var pinHash = await sha256(String(p.pin || '').trim());
  var data = await rpcCall('fn_verify_pin', {
    p_username: session.username,
    p_pin_hash: pinHash
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) ? data.message : 'PIN salah.' };

  return { status: 'ok', message: 'PIN benar.' };
}

// ── SET PIN via RPC ──────────────────────────────────────────
async function _setPin(p, signal) {
  var pwHash  = await sha256(String(p.password || '').trim());
  var pinHash = await sha256(String(p.pinBaru  || '').trim());

  var data = await rpcCall('fn_set_pin_user', {
    p_token:         p.token,
    p_password_hash: pwHash,
    p_pin_hash_baru: pinHash
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) ? data.message : 'Gagal menyimpan PIN.' };

  return { status: 'ok', message: data.message };
}

// ── TAMBAH GARDU via RPC ─────────────────────────────────────
async function _tambahGardu(p, signal) {
  var pinHash = await sha256(String(p.pin || '').trim());
  var ulpEnum = _normalizeUlpEnum(p.ulp);

  var data = await rpcCall('fn_tambah_gardu', {
    p_token:              p.token,
    p_pin_hash:           pinHash,
    p_no_gardu:           (p.noGardu || '').trim().toUpperCase(),
    p_ulp:                ulpEnum,
    p_unitup:             p.unitup     || null,
    p_penyulang:          p.penyulang  || null,
    p_alamat:             p.alamat     || null,
    p_kapasitas_kva:      p.daya       ? parseFloat(p.daya) : null,
    p_tipe:               p.tipe       ? String(p.tipe).toUpperCase() : null,
    p_status_kepemilikan: p.kepemilikan ? String(p.kepemilikan).toUpperCase() : null,
    p_status_operasional: p.statusOp   ? String(p.statusOp).toUpperCase() : 'AKTIF',
    p_merek_trafo:        p.merek      || null,
    p_latitude:           p.lat        ? String(p.lat) : null,
    p_longitude:          p.lng        ? String(p.lng) : null,
    p_keterangan:         p.keterangan || null,
    p_serial_number:      p.npSerial             || null,
    p_arus_primer:        p.npArusPrimer         ? parseFloat(p.npArusPrimer)         : null,
    p_arus_sekunder:      p.npArusSekunder       ? parseFloat(p.npArusSekunder)       : null,
    p_tegangan_primer:    p.npTeganganPrimer     ? parseFloat(p.npTeganganPrimer)     : null,
    p_tegangan_sekunder:  p.npTeganganSekunder   ? parseFloat(p.npTeganganSekunder)   : null,
    p_frekuensi_hz:       p.npFrekuensi          ? parseFloat(p.npFrekuensi)          : null,
    p_vektor_grup:        p.npVektor             || null,
    p_jenis_oli:          p.npJenisOli           ? String(p.npJenisOli).toUpperCase() : null,
    p_volume_oli_liter:   p.npVolumeOli          ? parseFloat(p.npVolumeOli)          : null,
    p_berat_total_kg:     p.npBerat              ? parseFloat(p.npBerat)              : null,
    p_tahun_produksi:     p.npTahun              ? parseInt(p.npTahun, 10)            : null
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) ? data.message : 'Gagal menambahkan gardu.' };

  return { status: 'ok', message: data.message };
}

// ── EDIT GARDU via RPC ───────────────────────────────────────
async function _editGardu(p, signal) {
  var pinHash = await sha256(String(p.pin || '').trim());
  var ulpEnum = p.ulp ? _normalizeUlpEnum(p.ulp) : null;
  var noGarduBaru = (p.noGarduBaru || '').trim().toUpperCase();

  var data = await rpcCall('fn_edit_gardu', {
    p_token:              p.token,
    p_pin_hash:           pinHash,
    p_no_gardu_lama:      (p.noGarduLama || '').trim().toUpperCase(),
    p_no_gardu_baru:      noGarduBaru || null,
    p_ulp:                ulpEnum,
    p_unitup:             p.unitup     || null,
    p_penyulang:          p.penyulang  || null,
    p_alamat:             p.alamat     || null,
    p_kapasitas_kva:      p.daya       ? parseFloat(p.daya) : null,
    p_tipe:               p.tipe       ? String(p.tipe).toUpperCase() : null,
    p_status_kepemilikan: p.kepemilikan ? String(p.kepemilikan).toUpperCase() : null,
    p_status_operasional: p.status     ? String(p.status).toUpperCase() : null,
    p_merek_trafo:        p.merek      || null,
    p_latitude:           p.lat        ? String(p.lat) : null,
    p_longitude:          p.lng        ? String(p.lng) : null,
    p_keterangan:         p.keterangan || null,
    p_serial_number:      p.npSerial             || null,
    p_arus_primer:        p.npArusPrimer         ? parseFloat(p.npArusPrimer)         : null,
    p_arus_sekunder:      p.npArusSekunder       ? parseFloat(p.npArusSekunder)       : null,
    p_tegangan_primer:    p.npTeganganPrimer     ? parseFloat(p.npTeganganPrimer)     : null,
    p_tegangan_sekunder:  p.npTeganganSekunder   ? parseFloat(p.npTeganganSekunder)   : null,
    p_frekuensi_hz:       p.npFrekuensi          ? parseFloat(p.npFrekuensi)          : null,
    p_vektor_grup:        p.npVektor             || null,
    p_jenis_oli:          p.npJenisOli           ? String(p.npJenisOli).toUpperCase() : null,
    p_volume_oli_liter:   p.npVolumeOli          ? parseFloat(p.npVolumeOli)          : null,
    p_berat_total_kg:     p.npBerat              ? parseFloat(p.npBerat)              : null,
    p_tahun_produksi:     p.npTahun              ? parseInt(p.npTahun, 10)            : null
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) ? data.message : 'Gagal menyimpan perubahan.' };

  return { status: 'ok', message: data.message };
}

// ── HAPUS GARDU via RPC ──────────────────────────────────────
// DESTRUKTIF: menghapus gardu beserta seluruh riwayat inspeksinya.
// Memerlukan PIN konfirmasi untuk cegah hapus tidak sengaja.
// RPC fn_hapus_gardu harus memverifikasi: token valid, role superadmin
// ATAU staff_up3 (lihat isFullAccessRole() di index.html — staff_up3 punya
// hak akses setara superadmin, RPC SQL ini perlu diupdate agar mengizinkan
// kedua role tsb, bukan hanya 'superadmin'),
// PIN benar, gardu ada — baru kemudian hapus cascade.
async function _hapusGardu(p, signal) {
  if (!p.noGardu) return { status: 'error', message: 'Kode gardu tidak boleh kosong.' };
  if (!p.pin)     return { status: 'error', message: 'PIN konfirmasi diperlukan untuk menghapus gardu.' };

  var pinHash = await sha256(String(p.pin).trim());

  var data = await rpcCall('fn_hapus_gardu', {
    p_token:    p.token,
    p_pin_hash: pinHash,
    p_no_gardu: (p.noGardu || '').trim().toUpperCase()
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal menghapus gardu.' };

  return { status: 'ok', message: data.message || 'Gardu berhasil dihapus.' };
}


async function _getDaftarUser(p, signal) {
  var data = await rpcCall('fn_get_daftar_user', { p_token: p.token }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal memuat daftar user.' };

  return { status: 'ok', data: data.rows || [] };
}

// ── HAPUS USER via RPC ───────────────────────────────────────
async function _hapusUser(p, signal) {
  var data = await rpcCall('fn_hapus_user', {
    p_token:    p.token,
    p_username: p.username
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal menghapus user.' };

  return { status: 'ok', message: data.message };
}

// ── CARI GARDU via RPC ───────────────────────────────────────
async function _cariGardu(p, signal) {
  var data = await rpcCall('fn_search_gardu', {
    p_keyword: (p.keyword || '').trim(),
    p_ulp:     p.ulp ? _normalizeUlpEnum(p.ulp) : null,
    p_limit:   20
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: 'Gagal mencari gardu.' };

  var rows = (data.data || []).map(function(g) {
    return _mapGarduRow(g);
  });

  return { status: 'ok', data: rows };
}

// ── LOGOUT via RPC ───────────────────────────────────────────
async function _logoutUser(p, signal) {
  if (p && p.token) {
    await rpcCall('fn_logout', { p_token: p.token }, signal).catch(function() {});
  }
  return { status: 'ok', message: 'Logout berhasil.' };
}

// ── RIWAYAT INSPEKSI via RPC ─────────────────────────────────
async function _getRiwayat(p, signal) {
  // Jika caller minta offset/limit eksplisit (mis. detail gardu), gunakan single call
  if (p.offset != null || (p.limit && parseInt(p.limit) <= 50)) {
    var data = await rpcCall('fn_get_riwayat_inspeksi', {
      p_no_gardu:  p.noGardu  ? (p.noGardu || '').trim().toUpperCase() : null,
      p_ulp:       p.ulp      ? _normalizeUlpEnum(p.ulp)               : null,
      p_tgl_awal:  p.tglAwal  || null,
      p_tgl_akhir: p.tglAkhir || null,
      p_limit:     p.limit    ? parseInt(p.limit)                       : 5,
      p_offset:    p.offset   ? parseInt(p.offset)                      : 0
    }, signal);
    if (!data || data.status !== 'ok')
      return { status: 'error', message: 'Gagal memuat riwayat inspeksi.' };
    var rows = (data.data || []).map(function(r) { return _mapInspeksiRow(r); });
    return { status: 'ok', data: rows, total: data.total || 0 };
  }

  // ── Mode "ambil semua data" — loop pagination ────────────────
  // Gunakan BATCH_SIZE besar agar jumlah round-trip minimal
  var BATCH_SIZE  = 1000;
  var allRows     = [];
  var offset      = 0;
  var hasMore     = true;
  var serverTotal = 0;

  var baseParams = {
    p_no_gardu:  p.noGardu  ? (p.noGardu || '').trim().toUpperCase() : null,
    p_ulp:       p.ulp      ? _normalizeUlpEnum(p.ulp)               : null,
    p_tgl_awal:  p.tglAwal  || null,
    p_tgl_akhir: p.tglAkhir || null,
    p_limit:     BATCH_SIZE
  };

  while (hasMore) {
    var batchParams = Object.assign({}, baseParams, { p_offset: offset });
    var batchData   = await rpcCall('fn_get_riwayat_inspeksi', batchParams, signal);

    if (!batchData || batchData.status !== 'ok')
      return { status: 'error', message: 'Gagal memuat riwayat inspeksi.' };

    var batchRows = batchData.data || [];
    if (offset === 0) serverTotal = batchData.total || 0;

    allRows = allRows.concat(batchRows);
    offset += BATCH_SIZE;

    // Berhenti jika batch kurang dari BATCH_SIZE (halaman terakhir)
    // atau sudah mencapai total yang dilaporkan server
    hasMore = batchRows.length === BATCH_SIZE && allRows.length < (serverTotal || Infinity);
  }

  var mappedRows = allRows.map(function(r) { return _mapInspeksiRow(r); });
  return { status: 'ok', data: mappedRows, total: serverTotal || mappedRows.length };
}

// ── REKAP GARDU SEDERHANA via REST ───────────────────────────
async function _getRekapGardu(p, signal) {
  var url = '/rest/v1/gardu?select=no_gardu,ulp,unitup,penyulang,status_operasional,status_kepemilikan,tipe,kapasitas_kva&order=ulp.asc,no_gardu.asc';
  if (p && p.ulp) url += '&ulp=eq.' + encodeURIComponent(_normalizeUlpEnum(p.ulp));

  var res = await sbFetch(url, { signal: signal });
  if (!res.ok) return { status: 'error', message: 'Gagal memuat rekap gardu.' };

  var rows = await res.json();
  return {
    status: 'ok',
    data: rows.map(function(g) {
      return {
        noGardu:     g.no_gardu || '',
        ulp:         g.ulp || '',
        unitup:      g.unitup || '',
        penyulang:   g.penyulang || '',
        statusOp:    g.status_operasional || '',
        kepemilikan: g.status_kepemilikan || '',
        tipe:        g.tipe || '',
        daya:        g.kapasitas_kva || ''
      };
    })
  };
}

// ── TAMBAH USER via RPC ──────────────────────────────────────
async function _tambahUser(p, signal) {
  var pwHash = await sha256(String(p.password || '').trim());

  var data = await rpcCall('fn_tambah_user', {
    p_token:         p.token,
    p_username:      (p.username || '').trim().toLowerCase(),
    p_password_hash: pwHash,
    p_nama:          p.nama || '',
    p_role:          p.role || 'petugas',
    p_ulp:           p.ulp  || null
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal tambah user.' };

  return { status: 'ok', message: data.message };
}

// ── EDIT USER via RPC ────────────────────────────────────────
async function _editUser(p, signal) {
  var pwHash = (p.password && String(p.password).trim().length >= 6)
    ? await sha256(String(p.password).trim())
    : null;

  var data = await rpcCall('fn_edit_user', {
    p_token:         p.token,
    p_username_lama: p.usernameLama || p.username,
    p_nama:          p.nama         || null,
    p_role:          p.role         || null,
    p_ulp:           p.ulp !== undefined ? (p.ulp || null) : null,
    p_password_hash: pwHash
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal edit user.' };

  return { status: 'ok', message: data.message };
}

// ── GANTI PASSWORD via RPC ───────────────────────────────────
async function _gantiPassword(p, signal) {
  var oldHash = await sha256(String(p.passwordLama || '').trim());
  var newHash = await sha256(String(p.passwordBaru || '').trim());

  var data = await rpcCall('fn_ganti_password', {
    p_token:              p.token,
    p_password_hash_lama: oldHash,
    p_password_hash_baru: newHash
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal mengubah password.' };

  return { status: 'ok', message: data.message };
}

// ── VERIFY ULP PIN via RPC ───────────────────────────────────
async function _verifyULPPin(p, signal) {
  var pinHash   = await sha256(String(p.pin || '').trim());
  var ulpTarget = (p.ulp || '').trim().toUpperCase();

  var data = await rpcCall('fn_verify_ulp_pin', {
    p_pin_hash:   pinHash,
    p_ulp_target: ulpTarget
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'PIN salah.' };

  return { status: 'ok', role: data.role, ulp: data.ulp };
}

// ── TOGGLE STATUS GARDU via RPC ──────────────────────────────
async function _toggleStatus(p, signal) {
  var data = await rpcCall('fn_toggle_status_gardu', {
    p_token:    p.token,
    p_no_gardu: p.noGardu,
    p_status:   (p.status || 'AKTIF').toUpperCase()
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal mengubah status gardu.' };

  return { status: 'ok', message: data.message };
}

// ── HELPER: Normalisasi array jurusan → JSON string ──────────
// Single source of truth untuk mapping field numerik per jurusan.
// Dipakai oleh _tambahInspeksi dan _editInspeksi agar perbaikan
// field (mis. v_r_s) cukup dilakukan di satu tempat.
function _normalizeJurusanPayload(jurusan) {
  if (!jurusan) return null;
  try {
    var arr = typeof jurusan === 'string' ? JSON.parse(jurusan) : jurusan;
    return JSON.stringify(arr.map(function(j) {
      return {
        nama:    j.nama    || null,
        titik:   j.titik   || null,
        r_total: _parseNumSafe(j.r_total) != null ? _parseNumSafe(j.r_total) : 0,
        s_total: _parseNumSafe(j.s_total) != null ? _parseNumSafe(j.s_total) : 0,
        t_total: _parseNumSafe(j.t_total) != null ? _parseNumSafe(j.t_total) : 0,
        n_total: _parseNumSafe(j.n_total) != null ? _parseNumSafe(j.n_total) : 0,
        v_r_n:   _parseNumSafe(j.v_r_n)   != null ? _parseNumSafe(j.v_r_n)   : 0,
        v_s_n:   _parseNumSafe(j.v_s_n)   != null ? _parseNumSafe(j.v_s_n)   : 0,
        v_t_n:   _parseNumSafe(j.v_t_n)   != null ? _parseNumSafe(j.v_t_n)   : 0,
        v_r_s:   _parseNumSafe(j.v_r_s)   != null ? _parseNumSafe(j.v_r_s)   : 0,
        v_s_t:   _parseNumSafe(j.v_s_t)   != null ? _parseNumSafe(j.v_s_t)   : 0,
        v_r_t:   _parseNumSafe(j.v_r_t)   != null ? _parseNumSafe(j.v_r_t)   : 0,
        thd_r:   _parseNumSafe(j.thd_r)   != null ? _parseNumSafe(j.thd_r)   : 0,
        thd_s:   _parseNumSafe(j.thd_s)   != null ? _parseNumSafe(j.thd_s)   : 0,
        thd_t:   _parseNumSafe(j.thd_t)   != null ? _parseNumSafe(j.thd_t)   : 0,
        ipeak_r: _parseNumSafe(j.ipeak_r) != null ? _parseNumSafe(j.ipeak_r) : 0,
        ipeak_s: _parseNumSafe(j.ipeak_s) != null ? _parseNumSafe(j.ipeak_s) : 0,
        ipeak_t: _parseNumSafe(j.ipeak_t) != null ? _parseNumSafe(j.ipeak_t) : 0,
        tpf_r:   _parseNumSafe(j.tpf_r)   != null ? _parseNumSafe(j.tpf_r)   : 0,
        tpf_s:   _parseNumSafe(j.tpf_s)   != null ? _parseNumSafe(j.tpf_s)   : 0,
        tpf_t:   _parseNumSafe(j.tpf_t)   != null ? _parseNumSafe(j.tpf_t)   : 0
      };
    }));
  } catch (e) {
    return typeof jurusan === 'string' ? jurusan : null;
  }
}

// ── TAMBAH INSPEKSI via RPC ──────────────────────────────────
async function _tambahInspeksi(p, signal) {
  var jurusanPayload = _normalizeJurusanPayload(p.jurusan);

  var data = await rpcCall('fn_tambah_inspeksi', {
    p_token:         p.token,
    p_no_gardu:      (p.noGardu || '').trim().toUpperCase(),
    p_tgl_ukur:      p.tglUkur                               || null,
    p_jam_ukur:      p.jamUkur                               || null,
    p_petugas:       p.petugas                               || null,
    p_daya:          p.daya        ? parseFloat(p.daya)      : null,
    p_fasa:          p.fasa        ? parseInt(p.fasa)        : null,
    p_daya_pakai:    p.dayaPakai   ? parseFloat(p.dayaPakai) : null,
    p_prosen:        p.prosen      ? parseFloat(p.prosen)    : null,
    p_tdk_seimbang:  p.tdkSeimbang ? parseFloat(p.tdkSeimbang) : null,
    p_r_total:       _parseNumSafe(p.rTotal),
    p_s_total:       _parseNumSafe(p.sTotal),
    p_t_total:       _parseNumSafe(p.tTotal),
    p_n_total:       _parseNumSafe(p.nTotal),
    p_v_r_n:         _parseNumSafe(p.vRN),
    p_v_s_n:         _parseNumSafe(p.vSN),
    p_v_t_n:         _parseNumSafe(p.vTN),
    p_v_r_s:         _parseNumSafe(p.vRS),
    p_v_s_t:         _parseNumSafe(p.vST),
    p_v_r_t:         _parseNumSafe(p.vRT),
    p_thd_r:         _parseNumSafe(p.thdR),
    p_thd_s:         _parseNumSafe(p.thdS),
    p_thd_t:         _parseNumSafe(p.thdT),
    p_ipeak_r:       _parseNumSafe(p.ipeakR),
    p_ipeak_s:       _parseNumSafe(p.ipeakS),
    p_ipeak_t:       _parseNumSafe(p.ipeakT),
    p_tpf_r:         _parseNumSafe(p.tpfR),
    p_tpf_s:         _parseNumSafe(p.tpfS),
    p_tpf_t:         _parseNumSafe(p.tpfT),
    p_phase_sequence: p.phaseSequence || null,
    p_jurusan:       jurusanPayload
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal menyimpan inspeksi.' };

  return { status: 'ok', message: data.message, id: data.id };
}

// ── HAPUS INSPEKSI via RPC ───────────────────────────────────
async function _hapusInspeksi(p, signal) {
  var data = await rpcCall('fn_hapus_inspeksi', {
    p_token: p.token,
    p_id:    parseInt(p.id)
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal menghapus inspeksi.' };

  return { status: 'ok', message: data.message };
}

// ── GET DAFTAR INSPEKSI per gardu / per ULP via RPC ─────────
async function _getInspeksi(p, signal) {
  var data = await rpcCall('fn_get_riwayat_inspeksi', {
    p_no_gardu:  p.noGardu  ? (p.noGardu || '').trim().toUpperCase() : null,
    p_ulp:       p.ulp      ? _normalizeUlpEnum(p.ulp)               : null,
    p_tgl_awal:  p.tglAwal  || null,
    p_tgl_akhir: p.tglAkhir || null,
    p_limit:     p.limit    ? parseInt(p.limit)                       : 50,
    p_offset:    p.offset   ? parseInt(p.offset)                      : 0
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal memuat data inspeksi.' };

  return {
    status: 'ok',
    data:   (data.data || []).map(_mapInspeksiRow),
    total:   data.total || 0
  };
}

// ── GET INSPEKSI BY ID — REST (select=* agar jurusan selalu ikut) ──
async function _getInspeksiById(p, signal) {
  var id = parseInt(p.id);
  if (!id) return { status: 'error', message: 'ID tidak valid.' };
  var res = await sbFetch('/rest/v1/inspeksi?select=*&id=eq.' + id + '&limit=1', { signal: signal });
  if (!res.ok) return { status: 'error', message: 'Gagal ambil data (' + res.status + ').' };
  var arr = await res.json();
  if (!arr || !arr.length) return { status: 'error', message: 'Data tidak ditemukan.' };
  var row = arr[0];
  // Inject gardu info dari cache global jika ada
  try {
    var gc = window.garduIndex && window.garduIndex[row.no_gardu];
    if (gc) {
      row.ulp                = row.ulp                || gc['ULP']               || '';
      row.unitup             = row.unitup             || gc['UNITUP']            || '';
      row.penyulang          = row.penyulang          || gc['PENYULANG']         || '';
      row.alamat             = row.alamat             || gc['ALAMAT']            || '';
      row.status_kepemilikan = row.status_kepemilikan || gc['STATUS_KEPEMILIKAN']|| '';
    }
  } catch(e) {}
  return { status: 'ok', data: _mapInspeksiRow(row) };
}

// ── EDIT INSPEKSI via RPC ─────────────────────────────────────
async function _editInspeksi(p, signal) {
  var jurusanPayload = _normalizeJurusanPayload(p.jurusan);

  var data = await rpcCall('fn_edit_inspeksi', {
    p_token:         p.token,
    p_id:            parseInt(p.id),
    p_tgl_ukur:      p.tglUkur                               || null,
    p_jam_ukur:      p.jamUkur                               || null,
    p_petugas:       p.petugas                               || null,
    p_daya:          p.daya        ? parseFloat(p.daya)      : null,
    p_fasa:          p.fasa        ? parseInt(p.fasa)        : null,
    p_daya_pakai:    p.dayaPakai   ? parseFloat(p.dayaPakai) : null,
    p_prosen:        p.prosen      ? parseFloat(p.prosen)    : null,
    p_tdk_seimbang:  p.tdkSeimbang ? parseFloat(p.tdkSeimbang) : null,
    p_r_total:       _parseNumSafe(p.rTotal),
    p_s_total:       _parseNumSafe(p.sTotal),
    p_t_total:       _parseNumSafe(p.tTotal),
    p_n_total:       _parseNumSafe(p.nTotal),
    p_v_r_n:         _parseNumSafe(p.vRN),
    p_v_s_n:         _parseNumSafe(p.vSN),
    p_v_t_n:         _parseNumSafe(p.vTN),
    p_v_r_s:         _parseNumSafe(p.vRS),
    p_v_s_t:         _parseNumSafe(p.vST),
    p_v_r_t:         _parseNumSafe(p.vRT),
    p_thd_r:         _parseNumSafe(p.thdR),
    p_thd_s:         _parseNumSafe(p.thdS),
    p_thd_t:         _parseNumSafe(p.thdT),
    p_ipeak_r:       _parseNumSafe(p.ipeakR),
    p_ipeak_s:       _parseNumSafe(p.ipeakS),
    p_ipeak_t:       _parseNumSafe(p.ipeakT),
    p_tpf_r:         _parseNumSafe(p.tpfR),
    p_tpf_s:         _parseNumSafe(p.tpfS),
    p_tpf_t:         _parseNumSafe(p.tpfT),
    p_phase_sequence: p.phaseSequence || null,
    p_jurusan:       jurusanPayload
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal mengedit inspeksi.' };

  return { status: 'ok', message: data.message };
}

// ── RESET PASSWORD BY ADMIN via RPC ──────────────────────────
async function _resetPasswordByAdmin(p, signal) {
  var pwHash = await sha256(String(p.passwordBaru || '').trim());

  var data = await rpcCall('fn_reset_password_by_admin', {
    p_token:           p.token,
    p_username_target: p.username,
    p_password_hash:   pwHash
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal reset password.' };

  return { status: 'ok', message: data.message };
}

// ── RESET PIN BY ADMIN via RPC ───────────────────────────────
async function _resetPinByAdmin(p, signal) {
  var data = await rpcCall('fn_reset_pin_by_admin', {
    p_token:           p.token,
    p_username_target: p.username
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal reset PIN.' };

  return { status: 'ok', message: data.message };
}

// ── AKTIFKAN USER via RPC ────────────────────────────────────
async function _aktifkanUser(p, signal) {
  var data = await rpcCall('fn_aktifkan_user', {
    p_token:           p.token,
    p_username_target: p.username
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal mengaktifkan user.' };

  return { status: 'ok', message: data.message };
}

// ── STATISTIK ULP via RPC ────────────────────────────────────
async function _statistikUlp(p, signal) {
  var data = await rpcCall('fn_get_statistik_ulp', {
    p_ulp: _normalizeUlpEnum(p.ulp)
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal memuat statistik ULP.' };

  return data;
}

// ── MAINTENANCE CLEANUP via RPC ──────────────────────────────
async function _maintenanceCleanup(p, signal) {
  var data = await rpcCall('fn_maintenance_cleanup_sessions', {}, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal cleanup sessions.' };

  return { status: 'ok', message: data.message };
}

// ── HELPER: Map row gardu ────────────────────────────────────
function _mapGarduRow(g) {
  return {
    'NO_GARDU':           g.no_gardu   || '',
    'ULP':                g.ulp        || '',
    'UNITUP':             g.unitup     || '',
    'PENYULANG':          g.penyulang  || '',
    'ALAMAT':             g.alamat     || '',
    'KAPASITAS_KVA':      g.kapasitas_kva != null ? String(g.kapasitas_kva) : '',
    'DAYA_KVA':           g.kapasitas_kva != null ? String(g.kapasitas_kva) : '',
    'TIPE':               g.tipe       || '',
    'MEREK_TRAFO':        g.merek_trafo || '',
    'STATUS_KEPEMILIKAN': g.status_kepemilikan || '',
    'STATUS_OPERASIONAL': g.status_operasional || '',
    'LATITUDE':           g.latitude   || '',
    'LONGITUDE':          g.longitude  || '',
    'KETERANGAN':         g.keterangan || '',
    'SERIAL_NUMBER':      g.serial_number      || '',
    'ARUS_PRIMER':        g.arus_primer        != null ? String(g.arus_primer)        : '',
    'ARUS_SEKUNDER':      g.arus_sekunder      != null ? String(g.arus_sekunder)      : '',
    'TEGANGAN_PRIMER':    g.tegangan_primer    != null ? String(g.tegangan_primer)    : '',
    'TEGANGAN_SEKUNDER':  g.tegangan_sekunder  != null ? String(g.tegangan_sekunder)  : '',
    'FREKUENSI_HZ':       g.frekuensi_hz       != null ? String(g.frekuensi_hz)       : '',
    'VEKTOR_GRUP':        g.vektor_grup        || '',
    'JENIS_OLI':          g.jenis_oli          || '',
    'VOLUME_OLI_LITER':   g.volume_oli_liter   != null ? String(g.volume_oli_liter)   : '',
    'BERAT_TOTAL_KG':     g.berat_total_kg     != null ? String(g.berat_total_kg)     : '',
    'TAHUN_PRODUKSI':     g.tahun_produksi     != null ? String(g.tahun_produksi)     : ''
  };
}

// ── HELPER: Map row inspeksi ─────────────────────────────────
function _mapInspeksiRow(r) {
  var flat = {
    '_id':          r.id         != null ? r.id : null,
    'NO_GARDU':     r.no_gardu   || '',
    'NOGARDU':      r.no_gardu   || '',
    'ULP':          r.ulp        || '',
    'UNITUP':       r.unitup     || '',
    'PENYULANG':    r.penyulang  || '',
    'ALAMAT':       r.alamat     || '',
    'STATUS_KEPEMILIKAN': r.status_kepemilikan || '',
    'TGLUKUR':      r.tgl_ukur   || '',
    'JAM UKUR':     r.jam_ukur   ? String(r.jam_ukur).slice(0, 5) : '',
    'PETUGAS':      r.petugas    || '',
    'DAYA':         r.daya       != null ? String(r.daya)       : '',
    'FASA':         r.fasa       != null ? String(r.fasa)       : '',
    'DAYA PAKAI':   r.daya_pakai != null ? String(r.daya_pakai) : '',
    'PROSEN':       r.prosen     != null ? String(r.prosen)     : '',
    'TDKSEIMBANG':  r.tdk_seimbang != null ? String(r.tdk_seimbang) : '',
    'TDK SEIMBANG': r.tdk_seimbang != null ? String(r.tdk_seimbang) : '',
    'R TOTAL':      r.r_total    != null ? String(r.r_total)    : '',
    'S TOTAL':      r.s_total    != null ? String(r.s_total)    : '',
    'T TOTAL':      r.t_total    != null ? String(r.t_total)    : '',
    'N TOTAL':      r.n_total    != null ? String(r.n_total)    : '',
    'R - N':        r.v_r_n      != null ? String(r.v_r_n)      : '',
    'S - N':        r.v_s_n      != null ? String(r.v_s_n)      : '',
    'T - N':        r.v_t_n      != null ? String(r.v_t_n)      : '',
    'R - S':        r.v_r_s      != null ? String(r.v_r_s)      : '',
    'S - T':        r.v_s_t      != null ? String(r.v_s_t)      : '',
    'R - T':        r.v_r_t      != null ? String(r.v_r_t)      : '',
    'THD-R':        r.thd_r      != null ? String(r.thd_r)      : '',
    'THD-S':        r.thd_s      != null ? String(r.thd_s)      : '',
    'THD-T':        r.thd_t      != null ? String(r.thd_t)      : '',
    'IPEAK-R':      r.ipeak_r    != null ? String(r.ipeak_r)    : '',
    'IPEAK-S':      r.ipeak_s    != null ? String(r.ipeak_s)    : '',
    'IPEAK-T':      r.ipeak_t    != null ? String(r.ipeak_t)    : '',
    'TPF-R':        r.tpf_r      != null ? String(r.tpf_r)      : '',
    'TPF-S':        r.tpf_s      != null ? String(r.tpf_s)      : '',
    'TPF-T':        r.tpf_t      != null ? String(r.tpf_t)      : '',
    'PHASE_SEQUENCE': r.phase_sequence || ''
  };

  var jurusan = [];
  try {
    jurusan = typeof r.jurusan === 'string'
      ? JSON.parse(r.jurusan)
      : (r.jurusan || []);
  } catch (e) {}

  // Simpan array asli agar bukaEditInspeksi bisa membaca data jurusan langsung
  // tanpa harus reconstruct dari flat keys (yang rentan bug key mismatch)
  flat._jurusanRaw = jurusan;

  // Always output 6 jurusan slots — fill with 0 if not present
  for (var idx = 0; idx < 6; idx++) {
    var j = jurusan[idx] || {};
    var n = idx + 1;
    flat['JURUSAN ' + n]           = j.nama     || '';
    flat['JUR' + n + '_R_TOTAL']   = j.r_total  != null ? String(j.r_total)  : '0';
    flat['JUR' + n + '_S_TOTAL']   = j.s_total  != null ? String(j.s_total)  : '0';
    flat['JUR' + n + '_T_TOTAL']   = j.t_total  != null ? String(j.t_total)  : '0';
    flat['JUR' + n + '_N_TOTAL']   = j.n_total  != null ? String(j.n_total)  : '0';
    flat['JUR' + n + '_R-N']       = j.v_r_n    != null ? String(j.v_r_n)    : '0';
    flat['JUR' + n + '_S-N']       = j.v_s_n    != null ? String(j.v_s_n)    : '0';
    flat['JUR' + n + '_T-N']       = j.v_t_n    != null ? String(j.v_t_n)    : '0';
    flat['JUR' + n + '_R-S']       = j.v_r_s    != null ? String(j.v_r_s)    : '0';
    flat['JUR' + n + '_S-T']       = j.v_s_t    != null ? String(j.v_s_t)    : '0';
    flat['JUR' + n + '_R-T']       = j.v_r_t    != null ? String(j.v_r_t)    : '0';
    flat['JUR' + n + '_THD-R']     = j.thd_r    != null ? String(j.thd_r)    : '0';
    flat['JUR' + n + '_THD-S']     = j.thd_s    != null ? String(j.thd_s)    : '0';
    flat['JUR' + n + '_THD-T']     = j.thd_t    != null ? String(j.thd_t)    : '0';
    flat['JUR' + n + '_IPEAK-R']   = j.ipeak_r  != null ? String(j.ipeak_r)  : '0';
    flat['JUR' + n + '_IPEAK-S']   = j.ipeak_s  != null ? String(j.ipeak_s)  : '0';
    flat['JUR' + n + '_IPEAK-T']   = j.ipeak_t  != null ? String(j.ipeak_t)  : '0';
    flat['JUR' + n + '_TPF-R']     = j.tpf_r    != null ? String(j.tpf_r)    : '0';
    flat['JUR' + n + '_TPF-S']     = j.tpf_s    != null ? String(j.tpf_s)    : '0';
    flat['JUR' + n + '_TPF-T']     = j.tpf_t    != null ? String(j.tpf_t)    : '0';
    flat['JUR' + n + '_TITIK_UKUR'] = j.titik   || '';
    // Backward compat aliases
    flat['JUR' + n + '_R TOTAL']   = flat['JUR' + n + '_R_TOTAL'];
    flat['JUR' + n + '_S TOTAL']   = flat['JUR' + n + '_S_TOTAL'];
    flat['JUR' + n + '_T TOTAL']   = flat['JUR' + n + '_T_TOTAL'];
    flat['JUR' + n + '_N TOTAL']   = flat['JUR' + n + '_N_TOTAL'];
    flat['JUR' + n + '_R - N']     = flat['JUR' + n + '_R-N'];
    flat['JUR' + n + '_S - N']     = flat['JUR' + n + '_S-N'];
    flat['JUR' + n + '_T - N']     = flat['JUR' + n + '_T-N'];
    flat['JUR' + n + '_R - S']     = flat['JUR' + n + '_R-S'];
    flat['JUR' + n + '_S - T']     = flat['JUR' + n + '_S-T'];
    flat['JUR' + n + '_R - T']     = flat['JUR' + n + '_R-T'];
  }

  return flat;
}

// ── TAMBAH PEMELIHARAAN via RPC ───────────────────────────────
async function _tambahPemeliharaan(p, signal) {
  var data = await rpcCall('fn_tambah_pemeliharaan', {
    p_token:     p.token,
    p_no_gardu:  (p.noGardu || '').trim().toUpperCase(),
    p_ulp:       p.ulp      || null,
    p_tanggal:   p.tanggal  || null,
    p_petugas:   p.petugas  || null,
    p_kategori:  p.kategori || null,
    p_jenis:     p.jenis    || null,
    p_catatan:   p.catatan  || '',
    p_foto_urls: Array.isArray(p.fotoUrls) ? p.fotoUrls : []
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal menyimpan data pemeliharaan.' };

  return { status: 'ok', message: data.message, id: data.id };
}

// ── GET DAFTAR PEMELIHARAAN via RPC ──────────────────────────
async function _getDaftarPemeliharaan(p, signal) {
  // Catatan: p_ulp tidak dikirim ke RPC karena filter ULP dilakukan di DB
  // berdasarkan role user (superadmin & staff_up3 lihat semua ULP, selain
  // itu hanya ULP sendiri — pastikan fn_get_pemeliharaan sudah diupdate
  // untuk mengenali role staff_up3 juga, bukan hanya 'superadmin').
  // Filter tambahan (kategori, ulp) dilakukan di sisi klien setelah data diterima.
  // p_status TIDAK dikirim karena kolom status tidak ada di tabel pemeliharaan.
  // catatan & foto_urls otomatis ikut di response RPC (sudah ditambahkan di fn_get_pemeliharaan).
  var rpcParams = {
    p_token:     p.token,
    p_no_gardu:  p.noGardu  ? (p.noGardu || '').trim().toUpperCase() : null,
    p_tgl_awal:  p.tglAwal  || null,
    p_tgl_akhir: p.tglAkhir || null,
    p_limit:     p.limit    ? parseInt(p.limit)                       : 200,
    p_offset:    p.offset   ? parseInt(p.offset)                      : 0
  };
  var data = await rpcCall('fn_get_pemeliharaan', rpcParams, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal memuat data pemeliharaan.' };

  return { status: 'ok', data: data.data || [], total: data.total || 0 };
}

// ── HAPUS PEMELIHARAAN via RPC ────────────────────────────────
async function _hapusPemeliharaan(p, signal) {
  var data = await rpcCall('fn_hapus_pemeliharaan', {
    p_token: p.token,
    p_id:    parseInt(p.id)
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal menghapus data pemeliharaan.' };

  return { status: 'ok', message: data.message };
}

// ── EDIT PEMELIHARAAN via RPC ─────────────────────────────────
// CATATAN: fn_edit_pemeliharaan TIDAK menerima p_ulp (ULP tidak bisa diedit,
// sesuai signature SQL final). Jangan kirim p_ulp ke RPC ini.
// p_catatan & p_foto_urls wajib diisi (validasi server-side menolak jika kosong).
async function _editPemeliharaan(p, signal) {
  var data = await rpcCall('fn_edit_pemeliharaan', {
    p_token:     p.token,
    p_id:        parseInt(p.id),
    p_tanggal:   p.tanggal  || null,
    p_petugas:   p.petugas  || null,
    p_kategori:  p.kategori || null,
    p_jenis:     p.jenis    || null,
    p_catatan:   p.catatan  || '',
    p_foto_urls: Array.isArray(p.fotoUrls) ? p.fotoUrls : []
  }, signal);

  if (!data || data.status !== 'ok')
    return { status: 'error', message: (data && data.message) || 'Gagal mengedit data pemeliharaan.' };

  return { status: 'ok', message: data.message };
}

// ── UPLOAD FOTO PEMELIHARAAN ke Supabase Storage ─────────────
// Mengembalikan { status:'ok', url:'...', path:'...' } atau { status:'error', message:'...' }
async function _uploadFotoPemeliharaan(file, signal) {
  var ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  var rand = Math.random().toString(36).slice(2, 8);
  var ts   = Date.now();
  var path = 'foto/' + ts + '_' + rand + '.' + ext;

  var res = await fetch(SUPABASE_URL + '/storage/v1/object/pemeliharaan-foto/' + path, {
    method:  'POST',
    headers: {
      'apikey':        SUPABASE_ANON,
      'Authorization': 'Bearer ' + SUPABASE_ANON,
      'Content-Type':  file.type || 'image/jpeg',
      'x-upsert':      'false'
    },
    body:   file,
    signal: signal
  });

  if (!res.ok) {
    var errTxt = await res.text().catch(function() { return String(res.status); });
    return { status: 'error', message: 'Gagal upload foto: ' + errTxt };
  }

  var publicUrl = SUPABASE_URL + '/storage/v1/object/public/pemeliharaan-foto/' + path;
  return { status: 'ok', url: publicUrl, path: path };
}

// ── HAPUS FOTO PEMELIHARAAN dari Supabase Storage ─────────────
// path = bagian setelah bucket, contoh: "foto/1234_abc.jpg"
async function _hapusFotoPemeliharaan(path, signal) {
  var res = await fetch(SUPABASE_URL + '/storage/v1/object/pemeliharaan-foto/' + path, {
    method:  'DELETE',
    headers: {
      'apikey':        SUPABASE_ANON,
      'Authorization': 'Bearer ' + SUPABASE_ANON
    },
    signal: signal
  });
  return res.ok
    ? { status: 'ok' }
    : { status: 'error', message: 'Gagal hapus foto (status ' + res.status + ')' };
}

// ── Override apiGet global ────────────────────────────────────
window.apiGet = function(params, cb) {
  var action = params.action || '';
  var p = Object.assign({}, params);
  delete p.action;
  apiCall(action, p, cb);
};

window._sbApiReady = true;
window.uploadFotoPemeliharaan = _uploadFotoPemeliharaan;
window.hapusFotoPemeliharaan  = _hapusFotoPemeliharaan;
console.log('[Supabase API v8] Layer aktif. URL:', SUPABASE_URL);