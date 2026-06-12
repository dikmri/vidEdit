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

// Mosaic keyframe: t = seconds relative to clip's timeline start (τ).
export interface MosaicKey {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

export interface MosaicRegion {
  id: string;
  strength: number;
  enabled: boolean;
  keys: MosaicKey[];
}

export interface Clip {
  id: string;
  mediaId: string;
  start: number;
  in: number;
  out: number;
  volume: number;
  opacity: number;
  mosaics: MosaicRegion[];
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

// Selected gap on a track (empty span left of a clip). end is always next clip start.
export interface GapSelection {
  trackId: string;
  start: number;
  end: number;
}

export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

// Interpolate a region's rect at relative time τ. Returns null before first key.
export function regionRectAt(region: MosaicRegion, t: number): RegionRect | null {
  const keys = region.keys;
  if (keys.length === 0) return null;
  if (t < keys[0].t) return null; // hidden before first key
  // find segment
  let i = keys.length - 1;
  for (let k = 0; k < keys.length; k++) {
    if (keys[k].t > t) {
      i = k - 1;
      break;
    }
  }
  if (i < 0) i = 0;
  const a = keys[i];
  // visible is step (held from this key until next)
  if (i >= keys.length - 1) {
    return { x: a.x, y: a.y, w: a.w, h: a.h, visible: a.visible };
  }
  const b = keys[i + 1];
  const span = b.t - a.t;
  const f = span > 1e-9 ? (t - a.t) / span : 0;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    w: a.w + (b.w - a.w) * f,
    h: a.h + (b.h - a.h) * f,
    visible: a.visible,
  };
}

// Migrate a parsed project to current version in-place (v1 -> v2: add mosaics).
export function migrateProject(proj: Project): Project {
  for (const track of proj.tracks) {
    for (const c of track.clips) {
      if (!Array.isArray(c.mosaics)) c.mosaics = [];
    }
  }
  proj.version = 2;
  return proj;
}

export function newProject(name = "untitled"): Project {
  return {
    version: 2,
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
  // Gap selection is exclusive with clip selection.
  selectedGap: GapSelection | null = null;
  // Selected mosaic region id within the selected clip.
  selectedRegionId: string | null = null;
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
    this.selectedGap = null;
    this.selectedRegionId = null;
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
      this.selectedRegionId = null;
    }
    if (this.selectedGap) {
      const t = this.project.tracks.find((tr) => tr.id === this.selectedGap!.trackId);
      if (!t) this.selectedGap = null;
    }
  }

  // Select a clip, clearing gap selection (exclusive).
  selectClip(id: string | null): void {
    this.selectedClipId = id;
    this.selectedGap = null;
    if (!id) this.selectedRegionId = null;
  }

  // Select a gap, clearing clip selection (exclusive). null clears both.
  selectGap(gap: GapSelection | null): void {
    this.selectedGap = gap;
    this.selectedClipId = null;
    this.selectedRegionId = null;
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
