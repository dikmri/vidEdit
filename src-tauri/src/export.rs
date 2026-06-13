use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::ffmpeg;

// --- Project JSON structures ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSettings {
    width: u32,
    height: u32,
    fps: f64,
    sample_rate: u32,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediaItem {
    id: String,
    path: String,
    kind: String,
    has_audio: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Clip {
    id: String,
    media_id: String,
    start: f64,
    #[serde(rename = "in")]
    clip_in: f64,
    out: f64,
    volume: f64,
    opacity: f64,
    #[serde(default)]
    mosaics: Vec<MosaicRegion>,
}

// --- Mosaic data model (shared with detect.rs) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MosaicKey {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub visible: bool,
    /// Rotation in degrees, around the rect center.
    #[serde(default)]
    pub rot: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MosaicRegion {
    pub id: String,
    pub strength: f64,
    pub enabled: bool,
    pub keys: Vec<MosaicKey>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    kind: String,
    clips: Vec<Clip>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    settings: ProjectSettings,
    media: Vec<MediaItem>,
    tracks: Vec<Track>,
}

// --- Event payloads ---

#[derive(Serialize, Clone)]
pub struct ExportProgress {
    pub ratio: f64,
    pub time_sec: f64,
}

#[derive(Serialize, Clone)]
pub struct ExportDone {
    pub ok: bool,
    pub error: Option<String>,
}

// --- Global export process handle ---

pub struct ExportState {
    pub child: Mutex<Option<std::process::Child>>,
}

impl ExportState {
    pub fn new() -> Self {
        ExportState {
            child: Mutex::new(None),
        }
    }
}

pub fn cancel_export(state: &ExportState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// --- Time parsing ---

fn parse_time_hms(s: &str) -> Option<f64> {
    // Format: HH:MM:SS.xx
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().ok()?;
        let m: f64 = parts[1].parse().ok()?;
        let sec: f64 = parts[2].parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + sec)
    } else {
        None
    }
}

// --- filter_complex builder ---

pub struct InputSpec {
    pub arg: String,
    pub lavfi: bool,
    pub loop_dur: Option<f64>,
}

// Round up to an even integer, with a minimum.
fn even_ceil(v: f64, min: u32) -> u32 {
    let mut n = v.ceil() as i64;
    if n < min as i64 {
        n = min as i64;
    }
    if n % 2 != 0 {
        n += 1;
    }
    n as u32
}

// Format an f64 as a compact ffmpeg-expr literal (no scientific notation).
fn lit(v: f64) -> String {
    let s = format!("{:.4}", v);
    // trim trailing zeros but keep at least one digit after the point
    let s = s.trim_end_matches('0');
    let s = s.trim_end_matches('.');
    if s.is_empty() || s == "-" {
        "0".to_string()
    } else {
        s.to_string()
    }
}

// Build the piecewise-linear interpolation expression for one coordinate
// accessor over the keys, clamped to [0, max]. `pick` returns the pixel value
// of a key. Times are the chain-internal time tau (setpts=PTS-STARTPTS done).
fn piecewise_expr(keys: &[MosaicKey], pick: impl Fn(&MosaicKey) -> f64) -> String {
    // Keys are assumed sorted ascending by t. Before first key the region is
    // not visible (VIS handles that), but we still need a defined value; hold
    // the first key's value. After last key, hold the last value.
    if keys.is_empty() {
        return "0".to_string();
    }
    if keys.len() == 1 {
        return lit(pick(&keys[0]));
    }
    // Build nested if() from the last segment outward.
    let last = keys.len() - 1;
    // Start with the value held after the last key.
    let mut expr = lit(pick(&keys[last]));
    // Iterate segments [i, i+1] from last down to first.
    for i in (0..last).rev() {
        let t0 = keys[i].t;
        let t1 = keys[i + 1].t;
        let v0 = pick(&keys[i]);
        let v1 = pick(&keys[i + 1]);
        let seg = if (t1 - t0).abs() < 1e-9 {
            lit(v1)
        } else {
            let slope = (v1 - v0) / (t1 - t0);
            // v0 + slope*(t - t0)
            format!("({}+{}*(t-{}))", lit(v0), lit(slope), lit(t0))
        };
        expr = format!("if(lt(t,{}),{},{})", lit(t1), seg, expr);
    }
    expr
}

