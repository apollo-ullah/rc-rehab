// Uno R3. Sample A3 RAW, A4 ENV and A5 RECT in sequence every 800 us.
// Send sequence numbers so the host can identify dropped frames.
struct Frame {
  uint32_t sequence;
  uint16_t adc[3];
};
volatile Frame queue[32];
volatile uint8_t head = 0, tail = 0, channel = 0;
volatile uint32_t sequence = 0;
volatile bool acquiring = false;
ISR(TIMER1_COMPA_vect) {
  uint32_t tick = sequence++;
  if (acquiring || ((head + 1) & 31) == tail) return;
  acquiring = true;
  queue[head].sequence = tick;
  channel = 0;
  ADMUX = _BV(REFS0) | 3;
  ADCSRA |= _BV(ADSC);
}
ISR(ADC_vect) {
  queue[head].adc[channel++] = ADC;
  if (channel == 3) {
    head = (head + 1) & 31;
    acquiring = false;
  } else {
    ADMUX = _BV(REFS0) | (3 + channel);
    ADCSRA |= _BV(ADSC);
  }
}
void setup() {
  Serial.begin(500000);
  ADCSRA = _BV(ADEN) | _BV(ADIE) | _BV(ADPS2) | _BV(ADPS1);
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  OCR1A = 1599;
  TIMSK1 = _BV(OCIE1A);
  TCCR1B = _BV(WGM12) | _BV(CS11);
}
void loop() {
  if (tail == head) return;
  Serial.print(queue[tail].sequence);
  for (uint8_t i = 0; i < 3; ++i) {
    Serial.write(',');
    Serial.print(queue[tail].adc[i]);
  }
  Serial.println();
  tail = (tail + 1) & 31;
}
