#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  kairu-kit 공용 배포 — 따릉이 EC2 공용 서버에 앱 하나 추가/업데이트
#  (subway-app/deploy.sh 를 앱 이름·포트를 app.config 로 뺀 범용 버전)
#
#  프로젝트 루트에 두는 파일:
#     deploy.sh               ← 이 파일 (고칠 필요 없음)
#     app.config              ← 앱 이름·포트 등 (이것만 고치기)
#     scripts/auto-update.sh  ← 5분마다 GitHub 새 커밋 자동 배포
#     scripts/gen-vapid.js    ← 푸시 쓰면
#
#  사용법 (서버의 프로젝트 폴더 안에서):   bash deploy.sh
#  다시 실행해도 안전합니다 (업데이트용)
#
#  하는 일:
#   1) .env 작성 (app.config 의 ASK_ENV 값, VAPID 키 자동 생성)
#   2) npm 패키지 설치
#   3) systemd 서비스 등록 (재부팅 시 자동 실행) + 5분마다 자동 배포 타이머
#   4) Caddy 에 이 앱 설정 파일만 추가 → https://<APP_NAME>.<IP>.sslip.io
#
#  내 도메인 쓰기 (예: chess.yplue.com):
#     저장소 루트의 deploy.domain 파일에 도메인 한 줄을 적어 커밋
#     → Cloudflare DNS 에 A 레코드(이 서버 IP, 회색 구름 = DNS only)가 잡히면 자동으로 전환
#     → 아직이면 sslip 주소로 계속 운영하고, 5분마다 자동 업데이트가 다시 확인
#     → 전환 뒤에도 예전 sslip 주소(보낸 링크·설치한 앱)는 계속 열림
#
#  다른 앱(따릉이 등)은 건드리지 않습니다. (/etc/caddy/sites/<APP_NAME>.caddy 만 수정)
#  서버에 Node·Caddy 가 처음 깔리는 건 따릉이 deploy.sh 가 담당 (최초 1회)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="$(id -un)"

c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_red=$'\e[31m'; c_bold=$'\e[1m'; c_off=$'\e[0m'
step() { echo; echo "${c_bold}${c_green}▶ $*${c_off}"; }
warn() { echo "${c_yellow}⚠️  $*${c_off}"; }
die()  { echo "${c_red}❌ $*${c_off}" >&2; exit 1; }

