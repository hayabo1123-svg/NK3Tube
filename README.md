# NK3Tube

YouTube風の動画視聴サービスです。API は `api.worker.js` を Node.js 向けに移植した `server.js` で動き、動画の再生には nkdlp の stream 抽出ロジックを組み込んでいます。

## 機能
- ホーム / 検索（すべて・動画・チャンネル・再生リスト）/ ショート
- 動画再生（画質切替・速度変更・関連動画・コメント）
- ダウンロード（映像＋音声 / 音声のみ）
- チャンネルページ（動画・ショート・ライブ・再生リスト、もっと見る）
- 登録チャンネル・履歴（ブラウザの localStorage に保存）

## ローカル起動
```
npm install   # 依存なし（任意）
npm start     # http://localhost:3000
```
Node.js 20 以上が必要です。

## Render にデプロイ
1. このフォルダを GitHub に push
2. Render で「New → Blueprint」を選び、リポジトリを指定（`render.yaml` を自動認識）
3. 必要なら環境変数 `YTDLP_BACKEND` / `YTDLP_BACKEND_TOKEN` を設定（nkdlp の `backend/server.py` を別途デプロイした場合のみ）

環境変数を設定しなければ、Innertube（ANDROID クライアント）で直接取得します。

## API
| エンドポイント | 内容 |
|---|---|
| `/api/v1/search?q=&type=video\|channel\|playlist&more=` | 検索 |
| `/api/v1/home` | おすすめ |
| `/api/v1/videos/:id` | 動画情報・関連動画 |
| `/api/v1/stream/:id` | 配信フォーマット一覧（nkdlp 互換） |
| `/api/v1/play/:id?itag=&dl=1` | 中継再生 / ダウンロード |
| `/api/v1/shorts`, `/api/v1/shorts/:id` | ショート |
| `/api/v1/channels/:id?tabs=videos,shorts,live,playlists&more=` | チャンネル |
| `/api/v1/comments/:id` | コメント |

## 注意
- YouTube の内部 API は仕様変更されることがあります。取得できなくなった場合は `server.js` の `clientVersion` などを更新してください。
- 利用は各サービス・著作権の規約に従ってください。
