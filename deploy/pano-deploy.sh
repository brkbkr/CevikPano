#!/usr/bin/env bash
# pano-deploy — sunucudaki otomatik dağıtıcı.
#
# Her ortam bir GitHub dalını izler (/etc/pano/ortamlar):
#   test  → main        (PR birleştirilince birkaç dakikada test sitesine gelir)
#   prod  → production  (GitHub'da "Canlıya yayınla" çalıştırılınca canlıya gelir)
# Dal ilerlediyse: kodu indirir, yeniden kurar, sağlık kontrolü yapar.
# Yeni sürüm açılmazsa önceki sürüme döner ve o sürümü bir daha denemez.
#
# systemd zamanlayıcısı her 2 dakikada bir çalıştırır. Elle:
#   sudo pano-deploy            # değişen ortamları güncelle
#   sudo pano-deploy test       # yalnızca test
#   sudo FORCE=1 pano-deploy prod   # değişiklik olmasa da yeniden kur
set -uo pipefail

CONF="${PANO_CONF:-/etc/pano/ortamlar}"
EDGE_ENV="${PANO_EDGE_ENV:-/etc/pano/edge.env}"
LOG="${PANO_LOG:-/var/log/pano-deploy.log}"
LOCK="${PANO_LOCK:-/run/lock/pano-deploy.lock}"
ONLY="${1:-}"
FORCE="${FORCE:-}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG" >&2; }

exec 9>"$LOCK"
flock -n 9 || exit 0                      # önceki çalışma sürüyorsa bekleme, çık

[ -f "$CONF" ] || { log "Ayar dosyası yok: $CONF"; exit 1; }

compose() { docker compose -p "$PROJECT" "$@" </dev/null; }

healthy() {
  local _i
  for _i in $(seq 1 60); do
    compose exec -T app wget -qO- http://localhost:3000/healthz >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

bring_up() {
  APP_COMMIT="$(git rev-parse HEAD)"
  APP_COMMIT_DATE="$(git log -1 --format=%cI)"
  APP_COMMIT_MSG="$(git log -1 --format=%s)"
  export APP_COMMIT APP_COMMIT_DATE APP_COMMIT_MSG
  compose up -d --build --remove-orphans >>"$LOG" 2>&1
}

edge_up() {
  # Ortak kapı ayarları canlı ortamın kodundan gelir (Caddyfile değiştiyse yeniden yükle).
  local dir="$1"
  [ -f "$EDGE_ENV" ] || return 0
  docker compose -p pano-edge --env-file "$EDGE_ENV" -f "$dir/deploy/edge.yml" up -d </dev/null >>"$LOG" 2>&1 || { log "edge: başlatılamadı"; return 1; }
  docker compose -p pano-edge --env-file "$EDGE_ENV" -f "$dir/deploy/edge.yml" exec -T caddy </dev/null \
    caddy reload --config /etc/pano-edge/Caddyfile --adapter caddyfile >>"$LOG" 2>&1 || true
  # Dağıtıcının kendisi de güncel kalsın.
  install -m 755 "$dir/deploy/pano-deploy.sh" /usr/local/bin/pano-deploy 2>/dev/null || true
}

deploy_env() {
  local name="$1" dir="$2" branch="$3"
  PROJECT="$4"
  cd "$dir" 2>/dev/null || { log "$name: klasör yok ($dir)"; return 1; }
  if ! git fetch -q origin "$branch" 2>/dev/null; then
    [ "$name" = prod ] && [ "$branch" = production ] \
      && log "$name: henüz yayınlanmış sürüm yok (origin/$branch); canlı olduğu gibi kalıyor" \
      || log "$name: origin/$branch indirilemedi"
    return 0
  fi
  local new cur failed
  new="$(git rev-parse FETCH_HEAD)"
  cur="$(cat .deployed 2>/dev/null || git rev-parse HEAD)"
  failed="$(cat .failed 2>/dev/null || true)"
  if [ -z "$FORCE" ]; then
    [ "$new" = "$cur" ] && return 0
    [ "$new" = "$failed" ] && return 0     # bu sürüm daha önce açılamadı; yeni bir sürüm bekle
  fi

  log "$name: ${cur:0:7} → ${new:0:7} ($(git log -1 --format=%s "$new" 2>/dev/null))"
  git reset -q --hard "$new"
  if bring_up && healthy; then
    echo "$new" > .deployed
    rm -f .failed
    log "$name: ✓ ${new:0:7} yayında"
    [ "$name" = prod ] && edge_up "$dir"
    return 0
  fi

  log "$name: ✗ ${new:0:7} açılmadı, önceki sürüme dönülüyor (${cur:0:7})"
  compose logs --tail 40 app >>"$LOG" 2>&1 || true
  echo "$new" > .failed
  git reset -q --hard "$cur"
  if bring_up && healthy; then log "$name: ↩ ${cur:0:7} geri yüklendi"
  else log "$name: !!! geri yükleme de başarısız — elle bakılmalı"; fi
  return 1
}

rc=0
while read -r name dir branch project _; do
  case "$name" in ''|\#*) continue ;; esac
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue
  deploy_env "$name" "$dir" "$branch" "$project" || rc=1
done < "$CONF"
exit $rc
