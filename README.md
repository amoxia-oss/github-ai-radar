# GitHub AI Radar

GitHub上で急上昇しているAIツールを自動監視する、外部DB不要のダッシュボードです。

## できること

- AI関連リポジトリをGitHub Search APIから自動探索
- GitHubのStar履歴APIから「直近7日 / 30日」のStar増加を取得
- 総Star数だけではなく、Star増加・成長率・更新頻度を合成してTrend Scoreを算出
- Agents / Coding / MCP / RAG / Image / Video / Voice / Local AIなどに自動分類
- 前回順位との差分、新規TOP20、急上昇を検出
- 6時間ごとにGitHub Actionsで自動更新
- GitHub Pagesへ自動デプロイ
- 任意でChatworkへ急上昇通知

## 最短セットアップ

1. このフォルダ一式を新しいGitHubリポジトリへpushします。
2. GitHubの `Settings > Pages` で Source を `GitHub Actions` にします。
3. `Actions > GitHub AI Radar > Run workflow` を一度実行します。
4. 数分後、GitHub PagesのURLでダッシュボードを確認します。

GitHub API用の追加トークンは基本不要です。Workflowに自動発行される `GITHUB_TOKEN` を使います。

## Chatwork通知を有効にする

Repositoryの `Settings > Secrets and variables > Actions` に以下を登録します。

- `CHATWORK_API_TOKEN`: ChatworkのAPIトークン
- `CHATWORK_ROOM_ID`: 投稿先ルームID

未設定ならChatwork送信だけスキップされます。

## 監視条件の変更

`radar.config.json` を編集します。

主な項目:

- `maxCandidates`: Star履歴まで詳しく調べる最大件数
- `minStars`: 最低Star数
- `maxInactiveDays`: 最終pushから何日までを対象にするか
- `queries`: GitHub Search APIへ投げる検索条件
- `alerts`: Chatwork通知の閾値

`{RECENT_90}` は実行時に「90日前の日付」へ自動置換されます。

## Trend Score

順位は次の相対評価で算出します。

- 直近7日のStar増加: 45%
- 7日成長率: 20%
- 直近30日のStar増加: 15%
- 最終pushの新しさ: 10%
- 総Star数: 10%

これにより、古くからStarが多いだけのリポジトリより、「今まさに伸びているAIツール」を上位に出しやすくしています。

## ローカル確認

デモデータ生成:

```bash
node scripts/monitor.mjs --demo
```

静的サーバー:

```bash
python3 -m http.server 8080 -d docs
```

ブラウザで `http://localhost:8080` を開きます。

## 本番データをローカル取得

GitHub APIへ到達できる環境なら:

```bash
export GITHUB_TOKEN="your_token_if_needed"
node scripts/monitor.mjs
```

パブリックリポジトリは認証なしでも取得できますが、継続運用では認証を推奨します。
