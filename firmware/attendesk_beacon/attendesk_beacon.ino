/* ===========================================================================
 * AttenDesk classroom beacon — ESP32 firmware
 * ---------------------------------------------------------------------------
 * One of these sits in each classroom and supports two teacher-selectable
 * transports. In Wi-Fi mode it polls Attendesk for a rotating code. In direct
 * Bluetooth mode a teacher provisions a short-lived session code through the
 * GATT characteristic, so campus Wi-Fi is not required.
 *
 * The advertised value is a rotating 8-byte code that changes every 30
 * seconds. That is what makes this different from a beacon broadcasting a
 * fixed room name: a code copied out of the room and sent to a friend at home
 * expires after the accepted time windows. A live relay is still possible;
 * Bluetooth alone cannot guarantee classroom presence.
 *
 * Board:    ESP32 / ESP32-C3 / ESP32-S3 (Arduino core 2.x or 3.x)
 * Library:  NimBLE-Arduino  (Library Manager -> "NimBLE-Arduino", h2zero)
 * Board URL: https://espressif.github.io/arduino-esp32/package_esp32_index.json
 *
 * Flash one board per room and change BEACON_CODE + BEACON_KEY each time.
 * Get both from the AttenDesk admin panel: Rooms & beacons -> Provision
 * beacon. The key is shown once; rotate it if you lose it.
 * ========================================================================= */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>     // Library Manager -> "ArduinoJson" (Benoit Blanchon)
#include <NimBLEDevice.h>
#include <time.h>

/* ----------------------------- CONFIGURE ME ----------------------------- */
static const char* WIFI_SSID     = "HBTU-Campus";
static const char* WIFI_PASSWORD = "change-me";

// Your deployed AttenDesk origin. Must be https:// in production.
static const char* API_BASE      = "https://attendesk.vercel.app";

// From the admin panel. Different on every board.
static const char* BEACON_CODE   = "ATTENDESK-210";
static const char* BEACON_KEY    = "paste-the-device-key-shown-once";
static const char* ROOM_LABEL    = "AD-210"; // ASCII, at most 11 bytes (scan-response budget).
// Paste the PEM root CA for your HTTPS deployment here. Never disable TLS verification.
static const char* ROOT_CA = R"PEM(PASTE_YOUR_ROOT_CA_CERTIFICATE_HERE)PEM";

static const char* FIRMWARE_VERSION = "1.2.0";
/* ------------------------------------------------------------------------ */

// Must match ATTENDESK_BLE_SERVICE in public/app.js and BleSessionManager.kt.
static const char* SERVICE_UUID        = "8d53dc1d-1db7-4cd3-868b-8a527460aa84";
static const char* CHARACTERISTIC_UUID = "d953c2d0-34d8-4d7b-94a7-2f54b42ea6d1";
static const char* IDENTITY_UUID       = "b61f7d38-4b2b-47e9-9b55-f5e50f8d4a31";

static const uint32_t IDLE_POLL_MS     = 5000;
static const uint32_t ACTIVE_POLL_MS   = 2000;
static const uint32_t WIFI_RETRY_MS    = 10000;

NimBLEServer*         bleServer         = nullptr;
NimBLECharacteristic* tokenCharacteristic = nullptr;
NimBLECharacteristic* identityCharacteristic = nullptr;
NimBLEAdvertising*    advertising       = nullptr;

bool     advertisingNow = false;
String   currentCode    = "";
uint32_t nextPollAt     = 0;
uint32_t pollInterval   = IDLE_POLL_MS;
bool     directActive   = false;
uint32_t directUntil    = 0;
uint32_t directNextRotation = 0;
uint8_t  directCodes[22][8];
uint8_t  directCodeCount = 0;
uint8_t  directCodeIndex = 0;

static void handleProvisioningWrite(NimBLECharacteristic* characteristic);

class ProvisioningCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo& connInfo) override {
    (void)connInfo;
    handleProvisioningWrite(characteristic);
  }
};

/* ---- helpers ------------------------------------------------------------ */

/** "a1b2…" (16 hex chars) -> 8 raw bytes, which is what goes on the air. */
static bool hexToBytes(const String& hex, uint8_t* out, size_t outLen) {
  if (hex.length() != outLen * 2) return false;
  for (size_t i = 0; i < outLen; i++) {
    char high = hex[i * 2];
    char low  = hex[i * 2 + 1];
    auto nibble = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    int h = nibble(high), l = nibble(low);
    if (h < 0 || l < 0) return false;
    out[i] = (uint8_t)((h << 4) | l);
  }
  return true;
}

static void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);           // BLE + Wi-Fi coexistence is steadier awake
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t deadline = millis() + WIFI_RETRY_MS;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
    delay(250);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? "\n[wifi] connected" : "\n[wifi] failed, will retry");
}

