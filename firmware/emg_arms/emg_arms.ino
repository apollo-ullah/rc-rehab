// RC-Rehab — arm sensors (EMG) ESP32 for the Arm path
//
// Two biceps EMG sensors, one per arm. This sketch decides "flexing or not" for each arm and
// sends one line to the game:
//   f <left> <right>      each 0 or 1, e.g. "f 1 0" = left biceps flexing, right relaxed
// when either arm changes, and every 0.5 s as a heartbeat. No line for 2 s = sensor offline
// (lessons pause and the car waits).
//
// Sensors: anything whose output rises when the muscle works, e.g. a MyoWare 2.0 using its
// ENV (envelope) output. Electrodes along the middle of each biceps, the reference on the bony
// part of the elbow. Power the sensors from 3.3 V so their output stays in the ESP32's range.
// If your sensor boards already decide flexing themselves (a digital HIGH while flexing),
// set DIGITAL_INPUTS = true below.
//
// Calibration: at power-up keep both arms relaxed for 3 seconds. The sketch measures the
// relaxed level and noise of each arm and sets the thresholds from that. For weak muscles,
// also type "l" (or "r") in the Serial Monitor (115200 baud) and squeeze that arm gently for
// 3 seconds: the "flexing" threshold then sits at 30% of that comfortable squeeze.
// Serial commands: c = redo the relaxed calibration, l / r = measure a squeeze, s = print levels.
//
// Library needed (Arduino Library Manager): "WebSockets" by Markus Sattler (links2004).
// The car's own ESP32 can do this job too: send the same "f L R" lines on its car connection.

#include <WiFi.h>
#include <WebSocketsClient.h>

// ================= 1. NETWORK — change these =================
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// A) Cloud (the web app on Vercel)
const bool USE_TLS = true;
const char* SERVER_HOST = "YOUR-APP.vercel.app";  // the app's address, no https://
const uint16_t SERVER_PORT = 443;
const char* EMG_PATH = "/api/emg?token=YOUR_CAR_TOKEN";  // the same token as the car
// B) Laptop (`npm start`): ESP32 and laptop on the same WiFi.
// const bool USE_TLS = false;
// const char* SERVER_HOST = "192.168.1.50";
// const uint16_t SERVER_PORT = 3000;
// const char* EMG_PATH = "/emg?token=letsgo";

// ================= 2. PINS =================
// ADC1 pins (32–39) keep working while WiFi is on; ADC2 pins don't.
const int PIN_LEFT = 34;
const int PIN_RIGHT = 35;
const bool DIGITAL_INPUTS = false;  // true: the sensor boards output HIGH while flexing

// ================= 3. TUNING =================
const float SMOOTH = 0.15f;      // smoothing of the envelope per 2 ms sample (smaller = smoother)
const float NOISE_K = 6.0f;      // "flexing" = relaxed level + 6 × noise …
const int MIN_DELTA = 60;        // … and at least this many ADC steps above relaxed (of 4095)
const float SQUEEZE_ON = 0.30f;  // after an "l"/"r" squeeze measurement: on at 30% of it
const float OFF_RATIO = 0.5f;    // hysteresis: off again below half of the "on" step
const uint32_t ON_MS = 30;       // must stay above "on" this long to count as flexing
const uint32_t OFF_MS = 80;      // must stay below "off" this long to count as relaxed
const uint32_t HEARTBEAT_MS = 500;
const uint32_t REFRESH_MS = 240000;  // Vercel ends connections after 5 minutes: renew while relaxed

struct Arm {
  int pin;
  const char* name;
  float level = 0, rest = 0, noise = 0, onAt = 4096, offAt = 4096;
  bool on = false;
  uint32_t since = 0;  // when the level crossed the threshold in the other direction
};
Arm arms[2] = {{PIN_LEFT, "left"}, {PIN_RIGHT, "right"}};

WebSocketsClient ws;
bool connected = false;
uint32_t connectedAt = 0, lastSent = 0, lastRelaxedChange = 0;

void setThresholds(Arm& a, float onStep) {
  a.onAt = a.rest + onStep;
  a.offAt = a.rest + onStep * OFF_RATIO;
  Serial.printf("%s: relaxed %.0f, noise %.1f -> flexing above %.0f, relaxed below %.0f\n", a.name, a.rest, a.noise, a.onAt, a.offAt);
}

float readRaw(const Arm& a) { return analogRead(a.pin); }

