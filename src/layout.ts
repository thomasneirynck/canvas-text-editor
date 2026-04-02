import { comparePositions, orderRange, type Doc, type Position, type TextNode } from "./model.js";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutRun {
  text: string;
  x: number;
  y: number;
  width: number;
  font: string;
  paragraphIndex: number;
  charStart: number;
  charEnd: number;
}

export interface LayoutLine {
  paragraphIndex: number;
  y: number;
  charStart: number;
  charEnd: number;
  runs: LayoutRun[];
}

export interface LayoutResult {
  runs: LayoutRun[];
  lines: LayoutLine[];
  lineHeight: number;
}

const LINE_HEIGHT = 22;

function nodeFont(node: TextNode): string {
  const isBold = Boolean(node.marks?.some((mark) => mark.type === "strong"));
  return isBold ? "bold 16px sans-serif" : "16px sans-serif";
}

function tokenize(text: string): string[] {
  const tokens = text.match(/\S+|\s+/g);
  return tokens ?? [];
}

function closestCharInRun(
  run: LayoutRun,
  x: number,
  ctx: CanvasRenderingContext2D,
): number {
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

  let bestOffset = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= run.text.length; i += 1) {
    const width = ctx.measureText(run.text.slice(0, i)).width;
    const caretX = run.x + width;
    const distance = Math.abs(x - caretX);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOffset = i;
    }
  }

  return run.charStart + bestOffset;
}

function lineContainsOffset(line: LayoutLine, offset: number): boolean {
  if (line.charStart === line.charEnd) {
    return offset === line.charStart;
  }
  return offset >= line.charStart && offset <= line.charEnd;
}

function measureCaretInLine(
  line: LayoutLine,
  offset: number,
  ctx: CanvasRenderingContext2D,
  bbox: BoundingBox,
): number {
  for (const run of line.runs) {
    if (offset < run.charStart || offset > run.charEnd) {
      continue;
    }

    ctx.font = run.font;
    const width = ctx.measureText(run.text.slice(0, offset - run.charStart)).width;
    return run.x + width;
  }

  if (line.runs.length === 0) {
    return bbox.x + 2;
  }

  const lastRun = line.runs[line.runs.length - 1];
  return lastRun.x + lastRun.width;
}

function drawSelectionOnRun(
  ctx: CanvasRenderingContext2D,
  run: LayoutRun,
  lineHeight: number,
  selectionStart: Position,
  selectionEnd: Position,
): void {
  if (
    run.paragraphIndex < selectionStart.paragraphIndex ||
    run.paragraphIndex > selectionEnd.paragraphIndex
  ) {
    return;
  }

  const start =
    run.paragraphIndex === selectionStart.paragraphIndex ? selectionStart.offset : run.charStart;
  const end =
    run.paragraphIndex === selectionEnd.paragraphIndex ? selectionEnd.offset : run.charEnd;
  const highlightStart = Math.max(start, run.charStart);
  const highlightEnd = Math.min(end, run.charEnd);
  if (highlightEnd <= highlightStart) {
    return;
  }

  ctx.font = run.font;
  const before = ctx.measureText(run.text.slice(0, highlightStart - run.charStart)).width;
  const selected = ctx.measureText(
    run.text.slice(highlightStart - run.charStart, highlightEnd - run.charStart),
  ).width;
  ctx.fillStyle = "#cfe3ff";
  ctx.fillRect(run.x + before, run.y, selected, lineHeight);
}

