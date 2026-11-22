constexpr uint8_t sensorPin = A4;
constexpr unsigned long sampleIntervalMs = 10;
unsigned long lastSampleMs = 0;

void setup() {
  Serial.begin(115200);
}

void loop() {
  const unsigned long now = millis();
  if (now - lastSampleMs < sampleIntervalMs) {
    return;
  }
  lastSampleMs = now;

  Serial.print(F("Envelope:"));
  Serial.println(analogRead(sensorPin));
}
