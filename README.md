# Remote Browser Bridge

Kontrol Chrome asli kamu dari OpenCode, Claude Code, Claude Desktop, Codex, atau MCP client lain. Extension Chrome membaca dan menggerakkan tab yang sedang kamu pakai, lengkap dengan session login, cookie, dan 2FA yang sudah ada.

Ini bukan pengganti Playwright MCP. Playwright selalu membuka browser baru. Proyek ini menempel ke Chrome harian kamu.

## Cara kerja

```
MCP client (OpenCode, Claude, Codex)
        │  stdio MCP
        ▼
packages/server/dist/index.js        tipis, satu proses per client
        │  WebSocket 127.0.0.1:8765
        ▼
packages/server/dist/bridge.js       daemon lokal, auto-spawn, token
        │  WebSocket 127.0.0.1:8765
        ▼
Chrome extension (MV3)               content script + chrome.debugger
        │
        ▼
Tab Chrome asli kamu
```

Bridge hidup terpisah dari MCP client. Ketika OpenCode restart, extension tidak perlu reconnect ulang. Kalau bridge belum ada, server MCP menyalakannya sendiri dalam mode detached.

## Kebutuhan

- Node.js 20.11 atau lebih baru
- Chrome 116 atau lebih baru (extension butuh WebSocket di service worker)
- MCP client yang mendukung server stdio

## Instalasi

```bash
git clone https://github.com/jamaahpees/mcp-remote-chrome-extension.git
cd mcp-remote-chrome-extension
npm install
npm run build
```

1. Buka `chrome://extensions`, aktifkan **Developer mode**.
2. Klik **Load unpacked**, pilih folder `packages/extension/dist`.
3. Jalankan sekali server MCP supaya token dibuat:

   ```bash
   node packages/server/dist/index.js
   ```

   Server menunggu di stdio, tekan `Ctrl+C` setelah beberapa detik.

4. Buka token:

   - Windows: `%APPDATA%\mcp-remote-chrome\token`
   - Linux/macOS: `~/.config/mcp-remote-chrome/token`

5. Klik ikon extension, tempel token, klik **Save**. Pastikan status berubah menjadi **Connected**.
6. Buka **Options** kalau perlu mengubah port atau membatasi origin.

Kalau tidak ingin menyalin token, jalankan server dengan `MCP_BROWSER_ALLOW_LOCAL_PAIRING=1`. Extension akan meminta token sendiri ke bridge lewat `POST /pair` saat pertama kali terhubung, lalu menyimpannya. Endpoint itu hanya menjawab origin `chrome-extension://`, menolak halaman web biasa, dan bisa dipersempit dengan `MCP_BROWSER_PAIR_ORIGINS`.

## Konfigurasi MCP client

Ganti `<path-to-repo>` dengan path absolut repo ini.

### OpenCode

`~/.config/opencode/opencode.jsonc` (global) atau `opencode.jsonc` di root project:

```jsonc
{
  "mcp": {
    "servers": {
      "chrome": {
        "type": "local",
        "command": ["node", "<path-to-repo>/packages/server/dist/index.js"]
      }
    }
  }
}
```

Tool akan muncul sebagai `chrome_browser_navigate`, `chrome_browser_snapshot`, dan seterusnya. Verifikasi dengan `opencode mcp list`.

### Claude Code

```bash
claude mcp add chrome -- node <path-to-repo>/packages/server/dist/index.js
```

### Claude Desktop

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["<path-to-repo>/packages/server/dist/index.js"]
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.chrome]
command = "node"
args = ["<path-to-repo>/packages/server/dist/index.js"]
```

## Variabel lingkungan

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `MCP_BROWSER_PORT` | `8765` | Port bridge. Ubah di server dan di extension options. |
| `MCP_BROWSER_HOME` | folder config OS | Lokasi token dan `bridge.json`. |
| `MCP_BROWSER_ALLOW_EVAL` | mati | Set `1` untuk mengaktifkan tool `browser_evaluate`. |
| `MCP_BROWSER_DEBUG` | mati | Set `1` untuk log protokol bridge ke stderr. |
| `MCP_BROWSER_ALLOW_LOCAL_PAIRING` | mati | Set `1` supaya extension bisa mengambil token sendiri lewat `POST /pair`. |
| `MCP_BROWSER_PAIR_ORIGINS` | kosong | Daftar origin extension yang boleh pairing, dipisah koma. Kosong berarti semua origin `chrome-extension://`. |

Kalau `MCP_BROWSER_ALLOW_EVAL=1` dipasang di config MCP, tool `browser_evaluate` ikut terdaftar. Tanpa itu, tool tidak dikirim ke model sama sekali.

