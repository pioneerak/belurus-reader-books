export type AudioPlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended";

export interface AudioChapter {
  id: string;
  title: string;
  start: number;
  end?: number;
}

export interface AudioPlayerSnapshot {
  status: AudioPlayerStatus;
  currentTime: number;
  duration: number;
  speed: number;
  volume: number;
  chapters: AudioChapter[];
}

/**
 * The controller owns HTML5 Audio and persists this state in the plugin's
 * data.json. Emit a new snapshot for time, duration, playback, speed, volume,
 * and chapter changes. savePlaybackState() should debounce frequent timeupdate
 * writes on the controller side.
 */
export interface IAudioController {
  getSnapshot(): AudioPlayerSnapshot;
  subscribe(listener: (state: AudioPlayerSnapshot) => void): () => void;
  restorePlaybackState(): Promise<void>;
  savePlaybackState(): Promise<void>;
  play(): Promise<void> | void;
  pause(): void;
  seek(seconds: number): void;
  setSpeed(speed: number): void;
  setVolume(volume: number): void;
  close(): void;
}

export class AudioPlayerUI {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly progress: HTMLButtonElement;
  private readonly progressFill: HTMLElement;
  private readonly progressSegments: HTMLElement;
  private readonly rewindButton: HTMLButtonElement;
  private readonly playButton: HTMLButtonElement;
  private readonly forwardButton: HTMLButtonElement;
  private readonly timeLabel: HTMLElement;
  private readonly chapterButton: HTMLButtonElement;
  private readonly chapterTitle: HTMLElement;
  private readonly chapterMenu: HTMLElement;
  private readonly speedButton: HTMLButtonElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly onDocumentPointerDown: (event: PointerEvent) => void;
  private unsubscribe: (() => void) | null = null;
  private state: AudioPlayerSnapshot;
  private menuOpen = false;
  private saving = false;
  private saveQueued = false;
  private saveTimer: number | null = null;
  private chapterRenderKey = "";
  private readonly onVisibilityChange: () => void;

