/**
 * The open document and its edit history.
 *
 * Parsing and editing stay in the main process: the renderer never sees the
 * object graph, only the flattened scene and the results of the edits it asks
 * for. That keeps the byte-level model in one place and means a bug in the UI
 * cannot corrupt a file.
 *
 * Undo is snapshot-based. Re-serializing a plan takes a few milliseconds and
 * reproduces it exactly, so the simplest correct history is a stack of archive
 * bodies — no need to invert each operation.
 */

import { loadBuffer, type LoadedFile } from '../format/index.js';
import { buildScene, type Scene } from '../format/scene.js';
import { serializeArchive, roundTrip, packContainer, packFreshContainer } from '../format/write.js';
import { indexDocument, type DocumentIndex } from '../format/edit.js';
import { createHash } from 'node:crypto';

const MAX_HISTORY = 100;
/** Prevent a large plan from multiplying into gigabytes of undo snapshots. */
const MAX_HISTORY_BYTES = 256 * 1024 * 1024;

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class Session {
  loaded!: LoadedFile;
  index!: DocumentIndex;
  scene!: Scene;
  /** Monotonic in-process revision for stale derived views. */
  revision = 0;
  /** True when this document was restored from the crash journal. */
  recovered = false;
  /** True when the file reproduces itself byte for byte, so it is safe to save. */
  editable = false;

  private undoStack: Buffer[] = [];
  private redoStack: Buffer[] = [];
  /**
   * Redo is only cleared when an edit commits. Keeping a snapshot while an
   * edit is in flight means a rejected/no-op edit can restore redo exactly.
   */
  private redoBeforeCheckpoint: Buffer[] | null = null;
  /** The body as it was last written to disk, which is what "saved" means. */
  private savedBody!: Buffer;
  /** Hash of the complete file last read or written by this session. */
  private savedFileDigest: string | null;
  /** Serializing is a few milliseconds; only redo it when something changed. */
  private cachedBody: Buffer | null = null;

  constructor(
    public path: string,
    /** The file exactly as it was read, used to repack the container. */
    private readonly originalFile: Buffer,
  ) {
    this.adopt(loadBuffer(originalFile, path));
    this.editable = roundTrip(this.loaded.document).identical;
    this.savedBody = this.body();
    this.savedFileDigest = digest(originalFile);
  }

  /**
   * Whether the document differs from the file on disk.
   *
   * Compared against the bytes last written rather than inferred from the depth
   * of the undo stack. The stack emptying is not the same question: undoing
   * after a save walks away from what is on disk, and past the history limit
   * the oldest snapshot is dropped, so an empty stack no longer means the
   * document is back where it started. Both used to report "no unsaved
   * changes" over a file that did not match.
   */
  private dirtyFlag: boolean | null = null;

  /**
   * True when the live archive differs from what was last opened or saved.
   *
   * After a successful edit we mark dirty without re-serializing the whole
   * plan on every status-bar tick; undo/redo clear the flag so the next read
   * compares bodies once.
   */
  get dirty(): boolean {
    if (this.dirtyFlag != null) return this.dirtyFlag;
    this.dirtyFlag = !this.body().equals(this.savedBody);
    return this.dirtyFlag;
  }

  private adopt(loaded: LoadedFile): void {
    this.cachedBody = null;
    this.dirtyFlag = null;
    this.loaded = loaded;
    this.index = indexDocument(loaded.document);
    this.scene = buildScene(loaded.document);
  }

  /** Current archive body, reflecting any edits. */
  body(): Buffer {
    if (!this.cachedBody) this.cachedBody = serializeArchive(this.loaded.document);
    return this.cachedBody;
  }

  /** A complete file, ready to write. */
  file(): Buffer {
    // Repaired opens came from a carved/damaged compound — do not re-parse it.
    if (this.loaded.repaired) return packFreshContainer(this.body());
    return packContainer(this.originalFile, this.body());
  }

  /**
   * Archive body last known to match disk (or the open revision).
   * Companion fingerprints must use this when the session is dirty so a
   * sidecar never claims freshness against bytes that never reached disk.
   */
  savedArchiveBody(): Buffer {
    return this.savedBody;
  }

  /** Call before mutating, so the change can be undone. */
  checkpoint(): void {
    if (this.redoBeforeCheckpoint) {
      throw new Error('an edit transaction is already active');
    }
    this.redoBeforeCheckpoint = [...this.redoStack];
    this.undoStack.push(this.body());
    this.trimHistory();
  }

  /** Call after mutating, to commit the edit and refresh the derived scene. */
  refresh(): void {
    if (this.redoBeforeCheckpoint) {
      this.redoStack.length = 0;
      this.redoBeforeCheckpoint = null;
    }
    this.cachedBody = null;
    this.dirtyFlag = true;
    this.index = indexDocument(this.loaded.document);
    this.scene = buildScene(this.loaded.document);
    this.revision++;
    this.trimHistory();
  }

  private restore(body: Buffer): void {
    const packed = this.loaded.repaired
      ? packFreshContainer(body)
      : packContainer(this.originalFile, body);
    this.adopt(loadBuffer(packed, this.path));
    this.dirtyFlag = null;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    if (this.redoBeforeCheckpoint) return false;
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.body());
    this.restore(previous);
    this.trimHistory();
    return true;
  }

  redo(): boolean {
    if (this.redoBeforeCheckpoint) return false;
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.body());
    this.restore(next);
    this.trimHistory();
    return true;
  }

  /**
   * Undoes the most recent checkpoint without offering it as a redo.
   *
   * For edits that failed or changed nothing. Using `undo()` for that put the
   * half-applied state on the redo stack, so Redo could apply a change the app
   * had just refused.
   */
  rollback(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.restore(previous);
    if (this.redoBeforeCheckpoint) {
      this.redoStack = this.redoBeforeCheckpoint;
      this.redoBeforeCheckpoint = null;
    }
    return true;
  }

  /** True only when the current on-disk file is the revision we opened/saved. */
  matchesSavedFile(bytes: Buffer): boolean {
    return this.savedFileDigest !== null && digest(bytes) === this.savedFileDigest;
  }

  /** Digest of the disk revision this session may safely replace. */
  get savedFileHash(): string | undefined {
    return this.savedFileDigest ?? undefined;
  }

  /** Marks journal bytes as unsaved work against the disk revision at the crash. */
  markRecovered(expectedDiskDigest?: string): void {
    this.recovered = true;
    this.savedBody = Buffer.alloc(0);
    this.dirtyFlag = true;
    this.savedFileDigest =
      expectedDiskDigest && /^[a-f0-9]{64}$/i.test(expectedDiskDigest)
        ? expectedDiskDigest.toLowerCase()
        : null;
  }

  /**
   * Marks the exact snapshot that reached disk.
   *
   * An edit can arrive while an atomic write is in progress. Recording the
   * current body here would incorrectly call that newer, unwritten edit clean.
   */
  markSaved(completeFile = this.file(), archiveBody = this.body()): void {
    this.savedBody = archiveBody;
    this.savedFileDigest = digest(completeFile);
    this.recovered = false;
    this.dirtyFlag = false;
  }

  private trimHistory(): void {
    while (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    while (this.redoStack.length > MAX_HISTORY) this.redoStack.shift();

    const bytes = () =>
      this.undoStack.reduce((total, entry) => total + entry.byteLength, 0) +
      this.redoStack.reduce((total, entry) => total + entry.byteLength, 0);
    // Keep the newest undo/redo state even when one very large plan exceeds
    // the normal budget; discard older snapshots first.
    while (bytes() > MAX_HISTORY_BYTES && this.undoStack.length + this.redoStack.length > 1) {
      if (this.undoStack.length > 1) this.undoStack.shift();
      else if (this.redoStack.length > 1) this.redoStack.shift();
      else if (this.undoStack.length && this.redoStack.length) this.undoStack.shift();
    }
  }
}
