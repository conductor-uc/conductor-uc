# Sizing: how many calls a server carries

This page gives measured CPU cost per call, for media servers (FreeSWITCH) and for the edge (OpenSIPs with the media relay), and shows how to turn it into a server count. The figures come from the capacity benchmark (plan task S4-09, `tests/sip/bench`).

Read [what these figures are not](#3-what-these-figures-are-not) before you buy hardware from them.

## 1. Measured cost per call

Measured 2026-09-30 on the development stack: one machine (Intel Core i5-9400, 6 cores at 2.9 GHz, no hyper-threading, 11 GB RAM) running every component in Docker, and the load generator too. Each workload held 30 or 40 calls up at once for 30 s with audio flowing both ways. Each was run five or more times over about two hours.

"Calls per vCPU" is how many calls one core carries at 80% use, leaving the rest for bursts. The range is the lowest and highest of all runs. It is wide: the same workload cost about a quarter more in the later runs than in the earlier ones, on the same machine with the same code. Plan with the low end, which is the last column.

### Media server (FreeSWITCH)

| Workload | One core, per call | Calls per vCPU at 80% | Use for planning |
|---|---|---|---|
| G.711 call between two phones | 0.49–0.72% | 111–161 | **110** |
| The same, recorded | 0.63–0.81% | 98–127 | **95** |
| Opus on one side, G.711 on the other (transcoded) | 1.71–2.33% | 34–46 | **34** |
| Audio conference, per participant (G.711) | 0.63–0.76% | 104–127 | **100** |

- **Recording** adds about a quarter to a call's cost on the media server (13–35% within the same run). The upload to object storage happens after the call and is not in this figure.
- **Transcoding** costs three to three and a half times a plain call in the same run. See [§4](#4-when-a-call-is-transcoded) for when it happens.
- **Conference** participants were measured with two media servers. The room is on one; a participant whose call the edge sent to the other is bridged across, which costs a call's two legs there. Half the participants were bridged this way, and the figure includes it. With one media server the cost per participant is lower; with more than two, a larger share is bridged and it is somewhat higher.

### Edge (OpenSIPs and the media relay)

Every call's audio passes through the active edge server (S4-10), so the edge is sized for calls too.

| Workload | One core, per call | Calls per vCPU at 80% | Use for planning |
|---|---|---|---|
| A call with two legs through the edge (phone to phone, recorded or not, transcoded or not) | 0.27–1.05% | 76–295 | **75** |
| A call with one leg through the edge (a conference participant, a caller in an IVR or voicemail) | 0.16–0.69% | 115–491 | **115** |

The edge figures vary far more between runs than the media server's. The likely reason is the edge's own health checks, which use a noticeable share of a core on this machine in bursts and would land in some samples and not others; this was not confirmed.

Only the **active** edge carries calls. The standby must be the same size, because it takes all of them at failover.

## 2. Working out a server count

1. Estimate the busiest moment: calls up at once, and how many of them are recorded, transcoded, or in conferences.
2. Media servers: divide each kind by its planning figure and add up the vCPUs. Add one more media server than that needs, so the platform carries the load with one server down ([04 §2](../architecture/04-high-availability.md)).
3. Edge: divide the calls by 75. Both edge servers get that many vCPUs.
4. Leave two vCPUs on every server for the operating system and everything that is not a call. This allowance is a rule of thumb, not a measurement.

**Example.** 600 calls at the busiest moment: 400 plain, 150 recorded, 50 transcoded.

| | Calculation | vCPUs |
|---|---|---|
| Plain | 400 ÷ 110 | 3.6 |
| Recorded | 150 ÷ 95 | 1.6 |
| Transcoded | 50 ÷ 34 | 1.5 |
| **Media, total** | | **6.7** |
| **Edge** | 600 ÷ 75 | **8.0** |

- Media: two servers with 4 vCPUs for calls each would carry it, so run **three** servers of 4 + 2 = 6 vCPUs.
- Edge: **two** servers (active and standby) of 8 + 2 = 10 vCPUs each.

Registrations, presence and the web console were not part of this benchmark. The application and data servers are not sized here: nothing has measured them yet.

## 3. What these figures are not

- **Not a ceiling test.** The benchmark ran 30 to 40 calls and measured what each cost. The per-vCPU figures assume the cost stays the same per call as the count rises. Nothing was run up to the point of failure, and audio quality under load was not measured.
- **One machine, one CPU model.** A server core that is slower or faster than this one carries fewer or more calls. Cloud vCPUs are often hyper-threads, which carry less than a full core.
- **Everything shared one machine.** The load generator, the databases and every service ran beside the media servers and the edge. That adds noise, most visibly in the edge figures.
- **The media relay ran in userspace.** RTPengine can forward packets in the kernel, which costs far less; the images here do not use that. The edge figures are for userspace forwarding.
- **CPU only.** Memory, network and disk were not measured. A G.711 call between two phones is four audio streams in and four out at the edge, about 320 kbit/s each way; 600 such calls are about 200 Mbit/s in and the same out.
- **G.711 and Opus only**, with 20 ms packets, no video, no encryption of media (SRTP).

Measure your own hardware before a large deployment: on a machine with Docker and this repository, `pnpm --filter @cuc/tests-sip bench` runs the four workloads against the development stack in about four minutes and writes what it measured to `tests/sip/bench-results/`.

## 4. When a call is transcoded

The platform answers a caller with the first codec on the caller's own list that it supports (Opus, G.722, G.711). It then offers the called side that codec first, followed by the rest of its list (G-134).

- **The called side speaks the caller's codec:** it answers with it, both legs use the same codec, and nothing is converted. This is the plain call's cost. It is the usual case when every phone is of one kind, and for any call where the caller uses G.711, which everything speaks.
- **The called side does not:** it answers with another codec and the media server converts every packet each way, at the transcoded cost. The usual case is a softphone on Opus calling a desk phone or a carrier that speaks only G.711.

A phone that is offered several codecs may also pick one of its own favourites rather than the first offered, and so cause a conversion that was not needed. If many calls are transcoded without a reason you can see, look at the codec order configured on the phones.

Audio is also converted on a media server in these cases, which the benchmark did not measure separately:

- conferences whose participants use different codecs;
- prompts, music on hold, voicemail and recording for a caller using Opus.

To plan, estimate the share of calls between an Opus endpoint and a G.711-only one, and count those at the transcoded figure.
