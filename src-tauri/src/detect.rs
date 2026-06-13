// Auto-mosaic: detect exposed genitalia (NudeNet v3 YOLOv8n ONNX) and emit
// MosaicRegion keyframes. Pure-Rust inference via tract-onnx; ffmpeg pipes raw
// RGB frames. See DESIGN.md v2-D.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tract_onnx::prelude::*;

use crate::export::{MosaicKey, MosaicRegion};
use crate::ffmpeg;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Direct release-download URLs redirect unauthenticated clients to a GitHub
// login page (HTML); the API asset endpoint with Accept: octet-stream works.
const MODEL_RELEASE_API: &str =
    "https://api.github.com/repos/notAI-tech/NudeNet/releases/tags/v3.4-weights";
const MODEL_ASSET_API: &str = "https://api.github.com/repos/notAI-tech/NudeNet/releases/assets";
const MODEL_ASSET_NAME: &str = "640m.onnx";
const MODEL_ASSET_ID_FALLBACK: u64 = 176832019;
const HTTP_UA: &str = "vidEdit (https://github.com/dikmri/vidEdit)";
const MODEL_MIN_BYTES: u64 = 5 * 1024 * 1024;
const INPUT: usize = 640;
const FPS: f64 = 3.0;
const CONF_THRESH: f32 = 0.25;
const NMS_IOU: f32 = 0.45;
// NudeNet class indices of interest.
const CLASS_FEMALE: usize = 4;
const CLASS_MALE: usize = 14;
const MAX_REGIONS: usize = 16;

// --- Cancellation state (separate from ExportState) ---

pub struct AutoMosaicState {
    pub cancel: Arc<AtomicBool>,
    pub child: Mutex<Option<std::process::Child>>,
}

impl AutoMosaicState {
    pub fn new() -> Self {
        AutoMosaicState {
            cancel: Arc::new(AtomicBool::new(false)),
            child: Mutex::new(None),
        }
    }
}

pub fn cancel(state: &AutoMosaicState) {
    state.cancel.store(true, Ordering::SeqCst);
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Serialize, Clone)]
struct Progress {
    phase: String,
    ratio: f64,
}

fn emit_progress(app: &AppHandle, phase: &str, ratio: f64) {
    let _ = app.emit(
        "automosaic-progress",
        Progress {
            phase: phase.to_string(),
            ratio,
        },
    );
}

// --- Model download ---

fn model_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir error: {}", e))?
        .join("models");
    Ok(dir.join("nudenet-640m.onnx"))
}

// Resolve the asset id via the release-tag API; fall back to the known id.
fn resolve_model_asset_url() -> String {
    let id = ureq::get(MODEL_RELEASE_API)
        .set("User-Agent", HTTP_UA)
        .set("Accept", "application/vnd.github+json")
        .call()
        .ok()
        .and_then(|r| r.into_string().ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|j| {
            j["assets"].as_array().and_then(|assets| {
                assets
                    .iter()
                    .find(|a| a["name"].as_str() == Some(MODEL_ASSET_NAME))
                    .and_then(|a| a["id"].as_u64())
            })
        })
        .unwrap_or(MODEL_ASSET_ID_FALLBACK);
    format!("{}/{}", MODEL_ASSET_API, id)
}

fn ensure_model(app: &AppHandle, cancel: &AtomicBool) -> Result<std::path::PathBuf, String> {
    let path = model_path(app)?;
    if path.exists() {
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() >= MODEL_MIN_BYTES {
                return Ok(path);
            }
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir models: {}", e))?;
    }

    emit_progress(app, "download", 0.0);
    let resp = ureq::get(&resolve_model_asset_url())
        .set("User-Agent", HTTP_UA)
        .set("Accept", "application/octet-stream")
        .call()
        .map_err(|e| format!("model download failed: {}", e))?;

    let total: Option<u64> = resp
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok());

    let mut reader = resp.into_reader();
    let tmp = path.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("create model file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut buf = [0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&tmp);
            return Err("cancelled".to_string());
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("model read: {}", e))?;
        if n == 0 {
            break;
        }
        if downloaded == 0 {
            let head = &buf[..n.min(16)];
            if head.starts_with(b"<!DOCTYPE") || head.starts_with(b"<html") {
                let _ = std::fs::remove_file(&tmp);
                return Err(
                    "model download returned an HTML page instead of the model \
                     (GitHub may be blocking the request)"
                        .to_string(),
                );
            }
        }
        std::io::Write::write_all(&mut file, &buf[..n])
            .map_err(|e| format!("model write: {}", e))?;
        downloaded += n as u64;
        if let Some(t) = total {
            if t > 0 {
                emit_progress(app, "download", (downloaded as f64 / t as f64).min(1.0));
            }
        }
    }
    drop(file);

    if downloaded < MODEL_MIN_BYTES {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "model download failed (got {} bytes). You can place 640m.onnx from \
             https://github.com/notAI-tech/NudeNet/releases/tag/v3.4-weights manually at: {}",
            downloaded,
            path.display()
        ));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename model: {}", e))?;
    Ok(path)
}

