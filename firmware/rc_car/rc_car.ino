// Head Racer — ESP32 firmware
//
// The game server sends "d <steer> <throttle>" about 20 times a second
// (each -1000..1000). This sketch turns that into button presses on the
// original RC controller:
//   - Throttle: the FORWARD button is pulsed quickly. 40% throttle = pressed 40% of the time,
//     so the real car speeds up and slows down with the car on screen.
//   - Steering: LEFT / RIGHT pressed when the steer is past a threshold (or pulsed, see STEER_PULSE).
//   - Failsafe: if no command arrives for 300 ms, every button is released.
//
// Library needed (Arduino Library Manager): "WebSockets" by Markus Sattler (links2004).
// Board: any ESP32. In Tools > Board pick your exact ESP32 model.

#include <WiFi.h>
#include <WebSocketsClient.h>

// ================= 1. NETWORK — change these =================
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// Where the game runs. Pick ONE of the two blocks.
// A) Cloud (the web app on Vercel): any WiFi with internet works.
const bool USE_TLS = true;
const char* SERVER_HOST = "YOUR-APP.vercel.app";  // the app's address, no https://
const uint16_t SERVER_PORT = 443;
const char* CAR_PATH = "/api/car?token=YOUR_CAR_TOKEN";  // must match CAR_TOKEN in Vercel
// B) Laptop (`npm start`): ESP32 and laptop on the same WiFi.
// const bool USE_TLS = false;
// const char* SERVER_HOST = "192.168.1.50";  // laptop IP: `npm start` prints it
// const uint16_t SERVER_PORT = 3000;
// const char* CAR_PATH = "/car?token=letsgo";  // must match CAR_TOKEN on the laptop

// ================= 2. PINS — the GPIOs wired to each button =================
// Avoid GPIO 0, 2, 5, 12, 15 (boot pins) and 6–11 (flash) on a classic ESP32.
const int PIN_FWD = 16;
const int PIN_BACK = 17;
const int PIN_LEFT = 18;
const int PIN_RIGHT = 19;

// How the GPIO is wired to the button:
//   true  = GPIO connected straight to the button signal (active-low, ~3.2 V released).
//           Pressed = GPIO pulls LOW. Released = GPIO goes high-impedance so the controller's
//           own pull-up brings it back to 3.2 V. The ESP32 never pushes 3.3 V into the controller.
//   false = GPIO drives a transistor/optocoupler that shorts the button. Pressed = GPIO HIGH.
const bool DIRECT_WIRING = true;

// ================= 3. FEEL — tune on the day =================
const float SPEED_SCALE = 0.7;      // < 1 makes the real car slower than the screen. Start low!
const uint32_t PULSE_PERIOD_MS = 120; // one on/off cycle for throttle pulsing
const float MIN_DUTY = 0.12;        // below this the button stays released (car can't move that slowly)
const float STEER_THRESHOLD = 0.35; // on/off steering: press when |steer| is above this
const bool STEER_PULSE = false;     // true = pulse the steering button for partial turns instead
const uint32_t FAILSAFE_MS = 300;

// =============================================================

WebSocketsClient ws;
float cmdSteer = 0, cmdThr = 0;  // -1..1
uint32_t lastCmdMs = 0;
bool reconnectNow = false;  // server asked for a fresh connection (the cloud closes old ones)
uint32_t holdUntilMs = 0;  // serial test commands hold this long
int forcedPin = -1;        // serial single-button test

int8_t pinState[64];  // last state written per GPIO, so we only touch pins that change

void setButton(int pin, bool pressed) {
  if (pin < 0 || pin >= 64 || pinState[pin] == (int8_t)pressed) return;
  pinState[pin] = pressed;
  if (DIRECT_WIRING) {
    if (pressed) {
      digitalWrite(pin, LOW);
      pinMode(pin, OUTPUT);
    } else {
      pinMode(pin, INPUT);  // high-impedance = released
    }
  } else {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, pressed ? HIGH : LOW);
  }
}

void releaseAll() {
  setButton(PIN_FWD, false);
  setButton(PIN_BACK, false);
  setButton(PIN_LEFT, false);
  setButton(PIN_RIGHT, false);
}

// Is a pulsed button "on" at this moment for the given duty (0..1)?
bool pulseOn(float duty, uint32_t now, uint32_t phaseOffset) {
  if (duty < MIN_DUTY) return false;
  if (duty > 0.92) return true;
  return ((now + phaseOffset) % PULSE_PERIOD_MS) < (uint32_t)(duty * PULSE_PERIOD_MS);
}

