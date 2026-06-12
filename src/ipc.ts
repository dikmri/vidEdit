// IPC wrappers around Tauri commands (snake_case on Rust side).
import { invoke } from "@tauri-apps/api/core";

export interface FfmpegStatus {
  ffmpeg: boolean;
  ffprobe: boolean;
  version: string | null;
}

export interface MediaInfo {
  kind: "video" | "audio" | "image";
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export function checkFfmpeg(): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>("check_ffmpeg");
}

export function probeMedia(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("probe_media", { path });
}

export function makeThumbnail(path: string, timeSec: number): Promise<string> {
  return invoke<string>("make_thumbnail", { path, timeSec });
}

export function saveProject(path: string, json: string): Promise<void> {
  return invoke<void>("save_project", { path, json });
}

export function loadProject(path: string): Promise<string> {
  return invoke<string>("load_project", { path });
}

export function exportVideo(projectJson: string, outPath: string): Promise<void> {
  return invoke<void>("export_video", { projectJson, outPath });
}

export function cancelExport(): Promise<void> {
  return invoke<void>("cancel_export");
}
