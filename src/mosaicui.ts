// Mosaic editing UI: region panel, preview overlay (frames/handles), draw/select
// interaction, keyframe editing, and auto-mosaic flow. See DESIGN.md C / D.
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  Store,
  Clip,
  Track,
  MosaicRegion,
  MosaicKey,
  clipLength,
  regionRectAt,
  uid,
} from "./state";
import { FitRect, Preview } from "./preview";
import { autoMosaic, cancelAutoMosaic } from "./ipc";

const HANDLE_PX = 8;
const MIN_NORM = 0.01; // minimum region size (normalized)

type EditMode = "idle" | "draw" | "move" | "resize";
type HandleId = "nw" | "ne" | "sw" | "se";

interface ProgressPayload {
  phase: string;
  ratio: number;
}

export class MosaicUI {
  private store: Store;
  private preview: Preview;
  private canvas: HTMLCanvasElement;
  private panel: HTMLElement;

  // interaction state
  private mode: EditMode = "idle";
  private drawingArmed = false; // "+ 領域追加" pressed, waiting for drag
  private dragStart = { x: 0, y: 0 }; // normalized
  private dragRect: { x: number; y: number; w: number; h: number } | null = null;
  private activeHandle: HandleId | null = null;
  private moveGrab = { dx: 0, dy: 0 }; // normalized offset within region
  private keysSnapshot: string | null = null; // region.keys before a live move/resize

  // auto-mosaic
  private autoModelDownloaded = false;
  private autoUnlisten: UnlistenFn[] = [];
  private autoOverlay: HTMLDivElement | null = null;

  constructor(store: Store, preview: Preview, canvas: HTMLCanvasElement, panel: HTMLElement) {
    this.store = store;
    this.preview = preview;
    this.canvas = canvas;
    this.panel = panel;

    preview.setOverlayDraw((ctx, fit) => this.drawOverlay(ctx, fit));

    canvas.addEventListener("mousedown", (e) => this.onDown(e));
    window.addEventListener("mousemove", (e) => this.onMove(e));
    window.addEventListener("mouseup", (e) => this.onUp(e));

    store.subscribe(() => this.renderPanel());
    this.renderPanel();
  }

  // ---- context resolution ----

  // The currently editable clip context, or null when not applicable.
  private ctx(): { track: Track; clip: Clip; tau: number; inRange: boolean } | null {
    const id = this.store.selectedClipId;
    if (!id) return null;
    const found = this.store.findClip(id);
    if (!found) return null;
    if (found.track.kind !== "video") return null;
    const media = this.store.mediaById(found.clip.mediaId);
    if (media && media.kind === "audio") return null;
    const start = found.clip.start;
    const end = start + clipLength(found.clip);
    const tau = this.store.playhead - start;
    const inRange = this.store.playhead >= start && this.store.playhead < end;
    return { track: found.track, clip: found.clip, tau, inRange };
  }

  private selectedRegion(): MosaicRegion | null {
    const c = this.ctx();
    if (!c) return null;
    const rid = this.store.selectedRegionId;
    if (!rid) return null;
    return c.clip.mosaics.find((m) => m.id === rid) || null;
  }

  // ---- panel ----

  private renderPanel(): void {
    const c = this.ctx();
    this.panel.innerHTML = "";
    if (!c) {
      this.panel.classList.add("hidden");
      return;
    }
    this.panel.classList.remove("hidden");
    const media = this.store.mediaById(c.clip.mediaId);
    const isImage = media?.kind === "image";

    const head = document.createElement("div");
    head.className = "mosaic-head";
    head.innerHTML = `<span>モザイク</span>`;
    const addBtn = document.createElement("button");
    addBtn.className = "btn";
    addBtn.textContent = this.drawingArmed ? "描画モード中…" : "+ 領域追加";
    addBtn.addEventListener("click", () => this.armDrawing());
    const autoBtn = document.createElement("button");
    autoBtn.className = "btn";
    autoBtn.textContent = "自動モザイク";
    autoBtn.disabled = isImage;
    if (isImage) autoBtn.title = "画像クリップは対象外です";
    autoBtn.addEventListener("click", () => void this.runAuto());
    head.appendChild(addBtn);
    head.appendChild(autoBtn);
    this.panel.appendChild(head);

    if (!c.inRange) {
      const hint = document.createElement("div");
      hint.className = "mosaic-hint";
      hint.textContent = "プレイヘッドをこのクリップ内に置くと編集できます。";
      this.panel.appendChild(hint);
    }

    const list = document.createElement("div");
    list.className = "mosaic-list";
    for (const region of c.clip.mosaics) {
      list.appendChild(this.regionRow(c.clip, region));
    }
    this.panel.appendChild(list);
  }

