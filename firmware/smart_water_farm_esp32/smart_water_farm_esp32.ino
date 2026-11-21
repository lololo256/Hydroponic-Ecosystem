/*
 * ==============================================================================
 * Smart Water Farm (Hydroponic) - REAL BOARD firmware
 * File    : smart_water_farm_esp32.ino
 * Target  : ESP32-S3-WROOM-1 N16R8 (16MB flash, 8MB octal PSRAM) - board "s3-real"
 * Owner   : firmware team (Cyber-Rune Forge)
 * Contract: To-dolist/CONTRACT_v3.md (telemetry / attributes / RPC / BLE)
 *
 * Arduino IDE -> Tools (MUST match, otherwise the sketch does not fit / no Serial):
 *   Board            : ESP32S3 Dev Module
 *   USB CDC On Boot  : Enabled           (UART0 is not wired, log goes over native USB)
 *   Flash Size       : 16MB (128Mb)
 *   PSRAM            : OPI PSRAM
 *   Partition Scheme : 16M Flash (3MB APP/9.9MB FATFS)
 *
 * ZERO-MOCK: this firmware contains NO simulation and NO random sensor values.
 *   A sensor that cannot be read correctly is simply omitted from telemetry
 *   (the key is not sent). esp_random() is used ONLY for the claim secret,
 *   the BLE verify code and network back-off jitter - never for sensor data.
 *
 * Hardware (from the EasyEDA schematic - physical pins, NOT the net-label names):
 *   DS18B20 data ............ IO39  (4.7k pull-up on board)
 *   Float switch (main tank)  IO40  (external pull-up, switch to GND)
 *   I2C SDA / SCL ........... IO16 / IO15  (ADS1115 @0x48 + OLED SH1106 @0x3C)
 *   pH module (NA520+NA521) . ADS1115 A0
 *   TDS/EC module ........... ADS1115 A1
 *   Relays (NPN, active-HIGH) IO10 PUMP1=A, IO11 PUMP2=B, IO12 PUMP3=pH-up, IO13 PUMP4=pH-down, IO14 PUMP5=main
 *   RGB status LED .......... IO4 R / IO5 G / IO6 B
 *   BOOT button ............. IO0
 *   NEVER use GPIO26-32 (flash) or GPIO33-37 (octal PSRAM) on N16R8.
 * ==============================================================================
 */

#include <Arduino.h>

#if !CONFIG_IDF_TARGET_ESP32S3
#error "smart_water_farm_esp32 targets ESP32-S3-WROOM-1 N16R8 only. Select 'ESP32S3 Dev Module' in Tools > Board."
#endif

#include <Wire.h>
#include <WiFi.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_timer.h>
#include <esp_task_wdt.h>
#include <esp_mac.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <math.h>
#include <string.h>
#include <FFat.h>        // offline log on the 9.9 MB FATFS partition (app3M_fat9M_16MB)
#include <time.h>
#include <sys/time.h>

// ---- secrets.h (never committed). Fallback keeps the sketch compiling. -------
#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "secrets.h not found: copy secrets.example.h to secrets.h and fill in the ThingsBoard token. Board will not connect to the cloud."
#endif
#ifndef DEFAULT_TB_TOKEN
#define DEFAULT_TB_TOKEN ""
#endif
#ifndef DEFAULT_TB_SERVER
#define DEFAULT_TB_SERVER "eu.thingsboard.cloud"
#endif

// ---- Optional libraries -------------------------------------------------------
// IMPORTANT (verified by compiling with arduino-cli / Arduino IDE 2):
// `#if __has_include(<OneWire.h>)` is ALWAYS false for third-party libraries in the
// Arduino build, because the library resolver only adds a library's include path
// after it sees a plain `#include`. A __has_include guard therefore silently
// disables the sensor even when the library IS installed (temp would never be sent).
// So optional libraries are switched with explicit USE_* defines instead:
//   1 = library required (installed on the boss's PC: OneWire 2.3.8,
//       DallasTemperature 4.0.6, Adafruit SH110X 2.1.15, Adafruit GFX 1.13.0)
//   0 = build without it (compile no longer needs the library)
// If the compile fails with "OneWire.h: No such file", either install the library
// (Library Manager) or set the matching USE_* to 0.
#define USE_DS18B20 1
#define OLED_SH1106 1   // 1 = OLED 128x64 @0x3C present, 0 = no OLED
#define OLED_IS_SSD1306 1  // 1 = SSD1306 0.96" (Adafruit_SSD1306), 0 = SH1106G 1.3" (Adafruit_SH110X)

#if USE_DS18B20
#include <OneWire.h>
#include <DallasTemperature.h>
#define HAS_DS18B20 1
#else
#define HAS_DS18B20 0
#warning "USE_DS18B20 = 0: temperature is never sent (key omitted), sensor_ok stays false."
#endif

#if OLED_SH1106
#include <Adafruit_GFX.h>
#if OLED_IS_SSD1306
#include <Adafruit_SSD1306.h>
#define OLED_WHITE SSD1306_WHITE
#define OLED_BLACK SSD1306_BLACK
#else
#include <Adafruit_SH110X.h>
#define OLED_WHITE SH110X_WHITE
#define OLED_BLACK SH110X_BLACK
#endif
#define HAS_OLED 1
#else
#define HAS_OLED 0
#warning "OLED_SH1106 = 0: no display - pairing claim code / verify code cannot be shown on the board."
#endif

// QR code generator (ricmoo qrcode.c/.h copied into this sketch folder)
#if __has_include("qrcode.h")
#include "qrcode.h"
#endif
#if defined(ECC_LOW) && defined(MODE_BYTE)
#define HAS_QR 1
#else
#define HAS_QR 0
#endif

// ------------------------------------------------------------------------------
// 1. Pin map (ESP32-S3-WROOM-1 N16R8, from schematic)
// ------------------------------------------------------------------------------
#define PIN_ONEWIRE_TEMP 39   // DS18B20 (4.7k pull-up on board)
#define PIN_FLOAT_MAIN 40     // single float switch, external pull-up
#define FLOAT_WATER_PRESENT_LEVEL LOW  // switch closes to GND when water is present (change if NC wiring)
#define HAS_FLOAT_SWITCH 1

#define PIN_I2C_SDA 16
#define PIN_I2C_SCL 15
#define I2C_FREQ_HZ 400000
#define ADS1115_ADDR 0x48
#define ADS_CH_PH 0           // ADS1115 A0
#define ADS_CH_TDS 1          // ADS1115 A1
// 1 = TDS/EC probe is plugged into U6 (A1). 0 = not installed: EC/TDS are never sent and A1
// (floating, it copies A0) is ignored, so it cannot fake EC or hide pH.
#define TDS_INSTALLED 1
#define OLED_ADDR 0x3C

// relays: 2N3904 + 470R base + 12k pull-down -> HIGH = ON (schematic Schematic_Hydroponic.pdf p.9-10)
#define PIN_PUMP_A 10         // ESP32_GPIO10_PUMP1 = nutrient A
#define PIN_PUMP_B 11         // ESP32_GPIO11_PUMP2 = nutrient B
#define PIN_PUMP_PH_UP 12     // ESP32_GPIO12_PUMP3 = pH up
#define PIN_PUMP_PH_DOWN 13   // ESP32_GPIO13_PUMP4 = pH down
#define PIN_PUMP_MAIN 14      // ESP32_GPIO14_PUMP5 = main circulation pump

#define PIN_LED_R 4
#define PIN_LED_G 5
#define PIN_LED_B 6
#define LED_ACTIVE_LOW 1      // 1 = common-anode RGB (LOW lights the LED), 0 = common-cathode

#define PIN_BTN_BOOT 0

// ------------------------------------------------------------------------------
// 2. Sensor calibration constants
// ------------------------------------------------------------------------------
// !!! HARDWARE WARNING (pH) !!!
// The NA520+NA521 / PH-4502C style pH board is powered from 5V and its output can
// go ABOVE 3.3V (acidic solutions). The ADS1115 runs at VDD = 3.3V and its inputs
// must NEVER exceed VDD + 0.3V (3.6V) or the chip can be damaged.
// -> Put a voltage divider between the pH module output and ADS1115 A0 so the pin
//    stays <= 3.3V (e.g. 10k series / 20k to GND => pin = 2/3 of sensor voltage),
//    then set PH_DIVIDER_RATIO = sensor volts / pin volts (10k/20k => 1.5f).
// 1.0f = no divider (only safe if you have MEASURED the module output <= 3.3V
// in pH 4 buffer).
#define PH_DIVIDER_RATIO 1.0f

// Default 2-point calibration (sensor-side volts). Overwritten by RPC calibratePh
// and stored in NVS namespace "calib" (kept on factory reset - it belongs to the probe).
#define PH_CAL_V7_DEFAULT 2.50f
#define PH_CAL_V4_DEFAULT 3.05f
#define PH_CAL_MIN_SPAN_V 0.10f   // |V7 - V4| must be at least this

// pH validity window on the ADS pin voltage (volts). Outside = not sent.
#define PH_PIN_MIN_V 0.05f
#define PH_PIN_MAX_V 3.25f
// TDS module (DFRobot-type) outputs 0..2.3V
#define TDS_PIN_MIN_V 0.02f      // ~0 V = probe in air / unplugged (with pull-down): omit, never "0 ppm"
#define TDS_PIN_MAX_V 2.40f
#define TDS_K_VALUE 1.0f          // DFRobot kValue (probe constant), 1.0 = factory
#define TDS_MAX_PPM 5000.0f
// If the 9 samples spread more than this (V), the input is floating/noisy -> invalid
#define ADC_MAX_SPREAD_V 0.15f
// A floating ADS1115 input copies the charge of the channel converted just before it, so an
// unplugged probe reads (almost) the same volts as the other channel. If A0 and A1 agree
// within this window, at least one input is floating -> omit BOTH (zero-mock).
#define ADC_MIRROR_V 0.03f
#define ADS_SAMPLES 9

#define TEMP_MIN_VALID_C -10.0f
#define TEMP_MAX_VALID_C 60.0f
#define TEMP_COMP_FALLBACK_C 25.0f   // used for TDS compensation ONLY, never sent

// ------------------------------------------------------------------------------
// 3. Protocol constants (CONTRACT_v3)
// ------------------------------------------------------------------------------
#define FW_VERSION "3.0.0-s3-real"
#define BOARD_KIND "s3-real"
#define BLE_SERVICE_UUID "0000ffff-0000-1000-8000-00805f9b34fb"
#define BLE_CHAR_UUID "0000ff01-0000-1000-8000-00805f9b34fb"
#define BLE_SERVICE_UUID16 0xFFFF

static const uint16_t TB_MQTT_PORT = 1883;
static const uint32_t TELEMETRY_INTERVAL_MS = 30000;   // contract: every 30 s
// Unbound boards stay pairable all the time (claim re-published every 10 min, no BOOT press needed).
// Bound boards: a pairing window opened by resetWifi / enablePairing / BOOT still closes after 10 min.
static const uint32_t PAIRING_WINDOW_MS = 600000;      // 10 minutes
// Bound board that cannot reach its stored Wi-Fi (or has none) for this long opens the BLE pairing
// window by itself (still retrying the stored network), so the owner can send a new Wi-Fi from the
// app without pressing BOOT. Auth is unchanged: QR claim secret or the 6-digit code on the screen.
static const uint32_t OFFLINE_PAIR_AFTER_MS = 120000;  // 2 minutes
static const uint32_t AUTH_LOCKOUT_MS = 300000;        // 5 minutes
static const uint32_t CHEM_PUMP_MAX_S = 10;            // A, B, phUp, phDown
static const uint32_t MAIN_PUMP_MAX_S = 300;           // main circulation pump
static const uint32_t SENSOR_CYCLE_MS = 5000;
static const uint32_t DS18B20_CONV_MS = 800;           // 12-bit conversion = 750 ms
static const uint32_t SENSOR_STALE_MS = 20000;         // older readings are not sent
static const uint32_t FLOAT_DEBOUNCE_MS = 500;
// New-credential test: up to 3 join attempts of 13 s each (WiFi+BLE share the radio; the first join often fails)
static const uint32_t WIFI_TEST_TIMEOUT_MS = 13000;  // per attempt
static const uint8_t WIFI_TEST_ATTEMPTS = 3;
static const uint32_t WDT_TIMEOUT_MS = 20000;
static const uint32_t MQTT_BACKOFF_MIN_MS = 1000;
static const uint32_t MQTT_BACKOFF_MAX_MS = 60000;
static const uint32_t WIFI_BACKOFF_MIN_MS = 4000;      // one association attempt takes ~3 s
static const uint32_t WIFI_BACKOFF_MAX_MS = 60000;
static const uint32_t AUTO_EVAL_INTERVAL_MS = 300000;  // contract 7: every 5 minutes
static const uint32_t AUTO_MIX_MS = 300000;            // contract 7: wait 5 min after dosing
static const uint32_t AUTO_DOSE_S = 2;                 // contract 7: 2 s per dose
static const uint32_t AUTO_DOSE_GAP_MS = 1000;
// DWC tank: AUTO runs the main circulation pump while it doses and mixes (still water would leave the
// chemical next to the outlet: wrong probe reading -> over-dosing). Starts this long before the first dose.
static const uint32_t AUTO_MAIN_LEAD_MS = 5000;
static const uint32_t AUTO_MAIN_MAX_S = 330;           // AUTO-only cap: lead + doses + 5 min mixing
static const uint32_t AUTO_FIRST_EVAL_AFTER_MODE_MS = 30000;
static const uint32_t OLED_REFRESH_MS = 1000;
static const uint32_t BOOT_PAIR_HOLD_MS = 5000;
static const uint32_t BOOT_FACTORY_HOLD_MS = 10000;
static const size_t BLE_VALUE_MAX = 500;               // ATT attribute value limit is 512

// ------------------------------------------------------------------------------
// 4. Types
// ------------------------------------------------------------------------------
enum PumpIndex { P_MAIN = 0, P_A, P_B, P_PHUP, P_PHDOWN, PUMP_COUNT };

struct Pump {
  const char *rpcName;     // name used by RPC setPump
  const char *telemetryKey;
  uint8_t pin;
  bool chemical;
  volatile bool active;
  volatile uint32_t stopAtMs;
  esp_timer_handle_t timer;
  // Cumulative run-time accounting (measured, not requested). Fields below are
  // zero-initialised by the aggregate initialiser of pumps[].
  volatile int64_t onAtUs;     // esp_timer_get_time() when the current ON stretch began
  volatile uint64_t pendingUs; // closed ON stretches not yet folded into runMs (guarded by pumpMux)
  uint64_t runMs;              // persisted total, loop() context only
};

enum WifiBleState { WB_IDLE, WB_TESTING, WB_OK, WB_ERROR };
enum PendingAction { PA_NONE, PA_REBOOT, PA_FACTORY_RESET, PA_RESET_WIFI };
enum AutoState { AS_WAIT, AS_DOSING, AS_MIXING };

struct SensorState {
  bool adsOk;
  // pH
  bool phVoltOk;       // voltage inside window and stable (used for calibration)
  float phSensorV;     // sensor-side volts (pin * PH_DIVIDER_RATIO)
  bool phValid;
  float ph;
  uint32_t phTs;
  // TDS / EC
  bool ecValid;
  float tdsV;
  float tds;           // ppm
  float ec;            // mS/cm
  uint32_t ecTs;
  // temperature
  bool tempValid;
  float temp;
  uint32_t tempTs;
  // float switch (debounced)
  bool tankOk;
};

struct BleMsg {
  uint16_t len;
  char data[384];
};

struct WifiNet {
  char ssid[33];
  int8_t rssi;
};

// Offline log row (section 17b). Declared here so Arduino's auto-prototypes can see it.
struct __attribute__((packed)) LogRec {
  int64_t ts;                  // > 0 epoch ms; < 0 = -(uptime ms + 1), real time not known yet (RAM only)
  float ph, ec, temp;          // NAN = no valid reading at that minute
  uint16_t tds;                // 0xFFFF = no valid reading
  uint8_t flags;               // b0 tank_main_ok, b1 tank valid, b2..b6 pumps, b7 AUTO
  uint8_t crc;
  uint32_t runDs[PUMP_COUNT];  // cumulative measured pump run time, 0.1 s
};
static_assert(sizeof(LogRec) == 44, "LogRec layout is stored on flash");

// ------------------------------------------------------------------------------
// 5. Globals
// ------------------------------------------------------------------------------
Preferences prefs;        // namespace "smartfarm"
WiFiClient netClient;
PubSubClient mqtt(netClient);

