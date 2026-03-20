const BARCODE_FORMATS = ["qr_code"];
let detectorInstance = null;
let jsQRModulePromise = null;
let zxingModulePromise = null;

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

const MIN_SEGMENT_AREA = 200 * 200;
const MAX_SEGMENT_COUNT = 6;

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

function drawSourceWithFilter(source, selection, filter) {
  const width = selection?.width ?? calculateSourceWidth(source);
  const height = selection?.height ?? calculateSourceHeight(source);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.filter = filter;

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

  ctx.filter = "none";
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

async function ensureZXing() {
  if (zxingModulePromise) {
    return zxingModulePromise;
  }

  const loaderUrl = chrome.runtime.getURL("utils/zxing-loader.js");
  zxingModulePromise = import(loaderUrl).then((mod) => {
    const candidate = mod?.default ?? mod;
    if (!candidate) {
      throw new Error("ZXing export invalid");
    }
    return candidate;
  });

  return zxingModulePromise;
}

function toGrayscale(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    out[i] = y;
    out[i + 1] = y;
    out[i + 2] = y;
    out[i + 3] = 255;
  }
  return new ImageData(out, width, height);
}

function stretchContrast(grayscaleImageData) {
  const { data, width, height } = grayscaleImageData;
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max <= min) {
    return grayscaleImageData;
  }
  const scale = 255 / (max - min);
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.round((data[i] - min) * scale);
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return new ImageData(out, width, height);
}

function adaptiveBinarize(grayscaleImageData, blockSize = 8) {
  const { data, width, height } = grayscaleImageData;
  const out = new Uint8ClampedArray(data.length);
  const integral = new Uint32Array((width + 1) * (height + 1));

  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    const rowOffset = (y - 1) * width * 4;
    for (let x = 1; x <= width; x++) {
      const idx = rowOffset + (x - 1) * 4;
      rowSum += data[idx];
      const integralIdx = y * (width + 1) + x;
      integral[integralIdx] = integral[integralIdx - (width + 1)] + rowSum;
    }
  }

  const half = Math.max(Math.floor(blockSize / 2), 1);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(y - half, 0);
    const y1 = Math.min(y + half, height - 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(x - half, 0);
      const x1 = Math.min(x + half, width - 1);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);

      const idxA = y0 * (width + 1) + x0;
      const idxB = y0 * (width + 1) + (x1 + 1);
      const idxC = (y1 + 1) * (width + 1) + x0;
      const idxD = (y1 + 1) * (width + 1) + (x1 + 1);
      const sum = integral[idxD] - integral[idxB] - integral[idxC] + integral[idxA];
      const threshold = sum / area - 6;

      const srcIdx = (y * width + x) * 4;
      const value = data[srcIdx] > threshold ? 255 : 0;
      out[srcIdx] = value;
      out[srcIdx + 1] = value;
      out[srcIdx + 2] = value;
      out[srcIdx + 3] = 255;
    }
  }

  return new ImageData(out, width, height);
}

function invertImageData(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = 255 - data[i];
    out[i + 1] = 255 - data[i + 1];
    out[i + 2] = 255 - data[i + 2];
    out[i + 3] = 255;
  }
  return new ImageData(out, width, height);
}

