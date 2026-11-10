#!/bin/bash
# Gera os grafos a pé e de carro a partir de backend/osrm-data/map.osm.pbf.
# Rode pelo docker compose (perfil prepare), não direto no Windows.
set -euo pipefail

if [[ ! -f /data/map.osm.pbf ]]; then
  echo "Arquivo ausente: backend/osrm-data/map.osm.pbf"
  echo "Baixe o recorte da operação, por exemplo o Nordeste:"
  echo "https://download.geofabrik.de/south-america/brazil/nordeste-latest.osm.pbf"
  exit 1
fi

ln -f /data/map.osm.pbf /data/foot.osm.pbf
echo "Extraindo perfil a pé..."
osrm-extract -p /opt/foot.lua /data/foot.osm.pbf
osrm-partition /data/foot.osrm
osrm-customize /data/foot.osrm

ln -f /data/map.osm.pbf /data/car.osm.pbf
echo "Extraindo perfil de carro..."
osrm-extract -p /opt/car.lua /data/car.osm.pbf
osrm-partition /data/car.osrm
osrm-customize /data/car.osrm

echo "Grafos prontos: foot.osrm e car.osrm"
