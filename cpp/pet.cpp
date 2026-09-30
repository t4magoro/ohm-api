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

// Drain rates in points per hour. `hours` is how long a full bar lasts on a normal day
// (you set it on the admin page). At night Ohm sleeps, so everything drains at half speed.
EXPORT("charge_rate")
double charge_rate(double hours, double temp_c, int is_day) {
  if (hours <= 0) return 0;  // the server only allows 1-168; this is a last safety net
  return 100.0 / hours * (is_day ? 1.0 : 0.5) * (temp_c > 30 ? 1.5 : 1.0);
}

EXPORT("mood_rate")
double mood_rate(double hours, int raining, int is_day) {
  if (hours <= 0) return 0;
  return 100.0 / hours * (is_day ? 1.0 : 0.5) * (raining ? 1.3 : 1.0);
}

// Weighted random pick for the Markov chain. JS writes up to MAX_WEIGHTS counts into
// `weights`, a fixed buffer (no heap, like MCU firmware), then calls pick_weighted.
constexpr int MAX_WEIGHTS = 4096;
static int weights[MAX_WEIGHTS];

EXPORT("weights_ptr")
int* weights_ptr() { return weights; }

// r is random in [0, 1). Returns the chosen index, or -1 if there's nothing to pick.
EXPORT("pick_weighted")
int pick_weighted(int n, double r) {
  if (n <= 0 || n > MAX_WEIGHTS) return -1;
  double total = 0;
  for (int i = 0; i < n; i++) total += weights[i];
  if (total <= 0) return -1;
  double x = r * total;
  for (int i = 0; i < n; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return n - 1;  // only reached through float rounding
}