#if HAS_DS18B20
// ---- Minimal 1-Wire driver for ONE DS18B20 (Skip ROM), on the ESP-IDF GPIO API ----------------
// Measured on this board: the OneWire library's reset on IO39 sees NO presence pulse, while the same
// reset done with plain GPIO calls sees the sensor (presence=1). So the probe is driven here directly.
// Every reading must pass the DS18B20's own CRC-8 and a config-byte check; otherwise it is dropped
// (temp key omitted) - a bad read can never become a temperature.
#include <driver/gpio.h>
static const gpio_num_t OW_PIN = (gpio_num_t)PIN_ONEWIRE_TEMP;
static void owInit() {
  gpio_reset_pin(OW_PIN);
  gpio_set_direction(OW_PIN, GPIO_MODE_INPUT_OUTPUT_OD);  // open-drain: 1 = released (4.7k pull-up)
  gpio_set_level(OW_PIN, 1);
}
static bool owReset() {
  noInterrupts();
  gpio_set_level(OW_PIN, 0);
  delayMicroseconds(500);
  gpio_set_level(OW_PIN, 1);
  delayMicroseconds(70);
  int presence = gpio_get_level(OW_PIN);  // sensor pulls LOW = present
  interrupts();
  delayMicroseconds(430);
  return presence == 0 && gpio_get_level(OW_PIN) == 1;  // and the bus must be released again
}
static void owWriteBit(uint8_t b) {
  noInterrupts();
  gpio_set_level(OW_PIN, 0);
  delayMicroseconds(b ? 6 : 60);
  gpio_set_level(OW_PIN, 1);
  interrupts();
  delayMicroseconds(b ? 64 : 10);
}
static uint8_t owReadBit() {
  noInterrupts();
  gpio_set_level(OW_PIN, 0);
  delayMicroseconds(3);
  gpio_set_level(OW_PIN, 1);
  delayMicroseconds(10);
  uint8_t r = (uint8_t)gpio_get_level(OW_PIN);
  interrupts();
  delayMicroseconds(53);
  return r;
}
static void owWriteByte(uint8_t v) {
  for (int i = 0; i < 8; i++) owWriteBit((v >> i) & 1);
}
static uint8_t owReadByte() {
  uint8_t v = 0;
  for (int i = 0; i < 8; i++) v |= (uint8_t)(owReadBit() << i);
  return v;
}
static uint8_t owCrc8(const uint8_t *d, int n) {
  uint8_t crc = 0;
  for (int i = 0; i < n; i++) {
    uint8_t in = d[i];
    for (int b = 0; b < 8; b++) {
      uint8_t mix = (crc ^ in) & 0x01;
      crc >>= 1;
      if (mix) crc ^= 0x8C;
      in >>= 1;
    }
  }
  return crc;
}
static bool dsPresent = false;  // last reset saw the sensor
static bool dsStartConversion() {
  dsPresent = owReset();
  if (!dsPresent) return false;
  owWriteByte(0xCC);  // Skip ROM (single sensor on the bus)
  owWriteByte(0x44);  // Convert T (12-bit default, 750 ms)
  return true;
}
// true only for a CRC-valid scratchpad from a real DS18B20
static bool dsReadTemp(float &out, const char *&why) {
  dsPresent = owReset();
  if (!dsPresent) { why = "NO PRESENCE (check U7 wiring)"; return false; }
  owWriteByte(0xCC);
  owWriteByte(0xBE);  // Read Scratchpad
  uint8_t d[9];
  bool allZero = true, allFF = true;
  for (int i = 0; i < 9; i++) {
    d[i] = owReadByte();
    if (d[i] != 0x00) allZero = false;
    if (d[i] != 0xFF) allFF = false;
  }
  if (allZero || allFF) { why = "BUS STUCK"; return false; }
  if (owCrc8(d, 8) != d[8]) { why = "CRC ERROR"; return false; }
  if ((d[4] & 0x9F) != 0x1F) { why = "BAD CONFIG BYTE"; return false; }
  int16_t raw = (int16_t)(((uint16_t)d[1] << 8) | d[0]);
  out = raw / 16.0f;
  why = "OK";
  return true;
}
#endif

#if HAS_OLED
#if OLED_IS_SSD1306
Adafruit_SSD1306 oled(128, 64, &Wire, -1, I2C_FREQ_HZ, I2C_FREQ_HZ);
#else
Adafruit_SH1106G oled(128, 64, &Wire, -1, I2C_FREQ_HZ, I2C_FREQ_HZ);
#endif
bool oledOk = false;
#endif

Pump pumps[PUMP_COUNT] = {
  {"main", "pump_main", PIN_PUMP_MAIN, false, false, 0, nullptr},
  {"A", "pump_a", PIN_PUMP_A, true, false, 0, nullptr},
  {"B", "pump_b", PIN_PUMP_B, true, false, 0, nullptr},
  {"phUp", "pump_ph_up", PIN_PUMP_PH_UP, true, false, 0, nullptr},
  {"phDown", "pump_ph_down", PIN_PUMP_PH_DOWN, true, false, 0, nullptr},
};
volatile bool pumpStateChanged = false;
portMUX_TYPE pumpMux = portMUX_INITIALIZER_UNLOCKED;  // active/onAtUs/pendingUs vs esp_timer task
// Telemetry keys (seconds, 1 decimal) and NVS keys for cumulative pump run time.
static const char *const PUMP_RUN_KEYS[PUMP_COUNT] = {"run_main", "run_a", "run_b", "run_ph_up", "run_ph_down"};
static const char *const PUMP_RT_NVS[PUMP_COUNT] = {"rt_main", "rt_a", "rt_b", "rt_phu", "rt_phd"};

SensorState S = {};
float phCalV7 = PH_CAL_V7_DEFAULT;
float phCalV4 = PH_CAL_V4_DEFAULT;
// bit0 = pH 7 point stored from a real buffer, bit1 = pH 4 point. pH is NEVER sent until both
// points come from real buffers (the defaults are only a typical module curve, not this probe).
uint8_t phCalMask = 0;
#define PH_CAL_ALL 0x03

// identity / secrets (fixed-size buffers, no String churn)
char deviceId[33] = "";
char claimSecret[11] = "";
char ownerName[65] = "";
char wifiSsid[33] = "";
char wifiPass[65] = "";
char tbToken[65] = "";
char btMacStr[18] = "";
bool tokenConfigured = false;

// binding / pairing
char ownerSource[8] = "";      // "attr" | "rpc" | ""
double lastSeenBindTs = 0;     // latest bind_ts seen while bound
double consumedBindTs = 0;     // bind_ts already unbound (blocks re-bind from a stale bind_owner)
bool isBound = false;
bool isPairingWindowOpen = false;
uint32_t pairingWindowStart = 0;
uint32_t wifiDownSince = 0;    // millis() when a bound board lost Wi-Fi (0 = online / not tracking)
bool offlinePairing = false;   // pairing window was opened because Wi-Fi is down (stays open until it is back)

// mode / targets
bool autoMode = false;
float targetPhMin = 5.8f, targetPhMax = 6.5f;
float targetEcMin = 1.4f, targetEcMax = 1.8f;
float targetTempMin = 22.0f, targetTempMax = 28.0f;

// AUTO dosing state machine
AutoState autoState = AS_WAIT;
uint32_t autoNextEvalAt = 0;
uint32_t autoMixUntil = 0;
uint32_t autoGapUntil = 0;
uint8_t autoQueue[3];
uint8_t autoQueueLen = 0;
uint8_t autoQueueIdx = 0;
char autoReason[24] = "";      // telemetry auto_reason, e.g. "pH 7.10 > 6.50"
bool autoMainInCycle = false;  // main circulation pump is part of the current AUTO cycle (telemetry auto_pumps)

// BLE (callbacks only touch these volatile flags / the queue)
BLEServer *pBleServer = nullptr;
BLECharacteristic *pBleChar = nullptr;
QueueHandle_t bleQueue = nullptr;
volatile bool bleConnected = false;
volatile bool bleConnectEvent = false;
volatile bool bleDisconnectEvent = false;
volatile bool bleWriteDropped = false;
bool isBleAdvertising = false;
bool bleAuthenticated = false;
bool bleStatusDirty = true;
bool bleNotifyPending = false;
int authFailCount = 0;
int verifyFailCount = 0;
bool authLocked = false;
uint32_t authLockUntil = 0;
int lockedCode = 0;
char bleEvent[16] = "";        // "status" field: auth_ok, verify_ready, verified, wrong, locked, ...
char bleAuthError[24] = "";    // ERR_AUTH_FAILED, ERR_CODE_MISMATCH
char bleWifiError[28] = "";    // ERR_WIFI_*, UNAUTHORIZED
int bleAttemptsLeft = -1;

// WiFi provisioning / scan
bool wifiTesting = false;
uint32_t wifiTestStart = 0;
char pendSsid[33] = "";
char pendPass[65] = "";
volatile uint8_t lastDiscReason = 0;
bool scanRequested = false;
bool scanRunning = false;
WifiNet nets[12];
uint8_t netCount = 0;
uint32_t wifiNextAttemptAt = 0;
uint32_t wifiBackoffMs = WIFI_BACKOFF_MIN_MS;
bool wifiWasConnected = false;

// MQTT
IPAddress tbIp;
bool tbIpValid = false;
uint32_t mqttNextAttemptAt = 0;
uint32_t mqttBackoffMs = MQTT_BACKOFF_MIN_MS;
bool mqttWasConnected = false;
uint32_t mqttUpSince = 0;      // millis() of the last MQTT connect (offline backlog waits a few s)
bool attrsDirty = true;
bool telemetryDirty = false;
uint32_t lastTelemetryAt = 0;

// deferred actions (reply first, act after the MQTT reply is flushed)
PendingAction pendingAction = PA_NONE;
uint32_t pendingActionAt = 0;

// sensor sampler state
bool sampActive = false;
uint8_t sampCh = 0;
uint8_t sampIdx = 0;
// The TDS input (A1) is high-impedance: right after the mux switches to it the first conversions
// read low and climb like an RC charge (measured 1.18 -> 1.82 V over 9 samples). Those settling
// conversions are discarded (real readings, just not yet settled), then 9 samples are kept.
#define ADS_TDS_SETTLE_SAMPLES 30
uint8_t sampDiscard = 0;
uint32_t sampConvStart = 0;
float phSamples[ADS_SAMPLES];
float tdsSamples[ADS_SAMPLES];
uint32_t nextSensorCycleAt = 0;
bool dsPending = false;
uint32_t dsRequestAt = 0;
int floatRawLast = -1;
uint32_t floatRawChangedAt = 0;

// BOOT button
uint32_t btnPressStart = 0;
bool btnPairArmed = false;
bool btnFactoryDone = false;

// OLED
uint32_t lastOledAt = 0;
bool oledDirty = true;

// ------------------------------------------------------------------------------
// 6. Forward declarations
// ------------------------------------------------------------------------------
void sendTelemetry();
void publishClientAttrs(bool force);
void publishClaimRequest();
void requestSharedAttributes();
void openPairingWindow();
void closePairingWindow();
void stopPump(int i);
void stopAllPumps();
void stopChemicalPumps();
bool startPump(int i, uint32_t seconds, uint32_t capOverrideS = 0);
void markBleDirty(bool notify);
void autoReset(uint32_t firstEvalDelayMs);
static void ologWipe();

// ------------------------------------------------------------------------------
// 7. Small helpers
// ------------------------------------------------------------------------------
static inline bool timeReached(uint32_t now, uint32_t at) { return (int32_t)(now - at) >= 0; }

static uint32_t withJitter(uint32_t ms) {
  // +/-20 % jitter (network pacing only, never sensor data)
  uint32_t span = ms / 5;
  if (span == 0) return ms;
  int32_t j = (int32_t)(esp_random() % (2 * span + 1)) - (int32_t)span;
  return (uint32_t)((int32_t)ms + j);
}

static bool isPlaceholder(const char *s) { return s == nullptr || s[0] == 0 || strncmp(s, "YOUR_", 5) == 0; }

static void copyStr(char *dst, size_t cap, const char *src) {
  if (!src) src = "";
  strncpy(dst, src, cap - 1);
  dst[cap - 1] = 0;
}

