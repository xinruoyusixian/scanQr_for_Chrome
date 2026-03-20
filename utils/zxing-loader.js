import "./zxing.js";

const loadedZXing = globalThis?.ZXing;

if (!loadedZXing) {
  throw new Error("ZXing 未正确加载");
}

export default loadedZXing;
