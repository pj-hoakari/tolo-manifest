# tolo-manifest

TOLO の全サービスを Kubernetes で動かすための Kustomize の base を置く  
構成は [tolo](https://github.com/pj-hoakari/tolo) の compose（`task up` で起動する組み合わせと fake IdP）に合わせている  
Firebase のエミュレータは base に含めない。どの Firebase プロジェクトにつなぐかは overlay で決める  
クラスタごとの事情（namespace、公開経路、StorageClass、NetworkPolicy、Secret の実体）は base に含めず、取り込む側の overlay で足す

## 構成

- `base/`: サービスごとのディレクトリに、`<name>.<kind>.yaml` の形で 1 ファイル 1 リソースを置く
- `base/kustomization.yaml`: イメージのタグを `images` で固定する
- `overlays/local/`: ローカルのクラスタで base を確かめるための overlay

compose のサービス名 `server` は、Service 名 `service-gateway` に置き換えている  
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
| `tenant-access-token`、`graph-access-token`、`observation-access-token` | web（任意） |

DB のパスワードは `DATABASE_URL` にそのまま埋め込まれるので、URL で使える文字（16 進数など）だけで作る

base は Firebase の接続先を設定しないので、overlay が edge-bridge と web の env に足す  
edge-bridge は `FIRESTORE_PROJECT_ID` がないと起動しない  
`overlays/local` はエミュレータを置き、その接続先を patch で足している

observation の `OBSERVATION_PAGE_URL_TEMPLATE` はブラウザから見たホストを指すので、公開する環境では overlay で書き換える

fakeidp は、要求されたとおりの利用者と権限でトークンを発行する  
base はアクセスの制御を持たないので、公開する環境では overlay の側で入口を絞る

web は人数検出のモデルを `/app/public/models` から配信する。base はそこに空の `models` ボリュームを置くので、overlay がモデルを入れたボリュームに差し替える。web はこのディレクトリを起動時に読むので、モデルを入れ替えたら Pod を作り直す

Postgres の PVC は `storageClassName` を指定しないので、クラスタの既定の StorageClass が使われる

## イメージ

イメージ名は `ghcr.io/pj-hoakari/<compose のイメージ名>:sha-<コミットの先頭 7 桁>` とする  
ghcr に公開されているのは web のイメージだけで、tolo-web のリリースのたびに公開される  
ほかのサービスのイメージはまだ公開されていないので、現状はローカルでビルドしたイメージでしか動かない

## ローカルで確かめる

前提は Docker、Kubernetes のクラスタ（OrbStack など Docker のイメージをそのまま使えるもの）、[mise](https://mise.jdx.dev)、tolo リポジトリの checkout

```bash
mise install
task local:images TOLO_DIR=<tolo の checkout>
task local:check-images
task local:up
```

`task local:images` は tolo の compose でイメージをビルドし、base が使う名前のタグを付ける。web は、公開されたイメージを ghcr から取得する  
`task local:up` は Secret の材料を `overlays/local/` に一度だけ生成し、現在の kubectl の context に適用する

tolo の e2e スクリプトは、Service を port-forward すれば同じように使える

```bash
kubectl -n tolo port-forward svc/service-gateway 8080:8080 &
kubectl -n tolo port-forward svc/fakeidp 8082:8080 &
<tolo の checkout>/scripts/tenant-management-onboarding.sh
```
