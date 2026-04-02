export interface Mark {
  type: "strong";
}

export interface TextNode {
  type: "text";
  text: string;
  marks?: Mark[];
}

export interface Paragraph {
  type: "paragraph";
  content: TextNode[];
}

export interface Doc {
  type: "doc";
  content: Paragraph[];
}

export interface Position {
  paragraphIndex: number;
  offset: number;
}

function hasStrong(node: TextNode): boolean {
  return Boolean(node.marks?.some((mark) => mark.type === "strong"));
}

function marksForBold(bold: boolean): Mark[] | undefined {
  return bold ? [{ type: "strong" }] : undefined;
}

function sameMarks(a: TextNode, b: TextNode): boolean {
  return hasStrong(a) === hasStrong(b);
}

function ensureParagraph(doc: Doc, paragraphIndex: number): Paragraph {
  const clamped = Math.max(0, Math.min(paragraphIndex, doc.content.length - 1));
  return doc.content[clamped];
}

function paragraphLength(paragraph: Paragraph): number {
  return paragraph.content.reduce((total, node) => total + node.text.length, 0);
}

function paragraphNodesAtOffset(paragraph: Paragraph, offset: number): { nodeIndex: number; localOffset: number } {
  const nodes = paragraph.content;

  if (nodes.length === 0) {
    return { nodeIndex: 0, localOffset: 0 };
  }

  const clamped = Math.max(0, Math.min(offset, paragraphLength(paragraph)));
  let consumed = 0;

  for (let index = 0; index < nodes.length; index += 1) {
    const len = nodes[index].text.length;
    if (clamped <= consumed + len) {
      return { nodeIndex: index, localOffset: clamped - consumed };
    }
    consumed += len;
  }

  const lastIndex = nodes.length - 1;
  return { nodeIndex: lastIndex, localOffset: nodes[lastIndex].text.length };
}

export function mergeAdjacentNodes(paragraph: Paragraph): void {
  const merged: TextNode[] = [];
  for (const node of paragraph.content) {
    if (node.text.length === 0) {
      continue;
    }

    const prev = merged[merged.length - 1];
    if (prev && sameMarks(prev, node)) {
      prev.text += node.text;
    } else {
      merged.push({
        type: "text",
        text: node.text,
        marks: hasStrong(node) ? [{ type: "strong" }] : undefined,
      });
    }
  }
  paragraph.content = merged;
}

export function normalizeDoc(doc: Doc): void {
  for (const paragraph of doc.content) {
    mergeAdjacentNodes(paragraph);
  }

  if (doc.content.length === 0) {
    doc.content.push({ type: "paragraph", content: [] });
  }
}

export function comparePositions(a: Position, b: Position): number {
  if (a.paragraphIndex !== b.paragraphIndex) {
    return a.paragraphIndex - b.paragraphIndex;
  }
  return a.offset - b.offset;
}

export function orderRange(a: Position, b: Position): [Position, Position] {
  return comparePositions(a, b) <= 0 ? [a, b] : [b, a];
}

export function clampPosition(doc: Doc, position: Position): Position {
  normalizeDoc(doc);
  const paragraphIndex = Math.max(0, Math.min(position.paragraphIndex, doc.content.length - 1));
  const paragraph = ensureParagraph(doc, paragraphIndex);
  return {
    paragraphIndex,
    offset: Math.max(0, Math.min(position.offset, paragraphLength(paragraph))),
  };
}

export function totalLengthWithBreaks(doc: Doc): number {
  if (doc.content.length === 0) {
    return 0;
  }

  let total = 0;
  for (let i = 0; i < doc.content.length; i += 1) {
    total += paragraphLength(doc.content[i]);
    if (i < doc.content.length - 1) {
      total += 1;
    }
  }
  return total;
}

export function positionToGlobal(doc: Doc, position: Position): number {
  const clamped = clampPosition(doc, position);
  let total = 0;
  for (let i = 0; i < clamped.paragraphIndex; i += 1) {
    total += paragraphLength(doc.content[i]) + 1;
  }
  return total + clamped.offset;
}

