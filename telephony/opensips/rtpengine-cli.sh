#!/bin/sh
# S4-10: one command to the local RTPengine's CLI (what rtpengine-ctl sends).
# keepalived runs `active` when this edge takes the floating addresses, so the
# relay owns the calls it was following from the other edge (and times them
# out, deletes them, answers for them), and `standby` when it gives them up.
set -eu
python3 - "$@" <<'PY'
import os, socket, sys
port = int(os.environ.get("RTPENGINE_CLI_PORT", "9900"))
with socket.create_connection(("127.0.0.1", port), timeout=3) as s:
    s.sendall((" ".join(sys.argv[1:]) + "\n").encode())
    s.shutdown(socket.SHUT_WR)
    print(s.makefile().read(), end="")
PY
