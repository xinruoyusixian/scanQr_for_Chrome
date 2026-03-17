const BARCODE_FORMATS = ["qr_code"];
let detectorInstance = null;
let jsQRModulePromise = null;

function supportsBarcodeDetector() {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

async function ensureDetector() {
  if (!supportsBarcodeDetector()) {
    return null;
  }

  if (!detectorInstance) {
    detectorInstance = new BarcodeDetector({ formats: BARCODE_FORMATS });
  }

  return detectorInstance;
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(Math.round(width), 1);
  canvas.height = Math.max(Math.round(height), 1);
  return canvas;
}

function drawSourceToCanvas(source, selection) {
  const width = selection?.width ?? calculateSourceWidth(source);
  const height = selection?.height ?? calculateSourceHeight(source);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  if (selection && selection.width > 0 && selection.height > 0) {
    ctx.drawImage(
      source,
      selection.x,
      selection.y,
      selection.width,
      selection.height,
      0,
      0,
      selection.width,
      selection.height
    );
  } else {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }

  return canvas;
}

function calculateSourceWidth(source) {
  if (source instanceof HTMLCanvasElement) {
    return source.width;
  }
  if (source instanceof HTMLImageElement) {
    return source.naturalWidth || source.width;
  }
  if (source instanceof ImageBitmap) {
    return source.width;
  }
  return 0;
}

function calculateSourceHeight(source) {
  if (source instanceof HTMLCanvasElement) {
    return source.height;
  }
  if (source instanceof HTMLImageElement) {
    return source.naturalHeight || source.height;
  }
  if (source instanceof ImageBitmap) {
    return source.height;
  }
  return 0;
}

async function ensureJSQR() {
  if (jsQRModulePromise) {
    return jsQRModulePromise;
  }

  const loaderUrl = chrome.runtime.getURL("utils/jsqr-loader.js");
  jsQRModulePromise = import(loaderUrl).then((mod) => {
    const candidate = mod?.default ?? mod;
    if (typeof candidate !== "function") {
      throw new Error("jsQR export invalid");
    }
    return candidate;
  });

  return jsQRModulePromise;
}

async function decodeWithJSQR(canvas) {
  const jsQR = await ensureJSQR();
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, canvas.width, canvas.height, {
    inversionAttempts: "dontInvert"
  });
  return code ? [code.data] : [];
}

async function detectWithBarcodeDetector(source) {
  const detector = await ensureDetector();
  if (!detector) {
    throw new Error("BarcodeDetector is not available.");
  }

  const results = await detector.detect(source);
  return results.map((item) => item.rawValue).filter(Boolean);
}

async function decodeFromSource(source, selection = null) {
  const canvas = source instanceof HTMLCanvasElement && !selection ? source : drawSourceToCanvas(source, selection);

  try {
    return await detectWithBarcodeDetector(canvas);
  } catch (error) {
    console.warn("BarcodeDetector failed; falling back to jsQR", error);
  }

  try {
    return await decodeWithJSQR(canvas);
  } catch (error) {
    console.warn("jsQR decode failed", error);
    return [];
  }
}

function capturePreview(source, selection = null) {
  const canvas =
    source instanceof HTMLCanvasElement && !selection
      ? source
      : drawSourceToCanvas(source, selection);
  return canvas.toDataURL("image/png");
}

export { decodeFromSource, supportsBarcodeDetector, capturePreview };
