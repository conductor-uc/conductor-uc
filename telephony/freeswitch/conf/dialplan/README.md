Deliberately empty. Dialplan resolution is 100% dynamic, via `mod_xml_curl`
against telephony-config (see `../autoload_configs/xml_curl.conf.xml`) — a
local XML file here would be dead weight nothing ever reads (D-006). The real
`from-ext`/`from-trunk`/`internal-app` contexts (03 §3.2) arrive in S1-13.
