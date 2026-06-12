mod detect;
mod export;
mod ffmpeg;
mod media;
mod project;

use detect::AutoMosaicState;
use export::ExportState;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegStatus {
    ffmpeg: bool,
    ffprobe: bool,
    version: Option<String>,
}

#[tauri::command]
fn check_ffmpeg() -> FfmpegStatus {
    let has_ffmpeg = ffmpeg::find_ffmpeg().is_some();
    let has_ffprobe = ffmpeg::find_ffprobe().is_some();
    let version = if has_ffmpeg {
        ffmpeg::get_ffmpeg_version()
    } else {
        None
    };
    FfmpegStatus {
        ffmpeg: has_ffmpeg,
        ffprobe: has_ffprobe,
        version,
    }
}

#[tauri::command]
fn probe_media(path: String) -> Result<media::MediaInfo, String> {
    media::probe_media(&path)
}

#[tauri::command]
fn make_thumbnail(path: String, time_sec: f64) -> Result<String, String> {
    media::make_thumbnail(&path, time_sec)
}

#[tauri::command]
fn save_project(path: String, json: String) -> Result<(), String> {
    project::save_project(&path, &json)
}

#[tauri::command]
fn load_project(path: String) -> Result<String, String> {
    project::load_project(&path)
}

#[tauri::command]
fn export_video(
    project_json: String,
    out_path: String,
    app: tauri::AppHandle,
    state: State<'_, Arc<ExportState>>,
) -> Result<(), String> {
    let state_clone = Arc::clone(&state);
    export::start_export(app, &project_json, &out_path, state_clone)
}

#[tauri::command]
fn cancel_export(state: State<'_, Arc<ExportState>>) {
    export::cancel_export(&state);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let export_state = Arc::new(ExportState::new());
    let automosaic_state = Arc::new(AutoMosaicState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(export_state)
        .manage(automosaic_state)
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            probe_media,
            make_thumbnail,
            save_project,
            load_project,
            export_video,
            cancel_export,
            detect::auto_mosaic,
            detect::cancel_auto_mosaic,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