  constructor(container: HTMLElement, private readonly controller: IAudioController) {
    this.doc = container.ownerDocument;
    this.state = controller.getSnapshot();
    this.root = this.doc.createElement("section");
    this.root.className = "br-audio-player";
    this.root.setAttribute("aria-label", "Audio player");

    this.progress = this.doc.createElement("button");
    this.progress.className = "br-audio-progress";
    this.progress.type = "button";
    this.progress.setAttribute("aria-label", "Seek audio");
    this.progressSegments = this.doc.createElement("span");
    this.progressSegments.className = "br-audio-progress-segments";
    this.progressFill = this.doc.createElement("span");
    this.progressFill.className = "br-audio-progress-fill";
    this.progress.append(this.progressSegments, this.progressFill);

    const controls = this.doc.createElement("div");
    controls.className = "br-audio-controls";
    const transport = this.doc.createElement("div");
    transport.className = "br-audio-transport";

    this.rewindButton = this.createButton("br-audio-icon", "Rewind 15 seconds", "↺", "15");
    this.playButton = this.createButton("br-audio-play", "Play", "▶");
    this.forwardButton = this.createButton("br-audio-icon", "Forward 15 seconds", "15", "↻");
    transport.append(this.rewindButton, this.playButton, this.forwardButton);

    this.timeLabel = this.doc.createElement("div");
    this.timeLabel.className = "br-audio-time";
    this.timeLabel.setAttribute("aria-live", "off");

    const chapterWrap = this.doc.createElement("div");
    chapterWrap.className = "br-audio-chapter-wrap";
    this.chapterButton = this.doc.createElement("button");
    this.chapterButton.className = "br-audio-chapter-button";
    this.chapterButton.type = "button";
    this.chapterButton.setAttribute("aria-expanded", "false");
    this.chapterButton.setAttribute("aria-haspopup", "menu");
    const menuIcon = this.doc.createElement("span");
    menuIcon.className = "br-audio-menu-icon";
    menuIcon.textContent = "☰";
    this.chapterTitle = this.doc.createElement("span");
    this.chapterTitle.className = "br-audio-chapter-title";
    this.chapterButton.append(menuIcon, this.chapterTitle);
    this.chapterMenu = this.doc.createElement("div");
    this.chapterMenu.className = "br-audio-chapter-menu";
    this.chapterMenu.setAttribute("role", "menu");
    chapterWrap.append(this.chapterButton, this.chapterMenu);

    const spacer = this.doc.createElement("div");
    spacer.className = "br-audio-spacer";
    this.speedButton = this.createButton("br-audio-speed", "Playback speed", "1.0x");

    const volume = this.doc.createElement("label");
    volume.className = "br-audio-volume";
    volume.setAttribute("aria-label", "Volume");
    const volumeIcon = this.doc.createElement("span");
    volumeIcon.className = "br-audio-volume-icon";
    volumeIcon.textContent = "◖";
    this.volumeInput = this.doc.createElement("input");
    this.volumeInput.type = "range";
    this.volumeInput.min = "0";
    this.volumeInput.max = "1";
    this.volumeInput.step = "0.01";
    this.volumeInput.setAttribute("aria-label", "Volume");
    volume.append(volumeIcon, this.volumeInput);

    this.closeButton = this.createButton("br-audio-close", "Close audio player", "×");
    controls.append(transport, this.timeLabel, chapterWrap, spacer, this.speedButton, volume, this.closeButton);
    this.root.append(this.progress, controls);
    container.appendChild(this.root);

    this.rewindButton.addEventListener("click", () => this.seekBy(-15));
    this.playButton.addEventListener("click", () => this.togglePlayback());
    this.forwardButton.addEventListener("click", () => this.seekBy(15));
    this.progress.addEventListener("click", (event) => this.seekFromProgress(event));
    this.chapterButton.addEventListener("click", () => this.setMenuOpen(!this.menuOpen));
    this.speedButton.addEventListener("click", () => this.cycleSpeed());
    this.volumeInput.addEventListener("input", () => this.setVolume());
    this.volumeInput.addEventListener("change", () => this.persist());
    this.closeButton.addEventListener("click", () => {
      this.controller.close();
      this.destroy();
    });
    this.onDocumentPointerDown = (event) => {
      if (this.menuOpen && !this.root.contains(event.target as Node)) this.setMenuOpen(false);
    };
    this.onVisibilityChange = () => {
      if (this.doc.visibilityState === "hidden") this.persistNow();
    };
    this.doc.addEventListener("pointerdown", this.onDocumentPointerDown);
    this.doc.addEventListener("visibilitychange", this.onVisibilityChange);

    this.unsubscribe = controller.subscribe((state) => {
      this.state = state;
      this.render();
      if (state.status === "playing") this.schedulePersist();
    });
    this.render();
    void this.restore();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.doc.removeEventListener("pointerdown", this.onDocumentPointerDown);
    this.doc.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.persistNow();
    this.root.remove();
  }

  private async restore(): Promise<void> {
    await this.controller.restorePlaybackState();
    this.state = this.controller.getSnapshot();
    this.render();
  }

