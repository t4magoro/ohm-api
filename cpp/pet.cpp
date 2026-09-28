// Ohm's pet math, compiled to WebAssembly.
// Rule for this file: numbers in, numbers out, no heap. It's built with -nostdlib,
// so there's no malloc to call. Using new or malloc fails the build.

#ifdef __wasm__
#define EXPORT(name) extern "C" __attribute__((export_name(name)))
#else
#define EXPORT(name) extern "C"  // native build for pet_test.cpp
#endif

constexpr double HOUR = 3'600'000.0;  // ms

// A stat stores its value at one moment (`at`, in ms) and how fast it drains
// (`rate`, points per hour). Nothing ticks: the current value is calculated.
EXPORT("value_now")
double value_now(double v, double at, double rate, double now) {
  double x = v - rate * (now - at) / HOUR;
  return x > 0 ? x : 0;
}

// The moment the stat reaches 0, or infinity if it isn't draining.
EXPORT("empty_at")
double empty_at(double v, double at, double rate) {
  return rate > 0 ? at + v / rate * HOUR : __builtin_inf();
}

// Drain rates in points per hour. At night Ohm sleeps, so everything drains at half speed.
EXPORT("charge_rate")
double charge_rate(double temp_c, int is_day) {
  return 5.0 * (is_day ? 1.0 : 0.5) * (temp_c > 30 ? 1.5 : 1.0);  // 100 -> 0 in 20 h
}

EXPORT("mood_rate")
double mood_rate(int raining, int is_day) {
  return 8.0 * (is_day ? 1.0 : 0.5) * (raining ? 1.3 : 1.0);  // 100 -> 0 in ~12 h
}