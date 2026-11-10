import { watchFile, unwatchFile } from 'node:fs';

// Owns debounce/deduplication only; reload and failure policy belong to the supervisor.
export class PointerWatcher {
  constructor({ pointerPath, watchEnabled, watchIntervalMs, readPointerDocument, reload, isClosing, hasSwitchError, log }) {
    this.pointerPath = pointerPath;
    this.watchEnabled = watchEnabled;
    this.watchIntervalMs = watchIntervalMs;
    this.readPointerDocument = readPointerDocument;
    this.reload = reload;
    this.isClosing = isClosing;
    this.hasSwitchError = hasSwitchError;
    this.log = log;
    this.lastPointerText = undefined;
    this.pointerDebounce = null;
    this.watching = false;
    // watchFile/unwatchFile must receive the exact same callback identity.
    this.onPointerChanged = this.onPointerChanged.bind(this);
  }

  async checkPointer() {
    let document;
    try {
      document = await this.readPointerDocument();
    } catch (error) {
      this.log(`runtime pointer check failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const text = document.text;
    // Rewriting the same pointer is how an updater retries after a transient
    // failure (entry still copying, locked file); do not dedupe that away.
    if (text === this.lastPointerText && !this.hasSwitchError()) return;
    this.lastPointerText = text;
    try {
      await this.reload();
    } catch (error) {
      this.log(`runtime pointer reload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onPointerChanged() {
    if (this.isClosing() || !this.watching || this.pointerDebounce) return;
    this.pointerDebounce = setTimeout(() => {
      this.pointerDebounce = null;
      void this.checkPointer();
    }, Math.min(50, this.watchIntervalMs));
    this.pointerDebounce.unref?.();
  }

  startWatching() {
    if (!this.watchEnabled || this.watching) return;
    this.watching = true;
    try {
      watchFile(this.pointerPath, { interval: this.watchIntervalMs }, this.onPointerChanged);
    } catch (error) {
      this.watching = false;
      this.log(`failed to watch runtime pointer ${this.pointerPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stopWatching() {
    if (!this.watching) return;
    this.watching = false;
    if (this.pointerDebounce) {
      clearTimeout(this.pointerDebounce);
      this.pointerDebounce = null;
    }
    try {
      unwatchFile(this.pointerPath, this.onPointerChanged);
    } catch {
      // The watcher may already be gone.
    }
  }
}
