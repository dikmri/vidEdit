// Auto-update: check 3s after launch, show notification bar, install + relaunch.
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export function initUpdater(barHost: HTMLElement): void {
  window.setTimeout(() => {
    void runCheck(barHost);
  }, 3000);
}

async function runCheck(barHost: HTMLElement): Promise<void> {
  try {
    const update = await check();
    if (!update) return;

    const bar = document.createElement("div");
    bar.className = "update-bar";
    const msg = document.createElement("span");
    msg.textContent = `v${update.version} が利用可能`;
    const btn = document.createElement("button");
    btn.className = "btn btn-accent";
    btn.textContent = "更新して再起動";
    bar.appendChild(msg);
    bar.appendChild(btn);
    barHost.appendChild(bar);

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "ダウンロード中...";
      try {
        await update.downloadAndInstall();
        await relaunch();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "更新して再起動";
        msg.textContent = `更新に失敗しました: ${String(e)}`;
      }
    });
  } catch {
    // updater not configured / offline: ignore silently
  }
}
