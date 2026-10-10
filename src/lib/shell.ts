// Window controls for the frameless shell. `getCurrentWindow()` throws synchronously
// outside Tauri (plain browser / tests), so every call is guarded here.

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Theme } from "@/types";

function currentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export async function minimizeWindow(): Promise<void> {
  const win = currentWindow();
  if (!win) return;
  try {
    await win.minimize();
  } catch {
    // Window closed underneath us.
  }
}

export async function toggleMaximizeWindow(): Promise<boolean> {
  const win = currentWindow();
  if (!win) return false;
  try {
    await win.toggleMaximize();
    return await win.isMaximized();
  } catch {
    return false;
  }
}

export async function isWindowMaximized(): Promise<boolean> {
  const win = currentWindow();
  if (!win) return false;
  try {
    return await win.isMaximized();
  } catch {
    return false;
  }
}

export async function closeWindow(): Promise<void> {
  const win = currentWindow();
  if (!win) return;
  try {
    await win.close();
  } catch {
    // Already closing.
  }
}

export async function setWindowTheme(theme: Theme): Promise<void> {
  const win = currentWindow();
  if (!win) return;
  try {
    await win.setTheme(theme);
  } catch {
    // Theme is cosmetic; the CSS class already switched.
  }
}
