# Sizing: how many calls a server carries

This page gives measured CPU cost per call, for media servers (FreeSWITCH) and for the edge (OpenSIPs with the media relay), and shows how to turn it into a server count. The figures come from the capacity benchmark (plan task S4-09, `tests/sip/bench`).

Read [what these figures are not](#3-what-these-figures-are-not) before you buy hardware from them.

## 1. Measured cost per call

Measured 2026-09-30, three runs, on the development stack: one machine (Intel Core i5-9400, 6 cores at 2.9 GHz, no hyper-threading, 11 GB RAM) running every component in Docker, and the load generator too. Each workload held 30 or 40 calls up at once for 30 s with audio flowing both ways.

"Calls per vCPU" is how many calls one core carries at 80% use, leaving the rest for bursts. The range is the lowest and highest of the three runs.

### Media server (FreeSWITCH)

| Workload | One core, per call | Calls per vCPU at 80% | Use for planning |
|---|---|---|---|
| G.711 call between two phones | 0.50–0.55% | 145–161 | **145** |
| The same, recorded | 0.63–0.68% | 118–127 | **118** |
| Opus on one side, G.711 on the other (transcoded) | 1.71–1.85% | 43–46 | **43** |
| Audio conference, per participant (G.711) | 0.63% | 126–127 | **126** |

- **Recording** adds about a quarter to a call's cost on the media server. The upload to object storage happens after the call and is not in this figure.
- **Transcoding** costs about three and a half times a plain call. See [§4](#4-when-a-call-is-transcoded) for when it happens.
- **Conference** participants were measured with two media servers. The room is on one; a participant whose call the edge sent to the other is bridged across, which costs a call's two legs there. Half the participants were bridged this way, and the figure includes it. With one media server the cost per participant is lower; with more than two, a larger share is bridged and it is somewhat higher.

### Edge (OpenSIPs and the media relay)

Every call's audio passes through the active edge server (S4-10), so the edge is sized for calls too.

| Workload | One core, per call | Calls per vCPU at 80% | Use for planning |
|---|---|---|---|
| A call with two legs through the edge (phone to phone, recorded or not, transcoded or not) | 0.40–0.72% | 111–200 | **110** |
| A call with one leg through the edge (a conference participant, a caller in an IVR or voicemail) | 0.16–0.55% | 145–490 | **145** |

The edge figures vary much more between runs than the media server's. Plan with the low end.

Only the **active** edge carries calls. The standby must be the same size, because it takes all of them at failover.

## 2. Working out a server count

1. Estimate the busiest moment: calls up at once, and how many of them are recorded, transcoded, or in conferences.
2. Media servers: divide each kind by its planning figure and add up the vCPUs. Add one more media server than that needs, so the platform carries the load with one server down ([04 §2](../architecture/04-high-availability.md)).
3. Edge: divide the calls by 110. Both edge servers get that many vCPUs.
4. Leave two vCPUs on every server for the operating system and everything that is not a call. This allowance is a rule of thumb, not a measurement.

**Example.** 600 calls at the busiest moment: 400 plain, 150 recorded, 50 transcoded.

| | Calculation | vCPUs |
|---|---|---|
| Plain | 400 ÷ 145 | 2.8 |
| Recorded | 150 ÷ 118 | 1.3 |
| Transcoded | 50 ÷ 43 | 1.2 |
| **Media, total** | | **5.2** |
| **Edge** | 600 ÷ 110 | **5.5** |

- Media: two servers with 4 vCPUs for calls each would carry it, so run **three** servers of 4 + 2 = 6 vCPUs.
- Edge: **two** servers (active and standby) of 6 + 2 = 8 vCPUs each.

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

As the platform is built today, a media server **does not transcode a call between two phones**. It offers the called phone the one codec the caller ended up with, and nothing else. So both sides of such a call always use the same codec, at the plain call's cost. This was observed for calls between phones; the leg to a carrier is set up the same way and was not checked.

That also means a call can fail where transcoding would have saved it: a caller whose phone prefers Opus reaches a phone that only speaks G.711, which is offered Opus alone. This is recorded as an open gap (G-134 in `docs/decisions.md`). Whichever way it is closed, the transcoded figure above is what a transcoded call will cost a media server.

Audio is converted on a media server today in these cases, which the benchmark did not measure separately:

- conferences whose participants use different codecs;
- prompts, music on hold, voicemail and recording for a caller using Opus.

The transcoded figure was measured with calls the media server placed itself, Opus to one phone and G.711 to another, so that it converted every packet each way.
