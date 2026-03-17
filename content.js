const modulePromise = import(chrome.runtime.getURL("utils/qr-scanner.js"));

let decodeFromSourceFn = null;
let capturePreviewFn = null;
const MAX_HISTORY = 100;

async function ensureScanner() {
  if (decodeFromSourceFn && capturePreviewFn) {
    return {
      decodeFromSource: decodeFromSourceFn,
      capturePreview: capturePreviewFn
    };
  }
  const module = await modulePromise;
  decodeFromSourceFn = module.decodeFromSource;
  capturePreviewFn = module.capturePreview;
  return {
    decodeFromSource: decodeFromSourceFn,
    capturePreview: capturePreviewFn
  };
}

async function scanImageFromUrl(url) {
  console.log("Content: scanImageFromUrl", url);
  const { decodeFromSource, capturePreview } = await ensureScanner();

  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.onload = async () => {
    try {
      const results = await decodeFromSource(img);
      let preview = null;
      if (typeof capturePreview === "function") {
        try {
          preview = capturePreview(img);
        } catch (error) {
          console.warn("Content: preview generation failed", error);
        }
      }
      handleResults(results, preview);
    } catch (error) {
      handleScanError(error);
    }
  };
  img.onerror = () => {
    sendToSidePanel("图片加载失败，无法识别。");
  };
  img.src = url;
}

async function scanScreenshot(dataUrl, selection = null) {
  console.log("Content: scanScreenshot", selection);
  const { decodeFromSource, capturePreview } = await ensureScanner();
  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.onload = async () => {
    try {
      const results = await decodeFromSource(img, selection);
      let preview = null;
      if (typeof capturePreview === "function") {
        try {
          preview = capturePreview(img, selection);
        } catch (error) {
          console.warn("Content: preview generation failed", error);
        }
      }
      handleResults(results, preview);
    } catch (error) {
      handleScanError(error);
    }
  };
  img.onerror = () => {
    sendToSidePanel("截图加载失败，无法识别。");
  };
  img.src = dataUrl;
}

function handleResults(results, preview = null) {
  if (!Array.isArray(results) || results.length === 0) {
    console.log("Content: no QR result");
    chrome.runtime.sendMessage({
      type: "RESULT_LIST",
      data: [],
      preview
    });
    return;
  }

  results.forEach(saveHistory);
  cacheLastResults(results);
  chrome.runtime.sendMessage({
    type: "RESULT_LIST",
    data: results,
    preview
  });
}

function handleScanError(error) {
  console.error("Content: scan error", error);
  const message =
    typeof error?.message === "string"
      ? error.message
      : "二维码识别失败，请稍后重试。";
  sendToSidePanel(message);
}

function sendToSidePanel(data) {
  chrome.runtime.sendMessage({
    type: "RESULT",
    data
  });
}

function saveHistory(data) {
  chrome.storage.local.get({ history: [] }, (res) => {
    const history = res.history || [];
    history.unshift({ data, time: Date.now() });
    if (history.length > MAX_HISTORY) {
      history.length = MAX_HISTORY;
    }
    chrome.storage.local.set({ history });
  });
}

function cacheLastResults(results) {
  chrome.storage.local.set({ lastResult: results });
}

function requestScreenshot(selection) {
  chrome.runtime.sendMessage({
    type: "REQUEST_SCREENSHOT",
    selection
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  console.log("Content: runtime message", msg);
  if (msg.type === "SCAN_IMAGE") {
    scanImageFromUrl(msg.url);
    return;
  }

  if (msg.type === "SCAN_SCREENSHOT") {
    scanScreenshot(msg.dataUrl, msg.selection);
    return;
  }

  if (msg.type === "START_SCREENSHOT_SELECTION") {
    startSelectionOverlay();
    return;
  }

  if (msg.type === "SCAN_ERROR") {
    sendToSidePanel(msg.message || "截图识别失败");
  }
});

let selectionState = null;

function startSelectionOverlay() {
  if (selectionState) {
    selectionState.cleanup();
    selectionState = null;
  }

  if (!document.body) {
    sendToSidePanel("当前页面不支持截图选择。");
    return;
  }

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:2147483647;cursor:crosshair;";

  const selectionBox = document.createElement("div");
  selectionBox.style.cssText =
    "border:2px dashed #0f62fe;position:fixed;pointer-events:none;display:none;z-index:2147483648;border-radius:8px;";

  const prompt = document.createElement("div");
  prompt.style.cssText =
    "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#fff;padding:10px 14px;border-radius:10px;font-size:13px;box-shadow:0 10px 30px rgba(15,23,42,0.25);";
  prompt.textContent = "拖拽选中二维码区域，或按 Esc 取消";

  overlay.append(prompt, selectionBox);
  document.body.appendChild(overlay);

  const CANCEL_TIMEOUT = 15000;
  const state = {
    overlay,
    selectionBox,
    isDragging: false,
    startX: 0,
    startY: 0,
    cancelTimer: null
  };

  function updateSelection(x, y) {
    const rect = {
      x: Math.min(state.startX, x),
      y: Math.min(state.startY, y),
      width: Math.abs(x - state.startX),
      height: Math.abs(y - state.startY)
    };
    state.selectionBox.style.display = "block";
    state.selectionBox.style.left = `${rect.x}px`;
    state.selectionBox.style.top = `${rect.y}px`;
    state.selectionBox.style.width = `${rect.width}px`;
    state.selectionBox.style.height = `${rect.height}px`;
    return rect;
  }

  function onPointerDown(event) {
    event.preventDefault();
    state.isDragging = true;
    state.startX = event.clientX;
    state.startY = event.clientY;
  }

  function onPointerMove(event) {
    if (!state.isDragging) {
      return;
    }
    updateSelection(event.clientX, event.clientY);
  }

  function onPointerUp(event) {
    if (!state.isDragging) {
      return;
    }
    state.isDragging = false;
    const rect = updateSelection(event.clientX, event.clientY);
    cleanup();
    requestScreenshot(rect.width < 10 || rect.height < 10 ? null : rect);
  }

  function onEsc(event) {
    if (event.key === "Escape") {
      cleanup(true);
    }
  }

  function cleanup(sendCancelMessage = false) {
    overlay.remove();
    window.removeEventListener("keydown", onEsc);
    overlay.removeEventListener("pointerdown", onPointerDown);
    overlay.removeEventListener("pointermove", onPointerMove);
    overlay.removeEventListener("pointerup", onPointerUp);
    selectionState = null;
    if (state.cancelTimer) {
      clearTimeout(state.cancelTimer);
      state.cancelTimer = null;
    }
    if (sendCancelMessage) {
      chrome.runtime.sendMessage({
        type: "SCAN_STATUS",
        message: "截图操作已取消",
        state: "idle"
      });
    }
  }

  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onEsc);

  state.cleanup = cleanup;
  state.cancelTimer = setTimeout(() => {
    cleanup(true);
  }, CANCEL_TIMEOUT);

  selectionState = state;
}