fn coord_expr(
    keys: &[MosaicKey],
    pick: impl Fn(&MosaicKey) -> f64,
    clamp_min: f64,
    clamp_max: f64,
) -> String {
    format!(
        "clip({},{},{})",
        piecewise_expr(keys, pick),
        lit(clamp_min),
        lit(clamp_max)
    )
}

// Build the enable expression (sum of between() over visible step intervals).
// Returns None if every interval is visible (enable can be omitted).
fn vis_expr(keys: &[MosaicKey]) -> Option<String> {
    if keys.is_empty() {
        return Some("0".to_string());
    }
    // Each key's `visible` applies as a step from keys[i].t to keys[i+1].t,
    // the last key extends to +inf.
    let mut intervals: Vec<(f64, f64)> = Vec::new();
    for i in 0..keys.len() {
        let a = keys[i].t;
        let b = if i + 1 < keys.len() {
            keys[i + 1].t
        } else {
            f64::INFINITY
        };
        if keys[i].visible {
            intervals.push((a, b));
        }
    }
    if intervals.is_empty() {
        return Some("0".to_string());
    }
    // Merge adjacent/contiguous visible intervals.
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (a, b) in intervals {
        if let Some(last) = merged.last_mut() {
            if (a - last.1).abs() < 1e-9 {
                last.1 = b;
                continue;
            }
        }
        merged.push((a, b));
    }
    let intervals = merged;
    let terms: Vec<String> = intervals
        .iter()
        .map(|(a, b)| {
            if b.is_infinite() {
                format!("gte(t,{})", lit(*a))
            } else {
                format!("between(t,{},{})", lit(*a), lit(*b))
            }
        })
        .collect();
    Some(terms.join("+"))
}

// Build the per-clip mosaic filter stages. Inserted between the `fps={fps}`
// stage and `format=yuva420p`. `in_label` is the input pad label (without
// brackets), e.g. "m0i"; returns (filter_segment, out_label) where out_label
// is also without brackets. If no enabled region produces stages, returns an
// empty segment and the input label unchanged.
fn build_mosaic_chain(
    in_label: &str,
    clip_idx: usize,
    mosaics: &[MosaicRegion],
    w: u32,
    h: u32,
) -> (String, String) {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = in_label.to_string();
    let mut stage = 0usize;

    for region in mosaics {
        if !region.enabled || region.keys.is_empty() {
            continue;
        }
        // crop size = max w/h over keys, in px, even-ceil, min 16.
        let max_w = region.keys.iter().map(|k| k.w).fold(0.0_f64, f64::max);
        let max_h = region.keys.iter().map(|k| k.h).fold(0.0_f64, f64::max);
        let wr = even_ceil(max_w * w as f64, 16);
        let hr = even_ceil(max_h * h as f64, 16);

        let vis = vis_expr(&region.keys);
        let enable = match &vis {
            Some(v) => format!(":enable='{}'", v),
            None => String::new(),
        };

        let base = format!("c{}s{}", clip_idx, stage);
        let lb = format!("{}b", base);
        let lt = format!("{}t", base);
        let lm = format!("{}m", base);
        let lout = format!("{}o", base);

        parts.push(format!("[{}]split=2[{}][{}]", cur, lb, lt));

        let has_rot = region.keys.iter().any(|k| k.rot.abs() > 1e-6);
        if !has_rot {
            // P = clamp(strength, 4, min(Wr,Hr)/2)
            let p_max = (wr.min(hr) as f64 / 2.0).floor().max(4.0);
            let p = region.strength.max(4.0).min(p_max).round() as u32;

            // Position expressions: top-left = (x*W, y*H), clamped to [0, W-Wr]/[0, H-Hr].
            let xmax = (w as f64 - wr as f64).max(0.0);
            let ymax = (h as f64 - hr as f64).max(0.0);
            let xexpr = coord_expr(&region.keys, |k| k.x * w as f64, 0.0, xmax);
            let yexpr = coord_expr(&region.keys, |k| k.y * h as f64, 0.0, ymax);

            parts.push(format!(
                "[{}]crop=w={}:h={}:x='{}':y='{}',pixelize=width={}:height={}[{}]",
                lt, wr, hr, xexpr, yexpr, p, p, lm
            ));
            parts.push(format!(
                "[{}][{}]overlay=x='{}':y='{}'{}[{}]",
                lb, lm, xexpr, yexpr, enable, lout
            ));
        } else {
            // Rotated mosaic: crop a DxD window around the (clamped) region
            // center, rotate -theta so the rect is axis-aligned, crop+pixelize
            // it, rotate back +theta with transparent fill, alpha-overlay.
            // D = hypot bounds the rect's bbox for any angle
            // (Wr|cos|+Hr|sin| <= hypot(Wr,Hr)).
            let mut d = even_ceil(((wr as f64).powi(2) + (hr as f64).powi(2)).sqrt(), 16);
            let frame_min = w.min(h) & !1u32;
            if d > frame_min {
                d = frame_min;
            }
            let wr = wr.min(d);
            let hr = hr.min(d);
            let p_max = (wr.min(hr) as f64 / 2.0).floor().max(4.0);
            let p = region.strength.max(4.0).min(p_max).round() as u32;

            let dh = d as f64 / 2.0;
            // Identical strings in crop and overlay keep the patch aligned.
            let cxe = format!(
                "{}-{}",
                coord_expr(
                    &region.keys,
                    |k| (k.x + k.w / 2.0) * w as f64,
                    dh,
                    w as f64 - dh
                ),
                lit(dh)
            );
            let cye = format!(
                "{}-{}",
                coord_expr(
                    &region.keys,
                    |k| (k.y + k.h / 2.0) * h as f64,
                    dh,
                    h as f64 - dh
                ),
                lit(dh)
            );
            let th = piecewise_expr(&region.keys, |k| k.rot.to_radians());
            let lr = format!("{}r", base);
            let lp = format!("{}p", base);

            parts.push(format!(
                "[{}]format=yuva420p,crop=w={}:h={}:x='{}':y='{}',rotate=a='-({})':c=none[{}]",
                lt, d, d, cxe, cye, th, lr
            ));
            parts.push(format!(
                "[{}]crop=w={}:h={}:x={}:y={},pixelize=width={}:height={}[{}]",
                lr,
                wr,
                hr,
                (d - wr) / 2,
                (d - hr) / 2,
                p,
                p,
                lp
            ));
            parts.push(format!(
                "[{}]rotate=a='{}':ow={}:oh={}:c=none[{}]",
                lp, th, d, d, lm
            ));
            parts.push(format!(
                "[{}][{}]overlay=x='{}':y='{}'{}[{}]",
                lb, lm, cxe, cye, enable, lout
            ));
        }

        cur = lout;
        stage += 1;
    }

    (parts.join(";\n"), cur)
}

