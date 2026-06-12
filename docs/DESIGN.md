# vidEdit — 設計書 (v1)

軽量・高速なクロスプラットフォーム動画編集ソフト。Tauri 2 (Rust) + Vite/TypeScript(フレームワーク不使用、Canvas 描画)。

## 1. 全体構成

```
vidEdit/
  package.json            # npm: @tauri-apps/api, plugin-dialog, plugin-updater, plugin-process / dev: vite, typescript, @tauri-apps/cli
  vite.config.ts          # 標準 Tauri 推奨設定 (port 1420, clearScreen false)
  tsconfig.json           # strict
  index.html              # アプリ UI ルート (フロント担当)
  src/                    # フロントエンド (TypeScript, フレームワークなし)
    main.ts  state.ts  timeline.ts  preview.ts  mediabin.ts  exportui.ts  ipc.ts  updater.ts  style.css
  src-tauri/
    Cargo.toml  build.rs  tauri.conf.json
    capabilities/default.json
    icons/                # tauri icon 生成のデフォルトアイコン一式
    src/
      main.rs  lib.rs     # lib.rs に Builder、plugins 登録、invoke_handler
      ffmpeg.rs           # ffmpeg/ffprobe 検出 (which 相当: PATH 探索)
      media.rs            # probe_media, make_thumbnail
      project.rs          # save_project, load_project
      export.rs           # export_video, cancel_export (filter_complex 構築)
  .github/workflows/release.yml
  install.ps1  install.sh
  README.md  LICENSE (MIT)
```

- identifier: `com.dikmri.videdit` / productName: `vidEdit` / version: 0.1.0
- GitHub: `dikmri/vidEdit` (public)

## 2. プロジェクトファイル形式 `.vep` (JSON, UTF-8)

```jsonc
{
  "version": 1,
  "name": "untitled",
  "settings": { "width": 1920, "height": 1080, "fps": 30, "sampleRate": 48000 },
  "media": [
    // kind: "video" | "audio" | "image"
    { "id": "m1", "path": "C:/abs/path.mp4", "kind": "video",
      "duration": 12.34, "width": 1920, "height": 1080, "fps": 29.97, "hasAudio": true }
  ],
  "tracks": [
    // kind: "video" | "audio"。video トラックは配列の後ろほど上のレイヤー(後勝ち overlay)。
    { "id": "t1", "kind": "video", "name": "V1",
      "clips": [
        // start: タイムライン上の開始秒, in/out: ソース内の使用範囲秒 (out > in)
        // 長さ = out - in。image は in=0, out=表示秒数(ソース無限とみなす)
        { "id": "c1", "mediaId": "m1", "start": 0.0, "in": 1.0, "out": 5.0,
          "volume": 1.0, "opacity": 1.0 }
      ] }
  ]
}
```

- 時刻は全て秒 (f64)。同一トラック内のクリップは重複禁止(UI 側で防ぐ)。
- video クリップの音声は hasAudio が true なら volume で出力に混合される。audio トラックのクリップは音声のみ。
- video トラックに image クリップを置ける。

## 3. IPC 契約 (Rust commands / フロントは ipc.ts でラップ)

すべて snake_case。エラーは `Err(String)` で返す。

| command | 引数 | 戻り値 |
|---|---|---|
| `check_ffmpeg` | なし | `{ ffmpeg: bool, ffprobe: bool, version: string \| null }` |
| `probe_media` | `path: String` | `MediaInfo { kind, duration, width, height, fps, hasAudio }` (serde rename_all = "camelCase") |
| `make_thumbnail` | `path: String, timeSec: f64` | `String` — `data:image/jpeg;base64,...` (幅 160px, ffmpeg `-frames:v 1` で生成。image はそのファイル自体を縮小) |
| `save_project` | `path: String, json: String` | `()` |
| `load_project` | `path: String` | `String` (JSON 中身) |
| `export_video` | `projectJson: String, outPath: String` | `()` — 即 return し非同期実行。進捗は event |
| `cancel_export` | なし | `()` |

