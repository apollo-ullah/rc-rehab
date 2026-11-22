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

class ConnectionEvents : public BLEServerCallbacks {
  void onDisconnect(BLEServer *) override { lastFlex.store(0); restartAdvertising.store(true); }
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
  const uint8_t mask = pulse && uint32_t(now - pulse) < 300 ? wheelMask.load() : 0;
  digitalWrite(5, mask & 1 ? LOW : HIGH);
  digitalWrite(7, mask & 2 ? LOW : HIGH);
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
