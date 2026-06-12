// Media bin: add media via dialog, probe + thumbnail, cards, DnD to timeline.
import { open } from "@tauri-apps/plugin-dialog";
import { Store, Media, Clip, uid, clipLength } from "./state";
import { probeMedia, makeThumbnail } from "./ipc";

const IMAGE_DEFAULT_DUR = 5; // seconds for image clip default

export class MediaBin {
  private store: Store;
  private container: HTMLElement;
  private addBtn: HTMLElement;

  constructor(store: Store, container: HTMLElement, addBtn: HTMLElement) {
    this.store = store;
    this.container = container;
    this.addBtn = addBtn;
    this.addBtn.addEventListener("click", () => void this.addMedia());
    store.subscribe(() => this.render());
    this.render();
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
      card.draggable = true;
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

      card.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/media-id", m.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      });
      card.addEventListener("dblclick", () => this.appendToTrack(m));

      this.container.appendChild(card);
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
      this.store.selectedClipId = clip.id;
    });
  }
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