function imageDataToCanvas(imageData) {
  const canvas = createCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function scaleCanvas(source, scale) {
  const width = Math.max(Math.round(source.width * scale), 1);
  const height = Math.max(Math.round(source.height * scale), 1);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function runJsQR(jsQR, imageData) {
  const { data, width, height } = imageData;
  const code = jsQR(data, width, height, {
    inversionAttempts: "attemptBoth"
  });
  return code ? [code.data] : [];
}

function runZXing(zxing, imageData) {
  const {
    RGBLuminanceSource,
    HybridBinarizer,
    BinaryBitmap,
    MultiFormatReader,
    DecodeHintType,
    BarcodeFormat
  } = zxing || {};

  if (!RGBLuminanceSource || !HybridBinarizer || !BinaryBitmap || !MultiFormatReader) {
    return [];
  }

  const source = new RGBLuminanceSource(imageData.data, imageData.width, imageData.height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  const reader = new MultiFormatReader();
  const hints = new Map();

  if (DecodeHintType?.POSSIBLE_FORMATS && BarcodeFormat?.QR_CODE) {
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
  }
  if (DecodeHintType?.TRY_HARDER) {
    hints.set(DecodeHintType.TRY_HARDER, true);
  }

  if (reader.setHints) {
    reader.setHints(hints);
  }

  try {
    const result = reader.decode(bitmap);
    const text = result?.getText ? result.getText() : result?.text;
    return text ? [text] : [];
  } catch {
    return [];
  }
}

function tryDecodeOnCanvas(jsQR, canvas) {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let result = runJsQR(jsQR, imageData);
  if (result.length) return result;

  const grayscale = toGrayscale(imageData);
  result = runJsQR(jsQR, grayscale);
  if (result.length) return result;

  const contrast = stretchContrast(grayscale);
  result = runJsQR(jsQR, contrast);
  if (result.length) return result;

  const bin = adaptiveBinarize(contrast, 8);
  result = runJsQR(jsQR, bin);
  if (result.length) return result;

  const inverted = invertImageData(bin);
  result = runJsQR(jsQR, inverted);
  return result;
}

function tryDecodeZXingOnCanvas(zxing, canvas) {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let result = runZXing(zxing, imageData);
  if (result.length) return result;

  const grayscale = toGrayscale(imageData);
  result = runZXing(zxing, grayscale);
  if (result.length) return result;

  const contrast = stretchContrast(grayscale);
  result = runZXing(zxing, contrast);
  if (result.length) return result;

  const bin = adaptiveBinarize(contrast, 8);
  result = runZXing(zxing, bin);
  if (result.length) return result;

  const inverted = invertImageData(bin);
  result = runZXing(zxing, inverted);
  return result;
}

function buildDetectionCandidates(source, selection, baseCanvas) {
  const candidates = [baseCanvas];
  try {
    const boosted = drawSourceWithFilter(
      source,
      selection,
      "contrast(180%) saturate(0%) brightness(105%)"
    );
    candidates.push(boosted);
  } catch {
    // Ignore filter failures.
  }

  try {
    const ctx = baseCanvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, baseCanvas.width, baseCanvas.height);
    const grayscale = toGrayscale(imageData);
    const contrast = stretchContrast(grayscale);
    const bin = adaptiveBinarize(contrast, 8);
    candidates.push(imageDataToCanvas(bin));
  } catch {
    // Ignore image data failures.
  }

  return candidates;
}

function normalizeResultValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value && typeof value === "object") {
    const candidate =
      typeof value.rawValue === "string"
        ? value.rawValue
        : typeof value.text === "string"
        ? value.text
        : null;
    if (candidate) {
      const trimmed = candidate.trim();
      return trimmed || null;
    }
  }
  return null;
}

function addResultsToSet(target, items) {
  if (!items) {
    return;
  }
  if (!Array.isArray(items)) {
    const normalized = normalizeResultValue(items);
    if (normalized) {
      target.add(normalized);
    }
    return;
  }
  for (const item of items) {
    const normalized = normalizeResultValue(item);
    if (normalized) {
      target.add(normalized);
    }
  }
}

async function runBarcodeDetectorOnCandidates(candidates, resultSet) {
  if (!supportsBarcodeDetector()) {
    return;
  }
  for (const candidate of candidates) {
    try {
      const detected = await detectWithBarcodeDetector(candidate);
      addResultsToSet(resultSet, detected);
    } catch (error) {
      console.warn("BarcodeDetector candidate failed", error);
    }
  }
}

function splitAxis(total, parts) {
  const limit = Math.max(Math.round(total), 1);
  const ranges = [];
  for (let i = 0; i < parts; i++) {
    const start = Math.floor((limit * i) / parts);
    const end = i === parts - 1 ? limit : Math.floor((limit * (i + 1)) / parts);
    ranges.push({ start, length: Math.max(1, end - start) });
  }
  return ranges;
}

async function scanGridSegments(source, selection, resultSet) {
  try {
    const width = selection?.width ?? calculateSourceWidth(source);
    const height = selection?.height ?? calculateSourceHeight(source);
    if (!width || !height) {
      return;
    }
    if (width * height < MIN_SEGMENT_AREA) {
      return;
    }

    let rows = 2;
    let cols = 3;
    const aspect = width / height;
    if (aspect > 1.6) {
      rows = 1;
      cols = 4;
    } else if (aspect < 0.6) {
      rows = 4;
      cols = 1;
    }

    while (rows * cols > MAX_SEGMENT_COUNT) {
      if (cols > rows) {
        cols -= 1;
      } else {
        rows -= 1;
      }
    }

    const xRanges = splitAxis(width, cols);
    const yRanges = splitAxis(height, rows);
    const offsetX = selection?.x ?? 0;
    const offsetY = selection?.y ?? 0;

    for (const yRange of yRanges) {
      for (const xRange of xRanges) {
        const rect = {
          x: offsetX + xRange.start,
          y: offsetY + yRange.start,
          width: xRange.length,
          height: yRange.length
        };
        if (rect.width < 64 || rect.height < 64) {
          continue;
        }
        const canvas = drawSourceToCanvas(source, rect);
        const zxingResults = await decodeWithZXing(canvas);
        addResultsToSet(resultSet, zxingResults);
        const jsqrResults = await decodeWithJSQR(canvas);
        addResultsToSet(resultSet, jsqrResults);
      }
    }
  } catch (error) {
    console.warn("Segment scanning failed", error);
  }
}