void applyOutputs(uint32_t now) {
  if (forcedPin >= 0) {  // serial wiring test
    setButton(PIN_FWD, forcedPin == PIN_FWD);
    setButton(PIN_BACK, forcedPin == PIN_BACK);
    setButton(PIN_LEFT, forcedPin == PIN_LEFT);
    setButton(PIN_RIGHT, forcedPin == PIN_RIGHT);
    return;
  }
  float thr = constrain(cmdThr, -1.0f, 1.0f) * SPEED_SCALE;
  float st = constrain(cmdSteer, -1.0f, 1.0f);

  bool fwd = thr > 0 && pulseOn(thr, now, 0);
  bool back = thr < 0 && pulseOn(-thr, now, 0);

  bool left, right;
  if (STEER_PULSE) {
    left = st < 0 && pulseOn(-st, now, PULSE_PERIOD_MS / 2);
    right = st > 0 && pulseOn(st, now, PULSE_PERIOD_MS / 2);
  } else {
    left = st < -STEER_THRESHOLD;
    right = st > STEER_THRESHOLD;
  }

  // Never press opposite buttons together.
  setButton(PIN_BACK, back && !fwd);
  setButton(PIN_FWD, fwd);
  setButton(PIN_RIGHT, right && !left);
  setButton(PIN_LEFT, left);
}

void onWs(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[ws] connected to server");
      ws.sendTXT("car online");
      break;
    case WStype_DISCONNECTED:
      Serial.println("[ws] disconnected — buttons released");
      cmdSteer = cmdThr = 0;
      releaseAll();
      break;
    case WStype_TEXT: {
      char buf[48];
      size_t n = min(length, sizeof(buf) - 1);
      memcpy(buf, payload, n);
      buf[n] = 0;
      int s, t;
      if (n == 1 && buf[0] == 'r') {
        reconnectNow = true;  // a race is about to start: reconnect now so the link lasts the race
      } else if (sscanf(buf, "d %d %d", &s, &t) == 2) {
        cmdSteer = s / 1000.0f;
        cmdThr = t / 1000.0f;
        lastCmdMs = millis();
      }
      break;
    }
    default:
      break;
  }
}

// Serial monitor (115200) bench tests:
//   f / b / l / r   press that one button for 1 second (check your wiring)
//   d 0 500         steer 0, throttle 50% for 3 seconds
//   x               release everything
void handleSerial() {
  static char line[32];
  static uint8_t len = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      line[len] = 0;
      len = 0;
      int s, t;
      if (line[0] == 'x') {
        forcedPin = -1;
        cmdSteer = cmdThr = 0;
        holdUntilMs = 0;
        Serial.println("released");
      } else if (sscanf(line, "d %d %d", &s, &t) == 2) {
        forcedPin = -1;
        cmdSteer = s / 1000.0f;
        cmdThr = t / 1000.0f;
        holdUntilMs = millis() + 3000;
        Serial.printf("drive steer=%d throttle=%d for 3 s\n", s, t);
      } else if (strchr("fblr", line[0]) && line[0]) {
        forcedPin = line[0] == 'f' ? PIN_FWD : line[0] == 'b' ? PIN_BACK : line[0] == 'l' ? PIN_LEFT : PIN_RIGHT;
        holdUntilMs = millis() + 1000;
        Serial.printf("pressing GPIO %d for 1 s\n", forcedPin);
      }
    } else if (len < sizeof(line) - 1) {
      line[len++] = c;
    }
  }
}

void setup() {
  memset(pinState, -1, sizeof(pinState));
  releaseAll();  // first thing: nothing pressed
  Serial.begin(115200);
  delay(200);
  Serial.println("\nHead Racer car starting");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // lower latency
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print('.');
    handleSerial();
  }
  Serial.printf("\nWiFi OK, ESP32 IP %s\n", WiFi.localIP().toString().c_str());

  // TLS here encrypts the link but does not pin the server certificate.
  if (USE_TLS) ws.beginSSL(SERVER_HOST, SERVER_PORT, CAR_PATH);
  else ws.begin(SERVER_HOST, SERVER_PORT, CAR_PATH);
  Serial.printf("Connecting to %s%s:%u\n", USE_TLS ? "wss://" : "ws://", SERVER_HOST, SERVER_PORT);
  ws.onEvent(onWs);
  ws.setReconnectInterval(1000);
  ws.enableHeartbeat(5000, 2000, 2);
}

void loop() {
  ws.loop();
  if (reconnectNow) {
    reconnectNow = false;
    Serial.println("[ws] refreshing the connection before the race");
    ws.disconnect();  // releases the buttons; the library reconnects within a second
  }
  handleSerial();
  uint32_t now = millis();
  bool serialHold = now < holdUntilMs;
  if (!serialHold) forcedPin = -1;
  if (!serialHold && now - lastCmdMs > FAILSAFE_MS) {
    cmdSteer = 0;
    cmdThr = 0;
  }
  applyOutputs(now);
}