static bool constantTimeEq(const char *a, const char *b) {
  size_t la = strlen(a), lb = strlen(b);
  uint8_t diff = (la != lb) ? 1 : 0;
  size_t n = la < lb ? la : lb;
  for (size_t i = 0; i < n; i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}

static void generateClaimSecret() {
  const char charset[] = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";  // no 0/O/1/I
  const size_t n = sizeof(charset) - 1;
  for (int i = 0; i < 10; i++) claimSecret[i] = charset[esp_random() % n];
  claimSecret[10] = 0;
}

// 6-digit verification code shown ONLY on the OLED (never sent over BLE); the user types it in the app.
// (The old "pick 1 of 3" sent the choices over BLE, so anyone in range guessed 1/3 and got the claim secret.)
static void generateVerifyCodes() {
  lockedCode = 100000 + (int)(esp_random() % 900000UL);
}

static void ledSet(bool r, bool g, bool b) {
  const uint8_t on = LED_ACTIVE_LOW ? LOW : HIGH;
  const uint8_t off = LED_ACTIVE_LOW ? HIGH : LOW;
  digitalWrite(PIN_LED_R, r ? on : off);
  digitalWrite(PIN_LED_G, g ? on : off);
  digitalWrite(PIN_LED_B, b ? on : off);
}

static bool sensorFresh(bool valid, uint32_t ts, uint32_t now) { return valid && (now - ts) <= SENSOR_STALE_MS; }
static bool phOk(uint32_t now) { return sensorFresh(S.phValid, S.phTs, now); }
static bool ecOk(uint32_t now) { return sensorFresh(S.ecValid, S.ecTs, now); }
static bool tempOk(uint32_t now) { return sensorFresh(S.tempValid, S.tempTs, now); }
static bool sensorOk(uint32_t now) { return phOk(now) && ecOk(now) && tempOk(now); }

static bool anyPumpActive() {
  for (int i = 0; i < PUMP_COUNT; i++)
    if (pumps[i].active) return true;
  return false;
}

// ------------------------------------------------------------------------------
// 8. Pumps - relay cut-off by esp_timer, independent of loop()
// ------------------------------------------------------------------------------
static void pumpTimerCb(void *arg) {
  // Runs in the esp_timer task: works even if loop() is blocked by network I/O.
  // Run-time bookkeeping only touches RAM here; loop() folds it into NVS.
  Pump *p = (Pump *)arg;
  digitalWrite(p->pin, LOW);
  int64_t nowUs = esp_timer_get_time();
  portENTER_CRITICAL(&pumpMux);
  if (p->active) {
    p->active = false;
    p->pendingUs += (uint64_t)(nowUs - p->onAtUs);
  }
  portEXIT_CRITICAL(&pumpMux);
  pumpStateChanged = true;
}

void stopPump(int i) {
  Pump &p = pumps[i];
  if (p.timer) esp_timer_stop(p.timer);
  digitalWrite(p.pin, LOW);
  int64_t nowUs = esp_timer_get_time();
  bool wasActive = false;
  portENTER_CRITICAL(&pumpMux);
  if (p.active) {
    wasActive = true;
    p.active = false;
    p.pendingUs += (uint64_t)(nowUs - p.onAtUs);
  }
  portEXIT_CRITICAL(&pumpMux);
  if (wasActive) pumpStateChanged = true;
}

// loop() context only: fold closed ON stretches into the total and persist it.
// Writes NVS only when a pump has actually turned OFF since the last call.
static void settlePumpRuntime() {
  for (int i = 0; i < PUMP_COUNT; i++) {
    Pump &p = pumps[i];
    uint64_t addMs = 0;
    portENTER_CRITICAL(&pumpMux);
    if (p.pendingUs >= 1000ULL) {
      addMs = p.pendingUs / 1000ULL;
      p.pendingUs -= addMs * 1000ULL;  // keep sub-ms remainder for the next run
    }
    portEXIT_CRITICAL(&pumpMux);
    if (addMs == 0) continue;
    p.runMs += addMs;
    prefs.putULong64(PUMP_RT_NVS[i], p.runMs);
  }
}

// Live cumulative run time in ms (persisted + unsettled + current ON stretch).
static uint64_t pumpRunMsLive(int i) {
  Pump &p = pumps[i];
  int64_t nowUs = esp_timer_get_time();
  uint64_t us;
  portENTER_CRITICAL(&pumpMux);
  us = p.pendingUs;
  if (p.active) us += (uint64_t)(nowUs - p.onAtUs);
  portEXIT_CRITICAL(&pumpMux);
  return p.runMs + us / 1000ULL;
}

void stopAllPumps() {
  for (int i = 0; i < PUMP_COUNT; i++) stopPump(i);
}

void stopChemicalPumps() {
  for (int i = 0; i < PUMP_COUNT; i++)
    if (pumps[i].chemical) stopPump(i);
}

bool startPump(int i, uint32_t seconds, uint32_t capOverrideS) {
  Pump &p = pumps[i];
  const uint32_t cap = capOverrideS ? capOverrideS : (p.chemical ? CHEM_PUMP_MAX_S : MAIN_PUMP_MAX_S);
  if (seconds > cap) seconds = cap;
  if (seconds == 0) {
    stopPump(i);
    return true;
  }
  if (!p.timer) return false;
  esp_timer_stop(p.timer);  // restart if already running (ESP_ERR_INVALID_STATE ignored)
  p.stopAtMs = millis() + seconds * 1000UL;
  digitalWrite(p.pin, HIGH);
  int64_t nowUs = esp_timer_get_time();
  portENTER_CRITICAL(&pumpMux);
  if (!p.active) p.onAtUs = nowUs;  // a restart of a running pump keeps its ON stretch going
  p.active = true;
  portEXIT_CRITICAL(&pumpMux);
  if (esp_timer_start_once(p.timer, (uint64_t)seconds * 1000000ULL) != ESP_OK) {
    stopPump(i);  // never leave a relay on without a hardware cut-off armed
    return false;
  }
  pumpStateChanged = true;
  Serial.printf("[PUMP] %s ON for %lu s\n", p.rpcName, (unsigned long)seconds);
  return true;
}

// Backup check in loop() (overflow-safe), plus interlocks.
void pumpSafetyTick(uint32_t now) {
  for (int i = 0; i < PUMP_COUNT; i++) {
    if (pumps[i].active && timeReached(now, pumps[i].stopAtMs)) {
      stopPump(i);
      Serial.printf("[PUMP] %s OFF (loop backup cut-off)\n", pumps[i].rpcName);
    }
  }
  if (!isBound && anyPumpActive()) stopAllPumps();
#if HAS_FLOAT_SWITCH
  if (pumps[P_MAIN].active && !S.tankOk) {
    stopPump(P_MAIN);
    Serial.println("[PUMP] main OFF: tank empty interlock");
  }
#endif
  settlePumpRuntime();  // covers esp_timer cut-offs, RPC/AUTO/safety stops and stopAllPumps()
  if (pumpStateChanged) {
    pumpStateChanged = false;
    telemetryDirty = true;
    oledDirty = true;
  }
}

// ------------------------------------------------------------------------------
// 9. Minimal ADS1115 driver (single-shot, PGA +/-4.096V, 128 SPS)
// ------------------------------------------------------------------------------
#define ADS_REG_CONVERSION 0x00
#define ADS_REG_CONFIG 0x01
#define ADS_CFG_OS_SINGLE 0x8000
#define ADS_CFG_MUX_AIN0 0x4000   // AINx vs GND: 0x4000 + ch * 0x1000
#define ADS_CFG_PGA_4_096V 0x0200
#define ADS_CFG_MODE_SINGLE 0x0100
#define ADS_CFG_DR_128SPS 0x0080
#define ADS_CFG_COMP_DISABLE 0x0003
static const float ADS_LSB_V = 4.096f / 32768.0f;
static const uint32_t ADS_CONV_MS = 9;     // 1/128 s = 7.8 ms
static const uint32_t ADS_CONV_TIMEOUT_MS = 50;

static bool adsWriteReg(uint8_t reg, uint16_t value) {
  Wire.beginTransmission(ADS1115_ADDR);
  Wire.write(reg);
  Wire.write((uint8_t)(value >> 8));
  Wire.write((uint8_t)(value & 0xFF));
  return Wire.endTransmission() == 0;
}

static bool adsReadReg(uint8_t reg, uint16_t &out) {
  Wire.beginTransmission(ADS1115_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom((uint8_t)ADS1115_ADDR, (uint8_t)2) != 2) return false;
  uint16_t hi = (uint16_t)Wire.read();
  uint16_t lo = (uint16_t)Wire.read();
  out = (uint16_t)((hi << 8) | lo);
  return true;
}

static bool adsProbe() {
  uint16_t cfg;
  return adsReadReg(ADS_REG_CONFIG, cfg);
}

static bool adsStartSingle(uint8_t ch) {
  uint16_t cfg = ADS_CFG_OS_SINGLE | (uint16_t)(ADS_CFG_MUX_AIN0 + ch * 0x1000) | ADS_CFG_PGA_4_096V |
                 ADS_CFG_MODE_SINGLE | ADS_CFG_DR_128SPS | ADS_CFG_COMP_DISABLE;
  return adsWriteReg(ADS_REG_CONFIG, cfg);
}

// returns 1 = ready (volts set), 0 = still converting, -1 = I2C error
static int adsPollResult(float &volts) {
  uint16_t cfg;
  if (!adsReadReg(ADS_REG_CONFIG, cfg)) return -1;
  if ((cfg & ADS_CFG_OS_SINGLE) == 0) return 0;  // conversion in progress
  uint16_t raw;
  if (!adsReadReg(ADS_REG_CONVERSION, raw)) return -1;
  volts = (float)(int16_t)raw * ADS_LSB_V;
  return 1;
}

// ------------------------------------------------------------------------------
// 10. Sensor processing (non-blocking state machine; no fake values)
// ------------------------------------------------------------------------------
static void sortFloats(float *a, int n) {
  for (int i = 1; i < n; i++) {
    float k = a[i];
    int j = i - 1;
    while (j >= 0 && a[j] > k) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = k;
  }
}

static float medianAndSpread(const float *src, int n, float &spread) {
  float tmp[ADS_SAMPLES];
  for (int i = 0; i < n; i++) tmp[i] = src[i];
  sortFloats(tmp, n);
  spread = tmp[n - 1] - tmp[0];
  return tmp[n / 2];
}

static void invalidateAdsSensors() {
  if (S.phValid || S.ecValid) telemetryDirty = true;
  S.phValid = false;
  S.phVoltOk = false;
  S.ecValid = false;
}

static void finishAdsCycle(uint32_t now) {
  // ---- floating-input check (see ADC_MIRROR_V) ----
  float spread, tdsSpread0;
  float pinV = medianAndSpread(phSamples, ADS_SAMPLES, spread);
  float tdsV0 = medianAndSpread(tdsSamples, ADS_SAMPLES, tdsSpread0);
  bool mirrored = TDS_INSTALLED && fabsf(pinV - tdsV0) < ADC_MIRROR_V;

  // ---- pH ----
  bool winOk = !mirrored && (pinV >= PH_PIN_MIN_V) && (pinV <= PH_PIN_MAX_V) && (spread <= ADC_MAX_SPREAD_V);
  S.phVoltOk = winOk;
  S.phSensorV = pinV * PH_DIVIDER_RATIO;
  bool phValid = false;
  if (winOk && phCalMask == PH_CAL_ALL && fabsf(phCalV7 - phCalV4) >= PH_CAL_MIN_SPAN_V) {
    float slope = (7.0f - 4.0f) / (phCalV7 - phCalV4);  // pH per volt
    float ph = 7.0f + (S.phSensorV - phCalV7) * slope;
    if (isfinite(ph) && ph >= 0.0f && ph <= 14.0f) {
      S.ph = ph;
      phValid = true;
    }
  }
  S.phValid = phValid;
  if (phValid) S.phTs = now;

  // ---- TDS / EC (DFRobot formula with temperature compensation) ----
  float tdsV = medianAndSpread(tdsSamples, ADS_SAMPLES, spread);
  if (tdsV < 0.0f && tdsV > -0.01f) tdsV = 0.0f;  // ADC offset around 0 V
  bool tWin = TDS_INSTALLED && !mirrored && (tdsV >= TDS_PIN_MIN_V) && (tdsV <= TDS_PIN_MAX_V) && (spread <= ADC_MAX_SPREAD_V);
  bool ecValid = false;
  if (tWin) {
    // real temperature only; if DS18B20 is invalid use 25 C for compensation
    // (EC/TDS still sent, sensor_ok becomes false because temp is missing)
    float tC = tempOk(now) ? S.temp : TEMP_COMP_FALLBACK_C;
    float coef = 1.0f + 0.02f * (tC - 25.0f);
    float cv = tdsV / coef;
    float tds = (133.42f * cv * cv * cv - 255.86f * cv * cv + 857.39f * cv) * 0.5f * TDS_K_VALUE;
    if (tds < 0.0f) tds = 0.0f;
    if (isfinite(tds) && tds <= TDS_MAX_PPM) {
      S.tdsV = tdsV;
      S.tds = tds;
      S.ec = tds / 500.0f;  // ppm (0.5 scale) -> mS/cm
      ecValid = true;
    }
  }
  S.ecValid = ecValid;
  if (ecValid) S.ecTs = now;
  oledDirty = true;

  // Serial-only diagnostics (raw measured volts, never sent to the cloud), every 10 s
  static uint32_t lastDiagAt = 0;
  if (now - lastDiagAt >= 10000) {
    lastDiagAt = now;
    float phSpread, tdsSpread;
    float phPin = medianAndSpread(phSamples, ADS_SAMPLES, phSpread);
    medianAndSpread(tdsSamples, ADS_SAMPLES, tdsSpread);
    Serial.print("[ADC] A1 raw:");
    for (int i = 0; i < ADS_SAMPLES; i++) Serial.printf(" %.3f", (double)tdsSamples[i]);
    Serial.println();
    Serial.printf("[ADC] pH A0=%.3fV spread=%.3fV -> %s | TDS A1=%.3fV spread=%.3fV -> %s\n", phPin, phSpread,
                  phValid ? "OK" : mirrored ? "FLOATING(A0=A1)" : (phCalMask != PH_CAL_ALL && phPin >= PH_PIN_MIN_V && phPin <= PH_PIN_MAX_V && phSpread <= ADC_MAX_SPREAD_V) ? "UNCALIBRATED(hidden)" : (phPin < PH_PIN_MIN_V ? "LOW(no signal?)" : phPin > PH_PIN_MAX_V ? "HIGH(>3.25V)" : phSpread > ADC_MAX_SPREAD_V ? "NOISY" : "CAL/RANGE"),
                  tdsV, tdsSpread,
                  ecValid ? "OK" : !TDS_INSTALLED ? "NOT INSTALLED" : mirrored ? "FLOATING(A0=A1)" : tdsV < TDS_PIN_MIN_V ? "LOW(no probe?)" : (tdsV > TDS_PIN_MAX_V ? "HIGH(>2.4V)" : tdsSpread > ADC_MAX_SPREAD_V ? "NOISY" : "RANGE"));
  }
}

void sensorTick(uint32_t now) {
  // ---- start of a cycle ----
  if (!sampActive && timeReached(now, nextSensorCycleAt)) {
    nextSensorCycleAt = now + SENSOR_CYCLE_MS;
#if HAS_DS18B20
    if (!dsPending) {
      dsStartConversion();  // non-blocking: result read DS18B20_CONV_MS later
      dsPending = true;
      dsRequestAt = now;
    }
#endif
    if (!S.adsOk) S.adsOk = adsProbe();
    if (S.adsOk && adsStartSingle(ADS_CH_PH)) {
      sampActive = true;
      sampCh = ADS_CH_PH;
      sampIdx = 0;
      sampConvStart = now;
    } else {
      if (S.adsOk) Serial.println("[ADS1115] I2C error - pH/EC omitted");
      S.adsOk = false;
      invalidateAdsSensors();
    }
  }

  // ---- ADS1115 conversions, one step per loop pass ----
  if (sampActive && (now - sampConvStart) >= ADS_CONV_MS) {
    float v;
    int r = adsPollResult(v);
    if (r == 0 && (now - sampConvStart) > ADS_CONV_TIMEOUT_MS) r = -1;
    if (r < 0) {
      sampActive = false;
      S.adsOk = false;
      invalidateAdsSensors();
      Serial.println("[ADS1115] conversion failed - pH/EC omitted");
    } else if (r == 1) {
      if (sampDiscard > 0) {
        sampDiscard--;  // settling conversion, not stored
      } else {
        if (sampCh == ADS_CH_PH) phSamples[sampIdx] = v;
        else tdsSamples[sampIdx] = v;
        sampIdx++;
      }
      if (sampIdx >= ADS_SAMPLES) {
        if (sampCh == ADS_CH_PH) {
          sampCh = ADS_CH_TDS;
          sampIdx = 0;
          sampDiscard = ADS_TDS_SETTLE_SAMPLES;
        } else {
          sampActive = false;
          finishAdsCycle(now);
        }
      }
      if (sampActive) {
        if (adsStartSingle(sampCh)) {
          sampConvStart = now;
        } else {
          sampActive = false;
          S.adsOk = false;
          invalidateAdsSensors();
        }
      }
    }
  }

#if HAS_DS18B20
  // ---- DS18B20 result ----
  if (dsPending && (now - dsRequestAt) >= DS18B20_CONV_MS) {
    dsPending = false;
    float t = NAN;
    const char *why = "";
    bool readOk = dsReadTemp(t, why);
    if (readOk && t == 85.0f) why = "85C POWER-ON VALUE";
    bool valid = readOk && (t != 85.0f) && isfinite(t) && t >= TEMP_MIN_VALID_C && t <= TEMP_MAX_VALID_C;
    if (readOk && !valid && why[0] == 'O') why = "OUT OF RANGE";
    if (valid) {
      S.temp = t;
      S.tempTs = now;
    }
    if (valid != S.tempValid) telemetryDirty = true;
    S.tempValid = valid;
    static uint32_t lastDsDiagAt = 0;
    if (now - lastDsDiagAt >= 10000) {
      lastDsDiagAt = now;
      if (valid) Serial.printf("[DS18B20] IO39 presence=%u -> OK %.2f C\n", (unsigned)dsPresent, (double)t);
      else Serial.printf("[DS18B20] IO39 presence=%u -> %s (temp omitted)\n", (unsigned)dsPresent, why);
    }
    oledDirty = true;
  }
#endif

#if HAS_FLOAT_SWITCH
  // ---- float switch debounce ----
  int raw = digitalRead(PIN_FLOAT_MAIN);
  if (raw != floatRawLast) {
    floatRawLast = raw;
    floatRawChangedAt = now;
  } else if ((now - floatRawChangedAt) >= FLOAT_DEBOUNCE_MS) {
    bool ok = (raw == FLOAT_WATER_PRESENT_LEVEL);
    if (ok != S.tankOk) {
      S.tankOk = ok;
      telemetryDirty = true;
      oledDirty = true;
      Serial.printf("[FLOAT] main tank %s\n", ok ? "OK" : "EMPTY");
    }
  }
#endif
}

// ------------------------------------------------------------------------------
// 11. NVS persistence
// ------------------------------------------------------------------------------
static void loadCalibration() {
  Preferences cal;
  cal.begin("calib", true);
  phCalV7 = cal.getFloat("ph_v7", PH_CAL_V7_DEFAULT);
  phCalV4 = cal.getFloat("ph_v4", PH_CAL_V4_DEFAULT);
  phCalMask = cal.getUChar("ph_mask", 0);
  cal.end();
  if (!isfinite(phCalV7) || !isfinite(phCalV4) || fabsf(phCalV7 - phCalV4) < PH_CAL_MIN_SPAN_V) {
    phCalV7 = PH_CAL_V7_DEFAULT;
    phCalV4 = PH_CAL_V4_DEFAULT;
    phCalMask = 0;
  }
  Serial.printf("[CAL] pH calibration %s (v7=%.3f v4=%.3f mask=%u)\n", phCalMask == PH_CAL_ALL ? "DONE" : "NOT DONE - pH hidden",
                (double)phCalV7, (double)phCalV4, (unsigned)phCalMask);
}

static void saveCalibration() {
  Preferences cal;
  cal.begin("calib", false);
  cal.putFloat("ph_v7", phCalV7);
  cal.putFloat("ph_v4", phCalV4);
  cal.putUChar("ph_mask", phCalMask);
  cal.end();
}

static void rotateClaimSecret() {
  generateClaimSecret();
  prefs.putString("claim_secret", claimSecret);
}

// ------------------------------------------------------------------------------
// 12. Binding / pairing
// ------------------------------------------------------------------------------
void openPairingWindow() {
  isPairingWindowOpen = true;
  pairingWindowStart = millis();
  bleAuthenticated = false;
  authFailCount = 0;
  verifyFailCount = 0;
  authLocked = false;
  bleAuthError[0] = 0;
  bleEvent[0] = 0;
  generateVerifyCodes();
  attrsDirty = true;
  oledDirty = true;
  markBleDirty(false);
  Serial.println("[PAIR] pairing window OPEN (10 min)");
  if (mqtt.connected()) publishClaimRequest();
}

void closePairingWindow() {
  isPairingWindowOpen = false;
  attrsDirty = true;
  oledDirty = true;
  Serial.println("[PAIR] pairing window CLOSED");
}

// While unbound: a successful BLE auth / applied WiFi credentials restart the 10-min
// window and re-publish the TB claim request, so the app's claim never races an
// expiring window.
// (does not reset BLE auth / verify code, so the app's ongoing flow is not cut)
static void refreshPairingForClaim(const char *why) {
  if (isBound) return;
  isPairingWindowOpen = true;
  pairingWindowStart = millis();
  attrsDirty = true;
  oledDirty = true;
  if (mqtt.connected()) publishClaimRequest();
  Serial.printf("[PAIR] window renewed (%s)\n", why);
}

static void bindDevice(const char *owner, const char *source) {
  bool wasBound = isBound;
  if (owner && owner[0]) {
    copyStr(ownerName, sizeof(ownerName), owner);
    prefs.putString("owner", ownerName);
  }
  copyStr(ownerSource, sizeof(ownerSource), source);
  prefs.putString("owner_src", ownerSource);
  if (lastSeenBindTs > 0) prefs.putDouble("bind_ts_seen", lastSeenBindTs);
  isBound = true;
  prefs.putBool("is_bound", true);
  if (isPairingWindowOpen) closePairingWindow();
  bleAuthenticated = false;
  attrsDirty = true;
  telemetryDirty = true;
  oledDirty = true;
  if (!wasBound) {
    autoReset(AUTO_EVAL_INTERVAL_MS);
    Serial.println("[BIND] device bound");
  }
}

static void unbindDevice() {
  stopAllPumps();
  if (lastSeenBindTs > consumedBindTs) consumedBindTs = lastSeenBindTs;
  prefs.putDouble("bind_ts_used", consumedBindTs);
  isBound = false;
  ownerName[0] = 0;
  ownerSource[0] = 0;
  prefs.putBool("is_bound", false);
  prefs.remove("owner");
  prefs.remove("owner_src");
  rotateClaimSecret();  // contract: unbind rotates the claim secret (history kept on TB)
  autoReset(AUTO_EVAL_INTERVAL_MS);
  openPairingWindow();
  attrsDirty = true;
  Serial.println("[BIND] device unbound, new claim secret, pairing open");
}

// BOOT 5 s: forget WiFi + unbind + new secret + open pairing
static void bootPairingReset() {
  Serial.println("[BOOT] 5 s: reset WiFi + pairing");
  prefs.remove("wifi_ssid");
  prefs.remove("wifi_pass");
  wifiSsid[0] = 0;
  wifiPass[0] = 0;
  WiFi.disconnect(false, true);
  unbindDevice();
}

static void doFactoryResetNow() {
  stopAllPumps();
  Serial.println("[RESET] factory reset: clearing NVS (pH calibration kept) and restarting");
  double keepTs = (lastSeenBindTs > consumedBindTs) ? lastSeenBindTs : consumedBindTs;
  ologWipe();  // the log index lives in NVS: drop the rows together with it
  prefs.clear();
  if (keepTs > 0) prefs.putDouble("bind_ts_used", keepTs);  // stale bind_owner must not re-bind
  WiFi.disconnect(true, true);
  ESP.restart();
}

// ------------------------------------------------------------------------------
// 13. AUTO dosing state machine (CONTRACT_v3 section 7)
// ------------------------------------------------------------------------------
// AUTO: keep the main circulation pump running at least until untilMs. Never shortens a longer run the
// owner started; never runs it when the float switch reports the main tank low.
static void autoEnsureMainUntil(uint32_t now, uint32_t untilMs) {
#if HAS_FLOAT_SWITCH
  if (!S.tankOk) return;
#endif
  autoMainInCycle = true;
  Pump &m = pumps[P_MAIN];
  if (m.active && timeReached(m.stopAtMs, untilMs)) return;  // already runs long enough
  uint32_t secs = (uint32_t)((untilMs - now + 999UL) / 1000UL);
  if (secs == 0) return;
  if (!startPump(P_MAIN, secs, AUTO_MAIN_MAX_S)) Serial.println("[AUTO] main pump timer failed");
}

void autoReset(uint32_t firstEvalDelayMs) {
  if (autoState == AS_DOSING) stopChemicalPumps();
  if (autoState != AS_WAIT) telemetryDirty = true;  // app sees auto_phase go back to idle
  autoState = AS_WAIT;
  autoQueueLen = 0;
  autoQueueIdx = 0;
  autoReason[0] = 0;
  autoMainInCycle = false;  // a running main pump keeps its own timer (harmless, ends by itself)
  autoNextEvalAt = millis() + firstEvalDelayMs;
}

void autoTick(uint32_t now) {
  if (!autoMode || !isBound) {
    if (autoState != AS_WAIT) autoReset(AUTO_EVAL_INTERVAL_MS);
    return;
  }
  switch (autoState) {
    case AS_WAIT:
      if (!timeReached(now, autoNextEvalAt)) break;
      autoNextEvalAt = now + AUTO_EVAL_INTERVAL_MS;
      if (!sensorOk(now)) {
        Serial.println("[AUTO] skip: sensors not valid");
        break;
      }
      if (!S.tankOk) {
        Serial.println("[AUTO] skip: main tank empty");
        break;
      }
      autoQueueLen = 0;
      if (S.ph > targetPhMax) autoQueue[autoQueueLen++] = P_PHDOWN;
      else if (S.ph < targetPhMin) autoQueue[autoQueueLen++] = P_PHUP;
      if (S.ec < targetEcMin) {
        autoQueue[autoQueueLen++] = P_A;
        autoQueue[autoQueueLen++] = P_B;
      }
      if (autoQueueLen > 0) {
        if (autoQueue[0] == P_PHDOWN || autoQueue[0] == P_PHUP)
          snprintf(autoReason, sizeof(autoReason), "pH %.2f %c %.2f", (double)S.ph, autoQueue[0] == P_PHDOWN ? '>' : '<',
                   (double)(autoQueue[0] == P_PHDOWN ? targetPhMax : targetPhMin));
        else
          snprintf(autoReason, sizeof(autoReason), "EC %.2f < %.2f", (double)S.ec, (double)targetEcMin);
        autoState = AS_DOSING;
        autoQueueIdx = 0;
        // circulate first, then dose into moving water; keep it on through the doses (mixing extends it)
        autoEnsureMainUntil(now, now + AUTO_MAIN_LEAD_MS + autoQueueLen * (AUTO_DOSE_S * 1000UL + AUTO_DOSE_GAP_MS) + 2000UL);
        autoGapUntil = pumps[P_MAIN].active ? now + AUTO_MAIN_LEAD_MS : now;
        telemetryDirty = true;  // auto_phase -> dosing
        Serial.printf("[AUTO] dosing plan: %u step(s) (pH %.2f, EC %.2f)\n", autoQueueLen, S.ph, S.ec);
      }
      break;

    case AS_DOSING: {
      bool chemRunning = false;
      for (int i = 0; i < PUMP_COUNT; i++)
        if (pumps[i].chemical && pumps[i].active) chemRunning = true;
      if (chemRunning || !timeReached(now, autoGapUntil)) break;
      if (autoQueueIdx >= autoQueueLen) {
        autoState = AS_MIXING;
        autoMixUntil = now + AUTO_MIX_MS;
        autoEnsureMainUntil(now, autoMixUntil);  // circulate for the whole 5 min mixing
        telemetryDirty = true;  // auto_phase -> mixing
        Serial.println("[AUTO] dosing done, mixing 5 min");
        break;
      }
      if (!sensorOk(now) || !S.tankOk) {  // abort remaining doses
        Serial.println("[AUTO] abort dosing: sensors invalid or tank empty");
        autoState = AS_MIXING;
        autoMixUntil = now + AUTO_MIX_MS;
        autoEnsureMainUntil(now, autoMixUntil);  // skipped by itself when the tank is low
        telemetryDirty = true;
        break;
      }
      uint8_t p = autoQueue[autoQueueIdx++];
      if (!startPump(p, AUTO_DOSE_S)) Serial.println("[AUTO] pump timer failed");
      autoGapUntil = now + AUTO_DOSE_S * 1000UL + AUTO_DOSE_GAP_MS;
      break;
    }

    case AS_MIXING:
      if (timeReached(now, autoMixUntil)) {
        autoState = AS_WAIT;
        autoReason[0] = 0;
        autoMainInCycle = false;
        telemetryDirty = true;  // auto_phase -> idle
        autoNextEvalAt = now;  // evaluate right after mixing
      }
      break;
  }
}

// ------------------------------------------------------------------------------
// 14. ThingsBoard publishing
// ------------------------------------------------------------------------------
static void fmt(char *buf, size_t cap, float v, int decimals) { snprintf(buf, cap, "%.*f", decimals, (double)v); }

void sendTelemetry() {
  if (!mqtt.connected() || !isBound) return;
  uint32_t now = millis();
  JsonDocument d;
  char bPh[12], bEc[12], bTemp[12];
  if (phOk(now)) {
    fmt(bPh, sizeof(bPh), S.ph, 2);
    d["ph"] = serialized(bPh);
  }
  if (ecOk(now)) {
    fmt(bEc, sizeof(bEc), S.ec, 2);
    d["ec"] = serialized(bEc);
    d["tds"] = (int)lroundf(S.tds);
  }
  if (tempOk(now)) {
    fmt(bTemp, sizeof(bTemp), S.temp, 1);
    d["temp"] = serialized(bTemp);
  }
#if HAS_FLOAT_SWITCH
  d["tank_main_ok"] = S.tankOk;
#endif
  for (int i = 0; i < PUMP_COUNT; i++) d[pumps[i].telemetryKey] = (bool)pumps[i].active;
  // Cumulative measured pump run time, seconds with 1 decimal (live while ON).
  char bRun[PUMP_COUNT][16];
  for (int i = 0; i < PUMP_COUNT; i++) {
    uint64_t ms = pumpRunMsLive(i);
    snprintf(bRun[i], sizeof(bRun[i]), "%lu.%u", (unsigned long)(ms / 1000ULL), (unsigned)((ms % 1000ULL) / 100ULL));
    d[PUMP_RUN_KEYS[i]] = serialized((const char *)bRun[i]);
  }
  d["mode"] = autoMode ? "AUTO" : "MANUAL";
  d["sensor_ok"] = sensorOk(now);
  d["sim"] = false;  // real hardware, never simulated
  // AUTO cycle (doses last 2 s; the app polls every 15 s, so it shows the cycle phase)
  bool cycle = autoMode && autoState != AS_WAIT;
  d["auto_phase"] = !cycle ? "idle" : (autoState == AS_DOSING ? "dosing" : "mixing");
  char bPumps[48] = "";
  if (cycle) {
    if (autoMainInCycle) strncat(bPumps, "main", sizeof(bPumps) - strlen(bPumps) - 1);
    for (uint8_t k = 0; k < autoQueueLen; k++) {
      if (bPumps[0]) strncat(bPumps, ",", sizeof(bPumps) - strlen(bPumps) - 1);
      strncat(bPumps, pumps[autoQueue[k]].rpcName, sizeof(bPumps) - strlen(bPumps) - 1);
    }
  }
  d["auto_pumps"] = (const char *)bPumps;
  d["auto_reason"] = cycle ? (const char *)autoReason : "";
  d["auto_mix_left"] = (cycle && autoState == AS_MIXING && !timeReached(now, autoMixUntil))
                           ? (uint32_t)((autoMixUntil - now + 999) / 1000) : 0;
  char out[768];
  size_t n = serializeJson(d, out, sizeof(out));
  if (n > 0 && n < sizeof(out)) {
    mqtt.publish("v1/devices/me/telemetry", out);
    Serial.printf("[TB] telemetry %s\n", out);
  }
  lastTelemetryAt = now;
  telemetryDirty = false;
}

void publishClientAttrs(bool force) {
  static bool lastBound = false, lastPairing = false;
  static char lastOwner[65] = "\x01";
  if (!mqtt.connected()) return;
  bool pairing = isPairingWindowOpen && !isBound;
  if (!force && lastBound == isBound && lastPairing == pairing && strcmp(lastOwner, ownerName) == 0) return;
  JsonDocument d;
  d["bound"] = isBound;
  d["pairing"] = pairing;
  d["fw"] = FW_VERSION;
  d["board"] = BOARD_KIND;
  d["owner"] = ownerName;
  char b[6][12];
  JsonObject t = d["targets_applied"].to<JsonObject>();
  fmt(b[0], 12, targetPhMin, 2);  t["ph_min"] = serialized(b[0]);
  fmt(b[1], 12, targetPhMax, 2);  t["ph_max"] = serialized(b[1]);
  fmt(b[2], 12, targetEcMin, 2);  t["ec_min"] = serialized(b[2]);
  fmt(b[3], 12, targetEcMax, 2);  t["ec_max"] = serialized(b[3]);
  fmt(b[4], 12, targetTempMin, 1); t["temp_min"] = serialized(b[4]);
  fmt(b[5], 12, targetTempMax, 1); t["temp_max"] = serialized(b[5]);
  char out[384];
  size_t n = serializeJson(d, out, sizeof(out));
  if (n > 0 && n < sizeof(out)) {
    mqtt.publish("v1/devices/me/attributes", out);
    Serial.printf("[TB] client attrs bound=%d pairing=%d\n", isBound, pairing);
  }
  lastBound = isBound;
  lastPairing = pairing;
  copyStr(lastOwner, sizeof(lastOwner), ownerName);
  attrsDirty = false;
}

void publishClaimRequest() {
  if (!mqtt.connected() || isBound || !isPairingWindowOpen) return;
  uint32_t elapsed = millis() - pairingWindowStart;
  uint32_t remain = elapsed < PAIRING_WINDOW_MS ? PAIRING_WINDOW_MS - elapsed : 0;
  if (remain == 0) return;
  char out[96];
  snprintf(out, sizeof(out), "{\"secretKey\":\"%s\",\"durationMs\":%lu}", claimSecret, (unsigned long)remain);
  mqtt.publish("v1/devices/me/claim", out);
  Serial.println("[TB] claim request published");
}

void requestSharedAttributes() {
  if (!mqtt.connected()) return;
  mqtt.publish("v1/devices/me/attributes/request/1",
               "{\"sharedKeys\":\"ph_min,ph_max,ec_min,ec_max,temp_min,temp_max,bind_owner,bind_ts\"}");
}

// ------------------------------------------------------------------------------
// 15. Shared attributes + RPC
// ------------------------------------------------------------------------------
static void applyRange(JsonObjectConst s, const char *kMin, const char *kMax, float &vMin, float &vMax, float lo,
                       float hi, const char *nvMin, const char *nvMax, bool &updated) {
  if (!s[kMin].is<float>() && !s[kMax].is<float>()) return;
  float a = s[kMin].is<float>() ? s[kMin].as<float>() : vMin;
  float b = s[kMax].is<float>() ? s[kMax].as<float>() : vMax;
  a = constrain(a, lo, hi);
  b = constrain(b, lo, hi);
  if (!(a < b)) return;  // reject inverted range, keep previous values
  vMin = a;
  vMax = b;
  prefs.putFloat(nvMin, vMin);
  prefs.putFloat(nvMax, vMax);
  updated = true;
}

// isPush = live update on v1/devices/me/attributes (vs. response to our request on connect)
static void handleSharedAttributes(JsonObjectConst s, bool isPush, bool ownerDeleted) {
  bool updated = false;
  applyRange(s, "ph_min", "ph_max", targetPhMin, targetPhMax, 4.5f, 7.5f, "ph_min", "ph_max", updated);
  applyRange(s, "ec_min", "ec_max", targetEcMin, targetEcMax, 0.5f, 3.5f, "ec_min", "ec_max", updated);
  applyRange(s, "temp_min", "temp_max", targetTempMin, targetTempMax, 15.0f, 35.0f, "temp_min", "temp_max", updated);
  if (updated) attrsDirty = true;

  // ---- bind_ts / bind_owner: primary binding mechanism (contract 3) ----
  bool hasTs = s["bind_ts"].is<double>();
  double ts = hasTs ? s["bind_ts"].as<double>() : 0;
  if (hasTs && isBound && ts > lastSeenBindTs) {
    lastSeenBindTs = ts;
    prefs.putDouble("bind_ts_seen", lastSeenBindTs);
  }
  bool hasOwner = s["bind_owner"].is<const char *>() || ownerDeleted;
  if (!hasOwner) return;
  char o[65] = "";
  if (!ownerDeleted) copyStr(o, sizeof(o), s["bind_owner"].as<const char *>());
  // trim surrounding spaces
  size_t st = 0;
  while (o[st] == ' ') st++;
  if (st) memmove(o, o + st, strlen(o + st) + 1);
  for (int k = (int)strlen(o) - 1; k >= 0 && o[k] == ' '; k--) o[k] = 0;

  if (o[0]) {
    if (!isBound) {
      if (hasTs && ts <= consumedBindTs) {
        Serial.println("[BIND] ignored stale bind_owner (bind_ts already unbound)");
        return;
      }
      if (hasTs) lastSeenBindTs = ts;  // bind_owner without bind_ts is accepted
      bindDevice(o, "attr");
    } else if (strcmp(o, ownerName) != 0 || strcmp(ownerSource, "attr") != 0) {
      copyStr(ownerName, sizeof(ownerName), o);
      copyStr(ownerSource, sizeof(ownerSource), "attr");
      prefs.putString("owner", ownerName);
      prefs.putString("owner_src", ownerSource);
      attrsDirty = true;
      oledDirty = true;
      Serial.println("[BIND] owner updated from bind_owner");
    }
  } else if (isBound) {
    // App writes "" on unbind: a live push always unbinds; the value seen on the
    // connect-time sync unbinds only if the current binding came from bind_owner.
    if (isPush || strcmp(ownerSource, "attr") == 0) {
      Serial.println(isPush ? "[BIND] bind_owner cleared -> unbind" : "[BIND] bind_owner empty on sync -> unbind");
      unbindDevice();
      schedule(PA_RESET_WIFI, 1500);  // removed from the account: forget owner + WiFi (history stays on ThingsBoard)
    }
  }
}

static void rpcPublish(const char *reqId, const char *payload) {
  char topic[64];
  snprintf(topic, sizeof(topic), "v1/devices/me/rpc/response/%s", reqId);
  mqtt.publish(topic, payload);
}

static void rpcError(const char *reqId, const char *code) {
  char out[64];
  snprintf(out, sizeof(out), "{\"error\":\"%s\"}", code);
  rpcPublish(reqId, out);
  Serial.printf("[RPC] -> error %s\n", code);
}

static void rpcSuccessDoc(const char *reqId, JsonDocument &d) {
  d["success"] = true;
  char out[256];
  size_t n = serializeJson(d, out, sizeof(out));
  if (n == 0 || n >= sizeof(out)) {
    rpcPublish(reqId, "{\"success\":true}");
    return;
  }
  rpcPublish(reqId, out);
}

static void schedule(PendingAction a, uint32_t delayMs) {
  pendingAction = a;
  pendingActionAt = millis() + delayMs;
}

static void handleRpc(const char *reqId, JsonDocument &doc) {
  const char *method = doc["method"] | "";
  JsonVariantConst params = doc["params"];
  Serial.printf("[RPC] %s\n", method);

  if (strcmp(method, "setPump") == 0) {
    if (!isBound) return rpcError(reqId, "DEVICE_UNBOUND");
    const char *name = params["pump"] | "";
    int idx = -1;
    for (int i = 0; i < PUMP_COUNT; i++)
      if (strcmp(name, pumps[i].rpcName) == 0) idx = i;
    if (idx < 0) return rpcError(reqId, "UNKNOWN_PUMP");
    if (!params["seconds"].is<float>()) return rpcError(reqId, "INVALID_SECONDS");
    long secs = lroundf(params["seconds"].as<float>());
    if (secs < 0) return rpcError(reqId, "INVALID_SECONDS");
    JsonDocument r;
    r["pump"] = pumps[idx].rpcName;
    if (secs == 0) {  // contract: seconds 0 = stop now (allowed in any mode / tank state)
      stopPump(idx);
      r["seconds"] = 0;
      r["state"] = false;
      r["stopped"] = true;
      rpcSuccessDoc(reqId, r);
      telemetryDirty = true;
      return;
    }
    if (pumps[idx].chemical && autoMode) return rpcError(reqId, "AUTO_MODE_LOCKED");
#if HAS_FLOAT_SWITCH
    if (idx == P_MAIN && !S.tankOk) return rpcError(reqId, "TANK_EMPTY");
#endif
    uint32_t cap = pumps[idx].chemical ? CHEM_PUMP_MAX_S : MAIN_PUMP_MAX_S;
    uint32_t applied = (uint32_t)secs > cap ? cap : (uint32_t)secs;
    if (!startPump(idx, applied)) return rpcError(reqId, "PUMP_TIMER_FAIL");
    r["seconds"] = applied;
    r["state"] = true;
    rpcSuccessDoc(reqId, r);
    telemetryDirty = true;
    return;
  }

  if (strcmp(method, "setMode") == 0) {
    if (!isBound) return rpcError(reqId, "DEVICE_UNBOUND");
    const char *m = params["mode"] | "";
    bool wantAuto;
    if (strcmp(m, "AUTO") == 0) wantAuto = true;
    else if (strcmp(m, "MANUAL") == 0) wantAuto = false;
    else return rpcError(reqId, "INVALID_MODE");
    if (wantAuto != autoMode) {
      stopChemicalPumps();  // no manual dose survives into AUTO, no AUTO dose into MANUAL
      autoMode = wantAuto;
      prefs.putString("mode", autoMode ? "AUTO" : "MANUAL");
      autoReset(AUTO_FIRST_EVAL_AFTER_MODE_MS);
    }
    JsonDocument r;
    r["mode"] = autoMode ? "AUTO" : "MANUAL";
    rpcSuccessDoc(reqId, r);
    telemetryDirty = true;
    oledDirty = true;
    return;
  }

  if (strcmp(method, "bind") == 0) {
    const char *o = params["owner"] | "";
    bindDevice(o, "rpc");
    JsonDocument r;
    r["bound"] = true;
    r["owner"] = ownerName;
    rpcSuccessDoc(reqId, r);
    return;
  }

  if (strcmp(method, "unbind") == 0) {
    unbindDevice();
    JsonDocument r;
    r["bound"] = false;
    rpcSuccessDoc(reqId, r);
    schedule(PA_RESET_WIFI, 1500);  // removed from the account: forget owner + WiFi, restart into pairing
    return;
  }

  if (strcmp(method, "enablePairing") == 0) {
    openPairingWindow();
    JsonDocument r;
    r["pairingMs"] = PAIRING_WINDOW_MS;
    rpcSuccessDoc(reqId, r);
    return;
  }

  if (strcmp(method, "resetWifi") == 0) {
    // reply with the same details as the QR ({"d","c","m"}) so the owner's app (the only one allowed
    // to call RPC) goes straight to Wi-Fi entry; the claim secret is kept across a Wi-Fi reset
    JsonDocument r;
    r["d"] = (const char *)deviceId;
    r["c"] = (const char *)claimSecret;
    r["m"] = (const char *)btMacStr;
    rpcSuccessDoc(reqId, r);
    stopAllPumps();
    schedule(PA_RESET_WIFI, 800);
    return;
  }

  if (strcmp(method, "reboot") == 0) {
    rpcPublish(reqId, "{\"success\":true}");
    stopAllPumps();
    schedule(PA_REBOOT, 800);
    return;
  }

  if (strcmp(method, "factoryReset") == 0) {
    stopAllPumps();
    mqtt.publish("v1/devices/me/attributes", "{\"bound\":false,\"pairing\":false,\"owner\":\"\"}");
    rpcPublish(reqId, "{\"success\":true}");
    schedule(PA_FACTORY_RESET, 800);
    return;
  }

  if (strcmp(method, "calibratePh") == 0) {
    if (!isBound) return rpcError(reqId, "DEVICE_UNBOUND");
    int point = params["point"] | 0;
    if (point != 7 && point != 4) return rpcError(reqId, "INVALID_POINT");
    uint32_t now = millis();
    // need a fresh, stable, in-window voltage from the probe (phVoltOk is recomputed every
    // 5 s cycle and cleared on any I2C failure)
    (void)now;
    if (!S.adsOk || !S.phVoltOk) return rpcError(reqId, "PH_SIGNAL_INVALID");
    float v = S.phSensorV;
    float n7 = (point == 7) ? v : phCalV7;
    float n4 = (point == 4) ? v : phCalV4;
    if (fabsf(n7 - n4) < PH_CAL_MIN_SPAN_V) return rpcError(reqId, "CAL_SPAN_TOO_SMALL");
    phCalV7 = n7;
    phCalV4 = n4;
    phCalMask |= (point == 7) ? 0x01 : 0x02;
    saveCalibration();
    char bv[12], b7[12], b4[12];
    fmt(bv, 12, v, 3);
    fmt(b7, 12, phCalV7, 3);
    fmt(b4, 12, phCalV4, 3);
    JsonDocument r;
    r["point"] = point;
    r["voltage"] = serialized(bv);
    r["v7"] = serialized(b7);
    r["v4"] = serialized(b4);
    r["calibrated"] = (phCalMask == PH_CAL_ALL);
    rpcSuccessDoc(reqId, r);
    Serial.printf("[CAL] pH%d stored at %.3f V\n", point, (double)v);
    return;
  }

  rpcError(reqId, "METHOD_NOT_SUPPORTED");
}

void mqttCallback(char *topic, byte *payload, unsigned int length) {
  // Copy everything we need out of PubSubClient's buffer BEFORE publishing anything
  // (publish() reuses the same buffer).
  static const char RPC_PREFIX[] = "v1/devices/me/rpc/request/";
  char reqId[16] = "";
  bool isRpc = strncmp(topic, RPC_PREFIX, sizeof(RPC_PREFIX) - 1) == 0;
  bool isAttr = strcmp(topic, "v1/devices/me/attributes") == 0 ||
                strncmp(topic, "v1/devices/me/attributes/response/", 34) == 0;
  if (isRpc) copyStr(reqId, sizeof(reqId), topic + sizeof(RPC_PREFIX) - 1);

  JsonDocument doc;  // ArduinoJson 7 copies strings from the input
  if (deserializeJson(doc, payload, length)) return;

  if (isRpc) {
    handleRpc(reqId, doc);
  } else if (isAttr) {
    bool isPush = strcmp(topic, "v1/devices/me/attributes") == 0;
    bool ownerDeleted = false;
    if (doc["deleted"].is<JsonArrayConst>()) {
      for (JsonVariantConst k : doc["deleted"].as<JsonArrayConst>())
        if (k.is<const char *>() && strcmp(k.as<const char *>(), "bind_owner") == 0) ownerDeleted = true;
    }
    if (doc["shared"].is<JsonObjectConst>())
      handleSharedAttributes(doc["shared"].as<JsonObjectConst>(), isPush, ownerDeleted);
    else
      handleSharedAttributes(doc.as<JsonObjectConst>(), isPush, ownerDeleted);
  }
}

// ------------------------------------------------------------------------------
// 16. BLE provisioning - callbacks ONLY set flags / enqueue, work happens in loop()
// ------------------------------------------------------------------------------
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override {
    bleConnected = true;
    bleConnectEvent = true;
  }
  void onDisconnect(BLEServer *s) override {
    bleConnected = false;
    bleDisconnectEvent = true;
  }
};

class CharCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    static BleMsg m;  // only the BLE host task calls this
    size_t n = c->getLength();
    if (n == 0) return;
    if (n >= sizeof(m.data)) {
      bleWriteDropped = true;
      return;
    }
    memcpy(m.data, c->getData(), n);
    m.data[n] = 0;
    m.len = (uint16_t)n;
    if (bleQueue) xQueueSend(bleQueue, &m, 0);
  }
};

void markBleDirty(bool notify) {
  bleStatusDirty = true;
  if (notify) bleNotifyPending = true;
}

static bool authLockActive(uint32_t now) {
  if (authLocked && timeReached(now, authLockUntil)) {
    authLocked = false;
    authFailCount = 0;
    verifyFailCount = 0;
  }
  return authLocked;
}

static size_t buildBleStatus(char *out, size_t cap, bool withNetworks) {
  uint32_t now = millis();
  JsonDocument d;
  bool connected = WiFi.status() == WL_CONNECTED;
  bool locked = authLockActive(now);
  const char *ws;
  const char *err = "";
  if (wifiTesting) {
    ws = "testing";
  } else if (locked) {
    ws = "error";
    err = "ERR_LOCKED_OUT";
  } else if (bleWifiError[0]) {
    ws = "error";
    err = bleWifiError;
  } else if (connected) {
    ws = "ok";
  } else {
    ws = "idle";
  }
  if (!err[0] && bleAuthError[0]) err = bleAuthError;
  d["wifi_status"] = ws;
  if (err[0]) d["error"] = err;
  char ip[16] = "";
  if (connected) {
    IPAddress a = WiFi.localIP();
    snprintf(ip, sizeof(ip), "%u.%u.%u.%u", a[0], a[1], a[2], a[3]);
    d["ip"] = (const char *)ip;
  }
  d["status"] = (const char *)bleEvent;
  d["auth"] = bleAuthenticated;
  d["device"] = (const char *)deviceId;
  d["locked"] = locked;
  if (locked) d["retryAfterMs"] = (uint32_t)(authLockUntil - now);
  if (bleAttemptsLeft >= 0) d["attemptsLeft"] = bleAttemptsLeft;
  if (bleAuthenticated) d["c"] = (const char *)claimSecret;
  d["scanning"] = scanRunning || scanRequested;
  size_t n = serializeJson(d, out, cap);
  if (!withNetworks) return n;

  // networks stay in READ until the next scan; drop entries to fit the ATT limit
  JsonArray arr = d["networks"].to<JsonArray>();
  for (uint8_t i = 0; i < netCount; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["ssid"] = (const char *)nets[i].ssid;
    o["rssi"] = nets[i].rssi;
    if (measureJson(d) > BLE_VALUE_MAX) {
      arr.remove(arr.size() - 1);
      break;
    }
  }
  return serializeJson(d, out, cap);
}

