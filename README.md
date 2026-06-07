# bokuraway

BMS (Beat Music Simulator) プレイヤーのための練習サポートデスクトップアプリ。[Bokutachi](https://boku.tachi.ac) のスコアデータをもとに、次に狙うべき譜面をレコメンドします。

## 機能

- **レコメンド** — CLEAR済みでHARD CLEARがまだの譜面、およびまだCLEARできていない譜面を難易度順に一覧表示
- **スコア一覧** — 全7K PBをランプ別にフィルタリングして表示
- **統計** — 難易度レベル × ランプの集計テーブル

## セットアップ

### 必要なもの

- [Node.js](https://nodejs.org/)
- Bokutachi アカウント
- Bokutachi の OAuth クライアント情報（[Bokutachi 管理画面](https://boku.tachi.ac/dashboard/developer)で取得）

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

`.env` を開き、Bokutachi 管理画面で取得した `CLIENT_ID` と `CLIENT_SECRET` を記入します。

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
|---|---|
| `main.js` | Electron メインプロセス。OAuthサーバー、Bokutachi API 呼び出し、IPC ハンドラ |
| `preload.js` | コンテキストブリッジ。`window.tachi` を renderer に公開 |
| `index.html` | レンダラー。HTML / CSS / JS をすべて含む単一ファイル |

ビルドステップなし。Electron がファイルを直接ロードします。

## ライセンス

MIT