// --- Detection types ---

#[derive(Clone, Copy)]
struct Det {
    // normalized corner coords (0..1)
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    conf: f32,
}

impl Det {
    fn iou(&self, o: &Det) -> f64 {
        let ix1 = self.x1.max(o.x1);
        let iy1 = self.y1.max(o.y1);
        let ix2 = self.x2.min(o.x2);
        let iy2 = self.y2.min(o.y2);
        let iw = (ix2 - ix1).max(0.0);
        let ih = (iy2 - iy1).max(0.0);
        let inter = iw * ih;
        let a = (self.x2 - self.x1).max(0.0) * (self.y2 - self.y1).max(0.0);
        let b = (o.x2 - o.x1).max(0.0) * (o.y2 - o.y1).max(0.0);
        let union = a + b - inter;
        if union <= 0.0 {
            0.0
        } else {
            inter / union
        }
    }
}

// Runnable plan produced by into_optimized().into_runnable().
type RunnableModel = TypedRunnableModel<TypedModel>;

// Dynamic-axes ONNX exports (ultralytics) carry symbolic dim formulas like
// `floor(height/2 - 1/2) + 1` that tract's TDim parser rejects. Strip all
// intermediate shape info and pin the input to 1x3x640x640 before parsing.
fn sanitize_onnx(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use prost::Message;
    use tract_onnx::pb;

    let mut proto =
        pb::ModelProto::decode(bytes).map_err(|e| format!("onnx decode: {}", e))?;
    if let Some(g) = proto.graph.as_mut() {
        g.value_info.clear();
        for vi in g.output.iter_mut() {
            if let Some(t) = vi.r#type.as_mut() {
                if let Some(pb::type_proto::Value::TensorType(tt)) = t.value.as_mut() {
                    tt.shape = None;
                }
            }
        }
        if let Some(vi) = g.input.first_mut() {
            if let Some(t) = vi.r#type.as_mut() {
                if let Some(pb::type_proto::Value::TensorType(tt)) = t.value.as_mut() {
                    let dim = [1i64, 3, INPUT as i64, INPUT as i64]
                        .iter()
                        .map(|&v| pb::tensor_shape_proto::Dimension {
                            value: Some(pb::tensor_shape_proto::dimension::Value::DimValue(v)),
                            ..Default::default()
                        })
                        .collect();
                    tt.shape = Some(pb::TensorShapeProto { dim });
                }
            }
        }
    }
    let mut out = Vec::with_capacity(bytes.len());
    proto
        .encode(&mut out)
        .map_err(|e| format!("onnx re-encode: {}", e))?;
    Ok(out)
}

fn load_model(path: &std::path::Path) -> Result<RunnableModel, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("model read: {}", e))?;
    let sanitized = sanitize_onnx(&bytes)?;
    let model = tract_onnx::onnx()
        .model_for_read(&mut std::io::Cursor::new(sanitized))
        .map_err(|e| format!("model load: {}", e))?
        .with_input_fact(
            0,
            f32::fact([1, 3, INPUT, INPUT]).into(),
        )
        .map_err(|e| format!("input fact: {}", e))?
        .into_optimized()
        .map_err(|e| format!("optimize: {}", e))?
        .into_runnable()
        .map_err(|e| format!("runnable: {}", e))?;
    Ok(model)
}

