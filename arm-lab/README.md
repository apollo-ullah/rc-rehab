# Arm Lab

Run `python3 serve.py` in this folder, then open http://127.0.0.1:8741 in desktop Chrome or Edge. The server binds to this Mac. The app saves the current session in this browser and exports a JSON file on demand. No account is needed. Export before beginning a new site or remounting the pads.

## Connect one source

- **Current Uno ENV firmware.** MyoWare ENV to Uno A4, VIN to regulated 5V, GND to GND. Use a suitable USB isolator for on-body serial acquisition, close Arduino Serial Monitor, and select the Uno port in the browser. Existing firmware emits Envelope records at roughly 100 Hz at 115200 baud. A power bank alone gives the Uno no data link.
- **Existing ESP32 wireless firmware.** Power the ESP32 from a standalone battery. MyoWare VIN to 3V3, GND to GND, ENV to GPIO2. Join Forearm-EMG on this Mac (password forearm2749) and select ESP32 in the app. It polls the existing /sample endpoint and timestamps received readings. This provides an irregularly sampled envelope. The ESP32 firmware must already be loaded.
- **True RAW on Uno.** With the electrodes off and the board unpowered, connect the documented MyoWare RAW output to Uno A4 in place of ENV. Use an appropriate header or shield that exposes RAW. Keep MyoWare VIN on Uno 5V and GND common. Flash FirmwareRaw/FirmwareRaw.ino with Arduino Uno selected while off-body. The timer schedules 2000 conversions per second; sequence numbers expose dropped samples. Close the IDE serial monitor. Use isolated USB and choose Uno RAW in the app. Restore the ENV sketch and wiring together to return to envelope mode.

See the [manufacturer's sensor diagram](https://myoware.com/wp-content/uploads/2022/03/MyoWare_v2_AdvancedGuide-Updated.pdf) and [SparkFun hookup guidance](https://learn.sparkfun.com/tutorials/getting-started-with-the-myoware-20-muscle-sensor-ecosystem/hardware-hookup).

## Collect and reuse

Keep the sensor fixed throughout a session. Choose side and placement, then capture rest and one comfortable reference. Follow each cue at comparable effort. An operator can cancel a mislabeled capture while it is running. Four randomized rounds supply training examples and two later rounds evaluate the frozen model. Each round includes rest and both movements for the selected site. Free recognition runs on rolling 1.2-second windows after training. Repeat a complete session after moving or remounting the sensor.

JSON includes hardware source, arm, placement, original count samples, calibration, normalization parameters, feature order, labeled trials, model and held-out predictions. Each row contains sequence, ADC count and stream time in ms. Browser receipt time gates captures. Only the RAW firmware supplies device sequence numbers. ENV is already rectified and smoothed. For RAW the pipeline subtracts resting ADC median and calculates RMS on consecutive 50 ms blocks. Both modes subtract the resting amplitude median and divide by the comfortable reference span; values can exceed 1. To reproduce inference use amplitudes, features and classify from model.js with the exported calibration and model. Each model belongs to its source, site, arm and session. Predictions assume a reasonably steady pose within the window. They do not identify motion direction independently or assess strength. See guide.html for evidence and movement cues.

## Two-arm Uno firmware

FirmwareDual samples A3 (second arm RAW), A4 (first arm ENV), then A5 (second arm RECT) at 1250 frames per second. Each 500000-baud serial line contains sequence, RAW, ENV and RECT. Select a **Two arms** source to train the selected arm. Each calibration and trial export includes all three ADC readings. For the second arm the classifier uses RMS over 100 RAW samples (80 ms).

## ESP32-S3 Bluetooth envelope

The ForearmEMG sketch advertises Forearm-EMG over BLE and samples ENV on GPIO2 approximately every 20 ms. In desktop Chrome choose ESP32 · Bluetooth envelope and Connect device, then select Forearm-EMG. The local recorder works on your usual Wi-Fi. After switching the board from USB to standalone battery power, reconnect in the recorder. Each notification contains a little-endian uint32 sequence, uint32 device uptime in milliseconds and uint16 ADC reading. Export uses the device sequence and uptime.