static void publishBleStatus() {
  if (!pBleChar) return;
  static char full[BLE_VALUE_MAX + 12];
  static char compact[320];
  size_t nc = buildBleStatus(compact, sizeof(compact), false);
  size_t nf = buildBleStatus(full, sizeof(full), true);
  if (bleNotifyPending && bleConnected && nc > 0 && nc < sizeof(compact)) {
    // notify a compact copy (fits a negotiated MTU), READ always returns the full status
    pBleChar->setValue((uint8_t *)compact, nc);
    pBleChar->notify();
  }
  if (nf > 0 && nf < sizeof(full)) pBleChar->setValue((uint8_t *)full, nf);
  bleNotifyPending = false;
  bleStatusDirty = false;
}

static void startBleAdvertising() {
  if (isBleAdvertising || !pBleServer) return;
  BLEDevice::startAdvertising();
  isBleAdvertising = true;
  Serial.println("[BLE] advertising ON");
}

static void stopBleAdvertising() {
  if (!isBleAdvertising) return;
  BLEDevice::getAdvertising()->stop();
  isBleAdvertising = false;
  Serial.println("[BLE] advertising OFF");
}

// WiFi.begin() while the STA is still busy with the stored network is refused silently (STA busy),
// so the real begin() is deferred a little and retried from wifiTick() (non-blocking).
static bool wifiTestBeginPending = false;
static uint32_t wifiTestBeginAt = 0;
static uint8_t wifiTestBeginTries = 0;
static uint8_t wifiTestAttempt = 0;
static bool wifiTestLastWasPassword = false;

static void beginWifiTest() {
  wifiTesting = true;
  wifiTestStart = millis();
  bleWifiError[0] = 0;
  lastDiscReason = 0;
  if (scanRunning) {
    WiFi.scanDelete();
    scanRunning = false;
  }
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);  // stop any reconnect attempt to the stored network
  wifiTestBeginPending = true;
  wifiTestBeginTries = 0;
  wifiTestAttempt = 1;
  wifiTestLastWasPassword = false;
  wifiTestBeginAt = millis() + 600;
  Serial.println("[WiFi] testing new credentials (hidden)");
}

static void handleAuthFailure(bool withWifiPayload) {
  authFailCount++;
  Serial.printf("[BLE] secret auth FAILED (%d/3)\n", authFailCount);
  copyStr(bleEvent, sizeof(bleEvent), "error");
  if (authFailCount >= 3) {
    authLocked = true;
    authLockUntil = millis() + AUTH_LOCKOUT_MS;
    generateVerifyCodes();
    copyStr(bleEvent, sizeof(bleEvent), "locked");
    bleAttemptsLeft = 0;
  } else {
    copyStr(bleAuthError, sizeof(bleAuthError), "ERR_AUTH_FAILED");
    bleAttemptsLeft = 3 - authFailCount;
    if (withWifiPayload) copyStr(bleWifiError, sizeof(bleWifiError), "ERR_AUTH_FAILED");
  }
}