// Run one frame; returns kept boxes (per-class NMS already applied), normalized
// to source frame via the letterbox scale `s` (640 / max(srcW,srcH)).
fn detect_frame(
    model: &RunnableModel,
    rgb: &[u8],
    src_w: u32,
    src_h: u32,
) -> Result<Vec<Det>, String> {
    // Build CHW f32 tensor, RGB/255.
    let mut input = tract_ndarray::Array4::<f32>::zeros((1, 3, INPUT, INPUT));
    for y in 0..INPUT {
        for x in 0..INPUT {
            let base = (y * INPUT + x) * 3;
            input[[0, 0, y, x]] = rgb[base] as f32 / 255.0;
            input[[0, 1, y, x]] = rgb[base + 1] as f32 / 255.0;
            input[[0, 2, y, x]] = rgb[base + 2] as f32 / 255.0;
        }
    }
    let tensor: Tensor = input.into();
    let result = model
        .run(tvec!(tensor.into()))
        .map_err(|e| format!("inference: {}", e))?;
    let view = result[0]
        .to_array_view::<f32>()
        .map_err(|e| format!("output view: {}", e))?;

    // Expected [1, C, N] (C=22, N=8400) but tolerate [1, N, C].
    let shape = view.shape();
    if shape.len() != 3 {
        return Err(format!("unexpected output rank: {:?}", shape));
    }
    let d1 = shape[1];
    let d2 = shape[2];
    // Channel dim is the small one (22), anchor dim is the large one (8400).
    let (channels, anchors, transposed) = if d1 <= d2 { (d1, d2, false) } else { (d2, d1, true) };
    let num_classes = channels.saturating_sub(4);

    // accessor: value at (channel, anchor)
    let at = |c: usize, a: usize| -> f32 {
        if transposed {
            view[[0, a, c]]
        } else {
            view[[0, c, a]]
        }
    };

    // letterbox: pad to 640 keeping aspect, top-left aligned. scale s applied to
    // source. normalized = box_px / (src * s) where src*s = scaled dimension.
    let s = INPUT as f64 / src_w.max(src_h) as f64;
    let scaled_w = src_w as f64 * s;
    let scaled_h = src_h as f64 * s;

    let mut female: Vec<Det> = Vec::new();
    let mut male: Vec<Det> = Vec::new();

    if num_classes <= CLASS_MALE {
        return Err(format!(
            "model has {} classes, expected NudeNet's 18",
            num_classes
        ));
    }

    for a in 0..anchors {
        // Per-class thresholds (not argmax): a genital detection must not be
        // dropped just because another class scored higher at the same anchor.
        let sc_f = at(4 + CLASS_FEMALE, a);
        let sc_m = at(4 + CLASS_MALE, a);
        if sc_f <= CONF_THRESH && sc_m <= CONF_THRESH {
            continue;
        }
        // xywh center (in 640 input px)
        let cx = at(0, a) as f64;
        let cy = at(1, a) as f64;
        let bw = at(2, a) as f64;
        let bh = at(3, a) as f64;
        let x1 = cx - bw / 2.0;
        let y1 = cy - bh / 2.0;
        let x2 = cx + bw / 2.0;
        let y2 = cy + bh / 2.0;
        // normalize by scaled dimension (pad is at right/bottom).
        let make = |conf: f32| Det {
            x1: (x1 / scaled_w).clamp(0.0, 1.0),
            y1: (y1 / scaled_h).clamp(0.0, 1.0),
            x2: (x2 / scaled_w).clamp(0.0, 1.0),
            y2: (y2 / scaled_h).clamp(0.0, 1.0),
            conf,
        };
        if sc_f > CONF_THRESH {
            female.push(make(sc_f));
        }
        if sc_m > CONF_THRESH {
            male.push(make(sc_m));
        }
    }

    let mut kept = nms(female);
    kept.extend(nms(male));
    Ok(kept)
}

