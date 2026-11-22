// Active-low remote button inputs. Released pins never source voltage.
constexpr uint8_t buttons[] = {4, 5, 6, 7};
constexpr unsigned long pulseMs = 250;
unsigned long pressedAt;
bool pressing = false;
void releaseAll() {
  for (auto pin : buttons) pinMode(pin, INPUT);
  pressing = false;
}
void setup() {
  releaseAll();
  Serial.begin(115200);
}
void loop() {
  if (pressing && millis() - pressedAt >= pulseMs) releaseAll();
  if (!Serial.available()) return;
  char command = Serial.read();
  if (command == '0') releaseAll();
  if (command == '?') Serial.println(pressing ? "CARBENCH ACTIVE" : "CARBENCH STOPPED");
  if (command >= '4' && command <= '7' && !pressing) {
    uint8_t pin = command - '0';
    digitalWrite(pin, HIGH);
    pinMode(pin, OUTPUT_OPEN_DRAIN);
    digitalWrite(pin, LOW);
    pressing = true;
    pressedAt = millis();
  }
}