fn build_filter_complex(project: &Project) -> (String, Vec<InputSpec>) {
    let s = &project.settings;
    let w = s.width;
    let h = s.height;
    let fps = s.fps;
    let sr = s.sample_rate;

    // Collect all video tracks (bottom to top)
    let video_tracks: Vec<&Track> = project.tracks.iter().filter(|t| t.kind == "video").collect();
    let audio_tracks: Vec<&Track> = project.tracks.iter().filter(|t| t.kind == "audio").collect();

    // Compute total duration T
    let mut total_duration: f64 = 0.001;
    for track in &video_tracks {
        for clip in &track.clips {
            let end = clip.start + (clip.out - clip.clip_in);
            if end > total_duration {
                total_duration = end;
            }
        }
    }
    for track in &audio_tracks {
        for clip in &track.clips {
            let end = clip.start + (clip.out - clip.clip_in);
            if end > total_duration {
                total_duration = end;
            }
        }
    }

    let mut inputs: Vec<InputSpec> = Vec::new();

    let mut filter_parts: Vec<String> = Vec::new();

    // Base video: color source
    filter_parts.push(format!(
        "color=c=black:s={}x{}:r={}:d={}[base]",
        w, h, fps, total_duration
    ));

    // Process video clips
    let mut prev_label = "base".to_string();
    let mut video_clip_idx = 0usize;

    let mut all_video_clips: Vec<(usize, &Clip, &MediaItem, bool)> = Vec::new(); // (track_z, clip, media, is_image)

    for track in &video_tracks {
        for clip in &track.clips {
            let media = project.media.iter().find(|m| m.id == clip.media_id);
            if let Some(media) = media {
                let is_image = media.kind == "image";
                all_video_clips.push((0, clip, media, is_image));
            }
        }
    }

    // input index of each entry in all_video_clips, in order
    let mut video_clip_input_idx: Vec<usize> = Vec::new();

    for (_z, clip, media, is_image) in &all_video_clips {
        let input_idx = inputs.len();
        video_clip_input_idx.push(input_idx);

        let v_label = format!("v{}", video_clip_idx);
        // Pre-mosaic chain ends at fps={fps}; mosaic stages (if any) are inserted
        // here, then the chain continues with format=yuva420p,...,setpts=PTS+start.
        let pre_label = format!("m{}i", video_clip_idx);
        let (mosaic_seg, post_label) =
            build_mosaic_chain(&pre_label, video_clip_idx, &clip.mosaics, w, h);
        let post_chain = format!(
            "format=yuva420p,colorchannelmixer=aa={},setpts=PTS+{}/TB[{}]",
            clip.opacity, clip.start, v_label
        );

        if *is_image {
            inputs.push(InputSpec {
                arg: media.path.clone(),
                lavfi: false,
                loop_dur: Some(clip.out - clip.clip_in),
            });
            filter_parts.push(format!(
                "[{}:v]scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={}[{}]",
                input_idx, w, h, w, h, fps, pre_label
            ));
        } else {
            inputs.push(InputSpec {
                arg: media.path.clone(),
                lavfi: false,
                loop_dur: None,
            });
            filter_parts.push(format!(
                "[{}:v]trim=start={}:end={},setpts=PTS-STARTPTS,scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={}[{}]",
                input_idx, clip.clip_in, clip.out, w, h, w, h, fps, pre_label
            ));
        }
        if !mosaic_seg.is_empty() {
            filter_parts.push(mosaic_seg);
        }
        filter_parts.push(format!("[{}]{}", post_label, post_chain));

        // overlay without an enable window would show the first frame before
        // the clip starts (framesync extends it backwards)
        let clip_end = clip.start + (clip.out - clip.clip_in);
        let out_label = format!("o{}", video_clip_idx);
        filter_parts.push(format!(
            "[{}][v{}]overlay=eof_action=pass:enable='between(t,{},{})'[{}]",
            prev_label, video_clip_idx, clip.start, clip_end, out_label
        ));
        prev_label = out_label;
        video_clip_idx += 1;
    }

    // Final video label
    if video_clip_idx == 0 {
        filter_parts.push(format!("[base]copy[vout]"));
    } else {
        // rename last overlay output to vout
        let last = filter_parts.pop().unwrap();
        filter_parts.push(last.replace(&format!("[o{}]", video_clip_idx - 1), "[vout]"));
    }

    // Audio: anullsrc base (added as -f lavfi -i by the caller)
    let anull_input_idx = inputs.len();
    inputs.push(InputSpec {
        arg: format!(
            "anullsrc=channel_layout=stereo:sample_rate={}:d={}",
            sr, total_duration
        ),
        lavfi: true,
        loop_dur: None,
    });

    filter_parts.push(format!("[{}:a]acopy[abase]", anull_input_idx));

    // Collect audio clips
    let mut audio_sources: Vec<String> = Vec::new();

    // Video clips with audio (each clip has its own dedicated input)
    let mut audio_idx = 0usize;
    for (i, (_z, clip, media, is_image)) in all_video_clips.iter().enumerate() {
        if *is_image {
            continue;
        }
        if media.has_audio && clip.volume > 0.0 {
            let input_pos = video_clip_input_idx[i];
            let start_ms = (clip.start * 1000.0) as u64;
            let a_label = format!("a{}", audio_idx);
            filter_parts.push(format!(
                "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS,volume={},adelay={}|{},apad[{}]",
                input_pos, clip.clip_in, clip.out, clip.volume, start_ms, start_ms, a_label
            ));
            audio_sources.push(format!("[{}]", a_label));
            audio_idx += 1;
        }
    }

    // Audio track clips
    for track in &audio_tracks {
        for clip in &track.clips {
            let media = project.media.iter().find(|m| m.id == clip.media_id);
            if let Some(media) = media {
                let input_pos = inputs.len();
                inputs.push(InputSpec {
                    arg: media.path.clone(),
                    lavfi: false,
                    loop_dur: None,
                });
                let start_ms = (clip.start * 1000.0) as u64;
                let a_label = format!("a{}", audio_idx);
                filter_parts.push(format!(
                    "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS,volume={},adelay={}|{},apad[{}]",
                    input_pos, clip.clip_in, clip.out, clip.volume, start_ms, start_ms, a_label
                ));
                audio_sources.push(format!("[{}]", a_label));
                audio_idx += 1;
            }
        }
    }

    // amix
    if audio_sources.is_empty() {
        filter_parts.push("[abase]acopy[aout]".to_string());
    } else {
        let n = audio_sources.len() + 1;
        let sources_str = format!("[abase]{}", audio_sources.join(""));
        filter_parts.push(format!(
            "{}amix=inputs={}:duration=first:normalize=0[aout]",
            sources_str, n
        ));
    }

    let script = filter_parts.join(";\n");
    (script, inputs)
}

