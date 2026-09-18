/* ===========================================================================
 * AttenDesk classroom beacon — ESP32 firmware
 * ---------------------------------------------------------------------------
 * One of these sits in each classroom. It holds no attendance secret of its
 * own. Every two seconds it asks the AttenDesk server "should I be
 * broadcasting, and if so, what?" and advertises exactly what it is told.
 *
 * The advertised value is a rotating 8-byte code that changes every 30
 * seconds. That is what makes this different from a beacon broadcasting a
 * fixed room name: a code copied out of the room and sent to a friend at home
 * stops working within one rotation, so it cannot be used for proxy
 * attendance.
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

/* ----------------------------- CONFIGURE ME ----------------------------- */
static const char* WIFI_SSID     = "HBTU-Campus";
static const char* WIFI_PASSWORD = "change-me";

// Your deployed AttenDesk origin. Must be https:// in production.
static const char* API_BASE      = "https://attendesk.vercel.app";

// From the admin panel. Different on every board.
static const char* BEACON_CODE   = "ATTENDESK-210";
static const char* BEACON_KEY    = "paste-the-device-key-shown-once";

static const char* FIRMWARE_VERSION = "1.0.0";
/* ------------------------------------------------------------------------ */

// Must match ATTENDESK_BLE_SERVICE in public/app.js and BleSessionManager.kt.
static const char* SERVICE_UUID        = "8d53dc1d-1db7-4cd3-868b-8a527460aa84";
static const char* CHARACTERISTIC_UUID = "d953c2d0-34d8-4d7b-94a7-2f54b42ea6d1";

static const uint32_t IDLE_POLL_MS     = 5000;
static const uint32_t ACTIVE_POLL_MS   = 2000;
static const uint32_t WIFI_RETRY_MS    = 10000;

NimBLEServer*         bleServer         = nullptr;
NimBLECharacteristic* tokenCharacteristic = nullptr;
NimBLEAdvertising*    advertising       = nullptr;

bool     advertisingNow = false;
String   currentCode    = "";
uint32_t nextPollAt     = 0;
uint32_t pollInterval   = IDLE_POLL_MS;

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
  NimBLEDevice::init(String("AttenDesk ").concat(BEACON_CODE).c_str());
  NimBLEDevice::setPower(ESP_PWR_LVL_P6);   // ~+6 dBm: room-sized, not corridor-sized

  bleServer = NimBLEDevice::createServer();
  NimBLEService* service = bleServer->createService(SERVICE_UUID);
  tokenCharacteristic = service->createCharacteristic(CHARACTERISTIC_UUID, NIMBLE_PROPERTY::READ);
  tokenCharacteristic->setValue("");
  service->start();

  advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  Serial.println("[ble] stack ready (idle, not advertising)");
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
  advertising->setAdvertisementData(payload);

  if (!advertisingNow) {
    advertising->start();
    advertisingNow = true;
    Serial.println("[ble] advertising started");
  }
  currentCode = code;
}

static void stopAdvertising() {
  if (!advertisingNow) return;
  advertising->stop();
  advertisingNow = false;
  currentCode = "";
  tokenCharacteristic->setValue("");
  Serial.println("[ble] advertising stopped");
}

/** Ask the server what to do. Returns false on any network/parse failure. */
static bool poll() {
  if (WiFi.status() != WL_CONNECTED) return false;

  String url = String(API_BASE) + "/api/beacon/poll";
  HTTPClient http;
  WiFiClientSecure secure;
  secure.setInsecure();   // See firmware/README.md before a real deployment.

  bool began = url.startsWith("https") ? http.begin(secure, url) : http.begin(url);
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
  secure.setInsecure();
  if (!(url.startsWith("https") ? http.begin(secure, url) : http.begin(url))) return;
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
  connectWifi();
  startBle();
  reportBoot();
  nextPollAt = millis();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    // Never keep advertising a code we can no longer confirm is current.
    stopAdvertising();
    connectWifi();
    delay(1000);
    return;
  }
  if ((int32_t)(millis() - nextPollAt) >= 0) {
    bool ok = poll();
    nextPollAt = millis() + (ok ? pollInterval : IDLE_POLL_MS);
  }
  delay(50);
}
