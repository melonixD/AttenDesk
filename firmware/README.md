# AttenDesk ESP32 classroom beacon

One ESP32 per classroom. It never sees a student, subject or roster. Firmware
1.2 supports two teacher-selectable transports:

- **Automatic Wi-Fi:** the existing mode; the ESP32 polls Attendesk and receives
  the current rotating code.
- **Direct Bluetooth:** the teacher's Chrome/Edge browser sends the board a
  pre-authorised sequence of 30-second rotating codes. Campus Wi-Fi is not
  required, but the teacher and students still need internet/mobile data to
  reach the Attendesk API.

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
| Campus Wi-Fi | Optional in Direct Bluetooth mode; 2.4 GHz required for Automatic Wi-Fi mode |

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
   `BEACON_CODE`, `BEACON_KEY`, `ROOM_LABEL` and `ROOT_CA`. Use an HTTPS URL.
4. Flash. The serial monitor at 115200 baud should print `[ble] stack ready`.
   With Wi-Fi available it also prints `[wifi] connected` and polls every few
   seconds. Without Wi-Fi it remains discoverable for direct provisioning.
5. Mount it near the middle of the room, not next to the shared wall.

The beacon turns green in **Rooms & beacons** within about a minute.

## Before a real deployment

TLS verification is required. Replace the `ROOT_CA` placeholder with the current
root CA PEM for your actual API hostname's certificate chain; do not guess the
issuer from the hosting provider. NTP must be reachable for certificate validation.
See `../START-HERE.md` for dependency versions and the full setup checklist.

## Behaviour worth knowing

- In Automatic Wi-Fi mode, a Wi-Fi failure stops the active session
  advertisement and fails closed.
- In Direct Bluetooth mode, the browser verifies the board's registered beacon
  code, writes a maximum ten-minute package, and the board rotates codes every
  30 seconds using its local timer. It clears the package automatically when
  the attendance window expires.
- Direct Bluetooth requires the teacher website to run over HTTPS in a browser
  with Web Bluetooth (Chrome or Edge on a supported platform). Safari and
  Firefox cannot provision the board; choose Automatic Wi-Fi there.
- Transmit power starts at 0 dBm. Calibrate on site using NimBLE 2.x dBm values.
  Bluetooth crosses walls; power settings cannot enforce classroom boundaries.
- Web Bluetooth students connect over GATT one at a time. A single ESP32 handles
  a handful of concurrent connections, so a 60-student class will serialise.
  Test this with your real class size before trusting it — the Android app path
  scans passively and does not have this limit.