pub fn start_export(
    app: AppHandle,
    project_json: &str,
    out_path: &str,
    state: Arc<ExportState>,
) -> Result<(), String> {
    let project: Project =
        serde_json::from_str(project_json).map_err(|e| format!("Project parse error: {}", e))?;

    let out_path = out_path.to_string();

    tauri::async_runtime::spawn(async move {
        let result = run_export(&app, &project, &out_path, state).await;
        match result {
            Ok(()) => {
                let _ = app.emit("export-done", ExportDone { ok: true, error: None });
            }
            Err(e) => {
                let _ = app.emit(
                    "export-done",
                    ExportDone {
                        ok: false,
                        error: Some(e),
                    },
                );
            }
        }
    });

    Ok(())
}

async fn run_export(
    app: &AppHandle,
    project: &Project,
    out_path: &str,
    state: Arc<ExportState>,
) -> Result<(), String> {
    let (filter_script, inputs) = build_filter_complex(project);

    // Write filter_complex to temp file
    let tmp_dir = std::env::temp_dir();
    let filter_file = tmp_dir.join(format!("videdit_filter_{}.txt", timestamp_nanos()));
    std::fs::write(&filter_file, &filter_script).map_err(|e| e.to_string())?;

    let total_duration = compute_total_duration(project);

    // Build ffmpeg command
    let mut cmd = ffmpeg::ffmpeg_command()
        .ok_or_else(|| "ffmpeg not found in PATH".to_string())?;

    cmd.arg("-y");

    for spec in &inputs {
        if spec.lavfi {
            cmd.args(["-f", "lavfi", "-i", &spec.arg]);
        } else if let Some(dur) = spec.loop_dur {
            cmd.args(["-loop", "1", "-t", &format!("{}", dur), "-i", &spec.arg]);
        } else {
            cmd.args(["-i", &spec.arg]);
        }
    }

    cmd.args([
        "-filter_complex_script",
        filter_file.to_str().unwrap(),
        "-map", "[vout]",
        "-map", "[aout]",
        "-t", &format!("{}", total_duration),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        out_path,
    ]);

    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg spawn failed: {}", e))?;

    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Store child for cancellation
    {
        let mut guard = state.child.lock().unwrap();
        *guard = Some(child);
    }

    // Read stderr for progress
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        // Parse "time=HH:MM:SS.xx"
        if let Some(pos) = line.find("time=") {
            let after = &line[pos + 5..];
            let time_str: String = after.chars().take_while(|c| !c.is_whitespace()).collect();
            if let Some(t) = parse_time_hms(&time_str) {
                let ratio = if total_duration > 0.0 {
                    (t / total_duration).min(1.0)
                } else {
                    0.0
                };
                let _ = app.emit("export-progress", ExportProgress { ratio, time_sec: t });
            }
        }
    }

    // Wait for process
    let exit_status = {
        let mut guard = state.child.lock().unwrap();
        if let Some(ref mut c) = *guard {
            c.wait().map_err(|e| e.to_string())?
        } else {
            return Err("Export was cancelled".to_string());
        }
    };

    // Cleanup
    {
        let mut guard = state.child.lock().unwrap();
        *guard = None;
    }
    let _ = std::fs::remove_file(&filter_file);

    if exit_status.success() {
        Ok(())
    } else {
        Err(format!("ffmpeg exited with status: {:?}", exit_status.code()))
    }
}

