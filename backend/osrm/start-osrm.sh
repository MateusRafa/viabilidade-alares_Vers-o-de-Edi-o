#!/bin/bash
# Primeira subida: baixa o mapa e monta o grafo em /data (volume).
# Subidas seguintes só ligam o servidor, se o arquivo READY existir.
set -euo pipefail

DATA="${OSRM_DATA_DIR:-/data}"
URL="${OSM_PBF_URL:-https://download.geofabrik.de/south-america/brazil/nordeste-latest.osm.pbf}"
PORT="${PORT:-5000}"
PBF="$DATA/map.osm.pbf"
STAMP="$DATA/READY"

mkdir -p "$DATA"

if [[ ! -f "$STAMP" ]]; then
  echo "Montando o mapa de ruas. A primeira vez pode levar bastante. Nao reinicie o servico."
  rm -f "$DATA"/foot.osrm "$DATA"/foot.osrm.*
  if [[ ! -s "$PBF" ]]; then
    echo "Baixando $URL"
    wget -O "$PBF.part" "$URL"
    mv "$PBF.part" "$PBF"
  fi
  ln -f "$PBF" "$DATA/foot.osm.pbf"
  osrm-extract -p /opt/foot.lua "$DATA/foot.osm.pbf"
  osrm-partition "$DATA/foot.osrm"
  osrm-customize "$DATA/foot.osrm"
  touch "$STAMP"
  echo "Mapa pronto."
fi

echo "Servindo rotas na porta $PORT"
exec osrm-routed --algorithm mld --ip :: --port "$PORT" "$DATA/foot.osrm"
