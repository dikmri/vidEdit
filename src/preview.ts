// Preview canvas: fit project resolution, rAF playback, layered drawImage with opacity.
import { convertFileSrc } from "@tauri-apps/api/core";
import { Store, Clip, clipLength } from "./state";

interface VideoEl {
  el: HTMLVideoElement;
  ready: boolean;
}
interface ImageEl {
  el: HTMLImageElement;
  ready: boolean;
}

const SYNC_THRESHOLD = 0.15;

export class Preview {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private store: Store;
  private videos = new Map<string, VideoEl>(); // by mediaId
  private images = new Map<string, ImageEl>(); // by mediaId
  private hidden: HTMLElement;

  private playing = false;
  private lastTs = 0;
  private rafId = 0;
  private onStateChange: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, store: Store, hiddenHost: HTMLElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.store = store;
    this.hidden = hiddenHost;

    store.subscribe(() => {
      this.ensureMediaEls();
      if (!this.playing) this.renderFrame();
    });
    window.addEventListener("resize", () => this.renderFrame());
    this.ensureMediaEls();
    this.renderFrame();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  setOnStateChange(fn: () => void): void {
    this.onStateChange = fn;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  // Create hidden media elements for each media item.
  private ensureMediaEls(): void {
    for (const m of this.store.project.media) {
      if (m.kind === "video" || m.kind === "audio") {
        if (!this.videos.has(m.id)) {
          const el = document.createElement("video");
          el.src = convertFileSrc(m.path);
          el.preload = "auto";
          el.muted = false;
          (el as HTMLVideoElement).playsInline = true;
          const rec: VideoEl = { el, ready: false };
          el.addEventListener("loadeddata", () => {
            rec.ready = true;
            if (!this.playing) this.renderFrame();
          });
          el.addEventListener("seeked", () => {
            if (!this.playing) this.renderFrame();
          });
          this.hidden.appendChild(el);
          this.videos.set(m.id, rec);
        }
      } else if (m.kind === "image") {
        if (!this.images.has(m.id)) {
          const el = new Image();
          el.src = convertFileSrc(m.path);
          const rec: ImageEl = { el, ready: false };
          el.addEventListener("load", () => {
            rec.ready = true;
            if (!this.playing) this.renderFrame();
          });
          this.images.set(m.id, rec);
        }
      }
    }
  }

  // ---- playback ----
  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing) return;
    if (this.store.playhead >= this.store.totalDuration()) {
      this.store.playhead = 0;
    }
    this.playing = true;
    this.lastTs = performance.now();
    this.onStateChange?.();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    for (const v of this.videos.values()) v.el.pause();
    this.onStateChange?.();
  }

  stepFrame(dir: number): void {
    const fps = this.store.project.settings.fps || 30;
    this.pause();
    this.store.playhead = Math.max(0, this.store.playhead + dir / fps);
    this.store.notify();
  }

  private loop(ts: number): void {
    if (this.playing) {
      const dt = (ts - this.lastTs) / 1000;
      this.lastTs = ts;
      this.store.playhead += dt;
      const total = this.store.totalDuration();
      if (this.store.playhead >= total) {
        this.store.playhead = total;
        this.pause();
        this.store.notify();
      } else {
        this.syncAndRender();
        this.store.notify();
      }
    }
    this.rafId = requestAnimationFrame(this.loop);
  }

  // Active clips at playhead across all tracks.
  private activeClips(): { trackIndex: number; clip: Clip; isVideoTrack: boolean }[] {
    const p = this.store.playhead;
    const out: { trackIndex: number; clip: Clip; isVideoTrack: boolean }[] = [];
    this.store.project.tracks.forEach((t, ti) => {
      for (const c of t.clips) {
        if (p >= c.start && p < c.start + clipLength(c)) {
          out.push({ trackIndex: ti, clip: c, isVideoTrack: t.kind === "video" });
        }
      }
    });
    return out;
  }

  private syncAndRender(): void {
    const active = this.activeClips();
    const activeMediaIds = new Set(active.map((a) => a.clip.mediaId));

    // pause/sync all videos
    for (const [mid, v] of this.videos) {
      if (!activeMediaIds.has(mid)) {
        if (!v.el.paused) v.el.pause();
      }
    }

    for (const a of active) {
      const media = this.store.mediaById(a.clip.mediaId);
      if (!media) continue;
      if (media.kind === "video" || media.kind === "audio") {
        const v = this.videos.get(a.clip.mediaId);
        if (!v || !v.ready) continue;
        const want = this.store.playhead - a.clip.start + a.clip.in;
        if (Math.abs(v.el.currentTime - want) > SYNC_THRESHOLD) {
          v.el.currentTime = want;
        }
        v.el.volume = clampVol(a.clip.volume);
        if (this.playing && v.el.paused) {
          void v.el.play().catch(() => {});
        }
      }
    }
    this.renderFrame();
  }

  // ---- drawing ----
  private fitRect(): { x: number; y: number; w: number; h: number } {
    const cw = this.canvas.clientWidth || 640;
    const ch = this.canvas.clientHeight || 360;
    const pw = this.store.project.settings.width;
    const ph = this.store.project.settings.height;
    const scale = Math.min(cw / pw, ch / ph);
    const w = pw * scale;
    const h = ph * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  renderFrame(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth || 640;
    const ch = this.canvas.clientHeight || 360;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#0d0d0d";
    ctx.fillRect(0, 0, cw, ch);

    const fit = this.fitRect();
    ctx.fillStyle = "#000";
    ctx.fillRect(fit.x, fit.y, fit.w, fit.h);

    // video tracks bottom->top (array order); only video-kind tracks draw image.
    const active = this.activeClips()
      .filter((a) => a.isVideoTrack)
      .sort((a, b) => a.trackIndex - b.trackIndex);

    for (const a of active) {
      const media = this.store.mediaById(a.clip.mediaId);
      if (!media) continue;
      ctx.globalAlpha = clamp01(a.clip.opacity);
      if (media.kind === "image") {
        const img = this.images.get(a.clip.mediaId);
        if (img && img.ready) this.drawFitted(img.el, media.width || img.el.naturalWidth, media.height || img.el.naturalHeight, fit);
      } else {
        const v = this.videos.get(a.clip.mediaId);
        if (v && v.ready && v.el.videoWidth > 0) {
          // ensure currentTime synced when paused (seek-driven render)
          this.drawFitted(v.el, v.el.videoWidth, v.el.videoHeight, fit);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // Draw source fitted (contain) into the project frame rect.
  private drawFitted(
    src: CanvasImageSource,
    sw: number,
    sh: number,
    fit: { x: number; y: number; w: number; h: number },
  ): void {
    if (!sw || !sh) return;
    const scale = Math.min(fit.w / sw, fit.h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = fit.x + (fit.w - dw) / 2;
    const dy = fit.y + (fit.h - dh) / 2;
    this.ctx.drawImage(src, dx, dy, dw, dh);
  }

  // For paused seek: set video currentTime; 'seeked' triggers renderFrame.
  seekRender(): void {
    if (this.playing) return;
    const active = this.activeClips();
    let needSeek = false;
    for (const a of active) {
      const media = this.store.mediaById(a.clip.mediaId);
      if (!media || media.kind === "image") continue;
      const v = this.videos.get(a.clip.mediaId);
      if (!v || !v.ready) continue;
      const want = this.store.playhead - a.clip.start + a.clip.in;
      if (Math.abs(v.el.currentTime - want) > SYNC_THRESHOLD) {
        v.el.currentTime = want;
        needSeek = true;
      }
    }
    if (!needSeek) this.renderFrame();
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function clampVol(v: number): number {
  return Math.max(0, Math.min(1, v));
}
