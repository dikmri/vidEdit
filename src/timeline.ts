// Canvas timeline: ruler, track headers, clips, playhead, drag-move, trim, zoom, snap.
import { Store, Clip, Track, clipLength, uid } from "./state";

const HEADER_W = 110; // track header width
const RULER_H = 26;
const TRACK_H = 64;
const TRACK_GAP = 2;
const EDGE_PX = 8; // trim grab zone
const SNAP_PX = 8;
const MIN_PXPS = 10;
const MAX_PXPS = 500;
const MIN_CLIP = 0.05;

const COLORS: Record<string, string> = {
  video: "#3b6ea5",
  image: "#7a5a9e",
  audio: "#3a8f6a",
};
const COLORS_SEL: Record<string, string> = {
  video: "#5a96d6",
  image: "#a87fd0",
  audio: "#54c190",
};

type DragMode = "none" | "seek" | "move" | "trim-l" | "trim-r";

interface DragState {
  mode: DragMode;
  clipId: string | null;
  // pointer offset within clip (sec) for move
  grabOffset: number;
  origStart: number;
  origIn: number;
  origOut: number;
  origTrackId: string;
}

export class Timeline {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private store: Store;
  private drag: DragState = {
    mode: "none",
    clipId: null,
    grabOffset: 0,
    origStart: 0,
    origIn: 0,
    origOut: 0,
    origTrackId: "",
  };
  private hoverCursor = "default";

  constructor(canvas: HTMLCanvasElement, store: Store) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.store = store;

