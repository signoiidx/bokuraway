# bokuraway

- *bokura*: Japanese paraphrase of *boku-tachi*, meaning "us".
- *stairway*: the web tool for LR2IR.
- *bokuraway*: the desktop tool for Bokutachi IR.

Bokutachi IRユーザのための練習サポートデスクトップアプリ。[Bokutachi](https://boku.tachi.ac) のスコアデータをもとに、次に狙うべき譜面をレコメンドします。

## 機能

- 生成AIのパワーで試験的に追加した機能のため、今後人手で機能を検討し、変更予定あり。

  - **あと一歩ナッジ** — BP率をもとに「HARD CLEARが狙える」「EASY CLEARが狙える」譜面、スコア率をもとに「A/AA/AAAまであと少し」の譜面を達成が近い順にレコメンド
  - **レコメンド** — HARD CLEAR狙い(EASY CLEAR/CLEAR済みの譜面)とEASY CLEAR狙い(未クリアの譜面)を難易度順に一覧表示
  - **スコア一覧** — 全7K PBをランプ別にフィルタリングして表示
  - **統計** — 難易度レベル × ランプの集計テーブル

## セットアップ

### 必要なもの

- [Node.js](https://nodejs.org/)
- Bokutachi アカウント
- Bokutachi の OAuth クライアント情報（My Integrations - Service Integrations - My API Clientsで取得）

### インストール

```bash
git clone https://github.com/signoiidx/bokuraway.git
cd bokuraway
npm install
```

### 環境変数の設定

```bash
cp .env.example .env
```

`.env` を開き、Bokutachi Integrations My API Clientsで取得した `CLIENT_ID` と `CLIENT_SECRET` を記入します。

```env
CLIENT_ID=CIxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CLIENT_SECRET=CSxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 起動

```bash
npm start
```

起動後、ログインボタンを押すとブラウザが開き Bokutachi の OAuth 認証画面へ遷移します。認証が完了するとアプリに自動的に戻ります。

## 技術構成

| ファイル | 役割 |
| --- | --- |
| `main.js` | Electron メインプロセス。OAuthサーバ、Bokutachi API 呼び出し、IPC ハンドラ |
| `preload.js` | コンテキストブリッジ。`window.tachi` を renderer に公開 |
| `index.html` | レンダラ。HTML / CSS / JS をすべて含む単一ファイル |

ビルドステップなし。Electron がファイルを直接ロードします。

## ライセンス

The MIT License
