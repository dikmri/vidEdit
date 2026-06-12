// App entry: init store, wire header/toolbar, ffmpeg check, shortcuts, DnD drop.
import { open, save } from "@tauri-apps/plugin-dialog";
import { Store, newProject, Project, Media, clipLength } from "./state";
import { Timeline } from "./timeline";
import { Preview } from "./preview";
import { MediaBin } from "./mediabin";
import { ExportUI } from "./exportui";
import { initUpdater } from "./updater";
import { checkFfmpeg, saveProject, loadProject } from "./ipc";

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
    const proj = JSON.parse(json) as Project;
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

// ---- DnD: media card -> timeline ----
timelineCanvas.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("text/media-id")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
});
timelineCanvas.addEventListener("drop", (e) => {
  const mediaId = e.dataTransfer?.getData("text/media-id");
  if (!mediaId) return;
  e.preventDefault();
  const media = store.mediaById(mediaId);
  if (!media) return;
  dropMediaAt(media, e);
});

function dropMediaAt(media: Media, e: DragEvent): void {
  const HEADER_W = 110;
  const RULER_H = 26;
  const TRACK_H = 64;
  const TRACK_GAP = 2;
  const rect = timelineCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  let sec = store.scrollSec + (x - HEADER_W) / store.pxPerSec;
  if (sec < 0) sec = 0;

  // determine track under cursor
  let trackIndex = -1;
  if (y >= RULER_H) {
    const idx = Math.floor((y - RULER_H) / (TRACK_H + TRACK_GAP));
    if (idx >= 0 && idx < store.project.tracks.length) trackIndex = idx;
  }
  const wantKind = media.kind === "audio" ? "audio" : "video";
  let track =
    trackIndex >= 0 && store.project.tracks[trackIndex].kind === wantKind
      ? store.project.tracks[trackIndex]
      : store.project.tracks.find((t) => t.kind === wantKind);
  if (!track) return;

  const clip = mediabin.makeClip(media, sec);
  const len = clipLength(clip);
  // avoid overlap: push to nearest free spot after sec
  const targetTrack = track;
  let start = sec;
  const sorted = [...targetTrack.clips].sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    const cs = c.start;
    const ce = c.start + clipLength(c);
    if (start < ce && start + len > cs) {
      start = ce; // move past this clip
    }
  }
  clip.start = start;
  store.commit(() => {
    targetTrack.clips.push(clip);
    store.selectedClipId = clip.id;
  });
}

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