function getChannelMask(imageData, channel, factor = 0.85) {
  const { data, width, height } = imageData;
  const mask = new Uint8ClampedArray(width * height);
  let sum = 0;
  const len = data.length;
  const getValue = (idx) => {
    if (channel === "luminance") {
      return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }
    const mapping = { r: 0, g: 1, b: 2 };
    return data[idx + mapping[channel]];
  };
  for (let i = 0; i < len; i += 4) {
    sum += getValue(i);
  }
  const avg = sum / (width * height || 1);
  const threshold = Math.max(Math.min(avg * factor, 240), 28);
  let idx = 0;
  for (let i = 0; i < len; i += 4) {
    const value = getValue(i);
    mask[idx++] = value < threshold ? 1 : 0;
  }
  return mask;
}

function getBinaryMask(imageData) {
  const masks = [
    getChannelMask(imageData, "r", 0.95),
    getChannelMask(imageData, "g", 0.9),
    getChannelMask(imageData, "b", 0.9),
    getChannelMask(imageData, "luminance", 0.78)
  ];
  const { width, height } = imageData;
  const combined = new Uint8ClampedArray(width * height);
  for (let i = 0; i < combined.length; i++) {
    combined[i] = masks.some((mask) => mask[i]) ? 1 : 0;
  }
  return { mask: combined, width, height };
}

function dilateMask(mask, width, height) {
  const result = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const baseIdx = y * width + x;
      let found = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const ny = y + offsetY;
        if (ny < 0 || ny >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const nx = x + offsetX;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx]) {
            found = 1;
            break;
          }
        }
        if (found) break;
      }
      result[baseIdx] = found;
    }
  }
  return result;
}

function erodeMask(mask, width, height) {
  const result = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const baseIdx = y * width + x;
      let solid = 1;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const ny = y + offsetY;
        if (ny < 0 || ny >= height) {
          solid = 0;
          break;
        }
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const nx = x + offsetX;
          if (nx < 0 || nx >= width || mask[ny * width + nx] === 0) {
            solid = 0;
            break;
          }
        }
        if (!solid) break;
      }
      result[baseIdx] = solid;
    }
  }
  return result;
}

function closingMask(mask, width, height) {
  const dilated = dilateMask(mask, width, height);
  return erodeMask(dilated, width, height);
}

function findComponents(mask, width, height) {
  const visited = new Uint8ClampedArray(mask);
  const components = [];
  const stack = [];
  for (let idx = 0; idx < visited.length; idx++) {
    if (!visited[idx]) {
      continue;
    }
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    stack.push(idx);
    visited[idx] = 0;
    while (stack.length) {
      const current = stack.pop();
      const cy = Math.floor(current / width);
      const cx = current - cy * width;
      area += 1;
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy);
      maxY = Math.max(maxY, cy);
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const ny = cy + offsetY;
        if (ny < 0 || ny >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const nx = cx + offsetX;
          if (nx < 0 || nx >= width) continue;
          const neighborIdx = ny * width + nx;
          if (visited[neighborIdx]) {
            visited[neighborIdx] = 0;
            stack.push(neighborIdx);
          }
        }
      }
    }
    components.push({ minX, minY, maxX, maxY, area });
  }
  return components;
}

function centroidFromComponent(component) {
  const x = (component.minX + component.maxX) / 2;
  const y = (component.minY + component.maxY) / 2;
  const size = Math.max(component.maxX - component.minX, component.maxY - component.minY) + 1;
  return { x, y, size };
}

function scoreFinderPattern(component, width, height) {
  const boxWidth = component.maxX - component.minX + 1;
  const boxHeight = component.maxY - component.minY + 1;
  const aspect = Math.min(boxWidth, boxHeight) / Math.max(boxWidth, boxHeight);
  const area = component.area;
  const squareArea = boxWidth * boxHeight || 1;
  const fillRatio = Math.min(area / squareArea, 1);
  const centerDist =
    Math.hypot(component.minX + boxWidth / 2 - width / 2, component.minY + boxHeight / 2 - height / 2);
  const locationWeight = 1 - Math.min(centerDist / Math.hypot(width, height), 1);
  const normalizedArea = Math.min(area / (width * height), 1);
  return aspect * 0.2 + fillRatio * 0.2 + locationWeight * 0.2 + normalizedArea * 0.4;
}

