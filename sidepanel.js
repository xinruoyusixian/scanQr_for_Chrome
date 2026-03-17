import { decodeFromSource, capturePreview } from "./utils/qr-scanner.js";

const resultDiv = document.getElementById("result");
const historyDiv = document.getElementById("history");
const statusChip = document.getElementById("status-chip");
const previewContainer = document.getElementById("preview-container");
const previewImg = document.getElementById("preview-img");
const screenshotBtn = document.getElementById("screenshot-btn");
const uploadBtn = document.getElementById("upload-btn");
const fileInput = document.getElementById("file-input");
const clearHistoryBtn = document.getElementById("clear-history");
const HISTORY_DISPLAY_LIMIT = 50;

statusChip.dataset.state = "idle";

screenshotBtn.addEventListener("click", startScreenshotScan);
uploadBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  event.target.value = "";
  handleFileUpload(file);
});
clearHistoryBtn.addEventListener("click", () => {
  chrome.storage.local.set({ history: [] }, () => {
    loadHistory();
    setStatus("历史记录已清除", "success");
  });
});

function updatePreview(src, error = false) {
  if (!previewContainer || !previewImg) {
    return;
  }
  if (src) {
    previewImg.src = src;
    previewContainer.classList.remove("hidden");
    previewContainer.dataset.state = error ? "error" : "idle";
  } else {
    previewImg.src = "";
    previewContainer.classList.add("hidden");
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SCAN_STATUS") {
    setStatus(msg.message, msg.state ?? "idle");
    return;
  }

  if (msg.type === "RESULT") {
    renderSingle(msg.data);
    loadHistory();
    setStatus("识别完成", "success");
  }

  if (msg.type === "RESULT_LIST") {
    const isEmpty = !msg.data?.length;
    renderList(msg.data, { error: isEmpty, preview: msg.preview });
    loadHistory();
    setStatus(isEmpty ? "未识别到二维码" : "识别完成", isEmpty ? "error" : "success");
  }
});

async function startScreenshotScan() {
  setStatus("等待截图选区...", "loading");
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab?.id) {
    setStatus("找不到活动选项卡", "error");
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "START_SCREENSHOT_SELECTION" });
}

async function handleFileUpload(file) {
  setStatus("正在识别图片...", "loading");
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.onload = async () => {
    try {
      const results = await decodeFromSource(img);
      let preview = null;
      try {
        preview = capturePreview(img);
      } catch (error) {
        console.warn("SidePanel: preview failed", error);
      }
      renderSideResults(results, preview);
    } catch (error) {
      const message =
        typeof error?.message === "string"
          ? error.message
          : "二维码识别失败，请稍后重试";
      setStatus(message, "error");
      renderEmpty({ error: true });
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  img.onerror = () => {
    setStatus("图片加载失败", "error");
    renderEmpty({ error: true });
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function renderSideResults(list, preview) {
  if (!list || !list.length) {
    renderList(list, { error: true, preview });
    setStatus("未识别到二维码", "error");
    return;
  }
  renderList(list, { preview });
  setStatus(`识别成功，共 ${list.length} 个结果`, "success");
  list.forEach(saveHistory);
  cacheLastResults(list);
  loadHistory();
}

function renderSingle(data) {
  resultDiv.innerHTML = formatItem(data);
  updatePreview(null);
}

function renderList(list, { error = false, preview = null } = {}) {
  if (!list || !list.length) {
    renderEmpty({ error, preview });
    return;
  }
  updatePreview(preview, error);
  resultDiv.innerHTML = list
    .map((item) => `<div class="result-card">${formatItem(item)}</div>`)
    .join("");
}

function renderEmpty({ error = false, preview = null } = {}) {
  updatePreview(preview, error);
  const classes = error ? "result-card error" : "result-card";
  resultDiv.innerHTML = `<div class="${classes}">暂无识别结果，点上传或截图试试看</div>`;
}

function formatItem(data) {
  if (isURL(data)) {
    return `<div><a href="${data}" target="_blank" rel="noreferrer noopener">${escapeHTML(
      data
    )}</a></div>`;
  }
  return `<div>${escapeHTML(data)}</div>`;
}

function setStatus(text, state = "idle") {
  statusChip.textContent = text;
  statusChip.dataset.state = state;
}

function loadHistory() {
  chrome.storage.local.get({ history: [] }, (res) => {
    const history = Array.isArray(res.history) ? res.history : [];
    historyDiv.innerHTML = history
      .slice(0, HISTORY_DISPLAY_LIMIT)
      .map((item) => {
        const time = new Date(item.time).toLocaleString();
        return `<div class="history-item">
          ${formatItem(item.data)}
          <small>${time}</small>
        </div>`;
      })
      .join("");
  });
}

function saveHistory(data) {
  chrome.storage.local.get({ history: [] }, (res) => {
    const history = res.history || [];
    history.unshift({ data, time: Date.now() });
    if (history.length > HISTORY_DISPLAY_LIMIT) {
      history.length = HISTORY_DISPLAY_LIMIT;
    }
    chrome.storage.local.set({ history });
  });
}

function cacheLastResults(results) {
  chrome.storage.local.set({ lastResult: results });
}

function isURL(text) {
  return /^https?:\/\//i.test(text);
}

function escapeHTML(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

loadHistory();
renderEmpty();
