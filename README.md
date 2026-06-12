# vidEdit

**軽量・高速にこだわったクロスプラットフォーム動画編集ソフト**

Tauri 2 (Rust) 製。Electron 系エディタと違いシステム WebView を使うため、バイナリは数 MB 級・起動は一瞬・メモリ消費はごくわずかです。Windows / macOS / Linux に対応しています。

## 特徴

- 🎬 **Premiere ライクなタイムライン編集** — 複数ビデオ/オーディオトラック、クリップのドラッグ移動・トリム・分割・削除、スナップ、ズーム
- 🖱️ **ドラッグ&ドロップ読み込み** — OS からファイルをメディアビンやタイムラインへ直接ドロップ
- ✂️ **ギャップのリップル削除** — クリップ間(や先頭)の隙間をクリックして `Delete` で詰める
- 🟪 **モザイク(キーフレーム対応)** — プレビュー上で矩形を描画・移動・リサイズ、位置/サイズ/表示をキーフレームでアニメーション、粒度調整([wvmTool](https://github.com/dikmri/wvmTool) の操作感を踏襲)
- 🤖 **自動モザイク** — 露出した生殖器を AI(NudeNet, ONNX)でローカル検出し、追従モザイクを自動生成(モザイク処理が必要なコンテンツの編集支援。**動画が外部に送信されることはありません**)
- ⚡ **軽量・高速** — Rust バックエンド + 依存ライブラリ最小のフロントエンド(フレームワーク不使用、Canvas 直描画)
- 🖼️ **リアルタイムプレビュー** — 不透明度・音量・モザイクを反映した多トラック合成プレビュー
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

1. **「+ メディア」** または OS からのドラッグ&ドロップで動画・音声・画像を読み込む
2. メディアビンからタイムラインへドラッグして配置
3. クリップをドラッグで移動、端をドラッグでトリム、`S` で分割、`Delete` で削除
4. クリップ間の隙間はクリックして `Delete` で詰められます(リップル削除)
5. **「書き出し」** で MP4 に出力

### モザイク

1. ビデオクリップを選択し、モザイクパネルの **「+ 領域追加」** をクリック
2. プレビュー上をドラッグして矩形を描画(自動で選択モードに切り替わります)
3. 矩形はドラッグで移動、四隅ハンドルでリサイズ。操作した時点のキーフレームが記録されます
4. 再生位置を変えながら `K` でキーフレーム追加、`H` で表示/非表示を切り替え
5. パネルで粒度(5〜80px)・有効/無効・削除を操作

**自動モザイク**: クリップを選択して「自動モザイク」を押すと、露出した生殖器を検出して追従モザイクを自動生成します。初回のみ検出モデル([NudeNet](https://github.com/notAI-tech/NudeNet) 640m、約100MB)をダウンロードします。検出・処理はすべてローカルで実行され、動画や画像が外部へ送信されることはありません。生成された領域は通常のモザイクと同様に手動調整・削除できます。

> 制限: モザイク矩形の回転には現在対応していません。

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
