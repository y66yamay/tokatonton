# tokatonton

共同研究者との日程調整に使う、シンプルな予定調整 Web アプリです。

- 幹事が候補日時を作り、URL を共有するだけ（参加者はログイン不要）
- 参加者は候補ごとに ○ / △ / × とコメントを回答
- 集計表で ○ の多い候補がひと目でわかる
- 幹事用 URL から、イベントの編集・日程の確定・回答の削除・イベントの削除
- 回答締切日を設定すると、締切後は回答できなくなる

画面は GitHub Pages、データは Supabase（PostgreSQL）に保存します。
ビルドや外部ライブラリは使っていません（HTML / CSS / JavaScript のみ）。

## ファイル構成

```
docs/                     GitHub Pages で公開する画面
  index.html              イベントの作成・編集
  event.html              回答状況・回答の入力・幹事メニュー
  css/style.css
  js/config.js            Supabase の接続設定（要設定）
  js/api.js               Supabase の関数を呼び出す処理
  js/util.js              共通処理（DOM・日付・URL など）
  js/candidate-editor.js  候補日時の入力部品（カレンダー）
  js/create.js            index.html の処理
  js/event.js             event.html の処理
supabase/schema.sql       データベースの定義（テーブルと関数）
```

## セットアップ

### 1. Supabase のプロジェクトを作る

1. https://supabase.com でアカウントを作り、「New project」でプロジェクトを作成します。
   - Region は日本から使うなら「Northeast Asia (Tokyo)」がおすすめです。
   - Database Password は自分で控えておいてください（このアプリでは使いません）。
2. 左メニューの「SQL Editor」を開き、`supabase/schema.sql` の内容をすべて貼り付けて「Run」を押します。
   - 「Success. No rows returned」と出れば完了です。
   - 何度実行しても問題ありません（既存のデータは消えません）。

### 2. 接続設定を書く

1. Supabase の「Project Settings」→「API Keys」（または画面上部の「Connect」）を開きます。
2. 次の 2 つを `docs/js/config.js` に貼り付けます。
   - **Project URL**（`https://xxxx.supabase.co`）→ `SUPABASE_URL`
   - **Publishable key**（`sb_publishable_...`）→ `SUPABASE_KEY`
     （旧形式の `anon` `public` キー `eyJ...` でも動きます）

```js
export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_KEY = "sb_publishable_xxxxxxxx";
```

> このキーはブラウザに公開される前提のもので、GitHub に置いても問題ありません。
> テーブルへの直接アクセスは禁止してあり、決められた関数経由でしか操作できません。
> **`secret` キーや `service_role` キーは絶対に書かないでください。**

3. 変更をコミットして GitHub に push します。

### 3. GitHub Pages で公開する

1. GitHub のリポジトリの「Settings」→「Pages」を開きます。
2. 「Build and deployment」の Source を「Deploy from a branch」にし、
   Branch を `main`、フォルダを `/docs` にして「Save」を押します。
3. 1〜2 分待つと `https://<ユーザー名>.github.io/tokatonton/` で公開されます。

> 無料プランの GitHub では、GitHub Pages を使うにはリポジトリを **Public** にする必要があります。
> （Private のまま公開するには GitHub Pro などの有料プランが必要です）

## 使い方

1. トップページでタイトル・候補日時などを入れて「イベントを作成」。
2. 表示された 2 つの URL を保存します。
   - **参加者に送る URL**: 共同研究者にメールなどで送ります。
   - **幹事用 URL**: 自分だけが持っておきます。なくすと再発行できません
     （作成したブラウザでは、トップページの「このブラウザで作成したイベント」から開けます）。
3. 参加者は URL を開いて「回答する」から回答します。名前を押すと回答を修正できます。
4. 幹事は幹事用 URL を開き、集計表の「確定」ボタンで日程を確定します。

## 注意点

- **URL を知っている人は誰でも回答の追加・修正ができます。** 参加者用 URL は関係者だけに共有してください。
- 回答の削除は幹事だけができます。
- 日時はすべて日本時間として扱います。
- Supabase の無料プランは、**1 週間アクセスがないとプロジェクトが一時停止**します。
  停止したら Supabase のダッシュボードから「Restore」で再開できます（データは残ります）。
- 不要になったイベントは、幹事用 URL の「イベントを削除」で削除できます。

## データベースの構成

| テーブル | 内容 |
| --- | --- |
| `events` | イベント（タイトル、説明、締切日、確定した候補、幹事トークンのハッシュ） |
| `candidates` | 候補日時（日付、開始時刻、終了時刻） |
| `responses` | 回答者（名前、コメント） |
| `answers` | 回答者 × 候補ごとの ○△×（`yes` / `maybe` / `no`） |

画面から呼ぶ関数: `create_event`, `get_event`, `save_response`, `check_admin`,
`update_event`, `decide_event`, `delete_response`, `delete_event`
（`[幹事]` の付いた操作は幹事トークンが必要です。詳しくは `supabase/schema.sql` を参照）
