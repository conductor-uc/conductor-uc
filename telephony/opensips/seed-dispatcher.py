#!/usr/bin/env python3
"""S1-14 (G-18, docs/decisions.md): seeds the `dispatcher` table with this
deployment's FS node pool ("set 1", matching `ds_select_dst(1, ...)` in
opensips.cfg.template), provisioned as environment config (03 §1). Runs on
every container start, not just first boot, since the pool can legitimately
change between deployments of the same data volume.

S2-19: `OPENSIPS_FS_DESTINATION` is comma-separated, one entry per FS node.
Every entry becomes a row in set 1, which is both what `ds_select_dst`
spreads calls across and what `ds_is_in_list` recognizes as "this request
came from an FS node".

S4-02 (G-123): each entry is `[node-id=]sip:host:port[;weight=N]`, e.g.
`fs1=sip:10.10.0.21:5060;weight=2,fs2=sip:10.10.0.22:5060`.
- `node-id` is the node's id in call-control's `FS_NODES` (and its
  `FS_NODE_ID`). It is stored in the row's `attrs`, which is how
  telephony-config finds the row to take out of rotation when call-control
  drains that node. An entry without one works but cannot be drained.
- `weight` (1-999, default 1): under weighted round-robin
  (`ds_select_dst(1, 4)`) a node takes `weight` new calls in a row before
  the next one, so `;weight=3` on one node and 1 on another splits calls
  3:1. 0 is refused: OpenSIPs treats it as 1, not as "none" (found live).
  A node that should get no new calls is drained instead.
  S4-12 (G-124): it is only the *starting* weight of a newly listed node.
  Once the row exists, the operations console owns its weight, and a restart
  keeps whatever was set there.
The table is synced rather than rewritten: rows for destinations still listed
keep their `state` and `weight`, so a drained or reweighted node stays that way
across an OpenSIPs restart; rows for destinations no longer listed are removed.

Uses `pymysql`, already present in the base image for `opensips-cli`'s own
sake.
"""
import os
import re
import sys
from urllib.parse import urlparse

import pymysql

ENTRY = re.compile(
    r"^(?:(?P<node>[A-Za-z0-9][A-Za-z0-9_.-]{0,63})=)?"
    r"(?P<uri>sips?:[^;,\s]+)"
    r"(?:;weight=(?P<weight>[1-9]\d{0,2}))?$"
)


def parse(raw: str) -> list[tuple[str, str | None, str]]:
    entries = []
    for part in raw.split(","):
        part = part.strip()
        if part == "":
            continue
        match = ENTRY.match(part)
        if match is None:
            sys.exit(
                f"dispatcher: bad OPENSIPS_FS_DESTINATION entry '{part}': "
                "expected [node-id=]sip:host:port[;weight=N], N from 1 to 999"
            )
        entries.append((match["uri"], match["node"], match["weight"] or "1"))
    return entries


db_url = urlparse(os.environ["OPENSIPS_DB_URL"])
entries = parse(os.environ.get("OPENSIPS_FS_DESTINATION", "sip:freeswitch:5060"))

conn = pymysql.connect(
    host=db_url.hostname,
    port=db_url.port or 3306,
    user=db_url.username,
    password=db_url.password or "",
    database=db_url.path.lstrip("/"),
)
try:
    with conn.cursor() as cur:
        cur.execute("SELECT destination FROM dispatcher WHERE setid = 1")
        existing = {row[0] for row in cur.fetchall()}
        listed = {uri for uri, _, _ in entries}
        for uri in existing - listed:
            cur.execute("DELETE FROM dispatcher WHERE setid = 1 AND destination = %s", (uri,))
        for uri, node, weight in entries:
            if uri in existing:
                cur.execute(
                    "UPDATE dispatcher SET attrs = %s WHERE setid = 1 AND destination = %s",
                    (node, uri),
                )
            else:
                cur.execute(
                    "INSERT INTO dispatcher (setid, destination, state, weight, attrs, description) "
                    "VALUES (1, %s, 0, %s, %s, 'S4-02 seed: the FS node pool')",
                    (uri, weight, node),
                )
    conn.commit()
    # What OpenSIPs will load, not what the environment asked for: an existing
    # row's weight (set in the operations console) and state (a drain) win.
    with conn.cursor() as cur:
        cur.execute(
            "SELECT destination, attrs, weight, state FROM dispatcher WHERE setid = 1 ORDER BY id"
        )
        rows = cur.fetchall()
finally:
    conn.close()

sys.stdout.write(
    "dispatcher: set 1 -> "
    + ", ".join(
        f"{node or '?'}={uri} (weight {weight}{', inactive' if state == 1 else ''})"
        for uri, node, weight, state in rows
    )
    + "\n"
)
