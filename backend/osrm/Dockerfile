FROM ghcr.io/project-osrm/osrm-backend:v5.27.1

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY start-osrm.sh /start-osrm.sh
RUN chmod +x /start-osrm.sh

ENV OSM_PBF_URL=https://download.geofabrik.de/south-america/brazil/nordeste-latest.osm.pbf
ENV OSRM_DATA_DIR=/data
ENV PORT=5000

EXPOSE 5000
ENTRYPOINT ["bash", "/start-osrm.sh"]