function pickBestTriple(candidates) {
  if (candidates.length < 3) {
    return null;
  }
  let best = null;
  let bestScore = 0;
  const combos = [];
  for (let i = 0; i < candidates.length - 2; i++) {
    for (let j = i + 1; j < candidates.length - 1; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        combos.push([candidates[i], candidates[j], candidates[k]]);
      }
    }
  }
  for (const triplet of combos) {
    const [a, b, c] = triplet;
    const area =
      Math.abs(
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
      ) / 2;
    const avgScore = (a.score + b.score + c.score) / 3;
    const combinedScore = area * avgScore;
    if (combinedScore > bestScore) {
      bestScore = combinedScore;
      best = triplet;
    }
  }
  return best;
}

function computeHomography(src, dst) {
  const matrix = [];
  const values = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    values.push(u);
    matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    values.push(v);
  }
  const solution = solveLinearSystem(matrix, values);
  if (!solution) {
    return null;
  }
  const [h11, h12, h13, h21, h22, h23, h31, h32] = solution;
  return [h11, h12, h13, h21, h22, h23, h31, h32, 1];
}

function solveLinearSystem(matrix, values) {
  const n = matrix.length;
  if (n === 0) {
    return null;
  }
  const mat = matrix.map((row) => row.slice());
  const vec = values.slice();
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(mat[j][i]) > Math.abs(mat[pivot][i])) {
        pivot = j;
      }
    }
    if (Math.abs(mat[pivot][i]) < 1e-9) {
      return null;
    }
    if (pivot !== i) {
      [mat[i], mat[pivot]] = [mat[pivot], mat[i]];
      [vec[i], vec[pivot]] = [vec[pivot], vec[i]];
    }
    const divisor = mat[i][i];
    for (let k = i; k < n; k++) {
      mat[i][k] /= divisor;
    }
    vec[i] /= divisor;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const factor = mat[j][i];
      for (let k = i; k < n; k++) {
        mat[j][k] -= factor * mat[i][k];
      }
      vec[j] -= factor * vec[i];
    }
  }
  return vec;
}

function applyHomographyMatrix(matrix, x, y) {
  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = matrix;
  const denom = h31 * x + h32 * y + h33;
  if (denom === 0) {
    return { x: 0, y: 0 };
  }
  const u = (h11 * x + h12 * y + h13) / denom;
  const v = (h21 * x + h22 * y + h23) / denom;
  return { x: u, y: v };
}

function bilinearSample(srcData, srcWidth, srcHeight, x, y) {
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  const fx = clamp(x, 0, srcWidth - 1);
  const fy = clamp(y, 0, srcHeight - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, srcWidth - 1);
  const y1 = Math.min(y0 + 1, srcHeight - 1);
  const dx = fx - x0;
  const dy = fy - y0;
  const idx00 = (y0 * srcWidth + x0) * 4;
  const idx10 = (y0 * srcWidth + x1) * 4;
  const idx01 = (y1 * srcWidth + x0) * 4;
  const idx11 = (y1 * srcWidth + x1) * 4;
  const output = [0, 0, 0, 255];
  for (let channel = 0; channel < 3; channel++) {
    const c00 = srcData[idx00 + channel];
    const c10 = srcData[idx10 + channel];
    const c01 = srcData[idx01 + channel];
    const c11 = srcData[idx11 + channel];
    const interp =
      c00 * (1 - dx) * (1 - dy) +
      c10 * dx * (1 - dy) +
      c01 * (1 - dx) * dy +
      c11 * dx * dy;
    output[channel] = interp;
  }
  return output;
}

function warpPerspectiveCanvas(sourceCanvas, quadruple, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  const srcPts = quadruple.src.map((pt) => [pt.x, pt.y]);
  const dstPts = [
    [0, 0],
    [size - 1, 0],
    [0, size - 1],
    [size - 1, size - 1]
  ];
  const matrix = computeHomography(srcPts, dstPts);
  if (!matrix) {
    return null;
  }
  const srcCtx = sourceCanvas.getContext("2d");
  if (!srcCtx) {
    return null;
  }
  const srcImageData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const srcData = srcImageData.data;
  const destData = ctx.createImageData(size, size);
  const destBuffer = destData.data;
  let ptr = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mapped = applyHomographyMatrix(matrix, x, y);
      const sample = bilinearSample(srcData, sourceCanvas.width, sourceCanvas.height, mapped.x, mapped.y);
      destBuffer[ptr++] = sample[0];
      destBuffer[ptr++] = sample[1];
      destBuffer[ptr++] = sample[2];
      destBuffer[ptr++] = 255;
    }
  }
  ctx.putImageData(destData, 0, 0);
  return canvas;
}

