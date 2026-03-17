import { decodeFromSource } from "./utils/qr-scanner.js";

const MAX_HISTORY = 100;
const fileInput = document.getElementById("file");
const uploadTrigger = document.getElementById("upload-trigger");
const outputDiv = document.getElementById("output");
const historyDiv = document.getElementById("history");
const statusDiv = document.getElementById("status");
const captureButton = document.getElementById("capture-btn");

fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  console.log("Popup: user selected file", file.name);
  handleFile(file);
  event.target.value = "";
});

uploadTrigger.addEventListener("click", () => {
  fileInput.click();
});

captureButton.addEventListener("click", async () => {
  const tabId = await ensurePanelOnActiveTab();
  if (!tabId) {
    setStatus("无法打开侧边栏，请稍后重试。", "error");
    return;
  }
  setStatus("等待截图识别...", "loading");
  console.log("Popup: screenshot shortcut triggered, tabId", tabId);
  chrome.tabs.sendMessage(tabId, { type: "START_SCREENSHOT_SELECTION" });
});

async function handleFile(file) {
  setStatus("识别中…", "loading");
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.onload = async () => {
    try {
      const results = await decodeFromSource(img);
      console.log("Popup: decoded from upload", results);
      renderResults(results);
      await ensurePanelOnActiveTab();
      notifySidePanel(results);
      if (!results.length) {
        setStatus("未识别到二维码", "error");
        return;
      }
      cacheLastResults(results);
      setStatus(`识别完成：${results.length} 个二维码`, "success");
      results.forEach(saveHistory);
      loadHistory();
    } catch (error) {
      console.error("Popup: decode failed", error);
      const message =
        typeof error?.message === "string"
          ? error.message
          : "二维码识别失败，请重试。";
      setStatus(message, "error");
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  img.onerror = () => {
    setStatus("图片加载失败，请重试。", "error");
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function renderResults(list) {
  if (!list || !list.length) {
    outputDiv.innerHTML =
      '<div class="result-card result-empty">未检测到二维码，请上传其他图片或尝试截图。</div>';
    return;
  }

  outputDiv.innerHTML = list
    .map(
      (item) => `<div class="result-card">${formatContent(item)}</div>`
    )
    .join("");
}

function formatContent(data) {
  if (isURL(data)) {
    return `<a href="${data}" target="_blank" rel="noreferrer noopener">${escapeHTML(
      data
    )}</a>`;
  }
  return `<div>${escapeHTML(data)}</div>`;
}

function setStatus(text, state = "idle") {
  if (!statusDiv) {
    return;
  }
  statusDiv.textContent = text;
  statusDiv.dataset.state = state;
}

function loadHistory() {
  chrome.storage.local.get({ history: [] }, (res) => {
    const history = Array.isArray(res.history) ? res.history : [];
    historyDiv.innerHTML = history
      .slice(0, MAX_HISTORY)
      .map((item) => {
        const time = new Date(item.time).toLocaleString();
        const content = isURL(item.data)
          ? `<a href="${item.data}" target="_blank" rel="noreferrer noopener">${escapeHTML(
              item.data
            )}</a>`
          : escapeHTML(item.data);
        return `<div class="history-item">${content}<small>${time}</small></div>`;
      })
      .join("");
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

function isURL(text) {
  return /^https?:\/\//i.test(text);
}

function escapeHTML(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function notifySidePanel(results) {
  chrome.runtime.sendMessage({
    type: "RESULT_LIST",
    data: results
  });
}

async function ensurePanelOnActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab?.id) {
    return null;
  }
  chrome.runtime.sendMessage({
    type: "OPEN_SIDE_PANEL",
    tabId: tab.id
  });
  return tab.id;
}

function cacheLastResults(results) {
  chrome.storage.local.set({
    lastResult: results
  });
}

setStatus("等待识别", "idle");
loadHistory();
