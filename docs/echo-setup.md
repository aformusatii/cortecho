# Echo setup

Cortecho does not modify the Echo. It is a voice assistant client for
[echo-dot-assist](https://github.com/Gamer92000/echo-dot-assist), whose
`hassmic` daemon runs on a rooted Echo and exposes the ESPHome native API.

## Ready for Cortecho?

Check these first; the setup wizard checks what it can and says in plain words
what is missing.

- A supported Echo that is already rooted and running echo-dot-assist. Only the
  **Echo Dot 2nd gen** is tested by this project today; the same `hassmic`
  daemon runs on the other supported models, so they will probably work. Please
  report your model with the device-report issue template.
- `hassmic` in **ESPHome mode**: `PROTO=esphome` in
  `/data/local/hassmic/hassmic.conf`.
- `hassmic` reachable on TCP `26053` from the machine that runs Cortecho, on the
  same network.
- A unique `NAME` in `hassmic.conf` when you run several Echos; hassmic's
  network uses it.
- The Echo's firewall (`lockdown.sh`) left as the project sets it. The Echo
  must be able to reach this computer on your LAN (the **Reply address** in
  Settings → Network).
- Nothing else subscribed to the Echo's voice assistant (Home Assistant or a
  second Cortecho). hassmic gives it to the first subscriber only.

Follow the echo-dot-assist guide for rooting and installation. Do not disable
the firewall, and do not expose the Echo's ports beyond the LAN.

Then start Cortecho, open the UI and use **Setup** (or the Discovered card on
the Echos page): it finds the Echo, secures the link and plays a test sound.

<a id="the-api-key"></a>

## Securing the Echo

The link can be plaintext or encrypted with a key. Use a key: it encrypts the
audio and it is the only way hassmic accepts its clock.

**Adding the Echo secures it.** In **Setup** (or **Echos → Add Echo**, or the
Echo's Discovered card), Cortecho generates a 32-byte key, stores it before
sending it, and sets it on the Echo the way Home Assistant adopts a device. The
key is never shown in the browser, never printed and never logged; there is no
separate "Secure" button. Nothing else on the Echo changes.

If another app (often Home Assistant) already set a key on the Echo, the wizard
says so. Paste that key there, or remove it on the Echo and try again.

**CLI fallback** for a headless install or a rescue; it shares the same
handshake code as the wizard:

```bash
npm run echo-set-key -- --host 192.168.1.50 --env-file cortecho.env
```

The command generates a 32-byte key, sends it to the Echo, writes
`ECHO_API_KEY` into `cortecho.env` (mode 0600) and never prints it. Add the Echo
in the UI: a fresh install imports the file, or paste the value under
**Connection → Advanced**. Removing a key, changing it or re-keying stays a
device change: Cortecho never rotates or clears it from the app.

Consequences of a keyed link:

- hassmic refuses plaintext and any other key. The app reports
  `encryption-required` or `invalid-key` on the status page, with a **Fix**
  action that opens the "already secured" step.
- The clock is set **only** over the keyed link.
- Device-admin messages (update install, adb switch, reset buttons) are never
  sent by Cortecho.

To remove a key, delete `/data/local/hassmic/state/api_key` on the Echo and
restart hassmic (`stop hassmic; start hassmic`), then use **Forget the key in
Cortecho** in the Echo's Connection tab (it only forgets it here; the Echo's
key is already gone).

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
2. Open **Setup** (always in the main nav) or the **Echos** page. A new Echo
   appears as a **Discovered** card within a minute: click **Add**, hear the
   sound, pick a room. Discovery can miss an Echo (another subnet, a bridge
   network without mDNS); **Setup** always offers **Enter an address instead**,
   and **Search again**. A card must show *Connected · Secured* and a clock
   sync.
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
