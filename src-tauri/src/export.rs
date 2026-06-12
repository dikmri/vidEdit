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

        if *is_image {
            inputs.push(InputSpec {
                arg: media.path.clone(),
                lavfi: false,
                loop_dur: Some(clip.out - clip.clip_in),
            });
            let v_label = format!("v{}", video_clip_idx);
            filter_parts.push(format!(
                "[{}:v]scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={},format=yuva420p,colorchannelmixer=aa={},setpts=PTS+{}/TB[{}]",
                input_idx, w, h, w, h, fps, clip.opacity, clip.start, v_label
            ));
        } else {
            inputs.push(InputSpec {
                arg: media.path.clone(),
                lavfi: false,
                loop_dur: None,
            });
            let v_label = format!("v{}", video_clip_idx);
            filter_parts.push(format!(
                "[{}:v]trim=start={}:end={},setpts=PTS-STARTPTS,scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={},format=yuva420p,colorchannelmixer=aa={},setpts=PTS+{}/TB[{}]",
                input_idx, clip.clip_in, clip.out, w, h, w, h, fps, clip.opacity, clip.start, v_label
            ));
        }

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
}