export function layoutAndRender(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  bbox: BoundingBox,
  cursor: Position,
  selection: { anchor: Position; head: Position },
  cursorVisible: boolean,
): LayoutResult {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.textBaseline = "top";
  const runs: LayoutRun[] = [];
  const lines: LayoutLine[] = [];
  const right = bbox.x + bbox.width;
  let currentX = bbox.x;
  let currentY = bbox.y;
  let cursorX = bbox.x;
  let cursorY = bbox.y;
  const [selectionStart, selectionEnd] = orderRange(selection.anchor, selection.head);
  const hasSelection = comparePositions(selectionStart, selectionEnd) !== 0;

  for (let paragraphIndex = 0; paragraphIndex < doc.content.length; paragraphIndex += 1) {
    const paragraph = doc.content[paragraphIndex];
    let paragraphOffset = 0;
    let activeLine: LayoutLine = {
      paragraphIndex,
      y: currentY,
      charStart: 0,
      charEnd: 0,
      runs: [],
    };
    lines.push(activeLine);

    for (const node of paragraph.content) {
      const font = nodeFont(node);
      ctx.font = font;
      const tokens = tokenize(node.text);

      for (const token of tokens) {
        const tokenWidth = ctx.measureText(token).width;
        if (currentX > bbox.x && currentX + tokenWidth > right) {
          currentX = bbox.x;
          currentY += LINE_HEIGHT;
          activeLine = {
            paragraphIndex,
            y: currentY,
            charStart: paragraphOffset,
            charEnd: paragraphOffset,
            runs: [],
          };
          lines.push(activeLine);
        }

        const charStart = paragraphOffset;
        const charEnd = paragraphOffset + token.length;
        const run: LayoutRun = {
          text: token,
          x: currentX,
          y: currentY,
          width: tokenWidth,
          font,
          paragraphIndex,
          charStart,
          charEnd,
        };

        runs.push(run);
        activeLine.runs.push(run);
        activeLine.charEnd = charEnd;

        paragraphOffset = charEnd;
        currentX += tokenWidth;
      }
    }

    // Keep empty paragraph lines clickable and selectable.
    if (activeLine.runs.length === 0) {
      activeLine.charStart = 0;
      activeLine.charEnd = 0;
    }

    currentX = bbox.x;
    currentY += LINE_HEIGHT;
  }

  if (hasSelection) {
    for (const run of runs) {
      drawSelectionOnRun(ctx, run, LINE_HEIGHT, selectionStart, selectionEnd);
    }
  }

  ctx.fillStyle = "#111111";
  for (const run of runs) {
    ctx.font = run.font;
    ctx.fillText(run.text, run.x, run.y);
  }

  // Draw the editable area bounds so wrapping behavior is visible.
  ctx.strokeStyle = "#2f6feb";
  ctx.lineWidth = 1;
  ctx.strokeRect(bbox.x + 0.5, bbox.y + 0.5, Math.max(0, bbox.width - 1), Math.max(0, bbox.height - 1));

  const cursorLine = lines.find(
    (line) => line.paragraphIndex === cursor.paragraphIndex && lineContainsOffset(line, cursor.offset),
  );
  if (cursorLine) {
    cursorX = measureCaretInLine(cursorLine, cursor.offset, ctx, bbox);
    cursorY = cursorLine.y;
  } else if (lines.length > 0) {
    const fallback = lines[lines.length - 1];
    cursorX = measureCaretInLine(fallback, fallback.charEnd, ctx, bbox);
    cursorY = fallback.y;
  }

  if (cursorVisible && !hasSelection) {
    const minX = bbox.x + 1;
    const maxX = bbox.x + Math.max(1, bbox.width - 1);
    const minY = bbox.y;
    const maxY = bbox.y + Math.max(0, bbox.height - LINE_HEIGHT);
    const clampedCursorX = Math.max(minX, Math.min(cursorX, maxX));
    const clampedCursorY = Math.max(minY, Math.min(cursorY, maxY));
    ctx.fillStyle = "#111111";
    ctx.fillRect(clampedCursorX, clampedCursorY, 1, LINE_HEIGHT);
  }

  return { runs, lines, lineHeight: LINE_HEIGHT };
}

export function hitTest(
  lines: LayoutLine[],
  x: number,
  y: number,
  ctx: CanvasRenderingContext2D,
  lineHeight: number
): Position {
  if (lines.length === 0) {
    return { paragraphIndex: 0, offset: 0 };
  }

  let targetLine = lines[lines.length - 1];
  for (const line of lines) {
    if (y < line.y + lineHeight) {
      targetLine = line;
      break;
    }
  }

  if (targetLine.runs.length === 0) {
    return { paragraphIndex: targetLine.paragraphIndex, offset: 0 };
  }

  for (const run of targetLine.runs) {
    const runRight = run.x + run.width;
    if (x >= run.x && x <= runRight) {
      ctx.font = run.font;
      return {
        paragraphIndex: run.paragraphIndex,
        offset: closestCharInRun(run, x, ctx),
      };
    }

    if (x < run.x) {
      return { paragraphIndex: run.paragraphIndex, offset: run.charStart };
    }
  }

  const lastRun = targetLine.runs[targetLine.runs.length - 1];
  return { paragraphIndex: lastRun.paragraphIndex, offset: lastRun.charEnd };
}
