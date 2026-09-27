# Third-party notices

このプロジェクト自身のコード(`src/`, `scripts/` など)は MIT ライセンスです([LICENSE](LICENSE))。
以下のサードパーティのコンポーネントは、それぞれのライセンスに従います。

## Stockfish.js 16 (GPL-3.0)

- 場所: `public/engine/stockfish-nnue-16-single.js`, `public/engine/stockfish-nnue-16-single.wasm`
- 出典: https://github.com/nmrugg/stockfish.js (npm: `stockfish@16.0.0`)
- ライセンス: GNU General Public License v3.0 — https://www.gnu.org/licenses/gpl-3.0.html
- 元になったプロジェクト: [Stockfish](https://github.com/official-stockfish/Stockfish) (GPL-3.0)、[stockfish.wasm](https://github.com/niklasf/stockfish.wasm)
- ソースコード: 上記リポジトリおよび npm パッケージで入手できます。

Stockfish は独立したWeb Worker(別プロセス相当)として動き、`postMessage` でUCIコマンドをやり取りするだけです。
Stockfish を含めて再配布する場合は、GPL-3.0 の条件(ソースの提供、ライセンス表示)に従ってください。

## MediaPipe Tasks Vision (Apache-2.0)

- npm: `@mediapipe/tasks-vision` — https://github.com/google-ai-edge/mediapipe
- Hand Landmarker のモデル(`hand_landmarker.task`)は Google が公開しているものを `npm install` 時にダウンロードします。

## chess.js (BSD-2-Clause)

- https://github.com/jhlywa/chess.js — ルール判定・PGN/FEN処理に使用。

## three.js (MIT)

- https://github.com/mrdoob/three.js — タイトル画面の3D背景に使用。

## WebXR generic hand model (W3C Software and Document License)

- 場所: `public/hand/right.glb`(タイトル画面の手の3Dモデル)
- 出典: https://github.com/immersive-web/webxr-input-profiles (`@webxr-input-profiles/assets` の `generic-hand`)
- ライセンス: [W3C Software and Document License](https://www.w3.org/copyright/software-license-2023/)
  Copyright © World Wide Web Consortium. https://www.w3.org/copyright/software-license-2023/
- モデルの骨(関節)を、コードで求めた位置・向きに合わせて動かしています。メッシュ自体は改変していません。
