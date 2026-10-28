#!/usr/bin/env bash
# GitHub 에 새 커밋이 있으면 받아서 배포 (systemd 타이머가 5분마다 실행)
#   로그 보기:  journalctl -u <APP_NAME>-update -n 50 --no-pager
# 앱 이름은 app.config 에서 읽으므로 이 파일은 고칠 필요 없음
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source ./app.config

BRANCH="${BRANCH:-main}"
ERR="/tmp/${APP_NAME}-fetch.err"

if ! git fetch -q origin "$BRANCH" 2>"$ERR"; then
  echo "❌ GitHub 에서 가져오기 실패 (토큰 만료/권한 확인):"
  cat "$ERR"
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
if [[ "$LOCAL" == "$REMOTE" ]]; then
  # 새 커밋은 없지만, deploy.domain 의 DNS 가 이제 이 서버를 가리키면 한 번 다시 배포해서 내 도메인으로 전환
  WANT=$(tr -d '[:space:]' 2>/dev/null < deploy.domain || true)
  CUR=$(cat .deploy-domain 2>/dev/null || true)
  if [[ -n "$WANT" && -n "$CUR" && "$WANT" != "$CUR" ]]; then
    ip_of() { getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}'; }
    NEW_IP=$(ip_of "$WANT"); CUR_IP=$(ip_of "$CUR")
    if [[ -n "$NEW_IP" && "$NEW_IP" == "$CUR_IP" ]]; then
      echo "🌐 ${WANT} DNS 확인됨 → 내 도메인으로 전환"
      bash deploy.sh </dev/null
    fi
  fi
  exit 0   # 새 커밋 없음
fi

echo "🔄 새 커밋 발견: ${LOCAL:0:7} → ${REMOTE:0:7}"
git log --oneline "$LOCAL..$REMOTE" || true

# 서버에서 임시로 고친 배포 파일이 있으면 되돌린 뒤 받기
git checkout -- deploy.sh scripts/ 2>/dev/null || true
if ! git pull -q --ff-only origin "$BRANCH"; then
  echo "❌ git pull 실패 — 서버에서 직접 수정한 파일이 있는지 확인하세요: git status"
  exit 1
fi

bash deploy.sh </dev/null
echo "✅ 자동 업데이트 완료: $(git rev-parse --short HEAD)"