// Arms relaxed: measure the relaxed level and the noise for 3 s.
void calibrateRelaxed() {
  Serial.println("Calibrating: keep both arms relaxed for 3 seconds…");
  double sum[2] = {0, 0}, sq[2] = {0, 0};
  int n = 0;
  for (uint32_t t0 = millis(); millis() - t0 < 3000; n++) {
    for (int i = 0; i < 2; i++) {
      float v = readRaw(arms[i]);
      sum[i] += v;
      sq[i] += v * v;
    }
    delay(2);
  }
  for (int i = 0; i < 2; i++) {
    Arm& a = arms[i];
    a.rest = sum[i] / n;
    a.noise = sqrt(max(0.0, sq[i] / n - a.rest * a.rest));
    a.level = a.rest;
    a.on = false;
    setThresholds(a, max((float)MIN_DELTA, NOISE_K * a.noise));
  }
}

// One arm squeezes gently for 3 s: "flexing" starts at 30% of that squeeze.
void calibrateSqueeze(Arm& a) {
  Serial.printf("Squeeze your %s arm gently and keep it on for 3 seconds…\n", a.name);
  delay(500);
  float level = a.rest, peak = a.rest;
  for (uint32_t t0 = millis(); millis() - t0 < 3000;) {
    level += (readRaw(a) - level) * SMOOTH;
    peak = max(peak, level);
    delay(2);
  }
  float step = (peak - a.rest) * SQUEEZE_ON;
  if (step < NOISE_K * a.noise * 0.5f) {
    Serial.println("That squeeze was too close to the relaxed level. Check the electrodes and try again.");
    return;
  }
  setThresholds(a, step);
}

void sendState(uint32_t now) {
  if (!connected) return;
  char line[12];
  snprintf(line, sizeof(line), "f %d %d", arms[0].on ? 1 : 0, arms[1].on ? 1 : 0);
  ws.sendTXT(line);
  lastSent = now;
}

void onWs(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) {
    connected = true;
    connectedAt = millis();
    Serial.println("[ws] connected");
    sendState(millis());
  } else if (type == WStype_DISCONNECTED) {
    if (connected) Serial.println("[ws] disconnected, retrying");
    connected = false;
  }
}

void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'c') calibrateRelaxed();
    if (c == 'l') calibrateSqueeze(arms[0]);
    if (c == 'r') calibrateSqueeze(arms[1]);
    if (c == 's') {
      for (auto& a : arms) Serial.printf("%s: level %.0f (on above %.0f) %s   ", a.name, a.level, a.onAt, a.on ? "FLEXING" : "relaxed");
      Serial.println();
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nRC-Rehab arm sensors starting");
  analogReadResolution(12);
  for (auto& a : arms) pinMode(a.pin, INPUT);
  if (!DIGITAL_INPUTS) calibrateRelaxed();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print('.');
  }
  Serial.printf("\nWiFi OK, ESP32 IP %s\n", WiFi.localIP().toString().c_str());
  if (USE_TLS) ws.beginSSL(SERVER_HOST, SERVER_PORT, EMG_PATH);
  else ws.begin(SERVER_HOST, SERVER_PORT, EMG_PATH);
  ws.onEvent(onWs);
  ws.setReconnectInterval(1000);
  ws.enableHeartbeat(5000, 2000, 2);
}

void loop() {
  ws.loop();
  handleSerial();
  uint32_t now = millis();
  bool changed = false;
  for (auto& a : arms) {
    bool want;
    if (DIGITAL_INPUTS) {
      want = digitalRead(a.pin) == HIGH;
      a.since = want == a.on ? now : a.since;
    } else {
      a.level += (readRaw(a) - a.level) * SMOOTH;
      want = a.on ? a.level > a.offAt : a.level > a.onAt;
      if (want == a.on) a.since = now;
    }
    // Only switch once the new state has lasted a moment, so a twitch doesn't flicker.
    if (want != a.on && now - a.since >= (want ? ON_MS : OFF_MS)) {
      a.on = want;
      a.since = now;
      changed = true;
      lastRelaxedChange = now;
    }
  }
  if (changed || now - lastSent >= HEARTBEAT_MS) sendState(now);
  // Renew the connection before the host ends it, at a calm moment (both arms relaxed for 2 s).
  if (connected && now - connectedAt > REFRESH_MS && !arms[0].on && !arms[1].on && now - lastRelaxedChange > 2000) {
    Serial.println("[ws] renewing the connection");
    ws.disconnect();
  }
  delay(2);
}