static void handleBleCommand(const char *json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) return;
  uint32_t now = millis();
  markBleDirty(true);

  if (authLockActive(now)) {
    Serial.println("[BLE] command rejected: lockout");
    return;  // status shows wifi_status:error + ERR_LOCKED_OUT
  }

  const char *cmd = doc["cmd"] | "";
  const char *c = doc["c"].is<const char *>() ? doc["c"].as<const char *>() : (doc["secret"] | "");
  bool hasWifi = doc["ssid"].is<const char *>() && doc["pass"].is<const char *>();

  // ---- 1. auth (sent once; empty c never counts as a failed attempt) ----
  bool isAuthCmd = strcmp(cmd, "auth") == 0;
  if (c[0] && (isAuthCmd || !bleAuthenticated)) {
    if (constantTimeEq(c, claimSecret)) {
      if (!bleAuthenticated) Serial.println("[BLE] secret auth OK");
      bleAuthenticated = true;
      authFailCount = 0;
      verifyFailCount = 0;
      bleAuthError[0] = 0;
      if (strcmp(bleWifiError, "UNAUTHORIZED") == 0 || strcmp(bleWifiError, "ERR_AUTH_FAILED") == 0)
        bleWifiError[0] = 0;
      bleAttemptsLeft = -1;
      copyStr(bleEvent, sizeof(bleEvent), "auth_ok");
      refreshPairingForClaim("BLE auth ok");
    } else {
      handleAuthFailure(hasWifi);
      return;
    }
    if (!hasWifi) return;
  } else if (isAuthCmd) {
    // empty secret: reported, but NOT counted as a failed attempt
    if (!bleAuthenticated) {
      copyStr(bleEvent, sizeof(bleEvent), "error");
      copyStr(bleAuthError, sizeof(bleAuthError), "ERR_SECRET_EMPTY");
    }
    return;
  }

  // ---- 2. numeric comparison ----
  if (strcmp(cmd, "start_verify") == 0) {
    if (lockedCode < 100000) generateVerifyCodes();
    copyStr(bleEvent, sizeof(bleEvent), "verify_ready");
    oledDirty = true;  // OLED shows the 6-digit code (never sent over BLE / printed to Serial)
    return;
  }
  if (doc["selectedCode"].is<int>() || strcmp(cmd, "verify_code") == 0) {
    int chosen = doc["selectedCode"] | (doc["code"] | -1);
    if (lockedCode >= 100000 && chosen == lockedCode) {  // ต้องเป็นเลข 6 หลักที่สร้างแล้วเท่านั้น
      bleAuthenticated = true;
      authFailCount = 0;
      verifyFailCount = 0;
      bleAuthError[0] = 0;
      bleAttemptsLeft = -1;
      copyStr(bleEvent, sizeof(bleEvent), "verified");
      Serial.println("[BLE] numeric verification OK");
      refreshPairingForClaim("BLE numeric verify ok");
    } else {
      verifyFailCount++;
      generateVerifyCodes();
      Serial.printf("[BLE] numeric verification FAILED (%d/2)\n", verifyFailCount);
      if (verifyFailCount >= 2) {
        authLocked = true;
        authLockUntil = now + AUTH_LOCKOUT_MS;
        copyStr(bleEvent, sizeof(bleEvent), "locked");
        bleAttemptsLeft = 0;
      } else {
        copyStr(bleEvent, sizeof(bleEvent), "wrong");
        copyStr(bleAuthError, sizeof(bleAuthError), "ERR_CODE_MISMATCH");
        bleAttemptsLeft = 2 - verifyFailCount;
      }
    }
    oledDirty = true;
    if (!hasWifi) return;
  }

  // ---- 3. WiFi scan (async, started from loop) ----
  if (strcmp(cmd, "scan_wifi") == 0) {
    scanRequested = true;
    copyStr(bleEvent, sizeof(bleEvent), "scanning");
    return;
  }

  // ---- 4. WiFi credentials ----
  if (hasWifi) {
    if (!bleAuthenticated) {
      copyStr(bleWifiError, sizeof(bleWifiError), "UNAUTHORIZED");
      Serial.println("[BLE] WiFi credentials rejected: not authenticated");
      return;
    }
    const char *ssid = doc["ssid"];
    const char *pass = doc["pass"];
    if (strlen(ssid) == 0 || strlen(ssid) > 32 || strlen(pass) > 64) {
      copyStr(bleWifiError, sizeof(bleWifiError), "ERR_WIFI_INVALID");
      return;
    }
    if (doc["tb_token"].is<const char *>()) {
      const char *tok = doc["tb_token"];
      if (tok[0] && strlen(tok) < sizeof(tbToken)) {
        copyStr(tbToken, sizeof(tbToken), tok);
        prefs.putString("tb_tok_ble", tbToken);
        tokenConfigured = true;
        tbIpValid = false;
      }
    }
    if (WiFi.status() == WL_CONNECTED && strcmp(WiFi.SSID().c_str(), ssid) == 0 && strcmp(wifiPass, pass) == 0) {
      bleWifiError[0] = 0;  // already on this network
      refreshPairingForClaim("already on same SSID");
      return;
    }
    copyStr(pendSsid, sizeof(pendSsid), ssid);
    copyStr(pendPass, sizeof(pendPass), pass);
    refreshPairingForClaim("WiFi credentials received");
    beginWifiTest();
    return;
  }
  // "bind_success" and unknown commands: no action (binding comes via bind_owner / RPC)
}

static void wifiFailureCode(uint8_t reason, char *out, size_t cap) {
  switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:
    case 210:  // NO_AP_FOUND_W_COMPATIBLE_SECURITY
    case 211:  // NO_AP_FOUND_IN_AUTHMODE_THRESHOLD
    case 212:  // NO_AP_FOUND_IN_RSSI_THRESHOLD
      copyStr(out, cap, "ERR_WIFI_NO_AP_FOUND");
      break;
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_AUTH_EXPIRE:
    case WIFI_REASON_MIC_FAILURE:
      copyStr(out, cap, "ERR_WIFI_WRONG_PASSWORD");
      break;
    default:
      copyStr(out, cap, "ERR_WIFI_TIMEOUT");
      break;
  }
}

static bool isPasswordWifiReason(uint8_t r) {
  return r == WIFI_REASON_AUTH_FAIL || r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || r == WIFI_REASON_HANDSHAKE_TIMEOUT ||
         r == WIFI_REASON_AUTH_EXPIRE || r == WIFI_REASON_MIC_FAILURE;
}

static bool isFatalWifiReason(uint8_t r) {
  return r == WIFI_REASON_NO_AP_FOUND || r == 210 || r == 211 || r == 212 || r == WIFI_REASON_AUTH_FAIL ||
         r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || r == WIFI_REASON_HANDSHAKE_TIMEOUT;
}

void bleTick(uint32_t now) {
  if (bleConnectEvent) {
    bleConnectEvent = false;
    isBleAdvertising = false;  // the stack stops advertising on connect
    bleAuthenticated = false;
    bleEvent[0] = 0;
    bleAuthError[0] = 0;
    bleAttemptsLeft = -1;
    markBleDirty(false);
    oledDirty = true;
    Serial.println("[BLE] client connected");
  }
  if (bleDisconnectEvent) {
    bleDisconnectEvent = false;
    isBleAdvertising = false;  // re-advertise below if the window is still open
    bleAuthenticated = false;
    bleEvent[0] = 0;
    markBleDirty(false);
    oledDirty = true;
    Serial.println("[BLE] client disconnected");
  }
  if (bleWriteDropped) {
    bleWriteDropped = false;
    Serial.println("[BLE] oversized write dropped");
  }

  static BleMsg m;
  while (bleQueue && xQueueReceive(bleQueue, &m, 0) == pdTRUE) handleBleCommand(m.data);

  // advertising policy: only while the pairing window is open and nobody is connected
  bool shouldAdvertise = isPairingWindowOpen && !bleConnected;
  if (shouldAdvertise) startBleAdvertising();
  else if (isBleAdvertising) stopBleAdvertising();

  static uint32_t lastPeriodic = 0;
  if (bleConnected && (now - lastPeriodic) >= 2000) {
    lastPeriodic = now;
    bleStatusDirty = true;  // keep wifi_status / ip / lockout timer fresh for READ
  }
  if (bleStatusDirty) publishBleStatus();
}

// ------------------------------------------------------------------------------
// 17. WiFi (provisioning test, async scan, reconnect with back-off) + MQTT
// ------------------------------------------------------------------------------
void wifiTick(uint32_t now) {
  bool connected = WiFi.status() == WL_CONNECTED;

  // ---- credential test started from BLE ----
  if (wifiTesting && wifiTestBeginPending) {
    // a WiFi scan requested by the app is still running -> begin() would be refused; wait (max 8 s)
    if (WiFi.scanComplete() == WIFI_SCAN_RUNNING && (int32_t)(now - wifiTestBeginAt) < 8000) return;
    if ((int32_t)(now - wifiTestBeginAt) >= 0) {
      if (WiFi.scanComplete() == WIFI_SCAN_RUNNING) WiFi.scanDelete();
      wl_status_t r = WiFi.begin(pendSsid, pendPass);
      wifiTestBeginTries++;
      if (r == WL_CONNECT_FAILED && wifiTestBeginTries < 4) {
        wifiTestBeginAt = now + 1000;
        Serial.printf("[WiFi] begin() refused (STA busy), retry %u/3\n", (unsigned)wifiTestBeginTries);
      } else {
        wifiTestBeginPending = false;
        lastDiscReason = 0;    // drop stale reasons from the stored-network attempt
        wifiTestStart = now;   // the test timeout counts from the real begin()
        Serial.printf("[WiFi] test begin() -> %d (try %u)\n", (int)r, (unsigned)wifiTestBeginTries);
      }
    }
    return;
  }
  if (wifiTesting) {
    if (connected && strcmp(WiFi.SSID().c_str(), pendSsid) == 0) {
      wifiTesting = false;
      copyStr(wifiSsid, sizeof(wifiSsid), pendSsid);
      copyStr(wifiPass, sizeof(wifiPass), pendPass);
      prefs.putString("wifi_ssid", wifiSsid);
      prefs.putString("wifi_pass", wifiPass);
      memset(pendPass, 0, sizeof(pendPass));
      bleWifiError[0] = 0;
      wifiBackoffMs = WIFI_BACKOFF_MIN_MS;
      mqttBackoffMs = MQTT_BACKOFF_MIN_MS;
      mqttNextAttemptAt = now;
      tbIpValid = false;
      markBleDirty(true);
      oledDirty = true;
      refreshPairingForClaim("WiFi test ok");
      Serial.println("[WiFi] new credentials OK, saved");
    } else {
      uint8_t r = lastDiscReason;
      bool fatal = (now - wifiTestStart) > 2500 && isFatalWifiReason(r);
      bool attemptOver = fatal || (now - wifiTestStart) > WIFI_TEST_TIMEOUT_MS;
      bool pw = isPasswordWifiReason(r);
      // retry unless out of attempts, or the same wrong-password reason came twice in a row
      if (attemptOver && wifiTestAttempt < WIFI_TEST_ATTEMPTS && !(pw && wifiTestLastWasPassword)) {
        Serial.printf("[WiFi] test attempt %u/%u failed (reason %u) -> retry\n", (unsigned)wifiTestAttempt,
                      (unsigned)WIFI_TEST_ATTEMPTS, (unsigned)r);
        wifiTestLastWasPassword = pw;
        wifiTestAttempt++;
        WiFi.disconnect(false, false);
        wifiTestBeginPending = true;
        wifiTestBeginTries = 0;
        wifiTestBeginAt = now + 800;
        return;
      }
      if (attemptOver) {
        wifiTesting = false;
        wifiFailureCode(r, bleWifiError, sizeof(bleWifiError));
        memset(pendPass, 0, sizeof(pendPass));
        WiFi.disconnect(false, false);
        wifiNextAttemptAt = now + WIFI_BACKOFF_MIN_MS;  // fall back to the stored network, if any
        markBleDirty(true);
        oledDirty = true;
        Serial.printf("[WiFi] test failed: %s (reason %u)\n", bleWifiError, r);
      }
    }
    return;
  }

  // ---- async scan ----
  if (scanRequested && !scanRunning) {
    scanRequested = false;
    if (!connected) {
      WiFi.disconnect(false, false);  // a connecting STA cannot scan
      wifiNextAttemptAt = now + 10000;
    }
    WiFi.mode(WIFI_STA);
    int16_t r = WiFi.scanNetworks(true, false, false, 120);  // async, ~1.6 s for all channels
    scanRunning = (r == WIFI_SCAN_RUNNING);
    if (!scanRunning) {
      copyStr(bleEvent, sizeof(bleEvent), "scan_failed");
      markBleDirty(true);
    }
  }
  if (scanRunning) {
    int16_t n = WiFi.scanComplete();
    if (n >= 0) {
      netCount = 0;
      for (int16_t i = 0; i < n && netCount < 12; i++) {
        String s = WiFi.SSID(i);  // short-lived, scan results only
        if (s.length() == 0 || s.length() > 32) continue;
        int8_t rssi = (int8_t)WiFi.RSSI(i);
        bool dup = false;
        for (uint8_t k = 0; k < netCount; k++) {
          if (strcmp(nets[k].ssid, s.c_str()) == 0) {
            if (rssi > nets[k].rssi) nets[k].rssi = rssi;
            dup = true;
            break;
          }
        }
        if (dup) continue;
        copyStr(nets[netCount].ssid, sizeof(nets[netCount].ssid), s.c_str());
        nets[netCount].rssi = rssi;
        netCount++;
      }
      // strongest first
      for (uint8_t a = 1; a < netCount; a++) {
        WifiNet k = nets[a];
        int b = a - 1;
        while (b >= 0 && nets[b].rssi < k.rssi) {
          nets[b + 1] = nets[b];
          b--;
        }
        nets[b + 1] = k;
      }
      WiFi.scanDelete();
      scanRunning = false;
      copyStr(bleEvent, sizeof(bleEvent), "scan_done");
      markBleDirty(true);
      Serial.printf("[WiFi] scan done: %u networks\n", netCount);
    } else if (n == WIFI_SCAN_FAILED) {
      scanRunning = false;
      copyStr(bleEvent, sizeof(bleEvent), "scan_failed");
      markBleDirty(true);
    }
  }

  // ---- connection state changes ----
  if (connected != wifiWasConnected) {
    wifiWasConnected = connected;
    markBleDirty(false);
    oledDirty = true;
    if (connected) {
      wifiBackoffMs = WIFI_BACKOFF_MIN_MS;
      mqttNextAttemptAt = now;
      configTime(0, 0, "pool.ntp.org", "time.google.com");  // UTC epoch for offline-log timestamps (async SNTP)
      Serial.println("[WiFi] connected");
      refreshPairingForClaim("WiFi connected");
    } else {
      wifiNextAttemptAt = now + withJitter(WIFI_BACKOFF_MIN_MS);
      Serial.println("[WiFi] disconnected");
    }
  }

  // ---- reconnect stored network with exponential back-off + jitter ----
  if (!connected && wifiSsid[0] && !scanRunning && timeReached(now, wifiNextAttemptAt)) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(wifiSsid, wifiPass);
    wifiNextAttemptAt = now + withJitter(wifiBackoffMs);
    wifiBackoffMs = wifiBackoffMs * 2 > WIFI_BACKOFF_MAX_MS ? WIFI_BACKOFF_MAX_MS : wifiBackoffMs * 2;
    Serial.println("[WiFi] reconnecting (stored network)");
  }
}

static void onMqttConnected() {
  mqtt.subscribe("v1/devices/me/rpc/request/+");
  mqtt.subscribe("v1/devices/me/attributes");
  mqtt.subscribe("v1/devices/me/attributes/response/+");
  publishClientAttrs(true);
  requestSharedAttributes();  // includes bind_owner -> self-bind if the RPC was missed
  publishClaimRequest();
  telemetryDirty = true;
  oledDirty = true;
  mqttUpSince = millis();  // offline backlog starts a few seconds after the live row
  Serial.println("[MQTT] connected to ThingsBoard");
}

void mqttTick(uint32_t now) {
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  bool up = mqtt.connected();
  if (up) {
    mqtt.loop();
    up = mqtt.connected();
  }
  if (up != mqttWasConnected) {
    mqttWasConnected = up;
    oledDirty = true;
    if (!up) {
      mqttBackoffMs = MQTT_BACKOFF_MIN_MS;
      mqttNextAttemptAt = now + withJitter(mqttBackoffMs);
      Serial.println("[MQTT] disconnected");
    }
  }
  if (up || !wifiUp || !tokenConfigured || wifiTesting || scanRunning) return;
  if (!timeReached(now, mqttNextAttemptAt)) return;

  // Step 1: DNS in its own loop pass (can block a few seconds) - WDT fed right before.
  if (!tbIpValid) {
    esp_task_wdt_reset();
    if (WiFi.hostByName(DEFAULT_TB_SERVER, tbIp) == 1) {
      tbIpValid = true;
      mqtt.setServer(tbIp, TB_MQTT_PORT);
      mqttNextAttemptAt = now;  // connect on the next pass
    } else {
      Serial.println("[MQTT] DNS failed");
      mqttNextAttemptAt = now + withJitter(mqttBackoffMs);
      mqttBackoffMs = mqttBackoffMs * 2 > MQTT_BACKOFF_MAX_MS ? MQTT_BACKOFF_MAX_MS : mqttBackoffMs * 2;
    }
    return;
  }

  // Step 2: TCP (3 s timeout) + CONNACK (3 s socket timeout)
  esp_task_wdt_reset();
  Serial.println("[MQTT] connecting...");
  if (mqtt.connect(deviceId, tbToken, nullptr)) {
    mqttBackoffMs = MQTT_BACKOFF_MIN_MS;
    mqttWasConnected = true;
    onMqttConnected();
  } else {
    Serial.printf("[MQTT] connect failed rc=%d, retry in ~%lu ms\n", mqtt.state(), (unsigned long)mqttBackoffMs);
    mqttNextAttemptAt = millis() + withJitter(mqttBackoffMs);
    mqttBackoffMs = mqttBackoffMs * 2 > MQTT_BACKOFF_MAX_MS ? MQTT_BACKOFF_MAX_MS : mqttBackoffMs * 2;
    tbIpValid = false;  // re-resolve next time (cloud IP may have moved)
  }
  esp_task_wdt_reset();
}

// Bound + Wi-Fi down >= 2 min -> open the BLE pairing window (the stored network keeps being retried
// by wifiTick). Closed again once Wi-Fi is back and no phone is connected over BLE.
void offlinePairingTick(uint32_t now) {
  bool up = WiFi.status() == WL_CONNECTED;
  if (up || !isBound) {
    wifiDownSince = 0;
    if (offlinePairing && (!isBound || (!bleConnected && !wifiTesting))) {
      offlinePairing = false;
      if (isBound && isPairingWindowOpen) closePairingWindow();
      Serial.println("[PAIR] Wi-Fi back -> offline pairing window closed");
    }
    return;
  }
  if (wifiDownSince == 0) {
    wifiDownSince = now ? now : 1;
    return;
  }
  if (!offlinePairing && !bleConnected && (now - wifiDownSince) >= OFFLINE_PAIR_AFTER_MS) {
    offlinePairing = true;
    if (!isPairingWindowOpen) openPairingWindow();
    oledDirty = true;
    Serial.println("[PAIR] Wi-Fi down 2 min -> pairing window open until Wi-Fi is back");
  }
}

