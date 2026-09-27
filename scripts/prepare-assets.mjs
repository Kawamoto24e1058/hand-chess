// MediaPipeのWASMとモデルを自前配信用にpublic/へ用意する (会場のWi-Fiが不安定でも動くように)
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const wasmSrc = "node_modules/@mediapipe/tasks-vision/wasm";
if (existsSync(wasmSrc)) {
  mkdirSync("public/mediapipe/wasm", { recursive: true });
  cpSync(wasmSrc, "public/mediapipe/wasm", { recursive: true });
  console.log("[assets] copied MediaPipe wasm");
}

const model = "public/models/hand_landmarker.task";
if (!existsSync(model)) {
  mkdirSync("public/models", { recursive: true });
  const url = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    writeFileSync(model, Buffer.from(await res.arrayBuffer()));
    console.log("[assets] downloaded hand_landmarker.task");
  } catch (e) {
    console.warn("[assets] モデルのダウンロードに失敗しました。手動で", url, "を", model, "に置いてください:", e.message);
  }
}
