#!/usr/bin/env python3
"""S1-14 (G-18, docs/decisions.md): seeds the `dispatcher` table with this
deployment's FS node pool ("set 1", matching `ds_select_dst(1, 4)` in
opensips.cfg.template) — the piece 03 §1's own words claim happens
("provisioned as environment config") but nothing ever actually did, from
S1-11 through S1-13. Idempotent (delete-then-insert on every container
start, not just first boot), unlike the mariadb-side init scripts, since
this destination can legitimately change between deployments of the same
data volume.

Uses `pymysql`, already present in the base image for `opensips-cli`'s own
sake — no new package needed.
"""
import os
import sys
from urllib.parse import urlparse

import pymysql

db_url = urlparse(os.environ["OPENSIPS_DB_URL"])
destination = os.environ.get("OPENSIPS_FS_DESTINATION", "sip:freeswitch:5060")

conn = pymysql.connect(
    host=db_url.hostname,
    port=db_url.port or 3306,
    user=db_url.username,
    password=db_url.password or "",
    database=db_url.path.lstrip("/"),
)
try:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM dispatcher WHERE setid = 1")
        cur.execute(
            "INSERT INTO dispatcher (setid, destination, state, weight, description) "
            "VALUES (1, %s, 0, '1', 'S1-14 seed: the FS node pool')",
            (destination,),
        )
    conn.commit()
finally:
    conn.close()

sys.stdout.write(f"dispatcher: seeded set 1 -> {destination}\n")
