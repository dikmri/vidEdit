// Project data model + undo/redo + subscription, per DESIGN.md section 2.

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
}

export type MediaKind = "video" | "audio" | "image";
export type TrackKind = "video" | "audio";

export interface Media {
  id: string;
  path: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  // Front-only fields (kept in memory, harmless if serialized).
  name?: string;
  thumb?: string;
}

export interface Clip {
  id: string;
  mediaId: string;
  start: number;
  in: number;
  out: number;
  volume: number;
  opacity: number;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
}

export interface Project {
  version: number;
  name: string;
  settings: ProjectSettings;
  media: Media[];
  tracks: Track[];
}

let idCounter = 0;
export function uid(prefix: string): string {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function clipLength(c: Clip): number {
  return c.out - c.in;
}

export function newProject(name = "untitled"): Project {
  return {
    version: 1,
    name,
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
    media: [],
    tracks: [
      { id: uid("t"), kind: "video", name: "V1", clips: [] },
      { id: uid("t"), kind: "video", name: "V2", clips: [] },
      { id: uid("t"), kind: "audio", name: "A1", clips: [] },
    ],
  };
}

type Listener = () => void;

const UNDO_LIMIT = 100;

export class Store {
  project: Project;
  selectedClipId: string | null = null;
  playhead = 0;
  pxPerSec = 100;
  scrollSec = 0;
  filePath: string | null = null;
  dirty = false;

  private listeners = new Set<Listener>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  constructor(project: Project) {
    this.project = project;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  // Snapshot current project before a mutation, then apply mutator, then notify.
  commit(mutator: () => void): void {
    const snapshot = JSON.stringify(this.project);
    this.undoStack.push(snapshot);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    mutator();
    this.dirty = true;
    this.notify();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(prev);
    this.dirty = true;
    this.sanitizeSelection();
    this.notify();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(next);
    this.dirty = true;
    this.sanitizeSelection();
    this.notify();
  }

  // Replace whole project (load / new). Clears history.
  setProject(project: Project, filePath: string | null): void {
    this.project = project;
    this.filePath = filePath;
    this.selectedClipId = null;
    this.playhead = 0;
    this.scrollSec = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.notify();
  }

  markSaved(filePath: string): void {
    this.filePath = filePath;
    this.dirty = false;
    this.notify();
  }

  private sanitizeSelection(): void {
    if (this.selectedClipId && !this.findClip(this.selectedClipId)) {
      this.selectedClipId = null;
    }
  }

  findClip(id: string): { track: Track; clip: Clip } | null {
    for (const track of this.project.tracks) {
      const clip = track.clips.find((c) => c.id === id);
      if (clip) return { track, clip };
    }
    return null;
  }

  mediaById(id: string): Media | undefined {
    return this.project.media.find((m) => m.id === id);
  }

  // Total timeline duration in seconds.
  totalDuration(): number {
    let t = 0;
    for (const track of this.project.tracks) {
      for (const c of track.clips) {
        t = Math.max(t, c.start + clipLength(c));
      }
    }
    return t;
  }
}
