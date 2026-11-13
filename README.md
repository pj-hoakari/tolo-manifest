# tolo-manifest

TOLO の全サービスを Kubernetes で動かすための Kustomize の base を置く  
構成は [tolo](https://github.com/pj-hoakari/tolo) の compose（`task up` で起動する組み合わせと fake IdP）に合わせている  
Firebase のエミュレータは base に含めない。どの Firebase プロジェクトにつなぐかは overlay で決める  
クラスタごとの事情（namespace、公開経路、StorageClass、NetworkPolicy、Secret の実体）は base に含めず、取り込む側の overlay で足す

## 構成

- `base/`: サービスごとのディレクトリに、`<name>.<kind>.yaml` の形で 1 ファイル 1 リソースを置く
- `base/kustomization.yaml`: イメージのタグを `images` で固定する
- `overlays/local/`: ローカルのクラスタで base を確かめるための overlay
- `components/idp/`: fakeidp の代わりに実物の IdP（tolo-idp）を production プロファイルで動かす Kustomize の component
- `overlays/local-idp/`: `overlays/local` に `components/idp` を重ねた overlay

compose のサービス名 `server` は Service 名 `service-gateway` に置き換えている  
それ以外のサービスは compose と同じ名前で互いを参照する

## overlay が用意するもの

base は Secret `tolo` を参照するが、作らない  
overlay は次のキーを持つ `tolo` を用意する

| キー | 使うサービス |
| --- | --- |
| `signing-key.pem` | service-gateway（内部 JWT の署名鍵。P-256 の EC 秘密鍵） |
| `introspection-client-secret` | service-gateway、fakeidp |
| `tenant-management-db-password` | tenant-management、tenant-management-db |
| `graph-authoring-db-password` | graph-authoring、graph-authoring-db |
| `observation-db-password` | observation、observation-db |
| `operation-db-password` | operation、operation-db |
| `guest-db-password` | guest、guest-db |
| `realtime-db-password` | realtime、realtime-db |

DB のパスワードは `DATABASE_URL` にそのまま埋め込まれるので、URL で使える文字（16 進数など）だけで作る

base は Firebase の接続先を設定しないので、overlay が edge-bridge、realtime、web の env に足す  
edge-bridge と realtime は `FIRESTORE_PROJECT_ID` がないと起動しない  
`overlays/local` はエミュレータを置き、その接続先を patch で足している

tenant-management の seed は固定のテナント（公開 ID `0123456789abcdef`）にサブドメイン `test` を付けて作る。web はこのテナントを `test.<ROOT_DOMAIN>` で開く。`ROOT_DOMAIN` は base で設定しないので、公開する環境では overlay で足す
サブドメインを変えるときは、`base/tenant-management/tenant-management.deployment.yaml` の seed の引数 `--set=tenant_subdomain=test` を書き換える

fakeidp は要求されたとおりの利用者と権限でトークンを発行する  
base はアクセスの制御を持たないので、公開する環境では overlay の側で入口を絞る

web は起動時に fakeidp から、固定のテナントとイベント（tenant-management の seed と同じ値）のトークンを発行して gateway に付ける。トークンの有効期限は 30 日とする  
fakeidp は起動のたびに署名鍵を作り直すので、fakeidp を作り直したときとトークンの期限が切れたときは web も作り直す

web は `AUTH_MOCKING=enabled` で動き、ログインの代わりにこの固定のトークンを使う  
`ROOT_DOMAIN` が `localhost` でもそのサブドメインでもないと web は起動しないので、公開する環境では overlay の `AUTH_MOCKING_ALLOWED_ROOT_DOMAINS` にそのドメインを足す。カンマで区切って複数書け、サブドメインも許される

web は人数検出のモデルを `/app/public/models` から配信する。base はそこに空の `models` ボリュームを置くので、overlay がモデルを入れたボリュームに差し替える。web はこのディレクトリを起動時に読むので、モデルを入れ替えたら Pod を作り直す

seed は Job で、固定のテナントとイベントに tolo-web のモックと同じ会場を作る。`base/seed/` の JSON は tolo-web の `src/mocks/fixtures` から写したもの  
作るのはグラフ、案内マップのレイアウト、QR の設置箇所 4 件、ゲストページの設定、エッジデバイス 3 台、ゲスト向けのメッセージ 2 件  
seed は一度も公開しておらず、seed が作ったもの以外のグラフもないイベントでだけ動き、最後にグラフを公開する。公開したあとの同期では何もしないので、コンソールで消したものや変えたものは戻らない  
途中で失敗したときは、次の実行が手順ごとに現在の状態を読み、ないものだけを作る。グラフは上書きしない。QR の設置箇所とエッジデバイスは名前で、メッセージは本文で、すでにあるかを判断する  
Argo CD は PostSync フックとして同期のたびに Job を作り直す。`task local:up` は適用の前に Job を消す  
guest は QR の設置箇所と案内マップを起動時と `RECONCILE_INTERVAL`（既定 10 分）ごとに取り込むので、seed のあとゲストページに出るまで最大でその時間がかかる  
NetworkPolicy で通信を絞る overlay は、seed から fakeidp と service-gateway の 8080 への通信を許す

nats は JetStream を有効にした NATS を StatefulSet で置き、operation と observation が `nats://nats:4222` へ publish する  
ストリームは operation と observation が起動時に作る。保存期限は両方の `NATS_STREAM_MAX_AGE`（`24h`）で決まるので、変えるときは 2 つをそろえる  
push-relay（jetstream-http-push）は JetStream から読み、`base/push-relay/subscriptions.json` の購読ごとに受け口へ POST する。`guest-status` と `guest-messages` は guest、`realtime-delivery` は realtime へ届ける  
push-relay の durable consumer は、作ったあとに publish されたメッセージだけを届ける。push-relay が初めて起動するより前に publish されたメッセージは届かない  
NetworkPolicy で通信を絞る overlay は、operation、observation、push-relay から nats の 4222 への通信と、push-relay から guest と realtime の 8080 への通信を許す

Postgres と NATS の PVC は `storageClassName` を指定しないので、クラスタの既定の StorageClass が使われる

## 実物の IdP に切り替える

`components/idp` は fakeidp の Deployment と Service、web の起動スクリプト `web-start` を消し、tolo-idp、その PostgreSQL と Redis、web の認証用の PostgreSQL（`web-auth-db`）を足す  
service-gateway と edge-bridge は tolo-idp のトークンを検証し、web は `AUTH_MOCKING=disabled` でログインに tolo-idp を使う  
seed の `token.mjs` を差し替え、seed のユーザーでログインしてから Token Exchange で `event_access` を取る  
固定のテナントのオーナー（`tolo-fixture` の `owner-sub`）は、seed のユーザーの ID（UUID）に置き換える

component を使う overlay は、次のものを用意する

ConfigMap `tolo-idp-public`

| キー | 内容 |
| --- | --- |
| `issuer` | IdP の issuer。ブラウザと service-gateway、web の Pod が同じ URL で届く必要がある |
| `web-origin` | web の `ROOT_DOMAIN` のオリジン。IdP のログイン画面、client の redirect URI、`/api/login` で許す Origin がここから決まる |

Secret `tolo-idp`

| キー | 使うもの |
| --- | --- |
| `jwk-private-key.pem` | tolo-idp（トークンの署名鍵。PKCS#8 の RSA 秘密鍵） |
| `seed-users.json` | tolo-idp、seed（seed のユーザー。`id` は `owner-sub`、`tenantId` は `tenant-id` と同じ値にする） |
| `idp-db-password` | tolo-idp、tolo-idp-db |
| `web-auth-db-password` | web、web-auth-db |
| `web-auth-secret` | web（better-auth の `AUTH_SECRET`） |
| `console-ui-client-secret` | tolo-idp、web、seed |
| `edge-page-client-secret` | tolo-idp、web |
| `observation-connection-client-secret` | tolo-idp、web |

tolo-idp の client `gateway-introspection` の secret には、Secret `tolo` の `introspection-client-secret` を使う  
client の定義は `components/idp/clients.yaml` にあり、redirect URI は `web-origin` から作る  
tolo-idp は seed のユーザーが DB の内容と食い違うと起動しないので、パスワードを変えたら tolo-idp-db のボリュームも作り直す

NetworkPolicy で通信を絞る overlay は、次の通信を許す

- service-gateway、edge-bridge、web、seed から tolo-idp の 8080
- tolo-idp から tenant-management の 8080、tolo-idp-db の 5432、tolo-idp-redis の 6379
- web から web-auth-db の 5432
- issuer がクラスタの外の URL なら、ingress から tolo-idp の 8080 と、service-gateway と web からその URL

## イメージ

イメージ名は `ghcr.io/pj-hoakari/<compose のイメージ名>:sha-<コミットの先頭 7 桁>` とする  
base のイメージは各リポジトリのリリースのときに ghcr へ公開される。fakeidp だけは tolo-service-gateway の `Publish fakeidp Image` ワークフローを手動で実行して公開する

## ローカルで確かめる

前提は Docker、Kubernetes のクラスタ（OrbStack など Docker のイメージをそのまま使えるもの）、[mise](https://mise.jdx.dev)、tolo リポジトリの checkout

```bash
mise install
task local:images TOLO_DIR=<tolo の checkout>
task local:check-images
task local:up
```

`task local:images` は base のイメージを ghcr から取得する。`overlays/local` だけで使う Firebase のエミュレータのイメージは公開していないので、tolo の compose で tolo の `firebase-emulator/`（本番相当のルール）からビルドし、overlay が参照する `ghcr.io/pj-hoakari/tolo-firebase-emulator:local` のタグを付ける  
`task local:up` は Secret の材料を `overlays/local/` に一度だけ生成し、現在の kubectl の context に適用する

tolo の e2e スクリプトは Service を port-forward すれば同じように使える

```bash
kubectl -n tolo port-forward svc/service-gateway 8080:8080 &
kubectl -n tolo port-forward svc/fakeidp 8082:8080 &
<tolo の checkout>/scripts/tenant-management-onboarding.sh
```

### 実物の IdP で確かめる

```bash
task local:images TOLO_DIR=<tolo の checkout>
task local-idp:up
task local-idp:forward
```

`task local-idp:up` は `overlays/local` の Secret の材料に加えて、`overlays/local-idp/` に IdP の Secret の材料を一度だけ生成する  
`task local-idp:forward` は IdP を `http://auth.tolo.localhost:18080`、web を `http://tolo.localhost` に転送する。macOS では、管理者権限なしに 80 番で待ち受けられるのは全インターフェースに向けたときだけなので、web は LAN からも届く  
ブラウザで `http://test.tolo.localhost` を開き、`overlays/local-idp/seed-users.json` のユーザー名とパスワードでログインする

issuer はブラウザと Pod で同じ URL にする必要がある。overlay は service-gateway と web の Pod で `auth.tolo.localhost` を 127.0.0.1 に向け、同じ Pod の socat が 127.0.0.1:18080 を tolo-idp へ中継する  
IdP の cookie は `__Host-` 付きで `Secure` なので、HTTP で試すときは `*.localhost` の名前を使う

`overlays/local` と `overlays/local-idp` は同じ namespace を使うので、切り替えるときは `task local:down` か `task local-idp:down` で先に消す
