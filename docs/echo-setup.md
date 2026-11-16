# Echo setup

Cortecho does not modify the Echo. It is a voice assistant client for
[echo-dot-assist](https://github.com/Gamer92000/echo-dot-assist), whose
`hassmic` daemon runs on a rooted Echo and exposes the ESPHome native API.

## What you need

- A supported Echo that is already rooted and running echo-dot-assist.
  Only the **Echo Dot 2nd gen** is tested by this project today; the same
  `hassmic` daemon runs on the other supported models, so they will probably
  work. Please report your model with the device-report issue template.
- `hassmic` in **ESPHome mode**: `PROTO=esphome` in
  `/data/local/hassmic/hassmic.conf`.
- `hassmic` reachable on TCP `26053` from the machine that runs Cortecho.
- A unique `NAME` in `hassmic.conf` when you run several Echos; hassmic's
  network uses it.
- The Echo's firewall (`lockdown.sh`) left as the project sets it. The Echo
  must be able to reach `REPLY_AUDIO_BASE_URL` on your LAN.

Follow the echo-dot-assist guide for rooting and installation. Do not disable
the firewall, and do not expose the Echo's ports beyond the LAN.

## The API key (optional but recommended)

The link can be plaintext or encrypted with an ESPHome API key. Use a key: it
encrypts the audio and it is the only way hassmic accepts its clock.

Set the key **once**, the way Home Assistant does when it adopts a device:

```bash
npm run echo-set-key -- --host 192.168.1.50 --env-file cortecho.env
```

The command generates a 32-byte key, sends it to the Echo, writes
`ECHO_API_KEY` into `cortecho.env` (mode 0600) and never prints it. Then add the
same key in the UI: **Echos → the Echo → Connection → API key**.

Changing the key later is a device change: remove
`/data/local/hassmic/state/api_key` on the Echo and restart hassmic, or re-run
the command. The app can log in with the all-zero key exactly once, while the
Echo has no key yet.

Consequences of a keyed link:

- hassmic refuses plaintext and any other key. The app reports
  `encryption-required` or `invalid-key` on the status page.
- The clock is set **only** over the keyed link.
- Device-admin messages (update install, adb switch, reset buttons) are never
  sent by Cortecho.

To undo, delete `/data/local/hassmic/state/api_key` on the Echo, restart
hassmic (`stop hassmic; start hassmic`) and use **Remove key** in the Echo's
Connection tab.

## The clock

hassmic asks for the time after it starts and every 6 hours. Cortecho answers
with the epoch and the POSIX rule of `assistant.timeZone`, and hassmic hands it
to root. Without a key the answer is ignored and the clock can fall back to
2010, which breaks HTTPS downloads on the Echo (for example wake-word models
from Amazon, with a certificate error).

If the status page shows **Clock sent: –** after an app restart, wait for
hassmic's next request (up to 6 hours) or restart hassmic. The Echo's clock
keeps running; this is not an error.

## Wake word

The firmware's wake word is "Alexa". The Echo's own settings page
(`http://<echo-ip>:28931`) can install Amazon's wake-word models, including
"Computer". In ESPHome mode, Home Assistant is normally the one that selects
the wake word; without it, write the chosen model to
`/data/local/hassmic/state/wake_word` and restart hassmic:

```bash
echo computer-en-US > /data/local/hassmic/state/wake_word
stop hassmic; start hassmic
```

`boot.log` then lists `wake word: computer-en-US "Computer" (en), active`.
Precedence is `state/wake_word` > `-m` in `hassmic.conf` > the firmware default.
Cortecho needs no change: `VoiceAssistantRequest.wake_word_phrase` carries the
real phrase.

A wake-word download from Amazon fails while the clock is wrong. Set the clock
first (a keyed link and a running Cortecho do it automatically).

## Several Echos

1. Give every Echo a unique `NAME` in `hassmic.conf`.
2. Add each one in the UI: **Echos → Add Echo**, with its address, port and
   key. A card must show *Connected · Encrypted* and a clock sync.
3. **Pair the Echos**: hold Volume up + Volume down for 2 s on the new Echo,
   then on one already in the network. Its settings page must show it as a
   member, not "outside". Without pairing, every Echo that hears the wake word
   answers.
4. Test from two rooms: only the nearer one should answer; the other's log
   shows `answered_elsewhere`.

Each Echo gets exactly one link from Cortecho. Do not run a second client (a
development server, Home Assistant) next to it: hassmic gives the voice
assistant to the first subscriber only. Disable the device in the UI first,
which closes its link.

## Small things that help on the device

- The Echo's shell is toybox, not busybox: there is no `awk`.
- hassmic is an init service: restart it with `stop hassmic; start hassmic`.
- File and log timestamps on the Echo are not real time while its clock is
  wrong.
- While root adb over Wi-Fi is unlocked, port 5555 is a passwordless root shell
  for the whole LAN until the unlock expires. Disconnecting does not close it
  early. Unlock only when you need it, and ask before changing anything.

## Troubleshooting

See [troubleshooting](troubleshooting.md).
