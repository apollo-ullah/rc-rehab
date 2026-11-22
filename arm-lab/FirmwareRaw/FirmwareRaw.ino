// Uno R3 only. MyoWare RAW to A4. Timer interrupt starts a conversion every 500 us.
// Each output line carries the acquisition sequence so dropped frames are detectable.
#include <util/atomic.h>
struct Sample { uint32_t seq; uint16_t adc; };
volatile Sample ring[64];
volatile uint8_t head = 0, tail = 0;
volatile uint32_t sequence = 0;
ISR(TIMER1_COMPA_vect) { ADCSRA |= _BV(ADSC); }
ISR(ADC_vect) {
  uint16_t value = ADC;
  uint8_t next = (head + 1) & 63;
  uint32_t n = sequence++;
  if (next == tail) return;
  ring[head].seq = n;
  ring[head].adc = value;
  head = next;
}
void setup() {
  Serial.begin(500000);
  ADMUX = _BV(REFS0) | 4;
  ADCSRA = _BV(ADEN) | _BV(ADIE) | _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0);
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  OCR1A = 999;
  TIMSK1 = _BV(OCIE1A);
  TCCR1B = _BV(WGM12) | _BV(CS11);
}
void loop() {
  if (tail == head) return;
  uint32_t seq = ring[tail].seq;
  uint16_t adc = ring[tail].adc;
  tail = (tail + 1) & 63;
  Serial.print(seq);
  Serial.print(',');
  Serial.println(adc);
}
