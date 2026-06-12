// Media bin: add media via dialog, probe + thumbnail, cards, custom drag to timeline.
import { open } from "@tauri-apps/plugin-dialog";
import { Store, Media, Clip, uid, clipLength } from "./state";
import { probeMedia, makeThumbnail } from "./ipc";

const IMAGE_DEFAULT_DUR = 5; // seconds for image clip default
const DRAG_THRESHOLD = 4; // px before a press becomes a drag

// Drop handler: place media at a screen position (timeline) or bin-only.
export type MediaDropFn = (media: Media, clientX: number, clientY: number) => void;
// Hover handler during custom drag, for timeline highlight (null = not over timeline).
export type MediaDragMoveFn = (media: Media | null, clientX: number, clientY: number) => void;

export class MediaBin {
  private store: Store;
  private container: HTMLElement;
  private addBtn: HTMLElement;
  private onDrop: MediaDropFn | null = null;
  private onDragMove: MediaDragMoveFn | null = null;

  // active custom drag state
  private dragMedia: Media | null = null;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private ghost: HTMLElement | null = null;

  constructor(store: Store, container: HTMLElement, addBtn: HTMLElement) {
    this.store = store;
    this.container = container;
    this.addBtn = addBtn;
    this.addBtn.addEventListener("click", () => void this.addMedia());
    window.addEventListener("mousemove", (e) => this.onDragMoveEvent(e));
    window.addEventListener("mouseup", (e) => this.onDragUp(e));
    store.subscribe(() => this.render());
    this.render();
  }

  // Wire drop / hover handlers (placement logic lives in main.ts, shared with OS DnD).
  setDropHandler(onDrop: MediaDropFn, onDragMove: MediaDragMoveFn): void {
    this.onDrop = onDrop;
    this.onDragMove = onDragMove;
  }

  async addMedia(): Promise<void> {
    const selected = await open({
      multiple: true,
      filters: [
        { name: "メディア", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "wav", "aac", "flac", "ogg", "m4a", "jpg", "jpeg", "png", "gif", "bmp", "webp"] },
        { name: "動画", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] },
        { name: "音声", extensions: ["mp3", "wav", "aac", "flac", "ogg", "m4a"] },
        { name: "画像", extensions: ["jpg", "jpeg", "png", "gif", "bmp", "webp"] },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const path of paths) {
      await this.importPath(path);
    }
  }

  private async importPath(path: string): Promise<void> {
    try {
      const info = await probeMedia(path);
      const name = path.split(/[\\/]/).pop() || path;
      const media: Media = {
        id: uid("m"),
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
      this.store.commit(() => {
        this.store.project.media.push(media);
      });
    } catch (e) {
      console.error("import failed", path, e);
      alert(`メディアの読み込みに失敗しました:\n${path}\n${String(e)}`);
    }
  }

  private render(): void {
    this.container.innerHTML = "";
    for (const m of this.store.project.media) {
      const card = document.createElement("div");
      card.className = "media-card";
      card.dataset.mediaId = m.id;

      const thumb = document.createElement("div");
      thumb.className = "media-thumb";
      if (m.thumb) {
        const img = document.createElement("img");
        img.src = m.thumb;
        thumb.appendChild(img);
      } else {
        thumb.textContent = m.kind === "audio" ? "♪" : m.kind === "image" ? "🖼" : "🎞";
      }

      const meta = document.createElement("div");
      meta.className = "media-meta";
      const nameEl = document.createElement("div");
      nameEl.className = "media-name";
      nameEl.textContent = m.name || m.path;
      nameEl.title = m.path;
      const durEl = document.createElement("div");
      durEl.className = "media-dur";
      durEl.textContent = m.kind === "image" ? "画像" : fmtDur(m.duration);
      meta.appendChild(nameEl);
      meta.appendChild(durEl);

      card.appendChild(thumb);
      card.appendChild(meta);

      // Custom mousedown-based drag (HTML5 DnD is broken under WebView2 dragDropEnabled).
      card.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.dragMedia = m;
        this.dragging = false;
        this.downX = e.clientX;
        this.downY = e.clientY;
      });
      card.addEventListener("dblclick", () => this.appendToTrack(m));

      this.container.appendChild(card);
    }
  }

  private onDragMoveEvent(e: MouseEvent): void {
    if (!this.dragMedia) return;
    if (!this.dragging) {
      if (Math.abs(e.clientX - this.downX) < DRAG_THRESHOLD && Math.abs(e.clientY - this.downY) < DRAG_THRESHOLD) {
        return;
      }
      this.dragging = true;
      this.makeGhost(this.dragMedia);
    }
    if (this.ghost) {
      this.ghost.style.left = `${e.clientX + 8}px`;
      this.ghost.style.top = `${e.clientY + 8}px`;
    }
    this.onDragMove?.(this.dragMedia, e.clientX, e.clientY);
  }

  private onDragUp(e: MouseEvent): void {
    if (!this.dragMedia) return;
    const media = this.dragMedia;
    const wasDragging = this.dragging;
    this.dragMedia = null;
    this.dragging = false;
    this.removeGhost();
    this.onDragMove?.(null, e.clientX, e.clientY);
    if (wasDragging) this.onDrop?.(media, e.clientX, e.clientY);
  }

  private makeGhost(m: Media): void {
    this.removeGhost();
    const g = document.createElement("div");
    g.className = "drag-ghost";
    g.textContent = m.name || m.path.split(/[\\/]/).pop() || "media";
    document.body.appendChild(g);
    this.ghost = g;
  }

  private removeGhost(): void {
    if (this.ghost) {
      this.ghost.remove();
      this.ghost = null;
    }
  }

  // Build a clip for given media.
  makeClip(m: Media, start: number): Clip {
    return {
      id: uid("c"),
      mediaId: m.id,
      start,
      in: 0,
      out: m.kind === "image" ? IMAGE_DEFAULT_DUR : m.duration,
      volume: 1,
      opacity: 1,
      mosaics: [],
    };
  }

  // Double-click: append to end of a suitable track.
  private appendToTrack(m: Media): void {
    const wantKind = m.kind === "audio" ? "audio" : "video";
    const track = this.store.project.tracks.find((t) => t.kind === wantKind);
    if (!track) return;
    let end = 0;
    for (const c of track.clips) end = Math.max(end, c.start + clipLength(c));
    const clip = this.makeClip(m, end);
    this.store.commit(() => {
      track.clips.push(clip);
      this.store.selectClip(clip.id);
    });
  }
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