static void startBle() {
  NimBLEDevice::init(ROOM_LABEL);
  NimBLEDevice::setPower(0); // dBm; measure actual coverage, walls do not contain BLE.

  bleServer = NimBLEDevice::createServer();
  NimBLEService* service = bleServer->createService(SERVICE_UUID);
  tokenCharacteristic = service->createCharacteristic(
    CHARACTERISTIC_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE,
    512
  );
  tokenCharacteristic->setCallbacks(new ProvisioningCallbacks());
  tokenCharacteristic->setValue("");
  identityCharacteristic = service->createCharacteristic(IDENTITY_UUID, NIMBLE_PROPERTY::READ);
  identityCharacteristic->setValue(BEACON_CODE);
  service->start();

  advertising = NimBLEDevice::getAdvertising();
  advertising->enableScanResponse(true);
  NimBLEAdvertisementData scan;
  scan.addServiceUUID(NimBLEUUID(SERVICE_UUID));
  scan.setName(std::string(ROOM_LABEL).substr(0, 11));
  advertising->setScanResponseData(scan);
  NimBLEAdvertisementData idle;
  idle.setFlags(0x06);
  idle.addServiceUUID(NimBLEUUID(SERVICE_UUID));
  advertising->setAdvertisementData(idle);
  advertising->start();
  Serial.println("[ble] stack ready (idle provisioning advertisement active)");
}

/**
 * Publish a rotating code.
 *
 * It goes out two ways so both student clients work:
 *   service DATA  - the Android app reads this from a passive scan, no
 *                   connection needed, so 60 phones cost the beacon nothing.
 *   GATT read     - Chrome's Web Bluetooth cannot scan passively, so web
 *                   students connect briefly and read the characteristic.
 */
static void publishCode(const String& code) {
  uint8_t raw[8];
  if (!hexToBytes(code, raw, sizeof(raw))) {
    Serial.printf("[ble] rejected malformed code: %s\n", code.c_str());
    return;
  }
  tokenCharacteristic->setValue(raw, sizeof(raw));

  NimBLEAdvertisementData payload;
  payload.setFlags(0x06);
  payload.setServiceData(NimBLEUUID(SERVICE_UUID), std::string((char*)raw, sizeof(raw)));
  advertising->stop();
  advertising->setAdvertisementData(payload);
  advertisingNow = advertising->start();
  currentCode = code;
}

static void stopAdvertising() {
  advertising->stop();
  advertisingNow = false;
  currentCode = "";
  tokenCharacteristic->setValue("");
  NimBLEAdvertisementData idle;
  idle.setFlags(0x06);
  idle.addServiceUUID(NimBLEUUID(SERVICE_UUID));
  advertising->setAdvertisementData(idle);
  advertising->start();
  Serial.println("[ble] session advertisement stopped; provisioning remains discoverable");
}

static String encodedCode(const uint8_t* bytes) {
  static const char hex[] = "0123456789abcdef";
  char encoded[17];
  for (size_t index = 0; index < 8; index++) {
    encoded[index * 2] = hex[(bytes[index] >> 4) & 0x0f];
    encoded[index * 2 + 1] = hex[bytes[index] & 0x0f];
  }
  encoded[16] = '\0';
  return String(encoded);
}

/**
 * Direct-Bluetooth payload written by the teacher browser:
 *   byte 0      - protocol version (1)
 *   byte 1      - rotating-code count (1..22)
 *   bytes 2..3  - seconds remaining for the first code
 *   bytes 4..5  - total session lifetime in seconds
 *   remaining   - count consecutive raw 8-byte rotating codes
 *
 * A random or malicious token is harmless because the API accepts only the
 * hash stored for the teacher's active session. The local expiry prevents a
 * disconnected board from broadcasting an old valid token indefinitely.
 */
static void handleProvisioningWrite(NimBLECharacteristic* characteristic) {
  std::string value = characteristic->getValue();
  if (value.size() < 14) {
    Serial.printf("[ble-direct] rejected short payload length %u\n", (unsigned)value.size());
    return;
  }
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(value.data());
  uint8_t count = bytes[1];
  uint16_t firstSeconds = (uint16_t)bytes[2] | ((uint16_t)bytes[3] << 8);
  uint16_t totalSeconds = (uint16_t)bytes[4] | ((uint16_t)bytes[5] << 8);
  if (bytes[0] != 1 || count < 1 || count > 22 || value.size() != (size_t)(6 + count * 8) ||
      firstSeconds < 1 || firstSeconds > 30 || totalSeconds < 30 || totalSeconds > 600) {
    Serial.println("[ble-direct] rejected malformed provisioning package");
    return;
  }
  for (uint8_t codeIndex = 0; codeIndex < count; codeIndex++) {
    memcpy(directCodes[codeIndex], bytes + 6 + codeIndex * 8, 8);
  }
  directCodeCount = count;
  directCodeIndex = 0;
  directActive = true;
  directUntil = millis() + (uint32_t)totalSeconds * 1000UL;
  directNextRotation = millis() + (uint32_t)firstSeconds * 1000UL;
  publishCode(encodedCode(directCodes[0]));
  Serial.printf("[ble-direct] %u rotating codes provisioned for %u seconds\n", (unsigned)count, (unsigned)totalSeconds);
}

