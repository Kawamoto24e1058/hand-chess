<div align="center">

# ♞ Hand Chess

**つまんで、動かして、指す。**
Webカメラの前で親指と人差し指をつまむだけ。インストール不要、ブラウザだけで遊べる「手」で指すチェス。

[**▶ 遊んでみる**](https://hand-chess.momotech.workers.dev) &nbsp;·&nbsp; [GitHub](https://github.com/Kawamoto24e1058/hand-chess)

`MediaPipe` × `Stockfish (WASM)` × `Cloudflare Workers / Durable Objects` × `TypeScript`

</div>

---

## 特徴

- ✋ **手で操作**: MediaPipe Hand Landmarker で親指と人差し指の「つまむ」を検出し、駒を掴んで動かして離す。マウス/タッチでも遊べます。
- 🤖 **AI対戦**: Stockfish 16 (WASM) がブラウザの中で相手。強さは3段階。
- 👥 **二人対戦**: 同じPCで交代して指せます。
- 🌐 **オンライン対戦**: ランダムマッチ / 部屋コード・招待リンク / 持ち時間(5+3・3+2・10+0・無制限) / 投了・引き分け提案・再戦(先後交代) / 切断からの自動復帰。
- 🎯 **手の入力を安定させる工夫**: One Euro Filter、ヒステリシス、遅延補正、検出落ちの猶予、自動キャリブレーション。
- ✨ 疑似3D表示・効果音・演出。LT向けの解説表示(`E`キー)つき。
- 🔒 **プライバシー**: カメラ映像は端末内だけで処理し、送信・保存しません。サーバーへ送るのは名前と指し手だけです。

## 遊び方

1. スタート画面でモードを選び、カメラを許可します。
2. カメラの前に手を出します(映像の中央80%が盤全体に対応します)。
3. **親指と人差し指をつまむ**と駒を掴めます。行きたいマスで**指を開く**と置けます。
4. 掴みにくい時は「設定・ツール → キャリブレーション」で、開いた手とつまんだ手を2.5秒ずつ測って自分に合わせます。

| キー | 動作 |
|---|---|
| `C` | キャリブレーション |
| `E` | 解説表示(生の指先 vs フィルタ後の軌跡、ピンチ比グラフ) |
| `F` | One Euro Filter の ON/OFF |
| `D` | デバッグ表示(検出FPS、ピンチ比、閾値) |

## 手の入力のしくみ

ハンドトラッキングで「ボタン」を作るときの落とし穴と対策です。

| 課題 | 対策 |
|---|---|
| 生のランドマークは毎フレーム震える | **One Euro Filter**(遅い動きは強く平滑化、速い動きは遅れず追従) |
| 閾値1本だと境界で掴む/離すを繰り返す | **ヒステリシス**(掴む閾値 < 離す閾値)、離すは3フレーム連続で確定 |
| つまむ/離す動作の途中で指がずれる | **遅延補正**(動作の少し前の位置を使う) |
| 手の向きでピンチ比が変わる(縦だと掴めない) | 手のひらの幅と長さで正規化し、3D座標比と画像比の**小さい方**を採用 |
| 人・環境・向きで閾値が違う | 起動時の**キャリブレーション**で「開く/つまむ」を測って閾値を決定 |
| 検出が一瞬落ちて駒が変な所に置かれる | 400msの**猶予**。超えたら駒を元に戻す |

## 開発

```bash
git clone https://github.com/Kawamoto24e1058/hand-chess.git
cd hand-chess
npm install        # MediaPipeのWASM/モデルを public/ に用意します(postinstall)
npm run dev        # http://localhost:5173  (Worker + Durable Objects もローカルで動く)
```

```bash
npm run typecheck                                     # クライアント/Workerの型チェック
node scripts/e2e-server.mjs http://localhost:5173     # サーバーの結合テスト(dev起動中に実行。本番URLも指定可)
```

カメラは `localhost` かHTTPSでのみ使えます。

## デプロイ (Cloudflare)

Workers Static Assets(静的ファイル) + Durable Objects(部屋・マッチング)で動きます。

```bash
npx wrangler login   # 初回のみ
npm run deploy       # ビルド + wrangler deploy
```

### 自動デプロイ(GitHub Actions)

`main` へのpushで [.github/workflows/deploy.yml](.github/workflows/deploy.yml) が動き、型チェックの後にデプロイします。
リポジトリの **Settings → Secrets and variables → Actions** に次の2つを登録してください(未設定ならデプロイはスキップされます)。

| Secret | 内容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflareダッシュボードで作成したAPIトークン(「Edit Cloudflare Workers」テンプレートが使えます) |
| `CLOUDFLARE_ACCOUNT_ID` | CloudflareのアカウントID |

## 構成

```
src/client/   ブラウザ側
  app.ts        画面遷移・HUD          game.ts    対局の進行(モード/同期/演出)
  hand.ts       手・マウス入力          render.ts  盤・駒・演出の描画
  projection.ts 疑似3Dの投影/逆投影      net.ts     WebSocket(再接続つき)
  engine.ts     Stockfish (+フォールバック)  filter.ts  One Euro Filter
src/worker/   Cloudflare Worker
  room.ts       対局部屋 (Durable Object)   matchmaker.ts  ランダムマッチ
src/shared/   通信プロトコルの型
public/       Stockfish、(postinstallで)MediaPipeのWASMとモデル
legacy/       最初の1ファイル版プロトタイプ
scripts/      アセット準備、サーバー結合テスト
```

### 設計メモ

- **サーバーが唯一の正**: 指し手の合法性・持ち時間・勝敗は `GameRoom` が判定。クライアントは楽観的に反映し、不正なら再同期します。
- **時計**: 双方が1手ずつ指してから動き出します(カメラ準備の時間を奪わない)。時間切れ・切断負け(90秒)はDurable Objectのalarmで判定。
- **WebSocket Hibernation**: 待機中の部屋はメモリを解放しつつ接続を維持。状態はDOのストレージに保存され、再起動しても復元します。
- **席トークン**: タブごと(`sessionStorage`)。リロードや回線切れで同じ席に戻れ、別タブは別プレイヤーとして扱います。
- **自前配信**: MediaPipeのモデル・WASM、Stockfishは同じオリジンから配信するので、外部CDNに依存せず、会場のWi-Fiが不安定でも動きます。

## ライセンス

自身のコードは [MIT](LICENSE)。同梱の Stockfish.js は GPL-3.0 です。詳細は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