export function globalToPosition(doc: Doc, globalOffset: number): Position {
  normalizeDoc(doc);
  let remaining = Math.max(0, Math.min(globalOffset, totalLengthWithBreaks(doc)));

  for (let i = 0; i < doc.content.length; i += 1) {
    const len = paragraphLength(doc.content[i]);
    if (remaining <= len) {
      return { paragraphIndex: i, offset: remaining };
    }
    remaining -= len;

    if (i < doc.content.length - 1) {
      if (remaining === 0) {
        return { paragraphIndex: i + 1, offset: 0 };
      }
      remaining -= 1;
    }
  }

  const lastIndex = doc.content.length - 1;
  return { paragraphIndex: lastIndex, offset: paragraphLength(doc.content[lastIndex]) };
}

function splitNodesAtOffset(paragraph: Paragraph, offset: number): { left: TextNode[]; right: TextNode[] } {
  const nodes = paragraph.content;
  const clampedOffset = Math.max(0, Math.min(offset, paragraphLength(paragraph)));
  const left: TextNode[] = [];
  const right: TextNode[] = [];
  let cursor = 0;

  for (const node of nodes) {
    const start = cursor;
    const end = cursor + node.text.length;
    cursor = end;

    if (end <= clampedOffset) {
      left.push({ type: "text", text: node.text, marks: hasStrong(node) ? [{ type: "strong" }] : undefined });
      continue;
    }

    if (start >= clampedOffset) {
      right.push({ type: "text", text: node.text, marks: hasStrong(node) ? [{ type: "strong" }] : undefined });
      continue;
    }

    const split = clampedOffset - start;
    const leftText = node.text.slice(0, split);
    const rightText = node.text.slice(split);
    if (leftText.length > 0) {
      left.push({ type: "text", text: leftText, marks: hasStrong(node) ? [{ type: "strong" }] : undefined });
    }
    if (rightText.length > 0) {
      right.push({ type: "text", text: rightText, marks: hasStrong(node) ? [{ type: "strong" }] : undefined });
    }
  }

  return { left, right };
}

function toggleBoldInParagraph(paragraph: Paragraph, from: number, to: number): void {
  const nodes = paragraph.content;
  if (nodes.length === 0) {
    return;
  }

  const start = Math.max(0, Math.min(from, to));
  const end = Math.max(from, to);
  if (start === end) {
    return;
  }

  const next: TextNode[] = [];
  let cursor = 0;

  for (const node of nodes) {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.text.length;
    cursor = nodeEnd;

    if (end <= nodeStart || start >= nodeEnd) {
      next.push(node);
      continue;
    }

    const overlapStart = Math.max(start, nodeStart);
    const overlapEnd = Math.min(end, nodeEnd);
    const left = node.text.slice(0, overlapStart - nodeStart);
    const middle = node.text.slice(overlapStart - nodeStart, overlapEnd - nodeStart);
    const right = node.text.slice(overlapEnd - nodeStart);
    const nodeBold = hasStrong(node);

    if (left.length > 0) {
      next.push({
        type: "text",
        text: left,
        marks: nodeBold ? [{ type: "strong" }] : undefined,
      });
    }

    if (middle.length > 0) {
      next.push({
        type: "text",
        text: middle,
        marks: nodeBold ? undefined : [{ type: "strong" }],
      });
    }

    if (right.length > 0) {
      next.push({
        type: "text",
        text: right,
        marks: nodeBold ? [{ type: "strong" }] : undefined,
      });
    }
  }

  paragraph.content = next;
  mergeAdjacentNodes(paragraph);
}