## Tool

| Tool | Fungsi |
| --- | --- |
| `browser_status` | Status bridge, extension, tab aktif, dialog yang menunggu, dan CDP. |
| `browser_tabs` | `list`, `new`, `close`, `activate`. |
| `browser_navigate` | Buka URL dan tunggu load. |
| `browser_go_back` | Mundur satu riwayat. |
| `browser_snapshot` | Accessibility tree dengan `ref=e12`. Mode `full`, `interactive`, `diff`. |
| `browser_get_text` | Baca teks elemen atau seluruh halaman. |
| `browser_click` | Klik via ref atau selector. `trusted: true` memakai CDP. |
| `browser_type` | Isi field dan opsi submit. Aman untuk React/Vue controlled input. |
| `browser_press_key` | Enter, Escape, Tab, `Control+A`, dan sejenisnya. |
| `browser_hover` | Buka menu hover. |
| `browser_select_option` | Pilih opsi pada `<select>`. |
| `browser_scroll` | Scroll halaman atau elemen. |
| `browser_wait_for` | Tunggu selector, teks, atau perubahan URL. |
| `browser_screenshot` | PNG viewport, full page, atau elemen. |
| `browser_console` | Buffer console dan exception dari tab. |
| `browser_network` | Buffer request dan status response. |
| `browser_handle_dialog` | Terima atau tolak `alert`, `confirm`, `prompt`. |
| `browser_evaluate` | Jalankan JavaScript di halaman. Hanya jika diaktifkan. |

### Snapshot, bukan dump HTML

Model menerima pohon semantik yang ringkas:

```
[page] https://shop.example.com/checkout
[title] Checkout
  - heading "Keranjang" [level=2] ref=e2
  - listitem "Kaos Hitam" ref=e5
    - button "Hapus" ref=e6
  - textbox "Kode promo" ref=e9
  - button "Terapkan" [disabled] ref=e10
  - combobox "Kurir" value="JNE Reguler" ref=e12
  - button "Bayar Sekarang" ref=e15
```

Mode `diff` hanya mengirim node yang berubah sejak snapshot sebelumnya, dan `interactive` menyaring ke elemen yang bisa diapa-apakan. Ref yang sudah tidak valid dikembalikan sebagai error `stale_ref`, bukan klik ke elemen yang salah.

### Memilih tab target

Popup extension menampilkan daftar tab yang terbuka. Klik satu tab untuk mengunci target, atau biarkan **Follow active tab** aktif. Urutan pemilihan:

1. `tabId` yang dikirim tool, kalau ada.
2. Tab yang dipilih di popup.
3. Tab aktif, kalau tidak ada yang dipilih.

Kalau tab yang dipilih ditutup, extension otomatis kembali ke mode follow active tab. Popup juga menampilkan alamat bridge dan panjang token, jadi kamu bisa membedakan masalah token dengan masalah koneksi.

### Cookie tools (opsional)

Halaman **Cookies** di extension bisa membaca, menyalin, mengimpor, dan menghapus cookie untuk satu domain. Tidak perlu extension Cookie-Editor lagi. Fitur ini **mati secara default** dan harus dinyalakan dengan satu klik.

- **Read cookies** memanggil `chrome.cookies.getAll` untuk domain yang kamu isi
- **Copy JSON** dan **Download JSON** menghasilkan format yang sama dengan export Cookie-Editor
- **Import cookies** menerima JSON yang ditempel, memvalidasi, lalu memasang lewat `chrome.cookies.set`
- **Delete cookies for this domain** butuh dua klik konfirmasi
- Nilai cookie ditampilkan tersembunyi sampai kamu mencentang **Show values**

Nilai cookie tidak pernah dikirim ke MCP server, tidak masuk log, dan tidak muncul di popup. Yang keluar dari browser hanya yang kamu salin atau unduh sendiri.

## Keamanan

