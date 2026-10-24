# tolo-manifest

TOLO の全サービスを Kubernetes で動かすための Kustomize の base を置く  
構成は [tolo](https://github.com/pj-hoakari/tolo) の compose（`task up` で起動する組み合わせと fake IdP）に合わせている  
Firebase のエミュレータは base に含めない。どの Firebase プロジェクトにつなぐかは overlay で決める  
クラスタごとの事情（namespace、公開経路、StorageClass、NetworkPolicy、Secret の実体）は base に含めず、取り込む側の overlay で足す

## 構成

- `base/`: サービスごとのディレクトリに、`<name>.<kind>.yaml` の形で 1 ファイル 1 リソースを置く
- `base/kustomization.yaml`: イメージのタグを `images` で固定する
- `overlays/local/`: ローカルのクラスタで base を確かめるための overlay

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

web は人数検出のモデルを `/app/public/models` から配信する。base はそこに空の `models` ボリュームを置くので、overlay がモデルを入れたボリュームに差し替える。web はこのディレクトリを起動時に読むので、モデルを入れ替えたら Pod を作り直す

nats は JetStream を有効にした NATS を StatefulSet で置き、operation と observation が `nats://nats:4222` へ publish する  
ストリームは operation と observation が起動時に作る。保存期限は両方の `NATS_STREAM_MAX_AGE`（`24h`）で決まるので、変えるときは 2 つをそろえる  
push-relay（jetstream-http-push）は JetStream から読み、`base/push-relay/subscriptions.json` の購読ごとに受け口へ POST する。`guest-status` と `guest-messages` は guest、`realtime-delivery` は realtime へ届ける  
push-relay の durable consumer は、作ったあとに publish されたメッセージだけを届ける。push-relay が初めて起動するより前に publish されたメッセージは届かない  
NetworkPolicy で通信を絞る overlay は、operation、observation、push-relay から nats の 4222 への通信と、push-relay から guest と realtime の 8080 への通信を許す

Postgres と NATS の PVC は `storageClassName` を指定しないので、クラスタの既定の StorageClass が使われる

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
