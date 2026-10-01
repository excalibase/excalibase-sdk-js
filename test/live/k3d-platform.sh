#!/usr/bin/env bash
# Runs test/live.test.ts against a throwaway platform: platform-aio on k3d (the
# excalibase-service DR-drill install, published `main` images) behind the
# HAProxy edge the RKE2 install uses, reachable at http://localhost:$EDGE_PORT.
# A project is set up through the control plane (platform-setup.mjs), the live
# test runs with only the edge URL, the project id and a key, and the cluster
# is deleted whatever the outcome.
#
# Env: SERVICE_REPO (an excalibase-service checkout), STATE_DIR (a private
# directory), R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY (file storage; the
# nightly's bucket), optional CLUSTER (sdk-live), EDGE_PORT (18080),
# PROV_PORT (24095), IMAGE_TAG (main).
set -euo pipefail

SDK_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${SERVICE_REPO:?set SERVICE_REPO to an excalibase-service checkout}"
: "${STATE_DIR:?set STATE_DIR to a private directory}"
: "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
export CLUSTER=${CLUSTER:-sdk-live} STATE_DIR PROV_PORT=${PROV_PORT:-24095}
EDGE_PORT=${EDGE_PORT:-18080}
NS=excalibase-platform
HAPROXY_NS=haproxy-controller
# A kubeconfig of its own, so other clusters' contexts are left alone.
export KUBECONFIG="$STATE_DIR/kubeconfig"
source "$SERVICE_REPO/rke2/versions.env"

trap 'bash "$SERVICE_REPO/aio-e2e/dr-drill/k3d-down.sh"' EXIT

cat > "$STATE_DIR/haproxy.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
helm repo add haproxytech https://haproxytech.github.io/helm-charts > /dev/null 2>&1 || true
helm repo update haproxytech > /dev/null
helm upgrade --install haproxy haproxytech/kubernetes-ingress --version "$HAPROXY_CHART_VERSION" \\
  -n "$HAPROXY_NS" --create-namespace \\
  --set controller.kind=DaemonSet \\
  --set controller.daemonset.useHostPort=true \\
  --set controller.daemonset.hostPorts.stat=null \\
  --set controller.service.enabled=false \\
  --set controller.ingressClass=haproxy \\
  --set controller.ingressClassResource.name=haproxy \\
  --set-string 'controller.config.frontend-config-snippet=http-request del-header X-Forwarded-For' \\
  --wait --timeout 300s
EOF
chmod +x "$STATE_DIR/haproxy.sh"

K3D_CREATE_ARGS="-p ${EDGE_PORT}:80@server:0" \
AFTER_CLUSTER_HOOK="$STATE_DIR/haproxy.sh" \
HELM_EXTRA_ARGS="--set ingress.enabled=true --set ingress.className=haproxy --set ingress.host=localhost --set ingress.tls.enabled=false --set auth.edge.namespace=$HAPROXY_NS --set auth.edge.podLabels=app.kubernetes.io/name=kubernetes-ingress" \
  bash "$SERVICE_REPO/aio-e2e/dr-drill/k3d-up.sh"

echo "== file storage (R2) for provisioning"
kubectl create secret generic r2-creds -n "$NS" \
  --from-literal=access_key_id="$R2_ACCESS_KEY_ID" \
  --from-literal=secret_access_key="$R2_SECRET_ACCESS_KEY" \
  --from-literal=endpoint=https://ad5d71d4bbd5e5dd487fb471d72fb788.r2.cloudflarestorage.com \
  --from-literal=bucket=excalibase-backups --from-literal=region=auto
kubectl rollout restart deploy/provisioning -n "$NS"
kubectl rollout status deploy/provisioning -n "$NS" --timeout=300s
kill "$(cat "$STATE_DIR/port-forward.pid")" 2>/dev/null || true
kubectl port-forward -n "$NS" svc/provisioning "$PROV_PORT:24005" > "$STATE_DIR/port-forward.log" 2>&1 &
echo $! > "$STATE_DIR/port-forward.pid"
for _ in $(seq 1 30); do curl -sf "http://localhost:$PROV_PORT/healthz" > /dev/null && break; sleep 2; done

echo "== the edge answers on :$EDGE_PORT"
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$EDGE_PORT/auth/x/y/validate" -X POST || true)
  [ "$code" != 000 ] && [ "$code" != 503 ] && break
  sleep 2
done
echo "edge: /auth -> HTTP $code"

echo "== project"
PROVISIONING_URL="http://localhost:$PROV_PORT" ADMIN_PASSWORD_FILE="$STATE_DIR/admin-pass.txt" \
SDK_LIVE_URL="http://localhost:$EDGE_PORT" node "$SDK_ROOT/test/live/platform-setup.mjs" > "$STATE_DIR/live.json"

echo "== live test"
eval "$(jq -r 'to_entries[] | "export \(.key)=\(.value | @sh)"' "$STATE_DIR/live.json")"
cd "$SDK_ROOT" && npx jest test/live.test.ts --verbose