// ------------------------------------------------------------------------------
// 17b. Offline log: while the cloud is unreachable the board records one row per minute,
//      then sends the backlog to ThingsBoard with the original timestamps when it is back.
//      Real time comes from NTP only (never guessed): rows taken before the clock is known are
//      kept in PSRAM with uptime and converted once NTP answers; a power cut before that loses
//      them on purpose (no real time = no row).
// ------------------------------------------------------------------------------
static const uint32_t OLOG_INTERVAL_MS = 60000;        // one row per minute while offline
static const uint32_t OLOG_MAX_ROWS = 200000;          // 200000 x 44 B = 8.8 MB on FFat (~138 days)
static const uint32_t OLOG_FLASH_BATCH = 10;           // flash write every 10 rows (~10 min) to spare the flash
static const uint32_t OLOG_RAM_CAP = 10080;            // PSRAM rows (7 days) waiting for real time / flash
static const uint8_t OLOG_SEND_BATCH = 10;             // rows per MQTT message
static const uint32_t OLOG_SEND_GAP_MS = 2000;         // pace the backlog (ThingsBoard rate limits)
static const uint32_t OLOG_AFTER_CONNECT_MS = 5000;    // live telemetry goes first, backlog after
static const int64_t EPOCH_VALID_MS = 1700000000000LL; // clock before Nov 2023 = not synced yet
#define OLOG_FILE "/olog.bin"

bool ologFsOk = false;
uint32_t ologHead = 0, ologCount = 0;  // flash ring (rows)
LogRec *ologRam = nullptr;
uint32_t ologRamCap = 0, ologRamHead = 0, ologRamCount = 0;
bool ologHasRelative = false;
bool ologWasOffline = false;
uint32_t ologNextSampleAt = 0;
uint32_t ologNextSendAt = 0;
uint32_t ologUnsavedSends = 0;
bool ologBacklogPending = false;

static int64_t epochNowMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  int64_t ms = (int64_t)tv.tv_sec * 1000LL + tv.tv_usec / 1000;
  return ms >= EPOCH_VALID_MS ? ms : 0;
}
static int64_t uptimeMs() { return esp_timer_get_time() / 1000; }

static uint8_t ologCrc(const LogRec &r) {
  const uint8_t *p = (const uint8_t *)&r;
  uint8_t c = 0xA5;
  for (size_t i = 0; i < sizeof(LogRec); i++) {
    if (i == offsetof(LogRec, crc)) continue;
    c ^= p[i];
    for (int b = 0; b < 8; b++) c = (c & 0x80) ? (uint8_t)((c << 1) ^ 0x07) : (uint8_t)(c << 1);
  }
  return c;
}

static void ologSaveMeta() {
  prefs.putULong("lg_head", ologHead);
  prefs.putULong("lg_cnt", ologCount);
  ologUnsavedSends = 0;
}

void ologBegin() {
  if (psramFound()) {
    ologRam = (LogRec *)ps_malloc(OLOG_RAM_CAP * sizeof(LogRec));
    if (ologRam) ologRamCap = OLOG_RAM_CAP;
  }
  if (!ologRam) {
    ologRam = (LogRec *)malloc(64 * sizeof(LogRec));  // no PSRAM: small RAM buffer only
    ologRamCap = ologRam ? 64 : 0;
  }
  ologFsOk = FFat.begin(true);  // formats the FATFS partition on first boot
  if (!ologFsOk) {
    Serial.println("[LOG] FFat mount FAILED - offline rows kept in RAM only");
    return;
  }
  ologHead = prefs.getULong("lg_head", 0);
  ologCount = prefs.getULong("lg_cnt", 0);
  size_t sz = 0;
  if (FFat.exists(OLOG_FILE)) {
    File f = FFat.open(OLOG_FILE, "r");
    if (f) {
      sz = f.size();
      f.close();
    }
  }
  uint32_t rowsOnFlash = sz / sizeof(LogRec);
  // the next write position must be inside the file or exactly at its end (ring grows by appending)
  bool sane = ologHead < OLOG_MAX_ROWS && ologCount <= OLOG_MAX_ROWS && rowsOnFlash <= OLOG_MAX_ROWS &&
              ologHead <= rowsOnFlash && ologCount <= rowsOnFlash &&
              ((ologHead + ologCount) % OLOG_MAX_ROWS) <= rowsOnFlash;
  if (!sane) {
    Serial.println("[LOG] log index inconsistent -> starting a new log");
    FFat.remove(OLOG_FILE);
    ologHead = 0;
    ologCount = 0;
    ologSaveMeta();
  }
  if (!FFat.exists(OLOG_FILE)) {
    File f = FFat.open(OLOG_FILE, "w");
    if (f) f.close();
    ologHead = 0;
    ologCount = 0;
    ologSaveMeta();
  }
  ologBacklogPending = ologCount > 0;
  Serial.printf("[LOG] FFat %u KB free, %lu rows waiting to be sent\n",
                (unsigned)((FFat.totalBytes() - FFat.usedBytes()) / 1024), (unsigned long)ologCount);
}

static void ologMakeRec(uint32_t now, LogRec &r) {
  memset(&r, 0, sizeof(r));
  int64_t e = epochNowMs();
  r.ts = e > 0 ? e : -(uptimeMs() + 1);
  r.ph = phOk(now) ? S.ph : NAN;
  r.ec = ecOk(now) ? S.ec : NAN;
  r.tds = ecOk(now) ? (uint16_t)constrain(lroundf(S.tds), 0L, 65534L) : 0xFFFF;
  r.temp = tempOk(now) ? S.temp : NAN;
#if HAS_FLOAT_SWITCH
  r.flags |= (S.tankOk ? 0x01 : 0) | 0x02;
#endif
  for (int i = 0; i < PUMP_COUNT; i++) {
    if (pumps[i].active) r.flags |= (uint8_t)(1u << (2 + i));
    r.runDs[i] = (uint32_t)(pumpRunMsLive(i) / 100ULL);
  }
  if (autoMode) r.flags |= 0x80;
  r.crc = ologCrc(r);
}

static void ologRamPush(const LogRec &r) {
  if (!ologRamCap) return;
  if (ologRamCount == ologRamCap) {  // full: drop the oldest row
    ologRamHead = (ologRamHead + 1) % ologRamCap;
    ologRamCount--;
  }
  ologRam[(ologRamHead + ologRamCount) % ologRamCap] = r;
  ologRamCount++;
  if (r.ts < 0) ologHasRelative = true;
}

// NTP answered: turn uptime-stamped rows (this boot only) into real time.
static void ologConvertRelative() {
  if (!ologHasRelative) return;
  int64_t e = epochNowMs();
  if (e <= 0) return;
  int64_t up = uptimeMs();
  for (uint32_t k = 0; k < ologRamCount; k++) {
    LogRec &r = ologRam[(ologRamHead + k) % ologRamCap];
    if (r.ts < 0) {
      int64_t at = -r.ts - 1;
      r.ts = e - (up - at);
      r.crc = ologCrc(r);
    }
  }
  ologHasRelative = false;
  Serial.println("[LOG] real time known (NTP) -> offline rows time-stamped");
}

// Move real-time RAM rows to the flash ring (oldest first).
static void ologFlushRam(bool force) {
  if (!ologFsOk || ologHasRelative || ologRamCount == 0) return;
  if (!force && ologRamCount < OLOG_FLASH_BATCH) return;
  File f = FFat.open(OLOG_FILE, "r+");
  if (!f) return;
  uint32_t moved = 0;
  while (ologRamCount > 0) {
    const LogRec &r = ologRam[ologRamHead];
    if (ologCount == OLOG_MAX_ROWS) {  // flash full: overwrite the oldest row
      ologHead = (ologHead + 1) % OLOG_MAX_ROWS;
      ologCount--;
    }
    uint32_t pos = (ologHead + ologCount) % OLOG_MAX_ROWS;
    if (!f.seek((size_t)pos * sizeof(LogRec)) || f.write((const uint8_t *)&r, sizeof(LogRec)) != sizeof(LogRec)) break;
    ologCount++;
    ologRamHead = (ologRamHead + 1) % ologRamCap;
    ologRamCount--;
    moved++;
  }
  f.close();
  if (moved) {
    ologSaveMeta();
    ologBacklogPending = true;
    Serial.printf("[LOG] %lu rows written to flash (%lu waiting)\n", (unsigned long)moved, (unsigned long)ologCount);
  }
}

static size_t ologRowJson(const LogRec &r, char *out, size_t cap) {
  JsonDocument d;
  d["ts"] = r.ts;
  JsonObject v = d["values"].to<JsonObject>();
  char b[4][12];
  if (!isnan(r.ph)) { fmt(b[0], 12, r.ph, 2); v["ph"] = serialized((const char *)b[0]); }
  if (!isnan(r.ec)) { fmt(b[1], 12, r.ec, 2); v["ec"] = serialized((const char *)b[1]); }
  if (r.tds != 0xFFFF) v["tds"] = r.tds;
  if (!isnan(r.temp)) { fmt(b[2], 12, r.temp, 1); v["temp"] = serialized((const char *)b[2]); }
  if (r.flags & 0x02) v["tank_main_ok"] = (bool)(r.flags & 0x01);
  char bRun[PUMP_COUNT][14];
  for (int i = 0; i < PUMP_COUNT; i++) {
    v[pumps[i].telemetryKey] = (bool)(r.flags & (1u << (2 + i)));
    snprintf(bRun[i], sizeof(bRun[i]), "%lu.%lu", (unsigned long)(r.runDs[i] / 10), (unsigned long)(r.runDs[i] % 10));
    v[PUMP_RUN_KEYS[i]] = serialized((const char *)bRun[i]);
  }
  v["mode"] = (r.flags & 0x80) ? "AUTO" : "MANUAL";
  v["sensor_ok"] = !isnan(r.ph) && !isnan(r.ec) && !isnan(r.temp);
  v["sim"] = false;
  v["offline_log"] = true;  // rule chain "Farm Alerts" skips these (no late alerts)
  size_t n = serializeJson(d, out, cap);
  return (n > 0 && n < cap) ? n : 0;
}

// Send up to OLOG_SEND_BATCH rows: flash ring first (older), then real-time RAM rows.
static void ologSendBatch() {
  static char payload[3600];
  static char row[340];
  size_t len = 0;
  payload[len++] = '[';
  uint8_t fromFlash = 0, fromRam = 0, skipped = 0;
  File f;
  if (ologFsOk && ologCount > 0) f = FFat.open(OLOG_FILE, "r");
  uint32_t k = 0;
  while ((fromFlash + fromRam + skipped) < OLOG_SEND_BATCH) {
    LogRec r;
    bool flashRow = f && k < ologCount;
    if (flashRow) {
      uint32_t pos = (ologHead + k) % OLOG_MAX_ROWS;
      if (!f.seek((size_t)pos * sizeof(LogRec)) || f.read((uint8_t *)&r, sizeof(LogRec)) != sizeof(LogRec)) break;
      k++;
    } else {
      if (ologHasRelative || fromRam >= ologRamCount) break;
      r = ologRam[(ologRamHead + fromRam) % ologRamCap];
    }
    if (r.crc != ologCrc(r) || r.ts <= 0) {  // damaged row: drop it, never send a guessed value
      if (flashRow) skipped++;
      else fromRam++;
      continue;
    }
    size_t n = ologRowJson(r, row, sizeof(row));
    if (n == 0 || len + n + 2 >= sizeof(payload)) break;
    if (len > 1) payload[len++] = ',';
    memcpy(payload + len, row, n);
    len += n;
    if (flashRow) fromFlash++;
    else fromRam++;
  }
  if (f) f.close();
  uint32_t flashDone = fromFlash + skipped;
  if (len <= 1) {  // nothing sendable (only damaged rows)
    if (flashDone) {
      ologHead = (ologHead + flashDone) % OLOG_MAX_ROWS;
      ologCount -= flashDone;
      ologSaveMeta();
    }
    if (fromRam) {
      ologRamHead = (ologRamHead + fromRam) % ologRamCap;
      ologRamCount -= fromRam;
    }
    return;
  }
  payload[len++] = ']';
  payload[len] = 0;
  bool ok = mqtt.publish("v1/devices/me/telemetry", payload);
  if (ok) {
    mqtt.loop();
    ok = mqtt.connected();
  }
  if (!ok) {
    Serial.println("[LOG] backlog send failed, will retry");
    return;  // rows stay; a resend later is harmless (same ts overwrites on ThingsBoard)
  }
  if (flashDone) {
    ologHead = (ologHead + flashDone) % OLOG_MAX_ROWS;
    ologCount -= flashDone;
    if (++ologUnsavedSends >= 10 || ologCount == 0) ologSaveMeta();
  }
  if (fromRam) {
    ologRamHead = (ologRamHead + fromRam) % ologRamCap;
    ologRamCount -= fromRam;
  }
  Serial.printf("[LOG] backlog sent %u rows (%lu flash + %lu RAM left)\n", (unsigned)(fromFlash + fromRam),
                (unsigned long)ologCount, (unsigned long)ologRamCount);
}

void ologTick(uint32_t now) {
  bool offline = isBound && !mqtt.connected();
  ologConvertRelative();

  if (offline) {
    if (!ologWasOffline) {
      ologWasOffline = true;
      ologNextSampleAt = now + OLOG_INTERVAL_MS;  // short blips (< 1 min) are not logged
    }
    if (timeReached(now, ologNextSampleAt)) {
      ologNextSampleAt = now + OLOG_INTERVAL_MS;
      LogRec r;
      ologMakeRec(now, r);
      ologRamPush(r);
      Serial.printf("[LOG] offline row %s (RAM %lu, flash %lu)\n", r.ts > 0 ? "real time" : "uptime only",
                    (unsigned long)ologRamCount, (unsigned long)ologCount);
    }
    ologFlushRam(false);
    return;
  }
  ologWasOffline = false;
  if (!isBound || !mqtt.connected()) return;
  if ((uint32_t)(now - mqttUpSince) < OLOG_AFTER_CONNECT_MS || !timeReached(now, ologNextSendAt)) return;
  bool hasRam = ologRamCount > 0 && !ologHasRelative;
  if ((ologFsOk && ologCount > 0) || hasRam) {
    ologBacklogPending = true;
    ologNextSendAt = now + OLOG_SEND_GAP_MS;
    ologSendBatch();
  } else if (ologBacklogPending) {
    ologBacklogPending = false;
    telemetryDirty = true;  // backlog done: refresh the latest values with a live row
    Serial.println("[LOG] backlog fully sent");
  }
}

static void ologWipe() {
  ologRamCount = 0;
  ologRamHead = 0;
  ologHasRelative = false;
  if (ologFsOk) FFat.remove(OLOG_FILE);
  ologHead = 0;
  ologCount = 0;
}

// ------------------------------------------------------------------------------
// 18. OLED (pairing info, verify code, live status) - ASCII only
// ------------------------------------------------------------------------------
#if HAS_OLED
// Full-screen pairing QR. The MAC is sent without ':' (the app accepts 12 hex digits),
// which keeps a FARM-xx payload inside QR version 3 (29 modules) -> 2 px per module = 58 px.
static void oledQr() {
#if HAS_QR
  char mac12[13];
  size_t j = 0;
  for (size_t i = 0; btMacStr[i] && j < 12; i++)
    if (btMacStr[i] != ':') mac12[j++] = btMacStr[i];
  mac12[j] = 0;
  char payload[96];
  snprintf(payload, sizeof(payload), "{\"d\":\"%s\",\"c\":\"%s\",\"m\":\"%s\"}", deviceId, claimSecret, mac12);
  QRCode qr;
  uint8_t buf[qrcode_getBufferSize(4)];
  int scale = 2;
  if (qrcode_initText(&qr, buf, 3, ECC_LOW, payload) != 0) {
    scale = 1;  // longer device name: version 4 (33 modules) only fits at 1 px/module
    if (qrcode_initText(&qr, buf, 4, ECC_LOW, payload) != 0) return;
  }
  const int px = qr.size * scale;
  const int side = 64;                 // white square = quiet zone around the code
  const int bx = (128 - side) / 2;
  const int x0 = bx + (side - px) / 2;
  const int y0 = (side - px) / 2;
  oled.fillRect(bx, 0, side, side, OLED_WHITE);
  for (uint8_t y = 0; y < qr.size; y++)
    for (uint8_t x = 0; x < qr.size; x++)
      if (qrcode_getModule(&qr, x, y)) oled.fillRect(x0 + x * scale, y0 + y * scale, scale, scale, OLED_BLACK);
#endif
}