fn compute_total_duration(project: &Project) -> f64 {
    let mut total: f64 = 0.001;
    for track in &project.tracks {
        for clip in &track.clips {
            let end = clip.start + (clip.out - clip.clip_in);
            if end > total {
                total = end;
            }
        }
    }
    total
}

fn timestamp_nanos() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Project {
        let json = r#"{
            "version": 1,
            "settings": { "width": 640, "height": 360, "fps": 30, "sampleRate": 48000 },
            "media": [
                { "id": "m1", "path": "a.mp4", "kind": "video", "duration": 10.0, "hasAudio": true },
                { "id": "m2", "path": "b.png", "kind": "image", "duration": 0.0, "hasAudio": false },
                { "id": "m3", "path": "c.mp3", "kind": "audio", "duration": 10.0, "hasAudio": true }
            ],
            "tracks": [
                { "id": "t1", "kind": "video", "name": "V1", "clips": [
                    { "id": "c1", "mediaId": "m1", "start": 0.0, "in": 0.5, "out": 2.5, "volume": 1.0, "opacity": 1.0 },
                    { "id": "c2", "mediaId": "m2", "start": 2.5, "in": 0.0, "out": 2.0, "volume": 1.0, "opacity": 1.0 }
                ]},
                { "id": "t2", "kind": "video", "name": "V2", "clips": [
                    { "id": "c3", "mediaId": "m1", "start": 1.0, "in": 3.0, "out": 4.0, "volume": 0.5, "opacity": 0.5 }
                ]},
                { "id": "t3", "kind": "audio", "name": "A1", "clips": [
                    { "id": "c4", "mediaId": "m3", "start": 0.5, "in": 0.0, "out": 3.0, "volume": 0.8, "opacity": 1.0 }
                ]}
            ]
        }"#;
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn filter_graph_structure() {
        let project = fixture();
        let (script, inputs) = build_filter_complex(&project);
        println!("--- INPUTS ---");
        for (i, s) in inputs.iter().enumerate() {
            println!("{}: lavfi={} loop_dur={:?} arg={}", i, s.lavfi, s.loop_dur, s.arg);
        }
        println!("--- SCRIPT ---\n{}", script);

        // 3 video clip inputs + anullsrc + 1 audio track input
        assert_eq!(inputs.len(), 5);
        // same media used twice must get distinct inputs
        assert!(script.contains("[vout]"));
        assert!(script.contains("[aout]"));
        // two video-clip audio sources + one audio-track source + abase
        assert!(script.contains("amix=inputs=4"));
        // every input stream consumed at most once
        for idx in 0..inputs.len() {
            for kind in ["v", "a"] {
                let label = format!("[{}:{}]", idx, kind);
                assert!(
                    script.matches(&label).count() <= 1,
                    "input stream {} consumed more than once",
                    label
                );
            }
        }
    }

    fn mosaic_fixture() -> Project {
        // Project 1000x1000 so that normalized coords map to clean pixel values.
        let json = r#"{
            "version": 2,
            "settings": { "width": 1000, "height": 1000, "fps": 30, "sampleRate": 48000 },
            "media": [
                { "id": "m1", "path": "a.mp4", "kind": "video", "duration": 10.0, "hasAudio": true }
            ],
            "tracks": [
                { "id": "t1", "kind": "video", "name": "V1", "clips": [
                    { "id": "c1", "mediaId": "m1", "start": 0.0, "in": 0.5, "out": 3.5, "volume": 1.0, "opacity": 1.0,
                      "mosaics": [
                        { "id": "auto-0", "strength": 20, "enabled": true, "keys": [
                          { "t": 0.0, "x": 0.1, "y": 0.2, "w": 0.2, "h": 0.2, "visible": true },
                          { "t": 1.0, "x": 0.3, "y": 0.2, "w": 0.2, "h": 0.2, "visible": true },
                          { "t": 2.0, "x": 0.3, "y": 0.2, "w": 0.2, "h": 0.2, "visible": false }
                        ] },
                        { "id": "auto-1", "strength": 30, "enabled": false, "keys": [
                          { "t": 0.0, "x": 0.5, "y": 0.5, "w": 0.1, "h": 0.1, "visible": true }
                        ] }
                      ]
                    }
                ]}
            ]
        }"#;
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn mosaic_filter_structure() {
        let project = mosaic_fixture();
        let (script, inputs) = build_filter_complex(&project);
        println!("--- MOSAIC SCRIPT ---\n{}", script);

        // No input stream is consumed more than once.
        for idx in 0..inputs.len() {
            for kind in ["v", "a"] {
                let label = format!("[{}:{}]", idx, kind);
                assert!(
                    script.matches(&label).count() <= 1,
                    "input stream {} consumed more than once",
                    label
                );
            }
        }

        assert!(script.contains("[vout]"));
        assert!(script.contains("[aout]"));

        // Mosaic stages present (enabled region only).
        assert!(script.contains("split=2"));
        assert!(script.contains("crop=w="));
        assert!(script.contains("pixelize=width="));
        assert!(script.contains("overlay=x="));

        // Disabled region (auto-1) must not emit any stage. With one enabled
        // region we get exactly one split.
        assert_eq!(script.matches("split=2").count(), 1);

        // Crop size: max w/h = 0.2 * 1000 = 200 (already even, >=16).
        assert!(
            script.contains("crop=w=200:h=200:"),
            "expected crop size 200x200"
        );

        // X interpolation domain: first segment t in [0,1], x goes 0.1->0.3
        // i.e. 100px -> 300px. The expr nests if(lt(t,1),...) and the later
        // segment if(lt(t,2),...). Verify tau-domain numbers are embedded.
        assert!(script.contains("if(lt(t,1)"), "missing first segment guard");
        assert!(script.contains("if(lt(t,2)"), "missing second segment guard");
        // Slope of first x segment = (300-100)/(1-0) = 200, base 100.
        assert!(script.contains("100+200*(t-0)"), "missing x lerp expression");
        // Clamp to [0, W-Wr] = [0, 800].
        assert!(script.contains("clip("), "missing clamp");
        assert!(script.contains(",0,800)"), "missing x clamp bound 800");

        // VIS: visible for [0,2), not visible after t=2 -> enable present.
        assert!(script.contains("enable='between(t,0,2)"), "missing vis window");

        // pixelize P = clamp(20,4,100) = 20.
        assert!(script.contains("pixelize=width=20:height=20"), "wrong P");
    }

    #[test]
    fn mosaic_rotation_structure() {
        let json = r#"{
            "version": 2,
            "settings": { "width": 1000, "height": 1000, "fps": 30, "sampleRate": 48000 },
            "media": [
                { "id": "m1", "path": "a.mp4", "kind": "video", "duration": 10.0, "hasAudio": false }
            ],
            "tracks": [
                { "id": "t1", "kind": "video", "name": "V1", "clips": [
                    { "id": "c1", "mediaId": "m1", "start": 0.0, "in": 0.5, "out": 3.5,
                      "volume": 1.0, "opacity": 1.0,
                      "mosaics": [
                        { "id": "mz1", "strength": 20, "enabled": true, "keys": [
                          { "t": 0.0, "x": 0.3, "y": 0.3, "w": 0.2, "h": 0.1, "visible": true, "rot": 0 },
                          { "t": 2.0, "x": 0.3, "y": 0.3, "w": 0.2, "h": 0.1, "visible": true, "rot": 90 }
                        ] }
                      ]
                    }
                ]}
            ]
        }"#;
        let project: Project = serde_json::from_str(json).unwrap();
        let (script, _inputs) = build_filter_complex(&project);
        println!("--- ROT SCRIPT ---\n{}", script);

        // Rotation path: two rotate stages with transparent fill.
        assert_eq!(script.matches("rotate=a=").count(), 2);
        assert_eq!(script.matches(":c=none").count(), 2);
        // D = even_ceil(hypot(200,100)) = 224, window crop present.
        assert!(script.contains("crop=w=224:h=224:"), "missing DxD window crop");
        // Inner axis-aligned crop of the rect at the window center.
        assert!(script.contains("crop=w=200:h=100:x=12:y=62"), "missing inner crop");
        // Center-x: (0.3+0.1)*1000 = 400, clamped to [112, 888], minus 112.
        assert!(script.contains(",112,888)"), "missing center x clamp");
        assert!(script.contains("-112"), "missing center x offset");
        // Theta lerp 0 -> pi/2 over [0,2]: slope ~0.7854 rad/s.
        assert!(script.contains("0.7854"), "missing radians lerp");
        assert!(script.contains("pixelize=width=20:height=20"));
        // Old key data without `rot` must keep working (serde default).
        let legacy: MosaicKey =
            serde_json::from_str(r#"{ "t":0,"x":0,"y":0,"w":0.1,"h":0.1,"visible":true }"#)
                .unwrap();
        assert_eq!(legacy.rot, 0.0);
    }
}
