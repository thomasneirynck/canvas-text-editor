import { CanvasTextEditor, renderDocument } from "../dist/index.js";

const canvas = document.getElementById("editor-canvas");
const editorPane = document.getElementById("editor-pane");
const editorCanvasWrap = document.querySelector(".editor-canvas-wrap");
const staticCanvas = document.getElementById("static-canvas");
const staticCanvasWrap = document.querySelector(".static-canvas-wrap");
const toolbarBold = document.getElementById("toolbar-bold");
const modelJson = document.getElementById("model-json");
const jsonError = document.getElementById("json-error");


const initialDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", marks: [{ type: "strong" }], text: "world" },
      ],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Select text and press Cmd/Ctrl+B." }],
    },
  ],
};

const paneRect = editorCanvasWrap.getBoundingClientRect();
canvas.width = Math.max(400, Math.floor(paneRect.width));
canvas.height = Math.max(260, Math.floor(paneRect.height));
const staticRect = staticCanvasWrap.getBoundingClientRect();
staticCanvas.width = Math.max(260, Math.floor(staticRect.width));
staticCanvas.height = Math.max(260, Math.floor(staticRect.height));

const inset = 24;
const editorWidth = Math.max(120, canvas.width - inset * 2);
const editorHeight = Math.max(120, canvas.height - inset * 2);
const editor = new CanvasTextEditor(
  canvas,
  inset,
  inset,
  editorWidth,
  editorHeight,
  initialDoc,
);

function renderStaticPreview(doc) {
  const staticWidth = Math.max(120, staticCanvas.width - inset * 2);
  const staticHeight = Math.max(120, staticCanvas.height - inset * 2);
  renderDocument(staticCanvas, doc, {
    x: inset,
    y: inset,
    width: staticWidth,
    height: staticHeight,
  });
}

let applyingFromEditor = false;
let applyingFromTextarea = false;

function setJsonError(message) {
  jsonError.textContent = message;
  if (message) {
    modelJson.classList.add("error");
  } else {
    modelJson.classList.remove("error");
  }
}

function formatDoc(doc) {
  return JSON.stringify(doc, null, 2);
}

function syncTextareaFromEditor(doc) {
  if (applyingFromTextarea) {
    return;
  }
  applyingFromEditor = true;
  modelJson.value = formatDoc(doc);
  setJsonError("");
  applyingFromEditor = false;
}

syncTextareaFromEditor(editor.getDocument());
renderStaticPreview(editor.getDocument());

editor.onChange((doc) => {
  syncTextareaFromEditor(doc);
  renderStaticPreview(doc);
});

function syncBoldButton() {
  const active = editor.isBoldActive();
  toolbarBold.classList.toggle("active", active);
  toolbarBold.setAttribute("aria-pressed", String(active));
}

editor.onSelectionChange(() => {
  syncBoldButton();
});

toolbarBold.addEventListener("mousedown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const next = !editor.isBoldActive();
  editor.setBoldActive(next);
  canvas.focus();
  syncBoldButton();
});

modelJson.addEventListener("input", () => {
  if (applyingFromEditor) {
    return;
  }

  try {
    const parsed = JSON.parse(modelJson.value);
    applyingFromTextarea = true;
    editor.setDocument(parsed);
    applyingFromTextarea = false;
    syncTextareaFromEditor(editor.getDocument());
    setJsonError("");
  } catch (error) {
    applyingFromTextarea = false;
    const message = error instanceof Error ? error.message : "Invalid JSON";
    setJsonError(message);
  }
});

syncBoldButton();
