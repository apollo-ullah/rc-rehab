#include <BLEDevice.h>
#include <BLE2902.h>
#include <atomic>

constexpr int sensorPin = 2;
constexpr unsigned long sampleIntervalMs = 20;
unsigned long lastSample = 0;
int envelope = 0;

constexpr char serviceId[] = "e0730c50-b64d-48f3-a0ac-3d0657c85430";
constexpr char sampleId[] = "e0730c51-b64d-48f3-a0ac-3d0657c85430";
BLECharacteristic *sampleCharacteristic;
std::atomic<bool> restartAdvertising(false);
uint32_t sequence = 0;

class ConnectionEvents : public BLEServerCallbacks {
  void onDisconnect(BLEServer *) override { restartAdvertising.store(true); }
};

void startBluetooth() {
  BLEDevice::init("Forearm-EMG");
  auto *server = BLEDevice::createServer();
  static ConnectionEvents events;
  server->setCallbacks(&events);
  auto *service = server->createService(serviceId);
  sampleCharacteristic = service->createCharacteristic(sampleId, BLECharacteristic::PROPERTY_NOTIFY);
  sampleCharacteristic->addDescriptor(new BLE2902());
  service->start();
  auto *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(serviceId);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
}

void publishSample(uint32_t timeMs, uint16_t adc) {
  // ESP32 is little endian: sequence (4), uptime ms (4), ADC count (2).
  uint8_t packet[10];
  memcpy(packet, &sequence, 4);
  memcpy(packet + 4, &timeMs, 4);
  memcpy(packet + 8, &adc, 2);
  ++sequence;
  if (BLEDevice::getServer()->getConnectedCount()) {
    sampleCharacteristic->setValue(packet, sizeof(packet));
    sampleCharacteristic->notify();
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);
  analogReadResolution(12);
  analogSetPinAttenuation(sensorPin, ADC_11db);

  startBluetooth();

}

void loop() {
  if (restartAdvertising.exchange(false)) BLEDevice::startAdvertising();
  const unsigned long now = millis();
  if (now - lastSample >= sampleIntervalMs) {
    lastSample = now;
    envelope = analogRead(sensorPin);
    publishSample(now, envelope);
    if (Serial.availableForWrite() >= 20) {
      Serial.print("Envelope:");
      Serial.println(envelope);
    }
  }
}
