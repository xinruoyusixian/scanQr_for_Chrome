chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "scan-qr",
    title: "扫码此图，Scan This image",
    contexts: ["image"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "scan-qr" || !tab?.id) {
    return;
  }

  console.log("Background: context menu scan requested", info.srcUrl, "tab", tab.id);
  openSidePanel(tab.id);
  safeSendMessage(tab.id, {
    type: "SCAN_IMAGE",
    url: info.srcUrl
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-qr") {
    return;
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    return;
  }

  console.log("Background: shortcut scan requested", tab.id);
  openSidePanel(tab.id);
  safeSendMessage(tab.id, { type: "START_SCREENSHOT_SELECTION" });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "REQUEST_SCREENSHOT") {
    handleScreenshotRequest(message.selection, sender);
    return;
  }

  if (message.type === "OPEN_SIDE_PANEL" && typeof message.tabId === "number") {
    openSidePanel(message.tabId);
  }
});

async function handleScreenshotRequest(selection, sender) {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;

  if (tabId == null || windowId == null) {
    return;
  }

  try {
    console.log("Background: capturing visible tab", tabId, windowId, selection);
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "png"
    });

    await safeSendMessage(tabId, {
      type: "SCAN_SCREENSHOT",
      dataUrl,
      selection: selection || null
    });
  } catch (error) {
    console.warn("Background: screenshot flow failed", error);
    if (tabId != null) {
      safeSendMessage(tabId, {
        type: "SCAN_ERROR",
        message: "Screenshot capture failed."
      });
    }
  }
}

function openSidePanel(tabId) {
  if (chrome.sidePanel?.open) {
    chrome.sidePanel.open({ tabId });
    return;
  }

  chrome.tabs.create({
    url: chrome.runtime.getURL("sidepanel.html")
  });
}

function safeSendMessage(tabId, message) {
  if (tabId == null) {
    return Promise.resolve();
  }

  return chrome.tabs
    .sendMessage(tabId, message)
    .catch(() => {
      // Ignore if the tab has no listener yet.
    });
}