イベント (Rust → front, `app.emit`):
- `export-progress`: `{ ratio: f64 /*0..1*/, timeSec: f64 }` (ffmpeg stderr の `time=` をパースし全体尺で割る)
- `export-done`: `{ ok: bool, error: string | null }`

probe_media: `ffprobe -v error -print_format json -show_format -show_streams`。kind 判定: video stream あり→video(ただし mjpeg/png 単一フレームや拡張子 jpg/png/gif/bmp/webp は image)、audio のみ→audio。

## 4. エクスポート (export.rs) — filter_complex 構築

出力: H.264 (libx264, preset veryfast, crf 20) + AAC 192k, MP4 (`-movflags +faststart`)。`-y` 付与。

1. 全体尺 `T` = 全クリップの `start + (out-in)` の最大値。
2. ベース: `color=c=black:s={W}x{H}:r={fps}:d={T}[base]`、音声ベース: `anullsrc=channel_layout=stereo:sample_rate={sr}:d={T}[abase]` ※anullsrc は `-f lavfi -i` の入力として与えてもよい(実装に任せるが、出力尺が T になることを保証)。
3. 各 video/image クリップ(video トラック、配列順=下→上):
   - video: 入力 `-i path`(同一メディアは入力を共有してよいが、簡潔さ優先で重複入力も可)。
     `[k:v]trim=start={in}:end={out},setpts=PTS-STARTPTS,scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuva420p,colorchannelmixer=aa={opacity},setpts=PTS+{start}/TB[vN]`
   - image: `-loop 1 -t {out-in} -i path` を入力にし、trim の代わりにそのまま scale/pad/fps/opacity/setpts チェーン。
   - 重ね: `[prev][vN]overlay=eof_action=pass[oN]` を順に連結、最後を `[vout]`。
4. 各音声ソース(video クリップで hasAudio かつ volume>0、および audio トラックのクリップ):
   `[k:a]atrim=start={in}:end={out},asetpts=PTS-STARTPTS,volume={vol},adelay={start_ms}|{start_ms},apad[aN]` →
   全て + `[abase]` を `amix=inputs=N:duration=first:normalize=0[aout]`。音声ソースが 0 なら `[abase]` を直接 `[aout]` に。
   ※`duration=first` の first が `[abase]`(d=T)になるよう abase を先頭に。apad で短い入力を伸ばす。
5. `-map [vout] -map [aout] -t {T}` で出力。
6. 実行: `ffmpeg -progress pipe:2` は使わず stderr を行読みして `time=HH:MM:SS.xx` をパース → `export-progress`。プロセスハンドルを `Mutex<Option<Child>>` に保持し、`cancel_export` で kill。終了コードで `export-done`。
7. filter_complex が長くなるため **`-filter_complex_script`**(一時ファイル)を使用すること(Windows のコマンドライン長制限対策)。
8. Windows では `CREATE_NO_WINDOW` (creation_flags 0x08000000) を ffmpeg/ffprobe 起動全箇所に付ける。

## 5. フロントエンド UI

レイアウト(CSS Grid、ダークテーマ、システムフォント):
```
┌─────────────┬──────────────────────┐
│ メディアビン │  プレビュー (canvas)   │
│ (サムネ一覧) │  再生コントロール       │
├─────────────┴──────────────────────┤
│ ツールバー(分割/削除/ズーム/書き出し) │
│ タイムライン (canvas, 複数トラック)    │
└────────────────────────────────────┘
```

