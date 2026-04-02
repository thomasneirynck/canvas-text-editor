import { CanvasTextEditor } from "../dist/index.js";

const canvas = document.getElementById("editor-canvas");
const editorPane = document.getElementById("editor-pane");
const modelJson = document.getElementById("model-json");
const jsonError = document.getElementById("json-error");

if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Expected #editor-canvas to be an HTMLCanvasElement.");
}

if (!(editorPane instanceof HTMLDivElement)) {
  throw new Error("Expected #editor-pane to be an HTMLDivElement.");
}

if (!(modelJson instanceof HTMLTextAreaElement)) {
  throw new Error("Expected #model-json to be an HTMLTextAreaElement.");
}

if (!(jsonError instanceof HTMLDivElement)) {
  throw new Error("Expected #json-error to be an HTMLDivElement.");
}

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

const paneRect = editorPane.getBoundingClientRect();
canvas.width = Math.max(400, Math.floor(paneRect.width));
canvas.height = Math.max(260, Math.floor(paneRect.height));

const inset = 24;
const editor = new CanvasTextEditor(
  canvas,
  inset,
  inset,
  200,
  200,
  initialDoc,
);

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

editor.onChange((doc) => {
  syncTextareaFromEditor(doc);
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