function setBoldInParagraph(paragraph: Paragraph, from: number, to: number, bold: boolean): void {
  const nodes = paragraph.content;
  if (nodes.length === 0) {
    return;
  }

  const start = Math.max(0, Math.min(from, to));
  const end = Math.max(from, to);
  if (start === end) {
    return;
  }

  const next: TextNode[] = [];
  let cursor = 0;

  for (const node of nodes) {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.text.length;
    cursor = nodeEnd;

    if (end <= nodeStart || start >= nodeEnd) {
      next.push(node);
      continue;
    }

    const overlapStart = Math.max(start, nodeStart);
    const overlapEnd = Math.min(end, nodeEnd);
    const left = node.text.slice(0, overlapStart - nodeStart);
    const middle = node.text.slice(overlapStart - nodeStart, overlapEnd - nodeStart);
    const right = node.text.slice(overlapEnd - nodeStart);
    const nodeBold = hasStrong(node);

    if (left.length > 0) {
      next.push({
        type: "text",
        text: left,
        marks: nodeBold ? [{ type: "strong" }] : undefined,
      });
    }

    if (middle.length > 0) {
      next.push({
        type: "text",
        text: middle,
        marks: bold ? [{ type: "strong" }] : undefined,
      });
    }

    if (right.length > 0) {
      next.push({
        type: "text",
        text: right,
        marks: nodeBold ? [{ type: "strong" }] : undefined,
      });
    }
  }

  paragraph.content = next;
  mergeAdjacentNodes(paragraph);
}

export function insertText(doc: Doc, position: Position, text: string, bold: boolean): Position {
  const clamped = clampPosition(doc, position);
  const paragraph = ensureParagraph(doc, clamped.paragraphIndex);
  const nodes = paragraph.content;
  const desiredMarks = marksForBold(bold);

  if (nodes.length === 0) {
    nodes.push({ type: "text", text, marks: desiredMarks });
    return { paragraphIndex: clamped.paragraphIndex, offset: clamped.offset + text.length };
  }

  const { nodeIndex, localOffset } = paragraphNodesAtOffset(paragraph, clamped.offset);
  const target = nodes[nodeIndex];
  const targetBold = hasStrong(target);

  if (targetBold === bold) {
    target.text = `${target.text.slice(0, localOffset)}${text}${target.text.slice(localOffset)}`;
    mergeAdjacentNodes(paragraph);
    return { paragraphIndex: clamped.paragraphIndex, offset: clamped.offset + text.length };
  }

  const beforeText = target.text.slice(0, localOffset);
  const afterText = target.text.slice(localOffset);
  const replacement: TextNode[] = [];

  if (beforeText.length > 0) {
    replacement.push({
      type: "text",
      text: beforeText,
      marks: targetBold ? [{ type: "strong" }] : undefined,
    });
  }

  replacement.push({ type: "text", text, marks: desiredMarks });

  if (afterText.length > 0) {
    replacement.push({
      type: "text",
      text: afterText,
      marks: targetBold ? [{ type: "strong" }] : undefined,
    });
  }

  nodes.splice(nodeIndex, 1, ...replacement);
  mergeAdjacentNodes(paragraph);
  return { paragraphIndex: clamped.paragraphIndex, offset: clamped.offset + text.length };
}

export function splitParagraphAt(doc: Doc, position: Position): Position {
  const clamped = clampPosition(doc, position);
  const paragraph = ensureParagraph(doc, clamped.paragraphIndex);
  const { left, right } = splitNodesAtOffset(paragraph, clamped.offset);

  paragraph.content = left;
  mergeAdjacentNodes(paragraph);

  const nextParagraph: Paragraph = {
    type: "paragraph",
    content: right,
  };
  mergeAdjacentNodes(nextParagraph);

  doc.content.splice(clamped.paragraphIndex + 1, 0, nextParagraph);
  normalizeDoc(doc);
  return { paragraphIndex: clamped.paragraphIndex + 1, offset: 0 };
}

export function deleteRange(doc: Doc, a: Position, b: Position): Position {
  normalizeDoc(doc);
  const [startRaw, endRaw] = orderRange(clampPosition(doc, a), clampPosition(doc, b));
  if (comparePositions(startRaw, endRaw) === 0) {
    return startRaw;
  }

  if (startRaw.paragraphIndex === endRaw.paragraphIndex) {
    const paragraph = ensureParagraph(doc, startRaw.paragraphIndex);
    const { left } = splitNodesAtOffset(paragraph, startRaw.offset);
    const { right } = splitNodesAtOffset(paragraph, endRaw.offset);
    paragraph.content = [...left, ...right];
    mergeAdjacentNodes(paragraph);
    normalizeDoc(doc);
    return startRaw;
  }

  const startParagraph = ensureParagraph(doc, startRaw.paragraphIndex);
  const endParagraph = ensureParagraph(doc, endRaw.paragraphIndex);
  const leftPart = splitNodesAtOffset(startParagraph, startRaw.offset).left;
  const rightPart = splitNodesAtOffset(endParagraph, endRaw.offset).right;
  startParagraph.content = [...leftPart, ...rightPart];
  mergeAdjacentNodes(startParagraph);

  const removeCount = endRaw.paragraphIndex - startRaw.paragraphIndex;
  doc.content.splice(startRaw.paragraphIndex + 1, removeCount);
  normalizeDoc(doc);
  return startRaw;
}