static void drawOled(uint32_t now) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(OLED_WHITE);
  oled.setTextSize(1);

  uint32_t held = btnPressStart ? now - btnPressStart : 0;
  if (held >= 1000) {
    oled.setCursor(0, 0);
    oled.printf("BOOT held %lus", (unsigned long)(held / 1000));
    oled.setCursor(0, 16);
    if (held < BOOT_PAIR_HOLD_MS) oled.print("5s: reset WiFi+pair");
    else if (held < BOOT_FACTORY_HOLD_MS) oled.print("RELEASE now:\nreset WiFi + pairing\n\nkeep holding to 10s:\nFACTORY RESET");
    else oled.print("FACTORY RESET...");
    oled.display();
    return;
  }

  bool verifyScreen = bleConnected && !bleAuthenticated && isPairingWindowOpen && !authLockActive(now);
  if (verifyScreen) {
    oled.setCursor(0, 0);
    oled.print("BLE VERIFY CODE");
    oled.setTextSize(3);
    oled.setCursor(10, 20);  // 6 digits x 18px = 108px
    oled.printf("%06d", lockedCode);
    oled.setTextSize(1);
    oled.setCursor(0, 52);
    oled.print("Type it on the phone");
    oled.display();
    return;
  }

  if (isPairingWindowOpen) {
#if HAS_QR
    oledQr();  // QR only, no text
#else
    oled.setCursor(0, 0);
    oled.print("PAIRING MODE");
    oled.setCursor(0, 16);
    oled.print(deviceId);
    oled.setCursor(0, 32);
    oled.print(claimSecret);
#endif
    oled.display();
    return;
  }

  // running screen
  char l[24];
  oled.setCursor(0, 0);
  oled.print(deviceId);
  oled.setCursor(0, 9);
  oled.printf("WiFi:%s Cloud:%s", WiFi.status() == WL_CONNECTED ? "OK" : "--", mqtt.connected() ? "OK" : "--");
  oled.setCursor(0, 18);
  if (isBound) {
    snprintf(l, sizeof(l), "Owner:%.15s", ownerName[0] ? ownerName : "?");
    oled.print(l);
  } else {
    oled.print("NOT BOUND (BOOT 5s)");
  }
  oled.setCursor(0, 27);
  if (phOk(now)) oled.printf("pH %.2f  ", (double)S.ph);
  else oled.print("pH --    ");
  if (ecOk(now)) oled.printf("EC %.2f", (double)S.ec);
  else oled.print("EC --");
  oled.setCursor(0, 36);
  if (tempOk(now)) oled.printf("T %.1fC  ", (double)S.temp);
  else oled.print("T --    ");
  oled.print(S.tankOk ? "Tank OK" : "Tank LOW");
  oled.setCursor(0, 45);
  oled.printf("%s %c%c%c%c%c", autoMode ? "AUTO  " : "MANUAL", pumps[P_MAIN].active ? 'M' : '.',
              pumps[P_A].active ? 'A' : '.', pumps[P_B].active ? 'B' : '.', pumps[P_PHUP].active ? '+' : '.',
              pumps[P_PHDOWN].active ? '-' : '.');
  oled.setCursor(0, 55);
  if (!tokenConfigured) oled.print("NO TB TOKEN!");
  else if (!S.adsOk) oled.print("ADS1115 NOT FOUND");
  else if (!wifiSsid[0]) oled.print("NO WIFI (BOOT 5s)");
  else if (!sensorOk(now)) oled.print("SENSOR CHECK");
  oled.display();
}
#endif

void oledTick(uint32_t now) {
#if HAS_OLED
  if (!oledOk) return;
  if ((now - lastOledAt) >= OLED_REFRESH_MS || (oledDirty && (now - lastOledAt) >= 250)) {
    lastOledAt = now;
    oledDirty = false;
    drawOled(now);
  }
#endif
}

// ------------------------------------------------------------------------------
// 19. Status LED + BOOT button + deferred actions
// ------------------------------------------------------------------------------
void ledTick(uint32_t now) {
  bool blink = ((now / 500) % 2) == 0;
  if (btnPressStart && (now - btnPressStart) >= 1000) ledSet(blink, false, blink);  // magenta blink
  else if (isPairingWindowOpen) ledSet(false, false, blink);                         // blue blink
  else if (WiFi.status() != WL_CONNECTED) ledSet(true, false, false);                // red
  else if (!mqtt.connected()) ledSet(true, true, false);                              // yellow
  else if (!sensorOk(now)) ledSet(blink, true, false);                                // green + red blink
  else ledSet(false, true, false);                                                    // green
}

void buttonTick(uint32_t now) {
  if (digitalRead(PIN_BTN_BOOT) == LOW) {
    if (btnPressStart == 0) {
      btnPressStart = now ? now : 1;
      btnPairArmed = false;
      btnFactoryDone = false;
    }
    uint32_t held = now - btnPressStart;
    if (held >= BOOT_PAIR_HOLD_MS && !btnPairArmed) {
      btnPairArmed = true;
      oledDirty = true;
    }
    if (held >= BOOT_FACTORY_HOLD_MS && !btnFactoryDone) {
      btnFactoryDone = true;
      if (mqtt.connected()) {
        mqtt.publish("v1/devices/me/attributes", "{\"bound\":false,\"pairing\":false,\"owner\":\"\"}");
        mqtt.loop();
      }
      oledDirty = true;
      schedule(PA_FACTORY_RESET, 300);
    }
  } else if (btnPressStart) {
    // 5-10 s hold acts on release; 10 s already triggered the factory reset
    if (btnPairArmed && !btnFactoryDone) bootPairingReset();
    btnPressStart = 0;
    btnPairArmed = false;
    btnFactoryDone = false;
    oledDirty = true;
  }
}

void pendingActionTick(uint32_t now) {
  if (pendingAction == PA_NONE || !timeReached(now, pendingActionAt)) return;
  PendingAction a = pendingAction;
  pendingAction = PA_NONE;
  stopAllPumps();
  if (mqtt.connected()) {
    mqtt.loop();
    mqtt.disconnect();
  }
  switch (a) {
    case PA_RESET_WIFI:
      Serial.println("[RPC] resetWifi: WiFi erased, pairing window opens after restart");
      prefs.remove("wifi_ssid");
      prefs.remove("wifi_pass");
      prefs.putBool("pair_boot", true);  // open pairing after boot even if bound
      WiFi.disconnect(true, true);
      ESP.restart();
      break;
    case PA_FACTORY_RESET:
      doFactoryResetNow();
      break;
    case PA_REBOOT:
      Serial.println("[RPC] reboot");
      ESP.restart();
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------------------
// 20. setup / loop
// ------------------------------------------------------------------------------
static void setupIdentity() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(deviceId, sizeof(deviceId), "FARM-%02X%02X%02X", mac[3], mac[4], mac[5]);
#ifdef DEFAULT_DEVICE_ID
  if (!isPlaceholder(DEFAULT_DEVICE_ID) && strlen(DEFAULT_DEVICE_ID) < sizeof(deviceId))
    copyStr(deviceId, sizeof(deviceId), DEFAULT_DEVICE_ID);
#endif
  uint8_t bt[6] = {0};
  if (esp_read_mac(bt, ESP_MAC_BT) != ESP_OK) esp_read_mac(bt, ESP_MAC_WIFI_STA);
  snprintf(btMacStr, sizeof(btMacStr), "%02X:%02X:%02X:%02X:%02X:%02X", bt[0], bt[1], bt[2], bt[3], bt[4], bt[5]);
}

static void setupNvs() {
  prefs.begin("smartfarm", false);
  // legacy keys from fw 2.x stored the compile-time token/server in NVS, which would
  // silently keep an OLD (leaked) token after re-flashing a new secrets.h -> remove.
  prefs.remove("tb_token");
  prefs.remove("tb_server");
  prefs.remove("device_id");

  isBound = prefs.getBool("is_bound", false);
  prefs.getString("owner", ownerName, sizeof(ownerName));
  prefs.getString("owner_src", ownerSource, sizeof(ownerSource));
  lastSeenBindTs = prefs.getDouble("bind_ts_seen", 0);
  consumedBindTs = prefs.getDouble("bind_ts_used", 0);
  if (prefs.getString("claim_secret", claimSecret, sizeof(claimSecret)) != 10) rotateClaimSecret();
  targetPhMin = prefs.getFloat("ph_min", 5.8f);
  targetPhMax = prefs.getFloat("ph_max", 6.5f);
  targetEcMin = prefs.getFloat("ec_min", 1.4f);
  targetEcMax = prefs.getFloat("ec_max", 1.8f);
  targetTempMin = prefs.getFloat("temp_min", 22.0f);
  targetTempMax = prefs.getFloat("temp_max", 28.0f);
  for (int i = 0; i < PUMP_COUNT; i++) pumps[i].runMs = prefs.getULong64(PUMP_RT_NVS[i], 0);
  char modeBuf[8] = "";
  prefs.getString("mode", modeBuf, sizeof(modeBuf));
  autoMode = strcmp(modeBuf, "AUTO") == 0;  // default MANUAL (safe until the probe is calibrated)
  prefs.getString("wifi_ssid", wifiSsid, sizeof(wifiSsid));
  prefs.getString("wifi_pass", wifiPass, sizeof(wifiPass));

  // token: BLE-provisioned value wins, otherwise the compile-time secrets.h value
  if (prefs.getString("tb_tok_ble", tbToken, sizeof(tbToken)) == 0 || isPlaceholder(tbToken))
    copyStr(tbToken, sizeof(tbToken), DEFAULT_TB_TOKEN);
  tokenConfigured = !isPlaceholder(tbToken);
  loadCalibration();
}

static void setupBle() {
  bleQueue = xQueueCreate(4, sizeof(BleMsg));
  BLEDevice::init(deviceId);
  BLEDevice::setMTU(517);
  pBleServer = BLEDevice::createServer();
  pBleServer->setCallbacks(new ServerCallbacks());
  BLEService *svc = pBleServer->createService(BLE_SERVICE_UUID);
  pBleChar = svc->createCharacteristic(BLE_CHAR_UUID, BLECharacteristic::PROPERTY_READ |
                                                          BLECharacteristic::PROPERTY_WRITE |
                                                          BLECharacteristic::PROPERTY_NOTIFY);
  pBleChar->addDescriptor(new BLE2902());
  pBleChar->setCallbacks(new CharCallbacks());
  svc->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  BLEAdvertisementData advData;  // 31-byte budget: flags 3 + uuid16 4 + name <= 22
  advData.setFlags(0x06);
  advData.setCompleteServices(BLEUUID((uint16_t)BLE_SERVICE_UUID16));
  advData.setName(deviceId);
  adv->setAdvertisementData(advData);
  BLEAdvertisementData scanData;
  scanData.setName(deviceId);
  adv->setScanResponseData(scanData);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06);
  adv->setMaxPreferred(0x12);
  publishBleStatus();
}

void setup() {
  // Relays OFF before the pins become outputs (no glitch at boot)
  for (int i = 0; i < PUMP_COUNT; i++) {
    digitalWrite(pumps[i].pin, LOW);
    pinMode(pumps[i].pin, OUTPUT);
    digitalWrite(pumps[i].pin, LOW);
  }
  ledSet(false, false, false);
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  ledSet(false, false, false);

  Serial.begin(115200);  // native USB CDC (Tools > USB CDC On Boot: Enabled)

  for (int i = 0; i < PUMP_COUNT; i++) {
    esp_timer_create_args_t a = {};
    a.callback = &pumpTimerCb;
    a.arg = &pumps[i];
    a.dispatch_method = ESP_TIMER_TASK;
    a.name = pumps[i].rpcName;
    if (esp_timer_create(&a, &pumps[i].timer) != ESP_OK) pumps[i].timer = nullptr;  // startPump refuses
  }

  pinMode(PIN_BTN_BOOT, INPUT_PULLUP);
#if HAS_FLOAT_SWITCH
  pinMode(PIN_FLOAT_MAIN, INPUT_PULLUP);  // external pull-up present; internal one is harmless backup
  floatRawLast = digitalRead(PIN_FLOAT_MAIN);
  floatRawChangedAt = millis();
  S.tankOk = (floatRawLast == FLOAT_WATER_PRESENT_LEVEL);
#endif

  setupIdentity();
  setupNvs();
  ologBegin();  // FFat mount (first boot formats the partition, before the WDT is armed)
  Serial.printf("\n[BOOT] Smart Water Farm %s board=%s id=%s bound=%d mode=%s\n", FW_VERSION, BOARD_KIND,
                deviceId, isBound, autoMode ? "AUTO" : "MANUAL");
  Serial.printf("[BOOT] PSRAM %u bytes, token %s\n", (unsigned)ESP.getPsramSize(),
                tokenConfigured ? "configured" : "MISSING");

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_FREQ_HZ);
  Wire.setTimeOut(50);
  S.adsOk = adsProbe();
  Serial.printf("[I2C] ADS1115 0x48 %s\n", S.adsOk ? "found" : "NOT FOUND");
#if HAS_OLED
  Wire.beginTransmission(OLED_ADDR);
  bool oledAck = Wire.endTransmission() == 0;
#if OLED_IS_SSD1306
  oledOk = oledAck && oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR, true, false);  // Wire already started
#else
  oledOk = oledAck && oled.begin(OLED_ADDR, true);
#endif
  Serial.printf("[I2C] OLED 0x3C %s\n", oledOk ? "found" : "NOT FOUND (running without display)");
  if (oledOk) {
    oled.clearDisplay();
    oled.setTextColor(OLED_WHITE);
    oled.setTextSize(1);
    oled.setCursor(0, 0);
    oled.println("Smart Water Farm");
    oled.println(FW_VERSION);
    oled.println(deviceId);
    oled.display();
  }
#endif

#if HAS_DS18B20
  owInit();
  Serial.printf("[DS18B20] IO39 presence at boot = %u\n", (unsigned)owReset());
#endif

  setupBle();

  WiFi.persistent(false);       // credentials live in our own NVS namespace
  WiFi.setAutoReconnect(false); // reconnect is paced by wifiTick() back-off
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) { lastDiscReason = info.wifi_sta_disconnected.reason; },
               ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.mode(WIFI_STA);
  if (wifiSsid[0]) {
    WiFi.begin(wifiSsid, wifiPass);
    wifiNextAttemptAt = millis() + WIFI_BACKOFF_MIN_MS * 3;
  }

  netClient.setTimeout(3000);  // TCP connect / IO timeout (ms)
  mqtt.setBufferSize(4096);  // offline backlog: up to 10 time-stamped rows per message
  mqtt.setSocketTimeout(3);
  mqtt.setKeepAlive(30);
  mqtt.setCallback(mqttCallback);

  // Unbound, or bound but without WiFi (e.g. after resetWifi) -> open pairing window
  bool pairOnBoot = prefs.getBool("pair_boot", false);
  if (pairOnBoot) prefs.remove("pair_boot");
  if (!isBound || !wifiSsid[0] || pairOnBoot) openPairingWindow();
  autoReset(AUTO_EVAL_INTERVAL_MS);  // first AUTO evaluation 5 min after boot (sensor warm-up)
  nextSensorCycleAt = millis();

  // Task watchdog 20 s on the loop task
  esp_task_wdt_config_t wdt = {};
  wdt.timeout_ms = WDT_TIMEOUT_MS;
  wdt.idle_core_mask = 0;
  wdt.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&wdt) != ESP_OK) esp_task_wdt_init(&wdt);
  esp_task_wdt_add(NULL);
}

void loop() {
  esp_task_wdt_reset();
  uint32_t now = millis();

  pumpSafetyTick(now);
  buttonTick(now);
  pendingActionTick(now);

  // signed check: BOOT-hold (buttonTick) may open the window with millis() newer than `now`
  if (isPairingWindowOpen && timeReached(now, pairingWindowStart + PAIRING_WINDOW_MS)) {
    if (!isBound) refreshPairingForClaim("auto-renew: unbound stays pairable");
    else if (offlinePairing) pairingWindowStart = now;  // stays open while Wi-Fi is down
    else closePairingWindow();
  }
  if (!isBound && !isPairingWindowOpen) refreshPairingForClaim("unbound: always pairable");

  sensorTick(now);
  bleTick(now);
  wifiTick(now);
  mqttTick(now);
  offlinePairingTick(millis());
  ologTick(millis());
  now = millis();  // network calls may have taken time

  autoTick(now);
  pumpSafetyTick(now);

  if (mqtt.connected()) {
    if (attrsDirty) publishClientAttrs(true);  // bound/pairing/owner/targets changed
    if (isBound && (telemetryDirty || (now - lastTelemetryAt) >= TELEMETRY_INTERVAL_MS)) sendTelemetry();
  }

  oledTick(now);
  ledTick(now);

  static uint32_t lastHeapLog = 0;
  if ((now - lastHeapLog) >= 60000) {
    lastHeapLog = now;
    Serial.printf("[HEAP] free=%u min=%u\n", (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap());
  }
  delay(2);  // yield; keeps loop responsive (BLE/MQTT run in their own tasks)
}
