// Export modal: choose output, run export, show progress / done, cancel.
import { save } from "@tauri-apps/plugin-dialog";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Store } from "./state";
import { exportVideo, cancelExport } from "./ipc";

interface ProgressPayload {
  ratio: number;
  timeSec: number;
}
interface DonePayload {
  ok: boolean;
  error: string | null;
}

export class ExportUI {
  private store: Store;
  private overlay: HTMLDivElement;
  private bar: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private cancelBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private titleEl: HTMLDivElement;
  private unlisten: UnlistenFn[] = [];
  private running = false;

  constructor(store: Store) {
    this.store = store;
    this.overlay = document.createElement("div");
    this.overlay.className = "modal-overlay hidden";
    this.overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">書き出し</div>
        <div class="export-status">準備中...</div>
        <div class="progress-track"><div class="progress-fill"></div></div>
        <div class="modal-actions">
          <button class="btn export-cancel">キャンセル</button>
          <button class="btn export-close hidden">閉じる</button>
        </div>
      </div>`;
    document.body.appendChild(this.overlay);
    this.bar = this.overlay.querySelector(".progress-fill") as HTMLDivElement;
    this.statusEl = this.overlay.querySelector(".export-status") as HTMLDivElement;
    this.cancelBtn = this.overlay.querySelector(".export-cancel") as HTMLButtonElement;
    this.closeBtn = this.overlay.querySelector(".export-close") as HTMLButtonElement;
    this.titleEl = this.overlay.querySelector(".modal-title") as HTMLDivElement;

    this.cancelBtn.addEventListener("click", () => void this.onCancel());
    this.closeBtn.addEventListener("click", () => this.hide());
  }

  async start(): Promise<void> {
    if (this.running) return;
    const outPath = await save({
      defaultPath: "output.mp4",
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!outPath) return;

    this.show();
    this.running = true;
    this.titleEl.textContent = "書き出し中";
    this.setStatus("初期化中...");
    this.setProgress(0);
    this.cancelBtn.classList.remove("hidden");
    this.closeBtn.classList.add("hidden");

    const projectJson = JSON.stringify(this.store.project);

    const unP = await listen<ProgressPayload>("export-progress", (e) => {
      const r = Math.max(0, Math.min(1, e.payload.ratio));
      this.setProgress(r);
      this.setStatus(`書き出し中... ${Math.round(r * 100)}%  (${e.payload.timeSec.toFixed(1)}s)`);
    });
    const unD = await listen<DonePayload>("export-done", (e) => {
      this.finish(e.payload.ok, e.payload.error);
    });
    this.unlisten = [unP, unD];

    try {
      await exportVideo(projectJson, outPath);
    } catch (err) {
      this.finish(false, String(err));
    }
  }

  private async onCancel(): Promise<void> {
    if (!this.running) {
      this.hide();
      return;
    }
    try {
      await cancelExport();
    } catch {
      /* ignore */
    }
    this.setStatus("キャンセルしました");
  }

  private finish(ok: boolean, error: string | null): void {
    this.running = false;
    this.cleanupListeners();
    this.titleEl.textContent = ok ? "完了" : "失敗";
    if (ok) {
      this.setProgress(1);
      this.setStatus("書き出しが完了しました。");
    } else {
      this.setStatus(`失敗: ${error ?? "不明なエラー"}`);
    }
    this.cancelBtn.classList.add("hidden");
    this.closeBtn.classList.remove("hidden");
  }

  private cleanupListeners(): void {
    for (const u of this.unlisten) u();
    this.unlisten = [];
  }

  private setProgress(r: number): void {
    this.bar.style.width = `${Math.round(r * 100)}%`;
  }
  private setStatus(s: string): void {
    this.statusEl.textContent = s;
  }
  private show(): void {
    this.overlay.classList.remove("hidden");
  }
  private hide(): void {
    this.cleanupListeners();
    this.overlay.classList.add("hidden");
  }
}