    store.subscribe(() => this.render());
    this.bind();
    window.addEventListener("resize", () => this.render());
    this.render();
  }

  // ---- coordinate helpers ----
  private secToX(sec: number): number {
    return HEADER_W + (sec - this.store.scrollSec) * this.store.pxPerSec;
  }
  private xToSec(x: number): number {
    return this.store.scrollSec + (x - HEADER_W) / this.store.pxPerSec;
  }
  private trackTop(index: number): number {
    return RULER_H + index * (TRACK_H + TRACK_GAP);
  }
  private trackAtY(y: number): number {
    if (y < RULER_H) return -1;
    const idx = Math.floor((y - RULER_H) / (TRACK_H + TRACK_GAP));
    return idx >= 0 && idx < this.store.project.tracks.length ? idx : -1;
  }

  private cssSize(): { w: number; h: number } {
    return {
      w: this.canvas.clientWidth || 800,
      h: this.canvas.clientHeight || 300,
    };
  }

  // ---- rendering ----
  render(): void {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.cssSize();
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // background
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, w, h);

    const tracks = this.store.project.tracks;

    // track lanes
    for (let i = 0; i < tracks.length; i++) {
      const top = this.trackTop(i);
      ctx.fillStyle = i % 2 === 0 ? "#232323" : "#202020";
      ctx.fillRect(HEADER_W, top, w - HEADER_W, TRACK_H);
    }

    this.drawRuler(ctx, w);

    // clips
    for (let i = 0; i < tracks.length; i++) {
      this.drawTrackClips(ctx, tracks[i], i, w);
    }

    // track headers (drawn over lanes for left column)
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, HEADER_W, h);
    for (let i = 0; i < tracks.length; i++) {
      const top = this.trackTop(i);
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(0, top, HEADER_W - 1, TRACK_H);
      ctx.fillStyle = "#ddd";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(tracks[i].name, 10, top + TRACK_H / 2);
      ctx.fillStyle = "#888";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(tracks[i].kind === "video" ? "映像" : "音声", 10, top + TRACK_H / 2 + 16);
    }
    // header/ruler corner
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, HEADER_W, RULER_H);

    this.drawPlayhead(ctx, h);
  }

  private niceStep(): number {
    // choose a ruler step (sec) so labels stay ~80px apart
    const target = 80 / this.store.pxPerSec;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const s of steps) if (s >= target) return s;
    return 600;
  }

  private drawRuler(ctx: CanvasRenderingContext2D, w: number): void {
    ctx.fillStyle = "#181818";
    ctx.fillRect(HEADER_W, 0, w - HEADER_W, RULER_H);
    const step = this.niceStep();
    const startSec = Math.floor(this.store.scrollSec / step) * step;
    ctx.strokeStyle = "#3a3a3a";
    ctx.fillStyle = "#999";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "alphabetic";
    for (let s = startSec; ; s += step) {
      const x = this.secToX(s);
      if (x > w) break;
      if (x < HEADER_W) continue;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 8);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillText(fmtTime(s), x + 3, RULER_H - 10);
    }
    ctx.strokeStyle = "#000";
    ctx.beginPath();
    ctx.moveTo(HEADER_W, RULER_H - 0.5);
    ctx.lineTo(w, RULER_H - 0.5);
    ctx.stroke();
  }

  private drawTrackClips(ctx: CanvasRenderingContext2D, track: Track, index: number, w: number): void {
    const top = this.trackTop(index);
    for (const c of track.clips) {
      const x = this.secToX(c.start);
      const cw = clipLength(c) * this.store.pxPerSec;
      if (x + cw < HEADER_W || x > w) continue;
      const media = this.store.mediaById(c.mediaId);
      const kind = media ? media.kind : track.kind;
      const selected = c.id === this.store.selectedClipId;
      const cx = Math.max(x, HEADER_W);
      const cwClamped = x < HEADER_W ? cw - (HEADER_W - x) : cw;
      ctx.fillStyle = selected ? COLORS_SEL[kind] : COLORS[kind];
      roundRect(ctx, cx, top + 4, Math.max(2, cwClamped), TRACK_H - 8, 4);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = "#7c5cff";
        ctx.lineWidth = 2;
        roundRect(ctx, cx, top + 4, Math.max(2, cwClamped), TRACK_H - 8, 4);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      // label
      const label = (media?.name) || media?.path?.split(/[\\/]/).pop() || "clip";
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx + 4, top + 4, Math.max(2, cwClamped) - 8, TRACK_H - 8);
      ctx.clip();
      ctx.fillStyle = "#eef";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(label, cx + 6, top + 8);
      ctx.restore();
    }
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, h: number): void {
    const x = this.secToX(this.store.playhead);
    if (x < HEADER_W) return;
    ctx.strokeStyle = "#e2433a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = "#e2433a";
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1;
  }

  // ---- hit testing ----
  private hitClip(x: number, y: number): { track: Track; clip: Clip; index: number } | null {
    const idx = this.trackAtY(y);
    if (idx < 0) return null;
    const track = this.store.project.tracks[idx];
    const top = this.trackTop(idx);
    if (y < top + 4 || y > top + TRACK_H - 4) return null;
    for (const c of track.clips) {
      const cx = this.secToX(c.start);
      const cw = clipLength(c) * this.store.pxPerSec;
      if (x >= cx && x <= cx + cw) return { track, clip: c, index: idx };
    }
    return null;
  }

  private edgeAt(clip: Clip, x: number): "l" | "r" | null {
    const cx = this.secToX(clip.start);
    const cw = clipLength(clip) * this.store.pxPerSec;
    if (cw < EDGE_PX * 3) return null; // too small to trim reliably
    if (Math.abs(x - cx) <= EDGE_PX) return "l";
    if (Math.abs(x - (cx + cw)) <= EDGE_PX) return "r";
    return null;
  }

  // ---- snapping ----
  private snapTargets(excludeClipId: string | null): number[] {
    const targets: number[] = [0, this.store.playhead];
    for (const t of this.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id === excludeClipId) continue;
        targets.push(c.start);
        targets.push(c.start + clipLength(c));
      }
    }
    return targets;
  }

  private snapSec(sec: number, excludeClipId: string | null): number {
    const thr = SNAP_PX / this.store.pxPerSec;
    let best = sec;
    let bestD = thr;
    for (const t of this.snapTargets(excludeClipId)) {
      const d = Math.abs(t - sec);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  // ---- overlap check ----
  private overlaps(track: Track, start: number, len: number, excludeId: string): boolean {
    const end = start + len;
    for (const c of track.clips) {
      if (c.id === excludeId) continue;
      const cs = c.start;
      const ce = c.start + clipLength(c);
      if (start < ce - 1e-6 && end > cs + 1e-6) return true;
    }
    return false;
  }

  // ---- events ----
  private bind(): void {
    this.canvas.addEventListener("mousedown", (e) => this.onDown(e));
    window.addEventListener("mousemove", (e) => this.onMove(e));
    window.addEventListener("mouseup", (e) => this.onUp(e));
    this.canvas.addEventListener("mousemove", (e) => this.onHover(e));
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
  }

  private localPos(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: MouseEvent): void {
    const { x, y } = this.localPos(e);
    if (x < HEADER_W) return;

    if (y < RULER_H) {
      // ruler seek
      this.drag.mode = "seek";
      this.seekTo(x);
      return;
    }

    const hit = this.hitClip(x, y);
    if (hit) {
      this.store.selectedClipId = hit.clip.id;
      const edge = this.edgeAt(hit.clip, x);
      this.drag.clipId = hit.clip.id;
      this.drag.origStart = hit.clip.start;
      this.drag.origIn = hit.clip.in;
      this.drag.origOut = hit.clip.out;
      this.drag.origTrackId = hit.track.id;
      if (edge === "l") this.drag.mode = "trim-l";
      else if (edge === "r") this.drag.mode = "trim-r";
      else {
        this.drag.mode = "move";
        this.drag.grabOffset = this.xToSec(x) - hit.clip.start;
      }
      this.store.notify();
    } else {
      // empty area: seek + deselect
      this.store.selectedClipId = null;
      this.drag.mode = "seek";
      this.seekTo(x);
    }
  }

  private seekTo(x: number): void {
    let sec = Math.max(0, this.xToSec(x));
    sec = this.snapSec(sec, null);
    this.store.playhead = Math.max(0, sec);
    this.store.notify();
  }

  private onMove(e: MouseEvent): void {
    if (this.drag.mode === "none") return;
    const { x, y } = this.localPos(e);

    if (this.drag.mode === "seek") {
      this.seekTo(x);
      return;
    }

    const found = this.drag.clipId ? this.store.findClip(this.drag.clipId) : null;
    if (!found) return;
    const { clip } = found;
    const media = this.store.mediaById(clip.mediaId);
    const isImage = media?.kind === "image";

    if (this.drag.mode === "move") {
      let newStart = this.xToSec(x) - this.drag.grabOffset;
      newStart = Math.max(0, newStart);
      // snap clip start and clip end
      const len = clipLength(clip);
      const snapStart = this.snapSec(newStart, clip.id);
      const snapEnd = this.snapSec(newStart + len, clip.id) - len;
      // pick whichever snapped (closer to a target)
      if (Math.abs(snapStart - newStart) <= Math.abs(snapEnd - newStart)) newStart = snapStart;
      else newStart = snapEnd;
      newStart = Math.max(0, newStart);

      // target track (same kind only)
      const idx = this.trackAtY(y);
      let targetTrack = found.track;
      if (idx >= 0) {
        const cand = this.store.project.tracks[idx];
        if (cand.kind === found.track.kind) targetTrack = cand;
      }

      // reject if overlap; keep clip where it is (no move applied) but allow track stay
      if (!this.overlaps(targetTrack, newStart, len, clip.id)) {
        // apply live (without commit; commit on mouseup)
        if (targetTrack.id !== found.track.id) {
          found.track.clips = found.track.clips.filter((c) => c.id !== clip.id);
          targetTrack.clips.push(clip);
        }
        clip.start = newStart;
        this.store.notify();
      }
      return;
    }

    if (this.drag.mode === "trim-l") {
      const desiredStart = Math.max(0, this.snapSec(this.xToSec(x), clip.id));
      let delta = desiredStart - this.drag.origStart;
      // newIn = origIn + delta; constraints
      let newIn = this.drag.origIn + delta;
      let newStart = this.drag.origStart + delta;
      if (!isImage) newIn = Math.max(0, newIn);
      // keep length > MIN_CLIP
      if (clip.out - newIn < MIN_CLIP) {
        newIn = clip.out - MIN_CLIP;
        newStart = this.drag.origStart + (newIn - this.drag.origIn);
      }
      if (newStart < 0) {
        const adj = -newStart;
        newStart = 0;
        newIn += adj;
      }
      // overlap guard
      if (!this.overlaps(found.track, newStart, clip.out - newIn, clip.id)) {
        clip.in = newIn;
        clip.start = newStart;
        this.store.notify();
      }
      return;
    }

    if (this.drag.mode === "trim-r") {
      const desiredEnd = Math.max(0, this.snapSec(this.xToSec(x), clip.id));
      let newOut = this.drag.origIn + (desiredEnd - this.drag.origStart);
      if (newOut - clip.in < MIN_CLIP) newOut = clip.in + MIN_CLIP;
      if (!isImage && media) newOut = Math.min(media.duration, newOut);
      if (!this.overlaps(found.track, clip.start, newOut - clip.in, clip.id)) {
        clip.out = newOut;
        this.store.notify();
      }
      return;
    }
  }

  private onUp(_e: MouseEvent): void {
    if (this.drag.mode === "none") return;
    const wasEdit = this.drag.mode === "move" || this.drag.mode === "trim-l" || this.drag.mode === "trim-r";
    if (wasEdit && this.drag.clipId) {
      // The live mutation already changed project; record an undo snapshot by
      // reconstructing pre-state and using commit semantics.
      const found = this.store.findClip(this.drag.clipId);
      if (found) {
        const cur = { start: found.clip.start, in: found.clip.in, out: found.clip.out };
        const curTrackId = found.track.id;
        const changed =
          cur.start !== this.drag.origStart ||
          cur.in !== this.drag.origIn ||
          cur.out !== this.drag.origOut ||
          curTrackId !== this.drag.origTrackId;
        if (changed) {
          // revert to original then commit the change for proper undo snapshot
          this.revertDragLive(found.clip, found.track, curTrackId);
          this.store.commit(() => {
            const f = this.store.findClip(this.drag.clipId!);
            if (!f) return;
            // move to target track if needed
            if (curTrackId !== f.track.id) {
              f.track.clips = f.track.clips.filter((c) => c.id !== f.clip.id);
              const tgt = this.store.project.tracks.find((t) => t.id === curTrackId);
              if (tgt) tgt.clips.push(f.clip);
            }
            f.clip.start = cur.start;
            f.clip.in = cur.in;
            f.clip.out = cur.out;
          });
        }
      }
    }
    this.drag.mode = "none";
    this.drag.clipId = null;
  }

  // Revert the live (un-committed) drag mutation back to original geometry/track.
  private revertDragLive(clip: Clip, curTrack: Track, _curTrackId: string): void {
    if (curTrack.id !== this.drag.origTrackId) {
      curTrack.clips = curTrack.clips.filter((c) => c.id !== clip.id);
      const orig = this.store.project.tracks.find((t) => t.id === this.drag.origTrackId);
      if (orig) orig.clips.push(clip);
    }
    clip.start = this.drag.origStart;
    clip.in = this.drag.origIn;
    clip.out = this.drag.origOut;
  }

  private onHover(e: MouseEvent): void {
    if (this.drag.mode !== "none") return;
    const { x, y } = this.localPos(e);
    let cursor = "default";
    if (x >= HEADER_W && y < RULER_H) cursor = "ew-resize";
    else {
      const hit = this.hitClip(x, y);
      if (hit) {
        const edge = this.edgeAt(hit.clip, x);
        cursor = edge ? "ew-resize" : "grab";
      }
    }
    if (cursor !== this.hoverCursor) {
      this.hoverCursor = cursor;
      this.canvas.style.cursor = cursor;
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey) {
      // zoom around cursor
      const { x } = this.localPos(e);
      const secAtCursor = this.xToSec(x);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      let pps = this.store.pxPerSec * factor;
      pps = Math.max(MIN_PXPS, Math.min(MAX_PXPS, pps));
      this.store.pxPerSec = pps;
      // keep cursor anchored
      this.store.scrollSec = secAtCursor - (x - HEADER_W) / pps;
      if (this.store.scrollSec < 0) this.store.scrollSec = 0;
    } else {
      const delta = e.shiftKey ? e.deltaX || e.deltaY : e.deltaY;
      this.store.scrollSec += (delta / this.store.pxPerSec) * (e.shiftKey ? 1 : 1);
      if (this.store.scrollSec < 0) this.store.scrollSec = 0;
    }
    this.store.notify();
  }

  // ---- commands (called from main/toolbar) ----
  splitAtPlayhead(): void {
    const sel = this.store.selectedClipId;
    if (!sel) return;
    const found = this.store.findClip(sel);
    if (!found) return;
    const c = found.clip;
    const p = this.store.playhead;
    const cs = c.start;
    const ce = c.start + clipLength(c);
    if (p <= cs + MIN_CLIP || p >= ce - MIN_CLIP) return;
    const splitIn = c.in + (p - cs);
    this.store.commit(() => {
      const f = this.store.findClip(sel);
      if (!f) return;
      const orig = f.clip;
      const right: Clip = {
        id: uid("c"),
        mediaId: orig.mediaId,
        start: p,
        in: splitIn,
        out: orig.out,
        volume: orig.volume,
        opacity: orig.opacity,
      };
      orig.out = splitIn;
      f.track.clips.push(right);
      this.store.selectedClipId = right.id;
    });
  }

  deleteSelected(): void {
    const sel = this.store.selectedClipId;
    if (!sel) return;
    const found = this.store.findClip(sel);
    if (!found) return;
    this.store.commit(() => {
      const f = this.store.findClip(sel);
      if (!f) return;
      f.track.clips = f.track.clips.filter((c) => c.id !== sel);
      this.store.selectedClipId = null;
    });
  }

  zoom(factor: number): void {
    let pps = this.store.pxPerSec * factor;
    pps = Math.max(MIN_PXPS, Math.min(MAX_PXPS, pps));
    this.store.pxPerSec = pps;
    this.store.notify();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fmtTime(sec: number): string {
  if (sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (sec < 10 && sec !== Math.floor(sec)) {
    return `${m}:${s.toFixed(1).padStart(4, "0")}`;
  }
  return `${m}:${Math.floor(s).toString().padStart(2, "0")}`;
}