- Bridge hanya listen di `127.0.0.1`, tidak pernah ke jaringan.
- Setiap koneksi wajib mengirim token. Token dibuat acak dan disimpan di folder config OS.
- Extension menolak `chrome://`, `chrome-extension://`, Web Store, `file://`, dan `data:`.
- Allowlist origin di halaman options kosong berarti semua situs http/https diizinkan. Isi allowlist kalau kamu ingin membatasi.
- Permission `debugger` memunculkan peringatan saat instalasi. CDP hanya dipasang saat tool console, network, screenshot, dialog, atau `trusted` click dipanggil, lalu dilepas setelah 30 detik idle.
- Tool `browser_evaluate` mati secara default karena itu jalur paling berbahaya.
- Cookie tools mati secara default. Permission `cookies` memberi extension akses ke nilai cookie, termasuk yang `HttpOnly`, jadi perlakukan hasil export sebagai kredensial session penuh. Jangan tempel ke chat, jangan simpan di repo.
- Import cookie hanya untuk akun dan session milikmu sendiri. Memasang cookie milik orang lain sama dengan membajak session.
- Extension tidak membaca, mengekspor, atau mengirim cookie situs. Session tetap di Chrome, dan agent hanya melihat DOM tab yang dipilih. Tidak ada fitur cookie sync, dan memang tidak dibutuhkan untuk kontrol browser.
- Local pairing menerima origin `chrome-extension://` saja, bukan halaman web. Saat diaktifkan, extension lain di profil Chrome yang sama juga bisa meminta token, jadi aktifkan hanya di profil yang kamu percaya. Untuk mengunci satu extension, isi `MCP_BROWSER_PAIR_ORIGINS`.

Extension ini memberi agent kontrol penuh atas tab yang diizinkan. Jangan pasang di profil Chrome yang kamu pakai untuk perbankan atau data sensitif tanpa allowlist.

## Batasan

- Halaman `chrome://`, Chrome Web Store, dan halaman extension lain tidak bisa dikontrol. Chrome memblokir injection.
- Isi iframe lintas origin tidak dibaca. Snapshot hanya menampilkan node `iframe`.
- Aplikasi canvas atau WebGL, misalnya Figma atau peta, hampir tidak punya DOM. Pakai `browser_screenshot` dan koordinat.
- PDF viewer internal Chrome tidak bisa diotomasi.
- Shadow DOM terbuka ikut dibaca. Shadow DOM tertutup tidak.
- Dialog JavaScript memblokir tab. Panggil `browser_handle_dialog` sebelum tool lain.
- Extension berhenti kalau Chrome ditutup. Bridge tetap hidup dan menunggu reconnect.

## Development

```bash
npm run typecheck     # tsc untuk server dan extension
npm run build         # dist/server dan dist/extension
npm test              # build + unit MCP + e2e Chrome asli
```

Test e2e memakai Chromium dari Playwright atau `CHROME_PATH`. Chrome branded versi 137 ke atas mengabaikan `--load-extension`, jadi test memakai Chromium/Chrome for Testing.

Struktur:

```
packages/server/src/
  index.ts        entry MCP stdio
  tools.ts        definisi 18 tool
  bridge.ts       daemon WebSocket
  client.ts       client protokol
  ensureBridge.ts auto-spawn
packages/extension/src/
  background.ts   service worker, CDP, tab lifecycle
  content.ts      aksi DOM
  snapshot.ts     snapshot engine dan ref map
  popup.*, options.*
fixtures/          halaman uji
tests/             mcp.test.mjs, e2e.test.mjs
```

## Troubleshooting

| Gejala | Penyebab dan solusi |
| --- | --- |
| Status **Waiting** terus | Bridge belum jalan. Buka MCP client atau jalankan `node packages/server/dist/index.js`. |
| Status **Needs attention** | Token di extension berbeda dengan file token. Salin ulang, lalu lihat detail di popup. |
| Extension tidak muncul di `chrome://extensions` | Folder yang dipilih salah atau Chrome memakai profil lain. Pilih `packages/extension/dist` yang berisi `manifest.json`. |
| Popup menampilkan token 0 chars | Token belum tersimpan. Paste ulang token dari file, lalu Save. |
| Token 3000+ chars atau pesan "cookie export" | Yang ditempel adalah export cookie, bukan token bridge. Hapus extension lalu load ulang untuk membersihkan storage, lalu paste token 32 karakter. |
| `extension_offline` | Chrome tertutup atau extension di-pause. Buka Chrome dan cek popup. |
| `page_not_controllable` | Tab berada di halaman sistem Chrome. Pindah ke http atau https. |
| `origin_not_allowed` | Origin tidak ada di allowlist extension options. |
| `cdp_unavailable` | DevTools sedang terbuka di tab itu, atau diblokir kebijakan enterprise. Tutup DevTools. |
| `stale_ref` | DOM berubah. Ambil `browser_snapshot` baru. |
| `injection_blocked` | Halaman memblokir content script, biasanya Chrome Web Store. |
| `npm run build` gagal karena esbuild | npm 11 memblokir postinstall. Jalankan `npm approve-scripts esbuild` lalu `npm rebuild esbuild`. |
| Port bentrok atau token ditolak | Ada bridge lain di port yang sama. Hentikan prosesnya atau ganti `MCP_BROWSER_PORT`. |

## Lisensi

MIT
