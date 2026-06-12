use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::ffmpeg;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub kind: String,
    pub duration: f64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub has_audio: bool,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    streams: Vec<FfprobeStream>,
    format: FfprobeFormat,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    nb_frames: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

fn parse_fps(rate_str: &str) -> Option<f64> {
    let parts: Vec<&str> = rate_str.split('/').collect();
    if parts.len() == 2 {
        let num: f64 = parts[0].parse().ok()?;
        let den: f64 = parts[1].parse().ok()?;
        if den == 0.0 {
            return None;
        }
        Some(num / den)
    } else {
        rate_str.parse().ok()
    }
}

fn is_image_extension(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp")
}

pub fn probe_media(path: &str) -> Result<MediaInfo, String> {
    let path_buf = Path::new(path);

    let mut cmd = ffmpeg::ffprobe_command()
        .ok_or_else(|| "ffprobe not found in PATH".to_string())?;

    cmd.args([
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        path,
    ]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    let output = cmd.output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!("ffprobe failed for path: {}", path));
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let probe: FfprobeOutput =
        serde_json::from_str(&json_str).map_err(|e| format!("ffprobe json parse error: {}", e))?;

    let duration: f64 = probe
        .format
        .duration
        .as_deref()
        .and_then(|d| d.parse().ok())
        .unwrap_or(0.0);

    let mut has_video = false;
    let mut has_audio = false;
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;
    let mut fps: Option<f64> = None;
    let mut video_codec: Option<String> = None;
    let mut is_single_frame = false;

    for stream in &probe.streams {
        match stream.codec_type.as_deref() {
            Some("video") => {
                has_video = true;
                width = stream.width;
                height = stream.height;
                video_codec = stream.codec_name.clone();

                // Check if single frame (mjpeg, png decoder, or nb_frames=1)
                let codec = stream.codec_name.as_deref().unwrap_or("");
                if matches!(codec, "mjpeg" | "png" | "gif") {
                    is_single_frame = true;
                }
                if let Some(nb) = &stream.nb_frames {
                    if nb == "1" {
                        is_single_frame = true;
                    }
                }

                // Parse fps
                if let Some(rate) = &stream.r_frame_rate {
                    fps = parse_fps(rate);
                }
                if fps.is_none() || fps == Some(0.0) {
                    if let Some(rate) = &stream.avg_frame_rate {
                        fps = parse_fps(rate);
                    }
                }
            }
            Some("audio") => {
                has_audio = true;
            }
            _ => {}
        }
    }

    let kind = if has_video {
        // Image detection: extension-based or single-frame codec
        if is_image_extension(path_buf) || is_single_frame {
            "image".to_string()
        } else {
            let _ = video_codec;
            "video".to_string()
        }
    } else {
        "audio".to_string()
    };

    Ok(MediaInfo {
        kind,
        duration,
        width,
        height,
        fps,
        has_audio,
    })
}

pub fn make_thumbnail(path: &str, time_sec: f64) -> Result<String, String> {
    let path_buf = Path::new(path);
    let ext = path_buf
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let is_image = is_image_extension(path_buf);

    let tmp_dir = std::env::temp_dir();
    let tmp_file = tmp_dir.join(format!("videdit_thumb_{}.jpg", uuid_simple()));

    let mut cmd = ffmpeg::ffmpeg_command()
        .ok_or_else(|| "ffmpeg not found in PATH".to_string())?;

    if is_image {
        cmd.args([
            "-y",
            "-i", path,
            "-vf", "scale=160:-1",
            "-frames:v", "1",
            "-f", "image2",
        ]);
        cmd.arg(tmp_file.to_str().unwrap());
    } else {
        let seek_str = format!("{}", time_sec);
        cmd.args([
            "-y",
            "-ss", &seek_str,
            "-i", path,
            "-vf", "scale=160:-1",
            "-frames:v", "1",
            "-f", "image2",
        ]);
        cmd.arg(tmp_file.to_str().unwrap());
    }

    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    let status = cmd.status().map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = ext;
        return Err(format!("ffmpeg thumbnail failed for: {}", path));
    }

    let bytes = std::fs::read(&tmp_file).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp_file);

    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{}", encoded))
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", t)
}
