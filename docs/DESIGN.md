# vidEdit — 設計書

> v1 = 0.1.0 の基本設計(後半)。v2 = 0.2.0 追加機能(直下)。

# v2 追加設計 (0.2.0)

## A. OSからのドラッグ&ドロップ

- Tauri の drag-drop インターセプト(`dragDropEnabled` 既定 true)を利用。フロントは `getCurrentWebview().onDragDropEvent` を購読。
  - `over`: PhysicalPosition / devicePixelRatio → client 座標。メディアビン領域/タイムライン canvas 上ならハイライト表示。
  - `drop`: 各 path を probe_media + make_thumbnail で取り込み(.vep は除外)。ドロップ先がタイムライン canvas ならドロップ位置のトラック/時刻へ順次配置(既存の重なり回避ロジック)。それ以外はビンへの追加のみ。
- **注意**: dragDropEnabled=true の環境では HTML5 DnD が WebView2 で機能しない。メディアビン→タイムラインの内部ドラッグは mousedown ベースの自前実装(ゴースト表示、mouseup 位置で配置)に置き換える。

## B. ギャップ選択とリップル削除

- タイムラインのトラック上の空白(クリップとクリップの間、または 0 秒〜先頭クリップ)をクリック → ギャップ選択 `{trackId, start, end}`(右端は必ず次クリップの start。右側にクリップがない空白は選択不可)。斜線ハッチでハイライト。
- Delete/Backspace でリップル削除: そのトラック上の `clip.start >= gap.end - ε` の全クリップを `gap.end - gap.start` 秒だけ左へシフト(undo 可能な 1 commit)。

## C. モザイク機能 (wvmTool 参考)

### データモデル (.vep version: 2)

```jsonc
// Clip に追加(省略時 [])。v1 ファイルは mosaics=[] として読み込む。
"mosaics": [
  { "id": "mz1", "strength": 20, "enabled": true,
    "keys": [
      // t: クリップのタイムライン開始位置からの相対秒(τ)。昇順。
      // x,y,w,h: プロジェクトフレームに対する正規化座標(0..1, x/y=左上)
      { "t": 0.0, "x": 0.4, "y": 0.5, "w": 0.1, "h": 0.15, "visible": true }
    ] }
]
```

- 補間: keys 間は x/y/w/h を線形補間。最初の key より前は**非表示**。最後の key 以後は最終値を保持。`visible` はステップ(その key から次の key まで)。
- strength = モザイク粒度 px (5..80)。回転は非対応(v1 の制限として明記)。

### プレビュー/編集 UI

- 選択クリップが video トラック上にあるとき、プレビュー下にモザイクパネル: 領域リスト(●/○ 有効切替、粒度スライダー 5–80、× 削除)、「+ 領域追加」、「自動モザイク」。
- 「+ 領域追加」→ 描画モード: プレビュー上をドラッグで矩形描画 → 現在の τ に key 追加、自動で選択モードへ(wvmTool 同様)。
- 選択モード: 矩形クリックで選択、ドラッグ移動、四隅ハンドル(8px)でリサイズ。編集時は現在 τ の key を更新(無ければ追加)= キーフレーム記録。`K`=現在位置に key 追加、`H`=表示/非表示 key 追加。
- 一時停止中のみ枠線/ハンドル描画、再生中はモザイク効果のみ(wvmTool 同様)。
- プレビューのモザイク描画: 該当矩形を小さなオフスクリーン canvas に縮小描画→ `imageSmoothingEnabled=false` で拡大して戻す。ブロックサイズはプレビュー縮尺に合わせ strength を比例縮小。

### エクスポート (export.rs)

各 video/image クリップのチェーン `...,fps={fps}` の直後・`format=yuva420p` の前に、enabled な領域ごとに挿入:

```
[cN]split=2[cNb][cNt];
[cNt]crop=w={Wr}:h={Hr}:x='{XEXPR}':y='{YEXPR}',pixelize=width={P}:height={P}[cNm];
[cNb][cNm]overlay=x='{XEXPR}':y='{YEXPR}':enable='{VIS}'[cN']
```

- Wr/Hr = keys 中の最大 w/h × プロジェクト W/H を 2 の倍数に切上げ(最小 16)。crop サイズは固定し、位置のみ時間変化。
- XEXPR/YEXPR = keys の区分線形補間を `if(lt(t,t1), lerp式, if(...))` のネストで生成し、`clip(式, 0, {W-Wr})` でクランプ。t はチェーン内時刻 τ(trim 後 setpts=PTS-STARTPTS 済みのため)。数値は全てリテラルで埋め込む。
- VIS = visible 区間の `between(t,a,b)` の和。全区間可視なら enable 省略。
- P = clamp(strength, 4, min(Wr,Hr)/2)。
- 自動生成 keys はエクスポート前にデータ側で間引かれている前提(下記)ため式長は問題にならない。

## D. 自動モザイク(生殖器の自動検出)

露出した生殖器を NudeNet v3 検出モデル(YOLOv8n, ONNX)で検出し、モザイク領域として自動追加する(モザイク義務化コンテンツの編集支援)。

### IPC 追加

| command | 引数 | 戻り値 |
|---|---|---|
| `auto_mosaic` | `path, inSec: f64, outSec: f64` | `Vec<MosaicRegion>`(async。keys.t は τ=srcT−inSec) |
| `cancel_auto_mosaic` | なし | `()` |

イベント `automosaic-progress`: `{ phase: "download" \| "detect", ratio: f64 }`

### パイプライン (src-tauri/src/detect.rs)