fn nms(mut boxes: Vec<Det>) -> Vec<Det> {
    boxes.sort_by(|a, b| b.conf.partial_cmp(&a.conf).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<Det> = Vec::new();
    for b in boxes {
        if kept.iter().all(|k| k.iou(&b) <= NMS_IOU as f64) {
            kept.push(b);
        }
    }
    kept
}

// --- Frame extraction (ffmpeg rawvideo pipe) ---

fn probe_src_size(path: &str) -> Result<(u32, u32), String> {
    let info = crate::media::probe_media(path)?;
    match (info.width, info.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Ok((w, h)),
        _ => Err("could not determine source dimensions".to_string()),
    }
}

// A detection at one sample time: corner box + time (source seconds).
struct Sample {
    boxes: Vec<Det>,
    t_src: f64,
}

fn extract_and_detect(
    app: &AppHandle,
    state: &AutoMosaicState,
    model: &RunnableModel,
    path: &str,
    in_sec: f64,
    out_sec: f64,
    src_w: u32,
    src_h: u32,
) -> Result<Vec<Sample>, String> {
    let dur = (out_sec - in_sec).max(0.0);
    let vf = format!(
        "fps={},scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:0:0:color=black",
        FPS, INPUT, INPUT, INPUT, INPUT
    );

    let mut cmd = ffmpeg::ffmpeg_command().ok_or_else(|| "ffmpeg not found in PATH".to_string())?;
    cmd.args([
        "-ss",
        &format!("{}", in_sec),
        "-t",
        &format!("{}", dur),
        "-i",
        path,
        "-vf",
        &vf,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg spawn: {}", e))?;
    let mut stdout = child.stdout.take().ok_or("no ffmpeg stdout")?;
    {
        let mut guard = state.child.lock().unwrap();
        *guard = Some(child);
    }

    let frame_bytes = INPUT * INPUT * 3;
    let mut buf = vec![0u8; frame_bytes];
    let mut samples: Vec<Sample> = Vec::new();
    let mut frame_idx: u64 = 0;
    // Estimate total frames for progress.
    let est_frames = (dur * FPS).ceil().max(1.0);

    loop {
        if state.cancel.load(Ordering::SeqCst) {
            break;
        }
        match read_exact_or_eof(&mut stdout, &mut buf)? {
            false => break, // clean EOF
            true => {}
        }
        let t_src = in_sec + frame_idx as f64 / FPS;
        let boxes = detect_frame(model, &buf, src_w, src_h)?;
        samples.push(Sample { boxes, t_src });
        frame_idx += 1;
        emit_progress(app, "detect", (frame_idx as f64 / est_frames).min(0.99));
    }

    // Reap process. Kill first: on cancel (or early break) ffmpeg may be
    // blocked writing to the pipe we no longer read, and wait() would hang.
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(mut c) = guard.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    if state.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".to_string());
    }
    Ok(samples)
}

// Fill `buf` fully. Returns Ok(true) if filled, Ok(false) on clean EOF before
// any byte. A partial frame at EOF is treated as clean end.
fn read_exact_or_eof(r: &mut impl Read, buf: &mut [u8]) -> Result<bool, String> {
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = r
            .read(&mut buf[filled..])
            .map_err(|e| format!("frame read: {}", e))?;
        if n == 0 {
            return Ok(false);
        }
        filled += n;
    }
    Ok(true)
}

// --- Temporal grouping + keyframing ---

struct Track {
    samples: Vec<(f64, Det)>, // (t_src, box)
}

fn group_tracks(samples: &[Sample]) -> Vec<Track> {
    let mut tracks: Vec<Track> = Vec::new();
    for s in samples {
        for b in &s.boxes {
            // find a track whose last box matches (IoU>0.3, dt<=0.75s)
            let mut matched: Option<usize> = None;
            for (i, tr) in tracks.iter().enumerate() {
                if let Some((lt, lb)) = tr.samples.last() {
                    let dt = (s.t_src - lt).abs();
                    if dt <= 0.75 && lb.iou(b) > 0.3 {
                        matched = Some(i);
                        break;
                    }
                }
            }
            match matched {
                Some(i) => tracks[i].samples.push((s.t_src, *b)),
                None => tracks.push(Track {
                    samples: vec![(s.t_src, *b)],
                }),
            }
        }
    }
    tracks
}

// Pad each side of a corner box by 15% of its size, clamp to 0..1.
fn pad_box(b: &Det) -> (f64, f64, f64, f64) {
    let bw = (b.x2 - b.x1).max(0.0);
    let bh = (b.y2 - b.y1).max(0.0);
    let px = bw * 0.15;
    let py = bh * 0.15;
    let x1 = (b.x1 - px).clamp(0.0, 1.0);
    let y1 = (b.y1 - py).clamp(0.0, 1.0);
    let x2 = (b.x2 + px).clamp(0.0, 1.0);
    let y2 = (b.y2 + py).clamp(0.0, 1.0);
    (x1, y1, x2 - x1, y2 - y1)
}

// Reduce keys that lie (within tol) on the line between their neighbours.
fn decimate(keys: &[MosaicKey], tol: f64) -> Vec<MosaicKey> {
    if keys.len() <= 2 {
        return keys.to_vec();
    }
    let mut out: Vec<MosaicKey> = vec![keys[0].clone()];
    for i in 1..keys.len() - 1 {
        let prev = out.last().unwrap();
        let next = &keys[i + 1];
        let cur = &keys[i];
        let dt = next.t - prev.t;
        if dt.abs() < 1e-9 {
            out.push(cur.clone());
            continue;
        }
        let f = (cur.t - prev.t) / dt;
        let lerp = |a: f64, b: f64| a + (b - a) * f;
        let err = (cur.x - lerp(prev.x, next.x)).abs()
            + (cur.y - lerp(prev.y, next.y)).abs()
            + (cur.w - lerp(prev.w, next.w)).abs()
            + (cur.h - lerp(prev.h, next.h)).abs();
        if err > tol || cur.visible != prev.visible {
            out.push(cur.clone());
        }
    }
    out.push(keys[keys.len() - 1].clone());
    out
}

fn track_to_region(tr: &Track, in_sec: f64, id: usize) -> Option<MosaicRegion> {
    if tr.samples.is_empty() {
        return None;
    }
    let mut keys: Vec<MosaicKey> = tr
        .samples
        .iter()
        .map(|(t_src, b)| {
            let (x, y, w, h) = pad_box(b);
            MosaicKey {
                t: (t_src - in_sec).max(0.0),
                x,
                y,
                w,
                h,
                visible: true,
                rot: 0.0,
            }
        })
        .collect();

    keys = decimate(&keys, 0.01);

    // Capture the last key before shifting (a single-sample track's first key
    // IS the last key; shifting first would otherwise shorten the window).
    let last = keys.last().unwrap().clone();
    // Pull the first key earlier by 0.15s (visible).
    if let Some(first) = keys.first_mut() {
        first.t = (first.t - 0.15).max(0.0);
    }
    // Append a trailing invisible key 0.15s after the last.
    keys.push(MosaicKey {
        t: last.t + 0.15,
        x: last.x,
        y: last.y,
        w: last.w,
        h: last.h,
        visible: false,
        rot: 0.0,
    });

    Some(MosaicRegion {
        id: format!("auto-{}", id),
        strength: 20.0,
        enabled: true,
        keys,
    })
}

// Score for ranking: area * duration.
fn region_score(r: &MosaicRegion) -> f64 {
    if r.keys.len() < 2 {
        return 0.0;
    }
    let dur = r.keys.last().unwrap().t - r.keys.first().unwrap().t;
    let avg_area: f64 =
        r.keys.iter().map(|k| k.w * k.h).sum::<f64>() / r.keys.len() as f64;
    avg_area * dur.max(0.0)
}

fn build_regions(tracks: &[Track], in_sec: f64) -> Vec<MosaicRegion> {
    let mut regions: Vec<MosaicRegion> = tracks
        .iter()
        .enumerate()
        .filter_map(|(i, tr)| track_to_region(tr, in_sec, i))
        .collect();
    regions.sort_by(|a, b| {
        region_score(b)
            .partial_cmp(&region_score(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    regions.truncate(MAX_REGIONS);
    // Renumber ids after truncation/sort for stable "auto-N".
    for (i, r) in regions.iter_mut().enumerate() {
        r.id = format!("auto-{}", i);
    }
    regions
}

// --- Tauri commands ---

#[tauri::command]
pub async fn auto_mosaic(
    path: String,
    in_sec: f64,
    out_sec: f64,
    app: AppHandle,
    state: State<'_, Arc<AutoMosaicState>>,
) -> Result<Vec<MosaicRegion>, String> {
    state.cancel.store(false, Ordering::SeqCst);
    let st = Arc::clone(&state);
    let app2 = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        run_detection(&app2, &st, &path, in_sec, out_sec)
    })
    .await
    .map_err(|e| format!("task join error: {}", e))?
}

#[tauri::command]
pub fn cancel_auto_mosaic(state: State<'_, Arc<AutoMosaicState>>) {
    cancel(&state);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Requires VIDEDIT_TEST_MODEL=path to nudenet-640m.onnx; run with
    // `cargo test -- --ignored`. Verifies tract can load and execute the model.
    #[test]
    #[ignore]
    fn model_smoke() {
        let path = std::env::var("VIDEDIT_TEST_MODEL").expect("set VIDEDIT_TEST_MODEL");
        let model = load_model(std::path::Path::new(&path)).expect("model load/optimize");
        let rgb = vec![128u8; INPUT * INPUT * 3];
        let dets = detect_frame(&model, &rgb, 1920, 1080).expect("inference");
        // Gray frame: expect no genital detections.
        assert!(dets.len() < 10, "unexpected detections: {}", dets.len());
    }
}

fn run_detection(
    app: &AppHandle,
    state: &AutoMosaicState,
    path: &str,
    in_sec: f64,
    out_sec: f64,
) -> Result<Vec<MosaicRegion>, String> {
    let model_path = ensure_model(app, &state.cancel)?;
    if state.cancel.load(Ordering::SeqCst) {
        return Err("cancelled".to_string());
    }
    let model = load_model(&model_path)?;
    let (src_w, src_h) = probe_src_size(path)?;

    emit_progress(app, "detect", 0.0);
    let samples = extract_and_detect(
        app, state, &model, path, in_sec, out_sec, src_w, src_h,
    )?;

    let tracks = group_tracks(&samples);
    let regions = build_regions(&tracks, in_sec);
    emit_progress(app, "detect", 1.0);
    Ok(regions)
}
