# AttenDesk ESP32 classroom beacon

One ESP32 per classroom. It is a dumb relay: it asks the server what to
broadcast and broadcasts that. It never sees a student, a subject or a roster,
and it stores no attendance secret.

## Why not just broadcast "ATTENDESK_ROOM_210"?

Because any student with a `$5` board or a BLE spoofing app could rebroadcast
that string from their hostel room and mark themselves present forever. The
server instead issues a code derived from the session and the current 30-second
window. A code that leaves the room is worthless almost immediately.

## Parts per room

| Item | Note |
|---|---|
| ESP32 dev board | ESP32-WROOM-32, ESP32-C3 or ESP32-S3 all work |
| 5 V USB supply | Any phone charger; the board draws well under 0.5 A |
| Campus Wi-Fi | 2.4 GHz. ESP32 does **not** join 5 GHz-only networks |

## One-time setup

1. Arduino IDE → **Preferences → Additional board URLs**:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. **Tools → Board → Boards Manager** → install *esp32 by Espressif*.
3. **Library Manager** → install **NimBLE-Arduino** and **ArduinoJson**.

## Per board

1. In AttenDesk: **Rooms & beacons → Add classroom**, then **Provision beacon**.
   Use the code `ATTENDESK-<room>`, e.g. `ATTENDESK-210`.
2. Copy the device key shown. **It is displayed once.** Only its hash is stored.
3. In `attendesk_beacon.ino` set `WIFI_SSID`, `WIFI_PASSWORD`, `API_BASE`,
   `BEACON_CODE` and `BEACON_KEY`.
4. Flash. The serial monitor at 115200 baud should print `[wifi] connected`,
   `[ble] stack ready` and then a poll every few seconds.
5. Mount it near the middle of the room, not next to the shared wall.

The beacon turns green in **Rooms & beacons** within about a minute.

## Before a real deployment

`secure.setInsecure()` skips TLS certificate verification. It is fine on a
closed campus pilot and it is what lets the board talk to a Vercel host without
a bundled root store, but it means a machine-in-the-middle on campus Wi-Fi could
impersonate the server. Before you rely on this for real attendance records,
replace it with a pinned root certificate:

```cpp
static const char* ROOT_CA = "-----BEGIN CERTIFICATE-----\n...";
secure.setCACert(ROOT_CA);
```

Use the root CA of whatever host `API_BASE` points at (ISRG Root X1 for
Let's Encrypt, Baltimore/DigiCert for Vercel). Also set a real NTP time source
if you pin, because certificate validation needs a correct clock.

## Behaviour worth knowing

- If Wi-Fi drops, the beacon **stops advertising**. It will not keep publishing
  a code it can no longer confirm is current.
- Transmit power is set to about +6 dBm so the signal covers a room rather than
  a corridor. If students at the back cannot connect, raise it to
  `ESP_PWR_LVL_P9`; if the class next door can see it, drop to `ESP_PWR_LVL_P3`.
- Web Bluetooth students connect over GATT one at a time. A single ESP32 handles
  a handful of concurrent connections, so a 60-student class will serialise.
  Test this with your real class size before trusting it — the Android app path
  scans passively and does not have this limit.
