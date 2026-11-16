#!/usr/bin/env bash
# Temporary: find out how the sites that refuse GitHub's servers are refusing them.
set -u
out=snapshot/diag
mkdir -p "$out"
UA='Mozilla/5.0 (compatible; LeglRegulationTracker/1.0; +https://www.legl.com)'
W='code=%{http_code} ip=%{remote_ip} connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s bytes=%{size_download} http=%{http_version}\n'
{
echo "runner: $(curl -s -m 10 https://ipinfo.io/json | tr -d '\n' | cut -c1-300)"
echo "chrome: $(google-chrome --version 2>&1 | head -1)"
for host in www.austrac.gov.au www.oaic.gov.au www.ag.gov.au; do echo "dns $host: $(getent hosts $host | head -2 | tr '\n' ' ') $(dig +short CNAME $host 2>/dev/null | tr '\n' ' ')"; done
i=0
for u in \
  https://www.austrac.gov.au/robots.txt \
  https://www.austrac.gov.au/news-and-media/news-and-media-releases \
  https://www.austrac.gov.au/media-release/rss.xml \
  https://www.austrac.gov.au/industry-and-business/consultations \
  https://www.oaic.gov.au/robots.txt \
  https://www.oaic.gov.au/news/media-centre \
  https://www.oaic.gov.au/engage-with-us/consultations \
  https://www.ag.gov.au/robots.txt ; do
  i=$((i+1))
  echo; echo "== $u"
  printf 'curl default ua : '; curl -sS -L -m 20 -o "$out/curl-$i.txt" -w "$W" "$u" 2>&1 | tail -1
  printf 'curl our ua     : '; curl -sS -L -m 20 -A "$UA" -o "$out/curl-ua-$i.txt" -w "$W" "$u" 2>&1 | tail -1
  printf 'curl http1.1    : '; curl -sS -L -m 20 --http1.1 -A "$UA" -H 'accept: text/html' -H 'accept-language: en-GB,en;q=0.9' -o /dev/null -w "$W" "$u" 2>&1 | tail -1
  case "$u" in *robots.txt|*rss.xml) continue;; esac
  printf 'chrome headless : '; timeout 60 google-chrome --headless=new --no-sandbox --disable-gpu --virtual-time-budget=15000 --dump-dom "$u" > "$out/chrome-$i.html" 2> "$out/chrome-$i.err"; echo "exit=$? bytes=$(wc -c < "$out/chrome-$i.html") links=$(grep -o '<a ' "$out/chrome-$i.html" | wc -l) title=$(grep -o '<title>[^<]*' "$out/chrome-$i.html" | head -1)"
  printf 'chrome our ua   : '; timeout 60 google-chrome --headless=new --no-sandbox --disable-gpu --virtual-time-budget=15000 --user-agent="$UA" --dump-dom "$u" > "$out/chrome-ua-$i.html" 2> "$out/chrome-ua-$i.err"; echo "exit=$? bytes=$(wc -c < "$out/chrome-ua-$i.html") links=$(grep -o '<a ' "$out/chrome-ua-$i.html" | wc -l) title=$(grep -o '<title>[^<]*' "$out/chrome-ua-$i.html" | head -1)"
done
echo; echo "== web archive"
for u in www.austrac.gov.au/news-and-media/news-and-media-releases www.oaic.gov.au/news/media-centre; do
  echo "available $u: $(curl -s -m 20 "https://archive.org/wayback/available?url=$u" | cut -c1-300)"
done
} 2>&1 | tee "$out/report.txt"
cp "$out/report.txt" report.md
for f in "$out"/curl-1.txt "$out"/curl-5.txt "$out"/curl-8.txt; do echo "---- $f"; head -c 1500 "$f"; echo; done >> "$out/report.txt" 2>&1
find "$out" -size +900k -delete
