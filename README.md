# vidEdit

**軽量・高速にこだわったクロスプラットフォーム動画編集ソフト**

Tauri 2 (Rust) 製。Electron 系エディタと違いシステム WebView を使うため、バイナリは数 MB 級・起動は一瞬・メモリ消費はごくわずかです。Windows / macOS / Linux に対応しています。

## 特徴

- 🎬 **Premiere ライクなタイムライン編集** — 複数ビデオ/オーディオトラック、クリップのドラッグ移動・トリム・分割・削除、スナップ、ズーム
- ⚡ **軽量・高速** — Rust バックエンド + 依存ライブラリ最小のフロントエンド(フレームワーク不使用、Canvas 直描画)
- 🖼️ **リアルタイムプレビュー** — 不透明度・音量を反映した多トラック合成プレビュー
- 📦 **FFmpeg による書き出し** — H.264/AAC MP4 出力、進捗表示・キャンセル対応
- 💾 **オープンなプロジェクト形式 `.vep`** — ただの JSON。仕様は [docs/DESIGN.md](docs/DESIGN.md) に公開
- 🔄 **自動アップデート** — GitHub Releases から署名検証付きで自動更新
- ↩️ **Undo / Redo**、キーボードショートカット対応

## インストール

### Windows

```powershell
irm https://raw.githubusercontent.com/dikmri/vidEdit/main/install.ps1 | iex
```

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/dikmri/vidEdit/main/install.sh | sh
```

[Releases](https://github.com/dikmri/vidEdit/releases/latest) からインストーラを直接ダウンロードすることもできます(Windows: `-setup.exe` / macOS: `.dmg` / Linux: `.AppImage`)。

### 必須: FFmpeg

書き出しとメディア解析に FFmpeg を使用します(同梱していないため別途インストールしてください):

| OS | コマンド |
|---|---|
| Windows | `winget install Gyan.FFmpeg` |
| macOS | `brew install ffmpeg` |
| Linux | `sudo apt install ffmpeg` |

> Linux でプレビューに H.264 動画が表示されない場合は、WebKitGTK 用の GStreamer コーデック(`gstreamer1.0-plugins-good` / `gstreamer1.0-libav` など)をインストールしてください。

## 使い方

1. **「+ メディア」** で動画・音声・画像を読み込む
2. メディアビンからタイムラインへドラッグして配置
3. クリップをドラッグで移動、端をドラッグでトリム、`S` で分割、`Delete` で削除
4. **「書き出し」** で MP4 に出力

### ショートカット

| キー | 動作 |
|---|---|
| `Space` | 再生 / 停止 |
| `←` / `→` | 1 フレーム移動 |
| `S` | 再生ヘッド位置で分割 |
| `Delete` | 選択クリップを削除 |
| `Ctrl+Z` / `Ctrl+Y` | 元に戻す / やり直し |
| `Ctrl+N` / `Ctrl+O` / `Ctrl+S` | 新規 / 開く / 保存 |
| `Ctrl+ホイール` | タイムラインをズーム |

## プロジェクト形式 (.vep)

`.vep` はオープンな JSON 形式です。時刻はすべて秒、`start` がタイムライン上の位置、`in`/`out` がソース内の使用範囲を表します。完全な仕様は [docs/DESIGN.md](docs/DESIGN.md) を参照してください。

```jsonc
{
  "version": 1,
  "settings": { "width": 1920, "height": 1080, "fps": 30 },
  "media":  [{ "id": "m1", "path": "...", "kind": "video", "duration": 12.3 }],
  "tracks": [{ "id": "t1", "kind": "video", "clips": [{ "mediaId": "m1", "start": 0, "in": 1, "out": 5 }] }]
}
```

## ソースからのビルド

必要なもの: [Rust](https://rustup.rs/)、Node.js 22+、[Tauri の OS 別前提パッケージ](https://tauri.app/start/prerequisites/)

```sh
git clone https://github.com/dikmri/vidEdit.git
cd vidEdit
npm install
npm run tauri dev    # 開発起動
npm run tauri build  # リリースビルド
```

## 自動アップデート

起動時に GitHub Releases の最新版を確認し、新しいバージョンがあれば画面上部に通知が表示されます。ワンクリックでダウンロード・署名検証・再起動まで自動で行われます。

## ライセンス

[MIT](LICENSE)