/** Ask the server what to do. Returns false on any network/parse failure. */
static bool poll() {
  if (WiFi.status() != WL_CONNECTED) return false;

  String url = String(API_BASE) + "/api/beacon/poll";
  HTTPClient http;
  WiFiClientSecure secure;
  secure.setCACert(ROOT_CA);

  bool began = url.startsWith("https://") && http.begin(secure, url);
  if (!began) return false;

  http.setTimeout(6000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Beacon-Code", BEACON_CODE);
  http.addHeader("X-Beacon-Key", BEACON_KEY);

  String body = String("{\"firmwareVersion\":\"") + FIRMWARE_VERSION + "\"}";
  int status = http.POST(body);

  if (status != 200) {
    Serial.printf("[api] poll failed: HTTP %d\n", status);
    if (status == 401 || status == 403) {
      Serial.println("[api] this beacon is not recognised or is disabled — check BEACON_CODE / BEACON_KEY");
      stopAdvertising();
    }
    http.end();
    return false;
  }

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, http.getString());
  http.end();
  if (error) {
    Serial.printf("[api] bad JSON: %s\n", error.c_str());
    return false;
  }

  pollInterval = (uint32_t)(doc["pollAfterSeconds"] | 5) * 1000UL;

  if (doc["advertise"] | false) {
    String code = doc["code"] | "";
    if (code.length() == 16 && code != currentCode) {
      publishCode(code);
      Serial.printf("[api] code rotated, %ds left in session\n", (int)(doc["secondsRemaining"] | 0));
    } else if (code.length() == 16 && !advertisingNow) {
      publishCode(code);
    }
  } else {
    if (advertisingNow) Serial.printf("[api] idle (%s)\n", (const char*)(doc["reason"] | "NO_ACTIVE_SESSION"));
    stopAdvertising();
  }
  return true;
}

static void reportBoot() {
  if (WiFi.status() != WL_CONNECTED) return;
  String url = String(API_BASE) + "/api/beacon/event";
  HTTPClient http;
  WiFiClientSecure secure;
  secure.setCACert(ROOT_CA);
  if (!url.startsWith("https://") || !http.begin(secure, url)) return;
  http.setTimeout(6000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Beacon-Code", BEACON_CODE);
  http.addHeader("X-Beacon-Key", BEACON_KEY);
  http.POST(String("{\"event\":\"boot\",\"detail\":\"firmware ") + FIRMWARE_VERSION + "\"}");
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\nAttenDesk beacon %s (firmware %s)\n", BEACON_CODE, FIRMWARE_VERSION);
  startBle();
  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  reportBoot();
  nextPollAt = millis();
}

void loop() {
  while (directActive && directCodeIndex + 1 < directCodeCount && (int32_t)(millis() - directNextRotation) >= 0) {
    directCodeIndex++;
    publishCode(encodedCode(directCodes[directCodeIndex]));
    directNextRotation += 30000UL;
    Serial.printf("[ble-direct] rotated to code %u/%u\n", (unsigned)(directCodeIndex + 1), (unsigned)directCodeCount);
  }
  if (directActive && (int32_t)(millis() - directUntil) >= 0) {
    directActive = false;
    directCodeCount = 0;
    stopAdvertising();
    Serial.println("[ble-direct] session expired");
  }
  if (WiFi.status() != WL_CONNECTED) {
    // Wi-Fi mode fails closed. A directly provisioned token remains valid only
    // until its local deadline and therefore survives a campus Wi-Fi outage.
    if (!directActive && advertisingNow) stopAdvertising();
    connectWifi();
    delay(1000);
    return;
  }
  if (!directActive && (int32_t)(millis() - nextPollAt) >= 0) {
    bool ok = poll();
    if (!ok) stopAdvertising();
    nextPollAt = millis() + (ok ? pollInterval : IDLE_POLL_MS);
  }
  // A BLE connection stops advertising. Resume after it disconnects.
  if (!advertising->isAdvertising() && bleServer->getConnectedCount() == 0) advertising->start();
  delay(50);
}