  private regionRow(clip: Clip, region: MosaicRegion): HTMLElement {
    const row = document.createElement("div");
    row.className = "mosaic-row";
    if (region.id === this.store.selectedRegionId) row.classList.add("selected");

    const en = document.createElement("button");
    en.className = "mosaic-toggle";
    en.textContent = region.enabled ? "●" : "○";
    en.title = region.enabled ? "有効" : "無効";
    en.addEventListener("click", (e) => {
      e.stopPropagation();
      this.store.commit(() => {
        region.enabled = !region.enabled;
      });
    });

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "5";
    slider.max = "80";
    slider.value = String(region.strength);
    slider.className = "mosaic-slider";
    slider.title = "粒度";
    let beforeStrength = region.strength;
    slider.addEventListener("pointerdown", () => {
      beforeStrength = region.strength;
    });
    slider.addEventListener("input", () => {
      region.strength = Number(slider.value); // live, no snapshot
      this.preview.requestRender();
    });
    slider.addEventListener("change", () => {
      const next = Number(slider.value);
      region.strength = beforeStrength; // revert so commit snapshots pre-edit state
      this.store.commit(() => {
        region.strength = next;
      });
    });

    const del = document.createElement("button");
    del.className = "mosaic-del";
    del.textContent = "×";
    del.title = "削除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.store.commit(() => {
        clip.mosaics = clip.mosaics.filter((m) => m.id !== region.id);
        if (this.store.selectedRegionId === region.id) this.store.selectedRegionId = null;
      });
    });

    row.addEventListener("click", () => {
      this.store.selectedRegionId = region.id;
      this.store.notify();
    });

    const label = document.createElement("span");
    label.className = "mosaic-label";
    label.textContent = region.id;

    row.appendChild(en);
    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(del);
    return row;
  }

  private armDrawing(): void {
    if (!this.ctx()) return;
    this.drawingArmed = true;
    this.canvas.style.cursor = "crosshair";
    this.renderPanel();
  }

  // ---- preview overlay (paused only) ----

  private drawOverlay(ctx: CanvasRenderingContext2D, fit: FitRect): void {
    const c = this.ctx();
    if (!c || !c.inRange) return;
    const region = this.selectedRegion();

    // active rubber-band while drawing
    if (this.mode === "draw" && this.dragRect) {
      const r = this.dragRect;
      ctx.strokeStyle = "#7c5cff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(fit.x + r.x * fit.w, fit.y + r.y * fit.h, r.w * fit.w, r.h * fit.h);
      ctx.setLineDash([]);
      return;
    }

    if (!region) return;
    const rr = regionRectAt(region, c.tau);
    if (!rr) return;
    const rx = fit.x + rr.x * fit.w;
    const ry = fit.y + rr.y * fit.h;
    const rw = rr.w * fit.w;
    const rh = rr.h * fit.h;
    ctx.strokeStyle = rr.visible ? "#7c5cff" : "#888";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rh);
    // corner handles
    ctx.fillStyle = "#7c5cff";
    for (const [hx, hy] of this.cornerPts(rx, ry, rw, rh)) {
      ctx.fillRect(hx - HANDLE_PX / 2, hy - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
    }
  }

  private cornerPts(rx: number, ry: number, rw: number, rh: number): [number, number][] {
    return [
      [rx, ry],
      [rx + rw, ry],
      [rx, ry + rh],
      [rx + rw, ry + rh],
    ];
  }

  // ---- interaction ----

  private norm(e: MouseEvent, fit: FitRect): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left - fit.x;
    const py = e.clientY - r.top - fit.y;
    return { x: fit.w > 0 ? px / fit.w : 0, y: fit.h > 0 ? py / fit.h : 0 };
  }

  private onDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const c = this.ctx();
    if (!c || !c.inRange) return;
    if (this.preview.isPlaying()) return;
    const fit = this.preview.getFitRect();
    const p = this.norm(e, fit);
    // ignore clicks outside the frame
    if (p.x < -0.05 || p.y < -0.05 || p.x > 1.05 || p.y > 1.05) return;

    if (this.drawingArmed) {
      this.mode = "draw";
      this.dragStart = { x: clamp01(p.x), y: clamp01(p.y) };
      this.dragRect = { x: this.dragStart.x, y: this.dragStart.y, w: 0, h: 0 };
      e.preventDefault();
      return;
    }

    // select mode: hit handle of selected region first
    const region = this.selectedRegion();
    if (region) {
      const rr = regionRectAt(region, c.tau);
      if (rr) {
        const rx = fit.x + rr.x * fit.w;
        const ry = fit.y + rr.y * fit.h;
        const rw = rr.w * fit.w;
        const rh = rr.h * fit.h;
        const mx = e.clientX - this.canvas.getBoundingClientRect().left;
        const my = e.clientY - this.canvas.getBoundingClientRect().top;
        const h = this.hitHandle(mx, my, rx, ry, rw, rh);
        if (h) {
          this.mode = "resize";
          this.activeHandle = h;
          this.keysSnapshot = JSON.stringify(region.keys);
          e.preventDefault();
          return;
        }
        // hit body -> move
        if (p.x >= rr.x && p.x <= rr.x + rr.w && p.y >= rr.y && p.y <= rr.y + rr.h) {
          this.mode = "move";
          this.moveGrab = { dx: p.x - rr.x, dy: p.y - rr.y };
          this.keysSnapshot = JSON.stringify(region.keys);
          e.preventDefault();
          return;
        }
      }
    }

    // otherwise: select a region whose rect contains the point
    const hit = this.regionAt(c.clip, c.tau, p.x, p.y);
    if (hit) {
      this.store.selectedRegionId = hit.id;
      this.store.notify();
    }
  }

  private onMove(e: MouseEvent): void {
    if (this.mode === "idle") return;
    const c = this.ctx();
    if (!c) return;
    const fit = this.preview.getFitRect();
    const p = this.norm(e, fit);

    if (this.mode === "draw" && this.dragRect) {
      const x0 = this.dragStart.x;
      const y0 = this.dragStart.y;
      const x1 = clamp01(p.x);
      const y1 = clamp01(p.y);
      this.dragRect = {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0),
      };
      this.preview.requestRender();
      return;
    }

    const region = this.selectedRegion();
    if (!region) return;
    const rr = regionRectAt(region, c.tau);
    if (!rr) return;
    let nx = rr.x;
    let ny = rr.y;
    let nw = rr.w;
    let nh = rr.h;

    if (this.mode === "move") {
      nx = clamp01(p.x - this.moveGrab.dx);
      ny = clamp01(p.y - this.moveGrab.dy);
      nx = Math.min(nx, 1 - nw);
      ny = Math.min(ny, 1 - nh);
    } else if (this.mode === "resize" && this.activeHandle) {
      const left = rr.x;
      const top = rr.y;
      const right = rr.x + rr.w;
      const bottom = rr.y + rr.h;
      let l = left,
        t = top,
        r = right,
        b = bottom;
      const px = clamp01(p.x);
      const py = clamp01(p.y);
      if (this.activeHandle.includes("w")) l = px;
      if (this.activeHandle.includes("e")) r = px;
      if (this.activeHandle.includes("n")) t = py;
      if (this.activeHandle.includes("s")) b = py;
      nx = Math.min(l, r);
      ny = Math.min(t, b);
      nw = Math.max(MIN_NORM, Math.abs(r - l));
      nh = Math.max(MIN_NORM, Math.abs(b - t));
    }
    // live update of the current-τ key (no commit until mouseup)
    this.writeKey(region, c.tau, { x: nx, y: ny, w: nw, h: nh, visible: rr.visible }, false);
    this.preview.requestRender();
  }

  private onUp(_e: MouseEvent): void {
    if (this.mode === "idle") return;
    const c = this.ctx();

    if (this.mode === "draw") {
      const r = this.dragRect;
      this.dragRect = null;
      this.drawingArmed = false;
      this.canvas.style.cursor = "default";
      this.mode = "idle";
      if (c && r && r.w >= MIN_NORM && r.h >= MIN_NORM) {
        const region: MosaicRegion = {
          id: uid("mz"),
          strength: 20,
          enabled: true,
          keys: [{ t: Math.max(0, c.tau), x: r.x, y: r.y, w: r.w, h: r.h, visible: true }],
        };
        this.store.commit(() => {
          c.clip.mosaics.push(region);
          this.store.selectedRegionId = region.id;
        });
      } else {
        this.renderPanel();
      }
      return;
    }

    // move/resize: commit the current geometry as a key at τ
    const region = this.selectedRegion();
    if (region && c) {
      const rr = regionRectAt(region, c.tau);
      if (rr && this.keysSnapshot !== null) {
        const final = { x: rr.x, y: rr.y, w: rr.w, h: rr.h, visible: rr.visible };
        region.keys = JSON.parse(this.keysSnapshot); // revert so commit snapshots pre-edit
        this.store.commit(() => {
          this.writeKey(region, c.tau, final, true);
        });
      }
    }
    this.keysSnapshot = null;
    this.mode = "idle";
    this.activeHandle = null;
  }

  // ---- keyframe writing ----

  // Update or insert a key at τ. (committed flag is just for clarity; caller wraps commit.)
  private writeKey(region: MosaicRegion, t: number, v: Omit<MosaicKey, "t">, _committed: boolean): void {
    const tt = Math.max(0, t);
    const eps = 1e-4;
    const idx = region.keys.findIndex((k) => Math.abs(k.t - tt) < eps);
    if (idx >= 0) {
      region.keys[idx] = { t: region.keys[idx].t, ...v };
    } else {
      region.keys.push({ t: tt, ...v });
      region.keys.sort((a, b) => a.t - b.t);
    }
  }

  private regionAt(clip: Clip, tau: number, x: number, y: number): MosaicRegion | null {
    // topmost (last) region containing the point
    for (let i = clip.mosaics.length - 1; i >= 0; i--) {
      const region = clip.mosaics[i];
      const rr = regionRectAt(region, tau);
      if (!rr) continue;
      if (x >= rr.x && x <= rr.x + rr.w && y >= rr.y && y <= rr.y + rr.h) return region;
    }
    return null;
  }

  private hitHandle(mx: number, my: number, rx: number, ry: number, rw: number, rh: number): HandleId | null {
    const pts: [HandleId, number, number][] = [
      ["nw", rx, ry],
      ["ne", rx + rw, ry],
      ["sw", rx, ry + rh],
      ["se", rx + rw, ry + rh],
    ];
    for (const [id, hx, hy] of pts) {
      if (Math.abs(mx - hx) <= HANDLE_PX && Math.abs(my - hy) <= HANDLE_PX) return id;
    }
    return null;
  }

  // ---- keyboard (called from main; returns true if handled) ----

  // K: add key at current τ from interpolated rect. H: add visibility-toggle key.
  handleKey(key: string): boolean {
    if (key !== "k" && key !== "K" && key !== "h" && key !== "H") return false;
    const c = this.ctx();
    if (!c || !c.inRange) return false;
    const region = this.selectedRegion();
    if (!region) return false;
    const rr = regionRectAt(region, c.tau);
    if (key === "k" || key === "K") {
      const base = rr || (region.keys.length ? region.keys[0] : null);
      if (!base) return false;
      this.store.commit(() => {
        this.writeKey(region, c.tau, { x: base.x, y: base.y, w: base.w, h: base.h, visible: base.visible }, true);
      });
      return true;
    }
    // H: toggle visibility from current state
    const cur = rr ? rr.visible : true;
    const base = rr || (region.keys.length ? region.keys[0] : null);
    if (!base) return false;
    this.store.commit(() => {
      this.writeKey(region, c.tau, { x: base.x, y: base.y, w: base.w, h: base.h, visible: !cur }, true);
    });
    return true;
  }

  // ---- auto-mosaic ----

  private async runAuto(): Promise<void> {
    const c = this.ctx();
    if (!c) return;
    const media = this.store.mediaById(c.clip.mediaId);
    if (!media || media.kind === "image") return;

    let msg = "選択クリップの範囲を解析して自動でモザイク領域を追加します。続行しますか?";
    if (!this.autoModelDownloaded) {
      msg = "初回は検出モデル(約100MB)をダウンロードします。\n\n" + msg;
    }
    if (!window.confirm(msg)) return;

    const clip = c.clip;
    const inSec = clip.in;
    const outSec = clip.out;
    const path = media.path;

    this.showAutoModal();
    const unP = await listen<ProgressPayload>("automosaic-progress", (e) => {
      this.setAutoProgress(e.payload.phase, e.payload.ratio);
    });
    this.autoUnlisten = [unP];

    try {
      const regions = await autoMosaic(path, inSec, outSec);
      this.autoModelDownloaded = true;
      this.cleanupAuto();
      if (regions.length === 0) {
        this.closeAutoModal("検出なし");
        return;
      }
      this.store.commit(() => {
        for (const r of regions) clip.mosaics.push(r);
        if (regions.length) this.store.selectedRegionId = regions[regions.length - 1].id;
      });
      this.closeAutoModal(null);
    } catch (err) {
      this.cleanupAuto();
      this.closeAutoModal(`失敗: ${String(err)}`);
    }
  }

  private showAutoModal(): void {
    this.removeAutoOverlay();
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = `
      <div class="modal">
        <div class="modal-title">自動モザイク</div>
        <div class="automosaic-status">準備中...</div>
        <div class="progress-track"><div class="progress-fill"></div></div>
        <div class="modal-actions">
          <button class="btn automosaic-cancel">キャンセル</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    this.autoOverlay = ov;
    ov.querySelector(".automosaic-cancel")?.addEventListener("click", () => void this.cancelAuto());
  }

  private setAutoProgress(phase: string, ratio: number): void {
    if (!this.autoOverlay) return;
    const r = Math.max(0, Math.min(1, ratio));
    const fill = this.autoOverlay.querySelector(".progress-fill") as HTMLDivElement | null;
    const st = this.autoOverlay.querySelector(".automosaic-status") as HTMLDivElement | null;
    if (fill) fill.style.width = `${Math.round(r * 100)}%`;
    if (st) {
      const label = phase === "download" ? "モデルをダウンロード中" : "検出中";
      st.textContent = `${label}... ${Math.round(r * 100)}%`;
    }
  }

  private async cancelAuto(): Promise<void> {
    try {
      await cancelAutoMosaic();
    } catch {
      /* ignore */
    }
    this.cleanupAuto();
    this.closeAutoModal("キャンセルしました");
  }

  private cleanupAuto(): void {
    for (const u of this.autoUnlisten) u();
    this.autoUnlisten = [];
  }

  private closeAutoModal(message: string | null): void {
    if (message && this.autoOverlay) {
      const st = this.autoOverlay.querySelector(".automosaic-status") as HTMLDivElement | null;
      if (st) st.textContent = message;
      const actions = this.autoOverlay.querySelector(".modal-actions");
      if (actions) {
        actions.innerHTML = "";
        const close = document.createElement("button");
        close.className = "btn";
        close.textContent = "閉じる";
        close.addEventListener("click", () => this.removeAutoOverlay());
        actions.appendChild(close);
      }
      return;
    }
    this.removeAutoOverlay();
  }

  private removeAutoOverlay(): void {
    if (this.autoOverlay) {
      this.autoOverlay.remove();
      this.autoOverlay = null;
    }
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