- **state.ts**: Project 状態 + undo/redo(JSON スナップショット方式、上限 100)。変更は `commit()` 経由。subscribe で再描画通知。
- **mediabin.ts**: 「メディアを追加」→ plugin-dialog open(複数選択, 動画/音声/画像フィルタ)→ probe_media + make_thumbnail。一覧からタイムラインへ HTML5 DnD またはクリック配置。
- **timeline.ts**: Canvas 描画。機能: 目盛り(秒)、トラックレーン、クリップ矩形(サムネなしの色分け+ラベル)、再生ヘッド、クリック/ドラッグでシーク、クリップのドラッグ移動(トラック間も可・同種トラックのみ)、端ドラッグでトリム(in/out 調整)、選択(クリック)、分割(S キー / ボタン: 再生ヘッド位置で選択クリップを 2 分割)、削除(Delete)、ズーム(Ctrl+ホイール、px/sec 可変)、スナップ(クリップ端と再生ヘッド、しきい値 8px)。トラック追加ボタン(V/A)。
- **preview.ts**: Canvas ({W}x{H} を fit 表示)。各 video メディアに hidden `<video>`(`convertFileSrc(path)`)、image は `<img>`。再生: requestAnimationFrame で playhead 進行、各 video 要素の currentTime を `playhead - start + in` に同期(ズレ > 0.15s で補正)、video.volume = clip.volume、globalAlpha = opacity で下層→上層の順に drawImage。停止中シークはフレーム描画のみ。Space で再生/停止、←→で 1 フレーム移動、J/K/L 対応は任意。
- **exportui.ts**: モーダル。保存先を plugin-dialog save で選択 → export_video → progress バー(event 購読)→ 完了/キャンセル。
- **updater.ts**: 起動 3 秒後に plugin-updater `check()`。更新ありなら通知バー表示「アップデート vX.Y.Z → 再起動して更新」→ `downloadAndInstall()` → plugin-process `relaunch()`。
- **main.ts**: 初期化、check_ffmpeg(なければ画面上部に警告バー+インストール案内リンク)、メニュー相当のヘッダー(新規/開く/保存/名前を付けて保存 = save_project/load_project + dialog)、Ctrl+S/O/N/Z/Y ショートカット。
- ファイルは ESM。クラスまたはモジュール関数で簡潔に。外部 UI ライブラリ禁止。

## 6. Tauri 設定

- `tauri.conf.json`: app.windows[0] = { title: "vidEdit", width: 1280, height: 800 }。
  - `app.security.assetProtocol = { enable: true, scope: ["**"] }`、csp は null。
  - `bundle.createUpdaterArtifacts: true`、targets: "all"。
  - `plugins.updater = { endpoints: ["https://github.com/dikmri/vidEdit/releases/latest/download/latest.json"], pubkey: "<後で挿入>" }`
- capabilities/default.json: core:default, dialog:default, updater:default, process:default + `core:webview:allow-internal-toggle-devtools` は不要。
- Cargo: tauri = { version = "2", features = ["protocol-asset"] }, tauri-plugin-dialog, tauri-plugin-updater, tauri-plugin-process, serde, serde_json, base64。release profile: opt-level = "s", lto = true, strip = true, codegen-units = 1, panic = "abort"。

## 7. CI / リリース (.github/workflows/release.yml)

- trigger: `push: tags: ["v*"]`。permissions: contents: write。
- matrix: `windows-latest` (nsis), `macos-latest` (`--target universal-apple-darwin`, rustup target 両方追加), `ubuntu-22.04` (AppImage+deb, apt: libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev)。
- steps: checkout → setup-node 22 + npm ci → dtolnay/rust-toolchain@stable → swatinem/rust-cache → tauri-apps/tauri-action@v0 with `tagName: ${{ github.ref_name }}`, releaseName: "vidEdit ${{ github.ref_name }}", `includeUpdaterJson: true`, env: GITHUB_TOKEN, TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD。

## 8. インストールスクリプト

- `install.ps1`: GitHub API `releases/latest` から `*-setup.exe` を取得 → `%TEMP%` に DL → `/S` でサイレント実行 → 完了メッセージ。
- `install.sh`: `uname` で分岐。
  - macOS: `*.app.tar.gz`(arch 共通 universal)を DL → `/Applications` に展開。
  - Linux: `*.AppImage` を `~/.local/bin/videdit` に配置 + chmod +x + `~/.local/share/applications/videdit.desktop` 作成。
- 使い方(README 記載):
  - Win: `irm https://raw.githubusercontent.com/dikmri/vidEdit/main/install.ps1 | iex`
  - mac/Linux: `curl -fsSL https://raw.githubusercontent.com/dikmri/vidEdit/main/install.sh | sh`
- FFmpeg は同梱しない。未検出時はアプリ内警告 + README に各 OS のインストールコマンド(winget/brew/apt)。
