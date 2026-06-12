// App entry: init store, wire header/toolbar, ffmpeg check, shortcuts, OS + custom DnD.
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Store, newProject, Project, Media, migrateProject } from "./state";
import { Timeline } from "./timeline";
import { Preview } from "./preview";
import { MediaBin } from "./mediabin";
import { MosaicUI } from "./mosaicui";
import { ExportUI } from "./exportui";
import { initUpdater } from "./updater";
import { checkFfmpeg, saveProject, loadProject, probeMedia, makeThumbnail } from "./ipc";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as T;
};

const store = new Store(newProject());

const previewCanvas = $<HTMLCanvasElement>("#preview-canvas");
const timelineCanvas = $<HTMLCanvasElement>("#timeline-canvas");
const hiddenHost = $("#hidden-media");

const preview = new Preview(previewCanvas, store, hiddenHost);
const timeline = new Timeline(timelineCanvas, store);
const mediabin = new MediaBin(store, $("#media-list"), $("#btn-add-media"));
const mosaicUI = new MosaicUI(store, preview, previewCanvas, $("#mosaic-panel"));
const exportUI = new ExportUI(store);

// ---- title / dirty mark ----
function updateTitle(): void {
  const name = store.project.name || "untitled";
  const mark = store.dirty ? "*" : "";
  $("#project-name").textContent = `${mark}${name}`;
  document.title = `${mark}${name} — vidEdit`;
  ($("#btn-undo") as HTMLButtonElement).disabled = !store.canUndo();
  ($("#btn-redo") as HTMLButtonElement).disabled = !store.canRedo();
}
store.subscribe(updateTitle);
updateTitle();

// keep paused preview synced after timeline seeks (subscribe driven)
store.subscribe(() => {
  if (!preview.isPlaying()) preview.seekRender();
});

// ---- header buttons ----
$("#btn-new").addEventListener("click", () => void doNew());
$("#btn-open").addEventListener("click", () => void doOpen());
$("#btn-save").addEventListener("click", () => void doSave(false));
$("#btn-saveas").addEventListener("click", () => void doSave(true));
$("#btn-undo").addEventListener("click", () => store.undo());
$("#btn-redo").addEventListener("click", () => store.redo());

// ---- toolbar ----
$("#btn-split").addEventListener("click", () => timeline.splitAtPlayhead());
$("#btn-delete").addEventListener("click", () => timeline.deleteSelected());
$("#btn-zoom-in").addEventListener("click", () => timeline.zoom(1.3));
$("#btn-zoom-out").addEventListener("click", () => timeline.zoom(1 / 1.3));
$("#btn-add-v").addEventListener("click", () => addTrack("video"));
$("#btn-add-a").addEventListener("click", () => addTrack("audio"));
$("#btn-export").addEventListener("click", () => void exportUI.start());
$("#btn-play").addEventListener("click", () => preview.togglePlay());

preview.setOnStateChange(() => {
  $("#btn-play").textContent = preview.isPlaying() ? "❚❚" : "▶";
});

function addTrack(kind: "video" | "audio"): void {
  store.commit(() => {
    const count = store.project.tracks.filter((t) => t.kind === kind).length + 1;
    const prefix = kind === "video" ? "V" : "A";
    store.project.tracks.push({
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind,
      name: `${prefix}${count}`,
      clips: [],
    });
  });
}

// ---- file ops ----
async function confirmDiscard(): Promise<boolean> {
  if (!store.dirty) return true;
  return window.confirm("保存されていない変更があります。破棄しますか?");
}

async function doNew(): Promise<void> {
  if (!(await confirmDiscard())) return;
  store.setProject(newProject(), null);
}

async function doOpen(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const path = await open({
    multiple: false,
    filters: [{ name: "vidEdit プロジェクト", extensions: ["vep"] }],
  });
  if (!path || Array.isArray(path)) return;
  try {
    const json = await loadProject(path);
    const proj = migrateProject(JSON.parse(json) as Project);
    // restore front-only fields (name) for media
    for (const m of proj.media) {
      if (!m.name) m.name = m.path.split(/[\\/]/).pop() || m.path;
    }
    store.setProject(proj, path);
  } catch (e) {
    alert(`プロジェクトを開けませんでした:\n${String(e)}`);
  }
}

async function doSave(forceDialog: boolean): Promise<void> {
  let path = store.filePath;
  if (forceDialog || !path) {
    const chosen = await save({
      defaultPath: `${store.project.name || "untitled"}.vep`,
      filters: [{ name: "vidEdit プロジェクト", extensions: ["vep"] }],
    });
    if (!chosen) return;
    path = chosen;
    // derive project name from filename
    const base = path.split(/[\\/]/).pop() || "untitled.vep";
    store.project.name = base.replace(/\.vep$/i, "");
  }
  try {
    await saveProject(path, JSON.stringify(store.project, null, 2));
    store.markSaved(path);
  } catch (e) {
    alert(`保存に失敗しました:\n${String(e)}`);
  }
}

