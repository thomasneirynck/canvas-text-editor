import {
  clampPosition,
  comparePositions,
  deleteRange,
  globalToPosition,
  getTextInRange,
  insertText,
  isRangeFullyBold,
  normalizeDoc,
  orderRange,
  positionToGlobal,
  setBold,
  splitParagraphAt,
  totalLengthWithBreaks,
  type Doc,
  type Position,
} from "./model.js";
import {
  hitTest,
  layoutDoc,
  paintCaretOverlay,
  paintSelectionOverlay,
  paintStaticLayout,
  renderDocumentToCanvas,
  type StaticRenderOptions,
  type BoundingBox,
  type LayoutLine,
  type LayoutResult,
  type LayoutRun,
} from "./layout.js";

function defaultDoc(): Doc {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [] }],
  };
}

function cloneDoc(doc: Doc): Doc {
  return JSON.parse(JSON.stringify(doc)) as Doc;
}

function assertIsDoc(value: unknown): asserts value is Doc {
  if (typeof value !== "object" || value === null) {
    throw new Error("Document must be an object.");
  }
  const doc = value as { type?: unknown; content?: unknown };
  if (doc.type !== "doc" || !Array.isArray(doc.content)) {
    throw new Error("Document must have type 'doc' and an array content.");
  }
}

function resolveContext(
  target: HTMLCanvasElement | CanvasRenderingContext2D,
): CanvasRenderingContext2D {
  if (target instanceof HTMLCanvasElement) {
    const ctx = target.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D context is not available.");
    }
    return ctx;
  }
  return target;
}

export interface EditorSelectionState {
  hasSelection: boolean;
  boldActive: boolean;
}

export function renderDocument(
  target: HTMLCanvasElement | CanvasRenderingContext2D,
  doc: Doc,
  bbox: BoundingBox,
  options: StaticRenderOptions = {},
): LayoutResult {
  assertIsDoc(doc);
  const normalizedDoc = cloneDoc(doc);
  normalizeDoc(normalizedDoc);
  const ctx = resolveContext(target);
  return renderDocumentToCanvas(ctx, normalizedDoc, bbox, options);
}

export class CanvasTextEditor {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bbox: BoundingBox;
  private readonly blinkIntervalId: ReturnType<typeof setInterval>;
  private doc: Doc;
  private runs: LayoutRun[] = [];
  private lines: LayoutLine[] = [];
  private lineHeight = 22;
  private anchor: Position = { paragraphIndex: 0, offset: 0 };
  private head: Position = { paragraphIndex: 0, offset: 0 };
  private cursorVisible = true;
  private isBold = false;
  private isSelecting = false;
  private preferredCaretX: number | null = null;
  private readonly changeListeners = new Set<(doc: Doc) => void>();
  private readonly selectionListeners = new Set<(state: EditorSelectionState) => void>();

  constructor(
    canvas: HTMLCanvasElement,
    x: number,
    y: number,
    width: number,
    height: number,
    doc: Doc = defaultDoc(),
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D context is not available.");
    }

    this.canvas = canvas;
    this.ctx = ctx;
    this.bbox = { x, y, width, height };
    this.doc = cloneDoc(doc);
    normalizeDoc(this.doc);

    this.canvas.tabIndex = 0;
    this.canvas.addEventListener("keydown", this.onKeyDown);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.canvas.addEventListener("copy", this.onCopy);
    this.canvas.addEventListener("cut", this.onCut);
    this.canvas.addEventListener("paste", this.onPaste);
    window.addEventListener("mouseup", this.onMouseUp);
    this.canvas.focus();

