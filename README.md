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

## Keamanan

- Bridge hanya listen di `127.0.0.1`, tidak pernah ke jaringan.
- Setiap koneksi wajib mengirim token. Token dibuat acak dan disimpan di folder config OS.
- Extension menolak `chrome://`, `chrome-extension://`, Web Store, `file://`, dan `data:`.
- Allowlist origin di halaman options kosong berarti semua situs http/https diizinkan. Isi allowlist kalau kamu ingin membatasi.
- Permission `debugger` memunculkan peringatan saat instalasi. CDP hanya dipasang saat tool console, network, screenshot, dialog, atau `trusted` click dipanggil, lalu dilepas setelah 30 detik idle.
- Tool `browser_evaluate` mati secara default karena itu jalur paling berbahaya.

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
| Status **Needs attention** | Token di extension berbeda dengan file token. Salin ulang. |
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
