#include <BLEDevice.h>
#include <BLE2902.h>
#include <atomic>

constexpr int sensorPin = 2;
constexpr int rightSensorPin = 8;
BLECharacteristic *dualSamples;
constexpr unsigned long sampleIntervalMs = 20;
unsigned long lastSample = 0;
int envelope = 0;

constexpr char serviceId[] = "e0730c50-b64d-48f3-a0ac-3d0657c85430";
constexpr char sampleId[] = "e0730c51-b64d-48f3-a0ac-3d0657c85430";
BLECharacteristic *sampleCharacteristic;
std::atomic<bool> restartAdvertising(false);
uint32_t sequence = 0;

// Bits 0 and 1 request left and right forward. Both expire on heartbeat loss.
std::atomic<uint8_t> wheelMask(0);
std::atomic<uint32_t> lastFlex(0);
class DriveEvents : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) override {
    auto value = ch->getValue();
    uint8_t mask = value.length() == 1 ? uint8_t(value[0]) : 0;
    wheelMask.store(mask <= 3 ? mask : 0);
    lastFlex.store(millis());
  }
};

// RC-Rehab's game page (public/musclecar.js) writes two bytes instead: power for the left and
// right wheels, 0-255 each. The board pulses each button so the car runs slower than full speed:
// at 40% power the button is held for 40% of every PULSE_MS. Also expires on heartbeat loss.
constexpr unsigned long PULSE_MS = 80;     // one on/off cycle
constexpr unsigned long MIN_PRESS_MS = 12; // shorter presses may not reach the car, so skip them
std::atomic<uint16_t> wheelPower(0);       // left in the low byte, right in the high byte
std::atomic<uint32_t> lastPower(0);
class PowerEvents : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) override {
    auto value = ch->getValue();
    wheelPower.store(value.length() == 2 ? uint16_t(uint8_t(value[0]) | uint8_t(value[1]) << 8) : 0);
    lastPower.store(millis());
  }
};
bool pulsed(uint8_t power, unsigned long now) {
  const unsigned long on = power * PULSE_MS / 255;
  if (on < MIN_PRESS_MS) return false;
  if (on > PULSE_MS - MIN_PRESS_MS) return true;
  return now % PULSE_MS < on;
}

class ConnectionEvents : public BLEServerCallbacks {
  void onDisconnect(BLEServer *) override { lastFlex.store(0); lastPower.store(0); restartAdvertising.store(true); }
};

void startBluetooth() {
  BLEDevice::init("Forearm-EMG");
  auto *server = BLEDevice::createServer();
  static ConnectionEvents events;
  server->setCallbacks(&events);
  auto *service = server->createService(serviceId);
  sampleCharacteristic = service->createCharacteristic(sampleId, BLECharacteristic::PROPERTY_NOTIFY);
  sampleCharacteristic->addDescriptor(new BLE2902());
  dualSamples = service->createCharacteristic("e0730c53-b64d-48f3-a0ac-3d0657c85430", BLECharacteristic::PROPERTY_NOTIFY);
  dualSamples->addDescriptor(new BLE2902());
  auto *drive = service->createCharacteristic("e0730c52-b64d-48f3-a0ac-3d0657c85430", BLECharacteristic::PROPERTY_WRITE);
  static DriveEvents commands;
  drive->setCallbacks(&commands);
  auto *power = service->createCharacteristic("e0730c54-b64d-48f3-a0ac-3d0657c85430", BLECharacteristic::PROPERTY_WRITE);
  static PowerEvents powerCommands;
  power->setCallbacks(&powerCommands);
  service->start();
  auto *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(serviceId);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
}

void publishSample(uint32_t timeMs, uint16_t adc, uint16_t right) {
  // ESP32 is little endian: sequence (4), uptime ms (4), ADC count (2).
  uint8_t packet[12];
  memcpy(packet, &sequence, 4);
  memcpy(packet + 4, &timeMs, 4);
  memcpy(packet + 8, &adc, 2);
  memcpy(packet + 10, &right, 2);
  ++sequence;
  if (BLEDevice::getServer()->getConnectedCount()) {
    sampleCharacteristic->setValue(packet, 10);
    sampleCharacteristic->notify();
    dualSamples->setValue(packet, sizeof(packet));
    dualSamples->notify();
  }
}

void setup() {
  for (int pin : {4, 5, 6, 7}) pinMode(pin, INPUT);
  for (int pin : {5, 7}) {
    digitalWrite(pin, HIGH);
    pinMode(pin, OUTPUT_OPEN_DRAIN);
    digitalWrite(pin, HIGH);
  }
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);
  analogReadResolution(12);
  analogSetPinAttenuation(sensorPin, ADC_11db);

  analogSetPinAttenuation(rightSensorPin, ADC_11db);
  startBluetooth();

}

void loop() {
  if (restartAdvertising.exchange(false)) BLEDevice::startAdvertising();
  const unsigned long now = millis();
  const uint32_t pulse = lastFlex.load();
  const uint32_t powerAt = lastPower.load();
  const bool maskFresh = pulse && uint32_t(now - pulse) < 300;
  const bool powerFresh = powerAt && uint32_t(now - powerAt) < 300;
  bool left = false, right = false;
  if (powerFresh && (!maskFresh || int32_t(powerAt - pulse) >= 0)) {
    // The newest command wins: wheel power from the game page.
    const uint16_t power = wheelPower.load();
    left = pulsed(power & 0xFF, now);
    right = pulsed(power >> 8, now);
  } else if (maskFresh) {
    const uint8_t mask = wheelMask.load();
    left = mask & 1;
    right = mask & 2;
  }
  digitalWrite(5, left ? LOW : HIGH);
  digitalWrite(7, right ? LOW : HIGH);
  if (now - lastSample >= sampleIntervalMs) {
    lastSample = now;
    envelope = analogRead(sensorPin);
    publishSample(now, envelope, analogRead(rightSensorPin));
    if (Serial.availableForWrite() >= 20) {
      Serial.print("Envelope:");
      Serial.println(envelope);
    }
  }
}