    this.blinkIntervalId = setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.render();
    }, 500);

    this.render();
    this.emitSelectionChange();
  }

  private getSelectionRange(): [Position, Position] {
    return orderRange(this.anchor, this.head);
  }

  private hasSelection(): boolean {
    return comparePositions(this.anchor, this.head) !== 0;
  }

  private collapseSelection(position: Position): void {
    const clamped = clampPosition(this.doc, position);
    this.anchor = clamped;
    this.head = clamped;
  }

  private moveCaretBy(delta: number, extend: boolean): void {
    const base = extend ? this.head : this.getSelectionRange()[1];
    const global = positionToGlobal(this.doc, base);
    const nextGlobal = Math.max(0, Math.min(totalLengthWithBreaks(this.doc), global + delta));
    const next = globalToPosition(this.doc, nextGlobal);
    if (extend) {
      this.head = next;
    } else {
      this.collapseSelection(next);
    }
  }

  private lineContainsOffset(line: LayoutLine, offset: number): boolean {
    if (line.charStart === line.charEnd) {
      return offset === line.charStart;
    }
    return offset >= line.charStart && offset <= line.charEnd;
  }

  private lineAtY(y: number): LayoutLine | null {
    if (this.lines.length === 0) {
      return null;
    }

    let target = this.lines[this.lines.length - 1];
    for (const line of this.lines) {
      if (y < line.y + this.lineHeight) {
        target = line;
        break;
      }
    }
    return target;
  }

  private lineIndexForPosition(position: Position): number {
    return this.lines.findIndex(
      (line) =>
        line.paragraphIndex === position.paragraphIndex &&
        this.lineContainsOffset(line, position.offset),
    );
  }

  private caretXForPosition(position: Position): number {
    const lineIndex = this.lineIndexForPosition(position);
    if (lineIndex < 0) {
      return this.bbox.x;
    }
    const line = this.lines[lineIndex];
    if (line.runs.length === 0) {
      return this.bbox.x;
    }

    for (const run of line.runs) {
      if (position.offset < run.charStart || position.offset > run.charEnd) {
        continue;
      }
      this.ctx.font = run.font;
      const width = this.ctx.measureText(
        run.text.slice(0, position.offset - run.charStart),
      ).width;
      return run.x + width;
    }

    const lastRun = line.runs[line.runs.length - 1];
    return lastRun.x + lastRun.width;
  }

  private closestOffsetInRun(run: LayoutRun, x: number): number {
    if (run.text.length === 0) {
      return run.charStart;
    }

    if (x <= run.x) {
      return run.charStart;
    }

    const runRight = run.x + run.width;
    if (x >= runRight) {
      return run.charEnd;
    }

    this.ctx.font = run.font;
    let bestOffset = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= run.text.length; i += 1) {
      const width = this.ctx.measureText(run.text.slice(0, i)).width;
      const caretX = run.x + width;
      const distance = Math.abs(x - caretX);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestOffset = i;
      }
    }
    return run.charStart + bestOffset;
  }

  private positionAtXOnLine(line: LayoutLine, x: number): Position {
    if (line.runs.length === 0) {
      return { paragraphIndex: line.paragraphIndex, offset: 0 };
    }

    for (const run of line.runs) {
      const runRight = run.x + run.width;
      if (x >= run.x && x <= runRight) {
        return {
          paragraphIndex: run.paragraphIndex,
          offset: this.closestOffsetInRun(run, x),
        };
      }
      if (x < run.x) {
        return { paragraphIndex: run.paragraphIndex, offset: run.charStart };
      }
    }

    const lastRun = line.runs[line.runs.length - 1];
    return { paragraphIndex: lastRun.paragraphIndex, offset: lastRun.charEnd };
  }

  private moveCaretVertical(direction: -1 | 1, extend: boolean): void {
    if (this.lines.length === 0) {
      return;
    }

    const [start, end] = this.getSelectionRange();
    const base = extend ? this.head : this.hasSelection() ? (direction < 0 ? start : end) : this.head;
    const currentLineIndex = this.lineIndexForPosition(base);
    if (currentLineIndex < 0) {
      return;
    }

    if (this.preferredCaretX === null) {
      this.preferredCaretX = this.caretXForPosition(base);
    }

    const targetLineIndex = Math.max(
      0,
      Math.min(this.lines.length - 1, currentLineIndex + direction),
    );
    const target = this.positionAtXOnLine(
      this.lines[targetLineIndex],
      this.preferredCaretX,
    );
    if (extend) {
      this.head = clampPosition(this.doc, target);
    } else {
      this.collapseSelection(target);
    }
  }

  private deleteSelectionIfAny(): boolean {
    if (!this.hasSelection()) {
      return false;
    }
    const [start, end] = this.getSelectionRange();
    const next = deleteRange(this.doc, start, end);
    this.collapseSelection(next);
    return true;
  }

  private emitDocumentChange(): void {
    const snapshot = cloneDoc(this.doc);
    for (const listener of this.changeListeners) {
      listener(snapshot);
    }
  }

  private currentBoldActive(): boolean {
    if (!this.hasSelection()) {
      return this.isBold;
    }
    const [start, end] = this.getSelectionRange();
    return isRangeFullyBold(this.doc, start, end);
  }

  private emitSelectionChange(): void {
    const state: EditorSelectionState = {
      hasSelection: this.hasSelection(),
      boldActive: this.currentBoldActive(),
    };
    for (const listener of this.selectionListeners) {
      listener(state);
    }
  }

  private applyBoldToggle(): boolean {
    if (this.hasSelection()) {
      const [start, end] = this.getSelectionRange();
      const shouldBold = !isRangeFullyBold(this.doc, start, end);
      setBold(this.doc, start, end, shouldBold);
      this.anchor = clampPosition(this.doc, start);
      this.head = clampPosition(this.doc, end);
      return true;
    }
    this.isBold = !this.isBold;
    return false;
  }

  private insertPlainTextAtSelection(text: string): void {
    if (this.deleteSelectionIfAny()) {
      // Selection removal handled before insert.
    }

    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    let cursor = this.head;

    for (let i = 0; i < lines.length; i += 1) {
      const lineText = lines[i];
      if (lineText.length > 0) {
        cursor = insertText(this.doc, cursor, lineText, this.isBold);
      }
      if (i < lines.length - 1) {
        cursor = splitParagraphAt(this.doc, cursor);
      }
    }

    this.collapseSelection(cursor);
    this.preferredCaretX = null;
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.detail > 1) {
      // Let dblclick handler own range selection behavior.
      return;
    }

    this.canvas.focus();
    const hit = hitTest(
      this.lines,
      event.offsetX,
      event.offsetY,
      this.ctx,
      this.lineHeight,
    );
    this.isSelecting = true;
    this.anchor = hit;
    this.head = hit;
    this.preferredCaretX = null;
    this.cursorVisible = true;
    this.render();
    this.emitSelectionChange();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.isSelecting) {
      return;
    }
    this.head = hitTest(this.lines, event.offsetX, event.offsetY, this.ctx, this.lineHeight);
    this.cursorVisible = true;
    this.render();
    this.emitSelectionChange();
  };

  private readonly onMouseUp = (): void => {
    this.isSelecting = false;
    this.emitSelectionChange();
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.canvas.focus();
    const line = this.lineAtY(event.offsetY);
    if (!line) {
      return;
    }

    this.anchor = { paragraphIndex: line.paragraphIndex, offset: line.charStart };
    this.head = { paragraphIndex: line.paragraphIndex, offset: line.charEnd };
    this.isSelecting = false;
    this.preferredCaretX = null;
    this.cursorVisible = true;
    this.render();
    this.emitSelectionChange();
  };

  private readonly onCopy = (event: ClipboardEvent): void => {
    if (!this.hasSelection()) {
      return;
    }
    const [start, end] = this.getSelectionRange();
    const text = getTextInRange(this.doc, start, end);
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
  };

  private readonly onCut = (event: ClipboardEvent): void => {
    if (!this.hasSelection()) {
      return;
    }
    const [start, end] = this.getSelectionRange();
    const text = getTextInRange(this.doc, start, end);
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
    const next = deleteRange(this.doc, start, end);
    this.collapseSelection(next);
    this.preferredCaretX = null;
    this.cursorVisible = true;
    this.render();
    this.emitDocumentChange();
    this.emitSelectionChange();
  };

  private readonly onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text/plain");
    if (typeof text !== "string") {
      return;
    }
    event.preventDefault();
    this.insertPlainTextAtSelection(text);
    this.cursorVisible = true;
    this.render();
    this.emitDocumentChange();
    this.emitSelectionChange();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    let handled = false;
    let changed = false;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      changed = this.applyBoldToggle();
      handled = true;
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      this.anchor = { paragraphIndex: 0, offset: 0 };
      this.head = globalToPosition(this.doc, totalLengthWithBreaks(this.doc));
      this.preferredCaretX = null;
      handled = true;
    } else if (event.key === "Backspace") {
      if (!this.deleteSelectionIfAny()) {
        const caret = this.head;
        const caretGlobal = positionToGlobal(this.doc, caret);
        if (caretGlobal > 0) {
          const from = globalToPosition(this.doc, caretGlobal - 1);
          const next = deleteRange(this.doc, from, caret);
          this.collapseSelection(next);
          changed = true;
        }
      } else {
        changed = true;
      }
      handled = true;
    } else if (event.key === "ArrowLeft") {
      this.moveCaretBy(-1, event.shiftKey);
      this.preferredCaretX = null;
      handled = true;
    } else if (event.key === "ArrowRight") {
      this.moveCaretBy(1, event.shiftKey);
      this.preferredCaretX = null;
      handled = true;
    } else if (event.key === "ArrowUp") {
      this.moveCaretVertical(-1, event.shiftKey);
      handled = true;
    } else if (event.key === "ArrowDown") {
      this.moveCaretVertical(1, event.shiftKey);
      handled = true;
    } else if (event.key === "Enter") {
      if (this.deleteSelectionIfAny()) {
        changed = true;
      }
      const next = splitParagraphAt(this.doc, this.head);
      this.collapseSelection(next);
      this.preferredCaretX = null;
      changed = true;
      handled = true;
    } else if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      if (this.deleteSelectionIfAny()) {
        changed = true;
      }
      const next = insertText(this.doc, this.head, event.key, this.isBold);
      this.collapseSelection(next);
      this.preferredCaretX = null;
      changed = true;
      handled = true;
    }

    if (handled) {
      event.preventDefault();
      this.cursorVisible = true;
      this.render();
      if (changed) {
        this.emitDocumentChange();
      }
      this.emitSelectionChange();
    }
  };

  getDocument(): Doc {
    return cloneDoc(this.doc);
  }

  setDocument(doc: Doc): void {
    assertIsDoc(doc);
    this.doc = cloneDoc(doc);
    normalizeDoc(this.doc);
    this.collapseSelection({ paragraphIndex: 0, offset: 0 });
    this.cursorVisible = true;
    this.render();
    this.emitDocumentChange();
    this.emitSelectionChange();
  }

  onChange(listener: (doc: Doc) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onSelectionChange(listener: (state: EditorSelectionState) => void): () => void {
    this.selectionListeners.add(listener);
    listener({
      hasSelection: this.hasSelection(),
      boldActive: this.currentBoldActive(),
    });
    return () => {
      this.selectionListeners.delete(listener);
    };
  }

  isBoldActive(): boolean {
    return this.currentBoldActive();
  }

  setBoldActive(active: boolean): void {
    let changed = false;
    if (this.hasSelection()) {
      const [start, end] = this.getSelectionRange();
      setBold(this.doc, start, end, active);
      this.anchor = clampPosition(this.doc, start);
      this.head = clampPosition(this.doc, end);
      changed = true;
    } else {
      this.isBold = active;
    }

    this.cursorVisible = true;
    this.render();
    if (changed) {
      this.emitDocumentChange();
    }
    this.emitSelectionChange();
  }

  toggleBold(): void {
    const changed = this.applyBoldToggle();
    this.cursorVisible = true;
    this.render();
    if (changed) {
      this.emitDocumentChange();
    }
    this.emitSelectionChange();
  }

  render(): void {
    const result = layoutDoc(this.ctx, this.doc, this.bbox);
    paintStaticLayout(this.ctx, result, this.bbox, { clearCanvas: true, drawBounds: false, drawText: false });
    paintSelectionOverlay(this.ctx, result, { anchor: this.anchor, head: this.head });
    paintStaticLayout(this.ctx, result, this.bbox, { clearCanvas: false, drawBounds: true, drawText: true });
    paintCaretOverlay(
      this.ctx,
      result,
      this.bbox,
      this.head,
      { anchor: this.anchor, head: this.head },
      this.cursorVisible,
    );
    this.runs = result.runs;
    this.lines = result.lines;
    this.lineHeight = result.lineHeight;
  }

  destroy(): void {
    clearInterval(this.blinkIntervalId);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    this.canvas.removeEventListener("copy", this.onCopy);
    this.canvas.removeEventListener("cut", this.onCut);
    this.canvas.removeEventListener("paste", this.onPaste);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.changeListeners.clear();
    this.selectionListeners.clear();
  }
}

export default CanvasTextEditor;

export type { Doc, Mark, Paragraph, Position, TextNode } from "./model.js";
export type {
  BoundingBox,
  LayoutLine,
  LayoutResult,
  LayoutRun,
  StaticRenderOptions,
} from "./layout.js";
