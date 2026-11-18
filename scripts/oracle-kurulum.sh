#!/usr/bin/env bash
# ÇevikPano — kendi sunucuna tek komutla kurulum (Oracle Cloud Always Free ve diğer Ubuntu sunucular).
#
#   curl -fsSL https://raw.githubusercontent.com/brkbkr/CevikPano/main/scripts/oracle-kurulum.sh | sudo bash
#
# Kendi alan adınız varsa (DNS'te pano.firma.com ve test.pano.firma.com → sunucu IP'si):
#   curl -fsSL .../oracle-kurulum.sh | sudo DOMAIN=pano.firma.com bash
#
# Kurduğu düzen:
#   CANLI  https://<alan>        /opt/cevikpano       GitHub "production" dalını izler
#   TEST   https://test.<alan>   /opt/cevikpano-test  GitHub "main" dalını izler (ayrı veritabanı, demo veri)
#   Ortak kapı (Caddy, HTTPS) ve her 2 dakikada çalışan otomatik dağıtıcı (pano-deploy).
# Tekrar çalıştırmak güvenlidir: mevcut ayarlar, parolalar ve veriler korunur.
set -euo pipefail

REPO="${REPO:-https://github.com/brkbkr/CevikPano.git}"
GITHUB_REPO="${GITHUB_REPO:-brkbkr/CevikPano}"
PROD_DIR="${PROD_DIR:-/opt/cevikpano}"
TEST_DIR="${TEST_DIR:-/opt/cevikpano-test}"
ETC="${PANO_ETC:-/etc/pano}"
BACKUP_DIR="$PROD_DIR/yedekler"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*"; exit 1; }
rand() { local s; s="$(head -c 600 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"; printf '%s' "${s:0:${1:-20}}"; }
# .env içinde anahtar yoksa ekle (varsa dokunma)
envset() { grep -q "^$2=" "$1" 2>/dev/null || printf '%s=%s\n' "$2" "$3" >> "$1"; }
envget() { grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2-; }

[ "$(id -u)" -eq 0 ] || die "sudo ile çalıştırın: curl ... | sudo bash"
# PANO_SKIP_SYSTEM=1: yalnızca geliştirme/test içindir; paket kurulumu, güvenlik duvarı, systemd ve cron atlanır.
SKIP_SYS="${PANO_SKIP_SYSTEM:-}"

if [ -z "$SKIP_SYS" ]; then
command -v apt-get >/dev/null || die "Bu betik Ubuntu/Debian içindir."
say "1/9 Sistem paketleri"
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -y -qq -o DPkg::Lock::Timeout=600"
$APT update
$APT install ca-certificates curl git iptables-persistent >/dev/null

say "2/9 Docker"
if ! docker compose version >/dev/null 2>&1; then
  $APT install docker.io docker-compose-v2 >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null
docker compose version >/dev/null || die "Docker Compose kurulamadı"
fi
docker network inspect pano-edge >/dev/null 2>&1 || docker network create pano-edge >/dev/null

say "3/9 Kod (canlı ve test)"
checkout() {   # klasör, tercih edilen dal, yedek dal
  local dir="$1" want="$2" alt="$3" ref
  [ -d "$dir/.git" ] || git clone -q "$REPO" "$dir"
  if git -C "$dir" fetch -q origin "$want" 2>/dev/null; then ref="$want"
  else git -C "$dir" fetch -q origin "$alt"; ref="$alt"; fi
  git -C "$dir" reset -q --hard FETCH_HEAD
  echo "$ref"
}
PROD_REF="$(checkout "$PROD_DIR" production main)"
TEST_REF="$(checkout "$TEST_DIR" main main)"
echo "  canlı: $PROD_REF ($(git -C "$PROD_DIR" rev-parse --short HEAD))   test: $TEST_REF ($(git -C "$TEST_DIR" rev-parse --short HEAD))"