# ── 설정 읽기 ─────────────────────────────────────────────────
[[ -f "$APP_DIR/app.config" ]] || die "app.config 가 없습니다. kairu-kit/deploy/app.config 를 복사해서 고치세요."
HEALTH_PATH="/api/status"; ENTRY="server.js"; MEMORY_MAX="200M"; USE_PUSH=0; ASK_ENV=()
# shellcheck disable=SC1091
source "$APP_DIR/app.config"
[[ "${APP_NAME:-}" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "app.config 의 APP_NAME 은 영문 소문자로 (예: myapp)"
[[ "${PORT:-}" =~ ^[0-9]+$ ]] || die "app.config 의 PORT 를 숫자로 정하세요"
[[ "$APP_NAME" != "myapp" ]] || die "app.config 의 APP_NAME 을 이 앱 이름으로 바꾸세요"

# ── 사전 확인 ─────────────────────────────────────────────────
[[ -f "$APP_DIR/$ENTRY" ]] || die "$ENTRY 가 없습니다. 프로젝트 폴더 안에서 실행하세요."
[[ "$(id -u)" -ne 0 ]] || die "root 말고 일반 사용자(ubuntu)로 실행하세요."
sudo -n true 2>/dev/null || die "비밀번호 없이 sudo 를 쓸 수 있어야 합니다."
command -v node >/dev/null || die "Node.js 가 없습니다. 따릉이 알리미를 먼저 배포하세요."
command -v npm  >/dev/null || die "npm 이 없습니다. 따릉이 알리미를 먼저 배포하세요."
command -v caddy >/dev/null || die "Caddy 가 없습니다. 따릉이 알리미를 먼저 배포하세요."

# 다른 앱이 같은 포트를 쓰고 있지 않은지 (이 앱 자신은 제외)
for f in /etc/systemd/system/*.service; do
  [[ -f "$f" ]] || continue
  if grep -qE "^WorkingDirectory=" "$f"; then
    other_dir=$(grep -E "^WorkingDirectory=" "$f" | cut -d= -f2-)
    [[ "$other_dir" != "$APP_DIR" ]] || continue   # 이 앱 자신(서비스·업데이트 타이머)은 제외
    other_port=$(grep -E "^PORT=" "$other_dir/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)
    [[ "$other_port" != "$PORT" ]] || die "포트 $PORT 는 $(basename "$f" .service) 가 이미 사용 중입니다. app.config 의 PORT 를 바꾸세요."
  fi
done

exec 9>"/tmp/${APP_NAME}-deploy.lock"
flock -w 600 9 || die "다른 배포가 진행 중입니다. 잠시 후 다시 시도하세요."

ENV_FILE="$APP_DIR/.env"
set_env() {
  local key="$1" val="$2"
  touch "$ENV_FILE"
  if grep -qE "^#?\s*${key}=" "$ENV_FILE"; then
    local esc; esc=$(printf '%s' "$val" | sed -e 's/[\/&|]/\\&/g')
    sed -i -E "s|^#?\s*${key}=.*|${key}=${esc}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
get_env() { grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
ask() {
  local q="$1" def="${2:-}" ans=""
  if [[ -t 0 ]]; then read -r -p "$q" ans || true; fi
  echo "${ans:-$def}"
}

# ── 1. 환경설정 ───────────────────────────────────────────────
step "1/4 환경설정 (.env) — ${APP_TITLE:-$APP_NAME}"
echo "  Node $(node -v)"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

for item in "${ASK_ENV[@]}"; do
  key="${item%%|*}"; question="${item#*|}"
  val="${!key:-$(get_env "$key")}"
  [[ -n "$val" ]] || val=$(ask "  ${question}: " "")
  val="$(echo -n "$val" | tr -d '[:space:]')"
  set_env "$key" "$val"
  [[ -n "$val" ]] || warn "$key 가 비어 있습니다. 나중에 .env 에 넣고 재시작하세요."
done
set_env PORT "$PORT"
set_env HOST "127.0.0.1"   # 외부에서는 Caddy(443)로만 접속
set_env NODE_ENV "production"

# ── 2. 패키지 ─────────────────────────────────────────────────
step "2/4 패키지 설치"
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error )

# VAPID 키: 이미 있으면 절대 바꾸지 않음 (바꾸면 기존 알림 구독이 모두 끊김)
if [[ "$USE_PUSH" == "1" ]]; then
  if [[ -z "$(get_env VAPID_PUBLIC_KEY)" || -z "$(get_env VAPID_PRIVATE_KEY)" ]]; then
    [[ -f "$APP_DIR/scripts/gen-vapid.js" ]] || die "scripts/gen-vapid.js 가 없습니다 (kairu-kit/deploy 에서 복사)"
    while IFS='=' read -r k v; do set_env "$k" "$v"; done < <(cd "$APP_DIR" && node scripts/gen-vapid.js)
    echo "  푸시 알림 키(VAPID) 새로 생성"
  else
    echo "  푸시 알림 키(VAPID) 기존 값 유지"
  fi
fi
mkdir -p "$APP_DIR/data"

# ── 도메인 ───────────────────────────────────────────────────
TOKEN=$(curl -fsS -m 3 -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)
PUBLIC_IP=$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
[[ -n "$PUBLIC_IP" ]] || PUBLIC_IP=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
[[ -n "$PUBLIC_IP" ]] || die "공인 IP를 찾을 수 없습니다."

SSLIP_DOMAIN="${APP_NAME}.${PUBLIC_IP//./-}.sslip.io"
SAVED_DOMAIN=$(cat "$APP_DIR/.deploy-domain" 2>/dev/null || true)
WANT_DOMAIN=$(tr -d '[:space:]' 2>/dev/null < "$APP_DIR/deploy.domain" | sed -E 's#^https?://##; s#/.*$##' || true)
resolves_here() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | grep -qxF "$PUBLIC_IP"; }
if [[ -n "${DOMAIN:-}" ]]; then
  :                                                   # DOMAIN=... bash deploy.sh 로 직접 지정
elif [[ -n "$WANT_DOMAIN" ]] && { [[ "$SAVED_DOMAIN" == "$WANT_DOMAIN" ]] || resolves_here "$WANT_DOMAIN"; }; then
  DOMAIN="$WANT_DOMAIN"                               # deploy.domain 의 DNS 가 이 서버를 가리킴
elif [[ -n "$WANT_DOMAIN" ]]; then
  DOMAIN="${SAVED_DOMAIN:-$SSLIP_DOMAIN}"
  warn "${WANT_DOMAIN} 이 아직 이 서버(${PUBLIC_IP})를 가리키지 않습니다 → 지금은 ${DOMAIN} 로 운영 (5분마다 다시 확인)"
  warn "Cloudflare DNS: A 레코드  이름 ${WANT_DOMAIN%%.*}  →  ${PUBLIC_IP}  (프록시 끔 = 회색 구름)"
else
  DEFAULT_DOMAIN="${SAVED_DOMAIN:-$SSLIP_DOMAIN}"
  DOMAIN="$(ask "  사용할 도메인 (엔터 = ${DEFAULT_DOMAIN}): " "$DEFAULT_DOMAIN")"
fi
DOMAIN="$(echo -n "$DOMAIN" | tr -d '[:space:]' | sed -E 's#^https?://##; s#/.*$##')"
echo "$DOMAIN" > "$APP_DIR/.deploy-domain"
# 내 도메인으로 옮겨도 예전 sslip 주소(보낸 링크·설치한 앱)는 계속 열리게 같이 받는다
SITE_HOSTS="$DOMAIN"
[[ "$DOMAIN" != "$SSLIP_DOMAIN" ]] && SITE_HOSTS="$DOMAIN, $SSLIP_DOMAIN"
[[ "$USE_PUSH" == "1" ]] && set_env VAPID_SUBJECT "https://$DOMAIN"
set_env PUBLIC_URL "https://$DOMAIN"
echo "  도메인 : $DOMAIN"

# ── 3. 서비스 ─────────────────────────────────────────────────
step "3/4 서비스 등록 (재부팅 시 자동 실행)"
sudo tee "/etc/systemd/system/${APP_NAME}.service" >/dev/null <<EOF
[Unit]
Description=${APP_TITLE:-$APP_NAME}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v node) ${APP_DIR}/${ENTRY}
Restart=always
RestartSec=5
MemoryMax=${MEMORY_MAX}

[Install]
WantedBy=multi-user.target
EOF

chmod +x "$APP_DIR/scripts/auto-update.sh" 2>/dev/null || true
sudo tee "/etc/systemd/system/${APP_NAME}-update.service" >/dev/null <<EOF
[Unit]
Description=${APP_TITLE:-$APP_NAME} - GitHub 새 커밋 자동 배포
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${APP_USER}
Environment=HOME=${HOME}
WorkingDirectory=${APP_DIR}
ExecStart=/bin/bash ${APP_DIR}/scripts/auto-update.sh
EOF
sudo tee "/etc/systemd/system/${APP_NAME}-update.timer" >/dev/null <<EOF
[Unit]
Description=${APP_TITLE:-$APP_NAME} - 5분마다 새 커밋 확인

[Timer]
OnBootSec=4min
OnUnitActiveSec=5min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$APP_NAME" >/dev/null 2>&1
sudo systemctl restart "$APP_NAME"
for i in {1..20}; do
  curl -fsS -m 2 "http://127.0.0.1:${PORT}${HEALTH_PATH}" >/dev/null 2>&1 && break
  sleep 1
  [[ $i -eq 20 ]] && { sudo journalctl -u "$APP_NAME" -n 30 --no-pager; die "앱이 시작되지 않았습니다. 위 로그를 확인하세요. (${HEALTH_PATH} 가 200 을 돌려주는지도 확인)"; }
done
echo "  앱 실행 중 (127.0.0.1:${PORT})"
if [[ -f "$APP_DIR/scripts/auto-update.sh" ]]; then
  sudo systemctl enable --now "${APP_NAME}-update.timer" >/dev/null 2>&1
  echo "  자동 업데이트: 켜짐 (5분마다 GitHub 확인)"
fi

# ── 4. Caddy (HTTPS) — 이 앱 파일만 추가 ──────────────────────
step "4/4 HTTPS 연결 (Caddy)"
CADDY_MAIN=/etc/caddy/Caddyfile
CADDY_SITES=/etc/caddy/sites
SITE_FILE="${CADDY_SITES}/${APP_NAME}.caddy"
IMPORT_LINE="import ${CADDY_SITES}/*.caddy"

# 메인 Caddyfile 이 앱별 파일 구조가 아니면 다른 앱 설정을 지울 수 있으니 중단
sudo grep -qxF "$IMPORT_LINE" "$CADDY_MAIN" 2>/dev/null \
  || die "Caddy 가 아직 앱별 파일 구조가 아닙니다. 따릉이 알리미를 먼저 업데이트하세요."

sudo mkdir -p "$CADDY_SITES"
CADDY_BAK=$(mktemp -d)
sudo cp -a "$SITE_FILE" "$CADDY_BAK/site" 2>/dev/null || true
# reverse_proxy 는 WebSocket(socket.io, ws) 도 그대로 통과시킨다
printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$SITE_HOSTS" "$PORT" | sudo tee "$SITE_FILE" >/dev/null
if ! sudo caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null 2>&1; then
  if [[ -f "$CADDY_BAK/site" ]]; then sudo cp -a "$CADDY_BAK/site" "$SITE_FILE"; else sudo rm -f "$SITE_FILE"; fi
  die "Caddy 설정 오류 — 이전 설정으로 되돌렸습니다. 다른 앱은 영향 없습니다."
fi
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

echo "  인증서 발급 대기 중… (최대 60초)"
OK=0
for i in {1..30}; do
  if curl -fsS -m 5 "https://${DOMAIN}${HEALTH_PATH}" >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done

echo
if [[ $OK -eq 1 ]]; then
  echo "${c_bold}${c_green}✅ 배포 완료!${c_off}"
  echo
  echo "   👉 https://${DOMAIN}"
else
  warn "HTTPS 확인 실패. 로그: sudo journalctl -u caddy -n 50 --no-pager"
fi
cat <<EOF

   상태      sudo systemctl status ${APP_NAME}
   로그      sudo journalctl -u ${APP_NAME} -f
   재시작    sudo systemctl restart ${APP_NAME}
   설정 수정  nano ${ENV_FILE}  →  재시작
   업데이트  cd ${APP_DIR} && git pull && bash deploy.sh   (평소엔 5분마다 자동)
EOF