1. **モデル**: `{app_data_dir}/models/nudenet-640m.onnx`。無ければ `https://github.com/notAI-tech/NudeNet/releases/download/v3.4-weights/640m.onnx` から ureq でダウンロード(progress 発行、5MB 未満なら失敗扱い)。
2. **フレーム抽出**: ffprobe で srcW/srcH 取得後、`ffmpeg -ss {in} -t {out-in} -i path -vf fps=3,scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:0:0:color=black -f rawvideo -pix_fmt rgb24 pipe:1` を行(フレーム)単位でストリーム読み(640*640*3 bytes/frame)。pad 左上寄せなので座標逆変換は スケール s=640/max(srcW,srcH)、normalized = box_px / (src*s)。
3. **推論**: tract-onnx(純Rust、ネイティブ依存なしで CI 3OS 安全)。入力 fact f32 [1,3,640,640]、RGB/255、CHW。出力 [1,22,8400](YOLOv8: 4bbox+18class、sigmoid 適用済み)。対象クラス index: **4 = FEMALE_GENITALIA_EXPOSED, 14 = MALE_GENITALIA_EXPOSED のみ**。conf>0.25 → xywh(center)→corner → クラス毎 NMS IoU 0.45 → 正規化座標へ逆変換。
4. **時間方向グルーピング**: 直前ボックスとの IoU>0.3 かつ時間差≤0.75s なら同一トラックに連結、なければ新規。トラックごとに: ボックスを各辺 15% パディング(0..1 クランプ)→ key 列化(t=サンプル時刻−in)→ 線形補間で再現できる中間 key を間引き(許容誤差 0.01)→ 先頭 key の t を max(0, t−0.15) に前倒し(visible=true)、末尾に t=最終+0.15 の visible=false key を追加。
5. region: id="auto-N", strength=20, enabled=true。面積×継続時間の大きい順に最大 16 個。
6. キャンセル: AtomicBool + ffmpeg child kill。エラーはメッセージ付き Err(手動モザイクは影響なし)。

### フロント

- モザイクパネルの「自動モザイク」: 確認ダイアログ(初回はモデル約100MBをダウンロードする旨)→ progress モーダル(キャンセル可)→ 結果 regions を選択クリップに append(1 commit、undo 可)。image クリップは対象外(ボタン無効)。

## E. その他

- バージョン 0.2.0(package.json / Cargo.toml / tauri.conf.json)。.vep version 2(v1 読込可)。
- release.yml の actions/checkout, setup-node を v5 へ(Node20 非推奨対応)。

---

# v3 追加設計 (0.3.0)

## F. モデルダウンロード修正

GitHub の release 直リンクは未認証だとログインページ(HTML)へリダイレクトされるようになったため、**GitHub API のアセットエンドポイント**を使う:

1. `GET https://api.github.com/repos/notAI-tech/NudeNet/releases/tags/v3.4-weights`(`User-Agent` 必須、`Accept: application/vnd.github+json`)→ assets から name=640m.onnx の id を解決。失敗時は既知 id `176832019` にフォールバック。
2. `GET https://api.github.com/repos/notAI-tech/NudeNet/releases/assets/{id}`(`Accept: application/octet-stream`、`User-Agent` 付き)→ リダイレクト追従でバイナリ取得(検証済み: 未認証で 103,538,690 bytes)。
3. 先頭チャンクが `<!DOCTYPE`/`<html` なら即エラー。既存の 5MB 下限ガード維持。

## G. モザイク回転 (Q/E/R、wvmTool 準拠)

### データモデル

`MosaicKey` に `rot: f64`(度、デフォルト 0、serde default)を追加。線形補間。.vep version は 2 のまま(追加フィールドは後方互換)。

### UI(フロント)

- 選択領域に対して `Q`=反時計 5°、`E`=時計 5°、`R`=0° リセット。いずれも現在 τ の key に記録(なければ追加)= K/H と同じ流儀。
- プレビュー: 枠線/ハンドルは回転して描画。ヒットテスト・移動・リサイズはマウス座標を領域中心まわりに逆回転してから既存ロジックへ。モザイク効果は「回転矩形でクリップした領域に、軸平行ブロックのピクセル化を適用」(Canvas2D: save→translate(中心)→rotate→rect クリップ→ピクセル化済みバウンディング矩形を描画→restore)。

### エクスポート (export.rs)

領域の全 key が rot=0 なら従来チェーン。回転がある場合:

```
[in]split=2[b][t];
[t]format=yuva420p,crop=w={D}:h={D}:x='{CX}-{D/2}':y='{CY}-{D/2}',rotate=a='-({TH})':c=none[r];
[r]crop=w={Wr}:h={Hr}:x={(D-Wr)/2}:y={(D-Hr)/2},pixelize=...[p];
[p]rotate=a='{TH}':ow={D}:oh={D}:c=none[m];
[b][m]overlay=x='{CX}-{D/2}':y='{CY}-{D/2}':enable='{VIS}'[out]
```

- D = even_ceil(hypot(Wr,Hr))(回転矩形のバウンディングボックスは任意角で D 以下: Wr|cosθ|+Hr|sinθ| ≤ hypot)。min(W,H) を超える場合はクランプ。
- CX/CY = 領域**中心**の区分線形式を `clip(式, D/2, W-D/2)` でクランプ(crop と overlay で同一文字列にして位置整合を保証)。
- TH = rot の区分線形式(**ラジアン**に変換した数値をリテラル埋め込み)。1段目は負号、2段目は正号。
- c=none で回転外周を透明化し、overlay は alpha 合成で回転矩形のみモザイクが乗る。

---

# v1 基本設計 (0.1.0)

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