say "4/9 Ayarlar"
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || true)"
PENV="$PROD_DIR/.env"; TENV="$TEST_DIR/.env"
NEW_INSTALL=0
umask 077
if [ ! -f "$PENV" ]; then
  NEW_INSTALL=1
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
  {
    echo "DOMAIN=$DOMAIN"
    echo "ADMIN_USERNAME=admin"
    echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
    echo "DEFAULT_USER_PASSWORD=Pano-$(rand 8)"
    echo "POSTGRES_PASSWORD=$(rand 32)"
  } > "$PENV"
else
  warn "Canlı ortam ayarları zaten var; parolalar ve veriler korunuyor."
fi
DOMAIN="$(envget "$PENV" DOMAIN)"
TEST_DOMAIN="test.$DOMAIN"
envset "$PENV" STACK cevikpano
envset "$PENV" APP_ENV production
envset "$PENV" PEER_URL "https://$TEST_DOMAIN"
envset "$PENV" GITHUB_REPO "$GITHUB_REPO"

if [ ! -f "$TENV" ]; then
  {
    echo "DOMAIN=$TEST_DOMAIN"
    echo "ADMIN_USERNAME=admin"
    echo "ADMIN_PASSWORD=$(envget "$PENV" ADMIN_PASSWORD)"     # test girişi canlıyla aynı parola
    echo "DEFAULT_USER_PASSWORD=$(envget "$PENV" DEFAULT_USER_PASSWORD)"
    echo "POSTGRES_PASSWORD=$(rand 32)"
  } > "$TENV"
fi
envset "$TENV" STACK cevikpano-test
envset "$TENV" APP_ENV test
envset "$TENV" PEER_URL "https://$DOMAIN"
envset "$TENV" GITHUB_REPO "$GITHUB_REPO"
umask 022

mkdir -p "$ETC"
cat > "$ETC/ortamlar" <<EOF
# ad   klasör              izlenen dal   docker projesi
prod   $PROD_DIR       production    cevikpano
test   $TEST_DIR  main          cevikpano-test
EOF
printf 'PROD_DOMAIN=%s\nTEST_DOMAIN=%s\n' "$DOMAIN" "$TEST_DOMAIN" > "$ETC/edge.env"

if [ -z "$SKIP_SYS" ]; then
say "5/9 Güvenlik duvarı (80, 443)"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport "$p" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
fi

