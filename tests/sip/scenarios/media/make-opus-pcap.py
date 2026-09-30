#!/usr/bin/env python3
"""S4-09: turns an Ogg Opus file into a pcap of RTP packets (payload type 102,
the one FreeSWITCH offers Opus under, 20 ms each), for SIPp's `play_pcap_audio`
in the transcoding benchmark. SIPp rewrites the addresses and ports as it
sends; only the RTP payloads, their payload type and their timing matter.

  ffmpeg -f lavfi -i sine=frequency=440:duration=40 -ar 48000 -ac 1 \\
    -c:a libopus -b:a 24k -frame_duration 20 -application voip -f ogg tone.ogg
  python3 make-opus-pcap.py tone.ogg opus-440hz-40s.pcap
"""
import struct
import sys


def ogg_packets(data):
    """Yields each Ogg packet (a packet may span pages)."""
    pos, partial = 0, b""
    while pos < len(data):
        if data[pos:pos + 4] != b"OggS":
            raise ValueError("not an Ogg page at %d" % pos)
        segments = data[pos + 26]
        table = data[pos + 27:pos + 27 + segments]
        body = pos + 27 + segments
        for size in table:
            partial += data[body:body + size]
            body += size
            if size < 255:
                yield partial
                partial = b""
        pos = body


def main(src, dst):
    packets = list(ogg_packets(open(src, "rb").read()))
    audio = [p for p in packets if not p.startswith((b"OpusHead", b"OpusTags"))]
    with open(dst, "wb") as out:
        # pcap global header: Ethernet link type.
        out.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
        src_ip, dst_ip = bytes([10, 0, 0, 1]), bytes([10, 0, 0, 2])
        for i, payload in enumerate(audio):
            rtp = struct.pack("!BBHII", 0x80, 102, i & 0xFFFF, (i * 960) & 0xFFFFFFFF, 0x0C0FFEE0) + payload
            udp = struct.pack("!HHHH", 6000, 6002, 8 + len(rtp), 0) + rtp
            ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(udp), i & 0xFFFF, 0, 64, 17, 0, src_ip, dst_ip) + udp
            frame = b"\x00" * 12 + b"\x08\x00" + ip
            t_us = i * 20000
            out.write(struct.pack("<IIII", t_us // 1000000, t_us % 1000000, len(frame), len(frame)))
            out.write(frame)
    print("%d packets" % len(audio))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
