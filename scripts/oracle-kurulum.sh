#!/usr/bin/env bash
# ÇevikPano — kendi sunucuna tek komutla kurulum (Oracle Cloud Always Free ve diğer Ubuntu sunucular).
#
# Sunucuda (Ubuntu 22.04 / 24.04, ARM ya da x86) çalıştırın:
#   curl -fsSL https://raw.githubusercontent.com/brkbkr/CevikPano/main/scripts/oracle-kurulum.sh | sudo bash
#
# Alan adınız varsa (DNS'te A kaydı sunucu IP'sini göstermeli):
#   curl -fsSL .../oracle-kurulum.sh | sudo DOMAIN=pano.firmam.com bash
#
# Yaptıkları: Docker kurar, depoyu /opt/cevikpano'ya indirir, rastgele parolalarla .env üretir,
# 80/443 portlarını açar, PostgreSQL + uygulama + HTTPS (Caddy) başlatır, günlük veritabanı yedeği kurar.
# Tekrar çalıştırmak güvenlidir: mevcut .env ve veriler korunur, sadece güncellenir.
set -euo pipefail

REPO="${REPO:-https://github.com/brkbkr/CevikPano.git}"
BRANCH="${BRANCH:-main}"
DIR="${DIR:-/opt/cevikpano}"
BACKUP_DIR="$DIR/yedekler"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*"; exit 1; }
rand() { local s; s="$(head -c 600 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"; printf '%s' "${s:0:${1:-20}}"; }

[ "$(id -u)" -eq 0 ] || die "sudo ile çalıştırın: curl ... | sudo bash"
command -v apt-get >/dev/null || die "Bu betik Ubuntu/Debian içindir."

say "1/7 Sistem paketleri"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git iptables-persistent >/dev/null

say "2/7 Docker"
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null
docker compose version >/dev/null || die "Docker Compose kurulamadı"

say "3/7 Uygulama kodu ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

say "4/7 Ayarlar (.env)"
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || true)"
if [ ! -f .env ]; then
  DOMAIN="${DOMAIN:-}"
  if [ -z "$DOMAIN" ]; then
    [ -n "$PUBLIC_IP" ] || die "Sunucunun genel IP adresi bulunamadı; DOMAIN=... vererek tekrar çalıştırın."
    DOMAIN="$(echo "$PUBLIC_IP" | tr . -).sslip.io"
  fi
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
  if [ -z "$ADMIN_PASSWORD" ] && [ -r /dev/tty ]; then
    printf 'Yönetici (admin) parolası belirleyin (en az 8 karakter, boş bırakırsanız rastgele üretilir): ' >/dev/tty
    read -rs ADMIN_PASSWORD </dev/tty || true; echo >/dev/tty
  fi
  if [ -n "$ADMIN_PASSWORD" ] && { [ "${#ADMIN_PASSWORD}" -lt 8 ] || [[ "$ADMIN_PASSWORD" =~ [[:space:]\'\"\$\`\\] ]]; }; then
    warn "Parola en az 8 karakter olmalı ve boşluk, tırnak, \$, \` veya \\ içermemeli; rastgele parola üretildi."
    ADMIN_PASSWORD=""
  fi
  [ -n "$ADMIN_PASSWORD" ] || ADMIN_PASSWORD="$(rand 14)"
  umask 077
  cat > .env <<EOF
DOMAIN=$DOMAIN
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$ADMIN_PASSWORD
DEFAULT_USER_PASSWORD=Pano-$(rand 8)
POSTGRES_PASSWORD=$(rand 32)
EOF
  umask 022
  NEW_INSTALL=1
else
  NEW_INSTALL=0
  warn ".env zaten var; mevcut ayarlar ve parolalar korunuyor."
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a

say "5/7 Güvenlik duvarı (80, 443)"
# Oracle'ın Ubuntu imajları iptables ile her şeyi engeller; web portlarını aç.
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport "$p" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

say "6/7 Uygulamayı başlat (ilk seferde birkaç dakika sürer)"
docker compose up -d --build
for i in $(seq 1 60); do
  docker compose exec -T app wget -qO- http://localhost:3000/healthz >/dev/null 2>&1 && break
  sleep 3
  [ "$i" -eq 60 ] && { docker compose logs --tail 50 app; die "Uygulama açılmadı (yukarıdaki günlüğe bakın)."; }
done

say "7/7 Günlük yedek (her gece 03:15, son 14 gün)"
mkdir -p "$BACKUP_DIR"
cat > /etc/cron.d/cevikpano-yedek <<EOF
15 3 * * * root cd $DIR && docker compose exec -T db pg_dump -U cevikpano -d cevikpano | gzip > $BACKUP_DIR/cevikpano-\$(date +\%F).sql.gz && find $BACKUP_DIR -name '*.sql.gz' -mtime +14 -delete
EOF
chmod 644 /etc/cron.d/cevikpano-yedek

cat <<EOF

$(printf '\033[1;32m')ÇevikPano çalışıyor!$(printf '\033[0m')

  Adres     : https://$DOMAIN
  Kullanıcı : ${ADMIN_USERNAME:-admin}
EOF
if [ "$NEW_INSTALL" = 1 ]; then
  echo "  Parola    : $ADMIN_PASSWORD"
  echo "  (Parolalar $DIR/.env dosyasında; bu ekranı kapatmadan bir yere not edin.)"
fi
cat <<EOF

  HTTPS sertifikası ilk açılışta 1-2 dakika içinde alınır. Açılmazsa Oracle Cloud'da
  80 ve 443 portlarının (Security List → Ingress Rules) açık olduğunu kontrol edin.

  Güncelleme  : sudo bash $DIR/scripts/oracle-kurulum.sh
  Günlükler   : cd $DIR && sudo docker compose logs -f app
  Yedekler    : $BACKUP_DIR (uygulama içinde de Sistem → Yedekler)
EOF