up_env() {   # klasör, proje
  local dir="$1" project="$2" i
  ( cd "$dir"
    APP_COMMIT="$(git rev-parse HEAD)" APP_COMMIT_DATE="$(git log -1 --format=%cI)" APP_COMMIT_MSG="$(git log -1 --format=%s)" \
      docker compose -p "$project" up -d --build --remove-orphans )
  for i in $(seq 1 80); do
    (cd "$dir" && docker compose -p "$project" exec -T app wget -qO- http://localhost:3000/healthz >/dev/null 2>&1) && break
    sleep 3
    [ "$i" -eq 80 ] && { (cd "$dir" && docker compose -p "$project" logs --tail 60 app); die "$project açılmadı (yukarıdaki günlüğe bakın)."; }
  done
  git -C "$dir" rev-parse HEAD > "$dir/.deployed"
}

say "6/9 Canlı ortam (ilk seferde birkaç dakika sürer)"
up_env "$PROD_DIR" cevikpano             # eski tek-parça kurulumdaki kapı (caddy) burada kaldırılır

say "7/9 Ortak kapı (HTTPS)"
docker compose -p pano-edge --env-file "$ETC/edge.env" -f "$PROD_DIR/deploy/edge.yml" up -d

say "8/9 Test ortamı"
up_env "$TEST_DIR" cevikpano-test
if [ ! -f "$TEST_DIR/.seeded" ] && [ -f "$TEST_DIR/test/fixtures/demo.json" ]; then
  (cd "$TEST_DIR"
   docker compose -p cevikpano-test exec -T app sh -c 'cat > /tmp/demo.json' < test/fixtures/demo.json
   docker compose -p cevikpano-test exec -T app node -e '
     (async () => {
       const base = "http://localhost:3000", h = { "x-pano": "1", "content-type": "application/json" };
       const r = await fetch(base + "/api/auth/login", { method: "POST", headers: h,
         body: JSON.stringify({ username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD }) });
       if (!r.ok) throw new Error("giriş: " + r.status);
       h.cookie = r.headers.get("set-cookie").split(";")[0];
       const data = JSON.parse(require("fs").readFileSync("/tmp/demo.json", "utf8"));
       const i = await fetch(base + "/api/import", { method: "POST", headers: h, body: JSON.stringify({ data }) });
       console.log("demo veri:", i.status, JSON.stringify(await i.json()));
     })().catch(e => { console.error(e.message); process.exit(1); });') \
  && touch "$TEST_DIR/.seeded" || warn "Test ortamına demo veri yüklenemedi (önemli değil)."
fi

say "9/9 Otomatik dağıtıcı ve günlük yedek"
if [ -z "$SKIP_SYS" ]; then
install -m 755 "$PROD_DIR/deploy/pano-deploy.sh" /usr/local/bin/pano-deploy
cat > /etc/systemd/system/pano-deploy.service <<'EOF'
[Unit]
Description=ÇevikPano otomatik dağıtıcı (GitHub dallarını izler)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/pano-deploy
TimeoutStartSec=1800
EOF
cat > /etc/systemd/system/pano-deploy.timer <<'EOF'
[Unit]
Description=ÇevikPano otomatik dağıtıcı — her 2 dakikada bir

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now pano-deploy.timer >/dev/null

mkdir -p "$BACKUP_DIR"
cat > /etc/cron.d/cevikpano-yedek <<EOF
15 3 * * * root cd $PROD_DIR && docker compose -p cevikpano exec -T db pg_dump -U cevikpano -d cevikpano | gzip > $BACKUP_DIR/cevikpano-\$(date +\%F).sql.gz && find $BACKUP_DIR -name '*.sql.gz' -mtime +14 -delete
EOF
chmod 644 /etc/cron.d/cevikpano-yedek
fi

ADMIN_USERNAME="$(envget "$PENV" ADMIN_USERNAME)"
cat <<EOF

$(printf '\033[1;32m')ÇevikPano çalışıyor!$(printf '\033[0m')

  🚀 Canlı : https://$DOMAIN
  🧪 Test  : https://$TEST_DOMAIN   (ayrı veritabanı, demo veri)
  Kullanıcı: ${ADMIN_USERNAME:-admin}   (iki ortamda da aynı parola)
EOF
if [ "$NEW_INSTALL" = 1 ]; then
  echo "  Parola   : $(envget "$PENV" ADMIN_PASSWORD)"
  echo "  (Parolalar $PENV dosyasında; bu ekranı kapatmadan bir yere not edin.)"
fi
cat <<EOF

  Nasıl çalışır:
   • GitHub'da onaylanan (main'e birleştirilen) değişiklik ~2-5 dakikada TEST sitesine gelir.
   • GitHub → Actions → "Canlıya yayınla" → Run workflow ile CANLI siteye alınır.
   • Yeni sürüm açılmazsa sunucu kendiliğinden önceki sürüme döner.

  Dağıtım günlüğü : sudo tail -f /var/log/pano-deploy.log
  Elle güncelleme : sudo pano-deploy
  Günlük yedekler : $BACKUP_DIR (uygulama içinde de Sistem → Yedekler)

  HTTPS sertifikaları ilk açılışta 1-2 dakikada alınır. Kendi alan adınızı kullanıyorsanız
  DNS'te hem $DOMAIN hem $TEST_DOMAIN sunucunun IP'sini göstermeli.
EOF