export function toggleBold(doc: Doc, a: Position, b: Position): void {
  normalizeDoc(doc);
  const [start, end] = orderRange(clampPosition(doc, a), clampPosition(doc, b));
  if (comparePositions(start, end) === 0) {
    return;
  }

  for (let paragraphIndex = start.paragraphIndex; paragraphIndex <= end.paragraphIndex; paragraphIndex += 1) {
    const paragraph = ensureParagraph(doc, paragraphIndex);
    const localStart = paragraphIndex === start.paragraphIndex ? start.offset : 0;
    const localEnd =
      paragraphIndex === end.paragraphIndex ? end.offset : paragraphLength(paragraph);
    toggleBoldInParagraph(paragraph, localStart, localEnd);
  }

  normalizeDoc(doc);
}

export function isRangeFullyBold(doc: Doc, a: Position, b: Position): boolean {
  normalizeDoc(doc);
  const [start, end] = orderRange(clampPosition(doc, a), clampPosition(doc, b));
  if (comparePositions(start, end) === 0) {
    return false;
  }

  for (let paragraphIndex = start.paragraphIndex; paragraphIndex <= end.paragraphIndex; paragraphIndex += 1) {
    const paragraph = ensureParagraph(doc, paragraphIndex);
    const localStart = paragraphIndex === start.paragraphIndex ? start.offset : 0;
    const localEnd = paragraphIndex === end.paragraphIndex ? end.offset : paragraphLength(paragraph);
    if (localStart === localEnd) {
      continue;
    }

    let cursor = 0;
    for (const node of paragraph.content) {
      const nodeStart = cursor;
      const nodeEnd = cursor + node.text.length;
      cursor = nodeEnd;
      if (localEnd <= nodeStart || localStart >= nodeEnd) {
        continue;
      }
      if (!hasStrong(node)) {
        return false;
      }
    }
  }

  return true;
}

export function setBold(doc: Doc, a: Position, b: Position, bold: boolean): void {
  normalizeDoc(doc);
  const [start, end] = orderRange(clampPosition(doc, a), clampPosition(doc, b));
  if (comparePositions(start, end) === 0) {
    return;
  }

  for (let paragraphIndex = start.paragraphIndex; paragraphIndex <= end.paragraphIndex; paragraphIndex += 1) {
    const paragraph = ensureParagraph(doc, paragraphIndex);
    const localStart = paragraphIndex === start.paragraphIndex ? start.offset : 0;
    const localEnd = paragraphIndex === end.paragraphIndex ? end.offset : paragraphLength(paragraph);
    setBoldInParagraph(paragraph, localStart, localEnd, bold);
  }

  normalizeDoc(doc);
}

function paragraphText(paragraph: Paragraph): string {
  return paragraph.content.map((node) => node.text).join("");
}

export function getTextInRange(doc: Doc, a: Position, b: Position): string {
  normalizeDoc(doc);
  const [start, end] = orderRange(clampPosition(doc, a), clampPosition(doc, b));
  if (comparePositions(start, end) === 0) {
    return "";
  }

  const parts: string[] = [];
  for (let paragraphIndex = start.paragraphIndex; paragraphIndex <= end.paragraphIndex; paragraphIndex += 1) {
    const paragraph = ensureParagraph(doc, paragraphIndex);
    const text = paragraphText(paragraph);
    const localStart = paragraphIndex === start.paragraphIndex ? start.offset : 0;
    const localEnd = paragraphIndex === end.paragraphIndex ? end.offset : text.length;
    parts.push(text.slice(localStart, localEnd));
  }

  return parts.join("\n");
}
