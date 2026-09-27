import "./style.css";
import { App } from "./app";

const app = new App();
// 開発時だけ: ブラウザのコンソールから入力を擬似的に注入して、手の3D表示などを確認できるようにする
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
