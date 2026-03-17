import "./jsqr.js";

const loadedJSQR = globalThis?.jsQR;

if (typeof loadedJSQR !== "function") {
  throw new Error("jsQR 未正确加载");
}

export default loadedJSQR;