// ---- keyboard ----
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      void doSave(e.shiftKey);
      return;
    }
    if (k === "o") {
      e.preventDefault();
      void doOpen();
      return;
    }
    if (k === "n") {
      e.preventDefault();
      void doNew();
      return;
    }
    if (k === "z") {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (k === "y") {
      e.preventDefault();
      store.redo();
      return;
    }
    return;
  }
  if (isTyping()) return;
  // mosaic keyframe shortcuts (K/H) when a clip + region is selected
  if ((e.key === "k" || e.key === "K" || e.key === "h" || e.key === "H") && mosaicUI.handleKey(e.key)) {
    e.preventDefault();
    return;
  }
  if (e.key === " ") {
    e.preventDefault();
    preview.togglePlay();
  } else if (e.key === "s" || e.key === "S") {
    timeline.splitAtPlayhead();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    timeline.deleteSelected();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    preview.stepFrame(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    preview.stepFrame(1);
  }
});

// ---- media placement (shared by custom drag + OS DnD) ----
// Drop media at a screen position: onto the timeline if over it, else bin-only.
function dropMediaAtScreen(media: Media, clientX: number, clientY: number): void {
  const kind = media.kind === "audio" ? "audio" : "video";
  const resolved = timeline.resolveDrop(clientX, clientY, kind);
  if (resolved) {
    timeline.placeMedia(media, (m, start) => mediabin.makeClip(m, start), resolved.trackIndex, resolved.sec);
  }
  // bin-only when not over the timeline (media already exists in bin)
}

// Highlight the timeline drop target during a drag.
function hintDrop(media: Media | null, clientX: number, clientY: number): void {
  if (!media) {
    timeline.setDropHint(null);
    return;
  }
  const kind = media.kind === "audio" ? "audio" : "video";
  timeline.setDropHint(timeline.resolveDrop(clientX, clientY, kind));
}

mediabin.setDropHandler(dropMediaAtScreen, hintDrop);

// ---- OS drag & drop (Tauri webview) ----
const MEDIA_EXTS = new Set([
  "mp4", "mov", "mkv", "webm", "avi", "m4v",
  "mp3", "wav", "aac", "flac", "ogg", "m4a",
  "jpg", "jpeg", "png", "gif", "bmp", "webp",
]);

function isMediaPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() || "";
  return MEDIA_EXTS.has(ext);
}

// PhysicalPosition -> client (CSS) coords.
function physToClient(pos: { x: number; y: number }): { x: number; y: number } {
  const dpr = window.devicePixelRatio || 1;
  return { x: pos.x / dpr, y: pos.y / dpr };
}

// Import a dropped path into the media bin, returning the created Media.
async function importDroppedPath(path: string): Promise<Media | null> {
  try {
    const info = await probeMedia(path);
    const name = path.split(/[\\/]/).pop() || path;
    const media: Media = {
      id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      path,
      kind: info.kind,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio,
      name,
    };
    let thumb = "";
    try {
      thumb = await makeThumbnail(path, Math.min(1, info.duration / 2 || 0));
    } catch {
      thumb = "";
    }
    media.thumb = thumb;
    store.commit(() => {
      store.project.media.push(media);
    });
    return media;
  } catch (e) {
    console.error("OS drop import failed", path, e);
    return null;
  }
}

void getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "over") {
    const c = physToClient(p.position);
    // highlight whichever target the cursor is over (track or null)
    const overTimeline = timeline.resolveDrop(c.x, c.y, "video") || timeline.resolveDrop(c.x, c.y, "audio");
    timeline.setDropHint(overTimeline);
  } else if (p.type === "leave") {
    timeline.setDropHint(null);
  } else if (p.type === "drop") {
    timeline.setDropHint(null);
    const c = physToClient(p.position);
    const paths = p.paths.filter((pp) => isMediaPath(pp) && !pp.toLowerCase().endsWith(".vep"));
    void (async () => {
      for (const path of paths) {
        const media = await importDroppedPath(path);
        if (media) dropMediaAtScreen(media, c.x, c.y);
      }
    })();
  }
});

// ---- ffmpeg check ----
async function runFfmpegCheck(): Promise<void> {
  try {
    const st = await checkFfmpeg();
    if (!st.ffmpeg || !st.ffprobe) {
      showFfmpegWarning();
    }
  } catch {
    showFfmpegWarning();
  }
}

function showFfmpegWarning(): void {
  const host = $("#notice-bar");
  const bar = document.createElement("div");
  bar.className = "warn-bar";
  bar.innerHTML = `
    <span>FFmpeg が見つかりません。書き出しとメディア解析に必要です。</span>
    <code>Windows: winget install Gyan.FFmpeg</code>
    <code>macOS: brew install ffmpeg</code>
    <code>Linux: sudo apt install ffmpeg</code>
    <button class="warn-close">×</button>`;
  bar.querySelector(".warn-close")?.addEventListener("click", () => bar.remove());
  host.appendChild(bar);
}

void runFfmpegCheck();
initUpdater($("#notice-bar"));