  private createButton(className: string, label: string, ...parts: string[]): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.className = className;
    button.type = "button";
    button.setAttribute("aria-label", label);
    parts.forEach((part) => {
      const span = this.doc.createElement("span");
      span.textContent = part;
      button.appendChild(span);
    });
    return button;
  }

  private render(): void {
    const { currentTime, duration, speed, volume, status } = this.state;
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const safeTime = Math.max(0, Math.min(currentTime || 0, safeDuration || currentTime || 0));
    const progress = safeDuration ? safeTime / safeDuration : 0;
    this.progressFill.style.width = `${progress * 100}%`;
    this.playButton.textContent = status === "playing" ? "Ⅱ" : "▶";
    this.playButton.setAttribute("aria-label", status === "playing" ? "Pause" : "Play");
    this.playButton.classList.toggle("is-playing", status === "playing");
    this.playButton.classList.toggle("is-loading", status === "loading");
    this.timeLabel.textContent = `${formatTime(safeTime)} / ${formatTime(safeDuration)} / ${formatTime(Math.max(0, safeDuration - safeTime))}`;
    this.speedButton.textContent = `${speed.toFixed(speed % 1 ? 2 : 1)}x`;
    this.volumeInput.value = String(volume);
    this.volumeInput.style.setProperty("--br-volume", `${volume * 100}%`);
    this.renderChapters();
  }

  private renderChapters(): void {
    const chapters = this.state.chapters || [];
    const current = getCurrentChapter(chapters, this.state.currentTime);
    this.chapterTitle.textContent = current?.title || "No chapters";
    const renderKey = `${this.state.duration}|${current?.id || ""}|${chapters.map((chapter) => `${chapter.id}:${chapter.start}:${chapter.title}`).join("|")}`;
    if (renderKey === this.chapterRenderKey) return;
    this.chapterRenderKey = renderKey;
    this.progressSegments.replaceChildren();
    this.chapterMenu.replaceChildren();
    if (!chapters.length || !this.state.duration) return;

    chapters.forEach((chapter, index) => {
      const marker = this.doc.createElement("span");
      marker.className = "br-audio-progress-marker";
      marker.style.left = `${Math.max(0, Math.min(100, chapter.start / this.state.duration * 100))}%`;
      marker.setAttribute("aria-hidden", "true");
      this.progressSegments.appendChild(marker);

      const item = this.doc.createElement("button");
      item.className = "br-audio-chapter-item";
      item.type = "button";
      item.setAttribute("role", "menuitem");
      const isCurrent = current?.id === chapter.id;
      item.classList.toggle("is-current", isCurrent);
      const dot = this.doc.createElement("span");
      dot.className = "br-audio-chapter-dot";
      const title = this.doc.createElement("span");
      title.className = "br-audio-chapter-item-title";
      title.textContent = chapter.title || `Chapter ${index + 1}`;
      const time = this.doc.createElement("span");
      time.className = "br-audio-chapter-item-time";
      time.textContent = formatTime(chapter.start);
      item.append(dot, title, time);
      item.addEventListener("click", () => {
        this.controller.seek(chapter.start);
        this.setMenuOpen(false);
        this.persist();
      });
      this.chapterMenu.appendChild(item);
    });
  }

  private async togglePlayback(): Promise<void> {
    if (this.state.status === "playing") this.controller.pause();
    else await this.controller.play();
    this.persist();
  }

  private seekBy(seconds: number): void {
    this.controller.seek(Math.max(0, Math.min(this.state.duration, this.state.currentTime + seconds)));
    this.persist();
  }

  private seekFromProgress(event: MouseEvent): void {
    if (!this.state.duration) return;
    const rect = this.progress.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    this.controller.seek(ratio * this.state.duration);
    this.persist();
  }

  private cycleSpeed(): void {
    const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];
    const currentIndex = speeds.findIndex((value) => Math.abs(value - this.state.speed) < 0.01);
    this.controller.setSpeed(speeds[(currentIndex + 1 + speeds.length) % speeds.length]);
    this.persist();
  }

  private setVolume(): void {
    this.controller.setVolume(Number(this.volumeInput.value));
  }

  private setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.chapterMenu.classList.toggle("is-open", open);
    this.chapterButton.setAttribute("aria-expanded", String(open));
  }

  private persist(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.persistNow();
  }

  private schedulePersist(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.persistNow();
    }, 3000);
  }

  private persistNow(): void {
    if (this.saving) {
      this.saveQueued = true;
      return;
    }
    this.saving = true;
    void this.controller.savePlaybackState().finally(() => {
      this.saving = false;
      if (this.saveQueued) {
        this.saveQueued = false;
        this.persist();
      }
    });
  }
}

function getCurrentChapter(chapters: AudioChapter[], currentTime: number): AudioChapter | undefined {
  return chapters.reduce<AudioChapter | undefined>((active, chapter) => chapter.start <= currentTime ? chapter : active, undefined);
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole % 3600 / 60);
  const remainingSeconds = whole % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}` : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}
