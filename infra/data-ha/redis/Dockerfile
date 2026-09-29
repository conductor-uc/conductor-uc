# S4-07/S4-11: a Redis group member or sentinel, with the start scripts that
# ask the sentinels who the primary is (redis-start.sh, sentinel-start.sh).
FROM redis:7-alpine
COPY redis-start.sh /usr/local/bin/redis-start.sh
COPY sentinel-start.sh /usr/local/bin/sentinel-start.sh
RUN chmod +x /usr/local/bin/redis-start.sh /usr/local/bin/sentinel-start.sh