function detectFinderPatterns(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { mask, width, height } = getBinaryMask(imageData);
  const closed = closingMask(mask, width, height);
  const components = findComponents(closed, width, height);
  components.sort((a, b) => b.area - a.area);
  const minArea = Math.max(256, (Math.min(width, height) * 0.08) ** 2);
  const filtered = components.filter((comp) => comp.area >= minArea);
  if (filtered.length < 3) {
    return null;
  }
  const centers = filtered.slice(0, 8).map((comp) => {
    const centroid = centroidFromComponent(comp);
    centroid.score = scoreFinderPattern(comp, width, height);
    return centroid;
  });
  const triple = pickBestTriple(centers);
  return orderCornerPoints(triple);
}

async function decodeWithJSQR(canvas) {
  const jsQR = await ensureJSQR();
  const width = canvas.width;
  const height = canvas.height;

  let result = tryDecodeOnCanvas(jsQR, canvas);
  if (result.length) return result;

  const maxSide = Math.max(width, height);
  if (maxSide < 600) {
    const scaledUp = scaleCanvas(canvas, 2);
    result = tryDecodeOnCanvas(jsQR, scaledUp);
    if (result.length) return result;
  }

  if (maxSide > 1600) {
    const scaledDown = scaleCanvas(canvas, 0.5);
    result = tryDecodeOnCanvas(jsQR, scaledDown);
    if (result.length) return result;
  }

  return [];
}

async function decodeWithZXing(canvas) {
  const zxing = await ensureZXing();
  const width = canvas.width;
  const height = canvas.height;

  let result = tryDecodeZXingOnCanvas(zxing, canvas);
  if (result.length) return result;

  const maxSide = Math.max(width, height);
  if (maxSide < 600) {
    const scaledUp = scaleCanvas(canvas, 2);
    result = tryDecodeZXingOnCanvas(zxing, scaledUp);
    if (result.length) return result;
  }

  if (maxSide > 1600) {
    const scaledDown = scaleCanvas(canvas, 0.5);
    result = tryDecodeZXingOnCanvas(zxing, scaledDown);
    if (result.length) return result;
  }

  return [];
}

async function detectWithBarcodeDetector(source) {
  const detector = await ensureDetector();
  if (!detector) {
    throw new Error("BarcodeDetector is not available.");
  }

  const results = await detector.detect(source);
  return results.map((item) => item.rawValue).filter(Boolean);
}

async function detectAndWarpWithFinder(canvas) {
  const cornerQuad = detectFinderPatterns(canvas);
  if (!cornerQuad) {
    return null;
  }
  return warpPerspectiveCanvas(canvas, cornerQuad, cornerQuad.size);
}

async function decodeFromSource(source, selection = null) {
  const canvas = source instanceof HTMLCanvasElement && !selection ? source : drawSourceToCanvas(source, selection);

  const resultSet = new Set();

  try {
    if (!selection && source && supportsBarcodeDetector()) {
      const direct = await detectWithBarcodeDetector(source);
      addResultsToSet(resultSet, direct);
    }

    const candidates = buildDetectionCandidates(source, selection, canvas);
    await runBarcodeDetectorOnCandidates(candidates, resultSet);
  } catch (error) {
    console.warn("BarcodeDetector failed; falling back to other scanners", error);
  }

  try {
    const corrected = await detectAndWarpWithFinder(canvas);
    if (corrected) {
      const zxingResults = await decodeWithZXing(corrected);
      addResultsToSet(resultSet, zxingResults);
      const jsqrResults = await decodeWithJSQR(corrected);
      addResultsToSet(resultSet, jsqrResults);
    }
  } catch (error) {
    console.warn("Finder correction failed", error);
  }

  try {
    const zxingResults = await decodeWithZXing(canvas);
    addResultsToSet(resultSet, zxingResults);
  } catch (error) {
    console.warn("ZXing decode failed", error);
  }

  try {
    const jsqrResults = await decodeWithJSQR(canvas);
    addResultsToSet(resultSet, jsqrResults);
  } catch (error) {
    console.warn("jsQR decode failed", error);
  }

  await scanGridSegments(source, selection, resultSet);

  return Array.from(resultSet);
}

function capturePreview(source, selection = null) {
  const canvas =
    source instanceof HTMLCanvasElement && !selection
      ? source
      : drawSourceToCanvas(source, selection);
  return canvas.toDataURL("image/png");
}

export { decodeFromSource, supportsBarcodeDetector, capturePreview };
